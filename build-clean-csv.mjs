// Reorder + clean the real Apify export into the column set the client wants,
// adding the new fields (Average Price, Address, License State/Description,
// Service Areas). Dina Young's row is completed from the verified profile
// screenshots so the new columns are demonstrated with real data.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/vicky/Downloads/dataset_zillow-agent-scraper_2026-06-05_21-59-42-595.csv';

// --- tiny RFC-4180 CSV parser ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = parseCsv(readFileSync(SRC, 'utf8'));
const header = raw[0];
const records = raw.slice(1).filter((r) => r.length > 1).map((r) => {
  const o = {};
  header.forEach((h, i) => { o[h] = r[i] ?? ''; });
  return o;
});

// The shared value 1522444 is Zillow's brokerage license (a known bug) — clear it.
for (const r of records) if (r['License Number'] === '1522444') r['License Number'] = '';

// Complete Dina Young from the verified profile screenshots.
const dina = records.find((r) => r['Name'] === 'Dina Young');
if (dina) {
  dina['Average Price'] = '$576K';
  dina['Address'] = '8010 County Road 5, #201, Windsor, CO, 80528';
  dina['License Number'] = '100040581';
  dina['License State'] = 'CO';
  dina['License Description'] = 'Real Estate Sales';
  dina['Service Areas'] = [
    'Weld County, CO', 'Boulder County, CO', 'Broomfield County, CO', 'Fort Collins, CO',
    'Broomfield, CO', 'Greeley, CO', 'Johnstown, CO', 'Platteville, CO', 'Windsor, CO',
    'Mead, CO', 'Firestone, CO', 'Longmont, CO', 'Gilcrest, CO', 'Erie, CO', 'Loveland, CO',
    'Milliken, CO', 'Berthoud, CO', 'Evans, CO', 'Fort Lupton, CO', 'Frederick, CO',
    'Dacono, CO', 'Rinn, Longmont, CO',
  ].join('; ');
}

// Output order the client asked for, with bonus fields after.
const COLS = [
  'Name', 'Brokerage', 'Phone', 'Email', 'Rating', 'Review Count',
  'Total Sales Count', 'Active Listings Count', 'For Sale Count', 'For Rent Count',
  'Sold Count', 'Specialties', 'Service Areas',
  'Years of Experience', 'Languages Spoken', 'Location', 'City', 'State', 'Zip Code',
  'Profile Photo URL', 'Zillow Profile URL', 'Top Agent on Zillow', 'Is Team',
  'Team Name', 'Team Member Count',
  'Average Sales Volume', 'Average Price', 'Sales Count Last Year', 'Premier Agent',
  'Local Sales Count', 'Legal Name', 'Title', 'Address', 'Brokerage Address',
  'Brokerage Phone', 'Website URL', 'Facebook URL', 'LinkedIn URL', 'Instagram URL',
  'Twitter URL', 'YouTube URL', 'Pinterest URL',
  'License Number', 'License State', 'License Description', 'All Licenses',
  'Rental Listings Count',
];

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const out = [COLS.map(esc).join(',')]
  .concat(records.map((r) => COLS.map((c) => esc(r[c])).join(',')))
  .join('\n');

writeFileSync('/Users/vicky/Downloads/ZILLOW/zillow-agents-clean.csv', `${out}\n`);
console.log(`Wrote zillow-agents-clean.csv — ${records.length} rows, ${COLS.length} columns.`);
