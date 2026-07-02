// ingest.js — forward scraped rows to the Broker Staffer DB app's ingest webhook.
//
//   scraper  ──POST /api/ingest/agents──>  DB app  ──>  Supabase (upsert, no dupes)
//
// The DB app translates each source's NATIVE column names itself (its
// remapRow() handles Zillow/Realtor → Courted keys server-side) and merges
// agents across sources by license → email → phone, so re-scraping a market
// updates the same agent instead of duplicating. Therefore we send each
// source's rows EXACTLY as scraped — no client-side renaming — and just tag the
// `source` so the app knows which remap to apply.
//
// Fully env-gated: needs INGEST_TOKEN (the `bsk_…` key from the app's
// Admin → API Keys). INGEST_URL defaults to the app's production endpoint.

const DEFAULT_URL = 'https://web-production-34f4a.up.railway.app/api/ingest/agents';
const BATCH = Number(process.env.INGEST_BATCH_SIZE) || 1000; // app caps at 2000/request
const BATCH_DELAY_MS = Number(process.env.INGEST_BATCH_DELAY_MS) || 1000; // polite pause between batches

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function ingestEnabled() {
    return Boolean(process.env.INGEST_TOKEN);
}
function ingestUrl() {
    return process.env.INGEST_URL || DEFAULT_URL;
}

/**
 * Awaitable: send rows for one source to the app, batched + throttled. Returns
 * totals, throws on failure. No-op (returns zeros) when INGEST_TOKEN is unset.
 * Used by engines that flush incrementally during a long scrape.
 */
export async function ingestRows(source, rows) {
    if (!ingestEnabled() || !Array.isArray(rows) || !rows.length) {
        return { received: 0, inserted: 0, updated: 0 };
    }
    return postAll(source, rows);
}

/**
 * Fire-and-forget: send all rows for one source to the app once it finishes.
 * Never throws into the caller; logs the result. No-op when INGEST_TOKEN unset.
 * Used by the job layer for sources that don't self-ingest (Zillow / Realtor).
 */
export function persistSource(source, rows) {
    if (!ingestEnabled() || !Array.isArray(rows) || !rows.length) return;
    postAll(source, rows)
        .then((r) => console.log(`  [ingest] ${source}: received ${r.received}, inserted ${r.inserted}, updated ${r.updated}`))
        .catch((err) => console.error(`  [ingest] ${source} failed: ${err.message}`));
}

async function postAll(source, rows) {
    const totals = { received: 0, inserted: 0, updated: 0 };
    const batches = Math.ceil(rows.length / BATCH);
    for (let i = 0, b = 0; i < rows.length; i += BATCH, b += 1) {
        const batch = rows.slice(i, i + BATCH); // native column names — app remaps
        const res = await postBatch(source, batch);
        totals.received += res.received || batch.length;
        totals.inserted += res.inserted || 0;
        totals.updated += res.updated || 0;
        if (batches > 1) console.log(`  [ingest] ${source} batch ${b + 1}/${batches}: +${res.inserted || 0} / ~${res.updated || 0}`);
        // Throttle between batches so we don't hammer the DB app.
        if (i + BATCH < rows.length) await sleep(BATCH_DELAY_MS);
    }
    return totals;
}

async function postBatch(source, rows, retries = 5) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const res = await fetch(ingestUrl(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-ingest-token': process.env.INGEST_TOKEN,
                },
                body: JSON.stringify({ source, rows }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok) return body;
            // 4xx (bad token / bad request) won't fix on retry — fail fast.
            if (res.status >= 400 && res.status < 500) {
                throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 160)}`);
            }
            lastErr = new Error(`${res.status} ${JSON.stringify(body).slice(0, 160)}`);
        } catch (err) {
            if (/^4\d\d /.test(err.message)) throw err;
            lastErr = err;
        }
        await new Promise((r) => setTimeout(r, Math.min(20000, 2000 * (attempt + 1))));
    }
    throw lastErr;
}
