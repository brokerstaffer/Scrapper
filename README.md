# Zillow Real Estate Agent Scraper

An [Apify Actor](https://apify.com/actors) that scrapes real estate agent data from Zillow. Give it a **city, neighborhood, or ZIP code** and it returns structured agent records (name, brokerage, rating, sales history, and — optionally — contact details) ready to export as JSON, CSV, or Excel.

---

## What it does

1. **Search results (Step 1, always)** — For each location, it loads Zillow's agent directory pages (`/professionals/real-estate-agent-reviews/{slug}/`), slow-scrolls to force Zillow's virtualized list to render every agent, and parses each agent card into structured fields.
2. **Profile enrichment (Step 2, optional)** — When **Enrich with Profile Data** is ON, it visits each agent's `/profile/{screenName}/` page and pulls phone, email, social links, license number, specialties, and more.

Results are pushed to the Apify Dataset, deduplicated by Zillow profile URL.

---

## Input

See [INPUT_SCHEMA.md](INPUT_SCHEMA.md). Minimum required input:

```json
{ "locations": ["Mead, CO"] }
```

> **Residential proxies are strongly recommended.** Zillow aggressively blocks datacenter IPs with a "Press & Hold" captcha. The default proxy config uses Apify's `RESIDENTIAL` group.

---

## Output fields

### Always available (from search results)

`Name`, `Brokerage`, `Rating`, `Review Count`, `Location`, `City`, `State`, `Zip Code`, `Profile Photo URL`, `Zillow Profile URL`, `Top Agent on Zillow`, `Team Name`, `Average Sales Volume`, `Sales Count Last Year`, `Local Sales Count`

### Added when enrichment is ON (from profile pages)

`Phone`, `Email`, `Total Sales Count`, `Active Listings Count`, `Specialties`, `Years of Experience`, `Languages Spoken`, `Premier Agent`, `Legal Name`, `Title`, `Brokerage Address`, `Brokerage Phone`, `Website URL`, `Facebook URL`, `LinkedIn URL`, `Instagram URL`, `Twitter URL`, `YouTube URL`, `Pinterest URL`, `License Number`, `Rental Listings Count`

Every record carries **all** columns (empty string when not available), so exports line up cleanly.

### Sample CSV row

```csv
Name,Brokerage,Rating,Review Count,Location,City,State,Average Sales Volume,Sales Count Last Year,Local Sales Count,Zillow Profile URL,Top Agent on Zillow,Team Name
Tracy McClung,RE/MAX Nexus,5.0,53,"Mead, CO",Mead,CO,$348K - $874K,6,5,https://www.zillow.com/profile/TracyMcClung/,No,
```

---

## How it handles Zillow's anti-bot defenses

- **Residential proxy pool** with session rotation — blocked sessions are retired and the request retried on a fresh IP (up to 5 retries).
- **Single concurrency** — never opens multiple tabs against Zillow at once.
- **Randomized delays** between pages and profiles (configurable, with jitter).
- **Rotating user agents** + browser fingerprint generation.
- **Captcha detection** — the "Press & Hold" interstitial is detected and the page retried with a new session.

---

## Running locally

```bash
npm install
npx playwright install chromium   # first time only
apify run -p                       # or: npm start
```

Provide input via `storage/key_value_stores/default/INPUT.json` (Apify CLI creates this) or the Apify Console.

Run the parser validation tests (no browser needed):

```bash
npm test
```

---

## Project structure

```
zillow-agent-scraper/
├── .actor/
│   ├── actor.json          # Actor metadata & dataset views
│   └── input_schema.json   # Input form definition
├── src/
│   ├── main.js             # Entry point — orchestration & crawler config
│   ├── routes.js           # SEARCH / PROFILE request handlers
│   ├── search-page.js      # Step 1: scroll + extract + parse search results
│   ├── profile-page.js     # Step 2: profile enrichment (__NEXT_DATA__ + DOM)
│   ├── parser.js           # Validated text-parsing logic
│   └── constants.js        # Columns, user agents, delays, helpers
├── test/
│   └── parser.test.js      # Parser validation against real Zillow samples
├── package.json
├── Dockerfile
├── INPUT_SCHEMA.md
└── README.md
```

---

## Notes & limits

- Zillow caps pagination at **25 pages** per location. For locations with thousands of agents, refine the search (e.g. by ZIP) or use Zillow's filter query params.
- Enrichment is slow by design (one profile page per agent, with delays). Use **Max Profiles to Enrich** to bound cost while testing.
- Field availability on profile pages varies; the enricher fills only empty fields and never overwrites Step 1 data.

*Use responsibly and in accordance with Zillow's Terms of Service and applicable law.*
