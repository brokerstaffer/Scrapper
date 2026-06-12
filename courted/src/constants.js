// constants.js — output columns, endpoints, and small formatting helpers for
// the Courted agent scraper.
//
// Courted is an MLS-driven brokerage CRM, NOT Zillow — so the data model is
// different. Where a Zillow field has a Courted equivalent we use it; the rest
// of the columns expose Courted's much richer production data (LTM sales volume,
// GCI, buy/list-side splits, predictions, likelihood-to-move, tenure, etc.).
// Every record carries ALL columns (empty string when missing) so CSV/Excel
// exports line up.

export const COGNITO_ENDPOINT = 'https://cognito-idp.us-east-1.amazonaws.com/';
// Public SPA client id (read from the broker-ui at sign-in time). Not a secret —
// it identifies the app, the user's password is still required.
export const COGNITO_CLIENT_ID = '2pf8vbespm0pkm8cffmpkgkjl';

export const API_BASE = 'https://api.courted.io/api';
export const AGENT_SEARCH_PATH = '/mls/broker/agent_search/';

// The status set the UI sends by default (active + various pipeline states).
// Without it the API still returns rows, but we mirror the UI exactly.
export const DEFAULT_STATUSES = [2, 3, 9, 4, 5, 6, 10, 7, 11, 8];

// Frontend deep-link pattern for an agent's profile (best-effort; the canonical
// identifier is "Courted Agent ID" = courted_mls_id).
export const PROFILE_URL_BASE = 'https://brokerage.courted.io/cts/candidates/agentsearch/';

// Ordered output columns.
export const OUTPUT_COLUMNS = [
    // --- Identity & contact ---
    'Name',
    'First Name',
    'Last Name',
    'Nickname',
    'Email',
    'Phone',
    'Mobile Phone',
    'Saved Contact Info',          // broker_agent_contact_info (CRM-saved)
    'Profile Photo URL',
    'Courted Profile URL',
    'Courted Agent ID',            // courted_mls_id (stable key)
    'Courted ID',                  // courted_id
    'Member MLS ID',
    // --- Office / brokerage ---
    'Office',                      // current_office_name
    'Custom Office Name',
    'Brand',                       // brand_name
    'Office Address',              // (enrichment) full street
    'Office City',
    'Office State',
    'Office Zip',
    'Time At Current Office (mos)',
    'Avg Time At Office (mos)',
    // --- Experience ---
    'Years Of Experience',         // agent_tenure converted to "X yrs Y mos"
    'Agent Tenure (mos)',
    'Is New Agent',
    // --- Sales & activity (LTM = trailing 12 months) ---
    'LTM Sales Volume',
    'Prev LTM Sales Volume',
    'Sales Volume Change %',
    'LTM Est GCI',
    'LTM Avg Sale Price',
    'LTM Closed Transactions',
    'LTM Closed Units',
    'LTM Units Buy-Side',
    'LTM Units List-Side',
    'LTM Sales Volume Buy-Side',
    'LTM Sales Volume List-Side',
    'LTM Avg Sale Price Buy-Side',
    'LTM Avg Sale Price List-Side',
    'LTM Close-To-List Price %',
    'LTM Avg Days On Market',
    'LTM Rental Count',
    'LTM Avg Rental Price',
    // --- Year to date ---
    'YTD Sales Volume',
    'YTD Units',
    'YTD Avg Sale Price',
    // --- Listings ---
    'Active Listings',
    'Pending Listings',
    // --- Predictions / signals ---
    'Sales Volume Prediction',
    'Prediction Low',
    'Prediction High',
    'Likelihood To Move',
    'Future Growth Tag',
    'Forecast Segment',            // (enrichment)
    'AI Agent Type',               // (enrichment)
    // --- Most transacted area ---
    'Most Transacted City',
    'Most Transacted State',
    'Most Transacted Zip',
    // --- MLS / licensing ---
    'MLS',                         // mls_short_name
    'MLS ID',
    'State License',
    'Alt State Licenses',
    'MLS Affiliations',            // (enrichment)
    // --- Role flags (enrichment) ---
    'Is Team Leader',
    'Is Team Member',
    'Is Managing Broker',
    'Is Rental Agent',
    // --- Home / personal ---
    'Home Address',
    'Home City',
    'Home State',
    'Home Zip',
    // --- CRM / pipeline ---
    'Prospect Status',
    'Assigned To',
    'Connections',
    'Is Watching',
    'Is Liked',
    // --- Search context ---
    'Searched Location',
];

export function createEmptyAgent() {
    const a = {};
    for (const c of OUTPUT_COLUMNS) a[c] = '';
    return a;
}

// --- formatting helpers ---

/** Round a numeric value to an integer string; '' for null/NaN. */
export function int(v) {
    if (v === null || v === undefined || v === '' || v === 'None') return '';
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n)) : '';
}

/** Round to 2 decimals; '' for null/NaN. */
export function dec(v, places = 2) {
    if (v === null || v === undefined || v === '' || v === 'None') return '';
    const n = Number(v);
    return Number.isFinite(n) ? String(Number(n.toFixed(places))) : '';
}

/** Percent value rounded to 1 decimal (the API already returns whole-percent). */
export function pct(v) {
    if (v === null || v === undefined || v === '' || v === 'None') return '';
    const n = Number(v);
    return Number.isFinite(n) ? `${Number(n.toFixed(1))}%` : '';
}

/** A clean string; treats Courted's literal "None"/null as empty. */
export function str(v) {
    if (v === null || v === undefined) return '';
    const s = String(v).trim();
    return s === 'None' || s === 'null' ? '' : s;
}

/** Yes/No from a boolean-ish value. */
export function yesno(v) {
    if (v === true || v === 1 || v === '1') return 'Yes';
    if (v === false || v === 0 || v === '0') return 'No';
    return '';
}

/** Months (float) -> "20 yrs 7 mos". */
export function monthsToYears(months) {
    const n = Number(months);
    if (!Number.isFinite(n) || n <= 0) return '';
    const y = Math.floor(n / 12);
    const m = Math.round(n - y * 12);
    const mm = m === 12 ? 0 : m; // rounding guard
    const yy = m === 12 ? y + 1 : y;
    const parts = [];
    if (yy) parts.push(`${yy} yr${yy === 1 ? '' : 's'}`);
    parts.push(`${mm} mo${mm === 1 ? '' : 's'}`);
    return parts.join(' ');
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
