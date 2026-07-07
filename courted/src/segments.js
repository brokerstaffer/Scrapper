// segments.js — split a Courted account's full agent set into "segments" that
// each return FEWER than the deep-pagination wall (~100k), so every segment can
// be paged from offset 0 without hitting Courted's deep-offset 504s.
//
// Primary split: server-side sales-volume range (ltm_sales_volume_min/max).
// A single value can hold a huge tie cluster (e.g. volume = 0). If such a
// cluster is still too big to page, we sub-split it by state. Anything still
// stuck after that is paged as far as it can go (and logged) — never silently
// dropped.
//
// HARDENING (learned in production):
//   1. Baseline sanity-check — right after a heavy scrape, Courted can return a
//      garbage-low count (Keyes once probed 637 instead of 191,482, and the
//      whole account was silently skipped). We now probe an unfiltered baseline
//      until it's stable, and replan if the segments don't add up to it.
//   2. Fall-through protection — agents with a null field don't match any range
//      of that field, so a split can leak them. If a split's parts don't sum to
//      the whole, we add a residual segment covering the whole (the scraper's
//      seen-set skips agents already captured, so overlap is free).
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

// Every account this system sweeps is 50k+ agents. A baseline probe far below
// this is treated as a throttled/garbage answer and re-probed, not believed.
const BASELINE_FLOOR = Number(process.env.COURTED_BASELINE_FLOOR) || 5000;

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
 * @param opts.delayMs   pause between probes (don't burst Courted)
 */
export async function buildSegments(session, { safeMax = 90000, log = console, delayMs = 350 } = {}) {
    let probes = 0;
    const probe = async (f) => {
        probes += 1;
        if (probes > 1) await sleep(delayMs); // pace probes — don't burst Courted
        return probeCount(session, f);
    };

    // How many agents does this account REALLY have? Don't trust one answer.
    const baseline = await settleBaseline(probe, log);
    log.info?.(`Planning against a baseline of ${baseline.toLocaleString()} agents.`);

    let segments = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        segments = await planOnce(probe, safeMax, log);
        const est = segments.reduce((s, x) => s + x.count, 0);
        // Complete coverage sums to >= baseline (bands overlap slightly; the
        // scraper de-dupes). A short sum means probes returned garbage mid-plan.
        if (est >= baseline * 0.9) {
            log.info?.(`Built ${segments.length} segment(s) with ${probes} probes; est ${est.toLocaleString()} vs baseline ${baseline.toLocaleString()}.`);
            return segments;
        }
        log.warning?.(`Plan covers only ${est.toLocaleString()} of ~${baseline.toLocaleString()} — cooling down, then replanning (${attempt}/3)…`);
        await sleep(Math.min(120000, 30000 * attempt));
    }

    // Still short after retries: keep the best plan but add an unfiltered
    // catch-all so nothing is silently skipped (paged with retry/skip; the
    // scraper's seen-set makes the overlap free).
    segments.push({ label: 'all · residual catch-all', locationScope: '', locationValues: [], extraParams: {}, count: baseline });
    log.warning?.('Coverage still short of baseline — added an unfiltered catch-all segment.');
    return segments;
}

/**
 * Probe the unfiltered account size until two consecutive answers agree.
 * Suspiciously small answers (< BASELINE_FLOOR) are re-probed with a cooldown —
 * they're almost always Courted throttling, not a genuinely tiny account.
 */
async function settleBaseline(probe, log) {
    let prev = -1;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
        const c = await probe({ locationScope: '', locationValues: [], extraParams: {} });
        const agrees = prev >= 0 && Math.abs(c - prev) <= Math.max(100, prev * 0.02);
        if (agrees && (c >= BASELINE_FLOOR || attempt >= 4)) return Math.max(c, prev);
        if (prev >= 0 && !agrees) log.warning?.(`Baseline probe unstable (${prev.toLocaleString()} → ${c.toLocaleString()}) — re-probing…`);
        else if (c < BASELINE_FLOOR) log.warning?.(`Baseline probe suspiciously low (${c.toLocaleString()}) — re-probing…`);
        prev = c;
        await sleep(Math.min(60000, 5000 * attempt));
    }
    return Math.max(prev, 0);
}

/** One planning pass: returns the segment list (may be garbage if throttled — caller verifies vs baseline). */
async function planOnce(probe, safeMax, log) {
    const segments = [];

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
    // narrowed by volume. Sub-split by STATE. Null-state agents fall through a
    // state split, so if the states don't sum to the cluster we also emit the
    // whole cluster as a residual (seen-set skips the already-captured part).
    // We deliberately do NOT split by tenure: agent_tenure is nullable and a
    // tenure split measurably leaked ~12k agents.
    const splitStuck = async (base, clusterCount) => {
        if (!base.locationScope) {
            let found = false;
            let stateSum = 0;
            for (const st of US_STATES) {
                const f = { ...base, locationScope: 'state', locationValues: [st], label: `${base.label} · ${st}` };
                const c = await probe(f);
                if (!c) continue;
                found = true;
                stateSum += c;
                emit(f, c); // emit() warns + accepts oversized (retry/skip pages it)
            }
            if (found) {
                if (stateSum < clusterCount * 0.98) {
                    log.warning?.(`State split covers ${stateSum.toLocaleString()} of ${clusterCount.toLocaleString()} — adding cluster residual: ${base.label}`);
                    emit({ ...base, label: `${base.label} · residual` }, clusterCount);
                }
                return;
            }
        }
        // Already state-scoped, or no states matched — page the whole value as-is.
        emit(base, clusterCount);
    };

    // Recursive volume bisection over [lo, hi] (inclusive). hi=VTOP for the main
    // range; an open band above VTOP is emitted separately.
    const splitVolume = async (base, lo, hi) => {
        const f = withVol(base, lo, hi);
        f.label = `${base.label} · vol ${lo}-${hi}`;
        const c = await probe(f);
        if (c === 0) return;
        if (c <= safeMax) { emit(f, c); return; }
        if (lo >= hi) { await splitStuck(f, c); return; } // single value, still too big
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
        else await splitStuck(topOpen, topCount);
    }

    // Main range [0, VTOP].
    await splitVolume(base, 0, VTOP);

    return segments;
}
