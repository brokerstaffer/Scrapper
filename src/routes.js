// routes.js — request router with two handlers: SEARCH and PROFILE.
//
// The router is built by a factory so the handlers can close over the run's
// input config and shared state (de-dup set, per-location enrich counters).

import { createPlaywrightRouter } from 'crawlee';

import { scrapeSearchPage, hasNextPage } from './search-page.js';
import { enrichProfilePage } from './profile-page.js';
import { jitterMs, sleep, ZILLOW_BASE, SEARCH_PATH } from './constants.js';

export const LABELS = {
    SEARCH: 'SEARCH',
    PROFILE: 'PROFILE',
};

/** Build a search results URL for a location slug + page number. */
export function buildSearchUrl(slug, pageNumber) {
    const base = `${ZILLOW_BASE}${SEARCH_PATH}/${slug}/`;
    return pageNumber > 1 ? `${base}?page=${pageNumber}` : base;
}

export function createRouter({ input, state }) {
    const router = createPlaywrightRouter();

    router.addHandler(LABELS.SEARCH, async (context) => {
        const { page, request, log, crawler, pushData, session } = context;
        const { location, pageNumber } = request.userData;

        log.info(`SEARCH "${location.full}" page ${pageNumber} — ${request.url}`);

        let agents;
        try {
            agents = await scrapeSearchPage({ page, location, log });
        } catch (err) {
            if (err.message === 'CAPTCHA') {
                log.warning(`Captcha/block on ${request.url} — retiring session and retrying.`);
                session?.retire();
                throw new Error('Blocked by Zillow captcha; retrying with a fresh session.');
            }
            throw err;
        }

        if (agents.length === 0) {
            log.warning(`No agents parsed for "${location.full}" page ${pageNumber}.`);
        }

        const profileRequests = [];
        for (const agent of agents) {
            const url = agent['Zillow Profile URL'];
            if (!url) continue;
            if (state.seen.has(url)) continue; // dedupe across pages/locations
            state.seen.add(url);

            if (input.enrichProfiles) {
                const used = state.profileCounts[location.slug] || 0;
                const underCap = input.maxProfilesPerLocation === 0
                    || used < input.maxProfilesPerLocation;
                if (underCap) {
                    state.profileCounts[location.slug] = used + 1;
                    profileRequests.push({
                        url,
                        label: LABELS.PROFILE,
                        userData: { agent, location },
                    });
                    continue;
                }
            }
            // Not enriching (or over the enrich cap): emit the Step 1 record now.
            await pushData(agent);
            state.totalPushed += 1;
        }

        if (profileRequests.length) {
            await crawler.addRequests(profileRequests);
            log.info(`Queued ${profileRequests.length} profile(s) for enrichment.`);
        }

        // Pagination — respect maxPages and Zillow's 25-page cap.
        if (pageNumber < input.maxPages && (await hasNextPage(page, pageNumber))) {
            const nextUrl = buildSearchUrl(location.slug, pageNumber + 1);
            await crawler.addRequests([{
                url: nextUrl,
                label: LABELS.SEARCH,
                userData: { location, pageNumber: pageNumber + 1 },
            }]);
        }

        // Rate-limit: with concurrency 1 this spaces out subsequent requests.
        await sleep(jitterMs(input.delayBetweenPages));
    });

    router.addHandler(LABELS.PROFILE, async (context) => {
        const { page, request, log, pushData, session } = context;
        const { agent } = request.userData;

        log.info(`PROFILE ${request.url}`);

        try {
            await enrichProfilePage({ page, agent, log });
        } catch (err) {
            if (err.message === 'CAPTCHA') {
                log.warning(`Captcha/block on profile ${request.url} — retiring session and retrying.`);
                session?.retire();
                throw new Error('Blocked by Zillow captcha on profile; retrying.');
            }
            // On other profile errors, still emit the Step 1 data we already have.
            log.warning(`Profile enrichment failed (${err.message}); pushing base record.`);
        }

        await pushData(agent);
        state.totalPushed += 1;

        await sleep(jitterMs(input.delayBetweenProfiles));
    });

    // Fallback: if a request arrives without a known label, treat as SEARCH page 1.
    router.addDefaultHandler(async (context) => {
        const { request, log } = context;
        log.warning(`Unlabeled request ${request.url} — skipping.`);
    });

    return router;
}
