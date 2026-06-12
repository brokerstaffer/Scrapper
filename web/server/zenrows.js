// zenrows.js — thin client for the ZenRows HTTP API.
// Used to fetch hard-blocked sites (realtor.com, Zillow profiles) that need
// premium proxies + anti-bot. Returns the target page's HTML.

const ENDPOINT = 'https://api.zenrows.com/v1/';

/**
 * Fetch a URL through ZenRows. `jsRender` defaults to false (cheaper) — many
 * targets (realtor.com) are server-rendered so the data is already in the HTML.
 * Set jsRender:true for SPA pages. Retries transient failures.
 */
export async function fetchViaZenRows(targetUrl, opts = {}) {
    const {
        jsRender = false, premium = true, country = 'us',
        timeoutMs = 120000, retries = 2,
    } = opts;
    const key = process.env.ZENROWS_API_KEY;
    if (!key) throw new Error('ZENROWS_API_KEY not set');

    const params = new URLSearchParams({ apikey: key, url: targetUrl });
    if (jsRender) params.set('js_render', 'true');
    if (premium) params.set('premium_proxy', 'true');
    if (country) params.set('proxy_country', country);
    const url = `${ENDPOINT}?${params.toString()}`;

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            const body = await res.text();
            if (res.ok) return body;
            // 4xx (except 429 concurrency) are deterministic — don't retry.
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`ZenRows ${res.status}: ${body.slice(0, 140)}`);
            }
            lastErr = new Error(`ZenRows ${res.status}: ${body.slice(0, 140)}`);
        } catch (err) {
            clearTimeout(timer);
            if (/ZenRows 4\d\d/.test(err.message)) throw err; // already a hard 4xx
            lastErr = err;
        }
        // Backoff — longer for 429 (concurrency) so the pool drains.
        await sleep(2000 * (attempt + 1));
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
