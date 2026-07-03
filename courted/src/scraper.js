// scraper.js — orchestration core (transport-agnostic). Logs in once, then
// pages through the agent-search API for each requested location, mapping and
// (optionally) enriching each agent. Calls onRecord(row) for every agent so the
// caller decides where it lands (Apify dataset, JSON file, CSV, ...).

import { login } from './auth.js';
import { buildSearchQuery, fetchSearchPage, fetchAgentDetail } from './api.js';
import { mapSearchRecord, mergeDetail } from './mapper.js';
import { sleep, DEFAULT_STATUSES } from './constants.js';

const PAGE_SIZE = 50; // API accepts larger pages than the UI's 20

/**
 * Turn a user location string into { scope, value, label }.
 *   "Miami, FL"  -> { scope: 'city', value: 'Miami|FL', label: 'Miami, FL' }
 *   "33139"      -> { scope: 'zip',  value: '33139',    label: '33139' }
 *   ""/null      -> null  (means "no location filter — all agents")
 */
export function parseLocation(raw) {
    const full = String(raw || '').trim();
    if (!full) return null;
    if (/^\d{5}(-\d{4})?$/.test(full)) {
        return { scope: 'zip', value: full.slice(0, 5), label: full };
    }
    const m = full.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
    if (m) {
        const city = m[1].trim();
        const state = m[2].toUpperCase();
        return { scope: 'city', value: `${city}|${state}`, label: `${city}, ${state}` };
    }
    // City with no state — send as-is; Courted matches on the city token.
    return { scope: 'city', value: `${full}|`, label: full };
}

/**
 * Run the scrape.
 * @param {object} config
 * @param {object} deps  { log, onRecord(row), session? }
 * @returns {Promise<{ pushed: number }>}
 */
export async function runScrape(config, { log = console, onRecord, onMeta, shouldStop }) {
    const {
        email,
        password,
        locations = [],
        orderBy = 'ltm_sales_volume',
        orderDirection = 'desc',
        maxRecords = 0,            // 0 = unlimited (total across all locations)
        maxRecordsPerLocation = 0, // 0 = unlimited per location
        minSalesVolume = 0,        // client-side filter on LTM sales volume
        enrichProfiles = false,
        includeContactInfo = true,
        statuses = DEFAULT_STATUSES,
        extraParams = {},
        segments = null,           // pre-built band segments (dodge deep-offset wall)
        delayMs = 350,             // polite pause between page requests
    } = config;

    const session = config.session || await login(email, password);
    log.info?.('Authenticated to Courted.');

    // Normalize the work list into uniform "segment" objects. Three sources:
    //   1. segments (band pagination) — each carries its own volume/state filter,
    //   2. locations — city/zip searches, one segment each,
    //   3. neither — a single unfiltered "(all agents)" sweep.
    // recordTag is the location string stamped onto each row; band segments aren't
    // real locations so they leave it blank (same as an unfiltered sweep).
    const searches = Array.isArray(segments) && segments.length
        ? segments.map((s) => ({
            label: s.label || '(segment)',
            locationScope: s.locationScope || '',
            locationValues: s.locationValues || [],
            extraParams: { ...extraParams, ...(s.extraParams || {}) },
            recordTag: '',
        }))
        : (locations.length
            ? locations.map(parseLocation).filter(Boolean).map((loc) => ({
                label: loc.label,
                locationScope: loc.scope,
                locationValues: [loc.value],
                extraParams,
                recordTag: loc.label,
            }))
            : [{ label: '(all agents)', locationScope: '', locationValues: [], extraParams, recordTag: '' }]);

    const seen = new Set(); // courted_mls_id dedupe across segments
    let pushed = 0;

    for (const seg of searches) {
        if (shouldStop?.()) return { pushed };
        const label = seg.label;
        let offset = 0;
        let perLoc = 0;
        let total = Infinity;
        let consecutiveFailures = 0; // stuck-page guard (don't abandon the account)

        log.info?.(`Searching ${label} ...`);

        while (offset < total) {
            if (shouldStop?.()) return { pushed };
            if (maxRecords && pushed >= maxRecords) {
                log.info?.(`Reached maxRecords (${maxRecords}).`);
                return { pushed };
            }
            if (maxRecordsPerLocation && perLoc >= maxRecordsPerLocation) break;

            const remainingForLoc = maxRecordsPerLocation
                ? Math.min(PAGE_SIZE, maxRecordsPerLocation - perLoc) : PAGE_SIZE;
            const limit = maxRecords
                ? Math.min(remainingForLoc, maxRecords - pushed) : remainingForLoc;

            const query = buildSearchQuery({
                limit,
                offset,
                orderBy,
                orderDirection,
                locationScope: seg.locationScope,
                locationValues: seg.locationValues,
                statuses,
                includeContactInfo,
                extraParams: seg.extraParams,
            });

            let data = null;
            let pageErr = null;
            // fetchSearchPage already retries 5xx/429 internally; add loop-level
            // retries with longer waits for a stubborn page (deep-pagination 504s).
            for (let pageAttempt = 1; pageAttempt <= 3; pageAttempt += 1) {
                try {
                    data = await fetchSearchPage(session, query);
                    pageErr = null;
                    break;
                } catch (err) {
                    pageErr = err;
                    log.warning?.(`Page failed (offset ${offset}) for ${label}, retry ${pageAttempt}/3: ${err.message}`);
                    await sleep(Math.min(30000, 5000 * pageAttempt));
                }
            }
            if (pageErr) {
                // Give up on THIS page only — skip its window and continue, so one
                // stuck page never abandons the whole account (was a hard `break`,
                // which silently dropped ~110k agents on a mid-sweep 504).
                consecutiveFailures += 1;
                if (consecutiveFailures >= 8) {
                    log.warning?.(`${label}: ${consecutiveFailures} consecutive page failures — stopping (API unavailable).`);
                    break;
                }
                offset += limit; // advance past the bad page and keep going
                await sleep(delayMs);
                continue;
            }
            consecutiveFailures = 0;

            total = Number.isFinite(data.count) ? data.count : 0;
            const results = Array.isArray(data.results) ? data.results : [];
            if (offset === 0) {
                log.info?.(`${label}: ${total.toLocaleString?.() || total} agents match.`);
                if (onMeta) await onMeta({ location: label, total });
            }
            if (results.length === 0) break;

            for (const rec of results) {
                const key = rec.courted_mls_id || rec.id;
                if (key && seen.has(key)) continue;
                if (key) seen.add(key);

                if (minSalesVolume && Number(rec.ltm_sales_volume || 0) < minSalesVolume) {
                    // Results are volume-desc by default: once we drop below the
                    // floor we can stop this location early.
                    if (orderBy === 'ltm_sales_volume' && orderDirection === 'desc') {
                        log.info?.(`${label}: below minSalesVolume — stopping location.`);
                        total = offset; // break outer loop
                        break;
                    }
                    continue;
                }

                let row = mapSearchRecord(rec, seg.recordTag);

                if (enrichProfiles && rec.courted_mls_id) {
                    try {
                        const detail = await fetchAgentDetail(session, rec.courted_mls_id);
                        row = mergeDetail(row, detail);
                    } catch (err) {
                        log.debug?.(`Enrich failed for ${rec.courted_mls_id}: ${err.message}`);
                    }
                    await sleep(delayMs);
                }

                await onRecord(row);
                pushed += 1;
                perLoc += 1;

                if (maxRecords && pushed >= maxRecords) break;
                if (maxRecordsPerLocation && perLoc >= maxRecordsPerLocation) break;
            }

            offset += results.length;
            await sleep(delayMs);
        }

        log.info?.(`${label}: pushed ${perLoc} agent(s).`);
    }

    return { pushed };
}
