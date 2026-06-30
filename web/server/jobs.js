// jobs.js — in-memory job registry + a tiny pub/sub hub for streaming results.
//
// A "job" is one search across one or more sources (Zillow / Courted). Engines
// push events into the job; the HTTP layer relays them to the browser over SSE.
// Events are buffered so a client that connects a moment after the job starts
// still receives everything from the beginning.

import { randomUUID } from 'node:crypto';
import { persistSource } from './ingest.js';

const jobs = new Map();

export function createJob(params) {
    const id = randomUUID();
    const job = {
        id,
        params,
        createdAt: Date.now(),
        status: 'running',         // running | done | error
        aborted: false,            // set by /stop — engines wind down
        events: [],                // full event log (for late subscribers + replay)
        subscribers: new Set(),    // Set<res> (SSE responses)
        rows: { zillow: [], courted: [], realtor: [] },
        sources: {                 // per-source progress
            zillow: { status: 'pending', count: 0, total: null, message: '' },
            courted: { status: 'pending', count: 0, total: null, message: '' },
            realtor: { status: 'pending', count: 0, total: null, message: '' },
        },
        pending: 0,                // engines still running
    };
    jobs.set(id, job);
    // Evict old jobs (keep last ~50) to bound memory.
    if (jobs.size > 50) {
        const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) jobs.delete(oldest.id);
    }
    return job;
}

export function getJob(id) {
    return jobs.get(id);
}

/** Signal a running job to stop; engines check job.aborted and wind down. */
export function abortJob(job) {
    if (job && job.status === 'running') {
        job.aborted = true;
        emit(job, 'progress', { source: '_', status: 'running', message: 'Stopping…' });
    }
}

/** Emit an event to a job: buffered + fanned out to all live subscribers. */
export function emit(job, type, data) {
    // Full-sweep (Courted "all agents") streams 100k+ rows straight to the DB —
    // don't hoard them (or their per-record events) in memory.
    const dbOnly = !!(job.params && job.params.courtedAllAgents) && data && data.source === 'courted';

    if (!(type === 'record' && dbOnly)) {
        job.events.push({ type, data, t: Date.now() });
    }

    // Update server-side rollups so exports + late joins are consistent.
    if (type === 'record') {
        const src = data.source;
        const s = job.sources[src];
        if (job.rows[src] && !dbOnly) job.rows[src].push(data.row);
        if (s) s.count = (s.count || 0) + 1; // count is independent of whether we store the row
    } else if (type === 'progress') {
        const s = job.sources[data.source];
        if (s) Object.assign(s, data);
    } else if (type === 'meta') {
        const s = job.sources[data.source];
        if (s && data.total != null) s.total = data.total;
    } else if (type === 'source_done') {
        const s = job.sources[data.source];
        if (s) { s.status = 'done'; s.message = data.message || ''; }
        // Forward to the DB app — unless the engine already streamed it itself.
        if (!s || !s.selfIngested) persistSource(data.source, job.rows[data.source]);
    } else if (type === 'source_error') {
        const s = job.sources[data.source];
        if (s) { s.status = 'error'; s.message = data.message || ''; }
        if (!s || !s.selfIngested) persistSource(data.source, job.rows[data.source]); // save what we got
    }

    if (!job.subscribers.size) return; // poll-based UI; skip building SSE payloads
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of job.subscribers) {
        try { res.write(payload); } catch { /* dropped client */ }
    }
}

/** Attach an SSE response to a job: replay history, then stream live. */
export function subscribe(job, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ jobId: job.id })}\n\n`);
    // Replay everything so far.
    for (const e of job.events) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    }
    // Only synthesize a completion if the job finished but never buffered one.
    if (job.status !== 'running' && !job.events.some((e) => e.type === 'complete')) {
        res.write(`event: complete\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
    }
    job.subscribers.add(res);
    // Heartbeat: keep the connection alive during long silent fetches (a realtor
    // page can take ~40s); otherwise idle SSE connections drop and live records
    // emitted in that window are lost.
    res.__hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
}

export function unsubscribe(job, res) {
    job.subscribers.delete(res);
    if (res.__hb) { clearInterval(res.__hb); res.__hb = null; }
}

/** Mark one engine finished; when all are done, fire the job-level complete. */
export function engineFinished(job) {
    job.pending -= 1;
    if (job.pending <= 0) {
        job.status = job.status === 'error' ? 'error' : 'done';
        emit(job, 'complete', { status: job.status });
    }
}
