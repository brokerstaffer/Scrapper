# Input Fields

The actor is configured through the Apify Console form (or the API `input` object).

| Field | Key | Type | Default | Description |
|-------|-----|------|---------|-------------|
| **Locations** | `locations` | array of strings | `["Mead, CO"]` | **Required.** Cities, neighborhoods, or ZIP codes to search. Examples: `Mead, CO`, `Boulder, CO`, `80542`. |
| **Max Pages Per Location** | `maxPages` | integer | `25` | Maximum search-result pages to scrape per location. Zillow caps pagination at 25. Range 1–25. |
| **Enrich with Profile Data** | `enrichProfiles` | boolean | `false` | When ON, the actor visits each agent's profile page to collect phone, email, social links, license, etc. Much slower. |
| **Max Profiles to Enrich** | `maxProfilesPerLocation` | integer | `0` | Cap on profiles enriched per location (only used when enrich is ON). `0` = unlimited. |
| **Proxy Configuration** | `proxy` | object | Apify Residential | Proxy settings. **Residential proxies are strongly recommended** — Zillow blocks datacenter IPs. |
| **Delay Between Pages (s)** | `delayBetweenPages` | integer | `5` | Random delay (± ~2s jitter) between search page loads. Range 2–30. |
| **Delay Between Profiles (s)** | `delayBetweenProfiles` | integer | `4` | Random delay (± ~2s jitter) between profile visits. Range 2–30. |

## Slug rules

- `"Mead, CO"` → `mead-co`
- `"Boulder, CO"` → `boulder-co`
- `"80542"` → `80542` (ZIP codes are used as-is)

## Example input

```json
{
    "locations": ["Mead, CO", "80542"],
    "maxPages": 7,
    "enrichProfiles": true,
    "maxProfilesPerLocation": 50,
    "delayBetweenPages": 6,
    "delayBetweenProfiles": 5,
    "proxy": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```
