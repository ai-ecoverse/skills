# Zone analytics: sampling, plan limits and the spike workflow

Detail moved out of `SKILL.md`. Applies to the `wrangler` binary only; billing
lives in `wrangler-ext` (see [BILLING.md](BILLING.md)).

## Architecture

- **Endpoint**: `POST /api/v4/graphql` on `dash.cloudflare.com`, same-origin
  `fetch` with `credentials: 'include'`.
- **Transport**: the `sliccy:browser` page-context bridge against the dashboard
  tab, which serializes the GraphQL response back to the script.
- **Auth model**: none of our own — we ride the dashboard cookies.
- **Zone cache**: resolved zones are cached in `~/.config/wrangler/zones.json`
  (mode 600) so a zone name does not cost a lookup every run. `wrangler-ext`
  caches the billing account id beside it as `billing-account.json`.
- **GraphQL queries are built with single-quoted concatenation, never template
  literals**, so the raw `$variables` survive into the query string.

## Sampling

`httpRequestsAdaptiveGroups` — the source for `top-paths`, `top-uas` and
`top-countries` — returns a **sampled** view. Counts are proportional, not
absolute. For absolute hourly totals use `timeseries`, which reads
`httpRequests1hGroups` and is unsampled.

`top-uas` and `top-countries` deliberately over-fetch (`limit × 20`, minimum 200
rows) and aggregate client-side, because the API orders by row count rather than
by the dimension you asked to rank.

## Investigating a traffic spike

Combining both sources is the right move:

1. **`timeseries`** to confirm the spike is real and locate the start hour
   (unsampled, so the shape is trustworthy).
2. **`statuscodes`** to see whether it is real users (mostly 200) or a scan
   (mostly 404 / 301).
3. **`top-paths`** and **`top-uas`** in a *narrow* window around the spike to
   identify the actor and its intent. Narrow matters: sampling means a wide
   window dilutes the very rows you are hunting.

## Free-plan limits

- **`httpRequests1hGroups` is capped at a 3-day window** on free zones; wider
  ranges return a `quota` error. The CLI auto-clamps.
- **`clientRefererHost` is gated to paid plans.** This skill avoids it by
  default, so referrer breakdowns are unavailable on free zones. If you need
  them, mint a paid token and call the REST API directly.
- **Bot-management dimensions** (`botManagementVerifiedBot`, `clientIPClass`) may
  be missing on free plans; the CLI degrades gracefully rather than failing.
- `--hours` is clamped to 1-72 regardless of plan.

## Command reference (`wrangler`)

| Command | Purpose |
|---|---|
| `open` | Open or focus the Cloudflare dashboard tab; prints the target id |
| `zones` | List zones reachable by the current session (cached to `zones.json`) |
| `status <zone>` | One page: total requests, status mix, top countries, top paths |
| `timeseries <zone>` | Hourly requests / pageViews / uniques / threats — **unsampled** |
| `statuscodes <zone>` | Hourly breakdown by `edgeResponseStatus` |
| `top-paths <zone>` | Most-requested URL paths (sampled) |
| `top-uas <zone>` | Most-common user agents (sampled, aggregated client-side) |
| `top-countries <zone>` | Top source countries by request count (sampled) |
| `query --zone=<z>` | Arbitrary GraphQL, from `--file=path` or stdin |
