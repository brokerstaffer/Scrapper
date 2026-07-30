// mls.js — enumerate the MLS(s) an account can see, with an exact agent count
// per MLS. Shared by the import picker (POST /api/courted/mls-list) and the
// account MLS monitor (POST /api/courted/mls-scan). Sampling a few ordered pages
// surfaces the distinct MLS codes cheaply; the exact count per code then comes
// from the server-side mls_id filter (the same filter the sweep uses, so counts
// match what an import would pull).

import { buildSearchQuery, fetchSearchPage } from './api.js';
import { DEFAULT_STATUSES, sleep } from './constants.js';

// Fast set (import picker) — top/bottom by volume + newest surfaces the material
// MLSs in three cheap pages.
const DEFAULT_ORDERS = [
    { orderBy: 'ltm_sales_volume', orderDirection: 'desc' },
    { orderBy: 'ltm_sales_volume', orderDirection: 'asc' },
    { orderBy: 'agent_tenure', orderDirection: 'desc' },
];
// Thorough set (monitor) — more orderings surface tiny MLSs too, so an add/remove
// diff doesn't misfire on a small MLS that a single ordering happened to miss.
const THOROUGH_ORDERS = [
    ...DEFAULT_ORDERS,
    { orderBy: 'agent_tenure', orderDirection: 'asc' },
    { orderBy: 'ltm_closed_units', orderDirection: 'desc' },
    { orderBy: 'active_listings', orderDirection: 'desc' },
];

// The MLS "code" is the suffix of courted_mls_id (e.g. 629029835_MFRMLS →
// MFRMLS), which is exactly what mls_id=<CODE> expects.
function codeOf(r) {
    const cmid = String(r.courted_mls_id || '');
    return (cmid.includes('_') ? cmid.replace(/^[^_]*_/, '') : String(r.mls_id || '')).trim();
}

/**
 * @param session  authenticated Courted session
 * @param opts.thorough  use the larger ordering set (monitor); default false (picker)
 * @returns {Promise<{ total:number, mls:{code,name,count}[] }>} total = whole account.
 */
export async function detectAccountMls(session, { thorough = false, sample = 500, delayMs = 400 } = {}) {
    const orders = thorough ? THOROUGH_ORDERS : DEFAULT_ORDERS;
    const names = new Map(); // code -> mls_short_name (display)
    let total = 0;
    for (const o of orders) {
        const q = buildSearchQuery({
            limit: sample, offset: 0, orderBy: o.orderBy, orderDirection: o.orderDirection,
            statuses: DEFAULT_STATUSES, includeContactInfo: false,
        });
        const d = await fetchSearchPage(session, q);
        if (Number.isFinite(d.count)) total = Math.max(total, d.count);
        for (const r of (d.results || [])) {
            const code = codeOf(r);
            if (!code) continue;
            const name = String(r.mls_short_name || '').trim();
            if (!names.has(code) || (!names.get(code) && name)) names.set(code, name);
        }
        await sleep(delayMs);
    }
    const mls = [];
    for (const [code, name] of names) {
        const q = buildSearchQuery({
            limit: 1, offset: 0, statuses: DEFAULT_STATUSES, includeContactInfo: false,
            extraParams: { mls_id: code },
        });
        const d = await fetchSearchPage(session, q);
        mls.push({ code, name: name || code, count: Number.isFinite(d.count) ? d.count : 0 });
        await sleep(delayMs);
    }
    mls.sort((a, b) => b.count - a.count);
    return { total, mls };
}
