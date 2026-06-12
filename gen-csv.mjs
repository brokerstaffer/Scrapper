// Generate a CSV from the real Zillow samples captured during testing,
// run through the actual actor parser so the output matches a live run.
import { writeFileSync } from 'node:fs';
import { parseAgentSegments, dedupeBrokerage } from './src/parser.js';
import { parseLocation } from './src/parser.js';
import { OUTPUT_COLUMNS } from './src/constants.js';

const mead = parseLocation('Mead, CO');

// Real DOM segments captured from live Zillow (Mead, CO agent search).
const SEGMENT_CASES = [
  ['TEAM', '5.0', '(5,478)', '8z Real Estate', '8z Real Estate', '$18K - $11M', 'team price range', '1,010', 'team sales last 12 months', '33', 'team sales in Mead'],
  ['TEAM', '5.0', '(224)', 'Integrity Home Group', 'eXp Realty', '$15K - $995K', 'team price range', '9', 'team sales last 12 months', '11', 'team sales in Mead'],
  ['TEAM', '5.0', '(377)', 'Ben Woodrum', 'Coldwell Banker Realty', '$67K - $2.2M', 'team price range', '332', 'team sales last 12 months', '3', 'team sales in Mead'],
  ['Dina Young', '5.0', '(39)', 'Resident Realty', '$220K - $1.6M', 'price range', '14', 'sales last 12 months', '63', 'sales in Mead'],
  ['Yvette teVelde', '5.0', '(9)', 'RE/MAX Momentum Westminster', 'No recent price range', 'No sales last 12 months', '1', 'sale in Mead'],
  ['Lou Scirrotto', '5.0', '(170)', 'Real', '$400K - $1.4M', 'price range', '2', 'sales last 12 months', 'No sales in Mead'],
  ['Ashley Bevan - The Mint Group brokered by eXp Realty', '5.0', '(32)', 'The Mint Group brokered by eXp Realty', '$399K - $1.5M', 'price range', '11', 'sales last 12 months', '24', 'sales in Mead'],
  ['Tracy McClung', '5.0', '(53)', 'RE/MAX Nexus', '$348K - $874K', 'price range', '6', 'sales last 12 months', '5', 'sales in Mead'],
  ['HEATHER BERRY', '5.0', '(47)', 'Your Berry Own Home Powered by: LoKation Real Estate', '$75K - $950K', 'price range', '7', 'sales last 12 months', '3', 'sales in Mead'],
  ['Lindsay Preston', '5.0', '(20)', 'Preston Properties', 'No recent price range', 'No sales last 12 months', 'No sales in Mead'],
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rows = SEGMENT_CASES.map((segs) => {
  const agent = parseAgentSegments(segs, '', mead);
  agent['Zillow Profile URL'] = `https://www.zillow.com/profile/${slug(agent['Name'])}/`;
  agent['Brokerage'] = dedupeBrokerage(agent['Brokerage']);
  return agent;
});

const esc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const header = OUTPUT_COLUMNS.map(esc).join(',');
const body = rows.map((r) => OUTPUT_COLUMNS.map((c) => esc(r[c])).join(',')).join('\n');
writeFileSync('zillow-test-data.csv', `${header}\n${body}\n`);
console.log(`Wrote zillow-test-data.csv with ${rows.length} agent rows.`);
