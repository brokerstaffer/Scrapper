// index.js — Express server for the Zillow + Courted agent search webapp.
// Local-first: run `node web/server/index.js` and open http://localhost:3000.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

import { createJob, getJob, emit, subscribe, unsubscribe } from './jobs.js';
import { runCourted } from './engines/courted.js';
import { runZillow } from './engines/zillow.js';
import { OUTPUT_COLUMNS as COURTED_COLS } from '../../courted/src/constants.js';
import { OUTPUT_COLUMNS as ZILLOW_COLS } from '../../src/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// --- tiny .env loader (web/.env) ---
loadEnv(path.join(ROOT, 'web/.env'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'web/public')));

const COLS = { courted: COURTED_COLS, zillow: ZILLOW_COLS };

// Full column lists per source (so the UI can show every field).
app.get('/api/columns', (_req, res) => res.json(COLS));

// Start a search. Body: { locations:[], sources:[], options... }
app.post('/api/search', (req, res) => {
    const b = req.body || {};
    const locations = (Array.isArray(b.locations) ? b.locations : [])
        .map((s) => String(s).trim()).filter(Boolean);
    const sources = (Array.isArray(b.sources) ? b.sources : ['zillow', 'courted'])
        .filter((s) => s === 'zillow' || s === 'courted');

    if (!locations.length) return res.status(400).json({ error: 'Provide at least one location or ZIP.' });
    if (!sources.length) return res.status(400).json({ error: 'Select at least one source.' });

    const params = {
        locations,
        sources,
        // Courted options (0 = all matches)
        courtedMax: toInt(b.courtedMax, 0),
        courtedEnrich: Boolean(b.courtedEnrich),
        minSalesVolume: toInt(b.minSalesVolume, 0),
        // Zillow options (default: all pages up to Zillow's 25-page cap)
        zillowMaxPages: toInt(b.zillowMaxPages, 25),
        zillowEnrich: Boolean(b.zillowEnrich),
        zillowMaxProfiles: toInt(b.zillowMaxProfiles, 0),
        zillowConcurrency: toInt(b.zillowConcurrency, 4),
    };

    const job = createJob(params);
    job.pending = sources.length;

    // Kick off engines (fire-and-forget; they stream into the job).
    if (sources.includes('courted')) runCourted(job);
    if (sources.includes('zillow')) runZillow(job);

    res.json({ jobId: job.id, params });
});

// SSE stream of a job's events.
app.get('/api/search/:id/stream', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).end();
    subscribe(job, res);
    req.on('close', () => unsubscribe(job, res));
});

// CSV export of one source's rows.
app.get('/api/search/:id/export', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).send('job not found');
    const source = req.query.source === 'zillow' ? 'zillow' : 'courted';
    const rows = job.rows[source] || [];
    const cols = COLS[source];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${source}-agents.csv"`);
    res.send(toCsv(rows, cols));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n  Agent Search webapp → http://localhost:${PORT}\n`);
    console.log(`  Courted creds: ${process.env.COURTED_EMAIL ? 'set ✓' : 'NOT SET ✗ (web/.env)'}`);
    console.log(`  Zillow proxy:  ${process.env.ZILLOW_PROXY_URL ? 'set ✓' : 'not set (Zillow may be blocked)'}\n`);
});

// --- helpers ---
function toInt(v, d) { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; }

function toCsv(rows, cols) {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = cols.map(esc).join(',');
    const lines = rows.map((r) => cols.map((c) => esc(r[c])).join(','));
    return [header, ...lines].join('\n');
}

function loadEnv(file) {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
}
