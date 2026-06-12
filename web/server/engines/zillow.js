// engines/zillow.js — Zillow engine: anti-bot hardened + concurrent.
//
// Strategy:
//   1. Fetch page 1 of a location (a single probe). If it has a "next page",
//      fan out the remaining pages (2..maxPages, capped at Zillow's 25-page
//      limit) and fetch them CONCURRENTLY.
//   2. Every agent found streams out immediately. If enrichment is on, each
//      agent's profile is queued and scraped concurrently too.
//
// Concurrency is bounded (default 4) — high enough to be fast, low enough to
// avoid Zillow's bot detection and the proxy's per-account thread limit. Each
// concurrent slot is a separate browser with its own generated fingerprint and
// (via the rotating residential proxy) its own IP, which actually *helps*
// stealth by spreading load across identities.

import { PlaywrightCrawler, ProxyConfiguration, Configuration } from 'crawlee';

import { parseLocation } from '../../../src/parser.js';
import { scrapeSearchPage, hasNextPage } from '../../../src/search-page.js';
import { enrichProfilePage } from '../../../src/profile-page.js';
import { ZILLOW_BASE, SEARCH_PATH, jitterMs, sleep } from '../../../src/constants.js';
import { emit, engineFinished } from '../jobs.js';

Configuration.getGlobalConfig().set('persistStorage', false);
Configuration.getGlobalConfig().set('purgeOnStart', false);

const ZILLOW_PAGE_CAP = 25; // Zillow never serves more than 25 agent pages
let chain = Promise.resolve();

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
    const concurrency = Math.min(Math.max(1, zillowConcurrency || 4), 12);

    const log = {
        info: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        warning: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        debug: () => {},
    };

    const proxyUrl = process.env.ZILLOW_PROXY_URL;
    const proxyConfiguration = proxyUrl ? new ProxyConfiguration({ proxyUrls: [proxyUrl] }) : undefined;
    if (!proxyConfiguration) {
        emit(job, 'progress', { source, status: 'running', message: '⚠ No residential proxy set — Zillow will likely block.' });
    }

    const seen = new Set();      // profile URL dedupe
    const pagesQueued = new Set(); // `${slug}:${p}` so we fan out a location's pages once
    let pushed = 0;
    let enrichedQueued = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: concurrency,
        minConcurrency: 1,
        maxRequestRetries: 8,
        requestHandlerTimeoutSecs: 200,
        navigationTimeoutSecs: 90,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 200 },
        browserPoolOptions: { useFingerprints: true },
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            },
        },
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                if (!page.__blocked) {
                    page.__blocked = true;
                    await page.route('**/*', (route) => {
                        const t = route.request().resourceType();
                        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
                        return route.continue();
                    });
                }
                if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';
            },
        ],
        requestHandler: async (ctx) => {
            const { page, request, session, crawler: cr } = ctx;
            const { label, location, pageNumber, agent } = request.userData;

            // --- PROFILE enrichment ---
            if (label === 'PROFILE') {
                try {
                    await enrichProfilePage({ page, agent, log });
                } catch (err) {
                    if (err.message === 'CAPTCHA') { session?.retire(); throw new Error('captcha (profile)'); }
                    log.warning(`Profile enrich failed: ${err.message}`);
                }
                emit(job, 'record', { source, row: agent });
                pushed += 1;
                return;
            }

            // --- SEARCH page ---
            let agents;
            try {
                agents = await scrapeSearchPage({ page, location, log });
            } catch (err) {
                if (err.message === 'CAPTCHA') {
                    log.warning(`Captcha on ${location.full} p${pageNumber} — new IP, retrying…`);
                    session?.retire();
                    throw new Error('captcha');
                }
                throw err;
            }

            // From page 1, fan out the rest of this location's pages at once.
            if (pageNumber === 1 && maxPages > 1 && agents.length > 0) {
                const more = await hasNextPage(page, 1).catch(() => false);
                if (more) {
                    const reqs = [];
                    for (let p = 2; p <= maxPages; p += 1) {
                        const key = `${location.slug}:${p}`;
                        if (pagesQueued.has(key)) continue;
                        pagesQueued.add(key);
                        reqs.push({
                            url: buildSearchUrl(location.slug, p),
                            uniqueKey: `S:${key}`,
                            label: 'SEARCH',
                            userData: { label: 'SEARCH', location, pageNumber: p },
                        });
                    }
                    if (reqs.length) {
                        log.info(`${location.full}: fanning out ${reqs.length} more pages (×${concurrency})…`);
                        await cr.addRequests(reqs);
                    }
                }
            }

            const profileReqs = [];
            for (const a of agents) {
                const url = a['Zillow Profile URL'];
                if (url && seen.has(url)) continue;
                if (url) seen.add(url);

                if (zillowEnrich && url && (!zillowMaxProfiles || enrichedQueued < zillowMaxProfiles)) {
                    enrichedQueued += 1;
                    profileReqs.push({ url, uniqueKey: `P:${url}`, label: 'PROFILE', userData: { label: 'PROFILE', agent: a, location } });
                } else {
                    emit(job, 'record', { source, row: a });
                    pushed += 1;
                }
            }
            if (profileReqs.length) await cr.addRequests(profileReqs);

            await sleep(jitterMs(2, 1)); // small human-ish jitter
        },
        failedRequestHandler: async ({ request }, err) => {
            // A page we gave up on (e.g. nonexistent page > last) — fine to skip.
            log.warning(`Skipped ${request.url.replace(ZILLOW_BASE, '')}: ${err.message}`);
        },
    }, new Configuration({ persistStorage: false, purgeOnStart: false }));

    const startRequests = locations.map((raw) => {
        const location = parseLocation(raw);
        return {
            url: buildSearchUrl(location.slug, 1),
            uniqueKey: `S:${location.slug}:1`,
            label: 'SEARCH',
            userData: { label: 'SEARCH', location, pageNumber: 1 },
        };
    });

    try {
        emit(job, 'progress', { source, status: 'running', message: `Launching ${concurrency} stealth browsers…` });
        await crawler.run(startRequests);
        if (pushed === 0) {
            emit(job, 'source_error', { source, message: 'Zillow blocked all attempts (captcha). Try again — the proxy rotates IPs.' });
        } else {
            emit(job, 'source_done', { source, message: `${pushed} agents` });
        }
    } catch (err) {
        emit(job, 'source_error', { source, message: err.message });
    } finally {
        await crawler.teardown().catch(() => {});
        engineFinished(job);
    }
}
