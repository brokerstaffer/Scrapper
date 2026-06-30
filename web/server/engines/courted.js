// engines/courted.js — bridge the Courted scraper into a streaming job.
// Pure HTTP, fast: results land in seconds.
//
// Supports MULTIPLE Courted accounts. Each account can belong to a different
// brokerage/MLS, so it may see different agents. We run the search on every
// account and merge the results, de-duplicating the same agent across accounts
// (by Courted ID, else email / license / name+office).

import { runScrape } from '../../../courted/src/scraper.js';
import { emit, engineFinished } from '../jobs.js';
import { ingestRows, ingestEnabled } from '../ingest.js';

// Flush to the DB app every N records during a long sweep (bounds memory + means
// a mid-run failure doesn't lose everything already scraped).
const FLUSH_SIZE = Number(process.env.COURTED_FLUSH_SIZE) || 1000;

/**
 * Read every configured Courted account from the environment:
 *   COURTED_EMAIL    / COURTED_PASSWORD      (account 1)
 *   COURTED_EMAIL_2  / COURTED_PASSWORD_2    (account 2)
 *   …up to _20. De-duplicated by email.
 */
export function readCourtedAccounts() {
    const out = [];
    const seen = new Set();
    const add = (email, password) => {
        if (!email || !password) return;
        const key = email.trim().toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ email: email.trim(), password });
    };
    add(process.env.COURTED_EMAIL, process.env.COURTED_PASSWORD);
    for (let i = 2; i <= 20; i += 1) {
        add(process.env[`COURTED_EMAIL_${i}`], process.env[`COURTED_PASSWORD_${i}`]);
    }
    return out;
}

// A stable identity for an agent so the same person from two accounts collapses
// into one row.
function personKey(row) {
    const v = (k) => String(row[k] == null ? '' : row[k]).trim().toLowerCase();
    return v('Courted Agent ID') || v('Courted ID')
        || v('Email') || v('State License')
        || (v('Name') ? `${v('Name')}|${v('Office')}` : '');
}

export async function runCourted(job) {
    const { locations, courtedMax, courtedEnrich, minSalesVolume, courtedAllAgents } = job.params;
    const source = 'courted';
    // Full unfiltered sweep: pull every agent the account's MLS can see.
    const searchLocations = courtedAllAgents ? [] : locations;

    const accounts = readCourtedAccounts();
    if (!accounts.length) {
        emit(job, 'source_error', { source, message: 'Courted credentials not set (COURTED_EMAIL / COURTED_PASSWORD in web/.env).' });
        engineFinished(job);
        return;
    }

    const log = {
        info: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        warning: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        debug: () => {},
    };

    const seen = new Set();   // cross-account de-dupe
    let pushed = 0;           // unique agents emitted
    let total = 0;            // sum of matched counts (rough, may double-count overlaps)
    const cap = courtedMax || 0;
    const reachedCap = () => cap > 0 && pushed >= cap;
    const errors = [];

    // Incremental DB-app flush. Buffer records and ship them every FLUSH_SIZE so
    // huge sweeps don't sit in memory and a mid-run crash keeps what was sent.
    const sendToDb = ingestEnabled();
    let buffer = [];
    let sent = 0;
    const flush = async () => {
        if (!sendToDb || !buffer.length) return;
        const batch = buffer; buffer = [];
        try {
            const r = await ingestRows(source, batch);
            sent += r.received;
            emit(job, 'progress', { source, status: 'running', message: `Saved ${sent.toLocaleString()} to database…` });
        } catch (err) {
            log.warning(`DB save failed (${batch.length} rows): ${err.message}`);
        }
    };

    try {
        for (let i = 0; i < accounts.length; i += 1) {
            if (job.aborted || reachedCap()) break;
            const acc = accounts[i];
            const tag = accounts.length > 1 ? `account ${i + 1}/${accounts.length} (${acc.email})` : '';
            emit(job, 'progress', { source, status: 'running', message: accounts.length > 1 ? `Signing in — ${tag}…` : 'Signing in…' });

            try {
                await runScrape(
                    {
                        email: acc.email,
                        password: acc.password,
                        locations: searchLocations,
                        maxRecords: 0,            // cap is enforced across accounts below
                        maxRecordsPerLocation: 0,
                        minSalesVolume: minSalesVolume || 0,
                        enrichProfiles: Boolean(courtedEnrich),
                        // Pace between page/profile requests — raise COURTED_DELAY_MS
                        // for big full-account runs to stay well under any rate limit.
                        delayMs: Number(process.env.COURTED_DELAY_MS) || 350,
                    },
                    {
                        log,
                        shouldStop: () => job.aborted || reachedCap(),
                        onRecord: async (row) => {
                            if (reachedCap()) return;
                            const key = personKey(row);
                            if (key && seen.has(key)) return; // already seen on another account
                            if (key) seen.add(key);
                            emit(job, 'record', { source, row });
                            pushed += 1;
                            if (sendToDb) {
                                buffer.push(row);
                                if (buffer.length >= FLUSH_SIZE) await flush(); // backpressure
                            }
                        },
                        onMeta: ({ total: t }) => {
                            total += t || 0;
                            emit(job, 'meta', { source, total });
                        },
                    },
                );
            } catch (err) {
                // One bad account shouldn't kill the whole source — log and move on.
                errors.push(`${acc.email}: ${err.message}`);
                log.warning(`Courted ${tag || acc.email} failed: ${err.message}`);
            }
            await flush(); // ship this account's remainder before the next account
        }
        await flush(); // final remainder
        // We streamed to the DB ourselves — tell the job layer not to bulk-send again.
        if (sendToDb) job.sources[source].selfIngested = true;

        const accLabel = accounts.length > 1 ? ` from ${accounts.length} accounts` : '';
        const dbLabel = sendToDb ? ` · ${sent.toLocaleString()} saved to DB` : '';
        const capped = cap > 0 && pushed >= cap;
        let message = capped
            ? `${pushed} of ${total.toLocaleString()} (capped at ${cap})${accLabel}${dbLabel}`
            : `${pushed} unique agents${accLabel}${dbLabel}`;
        if (errors.length && pushed === 0) {
            return emit(job, 'source_error', { source, message: `All Courted accounts failed — ${errors[0]}` });
        }
        if (errors.length) message += ` · ${errors.length} account(s) failed`;
        emit(job, 'source_done', { source, message });
    } catch (err) {
        emit(job, 'source_error', { source, message: err.message });
    } finally {
        engineFinished(job);
    }
}
