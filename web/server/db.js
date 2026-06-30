// db.js — optional Supabase persistence with upsert (no duplicates).
//
// Every scraped record is written to Supabase. The agent's stable id is the
// table's primary key, so re-scraping the same market UPDATES the existing row
// instead of inserting a duplicate. Uses Supabase's PostgREST endpoint directly
// (no extra dependency) with `Prefer: resolution=merge-duplicates`.
//
// Entirely env-gated: if SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY aren't set,
// every function is a no-op, so the app runs exactly as before.

import { OUTPUT_COLUMNS as COURTED_COLS } from '../../courted/src/constants.js';
import { OUTPUT_COLUMNS as ZILLOW_COLS } from '../../src/constants.js';
import { OUTPUT_COLUMNS as REALTOR_COLS } from './engines/realtor-map.js';

// Per-source table name, the column that uniquely identifies an agent, and the
// full column list (used to build the schema + map rows to snake_case).
export const TABLES = {
    courted: { table: 'courted_agents', key: 'Courted ID', columns: COURTED_COLS },
    zillow: { table: 'zillow_agents', key: 'Zillow Profile URL', columns: ZILLOW_COLS },
    realtor: { table: 'realtor_agents', key: 'Realtor Profile URL', columns: REALTOR_COLS },
};

const CHUNK = 500;

export function dbEnabled() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Column name -> snake_case identifier (must match the generated SQL schema).
export function slug(name) {
    return String(name)
        .toLowerCase()
        .replace(/%/g, ' pct ')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Upsert all rows for one source into its table. De-dupes on the source's key
 * column, so existing agents are updated, not duplicated. Returns a small stat.
 * No-op (returns null) when Supabase isn't configured or there's nothing to write.
 */
export async function upsertSource(source, rows) {
    if (!dbEnabled()) return null;
    const cfg = TABLES[source];
    if (!cfg || !Array.isArray(rows) || !rows.length) return null;

    const keyCol = slug(cfg.key);
    const stamp = new Date().toISOString();

    // Map each row to snake_case columns; drop rows missing the unique key.
    const payload = [];
    for (const row of rows) {
        const id = row[cfg.key];
        if (id == null || String(id).trim() === '') continue;
        const out = { updated_at: stamp };
        for (const col of cfg.columns) {
            const v = row[col];
            out[slug(col)] = (v == null || v === '') ? null : String(v);
        }
        payload.push(out);
    }
    if (!payload.length) return { source, written: 0, skipped: rows.length };

    let written = 0;
    for (let i = 0; i < payload.length; i += CHUNK) {
        const batch = payload.slice(i, i + CHUNK);
        await postBatch(cfg.table, keyCol, batch);
        written += batch.length;
    }
    return { source, written, skipped: rows.length - payload.length };
}

async function postBatch(table, keyCol, batch) {
    const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const url = `${base}/rest/v1/${table}?on_conflict=${encodeURIComponent(keyCol)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(batch),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Supabase upsert ${table} ${res.status}: ${body.slice(0, 200)}`);
    }
}

/** Fire-and-forget persist used by the job layer; never throws into callers. */
export function persistSource(source, rows) {
    if (!dbEnabled()) return;
    upsertSource(source, rows)
        .then((r) => { if (r) console.log(`  [db] ${r.source}: upserted ${r.written}${r.skipped ? ` (skipped ${r.skipped} w/o key)` : ''}`); })
        .catch((err) => console.error(`  [db] ${source} persist failed: ${err.message}`));
}

/** Build the CREATE TABLE SQL for all sources (used by scripts/gen-schema). */
export function buildSchemaSql() {
    const blocks = [];
    for (const [source, cfg] of Object.entries(TABLES)) {
        const keyCol = slug(cfg.key);
        const lines = cfg.columns.map((c) => {
            const col = slug(c);
            return col === keyCol ? `    ${col} text primary key` : `    ${col} text`;
        });
        // Ensure the key column is present even if it sorts oddly.
        lines.push('    created_at timestamptz not null default now()');
        lines.push('    updated_at timestamptz not null default now()');
        blocks.push(`-- ${source}\ncreate table if not exists ${cfg.table} (\n${lines.join(',\n')}\n);`);
    }
    return blocks.join('\n\n') + '\n';
}
