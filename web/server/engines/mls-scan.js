// engines/mls-scan.js — scan EVERY configured Courted account's MLS list so the
// UI can flag MLSs added to / removed from an account over time. The 8-account
// scan is minutes long (a login + several probes per account), so it runs as a
// background job the client polls — same shape as the enrich job. The client
// keeps the previous scan as a baseline and diffs against it.

import { login } from '../../../courted/src/auth.js';
import { detectAccountMls } from '../../../courted/src/mls.js';
import { readCourtedAccounts } from './courted.js';

const jobs = new Map();
let seq = 0;

/** Start a scan of all configured accounts. Returns the job (poll it by id). */
export function startMlsScan() {
    const id = `mlsscan_${Date.now()}_${(seq += 1)}`;
    const accounts = readCourtedAccounts();
    const job = {
        id,
        status: accounts.length ? 'running' : 'done',
        message: accounts.length ? 'Starting…' : 'No Courted accounts configured.',
        total: accounts.length,
        done: 0,
        accounts: [],   // [{ email, total, mls:[{code,name,count}] }] or { email, error }
        aborted: false,
        startedAt: Date.now(),
    };
    jobs.set(id, job);
    // Keep only the few most recent jobs in memory.
    if (jobs.size > 8) { const oldest = [...jobs.keys()][0]; jobs.delete(oldest); }
    if (accounts.length) run(job, accounts);
    return job;
}

export function getMlsScan(id) { return jobs.get(id); }
export function stopMlsScan(id) {
    const j = jobs.get(id);
    if (!j || j.status !== 'running') return false;
    j.aborted = true;
    return true;
}

async function run(job, accounts) {
    for (const acc of accounts) {
        if (job.aborted) break;
        job.message = `Scanning ${acc.email} (${job.done + 1}/${job.total})…`;
        try {
            const session = await login(acc.email, acc.password);
            const { total, mls } = await detectAccountMls(session, { thorough: true });
            job.accounts.push({ email: acc.email, total, mls });
        } catch (err) {
            job.accounts.push({ email: acc.email, error: err.message, total: 0, mls: [] });
        }
        job.done += 1;
    }
    job.status = job.aborted ? 'stopped' : 'done';
    job.message = job.aborted ? `Stopped after ${job.done}/${job.total}.` : `Scanned ${job.done} account(s).`;
}
