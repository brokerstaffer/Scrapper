# Courted Agent Scraper

Scrapes real-estate agent production data from **Courted** (courted.io) by city,
ZIP, or across all agents.

## How it works (and why it's not the CSV export)

Courted has no public API. This scraper:

1. **Signs in** with your Courted credentials through AWS Cognito (the same auth
   the website uses) — pure HTTP, no browser.
2. **Reads the exact JSON endpoint the agent table is built from**
   (`api.courted.io/api/mls/broker/agent_search/`), paging through results with
   `limit`/`offset`.

It does **not** touch the "Export to CSV" button. It reads the same live data the
UI renders — just directly and at scale.

Each agent record exposes **~70 fields** (far more than the table's visible
columns): contact info, office, full LTM/YTD production, buy/list-side splits,
GCI, predictions, likelihood-to-move, license, tenure, most-transacted area, and
(with enrichment) mobile phone, office street address, role/team flags, AI agent
type, and forecast segment.

## Run locally (no Apify)

```bash
cd courted
COURTED_EMAIL='you@example.com' COURTED_PASSWORD='secret' \
  node run-local.mjs --locations "Miami, FL;Boca Raton, FL" --max 200
```

Writes `output/courted-agents.json` and `output/courted-agents.csv`.

**Flags**

| Flag | Meaning | Default |
|------|---------|---------|
| `--locations "A;B"` | semicolon-separated cities (`City, ST`) or ZIPs | (all agents) |
| `--max N` | total record cap (`0` = unlimited) | `100` |
| `--per N` | cap per location | `0` |
| `--min-volume N` | skip agents under N LTM sales volume | `0` |
| `--order FIELD` | sort field (e.g. `ltm_sales_volume`, `agent_tenure`) | `ltm_sales_volume` |
| `--asc` | ascending order | desc |
| `--enrich` | fetch each agent's detail record (slower, richer) | off |
| `--all-statuses` | send no status filter | off |
| `--out DIR` | output directory | `output` |

## Run on Apify

Push as an actor and provide input (see `.actor/input_schema.json`):

```json
{
  "email": "you@example.com",
  "password": "secret",
  "locations": ["Miami, FL", "33139"],
  "orderBy": "ltm_sales_volume",
  "maxRecords": 500,
  "enrichProfiles": true
}
```

Leave `locations` empty to sweep all 196k+ agents.

## Notes

- **VPN:** the scraper uses whatever network the host machine has. If your Courted
  access is gated behind a VPN, run it on a machine connected to that VPN.
- **Auth:** tokens last ~1 hour and auto-refresh mid-run, so long sweeps don't
  drop.
- **Location matching:** `"Miami, FL"` → city scope; `"33139"` → ZIP scope. One
  search is issued per location and results are de-duplicated by agent ID.
- **Advanced filters:** copy any filter's query params from the Courted UI network
  tab into `extraParams` to pass them straight through.

## Files

```
src/auth.js      Cognito sign-in + token refresh
src/api.js       agent_search query builder + paged fetch + detail fetch
src/mapper.js    raw record -> output columns
src/scraper.js   orchestration (login, paginate, dedupe, enrich)
src/constants.js output schema + formatters
src/main.js      Apify actor entry point
run-local.mjs    standalone CLI (JSON + CSV output)
```
