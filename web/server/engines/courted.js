// engines/courted.js — bridge the Courted scraper into a streaming job.
// Pure HTTP, fast: results land in seconds.
//
// Supports MULTIPLE Courted accounts. Each account can belong to a different
// brokerage/MLS, so it may see different agents. We run the search on every
// account and merge the results, de-duplicating the same agent across accounts
// (by Courted ID, else email / license / name+office).

import { runScrape } from '../../../courted/src/scraper.js';
import { emit, engineFinished } from '../jobs.js';

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
    const { locations, courtedMax, courtedEnrich, minSalesVolume } = job.params;
    const source = 'courted';

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
                        locations,
                        maxRecords: 0,            // cap is enforced across accounts below
                        maxRecordsPerLocation: 0,
                        minSalesVolume: minSalesVolume || 0,
                        enrichProfiles: Boolean(courtedEnrich),
                    },
                    {
                        log,
                        shouldStop: () => job.aborted || reachedCap(),
                        onRecord: (row) => {
                            if (reachedCap()) return;
                            const key = personKey(row);
                            if (key && seen.has(key)) return; // already seen on another account
                            if (key) seen.add(key);
                            emit(job, 'record', { source, row });
                            pushed += 1;
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
        }

        const accLabel = accounts.length > 1 ? ` from ${accounts.length} accounts` : '';
        const capped = cap > 0 && pushed >= cap;
        let message = capped
            ? `${pushed} of ${total.toLocaleString()} (capped at ${cap})${accLabel}`
            : `${pushed} unique agents${accLabel}`;
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
