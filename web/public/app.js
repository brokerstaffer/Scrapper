// app.js — frontend: kick off a search, stream results into live tables.

const SOURCES = ['courted', 'zillow', 'realtor'];

// Compact "key columns" view (toggle). The FULL column set is loaded from the
// server and is the default.
const KEY_COLS = {
    courted: [
        'Name', 'Office', 'Email', 'Phone', 'Years Of Experience',
        'LTM Sales Volume', 'Sales Volume Change %', 'LTM Closed Units',
        'Active Listings', 'Most Transacted City', 'MLS', 'State License',
    ],
    zillow: [
        'Name', 'Brokerage', 'Phone', 'Email', 'Rating', 'Review Count',
        'Total Sales Count', 'Average Price', 'For Sale Count', 'Location',
        'Zillow Profile URL',
    ],
    realtor: [
        'Name', 'Office', 'Phone', 'Mobile Phone', 'Rating', 'Review Count',
        'Years Of Experience', 'For Sale Count', 'Sold Count', 'Combined Price Range',
        'License Number', 'Served Areas', 'Realtor Profile URL',
    ],
};

// Full column lists from the server (fallback to KEY_COLS until loaded).
let ALL_COLS = {
    courted: [...KEY_COLS.courted], zillow: [...KEY_COLS.zillow], realtor: [...KEY_COLS.realtor],
};
let showAllCols = true; // default: show every column
const DISPLAY_COLS = () => (showAllCols ? ALL_COLS : KEY_COLS);

fetch('/api/columns')
    .then((r) => r.json())
    .then((cols) => { if (cols && cols.courted) ALL_COLS = cols; })
    .catch(() => {});

// Header status badge — what's connected.
fetch('/api/status')
    .then((r) => r.json())
    .then((s) => {
        const env = document.getElementById('env');
        if (!env) return;
        const ok = (label, on) => `<span class="${on ? 'ok' : 'bad'}">${on ? '●' : '○'} ${label}</span>`;
        const courtedLabel = s.courtedAccounts > 1 ? `Courted · ${s.courtedAccounts} accts` : 'Courted';
        env.innerHTML = `${ok(courtedLabel, s.courted)} &nbsp; ${ok(`Unblocker${s.unblocker ? ' · ' + s.unblocker : ''}`, !!s.unblocker)}`;
    })
    .catch(() => {});

const URL_COLS = new Set(['Zillow Profile URL', 'Courted Profile URL', 'Realtor Profile URL', 'Profile Photo URL', 'Website URL', 'Facebook URL', 'Instagram URL', 'LinkedIn URL', 'Twitter URL', 'YouTube URL', 'TikTok URL']);
const MONEY_COLS = new Set(['LTM Sales Volume', 'LTM Est GCI', 'LTM Avg Sale Price', 'YTD Sales Volume']);

const $ = (id) => document.getElementById(id);
let currentJob = null;
let pollTimer = null;
const totals = {};   // matched-count per source
const rowData = {};  // raw rows kept for re-render on toggle
const serverCount = {}; // server-side fetched count (full-sweep streams to DB, not the table)
for (const s of SOURCES) { totals[s] = null; rowData[s] = []; serverCount[s] = 0; }

let running = false;
$('searchBtn').addEventListener('click', () => (running ? stopSearch() : startSearch()));

function stopSearch() {
    if (currentJob) fetch(`/api/search/${currentJob}/stop`, { method: 'POST' }).catch(() => {});
    if (pollTimer) clearTimeout(pollTimer);
    running = false;
    $('searchBtn').textContent = 'Search';
    $('searchBtn').classList.remove('stopping');
    for (const s of SOURCES) {
        const pill = $(`status-${s}`);
        if (pill && /running|queued/.test(pill.textContent)) setStatus(s, 'done', 'stopped');
    }
}
$('showAll').addEventListener('change', (e) => {
    showAllCols = e.target.checked;
    for (const src of SOURCES) rerender(src);
});

// Rebuild a whole table (header + all rows) from stored data — used on toggle.
function rerender(source) {
    const cols = DISPLAY_COLS()[source];
    $(`table-${source}`).querySelector('thead').innerHTML =
        '<tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    const tbody = $(`table-${source}`).querySelector('tbody');
    tbody.innerHTML = rowData[source]
        .map((row) => '<tr>' + cols.map((c) => `<td title="${escapeAttr(row[c])}">${cell(c, row[c])}</td>`).join('') + '</tr>')
        .join('');
}
document.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => {
        if (currentJob) window.location = `/api/search/${currentJob}/export?source=${btn.dataset.export}`;
    });
});

function startSearch() {
    // Split on NEW LINES / semicolons only — NOT commas (a "City, ST" has a comma).
    const locations = $('locations').value
        .split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
    const courtedAllAgents = $('courtedAllAgents').checked;
    if (!locations.length && !courtedAllAgents) { alert('Enter at least one location or ZIP (or tick Courted “All agents”).'); return; }

    const sources = SOURCES.filter((s) => $(`src-${s}`).checked);
    if (!sources.length) { alert('Select at least one source.'); return; }

    const body = {
        locations,
        sources,
        courtedMax: +$('courtedMax').value || 0,
        minSalesVolume: +$('minSalesVolume').value || 0,
        courtedEnrich: $('courtedEnrich').checked,
        courtedAllAgents,
        zillowMaxPages: +$('zillowMaxPages').value || 25,
        zillowConcurrency: +$('zillowConcurrency').value || 4,
        zillowEnrich: $('zillowEnrich').checked,
        realtorMax: +$('realtorMax').value || 0,
        realtorConcurrency: +$('realtorConcurrency').value || 3,
        realtorEnrich: $('realtorEnrich').checked,
    };

    resetUi(sources);
    running = true;
    $('searchBtn').textContent = 'Stop';
    $('searchBtn').classList.add('stopping');

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then((r) => r.json())
        .then((res) => {
            if (res.error) throw new Error(res.error);
            currentJob = res.jobId;
            openStream(res.jobId);
        })
        .catch((err) => {
            alert(err.message);
            running = false;
            $('searchBtn').textContent = 'Search';
            $('searchBtn').classList.remove('stopping');
        });
}

// Poll for results (robust — SSE/EventSource was dropping the realtor record
// burst after long fetches). Asks only for rows we haven't rendered yet.
function openStream(jobId) { poll(jobId); }

function poll(jobId) {
    const q = SOURCES.map((s) => `${s}=${rowData[s].length}`).join('&');
    fetch(`/api/search/${jobId}/results?${q}`)
        .then((r) => r.json())
        .then((d) => {
            if (d.error) { finishRun(); return; }
            for (const s of SOURCES) {
                const sc = d.sources[s];
                if (!sc) continue;
                if (sc.total != null) totals[s] = sc.total;
                if (sc.count != null) serverCount[s] = sc.count;
                for (const row of (sc.newRows || [])) addRow({ source: s, row });
                if (sc.status && sc.status !== 'pending') {
                    setStatus(s, sc.status, sc.message, sc.status === 'error');
                    if (sc.status === 'done' || sc.status === 'error') enableExport(s);
                }
                updateCount(s);
            }
            if (d.status !== 'running') { finishRun(); return; }
            if (running) pollTimer = setTimeout(() => poll(jobId), 1500);
        })
        .catch(() => { if (running) pollTimer = setTimeout(() => poll(jobId), 2000); });
}

function finishRun() {
    running = false;
    $('searchBtn').textContent = 'Search';
    $('searchBtn').classList.remove('stopping');
    $('stopAcctBtn').style.display = 'none'; // add-account sweep finished
    $('addAcctBtn').disabled = false;
    // Enable the master-list builder once a job has produced rows.
    const anyRows = SOURCES.some((s) => rowData[s].length);
    $('buildMaster').disabled = !(currentJob && anyRows);
}

// --- Master (deduplicated) list ---
let masterCols = [];
$('buildMaster').addEventListener('click', buildMaster);
$('exportMaster').addEventListener('click', () => {
    if (currentJob) window.location = `/api/search/${currentJob}/export?source=master`;
});

function buildMaster() {
    if (!currentJob) return;
    $('buildMaster').disabled = true;
    $('masterStats').textContent = 'Analyzing & matching agents across platforms…';
    fetch(`/api/search/${currentJob}/master`)
        .then((r) => r.json())
        .then((d) => {
            if (d.error) throw new Error(d.error);
            masterCols = d.columns;
            renderMaster(d.rows);
            const s = d.stats;
            $('masterStats').innerHTML =
                `<b>${s.unique.toLocaleString()}</b> unique agents `
                + `&nbsp;·&nbsp; <b>${s.duplicatesRemoved.toLocaleString()}</b> duplicates merged `
                + `&nbsp;·&nbsp; <b>${s.multiPlatform.toLocaleString()}</b> found on 2+ platforms `
                + `&nbsp;<span class="hint">(from ${s.totalScraped.toLocaleString()} scraped — `
                + `Courted ${s.bySource.courted}, Zillow ${s.bySource.zillow}, Realtor ${s.bySource.realtor})</span>`;
            $('exportMaster').disabled = d.rows.length === 0;
            $('buildMaster').disabled = false;
            $('buildMaster').textContent = 'Rebuild master list';
        })
        .catch((err) => {
            $('masterStats').textContent = 'Master build failed: ' + err.message;
            $('buildMaster').disabled = false;
        });
}

function renderMaster(rows) {
    $('table-master').querySelector('thead').innerHTML =
        '<tr>' + masterCols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    $('table-master').querySelector('tbody').innerHTML = rows.map((row) => {
        const pc = Number(row['Platform Count']) || 1;
        const cls = pc > 1 ? ' class="multi"' : '';
        return `<tr${cls}>` + masterCols.map((c) => `<td title="${escapeAttr(row[c])}">${cell(c, row[c])}</td>`).join('') + '</tr>';
    }).join('');
}

function resetUi(sources) {
    showAllCols = $('showAll').checked;
    for (const src of SOURCES) {
        totals[src] = null;
        rowData[src] = [];
        serverCount[src] = 0;
        const active = sources.includes(src);
        $(`panel-${src}`).style.opacity = active ? '1' : '0.4';
        $(`table-${src}`).querySelector('thead').innerHTML =
            '<tr>' + DISPLAY_COLS()[src].map((c) => `<th>${c}</th>`).join('') + '</tr>';
        $(`table-${src}`).querySelector('tbody').innerHTML = '';
        $(`count-${src}`).textContent = '0';
        $(`msg-${src}`).textContent = '';
        $(`msg-${src}`).classList.remove('error');
        setStatus(src, active ? 'queued' : 'idle', '');
        document.querySelector(`[data-export="${src}"]`).disabled = true;
    }
}

function addRow({ source, row }) {
    rowData[source].push(row);
    const tbody = $(`table-${source}`).querySelector('tbody');
    const cols = DISPLAY_COLS()[source];
    const tr = document.createElement('tr');
    tr.className = 'new';
    tr.innerHTML = cols.map((c) => `<td title="${escapeAttr(row[c])}">${cell(c, row[c])}</td>`).join('');
    tbody.appendChild(tr);
    updateCount(source);
    setTimeout(() => tr.classList.remove('new'), 1000);
}

// Count badge shows "fetched / total" once the matched total is known.
function updateCount(source) {
    const rendered = $(`table-${source}`).querySelector('tbody').children.length;
    const n = Math.max(rendered, serverCount[source] || 0); // full-sweep: rows go to DB, not the table
    const total = totals[source];
    $(`count-${source}`).textContent = (total != null && total !== n)
        ? `${n.toLocaleString()} / ${total.toLocaleString()}`
        : n.toLocaleString();
}

function cell(col, val) {
    if (val == null || val === '') return '';
    if (URL_COLS.has(col)) return `<a href="${escapeAttr(val)}" target="_blank">link</a>`;
    if (MONEY_COLS.has(col) && /^\d+$/.test(String(val))) return '$' + Number(val).toLocaleString();
    return escapeHtml(String(val));
}

function setStatus(source, status, message, isError) {
    const pill = $(`status-${source}`);
    if (pill) { pill.textContent = status; pill.className = `pill ${status}`; }
    if (message != null) {
        const m = $(`msg-${source}`);
        m.textContent = message;
        m.classList.toggle('error', !!isError);
    }
}

function enableExport(source) {
    const n = $(`table-${source}`).querySelector('tbody').children.length;
    document.querySelector(`[data-export="${source}"]`).disabled = n === 0;
}

function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

// --- Add a new Courted account, save it to Railway, then auto-sweep it ---
$('addAcctBtn').addEventListener('click', addAccount);
$('stopAcctBtn').addEventListener('click', () => {
    stopSearch();
    $('stopAcctBtn').style.display = 'none';
    $('addAcctBtn').disabled = false;
    setAcctMsg('Sweep stopped. Everything scraped so far is saved — you can re-add to resume.');
});

function setAcctMsg(text, isError) {
    const m = $('acctMsg');
    m.textContent = text;
    m.classList.toggle('error', !!isError);
}

async function addAccount() {
    const email = $('acctEmail').value.trim();
    const password = $('acctPassword').value;
    const state = $('acctState').value.trim().toUpperCase();
    if (!email || !password) { setAcctMsg('Enter the Courted email and password.', true); return; }
    if (state && !/^[A-Z]{2}$/.test(state)) { setAcctMsg('MLS state must be a 2-letter code (e.g. NV) — or leave it blank.', true); return; }

    $('addAcctBtn').disabled = true;
    setAcctMsg('Validating login & saving the account…');
    try {
        const r = await fetch('/api/courted/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'request failed');

        if (d.already) {
            setAcctMsg('Account already saved — starting the sweep…');
        } else {
            setAcctMsg(`Saved (account #${d.slot}). Restarting the service to load it — ~1–2 min…`);
            await waitForAccounts(d.accountsExpected);
            setAcctMsg('Service is back up. Starting the sweep…');
        }
        startAccountSweep(email, state);
    } catch (err) {
        setAcctMsg('Failed: ' + err.message, true);
        $('addAcctBtn').disabled = false;
    }
}

// Poll /api/status until the new account is loaded (survives the redeploy gap).
function waitForAccounts(expected) {
    return new Promise((resolve) => {
        const tick = () => fetch('/api/status', { cache: 'no-store' })
            .then((r) => r.json())
            .then((s) => {
                if ((s.courtedAccounts || 0) >= expected) resolve();
                else setTimeout(tick, 5000);
            })
            .catch(() => setTimeout(tick, 5000)); // container down mid-redeploy → retry
        setTimeout(tick, 10000); // let the redeploy start before first poll
    });
}

function startAccountSweep(email, state) {
    const body = state
        ? { sources: ['courted'], courtedOnly: [email], courtedAllAgents: false, locations: [`state:${state}`] }
        : { sources: ['courted'], courtedOnly: [email], courtedAllAgents: true, courtedBanded: true };

    resetUi(['courted']);
    running = true;
    $('searchBtn').textContent = 'Stop';
    $('searchBtn').classList.add('stopping');

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then((r) => r.json())
        .then((res) => {
            if (res.error) throw new Error(res.error);
            currentJob = res.jobId;
            $('addAcctBtn').disabled = false;
            $('stopAcctBtn').style.display = '';
            $('acctPassword').value = '';
            setAcctMsg(`Sweep started ✓ for ${email}${state ? ' · ' + state : ''} — live progress in the Courted panel below.`);
            openStream(res.jobId);
        })
        .catch((err) => {
            setAcctMsg('Sweep failed to start: ' + err.message, true);
            $('addAcctBtn').disabled = false;
            running = false;
            $('searchBtn').textContent = 'Search';
            $('searchBtn').classList.remove('stopping');
        });
}
