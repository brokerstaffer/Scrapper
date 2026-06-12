// parser.js — text parsing logic for Zillow agent cards.
// The regex patterns here were validated against real Zillow data. Do not
// change them without re-validating against the samples in test/parser.test.js.

import { createEmptyAgent } from './constants.js';

// Rating + Review Count — "5.0 (170)", "5.0(5,476)", "4.8 (23)"
export const RATING_PATTERN = /(\d\.\d)\s*\(([\d,]+)\)/;

// Price Range — "$400K - $1.4M", "$18K - $11M", "$75K - $950K", "$100K - $6.2M"
export const PRICE_PATTERN = /\$[\d,.]+[KkMmBb]?\s*-\s*\$[\d,.]+[KkMmBb]?/;

// Sales last 12 months — "1,012 team sales last 12 months", "2 sales last 12 months"
export const SALES_LAST_YEAR = /([\d,]+)\s*(?:team\s*)?sales?\s*last\s*12\s*months/i;

// Local sales — "33 team sales in Mead", "5 sales in Mead", "1 team sale in Mead"
export const LOCAL_SALES = /([\d,]+)\s*(?:team\s*)?sales?\s*in\s+/i;

// "No ..." negatives
export const NO_SALES_LAST = /No\s+sales?\s*last\s*12/i;
export const NO_SALES_LOCAL = /No\s+sales?\s*in\s/i;
export const NO_PRICE = /No\s+recent\s+price\s+range/i;

/**
 * Turn a user-supplied location into a Zillow URL slug and structured parts.
 *   "Mead, CO"    -> { slug: "mead-co", city: "Mead", state: "CO", zip: "", full: "Mead, CO" }
 *   "Boulder, CO" -> { slug: "boulder-co", ... }
 *   "80542"       -> { slug: "80542", city: "", state: "", zip: "80542", full: "80542" }
 */
export function parseLocation(rawLocation) {
    const full = String(rawLocation || '').trim();
    const isZip = /^\d{5}(-\d{4})?$/.test(full);

    if (isZip) {
        return { slug: full, city: '', state: '', zip: full, full };
    }

    // City, State form. Be tolerant of missing comma ("Mead CO").
    let city = full;
    let state = '';
    const commaMatch = full.match(/^(.*),\s*([A-Za-z]{2})$/);
    if (commaMatch) {
        city = commaMatch[1].trim();
        state = commaMatch[2].trim().toUpperCase();
    } else {
        const spaceMatch = full.match(/^(.*)\s+([A-Za-z]{2})$/);
        if (spaceMatch) {
            city = spaceMatch[1].trim();
            state = spaceMatch[2].trim().toUpperCase();
        }
    }

    const slug = full
        .toLowerCase()
        .replace(/,/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');

    return { slug, city, state, zip: '', full };
}

/**
 * Parse the concatenated text inside a single agent <a> tag into a structured
 * record. `pageLocation` is the output of parseLocation().
 */
function applyLocation(agent, profileUrl, loc) {
    agent['Zillow Profile URL'] = profileUrl || '';
    agent['Location'] = loc.full || '';
    agent['City'] = loc.city || '';
    agent['State'] = loc.state || '';
    agent['Zip Code'] = loc.zip || '';
    agent['Top Agent on Zillow'] = 'No';
    agent['Is Team'] = 'No';
    agent['Team Name'] = '';
}

/**
 * Preferred parser: works off the ordered DOM text segments captured from each
 * agent <a> tag. Zillow renders the name, brokerage, price, and each sales stat
 * as separate inline elements, so segments recover the boundaries that a flat
 * textContent blob glues together — notably team name vs brokerage.
 *
 * Returns a parsed agent, or null if the segments don't look parseable (caller
 * then falls back to the regex blob parser).
 */
export function parseAgentSegments(rawSegments, profileUrl, pageLocation = {}) {
    if (!Array.isArray(rawSegments) || rawSegments.length === 0) return null;

    const segs = rawSegments.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);

    // Locate the rating segment, e.g. "5.0".
    const ratingIdx = segs.findIndex((s) => /^\d\.\d$/.test(s));
    if (ratingIdx === -1) return null;

    const agent = createEmptyAgent();
    applyLocation(agent, profileUrl, pageLocation);

    const isTeam = /^TEAM$/i.test(segs[0]);
    agent['Is Team'] = isTeam ? 'Yes' : 'No';

    // Top Agent badge can appear as its own segment.
    if (segs.some((s) => /^Top Agent/i.test(s))) agent['Top Agent on Zillow'] = 'Yes';

    agent['Rating'] = segs[ratingIdx];

    // Review count is usually the next segment, "(39)".
    let reviewIdx = ratingIdx;
    const rc = segs[ratingIdx + 1] && segs[ratingIdx + 1].match(/^\(([\d,]+)\)$/);
    if (rc) {
        agent['Review Count'] = rc[1].replace(/,/g, '');
        reviewIdx = ratingIdx + 1;
    }

    // Name candidate from segments before the rating (individuals).
    const nameBefore = segs
        .slice(isTeam ? 1 : 0, ratingIdx)
        .filter((s) => !/^Top Agent/i.test(s))
        .join(' ')
        .trim();

    // Everything after the review-count segment.
    const after = segs.slice(reviewIdx + 1);

    // The name/brokerage block runs until the first price marker (or, failing
    // that, the first sales/number/"No sales" marker).
    let stopIdx = after.findIndex((s) => PRICE_PATTERN.test(s) || NO_PRICE.test(s));
    if (stopIdx === -1) {
        stopIdx = after.findIndex(
            (s) => /sales?\s*(last\s*12|in)\b/i.test(s) || /^[\d,]+$/.test(s) || /No\s+sales/i.test(s),
        );
    }
    if (stopIdx === -1) stopIdx = after.length;
    const block = after.slice(0, stopIdx).filter((s) => !/^Top Agent/i.test(s));

    if (isTeam) {
        // block = [TeamName, Brokerage] (Brokerage may equal TeamName).
        if (block.length >= 2) {
            agent['Name'] = block[0];
            agent['Brokerage'] = block[block.length - 1];
        } else if (block.length === 1) {
            agent['Name'] = dedupeBrokerage(block[0]);
            agent['Brokerage'] = agent['Name'];
        } else {
            agent['Name'] = nameBefore;
        }
        agent['Team Name'] = agent['Name'];
    } else {
        // Individual: name came before the rating; brokerage is the block.
        if (nameBefore) {
            agent['Name'] = nameBefore;
            agent['Brokerage'] = block.join(' ');
        } else {
            agent['Name'] = block[0] || '';
            agent['Brokerage'] = block.slice(1).join(' ');
        }
    }

    // Price range.
    const priceSeg = after.find((s) => PRICE_PATTERN.test(s));
    if (priceSeg) agent['Average Sales Volume'] = priceSeg.match(PRICE_PATTERN)[0].replace(/\s+/g, ' ').trim();

    // Sales stats — the number is the segment immediately before its label.
    for (let i = 0; i < after.length; i += 1) {
        const s = after[i];
        if (/No\s+sales?\s*last\s*12/i.test(s)) {
            agent['Sales Count Last Year'] = '0';
        } else if (/No\s+sales?\s*in\b/i.test(s)) {
            agent['Local Sales Count'] = '0';
        } else if (/sales?\s*last\s*12\s*months/i.test(s)) {
            const num = (after[i - 1] || '').match(/^([\d,]+)$/);
            if (num) agent['Sales Count Last Year'] = num[1].replace(/,/g, '');
        } else if (/sales?\s*in\s+/i.test(s)) {
            const num = (after[i - 1] || '').match(/^([\d,]+)$/);
            if (num) agent['Local Sales Count'] = num[1].replace(/,/g, '');
        }
    }

    agent['Name'] = (agent['Name'] || '').replace(/\$.*$/g, '').trim();
    if (!agent['Name']) return null;
    return agent;
}

export function parseAgentText(rawText, profileUrl, pageLocation = {}, segments = null) {
    // Prefer the structured segment parser when segments are available and valid.
    if (segments && segments.length) {
        const fromSegments = parseAgentSegments(segments, profileUrl, pageLocation);
        if (fromSegments) return fromSegments;
    }

    const agent = createEmptyAgent();
    agent['Zillow Profile URL'] = profileUrl || '';
    agent['Location'] = pageLocation.full || '';
    agent['City'] = pageLocation.city || '';
    agent['State'] = pageLocation.state || '';
    agent['Zip Code'] = pageLocation.zip || '';
    agent['Top Agent on Zillow'] = 'No';
    agent['Is Team'] = 'No';
    agent['Team Name'] = '';

    let text = String(rawText || '').replace(/\s+/g, ' ').trim();
    const isTeam = text.startsWith('TEAM');
    agent['Is Team'] = isTeam ? 'Yes' : 'No';

    // Step 1: strip TEAM prefix
    if (isTeam) {
        text = text.substring(4);
    }

    // Step 2: Top Agent badge
    if (/Top Agent/i.test(text)) {
        agent['Top Agent on Zillow'] = 'Yes';
        text = text.replace(/Top Agent\s*(on Zillow)?/gi, '');
    }

    // Step 3: Rating + Review Count
    const ratingMatch = text.match(RATING_PATTERN);
    if (!ratingMatch) {
        // No rating — minimal data available.
        agent['Name'] = text.substring(0, 60).trim();
        if (isTeam) agent['Team Name'] = agent['Name'];
        return agent;
    }

    agent['Rating'] = ratingMatch[1];
    agent['Review Count'] = ratingMatch[2].replace(/,/g, '');

    // Step 4: Name = everything before the rating
    const ratingIndex = text.indexOf(ratingMatch[0]);
    agent['Name'] = text.substring(0, ratingIndex).trim();

    // Step 5: everything after the rating
    const afterRating = text.substring(ratingIndex + ratingMatch[0].length).trim();

    // Step 6: Price range + brokerage
    const priceMatch = afterRating.match(PRICE_PATTERN);
    if (priceMatch) {
        agent['Average Sales Volume'] = priceMatch[0].replace(/\s+/g, ' ').trim();
        const priceIndex = afterRating.indexOf(priceMatch[0]);
        const brokerageText = afterRating.substring(0, priceIndex).trim();
        if (brokerageText) agent['Brokerage'] = brokerageText;
    } else {
        const noPriceIndex = afterRating.search(NO_PRICE);
        if (noPriceIndex > -1) {
            agent['Brokerage'] = afterRating.substring(0, noPriceIndex).trim();
        } else {
            const digitIndex = afterRating.search(/\d/);
            const noSalesIndex = afterRating.search(/No\s+sales/i);
            const splitIndex = Math.min(
                digitIndex > -1 ? digitIndex : Infinity,
                noSalesIndex > -1 ? noSalesIndex : Infinity,
            );
            if (splitIndex < Infinity) {
                agent['Brokerage'] = afterRating.substring(0, splitIndex).trim();
            }
        }
    }

    // Step 7: Sales last 12 months
    const salesMatch = afterRating.match(SALES_LAST_YEAR);
    if (salesMatch) {
        agent['Sales Count Last Year'] = salesMatch[1].replace(/,/g, '');
    } else if (NO_SALES_LAST.test(afterRating)) {
        agent['Sales Count Last Year'] = '0';
    }

    // Step 8: Local sales
    const localMatch = afterRating.match(LOCAL_SALES);
    if (localMatch) {
        agent['Local Sales Count'] = localMatch[1].replace(/,/g, '');
    } else if (NO_SALES_LOCAL.test(afterRating)) {
        agent['Local Sales Count'] = '0';
    }

    // Step 9: Team handling. For teams the name does not appear before the
    // rating — the team/brokerage text sits AFTER it (often doubled, e.g.
    // "8z Real Estate8z Real Estate"). Derive the team name from the brokerage.
    if (isTeam) {
        if (!agent['Name'] && agent['Brokerage']) {
            agent['Name'] = dedupeBrokerage(agent['Brokerage']);
        }
        agent['Team Name'] = agent['Name'];
    }

    // Step 10: Clean up name — drop any trailing price/brokerage that leaked in.
    agent['Name'] = agent['Name']
        .replace(NO_PRICE, '')
        .replace(/\$.*$/g, '')
        .trim();

    return agent;
}

/**
 * Some Zillow brokerage text accidentally repeats (the team name is printed
 * twice for teams, e.g. "8z Real Estate8z Real Estate"). Collapse an exact
 * doubled prefix when we can detect it cleanly.
 */
export function dedupeBrokerage(brokerage) {
    const b = String(brokerage || '').trim();
    if (!b) return b;
    const half = b.length / 2;
    if (Number.isInteger(half)) {
        const first = b.slice(0, half);
        const second = b.slice(half);
        if (first === second) return first.trim();
    }
    return b;
}
