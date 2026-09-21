---
name: seo
description: SEO measurement and reporting for a site you own. Reads Google Search Console performance data — property totals (clicks, impressions, CTR, average position), daily time series, and per-query breakdowns — from a logged-in Search Console browser tab, without any OAuth credential, by parsing the inline AF_initDataCallback data blocks Search Console embeds in its own HTML and fetching them via curlwright in the tab's session context. Includes a verify command that cross-checks parsed totals against the page's rendered scorecards to catch silent breakage from a UI change. Use whenever the user mentions SEO, search performance, search rankings, keywords a site ranks for, organic traffic, Search Console, GSC, clicks, impressions, CTR, or average position, or wants to pull search analytics for a verified property. Activate on "seo", "search console", "GSC", "search performance", "what do we rank for", "search queries", "organic clicks", "impressions", "average position".
allowed-tools: bash
command: search-console
script: scripts/search-console.jsh
---

# SEO

Measurement side of SEO: what a site actually earns in Google Search. The
`search-console` command reads Google Search Console performance data by parsing
the inline data blocks (`AF_initDataCallback`) out of the logged-in Search
Console HTML page. No OAuth credential is needed — `curlwright` issues the
request inside your logged-in `search.google.com` browser tab.

For changing a site so those numbers improve, see
[Related skills](#related-skills) — the Adobe content-ops skills do the
page-side work, this one tells you whether it moved.

## Why not the official API?

The official Search Console API (`googleapis.com/webmasters/v3/`) requires an
OAuth token, and both credentialed routes are closed:

- The Cloud SDK's public desktop client — the one `gcloud` reuses via
  `oauth-token --intercept` — **cannot request the `webmasters.readonly`
  scope**. The authorize endpoint refuses with `restricted_client`,
  "Unregistered scope(s) in the request", before any consent screen.
- Tab cookies for `search.google.com` **do not authenticate** calls to
  `googleapis.com`: the API returns 401.

A properly scoped OAuth client has to be minted in a project you control, and
OAuth clients are Console-UI-only. Until that exists, this reads what the
browser already sees.

## Prerequisites

An open, signed-in `search.google.com` browser tab (any Search Console page).
If the session has lapsed, commands exit non-zero and say so, rather than
reporting a UI change.

## Commands

| Command | What it does |
|---|---|
| `search-console performance` | Property totals + daily time series |
| `search-console queries` | Per-query breakdown, sorted by clicks desc |
| `search-console verify` | Cross-check parsed totals vs. displayed values |

All commands accept `--property <P>` (default: `sc-domain:sliccy.com`),
`--json` for machine-readable output, and `--help`. A property must be a domain
property (`sc-domain:example.com`) or a URL-prefix property
(`https://example.com/`); anything else is refused before a page is fetched.

### performance

```bash
search-console performance
search-console performance --days 7
search-console performance --property sc-domain:example.com --json
```

Shows property-level totals (clicks, impressions, CTR, average position) from
`ds:9`, plus a daily breakdown. **Totals always come from `ds:9`, never from
summing the query table** — see below.

### queries

```bash
search-console queries
search-console queries --limit 10
search-console queries --limit 20 --json
```

Lists every named query from `ds:16`, sorted by clicks descending, then prints
named-query sums and property totals side by side:

```
  Named queries: 76 clicks, 848 impressions (78 queries)
  Property totals: 196 clicks, 2790 impressions
  Anonymised gap: 120 clicks, 1942 impressions (61% / 70% not attributed)
```

**That gap is the one thing to understand about this data.** Search Console
omits anonymised rare queries from the query table while still counting them in
the property totals. Summing the table gives 76 clicks where the property earned
196, so a tool that summed it and called the result "total clicks" would
under-report by 61%. The gap is printed rather than hidden so nobody assumes the
columns add up.

### verify

```bash
search-console verify
```

Asserts that the parsed `ds:9` totals match the values the page itself renders
in its scorecards. Exits 0 on match, non-zero on mismatch with a message naming
both numbers.

This exists because the failure mode of reading positional arrays is **wrong
numbers, not an error**: a UI release shifts an index and the tool keeps printing
confidently. A missing scorecard counts as a failure too — if the reference
silently disappeared, a check that skipped it would start passing everything,
so it fails closed.

## Fragility

`ds:` indices and array offsets are undocumented, so a UI release can reshape
them silently. `verify` is the tripwire; run it before trusting a number that
matters. Query metrics are read by the type id each metric array carries at
index `[8]`, not by column order, which survives reordering but not renumbering.

If the format changes, the parsing lives in `scripts/gsc-parse.js` — a plain
module with no `sliccy:` or `fs` imports, so the test suite can exercise it.
`scripts/search-console.jsh` holds only tab discovery, fetching and output.

## Tests

`tests/gsc-parse.test.js` (`tst`, 23 tests / 58 assertions) covers the totals
source, metric-by-type-id reading, the anonymised gap, property validation,
sign-in detection and the `verify` comparison. Fixture shapes are copied from a
live report, not invented, and inlined as literals because the test realm cannot
require `fs`.

Every assertion was proven red against a deliberately broken parser — including
a `compareTotalsWithUI` that ignores a missing scorecard (fails open), metrics
read positionally, and the sign-in marker rejected during development.

One noted trap: the real signed-in report page **contains
`accounts.google.com/signin`** in its account-chooser markup, so matching on
that string as a login marker refuses every valid page. A test pins that.

## Data format (verified 2026-09-21)

- **`ds:9`** — totals at `data[1][1][1]`, as the 4-tuple
  `[clicks, impressions, ctr, position]`. Daily rows at `data[1][0]`, each
  `[epochMs, <that same 4-tuple>, ...]`; days with no data carry `"NaN"` strings
  and read as zero.
- **`ds:16`** — query table at `data[1][0]`, each row's container at `row[0]`;
  `container[0][0]` = query string; metric arrays carry a type id at index `[8]`
  (5=clicks, 6=impressions, 7=CTR, 8=position). Counts sit at `[1]`; the two
  ratios sit in a trailing slot, so the last non-null is taken.

## Related skills

This skill measures. The page-side work lives in Adobe's
[Edge Delivery Services content-ops plugin](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills),
which needs no credentials — it reads the published site. Install one with:

```bash
upskill adobe/skills --path plugins/aem/edge-delivery-services-content-ops --skill sitemap-audit
```

Closest companions to a Search Console finding:

| Adobe skill | Use it when Search Console shows |
|---|---|
| [`sitemap-audit`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/sitemap-audit) | Pages you expect to rank are missing from impressions — validates `sitemap.xml` against the query index |
| [`heading-optimizer`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/heading-optimizer) | Impressions without clicks — audits headings against search intent and hierarchy |
| [`internal-linking`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/internal-linking) | A page ranks far below the rest of the site — builds a link graph and finds orphans |
| [`structured-data`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/structured-data) | No rich results for pages that qualify — generates JSON-LD |
| [`image-seo`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/image-seo) | Little or no image-search traffic — checks alt text and image performance |
| [`link-rot-scanner`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/link-rot-scanner) | Position decay across a section — validates internal and external links |
| [`content-audit`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/content-audit) | A specific page underperforms — per-page content, SEO, accessibility and performance review |
| [`geo-rewrite`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/geo-rewrite) | You care about AI-assistant answers, which Search Console does not report — rewrites for generative engines |
| [`cwv-optimizer`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/cwv-optimizer) | Ranking loss with healthy content — diagnoses Core Web Vitals |
| [`bulk-metadata`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/bulk-metadata) | Titles or descriptions wrong across many pages — audits and updates metadata in bulk |
| [`product-page-seo`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/product-page-seo) | Commerce product pages missing from search |
| [`content-diff`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/content-diff) | Traffic changed after a publish — diffs preview against live |
| [`accessibility-fix`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/accessibility-fix) | WCAG 2.1 AA violations, which overlap heavily with crawlability |

Those are markdown skills for an agent to follow, not CLIs, and they target AEM
Edge Delivery sites specifically. In this repo, [`search`](../search/SKILL.md)
covers open-web queries and [`gcloud`](../gcloud/SKILL.md) is the reference for
the `oauth-token --intercept` pattern this skill had to work around.
