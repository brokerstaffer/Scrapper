// profile-parser.js — F1 "Import Profile URLs" enrichment.
//
// Given a single Zillow or Realtor.com profile URL and its fetched HTML, detect
// the source and parse it into a source-native agent record using the SAME
// proven parsers the live engines use:
//   - Zillow  → src/profile-page.js  enrichProfilePage()  (DOM: tel:/mailto:,
//               __NEXT_DATA__ licenses, listing counts, socials, service areas)
//   - Realtor → engines/realtor-map.js  mergeDetail()      (__NEXT_DATA__ agent)
// Reusing one parser per source means an imported row lines up 1:1 with a scraped
// row — identical columns and identical extraction — so the two pipelines feed
// the DB the same shapes.

import { createEmptyAgent } from '../../src/constants.js';
import { enrichProfilePage } from '../../src/profile-page.js';
import { extractNextData } from './unblocker.js';
import { emptyRecord, mergeDetail } from './engines/realtor-map.js';

const SILENT = { info() {}, warning() {}, debug() {} };

/** Which source does this profile URL belong to? null = neither (skip it). */
export function detectSource(rawUrl) {
    const u = String(rawUrl || '').toLowerCase();
    if (/(^|\/\/|\.)zillow\.com\/profile\//.test(u)) return 'zillow';
    if (/(^|\/\/|\.)realtor\.com\/realestateagents\//.test(u)) return 'realtor';
    return null;
}

/**
 * Canonical form for de-duping + matching a source URL: no protocol, no www,
 * no query/hash, no trailing slash, lowercase. This is identifier #1 in the
 * cross-check waterfall (see reconcile.js).
 *   "https://www.zillow.com/profile/JaneDoe/?src=x" → "zillow.com/profile/janedoe"
 */
export function normalizeUrl(rawUrl) {
    let u = String(rawUrl || '').trim().toLowerCase();
    u = u.replace(/^https?:\/\//, '').replace(/^www\./, '');
    u = u.split(/[?#]/)[0];
    u = u.replace(/\/+$/, '');
    return u;
}

/**
 * Parse a fetched profile page into a native agent record.
 * @param {{ url:string, html:string, browser:import('playwright').Browser }} args
 * @returns {Promise<{ source:('zillow'|'realtor'|null), alive:boolean, row:object|null }>}
 *   alive=false means the URL resolved but held no real agent (dead / removed
 *   profile) — the caller skips it.
 */
export async function parseProfile({ url, html, browser }) {
    const source = detectSource(url);
    if (source === 'zillow') return parseZillow(url, html, browser);
    if (source === 'realtor') return parseRealtor(url, html);
    return { source: null, alive: false, row: null };
}

async function parseZillow(url, html, browser) {
    const row = createEmptyAgent();
    row['Zillow Profile URL'] = String(url).trim();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        // enrichProfilePage throws 'CAPTCHA' on a challenge page — let it bubble
        // so the engine retries/records it rather than banking a dead row.
        await enrichProfilePage({ page, agent: row, log: SILENT });
    } finally {
        await ctx.close().catch(() => {});
    }
    const alive = Boolean(String(row['Name'] || '').trim());
    return { source: 'zillow', alive, row };
}

function parseRealtor(url, html) {
    const row = emptyRecord();
    row['Realtor Profile URL'] = String(url).trim();
    const nd = extractNextData(html);
    const ag = findAgent(nd && nd.props && nd.props.pageProps);
    if (ag) {
        mergeDetail(row, ag);
        if (ag.id) row['Realtor Agent ID'] = ag.id;
        if (ag.fulfillment_id) row['Fulfillment ID'] = ag.fulfillment_id;
    }
    const alive = Boolean(String(row['Name'] || '').trim());
    return { source: 'realtor', alive, row };
}

// Find the agent-detail object inside a realtor profile page's pageProps.
// (Same heuristic as engines/realtor.js — kept in sync intentionally.)
function findAgent(o, d = 0) {
    if (!o || typeof o !== 'object' || d > 9) return null;
    if ((o.license_number !== undefined || o.served_areas !== undefined) && o.fullname) return o;
    for (const k of Object.keys(o)) {
        const r = findAgent(o[k], d + 1);
        if (r) return r;
    }
    return null;
}
