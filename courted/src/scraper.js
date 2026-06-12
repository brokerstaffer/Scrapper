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
export async function runScrape(config, { log = console, onRecord, onMeta }) {
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
        delayMs = 350,             // polite pause between page requests
    } = config;

    const session = config.session || await login(email, password);
    log.info?.('Authenticated to Courted.');

    const searches = locations.length
        ? locations.map(parseLocation).filter(Boolean)
        : [null]; // no locations => one unfiltered sweep

    const seen = new Set(); // courted_mls_id dedupe across locations
    let pushed = 0;

    for (const loc of searches) {
        const label = loc ? loc.label : '(all agents)';
        let offset = 0;
        let perLoc = 0;
        let total = Infinity;

        log.info?.(`Searching ${label} ...`);

        while (offset < total) {
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
                locationScope: loc ? loc.scope : '',
                locationValues: loc ? [loc.value] : [],
                statuses,
                includeContactInfo,
                extraParams,
            });

            let data;
            try {
                data = await fetchSearchPage(session, query);
            } catch (err) {
                log.warning?.(`Page failed (offset ${offset}) for ${label}: ${err.message}`);
                break;
            }

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

                let row = mapSearchRecord(rec, loc ? loc.label : '');

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
