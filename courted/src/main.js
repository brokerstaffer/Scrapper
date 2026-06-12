// main.js — Apify actor entry point for the Courted agent scraper.

import { Actor } from 'apify';
import { log } from 'crawlee';

import { runScrape } from './scraper.js';
import { DEFAULT_STATUSES } from './constants.js';

await Actor.init();

const input = (await Actor.getInput()) || {};

const config = {
    email: input.email || process.env.COURTED_EMAIL,
    password: input.password || process.env.COURTED_PASSWORD,
    locations: Array.isArray(input.locations) ? input.locations.filter(Boolean) : [],
    orderBy: input.orderBy || 'ltm_sales_volume',
    orderDirection: input.orderDirection || 'desc',
    maxRecords: toInt(input.maxRecords, 0),
    maxRecordsPerLocation: toInt(input.maxRecordsPerLocation, 0),
    minSalesVolume: toInt(input.minSalesVolume, 0),
    enrichProfiles: Boolean(input.enrichProfiles),
    includeContactInfo: input.includeContactInfo !== false,
    statuses: Array.isArray(input.statuses) && input.statuses.length ? input.statuses : DEFAULT_STATUSES,
    extraParams: input.extraParams || {},
    delayMs: toInt(input.delayMs, 350),
};

if (!config.email || !config.password) {
    throw new Error('Provide Courted "email" and "password" in the actor input (or COURTED_EMAIL / COURTED_PASSWORD env vars).');
}

log.info(`Courted Agent Scraper starting for ${config.locations.length || 'ALL'} location(s).`);

const { pushed } = await runScrape(config, {
    log,
    onRecord: (row) => Actor.pushData(row),
});

log.info(`Done. Pushed ${pushed} agent record(s) to the dataset.`);
await Actor.exit();

function toInt(v, fallback) {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? fallback : n;
}
