// backfill-titles.mjs — one-time (re-runnable) title backfill for swept Courted
// agents. The 771k full sweep ran enrichment-OFF, so Courted's computed role
// (team leader / managing broker) was never captured and every DB row defaulted
// to title='Salesperson'. Courted's agent_search API filters by role via the
// `at_type_includes` param (found in the broker-ui bundle), so instead of a 20h
// per-agent enrichment we page the two filtered lists per account and stamp the
// title on the matching DB rows.
//
// Title values (app filters by "contains"):
//   team-leader only        -> "Team Leader"
//   managing-broker only    -> "Managing Broker"
//   both                    -> "Managing Broker, Team Leader"
//   team members / everyone -> left as "Salesperson"
// Join: DB agents.source_ids->courted->>agent_id == Courted courted_mls_id.
// Writes ONLY the title column, ONLY on team-leader / managing-broker rows.
//
//   node --env-file=web/.env courted/backfill-titles.mjs             # DRY RUN
//   node --env-file=web/.env courted/backfill-titles.mjs --write     # live
//   ...--accounts=7           only account #7 (matches COURTED_EMAIL_7)
//   ...--accounts=1,7,8       a subset       (default: all configured)

import { login } from './src/auth.js';
import { buildSearchQuery, fetchSearchPage } from './src/api.js';
import { DEFAULT_STATUSES, sleep } from './src/constants.js';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const accArg = (args.find((a) => a.startsWith('--accounts=')) || '').split('=')[1] || 'all';
const DELAY = Number(process.env.COURTED_DELAY_MS) || 500;  // polite pause between pages
const PAGE = Number(process.env.BACKFILL_PAGE) || 500;      // API honors up to 500/page
// Lean query: we only need courted_mls_id, so strip the heavy contact/annotate
// work. Fewer + lighter requests = smaller footprint (less likely to get flagged).
const LEAN = {
    include_broker_company_prospect_data: 'false',
    annotate_mutual_connection_info: 'false',
    annotate_watchlists_in: 'false',
    annotate_last_re_activity_date: 'false',
};
const jitter = () => DELAY + Math.floor(Math.random() * 300);
const DB_CHUNK = 150;

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enc = encodeURIComponent;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function readAccounts() {
    const out = [];
    const add = (email, password, n) => { if (email && password) out.push({ n, email: email.trim(), password }); };
    add(process.env.COURTED_EMAIL, process.env.COURTED_PASSWORD, 1);
    for (let i = 2; i <= 20; i += 1) add(process.env[`COURTED_EMAIL_${i}`], process.env[`COURTED_PASSWORD_${i}`], i);
    if (accArg === 'all') return out;
    const want = new Set(accArg.split(',').map((s) => Number(s.trim())));
    return out.filter((a) => want.has(a.n));
}

// Page one filtered list (at_type_includes=<value>), STRICTLY SERIAL with a
// polite jittered delay between pages — slow on purpose so we never look like a
// burst/scraper and never get the account rate-limited or flagged.
async function collectIds(session, value, label) {
    const ids = new Set();
    let offset = 0;
    let total = null;
    for (;;) {
        const q = buildSearchQuery({
            limit: PAGE, offset, statuses: DEFAULT_STATUSES, includeContactInfo: false,
            extraParams: { ...LEAN, at_type_includes: value },
        });
        let d;
        try { d = await fetchSearchPage(session, q); }
        catch (e) { console.error(`\n  ! ${label} page@${offset}: ${e.message} (retrying once after pause)`); await sleep(4000); try { d = await fetchSearchPage(session, q); } catch (e2) { console.error(`  !! giving up on page@${offset}: ${e2.message}`); break; } }
        if (total === null) total = Number.isFinite(d.count) ? d.count : 0;
        const rows = d.results || [];
        rows.forEach((r) => r.courted_mls_id && ids.add(r.courted_mls_id));
        process.stderr.write(`\r  ${label}: ${ids.size}/${total}   `);
        offset += PAGE;
        if (rows.length < PAGE || offset >= total) break;
        await sleep(jitter());
    }
    process.stderr.write('\n');
    return ids;
}

// Count DB rows currently matching these agent_ids.
async function dbCount(ids) {
    let n = 0;
    for (const grp of chunk(ids, DB_CHUNK)) {
        const res = await fetch(`${SB_URL}/rest/v1/agents?source_ids->courted->>agent_id=in.(${grp.map(enc).join(',')})&select=id`, {
            headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' },
        });
        n += Number((res.headers.get('content-range') || '*/0').split('/')[1] || 0);
    }
    return n;
}

// PATCH title on rows matching these agent_ids. Returns rows affected.
async function dbSetTitle(ids, title) {
    let affected = 0;
    for (const grp of chunk(ids, DB_CHUNK)) {
        const res = await fetch(`${SB_URL}/rest/v1/agents?source_ids->courted->>agent_id=in.(${grp.map(enc).join(',')})`, {
            method: 'PATCH',
            headers: {
                apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
                'Content-Type': 'application/json', Prefer: 'return=representation,count=exact', Range: '0-0',
            },
            body: JSON.stringify({ title }),
        });
        if (!res.ok) { console.error(`\n  ! PATCH ${res.status}: ${(await res.text()).slice(0, 160)}`); continue; }
        affected += Number((res.headers.get('content-range') || '*/0').split('/')[1] || 0);
        process.stderr.write(`\r  writing "${title}": ${affected}   `);
    }
    process.stderr.write('\n');
    return affected;
}

// Sample a few ids and show current DB title (dry-run proof).
async function sample(ids, newTitle, k = 6) {
    const pick = ids.slice(0, k);
    if (!pick.length) return;
    const res = await fetch(`${SB_URL}/rest/v1/agents?source_ids->courted->>agent_id=in.(${pick.map(enc).join(',')})&select=full_name,title,office_name,source_ids`, {
        headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    for (const r of (await res.json())) {
        const aid = (r.source_ids?.courted || {}).agent_id;
        console.error(`    ${String(r.full_name || '?').padEnd(24)} ${String(r.office_name || '').slice(0, 24).padEnd(24)}  ${String(r.title).padEnd(12)} ->  ${newTitle}`);
    }
}

(async () => {
    if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
    const accounts = readAccounts();
    if (!accounts.length) { console.error('No Courted accounts matched.'); process.exit(1); }
    console.error(`MODE: ${WRITE ? 'LIVE WRITE' : 'DRY RUN (no writes)'} · accounts: ${accounts.map((a) => a.n).join(',')} · page ${PAGE}, serial\n`);

    const tlAll = new Set(), mbAll = new Set();
    for (const acc of accounts) {
        console.error(`=== account ${acc.n}: ${acc.email} ===`);
        let session;
        try { session = await login(acc.email, acc.password); }
        catch (e) { console.error(`  ! login failed: ${e.message}`); continue; }
        (await collectIds(session, 'at_team_leader', 'team leaders')).forEach((x) => tlAll.add(x));
        await sleep(1500);
        (await collectIds(session, 'at_manager_managing_broker', 'managing brokers')).forEach((x) => mbAll.add(x));
        await sleep(2500);  // breathe between accounts
    }

    // Combined, contains-searchable title per id. Order: Managing Broker, Team
    // Leader (e.g. "Managing Broker, Team Leader"). ONLY these two roles get a
    // title. Team members and everyone else keep their existing "Salesperson"
    // and are NEVER touched.
    const groups = new Map(); // label -> [ids]
    for (const id of new Set([...tlAll, ...mbAll])) {
        const parts = [];
        if (mbAll.has(id)) parts.push('Managing Broker');
        if (tlAll.has(id)) parts.push('Team Leader');
        const label = parts.join(', ');
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(id);
    }
    const labels = [...groups.keys()].sort();
    console.error(`\nGlobal (deduped) role combinations:`);
    for (const label of labels) console.error(`  ${label.padEnd(44)} ids=${groups.get(label).length}`);

    console.error('\nDB rows that will change (matched to an agents row):');
    let total = 0;
    for (const label of labels) {
        const c = await dbCount(groups.get(label));
        total += c;
        console.error(`  ${label.padEnd(44)} ${c}`);
    }
    console.error(`  ${'TOTAL'.padEnd(44)} ${total}`);

    for (const label of labels) {
        console.error(`\nSAMPLE — ${label} (before -> after):`);
        await sample(groups.get(label), label);
    }

    if (!WRITE) { console.error('\nDRY RUN complete — nothing written. Re-run with --write to apply.'); return; }

    console.error('\nWriting titles…');
    let written = 0;
    for (const label of labels) written += await dbSetTitle(groups.get(label), label);
    console.error(`\nDONE. wrote ${written} rows across ${labels.length} role combination(s).`);
})();
