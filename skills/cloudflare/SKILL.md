---
name: cloudflare
description: >-
  Query Cloudflare zone analytics (HTTP request counts, status codes, top
  paths, user agents, countries, threats) via the Cloudflare dashboard's
  GraphQL Analytics API. Piggybacks on an open `dash.cloudflare.com` tab —
  no API token, no `wrangler login`. Use when investigating traffic spikes,
  bot scans, error rate changes, or referrer breakdowns for a zone you
  manage. Triggers on "cloudflare traffic", "why did traffic spike", "404
  rate", "bot scan", "top paths on <domain>".
allowed-tools: bash
---

# Cloudflare — zone analytics via the dashboard

CLI tool for querying Cloudflare's GraphQL Analytics API for a zone you own.
Uses the active `dash.cloudflare.com` browser tab to issue same-origin
`fetch` calls, so it inherits the user's logged-in session — **no
`CLOUDFLARE_API_TOKEN` required**.

## Prerequisites

1. A Cloudflare dashboard tab must be open and authenticated. Either:
   - Visit `https://dash.cloudflare.com` in any tab, **or**
   - Run `wrangler open` and complete the login if prompted.
2. The signed-in user must have access to the zone you query.

## Quick start

```bash
# List zones the current dash session can see
wrangler zones

# Quick traffic snapshot for the last N hours (default: 3h)
wrangler status sliccy.com
wrangler status sliccy.com --hours=24

# Hourly time-series of requests / pageViews / uniques / threats
wrangler timeseries sliccy.com --hours=72

# Status-code breakdown per hour (great for spotting 404 storms)
wrangler statuscodes sliccy.com --hours=24

# Top URL paths in a window, sorted by sampled request count
wrangler top-paths sliccy.com --hours=6 --limit=30

# Top user agents in a window
wrangler top-uas sliccy.com --hours=6 --limit=20

# Top countries in a window
wrangler top-countries sliccy.com --hours=24

# Free-form GraphQL — useful for one-off queries
wrangler query --zone=sliccy.com --file=/tmp/q.graphql
echo '{ viewer { zones { httpRequests1hGroups(limit:1, filter:{...}){ count } } } }' | wrangler query --zone=sliccy.com
```

## Available commands

| Command | Purpose |
|---|---|
| `open` | Open or focus the Cloudflare dashboard tab |
| `zones` | List zones reachable by the current session |
| `status <zone>` | One-page summary: total requests, status mix, top countries, top paths |
| `timeseries <zone>` | Hourly requests / pageViews / uniques / threats |
| `statuscodes <zone>` | Hourly breakdown by `edgeResponseStatus` |
| `top-paths <zone>` | Most-requested URL paths (sampled) |
| `top-uas <zone>` | Most-common user agents (sampled) |
| `top-countries <zone>` | Top source countries by request count |
| `query` | Execute an arbitrary GraphQL query |

## Common flags

| Flag | Meaning | Default |
|---|---|---|
| `--hours=N` | Window size in hours, ending now | `3` |
| `--limit=N` | Max rows returned for `top-*` | `25` |
| `--zone=<name|id>` | Zone for `query`. Accepts zone name or 32-char zone ID | (required) |
| `--tab=<targetId>` | Override dashboard tab. Default: auto-pick `dash.cloudflare.com` |
| `--json` | Emit raw JSON instead of formatted output | off |

## Architecture

- **Endpoint**: `POST /api/v4/graphql` on `dash.cloudflare.com`, same-origin
  `fetch` with `credentials: 'include'`.
- **Transport**: A Playwright `eval-file` against the Cloudflare tab, which
  serializes the GraphQL response and saves it to a temp file the shell
  script then parses.
- **Auth model**: None of our own — we ride the dashboard cookies.
- **Plan limits**: Free zones cap `httpRequests1hGroups` queries at 3 days
  and reject some dimensions (`clientRefererHost`, `botManagementVerifiedBot`).
  The CLI auto-clamps the window to 3 days for free zones and sticks to
  free-tier-allowed dimensions.

## Sampling

`httpRequestsAdaptiveGroups` (used by `top-paths` / `top-uas`) returns a
**sampled** view. Counts are not absolute — they are proportional. For absolute
hourly totals use `timeseries` (`httpRequests1hGroups`), which is unsampled.

Combining both is the right move for incident investigation:

1. `timeseries` to confirm a spike exists and locate the start hour.
2. `statuscodes` to see whether it's real users (mostly 200) or a scan (mostly
   404 / 301).
3. `top-paths` and `top-uas` in a narrow window around the spike to identify
   the actor and intent.

## Known limitations

- **Free plan only exposes a 3-day window** for `httpRequests1hGroups`. Wider
  ranges return a `quota` error.
- **`clientRefererHost` is gated to paid plans.** This skill avoids it by default.
- **Bot-management dimensions** (`botManagementVerifiedBot`, `clientIPClass`)
  may not be available on free plans; the CLI degrades gracefully.
- **Same-origin only.** If `dash.cloudflare.com` is not open and authenticated,
  every command fails. Run `wrangler open` first.

## Don't

- Don't try to use `CLOUDFLARE_API_TOKEN` env vars — this skill ignores them.
  Tokens with `Zone:Analytics:Read` are a fine alternative path but a separate tool.
- Don't expect referrer data on free zones; if you need it, mint a paid token
  and use the Cloudflare REST API directly.
- Don't query windows wider than 3 days on free zones — the API rejects it.
