// constants.js — output columns, user agents, delays, and small helpers

// The full ordered list of output columns. Every dataset record carries ALL of
// these keys (empty string when not available) so CSV/Excel exports line up.
// Order = the client's exact requested CSV layout. The 5 fields added later
// (Service Areas, Average Price, Address, License State/Description) sit next to
// their natural siblings; everything else matches the spec 1:1.
export const OUTPUT_COLUMNS = [
    'Name',                  // 1
    'Brokerage',             // 2
    'Phone',                 // 3
    'Email',                 // 4
    'Rating',                // 5
    'Review Count',          // 6
    'Total Sales Count',     // 7
    'Active Listings Count', // 8  (= For Sale + For Rent)
    'For Sale Count',        // (added) — currently listed for sale
    'For Rent Count',        // (added) — currently listed for rent
    'Sold Count',            // (added) — listings on the "Sold" tab
    'Specialties',           // 9
    'Service Areas',         // (added) — sits with Specialties
    'Years of Experience',   // 10
    'Languages Spoken',      // 11
    'Location',              // 12
    'City',                  // 13
    'State',                 // 14
    'Zip Code',              // 15
    'Profile Photo URL',     // 16
    'Zillow Profile URL',    // 17
    'Top Agent on Zillow',   // 18
    'Is Team',               // (added) — Yes/No: is this profile a team?
    'Team Name',             // 19
    'Team Member Count',     // (added) — number of team members listed
    'Average Sales Volume',  // 20
    'Average Price',         // (added) — sits with Average Sales Volume
    'Sales Count Last Year', // 21
    'Premier Agent',         // 22
    'Local Sales Count',     // 23
    // --- Bonus fields ---
    'Legal Name',
    'Title',
    'Address',               // (added) — sits with Brokerage Address
    'Brokerage Address',
    'Website URL',
    'Facebook URL',
    'LinkedIn URL',
    'Instagram URL',
    'Twitter URL',
    'YouTube URL',
    'Pinterest URL',
    'License Number',
    'License State',         // (added) — sits with License Number
    'License Description',   // (added)
    'All Licenses',          // (added) — every license entry from the modal
];

// Rotated to vary the browser fingerprint between requests.
export const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

// Phrases that indicate Zillow served a bot-challenge / captcha page instead of
// real content.
export const CAPTCHA_MARKERS = [
    'Press & Hold',
    'Press &amp; Hold',
    'confirm you are a human',
    'confirm you’re a human',
    "confirm you're a human",
    'pardon our interruption',
    'px-captcha',
];

export const ZILLOW_BASE = 'https://www.zillow.com';
export const SEARCH_PATH = '/professionals/real-estate-agent-reviews';

// Scroll tuning for forcing Zillow's virtualized list to render every agent.
export const SCROLL_STEP_PX = 400;
export const SCROLL_DELAY_MS = 400;
export const SCROLL_MAX_IDLE = 8; // stop after this many scrolls with no new links
export const SCROLL_MAX_STEPS = 400; // hard safety cap

// Build an empty record with every output column present as ''.
export function createEmptyAgent() {
    const agent = {};
    for (const col of OUTPUT_COLUMNS) agent[col] = '';
    return agent;
}

// Pick a random user agent.
export function randomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Random delay in ms around a base value (seconds) ± jitter (seconds).
export function jitterMs(baseSeconds, jitterSeconds = 2) {
    const base = Number(baseSeconds) || 0;
    const delta = (Math.random() * 2 - 1) * jitterSeconds; // -jitter .. +jitter
    return Math.max(0, Math.round((base + delta) * 1000));
}

// Promise-based sleep.
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
