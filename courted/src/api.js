// api.js — typed access to Courted's private agent-search API (the same
// endpoint the web UI calls to render the agent table). NOT the Export-to-CSV
// feature — this reads the live data layer the table is built from.

import { API_BASE, AGENT_SEARCH_PATH, DEFAULT_STATUSES, sleep } from './constants.js';

const ORDERABLE = new Set([
    'ltm_sales_volume', 'ltm_est_gci', 'ltm_avg_sale_price', 'ltm_closed_transactions',
    'ltm_closed_units', 'agent_tenure', 'sales_volume_prediction', 'ltm_sales_volume_change',
    'active_listings', 'pending_listings', 'ytd_sales_volume',
]);

/** Build the query string for one page of agent search. */
export function buildSearchQuery({
    limit = 20,
    offset = 0,
    orderBy = 'ltm_sales_volume',
    orderDirection = 'desc',
    locationScope = '',
    locationValues = [],
    statuses = DEFAULT_STATUSES,
    includeContactInfo = true,
    extraParams = {},
} = {}) {
    const p = new URLSearchParams();
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    p.set('order_by', ORDERABLE.has(orderBy) ? orderBy : 'ltm_sales_volume');
    p.set('order_by_direction', orderDirection === 'asc' ? 'asc' : 'desc');
    p.set('include_broker_company_prospect_data', 'true');
    if (includeContactInfo) p.set('include_broker_agent_contact_info', 'true');
    p.set('annotate_mutual_connection_info', 'true');
    p.set('annotate_watchlists_in', 'true');
    p.set('annotate_last_re_activity_date', 'true');
    for (const s of statuses) p.append('status', String(s));

    if (locationScope && locationValues.length) {
        p.set('location_scope', locationScope); // 'city' | 'zip'
        // Multiple values are sent as repeated location_values params.
        for (const v of locationValues) p.append('location_values', v);
    }

    // Caller-supplied passthrough (e.g. a filter copied from the UI network tab).
    for (const [k, v] of Object.entries(extraParams || {})) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
        else p.set(k, String(v));
    }
    return p.toString();
}

async function authedGet(url, session, { retries = 4 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const token = await session.valid();
            const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
            if (res.status === 401 || res.status === 403) {
                // Token rejected — force a refresh and retry.
                session.expiresAt = 0;
                lastErr = new Error(`Auth rejected (${res.status})`);
            } else if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(`Server ${res.status}`);
            } else if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`GET ${res.status}: ${body.slice(0, 200)}`);
            } else {
                return res.json();
            }
        } catch (err) {
            lastErr = err;
        }
        // Exponential backoff with jitter.
        await sleep(Math.min(15000, 800 * 2 ** attempt) + Math.random() * 400);
    }
    throw lastErr || new Error('request failed');
}

/** Fetch one page of agent search results. Returns { count, next, results }. */
export async function fetchSearchPage(session, queryString) {
    const url = `${API_BASE}${AGENT_SEARCH_PATH}?${queryString}`;
    return authedGet(url, session);
}

/** Fetch a single agent's detail record by courted_mls_id. */
export async function fetchAgentDetail(session, courtedMlsId) {
    const url = `${API_BASE}${AGENT_SEARCH_PATH}${encodeURIComponent(courtedMlsId)}/`;
    return authedGet(url, session, { retries: 3 });
}
