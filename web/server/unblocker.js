// unblocker.js — unified web-unblocker client for hard-blocked sites
// (realtor.com, Zillow profiles). Supports two providers, chosen via env:
//   - Bright Data Web Unlocker  (PAYG, ~$1.5/1k — cheapest; preferred)
//   - ZenRows Universal Scraper API  (subscription)
// Set UNBLOCKER_PROVIDER to force one, else it auto-detects from whichever
// credentials are present (Bright Data first).

const BD_ENDPOINT = 'https://api.brightdata.com/request';
const ZR_ENDPOINT = 'https://api.zenrows.com/v1/';

export function activeProvider() {
    const p = (process.env.UNBLOCKER_PROVIDER || '').toLowerCase();
    if (p === 'brightdata' || p === 'zenrows') return p;
    if (process.env.BRIGHTDATA_API_TOKEN) return 'brightdata';
    if (process.env.ZENROWS_API_KEY) return 'zenrows';
    return '';
}

/** Fetch a page's HTML through the configured unblocker. */
export async function fetchUnblocked(targetUrl, opts = {}) {
    const provider = activeProvider();
    if (provider === 'brightdata') return fetchBrightData(targetUrl, opts);
    if (provider === 'zenrows') return fetchZenRows(targetUrl, opts);
    throw new Error('No unblocker configured (set BRIGHTDATA_API_TOKEN or ZENROWS_API_KEY).');
}

// --- Bright Data Web Unlocker (auto-renders; one flat call) ---
async function fetchBrightData(url, { timeoutMs = 120000, retries = 2 } = {}) {
    const token = process.env.BRIGHTDATA_API_TOKEN;
    const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(BD_ENDPOINT, {
                method: 'POST',
                signal: ctrl.signal,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ zone, url, format: 'raw' }),
            });
            clearTimeout(timer);
            const body = await res.text();
            if (res.ok) return body;
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`BrightData ${res.status}: ${body.slice(0, 140)}`);
            }
            lastErr = new Error(`BrightData ${res.status}: ${body.slice(0, 140)}`);
        } catch (err) {
            clearTimeout(timer);
            if (/BrightData 4\d\d/.test(err.message)) throw err;
            lastErr = err;
        }
        await sleep(2000 * (i + 1));
    }
    throw lastErr;
}

// --- ZenRows Universal Scraper API ---
async function fetchZenRows(url, { render = false, country = 'us', timeoutMs = 120000, retries = 2 } = {}) {
    const key = process.env.ZENROWS_API_KEY;
    const params = new URLSearchParams({ apikey: key, url });
    if (render) params.set('js_render', 'true');
    params.set('premium_proxy', 'true');
    if (country) params.set('proxy_country', country);
    const endpoint = `${ZR_ENDPOINT}?${params.toString()}`;
    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(endpoint, { signal: ctrl.signal });
            clearTimeout(timer);
            const body = await res.text();
            if (res.ok) return body;
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`ZenRows ${res.status}: ${body.slice(0, 140)}`);
            }
            lastErr = new Error(`ZenRows ${res.status}`);
        } catch (err) {
            clearTimeout(timer);
            if (/ZenRows 4\d\d/.test(err.message)) throw err;
            lastErr = err;
        }
        await sleep(2000 * (i + 1));
    }
    throw lastErr;
}

/** Pull and parse the Next.js __NEXT_DATA__ JSON blob from a page's HTML. */
export function extractNextData(html) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
