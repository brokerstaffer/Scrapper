// index.js — Express server for the Zillow + Courted agent search webapp.
// Local-first: run `node web/server/index.js` and open http://localhost:3000.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

import { createJob, getJob, emit, subscribe, unsubscribe, abortJob } from './jobs.js';
import { runCourted, readCourtedAccounts } from './engines/courted.js';
import { runZillow } from './engines/zillow.js';
import { runRealtor } from './engines/realtor.js';
import { activeProvider as unblockerProvider } from './unblocker.js';
import { OUTPUT_COLUMNS as COURTED_COLS } from '../../courted/src/constants.js';
import { OUTPUT_COLUMNS as ZILLOW_COLS } from '../../src/constants.js';
import { OUTPUT_COLUMNS as REALTOR_COLS } from './engines/realtor-map.js';
import { buildMaster } from './merge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// --- tiny .env loader (web/.env) ---
loadEnv(path.join(ROOT, 'web/.env'));

const app = express();
app.use(express.json());
// Never cache the UI assets — always serve the latest app.js / index.html.
app.use(express.static(path.join(ROOT, 'web/public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const COLS = { courted: COURTED_COLS, zillow: ZILLOW_COLS, realtor: REALTOR_COLS };

// Full column lists per source (so the UI can show every field).
app.get('/api/columns', (_req, res) => res.json(COLS));

// What's configured (for the header status badge).
app.get('/api/status', (_req, res) => {
    const accounts = readCourtedAccounts().length;
    res.json({
        courted: accounts > 0,
        courtedAccounts: accounts,
        unblocker: unblockerProvider() || null,
    });
});

// Start a search. Body: { locations:[], sources:[], options... }
app.post('/api/search', (req, res) => {
    const b = req.body || {};
    const locations = (Array.isArray(b.locations) ? b.locations : [])
        .map((s) => String(s).trim()).filter(Boolean);
    const sources = (Array.isArray(b.sources) ? b.sources : ['zillow', 'courted'])
        .filter((s) => s === 'zillow' || s === 'courted' || s === 'realtor');

    const courtedAllAgents = Boolean(b.courtedAllAgents);
    // Courted "all agents" is an unfiltered MLS sweep, so it needs no location.
    if (!locations.length && !courtedAllAgents) return res.status(400).json({ error: 'Provide at least one location or ZIP.' });
    if (!sources.length) return res.status(400).json({ error: 'Select at least one source.' });

    const params = {
        locations,
        sources,
        // Courted options (0 = all matches)
        courtedMax: toInt(b.courtedMax, 0),
        courtedEnrich: Boolean(b.courtedEnrich),
        courtedAllAgents,
        courtedReverse: Boolean(b.courtedReverse),
        minSalesVolume: toInt(b.minSalesVolume, 0),
        // Zillow options (default: all pages up to Zillow's 25-page cap)
        zillowMaxPages: toInt(b.zillowMaxPages, 25),
        zillowEnrich: Boolean(b.zillowEnrich),
        zillowMaxProfiles: toInt(b.zillowMaxProfiles, 0),
        zillowConcurrency: toInt(b.zillowConcurrency, 4),
        // Realtor options
        realtorMax: toInt(b.realtorMax, 100),
        realtorEnrich: Boolean(b.realtorEnrich),
        realtorMaxProfiles: toInt(b.realtorMaxProfiles, 0),
        realtorConcurrency: toInt(b.realtorConcurrency, 3),
    };

    const job = createJob(params);
    job.pending = sources.length;

    // Kick off engines (fire-and-forget; they stream into the job).
    if (sources.includes('courted')) runCourted(job);
    if (sources.includes('zillow')) runZillow(job);
    if (sources.includes('realtor')) runRealtor(job);

    res.json({ jobId: job.id, params });
});

// Stop a running search.
app.post('/api/search/:id/stop', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    abortJob(job);
    res.json({ ok: true });
});

// Incremental results polling (robust alternative to SSE). Client passes the
// number of rows it has already rendered per source; we return the rest.
app.get('/api/search/:id/results', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const out = { status: job.status, sources: {} };
    for (const s of ['courted', 'zillow', 'realtor']) {
        const off = Math.max(0, parseInt(req.query[s], 10) || 0);
        const src = job.sources[s];
        out.sources[s] = {
            status: src.status,
            message: src.message,
            total: src.total,
            count: src.count || job.rows[s].length,
            newRows: job.rows[s].slice(off),
        };
    }
    res.json(out);
});

// SSE stream of a job's events (kept for compatibility).
app.get('/api/search/:id/stream', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).end();
    subscribe(job, res);
    req.on('close', () => unsubscribe(job, res));
});

// De-duplicated master list across all sources (JSON, for the UI table).
app.get('/api/search/:id/master', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const { columns, rows, stats } = buildMaster(job.rows, COLS);
    res.json({ columns, rows, stats });
});

// CSV export of one source's rows — or the merged master list (source=master).
app.get('/api/search/:id/export', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).send('job not found');
    if (req.query.source === 'master') {
        const { columns, rows } = buildMaster(job.rows, COLS);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="master-agents-deduped.csv"');
        return res.send(toCsv(rows, columns));
    }
    const source = ['zillow', 'realtor', 'courted'].includes(req.query.source) ? req.query.source : 'courted';
    const rows = job.rows[source] || [];
    const cols = COLS[source];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${source}-agents.csv"`);
    res.send(toCsv(rows, cols));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n  Agent Search webapp → http://localhost:${PORT}\n`);
    console.log(`  Courted creds: ${readCourtedAccounts().length || 'NO'} account(s)`);
    console.log(`  Unblocker:     ${unblockerProvider() || 'NONE — Zillow + realtor.com disabled'}  (Zillow + realtor.com)\n`);
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
    // Lead with a UTF-8 BOM so Excel renders accents / —  / ® correctly.
    return '﻿' + [header, ...lines].join('\n');
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
