---
name: search-console
description: Read Google Search Console performance data — property totals (clicks, impressions, CTR, position), daily time series, and per-query breakdowns — directly from a logged-in Search Console browser tab, without any OAuth credential. Parses the inline AF_initDataCallback data blocks that Search Console embeds in its own HTML, fetched via curlwright in the tab's session context. Includes a verify command that cross-checks parsed totals against the page's rendered scorecards to catch silent breakage from UI changes. Use whenever the user mentions Search Console, GSC, search performance, search queries, clicks, impressions, CTR, or wants to pull search analytics data for a verified property. Activate on "search console", "GSC", "search performance", "search queries", "search clicks", "search impressions", or related Google Search Console workflows.
allowed-tools: bash
command: search-console
script: scripts/search-console.jsh
---

# Google Search Console Skill

A `.jsh` CLI that reads Google Search Console performance data by parsing the
inline data blocks (`AF_initDataCallback`) from the logged-in Search Console
HTML page. No OAuth credential is needed — the request is issued by
`curlwright` inside your logged-in `search.google.com` browser tab.

## Why not the official API?

The official Search Console API (`googleapis.com/webmasters/v3/`) requires an
OAuth token. The Cloud SDK's public desktop client cannot request the
`webmasters.readonly` scope (`restricted_client`), and tab cookies for
`search.google.com` do not authenticate calls to `googleapis.com` (401). So
this skill parses what the browser already sees.

## Prerequisites

An open, signed-in `search.google.com` browser tab (any Search Console page).

## Commands

| Command | What it does |
|---|---|
| `search-console performance` | Property totals + daily time series |
| `search-console queries` | Per-query breakdown, sorted by clicks desc |
| `search-console verify` | Cross-check parsed totals vs. displayed values |

All commands accept `--property <P>` (default: `sc-domain:sliccy.com`),
`--json` for machine-readable output, and `--help`.

### performance

```bash
search-console performance
search-console performance --days 7
search-console performance --property sc-domain:example.com --json
```

Shows property-level totals (clicks, impressions, CTR, average position) from
`ds:9`, plus a daily breakdown. **Totals always come from `ds:9`, never from
summing the query table** — the query table omits anonymised rare queries, so
summing it under-reports by up to 61%.

### queries

```bash
search-console queries
search-console queries --limit 10
search-console queries --limit 20 --json
```

Lists every named query from `ds:16`, sorted by clicks descending. The footer
shows named-query sums and property totals side by side so the anonymised gap
is visible — the difference is queries Search Console suppresses for privacy.

### verify

```bash
search-console verify
```

Asserts that parsed `ds:9` totals (clicks, impressions, CTR, position) match
the values the page itself renders in its scorecards. Exits 0 on match,
non-zero on mismatch with a message naming both numbers. This catches silent
parse breakage if Google reshapes the data blocks.

## Fragility

`ds:` indices and array offsets are undocumented. A UI release can silently
reshape them. The `verify` command exists specifically to catch that. If the
format changes, update the `parseTotalsAndDaily` and `parseQueryTable`
functions in `scripts/search-console.jsh`.

## Data format (verified 2026-09-21)

- **`ds:9`** — totals at `data[1][1][1]` as `[clicks, impressions, ctr, position]`;
  daily rows at `data[1][0]`, each `[epochMs, [clicks, impressions, ctr, position], ...]`.
- **`ds:16`** — query table at `data[1][0]`, each row's container at `row[0]`;
  `container[0][0]` = query string; metric arrays have type id at index `[8]`
  (5=clicks, 6=impressions) with value at `[1]`.
