// merge.js — cross-platform agent de-duplication.
//
// Given the rows we scraped from Courted / Zillow / Realtor, find records that
// are the SAME real-world agent and fuse them into one "master" row. A master
// row records which platforms it came from (Sources) and why those records were
// considered the same person (Match Basis), so the result is auditable.
//
// Matching is conservative — we only merge on strong, identifying signals:
//   • phone   — same last-10 digits of any phone on the record
//   • email   — same email address (case-insensitive)
//   • license — same license number + same last name
//   • name+city — same normalized full name AND same city (weaker fallback)

const SOURCE_ORDER = ['courted', 'realtor', 'zillow']; // value-preference order

// The unified columns a master row carries.
export const MASTER_COLUMNS = [
    'Name', 'Sources', 'Platform Count', 'Match Basis',
    'First Name', 'Last Name',
    'Phone', 'Mobile Phone', 'Email',
    'Office / Brokerage', 'License Number', 'License State',
    'City', 'State',
    'Years Of Experience', 'Rating', 'Review Count',
    'For Sale Count', 'Sold Count', 'Total Sales Count', 'LTM Sales Volume',
    'Served Areas',
    'Courted Profile URL', 'Zillow Profile URL', 'Realtor Profile URL',
    'Profile Photo URL', 'Website URL',
];

// For each master column, the candidate source-column names to read from (the
// three sources name the same concept differently).
const FIELD_MAP = {
    'Name': ['Name'],
    'First Name': ['First Name'],
    'Last Name': ['Last Name'],
    'Phone': ['Phone'],
    'Mobile Phone': ['Mobile Phone'],
    'Email': ['Email'],
    'Office / Brokerage': ['Office', 'Brokerage'],
    'License Number': ['License Number', 'State License'],
    'License State': ['License State', 'Most Transacted State'],
    'City': ['City', 'Office City', 'Most Transacted City'],
    'State': ['State', 'Office State', 'Most Transacted State'],
    'Years Of Experience': ['Years Of Experience', 'Years of Experience'],
    'Rating': ['Rating'],
    'Review Count': ['Review Count'],
    'For Sale Count': ['For Sale Count'],
    'Sold Count': ['Sold Count'],
    'Total Sales Count': ['Total Sales Count'],
    'LTM Sales Volume': ['LTM Sales Volume'],
    'Served Areas': ['Served Areas', 'Service Areas'],
    'Courted Profile URL': ['Courted Profile URL'],
    'Zillow Profile URL': ['Zillow Profile URL'],
    'Realtor Profile URL': ['Realtor Profile URL'],
    'Profile Photo URL': ['Profile Photo URL'],
    'Website URL': ['Website URL'],
};

// --- normalization helpers ---
function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function phoneKey(s) { const d = digits(s); return d.length >= 10 ? d.slice(-10) : null; }
function emailKey(s) {
    const e = String(s == null ? '' : s).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
const NAME_NOISE = /\b(realtor|realtors|broker|brokers|associate|associates|agent|pa|p a|llc|inc|team|group|realty|ccim|gri|abr|sfr|crs|sres|mba|epro|rsps|jr|sr|iii|ii|iv)\b/g;
function normName(s) {
    return String(s == null ? '' : s).toLowerCase()
        .replace(/[,.'"&]/g, ' ')
        .replace(NAME_NOISE, ' ')
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function lastToken(name) { const p = normName(name).split(' ').filter(Boolean); return p.length ? p[p.length - 1] : ''; }
function licenseKey(num, lastName) {
    const n = String(num == null ? '' : num).replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (n.length < 4) return null;
    const ln = lastName || '';
    return ln ? `${ln}:${n}` : null; // require a last name to avoid cross-person collisions
}

function pick(row, cols) {
    for (const c of cols) {
        const v = row[c];
        if (v != null && String(v).trim() !== '') return v;
    }
    return '';
}

// Build a canonical view of one source row: the keys it can match on.
function canon(row, source) {
    const phones = new Set();
    for (const f of ['Phone', 'Mobile Phone', 'Brokerage Phone']) {
        const k = phoneKey(row[f]);
        if (k) phones.add(k);
    }
    const email = emailKey(pick(row, ['Email']));
    const fullName = pick(row, FIELD_MAP['Name']) || `${row['First Name'] || ''} ${row['Last Name'] || ''}`;
    const name = normName(fullName);
    const last = (pick(row, ['Last Name']) && normName(row['Last Name'])) || lastToken(fullName);
    const lic = licenseKey(pick(row, FIELD_MAP['License Number']), last);
    const city = normName(pick(row, FIELD_MAP['City']));
    // name+city only when we have a real first+last (2+ tokens) — avoids merging
    // brokerage rows or single-token names by coincidence.
    const nameCity = (name.split(' ').length >= 2 && city) ? `${name}|${city}` : null;
    return { row, source, phones: [...phones], email, lic, name, nameCity };
}

// Union-Find
function makeUF(n) {
    const p = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p[ra] = rb; };
    return { find, union };
}

/**
 * Build the de-duplicated master list.
 * @param {{courted:object[], zillow:object[], realtor:object[]}} bySource
 * @returns {{rows:object[], stats:object}}
 */
export function buildMaster(bySource) {
    const nodes = [];
    for (const source of ['courted', 'zillow', 'realtor']) {
        for (const row of (bySource[source] || [])) nodes.push(canon(row, source));
    }
    const uf = makeUF(nodes.length);

    // Index each strong key → node ids, then union nodes that share a key.
    const buckets = new Map(); // key -> [ids]
    const addKey = (key, id) => {
        if (!key) return;
        let arr = buckets.get(key);
        if (!arr) { arr = []; buckets.set(key, arr); }
        arr.push(id);
    };
    nodes.forEach((nd, id) => {
        for (const ph of nd.phones) addKey(`p:${ph}`, id);
        if (nd.email) addKey(`e:${nd.email}`, id);
        if (nd.lic) addKey(`l:${nd.lic}`, id);
        if (nd.nameCity) addKey(`n:${nd.nameCity}`, id);
    });
    for (const ids of buckets.values()) {
        for (let i = 1; i < ids.length; i += 1) uf.union(ids[0], ids[i]);
    }

    // Group node ids by cluster root.
    const clusters = new Map();
    nodes.forEach((_, id) => {
        const root = uf.find(id);
        let arr = clusters.get(root);
        if (!arr) { arr = []; clusters.set(root, arr); }
        arr.push(id);
    });

    const rows = [];
    let multi = 0;
    for (const ids of clusters.values()) {
        const members = ids.map((i) => nodes[i]);
        rows.push(fuse(members));
        const distinctSources = new Set(members.map((m) => m.source));
        if (distinctSources.size > 1) multi += 1;
    }

    // Stable, useful sort: multi-platform first, then by name.
    rows.sort((a, b) => (Number(b['Platform Count']) - Number(a['Platform Count']))
        || String(a.Name).localeCompare(String(b.Name)));

    const totalScraped = ['courted', 'zillow', 'realtor'].reduce((n, s) => n + (bySource[s] || []).length, 0);
    return {
        rows,
        stats: {
            totalScraped,
            unique: rows.length,
            duplicatesRemoved: totalScraped - rows.length,
            multiPlatform: multi,
            bySource: {
                courted: (bySource.courted || []).length,
                zillow: (bySource.zillow || []).length,
                realtor: (bySource.realtor || []).length,
            },
        },
    };
}

// Fuse a cluster of canonical records into one master row.
function fuse(members) {
    // Source-preference order for value selection.
    const ordered = [...members].sort(
        (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));

    const out = {};
    for (const col of MASTER_COLUMNS) {
        const cols = FIELD_MAP[col];
        if (!cols) continue;
        let val = '';
        for (const m of ordered) { val = pick(m.row, cols); if (val) break; }
        out[col] = val;
    }

    const sources = [...new Set(ordered.map((m) => m.source))]
        .sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b))
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
    out['Sources'] = sources.join(', ');
    out['Platform Count'] = String(new Set(members.map((m) => m.source)).size);
    out['Match Basis'] = members.length > 1 ? matchBasis(members) : '—';
    return out;
}

// Explain why a cluster was merged (which shared signals exist).
function matchBasis(members) {
    const basis = [];
    const allPhones = members.map((m) => new Set(m.phones));
    if (sharedAcrossSources(members, (m) => m.phones)) basis.push('phone');
    if (sharedAcrossSources(members, (m) => (m.email ? [m.email] : []))) basis.push('email');
    if (sharedAcrossSources(members, (m) => (m.lic ? [m.lic] : []))) basis.push('license');
    if (sharedAcrossSources(members, (m) => (m.nameCity ? [m.nameCity] : []))) basis.push('name+city');
    void allPhones;
    return basis.length ? basis.join(', ') : 'merged';
}

// True if two members from DIFFERENT sources share any value from getter.
function sharedAcrossSources(members, getter) {
    const seen = new Map(); // value -> source
    for (const m of members) {
        for (const v of getter(m)) {
            const prev = seen.get(v);
            if (prev && prev !== m.source) return true;
            if (!prev) seen.set(v, m.source);
        }
    }
    return false;
}
