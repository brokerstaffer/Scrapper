// engines/zillow.js — Zillow engine, fully on the unblocker (Bright Data).
//
// No residential proxy / crawlee anymore: we fetch each Zillow page's HTML via
// the unblocker, load it into a Playwright page with setContent, and run the
// proven parsers (scrapeSearchPage for the list, enrichProfilePage for details).
//   - Search: 1 unblocker request per page (Zillow serves 15 agents/page, 25-page cap)
//   - Enrich: 1 unblocker request per agent profile
// This eliminates LightningProxies and Zillow's 403/captcha walls in one move.

import { chromium } from 'playwright';

import { parseLocation } from '../../../src/parser.js';
import { scrapeSearchPage, hasNextPage } from '../../../src/search-page.js';
import { enrichProfilePage } from '../../../src/profile-page.js';
import { ZILLOW_BASE, SEARCH_PATH } from '../../../src/constants.js';
import { fetchUnblocked, activeProvider } from '../unblocker.js';
import { emit, engineFinished } from '../jobs.js';

const ZILLOW_PAGE_CAP = 25; // Zillow never serves more than 25 agent pages
let chain = Promise.resolve(); // serialize Zillow runs

function buildSearchUrl(slug, pageNumber) {
    const base = `${ZILLOW_BASE}${SEARCH_PATH}/${slug}/`;
    return pageNumber > 1 ? `${base}?page=${pageNumber}` : base;
}

export function runZillow(job) {
    chain = chain.then(() => crawl(job)).catch(() => {});
    return chain;
}

async function crawl(job) {
    const source = 'zillow';
    const {
        locations,
        zillowMaxPages = ZILLOW_PAGE_CAP,
        zillowEnrich = false,
        zillowMaxProfiles = 0,
        zillowConcurrency = 4,
    } = job.params;
    const maxPages = Math.min(Math.max(1, zillowMaxPages || ZILLOW_PAGE_CAP), ZILLOW_PAGE_CAP);
    const workers = Math.min(Math.max(1, zillowConcurrency || 4), 5);

    const log = {
        info: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        warning: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        debug: () => {},
    };

    if (!activeProvider()) {
        emit(job, 'source_error', { source, message: 'No unblocker configured (set BRIGHTDATA_API_TOKEN in web/.env).' });
        engineFinished(job);
        return;
    }

    const seen = new Set();
    const toEnrich = [];
    let pushed = 0;

    const ingest = (agents) => {
        for (const a of (agents || [])) {
            const url = a['Zillow Profile URL'];
            if (url && seen.has(url)) continue;
            if (url) seen.add(url);
            if (zillowEnrich && url) toEnrich.push(a);
            else { emit(job, 'record', { source, row: a }); pushed += 1; }
        }
    };

    const browser = await chromium.launch({ headless: true });
    try {
        emit(job, 'progress', { source, status: 'running', message: `Querying Zillow via ${activeProvider()}…` });

        for (const raw of locations) {
            if (job.aborted) break;
            const location = parseLocation(raw);
            log.info(`Zillow: ${location.full}…`);

            let first;
            try {
                first = await fetchSearch(browser, buildSearchUrl(location.slug, 1), location, log);
            } catch (err) {
                log.warning(`${location.full} page 1 failed: ${err.message}`);
                continue;
            }
            ingest(first.agents);

            if (first.hasNext && maxPages > 1) {
                log.info(`${location.full}: fanning out pages 2–${maxPages} (×${workers})…`);
                const pageNums = [];
                for (let p = 2; p <= maxPages; p += 1) pageNums.push(p);
                let i = 0;
                const worker = async () => {
                    while (i < pageNums.length) {
                        if (job.aborted) return;
                        const p = pageNums[i]; i += 1;
                        try {
                            const r = await fetchSearch(browser, buildSearchUrl(location.slug, p), location, log);
                            ingest(r.agents);
                        } catch (err) {
                            log.warning(`page ${p} failed: ${err.message}`);
                        }
                    }
                };
                await Promise.all(Array.from({ length: workers }, worker));
            }
        }

        // --- Enrichment phase (profiles via unblocker) ---
        if (zillowEnrich && toEnrich.length) {
            pushed += await enrichZillow(job, toEnrich, { zillowMaxProfiles, workers }, log, browser);
        }

        if (pushed === 0) {
            emit(job, 'source_error', { source, message: 'No Zillow agents found (check the location spelling).' });
        } else {
            emit(job, 'source_done', { source, message: `${pushed} agents` });
        }
    } catch (err) {
        emit(job, 'source_error', { source, message: err.message });
    } finally {
        await browser.close().catch(() => {});
        engineFinished(job);
    }
}

/** Fetch one Zillow search page via the unblocker and parse its agent list. */
async function fetchSearch(browser, url, location, log) {
    const html = await fetchUnblocked(url, { render: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        const agents = await scrapeSearchPage({ page, location, log }).catch(() => []);
        const hasNext = await hasNextPage(page, 1).catch(() => false);
        return { agents, hasNext };
    } finally {
        await ctx.close().catch(() => {});
    }
}

/** Enrich agents: fetch each profile via the unblocker, parse with enrichProfilePage. */
async function enrichZillow(job, agents, opts, log, browser) {
    const source = 'zillow';
    const cap = opts.zillowMaxProfiles > 0 ? Math.min(opts.zillowMaxProfiles, agents.length) : agents.length;
    const queue = agents.slice(0, cap);
    let pushed = 0;

    for (const a of agents.slice(cap)) { emit(job, 'record', { source, row: a }); pushed += 1; }

    log.info(`Enriching ${queue.length} Zillow profiles via ${activeProvider()}…`);
    let idx = 0;
    const worker = async () => {
        while (idx < queue.length) {
            if (job.aborted) return;
            const a = queue[idx]; idx += 1;
            try {
                const html = await fetchUnblocked(a['Zillow Profile URL'], { render: true });
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                await page.setContent(html, { waitUntil: 'domcontentloaded' });
                await enrichProfilePage({ page, agent: a, log: { info() {}, warning() {}, debug() {} } });
                await ctx.close().catch(() => {});
            } catch (err) {
                log.warning(`Zillow enrich failed: ${err.message}`);
            }
            emit(job, 'record', { source, row: a });
            pushed += 1;
        }
    };
    await Promise.all(Array.from({ length: opts.workers }, worker));
    return pushed;
}
