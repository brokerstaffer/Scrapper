// engines/realtor.js — realtor.com agent engine via ZenRows.
//
// realtor.com blocks normal scraping (429). We fetch through ZenRows (premium
// proxy + anti-bot). Data lives in the page's __NEXT_DATA__:
//   - search:  props.pageProps.agentSearchResultsPageProps.{agents, matching_rows}
//   - profile: an agent object with phones/license/experience/served_areas/etc.
//
// Search is cheap (1 request per ~24 agents). Enrichment is 1 request PER agent,
// so it's gated behind a toggle + a cap to control ZenRows credit spend.

import { fetchUnblocked, extractNextData, activeProvider } from '../unblocker.js';
import { mapSearchRecord, mergeDetail, profileUrl } from './realtor-map.js';
import { emit, engineFinished } from '../jobs.js';

let chain = Promise.resolve(); // serialize realtor runs (gentle on credits/concurrency)

export function runRealtor(job) {
    chain = chain.then(() => crawl(job)).catch(() => {});
    return chain;
}

function realtorSlug(raw) {
    const s = String(raw).trim();
    if (/^\d{5}$/.test(s)) return s; // ZIP
    const m = s.match(/^(.*?),?\s*([A-Za-z]{2})$/);
    if (m) {
        const city = m[1].trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        return `${city}_${m[2].toLowerCase()}`;
    }
    return s.toLowerCase().replace(/\s+/g, '-');
}

function searchUrl(slug, page) {
    const base = `https://www.realtor.com/realestateagents/${slug}`;
    return page > 1 ? `${base}/pg-${page}` : base;
}

/**
 * Fetch a realtor page's __NEXT_DATA__ via ZenRows.
 *  - Search pages are server-rendered → try cheap (no JS render) first, ~10 credits.
 *  - Profile pages need JS rendering → go straight to render (forceRender), ~25 credits.
 */
async function fetchRealtor(url, log, forceRender = false) {
    // Retry when the unblocker returns a 200 that ISN'T the real page (no
    // __NEXT_DATA__) — happens under Bright Data concurrency contention.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const html = await fetchUnblocked(url, { render: forceRender });
            const nd = extractNextData(html);
            if (nd) return nd;
        } catch (err) {
            if (attempt === 2) throw err;
            log?.warning?.(`realtor fetch error (try ${attempt + 1}): ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    return null;
}

async function crawl(job) {
    const source = 'realtor';
    const {
        locations,
        realtorMax = 100,
        realtorEnrich = false,
        realtorMaxProfiles = 0,
        realtorConcurrency = 3,
    } = job.params;

    if (!activeProvider()) {
        emit(job, 'source_error', { source, message: 'No unblocker configured (set BRIGHTDATA_API_TOKEN or ZENROWS_API_KEY in web/.env).' });
        engineFinished(job);
        return;
    }

    const log = {
        info: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        warning: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
    };

    const cap = realtorMax > 0 ? realtorMax : Infinity;
    const seen = new Set();
    const collected = []; // base records (pre-enrichment)
    let total = 0;
    let pushed = 0;

    try {
        emit(job, 'progress', { source, status: 'running', message: `Querying realtor.com via ${activeProvider()}…` });

        for (const raw of locations) {
            const slug = realtorSlug(raw);
            log.info(`realtor.com: ${raw} (${slug})…`);

            // Page 1 — also gives matching_rows (the true total).
            const nd = await fetchRealtor(searchUrl(slug, 1), log);
            const pp = nd && nd.props && nd.props.pageProps
                && nd.props.pageProps.agentSearchResultsPageProps;
            if (!pp) { log.warning(`No agent data for ${raw}.`); continue; }

            const locTotal = Number(pp.matching_rows) || 0;
            total += locTotal;
            emit(job, 'meta', { source, total });
            const pageSize = (pp.agents && pp.agents.length) || 20;
            const maxPages = Math.ceil(Math.min(cap, locTotal) / pageSize) || 1;

            const ingest = (agents) => {
                for (const a of (agents || [])) {
                    if (collected.length >= cap) break;
                    const id = a.id || a.fulfillment_id;
                    if (id && seen.has(id)) continue;
                    if (id) seen.add(id);
                    const rec = mapSearchRecord(a, raw);
                    collected.push({ rec, id: a.id });
                    if (!realtorEnrich) { emit(job, 'record', { source, row: rec }); pushed += 1; }
                }
            };
            ingest(pp.agents);

            for (let p = 2; p <= maxPages && collected.length < cap; p += 1) {
                try {
                    const nd2 = await fetchRealtor(searchUrl(slug, p), log);
                    const pp2 = nd2 && nd2.props && nd2.props.pageProps
                        && nd2.props.pageProps.agentSearchResultsPageProps;
                    ingest(pp2 && pp2.agents);
                    if (collected.length % 96 === 0) log.info(`…${collected.length} agents so far`);
                } catch (err) {
                    log.warning(`Page ${p} failed: ${err.message}`);
                }
            }
        }

        // Enrichment phase — one ZenRows request per agent, bounded concurrency.
        if (realtorEnrich) {
            const limit = realtorMaxProfiles > 0 ? Math.min(realtorMaxProfiles, collected.length) : collected.length;
            log.info(`Enriching ${limit} profiles (×${realtorConcurrency})…`);
            const queue = collected.slice(0, limit);
            // Stay under ZenRows' concurrency cap (trial = 5).
            const workers = Math.min(Math.max(1, realtorConcurrency), 4);
            let idx = 0;
            const worker = async () => {
                while (idx < queue.length) {
                    const i = idx; idx += 1;
                    const { rec, id } = queue[i];
                    if (id) {
                        try {
                            const nd = await fetchRealtor(profileUrl(id), log, true);
                            const ag = findAgent(nd && nd.props && nd.props.pageProps);
                            mergeDetail(rec, ag);
                        } catch (err) {
                            log.warning(`Enrich failed (${id}): ${err.message}`);
                        }
                    }
                    emit(job, 'record', { source, row: rec });
                    pushed += 1;
                }
            };
            await Promise.all(Array.from({ length: workers }, worker));
        }

        emit(job, 'source_done', { source, message: total && pushed < total ? `${pushed} of ${total.toLocaleString()}` : `${pushed} agents` });
    } catch (err) {
        emit(job, 'source_error', { source, message: err.message });
    } finally {
        engineFinished(job);
    }
}

/** Find the agent-detail object inside a profile page's pageProps. */
function findAgent(o, d = 0) {
    if (!o || typeof o !== 'object' || d > 9) return null;
    if ((o.license_number !== undefined || o.served_areas !== undefined) && o.fullname) return o;
    for (const k of Object.keys(o)) {
        const r = findAgent(o[k], d + 1);
        if (r) return r;
    }
    return null;
}
