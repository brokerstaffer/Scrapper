// main.js — Apify actor entry point. Orchestrates the Zillow agent scrape.

import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

import { parseLocation } from './parser.js';
import { createRouter, buildSearchUrl, LABELS } from './routes.js';
import { randomUserAgent, createEmptyAgent } from './constants.js';

await Actor.init();

// --- Read & normalize input ---
const input = (await Actor.getInput()) || {};

const config = {
    locations: Array.isArray(input.locations) ? input.locations.filter(Boolean) : [],
    profileUrls: Array.isArray(input.profileUrls) ? input.profileUrls.filter(Boolean) : [],
    maxPages: clampInt(input.maxPages, 1, 25, 25),
    enrichProfiles: Boolean(input.enrichProfiles),
    maxProfilesPerLocation: Math.max(0, parseInt(input.maxProfilesPerLocation, 10) || 0),
    delayBetweenPages: clampInt(input.delayBetweenPages, 2, 30, 5),
    delayBetweenProfiles: clampInt(input.delayBetweenProfiles, 2, 30, 4),
};

if (config.locations.length === 0 && config.profileUrls.length === 0) {
    throw new Error('Provide at least one of "locations" (to search) or "profileUrls" (to scrape specific profiles).');
}

log.info(`Starting Zillow Agent Scraper for ${config.locations.length} location(s).`);
log.info(`Config: ${JSON.stringify({ ...config }, null, 0)}`);

// --- Proxy ---
// Residential proxies are strongly recommended for Zillow.
const proxyConfiguration = await Actor.createProxyConfiguration(
    input.proxy || { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
);
if (!proxyConfiguration) {
    log.warning('No proxy configured — Zillow will likely block requests. Residential proxies strongly recommended.');
}

// --- Shared state across handlers ---
const state = {
    seen: new Set(), // profile URLs already handled (global dedupe)
    profileCounts: {}, // slug -> profiles enqueued for enrichment
    totalPushed: 0,
};

// --- Build initial (page 1) requests ---
const startRequests = config.locations.map((raw) => {
    const location = parseLocation(raw);
    return {
        url: buildSearchUrl(location.slug, 1),
        label: LABELS.SEARCH,
        userData: { location, pageNumber: 1 },
    };
});

// Direct profile URLs → enqueue straight to the PROFILE handler with an empty
// record (the profile page fills in name/brokerage/everything).
for (const raw of config.profileUrls) {
    const url = String(raw).trim().split('#')[0];
    if (!/\/profile\//i.test(url)) {
        log.warning(`Skipping non-profile URL: ${url}`);
        continue;
    }
    const agent = createEmptyAgent();
    agent['Zillow Profile URL'] = url.split('?')[0];
    state.seen.add(agent['Zillow Profile URL']);
    startRequests.push({
        url,
        label: LABELS.PROFILE,
        userData: { agent, location: { full: '', city: '', state: '', zip: '', slug: '' } },
    });
}

const router = createRouter({ input: config, state });

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    // Anti-bot: keep traffic gentle and sessions sticky-then-rotated.
    maxConcurrency: 1, // never open multiple tabs to Zillow at once
    maxRequestRetries: 5, // captcha/block pages get retried with fresh sessions
    requestHandlerTimeoutSecs: 180, // scrolling a full page can take a while
    navigationTimeoutSecs: 60,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize: 50,
    },
    browserPoolOptions: {
        useFingerprints: true,
    },
    launchContext: {
        launchOptions: {
            headless: true,
        },
    },
    preNavigationHooks: [
        async (crawlingContext, gotoOptions) => {
            const { page } = crawlingContext;

            // Block images, media and fonts to cut residential-proxy bandwidth
            // by ~80% (the data we need is text). Registered once per page.
            if (!page.__resourceBlock) {
                page.__resourceBlock = true;
                await page.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    if (type === 'image' || type === 'media' || type === 'font') {
                        return route.abort();
                    }
                    return route.continue();
                });
            }

            // Vary the user agent per request and set a realistic language header.
            const ua = randomUserAgent();
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
            });
            try {
                await page.context().setExtraHTTPHeaders({ 'User-Agent': ua });
            } catch {
                // setExtraHTTPHeaders for UA may be ignored by some engines; the
                // fingerprint generator already randomizes the UA, so this is best-effort.
            }
            if (gotoOptions) gotoOptions.waitUntil = 'domcontentloaded';
        },
    ],
});

await crawler.addRequests(startRequests);
await crawler.run();

log.info(`Done. Pushed ${state.totalPushed} agent record(s) to the dataset.`);

await Actor.exit();

// --- helpers ---
function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}
