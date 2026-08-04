// refresh.js — the automatic "15-day refresh". On a rolling schedule, re-run the
// SAME whole-account Courted sweep that "Add account & start sweep" uses
// (runCourted with courtedAllAgents), ONE account at a time, cycling through every
// account so each is re-scraped at least once per REFRESH_WINDOW_DAYS. Re-scraping
// ACCUMULATES (adds/updates agents + MLS memberships, never deletes) — proven — so
// this only ever freshens data. Fully env-gated, never throws into the caller.
//
// Env:
//   REFRESH_ENABLED=1             turn the scheduler on (default off)
//   REFRESH_WINDOW_DAYS=15        re-scrape every account within this many days
//   SLACK_BOT_TOKEN / SLACK_CHANNEL_ID   failure alerts (shared with mls-monitor)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   progress store (refresh_state)

import { createJob } from './jobs.js';
import { runCourted, readCourtedAccounts } from './engines/courted.js';
import { notifySlack } from './mls-monitor.js';

const STATE_TABLE = 'refresh_state';

export function refreshEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.REFRESH_ENABLED || ''));
}
function dbEnabled() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
function windowDays() {
    const d = Number(process.env.REFRESH_WINDOW_DAYS);
    return Number.isFinite(d) && d > 0 ? d : 15;
}
function windowMs() { return windowDays() * 24 * 3600 * 1000; }

// --- progress store (Supabase PostgREST; one row per account) ----------------
async function sb(pathAndQuery, init = {}) {
    const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
        ...init,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
}

/** email(lowercased) -> { email, last_refreshed_at, last_status, last_message } */
export async function loadState() {
    if (!dbEnabled()) return {};
    const rows = await (await sb(`${STATE_TABLE}?select=email,last_refreshed_at,last_status,last_message`)).json();
    const out = {};
    for (const r of rows) out[String(r.email).toLowerCase()] = r;
    return out;
}

async function saveState(email, status, message) {
    if (!dbEnabled()) return;
    const now = new Date().toISOString();
    await sb(`${STATE_TABLE}?on_conflict=email`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{
            email: email.toLowerCase(),
            last_refreshed_at: now,
            last_status: status,
            last_message: (message || '').slice(0, 500),
            updated_at: now,
        }]),
    });
}

function logStoreErr(err) {
    if (/refresh_state.* does not exist|42P01/i.test(err.message)) {
        console.error('[refresh] state table missing — run the refresh_state block in web/server/schema.sql.');
    } else {
        console.error('[refresh] store:', err.message);
    }
}

// --- pick + run --------------------------------------------------------------
/** The account that has gone longest without a refresh (never-refreshed first). */
function pickDueAccount(state, accounts) {
    let due = null, dueAge = -1;
    const now = Date.now();
    for (const acc of accounts) {
        const row = state[acc.email.toLowerCase()];
        const last = row && row.last_refreshed_at ? Date.parse(row.last_refreshed_at) : 0;
        const age = now - last; // never-refreshed → huge age (now - 0)
        if (age > dueAge) { dueAge = age; due = acc; }
    }
    return due;
}

/** Re-scrape ONE account end-to-end; resolves when the sweep fully completes. */
async function refreshAccount(email) {
    const job = createJob({
        sources: ['courted'],
        courtedAllAgents: true,   // whole-account unfiltered sweep
        courtedBanded: true,      // band pagination (stays under Courted's deep-offset wall)
        courtedOnly: [email],     // just this account
    });
    job.pending = 1;
    await runCourted(job);        // awaits the entire sweep (all bands + final DB flush)
    const s = job.sources.courted || {};
    return { ok: s.status !== 'error', message: s.message || '', count: s.count || 0 };
}

function formatFailure(email, message) {
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return `*Courted 15-day refresh* — ⚠️ *${email}* failed to refresh (${when} UTC): ${message || 'unknown error'}`;
}

// --- scheduler ---------------------------------------------------------------
let running = false;   // one sweep at a time — never overlap
let lastKickAt = 0;    // throttle: at most one account per pace slot
let timer = null;

/** Run the due account (if it's time and nothing else is running). Alerts on failure. */
async function runDue(force) {
    if (running) return;
    const accounts = readCourtedAccounts();
    if (!accounts.length) return;
    const pace = windowMs() / accounts.length;       // spread N accounts across the window
    if (!force && Date.now() - lastKickAt < pace) return; // not the next account's turn yet

    let state = {};
    if (dbEnabled()) { try { state = await loadState(); } catch (e) { logStoreErr(e); } }
    const acc = pickDueAccount(state, accounts);
    if (!acc) return;

    running = true;
    lastKickAt = Date.now();
    const email = acc.email;
    try {
        console.log(`[refresh] refreshing ${email}…`);
        const r = await refreshAccount(email);
        try { await saveState(email, r.ok ? 'ok' : 'error', r.message); } catch (e) { logStoreErr(e); }
        if (r.ok) {
            console.log(`[refresh] ${email} done — ${r.message}`);
        } else {
            console.error(`[refresh] ${email} failed: ${r.message}`);
            try { await notifySlack(formatFailure(email, r.message)); } catch (e) { console.error('[refresh] slack:', e.message); }
        }
        return { ok: r.ok, email, message: r.message, agents: r.count };
    } catch (err) {
        // An unexpected thrown sweep — record + alert, then move on.
        try { await saveState(email, 'error', err.message); } catch (e) { logStoreErr(e); }
        try { await notifySlack(formatFailure(email, err.message)); } catch (e) { console.error('[refresh] slack:', e.message); }
        return { ok: false, email, message: err.message };
    } finally {
        running = false;
    }
}

/** Kick a refresh ONCE, on demand (manual test / admin). Most-overdue by default. */
export async function runRefreshOnce({ email } = {}) {
    const accounts = readCourtedAccounts();
    if (!accounts.length) return { ok: false, message: 'No Courted accounts configured.' };
    if (running) return { ok: false, message: 'A refresh is already running — try again once it finishes.' };
    if (email) {
        const target = accounts.find((a) => a.email.toLowerCase() === String(email).toLowerCase());
        if (!target) return { ok: false, message: `No such account: ${email}` };
        running = true;
        lastKickAt = Date.now();
        try {
            const r = await refreshAccount(target.email);
            try { await saveState(target.email, r.ok ? 'ok' : 'error', r.message); } catch (e) { logStoreErr(e); }
            if (!r.ok) { try { await notifySlack(formatFailure(target.email, r.message)); } catch { /* logged upstream */ } }
            return { ok: r.ok, email: target.email, message: r.message, agents: r.count };
        } finally {
            running = false;
        }
    }
    return (await runDue(true)) || { ok: false, message: 'Nothing due.' };
}

export function startRefresh() {
    if (!refreshEnabled()) return { started: false, reason: 'REFRESH_ENABLED not set' };
    if (timer) return { started: true, already: true };
    const accounts = readCourtedAccounts().length;
    if (!accounts) return { started: false, reason: 'no Courted accounts' };
    const pace = windowMs() / accounts;
    // Tick hourly (but never longer than a single account's slot); the pace
    // throttle inside runDue() is what actually spreads accounts over the window.
    const tickMs = Math.min(60 * 60 * 1000, Math.max(5 * 60 * 1000, pace));
    const kick = () => runDue(false).catch((e) => console.error('[refresh] tick:', e.message));
    setTimeout(kick, 90 * 1000);            // first check ~1.5 min after boot
    timer = setInterval(kick, tickMs);
    console.log(`  15-day refresh: ON — ${accounts} accounts across ${windowDays()}d (one ~every ${(pace / 86400000).toFixed(1)}d)`);
    return { started: true, windowDays: windowDays(), accounts };
}
