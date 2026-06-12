// app.js — frontend: kick off a search, stream results into two live tables.

// Compact "key columns" view (toggle). The FULL column set (76 Courted / 47
// Zillow) is loaded from the server and is the default.
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
};

// Full column lists from the server (fallback to KEY_COLS until loaded).
let ALL_COLS = { courted: [...KEY_COLS.courted], zillow: [...KEY_COLS.zillow] };
let showAllCols = true; // default: show every column
const DISPLAY_COLS = () => (showAllCols ? ALL_COLS : KEY_COLS);

fetch('/api/columns')
    .then((r) => r.json())
    .then((cols) => { if (cols && cols.courted && cols.zillow) ALL_COLS = cols; })
    .catch(() => {});

const URL_COLS = new Set(['Zillow Profile URL', 'Courted Profile URL', 'Profile Photo URL', 'Website URL']);
const MONEY_COLS = new Set(['LTM Sales Volume', 'LTM Est GCI', 'LTM Avg Sale Price', 'YTD Sales Volume']);

const $ = (id) => document.getElementById(id);
let currentJob = null;
let es = null;
const totals = { courted: null, zillow: null }; // matched-count per source
const rowData = { courted: [], zillow: [] };     // raw rows kept for re-render on toggle

$('searchBtn').addEventListener('click', startSearch);
$('showAll').addEventListener('change', (e) => {
    showAllCols = e.target.checked;
    for (const src of ['courted', 'zillow']) rerender(src);
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
    const locations = $('locations').value
        .split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!locations.length) { alert('Enter at least one location or ZIP.'); return; }

    const sources = [];
    if ($('src-courted').checked) sources.push('courted');
    if ($('src-zillow').checked) sources.push('zillow');
    if (!sources.length) { alert('Select at least one source.'); return; }

    const body = {
        locations,
        sources,
        courtedMax: +$('courtedMax').value || 0,
        minSalesVolume: +$('minSalesVolume').value || 0,
        courtedEnrich: $('courtedEnrich').checked,
        zillowMaxPages: +$('zillowMaxPages').value || 25,
        zillowConcurrency: +$('zillowConcurrency').value || 4,
        zillowEnrich: $('zillowEnrich').checked,
    };

    resetUi(sources);
    $('searchBtn').disabled = true;
    $('searchBtn').textContent = 'Searching…';

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
            $('searchBtn').disabled = false;
            $('searchBtn').textContent = 'Search';
        });
}

function openStream(jobId) {
    if (es) es.close();
    es = new EventSource(`/api/search/${jobId}/stream`);

    es.addEventListener('record', (e) => addRow(JSON.parse(e.data)));
    es.addEventListener('meta', (e) => {
        const d = JSON.parse(e.data);
        totals[d.source] = d.total;
        updateCount(d.source);
    });
    es.addEventListener('progress', (e) => {
        const d = JSON.parse(e.data);
        setStatus(d.source, d.status || 'running', d.message);
    });
    es.addEventListener('source_done', (e) => {
        const d = JSON.parse(e.data);
        setStatus(d.source, 'done', d.message);
        enableExport(d.source);
    });
    es.addEventListener('source_error', (e) => {
        const d = JSON.parse(e.data);
        setStatus(d.source, 'error', d.message, true);
        enableExport(d.source);
    });
    es.addEventListener('complete', () => {
        $('searchBtn').disabled = false;
        $('searchBtn').textContent = 'Search';
        es.close();
    });
}

function resetUi(sources) {
    totals.courted = null;
    totals.zillow = null;
    rowData.courted = [];
    rowData.zillow = [];
    showAllCols = $('showAll').checked;
    for (const src of ['courted', 'zillow']) {
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
    const n = $(`table-${source}`).querySelector('tbody').children.length;
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
