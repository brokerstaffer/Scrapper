# Agent Search webapp (Zillow + Courted)

A local web UI: type locations or ZIPs, pick sources, and watch agent data stream
in live from **Zillow** and **Courted** side by side. Export each source to CSV.

- **Courted** → reads the app's authenticated data API (fast, seconds).
- **Zillow** → drives Playwright with your residential proxy (slower, minutes).

## Setup

```bash
# from the project root (/Users/vicky/Downloads/ZILLOW)
npm install express          # one-time (other deps already present)
cp web/.env.example web/.env # then edit web/.env
```

Edit `web/.env`:

```
COURTED_EMAIL=you@example.com
COURTED_PASSWORD=secret
ZILLOW_PROXY_URL=http://user:pass@proxy-host:port   # your residential proxy
PORT=3000
```

> **VPN:** Courted access is behind your Vinify VPN — keep the VPN connected while
> running. Zillow uses the residential proxy from `ZILLOW_PROXY_URL`.

## Run

```bash
node web/server/index.js
# open http://localhost:3000
```

The startup log shows whether Courted creds and the Zillow proxy are detected.

## Using it

1. Enter one or more locations (one per line, or comma/semicolon separated):
   `Miami, FL` · `Boca Raton, FL` · `33139`
2. Tick **Courted** and/or **Zillow**.
3. (Optional) open **Options** to set max results, min sales volume, enrichment.
4. **Search** — Courted rows appear in seconds; Zillow fills in as it scrapes.
5. **Export CSV** per panel (full field set, not just the visible columns).

## How it streams

`POST /api/search` starts a job and launches the engines; the browser subscribes
to `GET /api/search/:id/stream` (Server-Sent Events) and receives `record` /
`progress` / `source_done` / `complete` events. Late connects replay from the
start, so nothing is missed. `GET /api/search/:id/export?source=courted|zillow`
returns that source's CSV.

## Layout

```
web/
  server/
    index.js            Express app, SSE, CSV export, .env loader
    jobs.js             in-memory job registry + SSE pub/sub
    engines/
      courted.js        wraps courted/src/scraper.js
      zillow.js         raw-Playwright runner reusing src/ modules + proxy
  public/
    index.html app.js styles.css
  .env(.example)
```

The engines reuse the existing scrapers — `courted/src/*` and the Zillow `src/*`
parsing modules — so the actors and this webapp stay in sync.

## Hosting later

It's built local-first but deploy-ready: the server is a standard Express app and
all secrets come from env vars. To host, run it on a machine/container that has
your VPN (for Courted) and set the same env vars. No code changes needed.
```
