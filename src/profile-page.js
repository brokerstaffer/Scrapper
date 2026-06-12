// profile-page.js — Step 2: enrich an agent record from their profile page.
//
// Two extraction methods, tried in order, merged into the Step 1 record:
//   Method A — read the embedded __NEXT_DATA__ JSON and recursively pull known
//              fields out of it.
//   Method B — DOM scraping for phone/email/website/social/license/etc.
// We only FILL EMPTY fields — Step 1 data is never overwritten.

import { isCaptchaPage } from './search-page.js';

// Map of social-network host fragments -> output column.
const SOCIAL_HOSTS = [
    { host: 'facebook.com', col: 'Facebook URL' },
    { host: 'linkedin.com', col: 'LinkedIn URL' },
    { host: 'instagram.com', col: 'Instagram URL' },
    { host: 'twitter.com', col: 'Twitter URL' },
    { host: 'x.com', col: 'Twitter URL' },
    { host: 'youtube.com', col: 'YouTube URL' },
    { host: 'youtu.be', col: 'YouTube URL' },
    { host: 'pinterest.com', col: 'Pinterest URL' },
];

// Candidate __NEXT_DATA__ keys -> output column. Many are guesses across Zillow
// schema variants; we take the first non-empty hit per column.
const NEXT_DATA_FIELD_MAP = {
    Phone: ['phoneNumber', 'phone', 'displayPhone', 'businessPhoneNumber'],
    Email: ['email', 'emailAddress'],
    'Total Sales Count': ['totalSales', 'salesCount', 'lifetimeSalesCount', 'allTimeSalesCount'],
    // Active Listings Count is computed (For Sale + For Rent), not mapped here.
    'For Sale Count': ['forSaleCount', 'forSaleListingCount', 'activeForSaleCount', 'forSaleListingsCount'],
    'For Rent Count': ['forRentCount', 'forRentListingCount', 'forRentListingsCount'],
    'Sold Count': ['soldCount', 'soldListingCount', 'recentlySoldCount', 'soldListingsCount'],
    'Years of Experience': ['yearsOfExperience', 'experienceYears', 'yearsExperience'],
    'Languages Spoken': ['languages', 'languagesSpoken', 'spokenLanguages'],
    'Legal Name': ['legalName', 'fullLegalName', 'fullName', 'displayName'],
    // Prefer specific job-title keys; the generic "title" key elsewhere in the
    // JSON is a section heading (e.g. "Recent sales") and is filtered post-hoc.
    Title: ['professionalTitle', 'jobTitle', 'agentTitle', 'roleTitle', 'title'],
    Address: ['businessAddress', 'streetAddress', 'address', 'mailingAddress', 'officeAddress', 'fullAddress'],
    'Average Price': ['averagePrice', 'avgPrice', 'averageSalePrice', 'averageListPrice', 'avgSalePrice'],
    'Brokerage Address': ['brokerageAddress', 'businessAddress', 'officeAddress', 'address'],
    'Brokerage Phone': ['brokeragePhoneNumber', 'brokeragePhone', 'officePhone'],
    'Website URL': ['websiteUrl', 'website', 'personalWebsite', 'agentWebsite'],
    // License fields are handled by harvestLicense() (the flat map grabbed the
    // wrong brokerage license), so they are intentionally omitted here.
    'Rental Listings Count': ['rentalListingsCount', 'forRentListingCount', 'rentalListings'],
    'Premier Agent': ['isPremierAgent', 'premierAgent', 'isZillowPremierAgent', 'premierAgentStatus', 'isPaidAgent'],
    Specialties: ['specialties', 'specialtiesText', 'focusAreas'],
    'Service Areas': ['serviceAreas', 'servicedAreas', 'areasServed', 'serviceArea', 'servingAreas'],
    Brokerage: ['brokerageName', 'businessName'],
    Name: ['fullName', 'displayName', 'name'],
};

/** Coerce arrays / booleans / numbers to a clean output string. */
function toStr(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        return value
            .map((v) => (typeof v === 'object' && v ? (v.name || v.label || v.value || '') : v))
            .filter((v) => v !== '' && v !== null && v !== undefined)
            .join(', ');
    }
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') {
        // Direct label-ish props first.
        if (value.name || value.label || value.value) return value.name || value.label || value.value;
        // Structured address object → "line1 #unit, City, ST ZIP".
        const line = value.line1 || value.streetLine || value.street || value.address1 || value.addressLine1 || '';
        const unit = value.unit || value.line2 || value.address2 || '';
        const city = value.city || value.locality || '';
        const state = value.state || value.stateCode || value.region || '';
        const zip = value.zip || value.zipcode || value.postalCode || value.zipCode || '';
        const street = [line, unit].filter(Boolean).join(' #').replace(/ #$/, '');
        const cityState = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        const full = [street, cityState].filter(Boolean).join(', ');
        return full.trim();
    }
    return String(value).trim();
}

/**
 * Recursively walk an arbitrary object collecting the first non-empty value for
 * each candidate key. Returns a flat { keyName: value } map of best matches.
 */
function harvestKeys(root, wantedKeys) {
    const result = {};
    const seen = new Set();
    const stack = [root];
    let guard = 0;

    while (stack.length && guard < 200000) {
        guard += 1;
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);

        for (const [key, val] of Object.entries(node)) {
            if (wantedKeys.has(key) && result[key] === undefined) {
                if (val !== null && val !== undefined && val !== '' && typeof val !== 'object') {
                    result[key] = val;
                } else if (Array.isArray(val) && val.length) {
                    result[key] = val;
                } else if (val && typeof val === 'object'
                    && (val.name || val.value || val.label
                        || val.line1 || val.streetLine || val.street || val.city)) {
                    result[key] = val;
                }
            }
            if (val && typeof val === 'object') stack.push(val);
        }
    }
    return result;
}

/**
 * Find the agent's real-estate license(s) inside the __NEXT_DATA__ JSON. Zillow
 * renders the "See license information" modal from an array of license objects,
 * each carrying a number, an issuing state, and/or a description. We walk the
 * tree for any object that looks like a license entry and prefer the one with an
 * issuing state (the "Real estate license"). This replaces the brokerage license
 * that the flat key-map used to grab by mistake.
 */
function harvestLicense(root, agent) {
    const numKeys = ['licenseNumber', 'licenseNo', 'number', 'reLicenseNumber'];
    const stateKeys = ['stateAbbreviation', 'issuingState', 'stateName', 'state', 'issuedBy'];
    const descKeys = ['description', 'licenseType', 'type', 'licenseDescription'];

    const stack = [root];
    const seen = new Set();
    const entries = [];
    const dedupe = new Set();
    let guard = 0;

    while (stack.length && guard < 200000) {
        guard += 1;
        const node = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);

        const num = numKeys.map((k) => node[k]).find((v) => v != null && String(v).trim() !== '');
        if (num) {
            const state = stateKeys.map((k) => node[k]).find((v) => v != null && String(v).trim() !== '');
            const desc = descKeys.map((k) => node[k]).find((v) => v != null && String(v).trim() !== '');
            const entry = {
                num: String(num).trim(),
                state: state ? String(state).trim() : '',
                desc: desc ? String(desc).trim() : '',
            };
            const key = `${entry.num}|${entry.state}|${entry.desc}`;
            if (!dedupe.has(key)) { dedupe.add(key); entries.push(entry); }
        }
        for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
    }

    if (!entries.length) return;

    // Primary = first entry that has an issuing state (the real-estate license),
    // else the first one found.
    const primary = entries.find((e) => e.state) || entries[0];
    if (!agent['License Number']) agent['License Number'] = primary.num;
    if (!agent['License State']) agent['License State'] = primary.state;
    if (!agent['License Description']) {
        agent['License Description'] = primary.desc
            || (entries.find((e) => e.desc)?.desc ?? '');
    }

    // All Licenses = every entry, e.g. "000077246 (AL); 3227826 — Florida Real Estate Broker".
    if (!agent['All Licenses']) {
        agent['All Licenses'] = entries
            .map((e) => {
                let s = e.num;
                if (e.state) s += ` (${e.state})`;
                if (e.desc) s += ` - ${e.desc}`;
                return s;
            })
            .join('; ');
    }
}

/**
 * Open the "See license information" modal and scrape every license card.
 * Zillow loads this content on demand (it isn't in the server JSON for many
 * agents), so we click the trigger, read the modal, then close it.
 */
async function extractLicenseFromModal(page, agent, log) {
    try {
        const clicked = await page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('a,button,span,div'));
            const t = els.find((e) => {
                const txt = (e.textContent || '').replace(/\s+/g, ' ').trim();
                return /^see license information$/i.test(txt);
            });
            if (t) { t.click(); return true; }
            return false;
        });
        if (!clicked) return;

        await page.waitForFunction(
            () => /real estate licenses|license information/i.test(document.body.innerText || ''),
            { timeout: 8000 },
        ).catch(() => {});

        const entries = await page.evaluate(() => {
            const txt = document.body.innerText || '';
            const idx = txt.search(/license information/i);
            const region = idx >= 0 ? txt.slice(idx, idx + 3000) : txt;
            const out = [];
            const re = /License\s*#:\s*([A-Za-z0-9-]+)[\s\S]{0,60}?(Issued by|Description):\s*([^\n]+)/gi;
            let m;
            while ((m = re.exec(region))) {
                out.push({ num: m[1].trim(), type: m[2].toLowerCase(), val: m[3].trim() });
            }
            return out;
        });

        // Close the modal so it can't interfere with later DOM reads.
        await page.evaluate(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find((x) => /^close$/i.test((x.textContent || '').trim()));
            if (b) b.click();
        }).catch(() => {});

        if (!entries.length) return;

        const primary = entries.find((e) => e.type === 'issued by') || entries[0];
        if (!agent['License Number']) agent['License Number'] = primary.num;
        if (!agent['License State'] && primary.type === 'issued by') agent['License State'] = primary.val;
        if (!agent['License State']) {
            const st = entries.find((e) => e.type === 'issued by');
            if (st) agent['License State'] = st.val;
        }
        if (!agent['License Description']) {
            // Team modals also list member names under "Description"; only keep a
            // value that reads like an actual license description.
            const DESC_OK = /real estate|broker|salesperson|sales agent|realtor|appraiser|managing|associate broker/i;
            const d = entries.find((e) => e.type === 'description' && DESC_OK.test(e.val));
            if (d) agent['License Description'] = d.val;
        }
        if (!agent['All Licenses']) {
            agent['All Licenses'] = entries
                .map((e) => (e.type === 'issued by' ? `${e.num} (${e.val})` : `${e.num} - ${e.val}`))
                .join('; ');
        }
        if (log) log.debug?.(`License modal: ${entries.length} entr(y/ies).`);
    } catch (err) {
        if (log) log.debug?.(`License modal failed: ${err.message}`);
    }
}

/** Method A: pull fields out of the page's __NEXT_DATA__ JSON. */
async function extractFromNextData(page, agent, log) {
    let json;
    try {
        const raw = await page.$eval('script#__NEXT_DATA__', (el) => el.textContent);
        if (!raw) return;
        json = JSON.parse(raw);
    } catch {
        return; // no __NEXT_DATA__ or unparsable — fall through to DOM method
    }

    // Build the set of all candidate source keys.
    const wanted = new Set();
    for (const keys of Object.values(NEXT_DATA_FIELD_MAP)) keys.forEach((k) => wanted.add(k));

    const harvested = harvestKeys(json, wanted);

    // Licenses come from a dedicated walk (number + issuing state + description).
    harvestLicense(json, agent);

    for (const [col, keys] of Object.entries(NEXT_DATA_FIELD_MAP)) {
        if (agent[col]) continue; // never overwrite Step 1 data
        for (const key of keys) {
            if (harvested[key] !== undefined) {
                const str = toStr(harvested[key]);
                if (str) {
                    agent[col] = str;
                    break;
                }
            }
        }
    }

    if (log) log.debug?.('Applied __NEXT_DATA__ enrichment.');
}

/** Method B: scrape the rendered DOM for contact + social fields. */
async function extractFromDom(page, agent) {
    const data = await page.evaluate(() => {
        const out = {
            phone: '',
            email: '',
            website: '',
            socials: [],
            license: '',
            years: '',
            name: '',
            premier: false,
            topAgent: false,
            teamMemberCount: '',
            avgPrice: '',
            serviceAreas: '',
            forSale: '',
            forRent: '',
            sold: '',
            bodyText: '',
        };

        const tel = document.querySelector('a[href^="tel:"]');
        if (tel) out.phone = (tel.getAttribute('href') || '').replace(/^tel:/, '').trim();

        const mail = document.querySelector('a[href^="mailto:"]');
        if (mail) out.email = (mail.getAttribute('href') || '').replace(/^mailto:/, '').trim();

        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            if (/facebook\.com|linkedin\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|pinterest\.com/i.test(href)) {
                // Skip Zillow's own corporate social links that appear in the
                // page header/footer (e.g. instagram.com/zillow, facebook.com/Zillow).
                if (!/[/@]zillow\b/i.test(href)) {
                    out.socials.push(href);
                }
            }
            const text = (a.textContent || '').toLowerCase();
            if (!out.website && /website/.test(text) && /^https?:\/\//i.test(href)
                && !/zillow\.com/i.test(href)) {
                out.website = href;
            }
        }

        const body = document.body ? document.body.innerText : '';
        out.bodyText = body;

        // Agent name — used as a fallback for direct profile-URL scrapes (no
        // search data). The profile's main heading holds the name.
        const h1 = document.querySelector('h1');
        if (h1) out.name = (h1.textContent || '').replace(/\s+/g, ' ').trim();

        // Average price — "$576K average price".
        const avgMatch = body.match(/\$[\d.,]+\s*[KkMmBb]?\s+average\s+price/i);
        if (avgMatch) out.avgPrice = avgMatch[0].replace(/\s*average\s+price/i, '').replace(/\s+/g, '').trim();

        // Listing tab counts — the agent's listings section has tabs like
        // "For sale (3)", "For rent 1", "Sold 60", "All 64". Read each count from
        // the tab/link/button labels (preferred) and fall back to body text.
        const labelNodes = Array.from(document.querySelectorAll('a,button,[role="tab"],li,span,div'));
        const grab = (re) => {
            for (const el of labelNodes) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                // Keep it tight: the label must START with the tab word.
                const m = t.match(re);
                if (m) return m[1].replace(/,/g, '');
            }
            return '';
        };
        out.forSale = grab(/^for sale\s*\(?\s*(\d[\d,]*)\s*\)?$/i) || (body.match(/For sale\s*\(?\s*(\d[\d,]*)/i)?.[1] || '').replace(/,/g, '');
        out.forRent = grab(/^for rent\s*\(?\s*(\d[\d,]*)\s*\)?$/i) || (body.match(/For rent\s*\(?\s*(\d[\d,]*)/i)?.[1] || '').replace(/,/g, '');
        out.sold = grab(/^sold\s*\(?\s*(\d[\d,]*)\s*\)?$/i) || (body.match(/\bSold\s*\(\s*(\d[\d,]*)\s*\)/i)?.[1] || '').replace(/,/g, '');

        // Service areas — find the "Service areas (N)" heading and collect the
        // "City, ST" / "County, ST" items that follow it until the next section.
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span'));
        const head = headings.find((el) => /^\s*service areas\b/i.test(el.textContent || ''));
        if (head) {
            let container = head.parentElement;
            // Climb to a parent that actually holds the list of areas.
            for (let i = 0; i < 3 && container && container.parentElement; i += 1) {
                if (/, [A-Z]{2}\b/.test(container.innerText || '')) break;
                container = container.parentElement;
            }
            const text = (container && container.innerText) || '';
            const areas = (text.match(/[A-Za-z][A-Za-z .'-]+,\s*[A-Z]{2}\b/g) || [])
                .map((s) => s.replace(/\s+/g, ' ').trim());
            const unique = [...new Set(areas)];
            if (unique.length) out.serviceAreas = unique.join('; ');
        }

        // NOTE: License number is intentionally NOT scraped from body text — Zillow
        // renders its own brokerage license in the page chrome, which produced the
        // same wrong number on every agent. License now comes only from per-agent
        // __NEXT_DATA__ (left empty when Zillow doesn't expose it).

        const yrMatch = body.match(/(\d+)\s+years?\s+(?:of\s+)?experience/i);
        if (yrMatch) out.years = yrMatch[1];

        // Premier / Top Agent badges aren't plain text or image alts — Zillow
        // renders each with an explainer link that only appears WHEN the agent
        // holds the badge:
        //   Top Agent     -> a "What is Top Agent?" link
        //   Premier Agent -> a 'More about "Zillow Premier Agent"' link
        // Detect those phrases (badge-specific, absent on non-badged profiles).
        const bodyTxt = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
        // Premier's tooltip is hidden (hover-only) so innerText skips it — use
        // textContent. The full 'More about "Zillow Premier Agent"' phrase is
        // badge-specific (the footer program link says only "Zillow Premier Agent").
        const bodyAll = (document.body ? document.body.textContent : '').replace(/\s+/g, ' ');
        out.topAgent = /what is top agent/i.test(bodyTxt);
        out.premier = /more about .{0,4}zillow premier agent/i.test(bodyAll);

        // Team member count — the "Meet <team>" section shows a "<N> members"
        // label (the source of truth, since members can span multiple pages).
        // Fall back to counting member profile links if the label is absent.
        const meetHead = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
            .find((el) => /^\s*meet\b/i.test(el.textContent || ''));
        if (meetHead) {
            let container = meetHead.parentElement;
            for (let i = 0; i < 4 && container && container.parentElement; i += 1) {
                if (/\b\d+\s+members?\b/i.test(container.innerText || '')
                    || container.querySelector('a[href*="/profile/"]')) break;
                container = container.parentElement;
            }
            if (container) {
                const label = (container.innerText || '').match(/\b(\d+)\s+members?\b/i);
                if (label) {
                    out.teamMemberCount = label[1];
                } else {
                    const hrefs = new Set(
                        Array.from(container.querySelectorAll('a[href*="/profile/"]'))
                            .map((a) => (a.getAttribute('href') || '').split('?')[0]),
                    );
                    if (hrefs.size) out.teamMemberCount = String(hrefs.size);
                }
            }
        }

        return out;
    });

    if (!agent['Name'] && data.name) agent['Name'] = data.name;
    if (!agent['Phone'] && data.phone) agent['Phone'] = data.phone;
    if (!agent['Email'] && data.email) agent['Email'] = data.email;
    if (!agent['Website URL'] && data.website) agent['Website URL'] = data.website;
    if (!agent['License Number'] && data.license) agent['License Number'] = data.license;
    if (!agent['Years of Experience'] && data.years) agent['Years of Experience'] = data.years;
    if (!agent['Premier Agent'] && data.premier) agent['Premier Agent'] = 'Yes';
    if (!agent['Average Price'] && data.avgPrice) agent['Average Price'] = data.avgPrice;
    if (!agent['Service Areas'] && data.serviceAreas) agent['Service Areas'] = data.serviceAreas;
    if (!agent['For Sale Count'] && data.forSale) agent['For Sale Count'] = data.forSale;
    if (!agent['For Rent Count'] && data.forRent) agent['For Rent Count'] = data.forRent;
    if (!agent['Sold Count'] && data.sold) agent['Sold Count'] = data.sold;
    if (data.premier) agent['Premier Agent'] = 'Yes';
    if (data.topAgent) agent['Top Agent on Zillow'] = 'Yes';
    if (!agent['Team Member Count'] && data.teamMemberCount) agent['Team Member Count'] = data.teamMemberCount;

    // Map social links to their columns (first occurrence per network).
    for (const href of data.socials) {
        for (const { host, col } of SOCIAL_HOSTS) {
            if (href.toLowerCase().includes(host) && !agent[col]) {
                agent[col] = href;
                break;
            }
        }
    }
}

/**
 * Enrich one agent record in place from their already-navigated profile page.
 * Returns the same agent object.
 */
export async function enrichProfilePage({ page, agent, log }) {
    if (await isCaptchaPage(page)) {
        throw new Error('CAPTCHA');
    }

    await extractFromNextData(page, agent, log);
    await extractFromDom(page, agent);
    await extractLicenseFromModal(page, agent, log);

    // --- Derived / cleanup post-processing ---

    // Active Listings Count = For Sale + For Rent (the currently-listed total).
    const forSaleN = parseInt(agent['For Sale Count'], 10);
    const forRentN = parseInt(agent['For Rent Count'], 10);
    if (!Number.isNaN(forSaleN) || !Number.isNaN(forRentN)) {
        agent['Active Listings Count'] = String((forSaleN || 0) + (forRentN || 0));
    }

    // Zip Code — pull from the scraped Address. Prefer the 5 digits that follow
    // the state ("…, AL 36526"); else use the LAST 5-digit group (zips trail the
    // street number, e.g. "26050 Predazzer Lane, Daphne, AL 36526").
    if (!agent['Zip Code'] && agent['Address']) {
        const addr = String(agent['Address']);
        let zip = addr.match(/,\s*[A-Za-z]{2}\.?\s*,?\s*(\d{5})(?:-\d{4})?\b/);
        if (!zip) {
            const all = addr.match(/\b\d{5}\b/g);
            if (all && all.length) zip = [null, all[all.length - 1]];
        }
        if (zip) agent['Zip Code'] = zip[1];
    }

    // Title — only keep values that read like an actual role; otherwise the JSON
    // leaks section headings / marketing blurbs ("This team offers Showcase…").
    const TITLE_OK = /\b(broker|realtor|owner|president|c\.?e\.?o|founder|co-?founder|partner|principal|manager|managing|director|associate|lead|realty|agent|consultant|specialist|advisor)\b/i;
    if (agent['Title'] && !TITLE_OK.test(String(agent['Title']))) agent['Title'] = '';

    // Legal Name — fall back to the display name when Zillow doesn't expose a
    // separate legal/registered name.
    if (!agent['Legal Name'] && agent['Name']) agent['Legal Name'] = agent['Name'];

    // Is Team — confirm from the profile if the search parse didn't flag it
    // (a populated team-member count is a strong signal).
    const members = parseInt(agent['Team Member Count'], 10);
    if (!Number.isNaN(members) && members > 0) agent['Is Team'] = 'Yes';
    if (!agent['Is Team']) agent['Is Team'] = 'No';

    // Team Name — for a team profile the team's name is the agent Name. The
    // search-page parser sets this; direct profile-URL scrapes need it here too.
    if (agent['Is Team'] === 'Yes' && !agent['Team Name'] && agent['Name']) {
        agent['Team Name'] = agent['Name'];
    }

    // Normalize Yes/No fields if still empty (direct profile-URL scrapes skip
    // the search-page parser that would otherwise default these to "No").
    if (!agent['Premier Agent']) agent['Premier Agent'] = 'No';
    if (!agent['Top Agent on Zillow']) agent['Top Agent on Zillow'] = 'No';

    return agent;
}
