// search-page.js — Step 1: scrape an agent search results page.
//
// Zillow renders the agent list with a virtualized window, so only ~15 profile
// <a> tags exist in the DOM at any time. We slow-scroll the page and collect
// links at every scroll position, tracking unique hrefs, until no new links
// appear for several consecutive scrolls.

import {
    CAPTCHA_MARKERS,
    SCROLL_STEP_PX,
    SCROLL_DELAY_MS,
    SCROLL_MAX_IDLE,
    SCROLL_MAX_STEPS,
    sleep,
} from './constants.js';
import { parseAgentText, dedupeBrokerage } from './parser.js';

const PROFILE_LINK_SELECTOR = 'a[href*="/profile/"]';

/** Detect Zillow's "Press & Hold" / bot-challenge interstitial. */
export async function isCaptchaPage(page) {
    try {
        const content = await page.content();
        return CAPTCHA_MARKERS.some((m) => content.includes(m));
    } catch {
        return false;
    }
}

/** Normalize a profile href into an absolute, query-stripped URL. */
function normalizeProfileUrl(href) {
    if (!href) return '';
    let url = href.trim();
    if (url.startsWith('/')) url = `https://www.zillow.com${url}`;
    // Strip query string and trailing slash for stable de-duplication.
    url = url.split('?')[0].split('#')[0];
    return url;
}

/**
 * Slow-scroll the page, collecting every unique profile link with its raw text
 * content and headshot image. Returns a Map keyed by normalized profile URL.
 */
async function collectAgentLinks(page, log) {
    /** @type {Map<string, {url: string, rawText: string, photo: string}>} */
    const found = new Map();
    let idle = 0;
    let steps = 0;

    while (idle < SCROLL_MAX_IDLE && steps < SCROLL_MAX_STEPS) {
        const batch = await page.$$eval(PROFILE_LINK_SELECTOR, (anchors) => {
            // Walk an element collecting an ordered list of text "segments" —
            // the trimmed text of each leaf element plus interspersed text nodes.
            // Zillow renders name / brokerage / price / sales as separate inline
            // elements, so this recovers the boundaries that textContent glues
            // together (critical for splitting team name from brokerage).
            function leafSegments(root) {
                const out = [];
                const walk = (el) => {
                    for (const node of el.childNodes) {
                        if (node.nodeType === 3) {
                            const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
                            if (t) out.push(t);
                        } else if (node.nodeType === 1) {
                            if (node.children.length === 0) {
                                const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
                                if (t) out.push(t);
                            } else {
                                walk(node);
                            }
                        }
                    }
                };
                walk(root);
                return out;
            }

            return anchors.map((a) => {
                let photo = '';
                const img = a.querySelector('img');
                if (img) photo = img.getAttribute('src') || img.getAttribute('data-src') || '';
                // Top Agent badge — text OR the badge icon's alt/aria-label/title.
                const rawText = (a.textContent || '').replace(/\s+/g, ' ').trim();
                const topAgent = /top agent/i.test(rawText)
                    || !!a.querySelector('img[alt*="Top Agent" i], [aria-label*="Top Agent" i], [title*="Top Agent" i]');
                return {
                    href: a.getAttribute('href') || '',
                    rawText,
                    segments: leafSegments(a),
                    photo,
                    topAgent,
                };
            });
        });

        let newCount = 0;
        for (const item of batch) {
            const url = (item.href || '');
            if (!url.includes('/profile/')) continue;
            const normalized = url.startsWith('http')
                ? url.split('?')[0].split('#')[0]
                : `https://www.zillow.com${url}`.split('?')[0].split('#')[0];
            if (!normalized.includes('/profile/')) continue;
            if (!found.has(normalized)) {
                found.set(normalized, {
                    url: normalized,
                    rawText: item.rawText,
                    segments: item.segments || [],
                    photo: item.photo || '',
                    topAgent: !!item.topAgent,
                });
                newCount += 1;
            } else {
                const existing = found.get(normalized);
                if (item.rawText && item.rawText.length > existing.rawText.length) {
                    // Keep the richest text we've seen for this agent.
                    existing.rawText = item.rawText;
                    if (item.segments && item.segments.length > existing.segments.length) {
                        existing.segments = item.segments;
                    }
                }
                if (!existing.photo && item.photo) existing.photo = item.photo;
                if (item.topAgent) existing.topAgent = true; // badge seen on any scroll
            }
        }

        idle = newCount === 0 ? idle + 1 : 0;
        steps += 1;

        // Scroll down one step and let lazy content render.
        const atBottom = await page.evaluate((stepPx) => {
            const before = window.scrollY;
            window.scrollBy(0, stepPx);
            // Tell us if we cannot scroll any further.
            return window.scrollY === before
                && (window.innerHeight + window.scrollY) >= document.body.scrollHeight - 2;
        }, SCROLL_STEP_PX);

        await sleep(SCROLL_DELAY_MS);

        if (atBottom && newCount === 0) {
            // We're at the bottom and nothing new loaded — give it a couple
            // more idle cycles (handled by the idle counter) then stop.
            if (idle >= 2) break;
        }
    }

    if (log) log.info(`Collected ${found.size} unique agent links in ${steps} scroll steps.`);
    return found;
}

/**
 * Scrape a single, already-navigated search results page.
 * Returns an array of parsed agent records (deduped within this page).
 */
export async function scrapeSearchPage({ page, location, log }) {
    // Wait for the agent list (or a known empty/error state) to appear.
    try {
        await page.waitForSelector(PROFILE_LINK_SELECTOR, { timeout: 30000 });
    } catch {
        // No profile links — could be empty results or a block page.
        if (await isCaptchaPage(page)) {
            throw new Error('CAPTCHA');
        }
        if (log) log.warning(`No agent links found for "${location.full}".`);
        return [];
    }

    if (await isCaptchaPage(page)) {
        throw new Error('CAPTCHA');
    }

    const linkMap = await collectAgentLinks(page, log);

    const agents = [];
    for (const { url, rawText, segments, photo, topAgent } of linkMap.values()) {
        if (!rawText) continue;
        const agent = parseAgentText(rawText, url, location, segments);
        if (photo) agent['Profile Photo URL'] = photo;
        if (topAgent) agent['Top Agent on Zillow'] = 'Yes';
        agent['Brokerage'] = dedupeBrokerage(agent['Brokerage']);
        agents.push(agent);
    }

    return agents;
}

/**
 * Determine whether a next page exists. Zillow renders pagination as <button>
 * controls (not links): numbered PaginationNumberItem buttons plus a prev/next
 * "jump" button carrying rel="prev"/rel="next". We page via ?page=N URLs, so we
 * only need to detect that a further page is available. Zillow caps at 25 pages.
 */
export async function hasNextPage(page, currentPage) {
    try {
        return await page.evaluate((current) => {
            const nav = document.querySelector('nav[aria-label="Agent pages"]');
            if (!nav) return false;

            // Highest numbered page currently shown in the control.
            const nums = Array.from(nav.querySelectorAll('li[class*="PaginationNumberItem"]'))
                .map((li) => parseInt((li.textContent || '').trim(), 10))
                .filter((n) => !Number.isNaN(n));
            const maxNum = nums.length ? Math.max(...nums) : 0;
            if (current < maxNum) return true;

            // Otherwise, is the "next" control present and enabled?
            const next = nav.querySelector('button[rel="next"], a[rel="next"], [title="Next page"]');
            if (next) {
                return !(next.disabled || next.getAttribute('aria-disabled') === 'true');
            }
            return false;
        }, currentPage);
    } catch {
        return false;
    }
}

export { PROFILE_LINK_SELECTOR };
