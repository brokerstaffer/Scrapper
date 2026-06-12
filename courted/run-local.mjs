// run-local.mjs — run the Courted scraper WITHOUT Apify. Writes results to
// output/courted-agents.json and output/courted-agents.csv.
//
// Usage:
//   COURTED_EMAIL=you@x.com COURTED_PASSWORD=secret \
//     node run-local.mjs --locations "Miami, FL;Boca Raton, FL" --max 200 --enrich
//
// Flags:
//   --locations "A;B;C"   semicolon-separated cities ("City, ST") or ZIPs
//   --max N               total record cap (default 100; 0 = unlimited)
//   --per N               cap per location (0 = unlimited)
//   --min-volume N        skip agents under N LTM sales volume
//   --order FIELD         order_by (default ltm_sales_volume)
//   --asc                 ascending order
//   --enrich              fetch each agent's detail record (slower, richer)
//   --all-statuses        send no status filter
//   --out DIR             output directory (default ./output)

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runScrape } from './src/scraper.js';
import { OUTPUT_COLUMNS } from './src/constants.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name, def = '') => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const email = process.env.COURTED_EMAIL;
const password = process.env.COURTED_PASSWORD;
if (!email || !password) {
    console.error('Set COURTED_EMAIL and COURTED_PASSWORD env vars.');
    process.exit(1);
}

const config = {
    email,
    password,
    locations: val('--locations').split(';').map((s) => s.trim()).filter(Boolean),
    maxRecords: parseInt(val('--max', '100'), 10),
    maxRecordsPerLocation: parseInt(val('--per', '0'), 10),
    minSalesVolume: parseInt(val('--min-volume', '0'), 10),
    orderBy: val('--order', 'ltm_sales_volume'),
    orderDirection: flag('--asc') ? 'asc' : 'desc',
    enrichProfiles: flag('--enrich'),
    statuses: flag('--all-statuses') ? [] : undefined,
};
// Let scraper.js default the statuses when not overridden.
if (config.statuses === undefined) delete config.statuses;

const outDir = path.resolve(val('--out', 'output'));
await mkdir(outDir, { recursive: true });

const rows = [];
const t0 = Date.now();
const simpleLog = {
    info: (m) => console.log('•', m),
    warning: (m) => console.warn('!', m),
    debug: () => {},
};

const { pushed } = await runScrape(config, {
    log: simpleLog,
    onRecord: (row) => {
        rows.push(row);
        if (rows.length % 25 === 0) console.log(`  …${rows.length} agents`);
    },
});

const jsonPath = path.join(outDir, 'courted-agents.json');
const csvPath = path.join(outDir, 'courted-agents.csv');
await writeFile(jsonPath, JSON.stringify(rows, null, 2));
await writeFile(csvPath, toCsv(rows));

console.log(`\nDone. ${pushed} agents in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`JSON: ${jsonPath}`);
console.log(`CSV:  ${csvPath}`);

function toCsv(records) {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = OUTPUT_COLUMNS.map(esc).join(',');
    const lines = records.map((r) => OUTPUT_COLUMNS.map((c) => esc(r[c])).join(','));
    return [header, ...lines].join('\n');
}
