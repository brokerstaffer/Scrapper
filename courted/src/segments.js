// segments.js — split a Courted account's full agent set into "segments" that
// each return FEWER than the deep-pagination wall (~100k), so every segment can
// be paged from offset 0 without hitting Courted's deep-offset 504s.
//
// Primary split: server-side sales-volume range (ltm_sales_volume_min/max).
// A single value can hold a huge tie cluster (e.g. volume = 0). If such a
// cluster is still too big to page, we sub-split it by state, then by agent
// tenure. Anything still stuck after that is paged as far as it can go (and
// logged) — never silently dropped.
//
// Every segment carries the filter params to reproduce it; the scraper applies
// them and its `seen` set de-dupes any boundary overlap across segments.

import { buildSearchQuery, fetchSearchPage } from './api.js';
import { sleep } from './constants.js';

// US states + DC + territories (2-letter codes — verified: Courted wants the
// code, not the name). Used to sub-split a stuck single-value volume cluster.
export const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
    'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
    'VA','WA','WV','WI','WY','DC','PR','VI','GU',
];

const VTOP = 1_000_000_000; // $1B — practical ceiling; a rare-agent open band sits above it.

/**
 * Probe the match count for a filter (limit=1, cheap). Returns a number.
 */
async function probeCount(session, { locationScope, locationValues, extraParams }) {
    const q = buildSearchQuery({
        limit: 1, offset: 0,
        locationScope: locationScope || '',
        locationValues: locationValues || [],
        extraParams: extraParams || {},
    });
    const data = await fetchSearchPage(session, q);
    return Number.isFinite(data.count) ? data.count : 0;
}

/**
 * Build a flat list of segments that together cover the whole account, each
 * with an estimated count <= safeMax. Each segment is
 *   { label, locationScope, locationValues, extraParams, count }
 * Uses only cheap count-probes; does NOT fetch agent rows.
 *
 * @param session  authenticated Courted session
 * @param opts.safeMax   target ceiling per segment (default 90000, under the ~103k wall)
 * @param opts.log       optional logger
 */
export async function buildSegments(session, { safeMax = 90000, log = console, delayMs = 350 } = {}) {
    const segments = [];
    let probes = 0;
    const probe = async (f) => {
        probes += 1;
        if (probes > 1) await sleep(delayMs); // pace probes — don't burst Courted
        return probeCount(session, f);
    };

    // Merge helper for extraParams.
    const withVol = (base, min, max) => {
        const e = { ...(base.extraParams || {}) };
        if (min != null) e.ltm_sales_volume_min = min;
        if (max != null) e.ltm_sales_volume_max = max;
        return { ...base, extraParams: e };
    };

    const emit = (seg, count) => {
        if (count > safeMax) {
            // Irreducible cluster (single volume value, single state) bigger than
            // the wall — the scraper will page it with retry/skip. Only the deep
            // pages past the wall are at risk, not the whole segment.
            log.warning?.(`Oversized segment ${count.toLocaleString()} (> ${safeMax}); will page with retry/skip: ${seg.label}`);
        }
        segments.push({
            label: seg.label,
            locationScope: seg.locationScope || '',
            locationValues: seg.locationValues || [],
            extraParams: seg.extraParams || {},
            count,
        });
    };

    // A stuck cluster = one volume value that still exceeds safeMax and can't be
    // narrowed by volume. Sub-split by STATE (complete: agents carry office/home/
    // transacted state, and state segments overlap rather than gap — the scraper
    // de-dupes). Any residual single-state cluster still over the wall is emitted
    // as-is and paged with retry/skip. We deliberately do NOT split by tenure:
    // agent_tenure is nullable, so tenure bands would silently drop null-tenure
    // agents (measured: a ~12k gap). Completeness beats tidiness.
    const splitStuck = async (base) => {
        if (!base.locationScope) {
            let found = false;
            for (const st of US_STATES) {
                const f = { ...base, locationScope: 'state', locationValues: [st], label: `${base.label} · ${st}` };
                const c = await probe(f);
                if (!c) continue;
                found = true;
                emit(f, c); // emit() warns + accepts oversized (retry/skip pages it)
            }
            if (found) return;
        }
        // Already state-scoped, or no states matched — page the whole value as-is.
        emit(base, await probe(base));
    };

    // Recursive volume bisection over [lo, hi] (inclusive). hi=VTOP for the main
    // range; an open band above VTOP is emitted separately.
    const splitVolume = async (base, lo, hi) => {
        const f = withVol(base, lo, hi);
        f.label = `${base.label} · vol ${lo}-${hi}`;
        const c = await probe(f);
        if (c === 0) return;
        if (c <= safeMax) { emit(f, c); return; }
        if (lo >= hi) { await splitStuck(f); return; } // single value, still too big
        const mid = Math.floor((lo + hi) / 2);
        await splitVolume(base, mid + 1, hi); // higher band first (desc order)
        await splitVolume(base, lo, mid);
    };

    const base = { label: 'all', locationScope: '', locationValues: [], extraParams: {} };

    // Open top band above VTOP (rare whales) — usually 0 or a handful.
    const topOpen = withVol(base, VTOP + 1, null);
    topOpen.label = `all · vol >${VTOP}`;
    const topCount = await probe(topOpen);
    if (topCount > 0) {
        if (topCount <= safeMax) emit(topOpen, topCount);
        else await splitStuck(topOpen);
    }

    // Main range [0, VTOP].
    await splitVolume(base, 0, VTOP);

    const est = segments.reduce((s, x) => s + x.count, 0);
    log.info?.(`Built ${segments.length} segment(s) with ${probes} probes; est ${est.toLocaleString()} matches (pre-dedup).`);
    return segments;
}
