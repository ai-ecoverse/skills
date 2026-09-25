---
name: seo
description: SEO measurement and reporting for a site you own. Reads Google Search Console performance data — property totals (clicks, impressions, CTR, average position), daily time series, per-query and per-page breakdowns, including which URL earns a given query's impressions — from a logged-in Search Console browser tab, with no OAuth credential. Includes a verify command that cross-checks the parsed numbers against what the page itself displays, to catch silent breakage from a UI change. Use whenever the user mentions SEO, search performance, search rankings, keywords a site ranks for, which page ranks for a term, landing pages, organic traffic, Search Console, GSC, clicks, impressions, CTR, or average position, or wants to pull search analytics for a verified property. Activate on "seo", "search console", "GSC", "search performance", "what do we rank for", "top pages", "landing pages", "which url earns a query", "search queries", "organic clicks", "impressions", "average position".
allowed-tools: bash
command: search-console
script: scripts/search-console.jsh
---

# SEO

Measurement side of SEO: what a site actually earns in Google Search. Requires an
open, signed-in `search.google.com` tab — no OAuth credential, because the Cloud
SDK's public client cannot request the Search Console scope and tab cookies do
not authenticate `googleapis.com`. See
[references/data-format.md](references/data-format.md) for that dead end in full.

To change a site so the numbers move, see [Related skills](#related-skills).

## Commands

| Command | What it does |
|---|---|
| `search-console performance` | Property totals + daily time series |
| `search-console queries` | Per-query breakdown, sorted by clicks desc |
| `search-console pages` | Per-page breakdown; `--query` narrows it to one exact query |
| `search-console verify` | Cross-check parsed totals against displayed values |

All accept `--property <P>` (default `sc-domain:sliccy.com`), `--json` and
`--help`. A property must be a domain property (`sc-domain:example.com`) or a
URL-prefix property (`https://example.com/`); anything else is refused before a
page is fetched.

```bash
search-console performance
search-console performance --days 7
search-console queries --limit 20 --json
search-console pages --limit 10
search-console pages --query slicc       # which URL earns that query
search-console verify
search-console queries --property sc-domain:example.com
```

## `pages --query` answers "which URL ranks for this term"

`queries` says the property earned 380 impressions for `slicc`; only `pages`
says where they landed.

```
  Page                                               Clicks   Impressions      CTR   Position
  https://www.sliccy.com/                                 3           380     0.8%        5.3
  https://www.sliccy.com/automate-website-migration       0             1     0.0%        2.0
```

The match is **exact**, so `--query slicc` excludes `sliccy` and `slicc ai`
(measured: the "contains" form would return 4 pages and 527 impressions instead
of 2 and 380). Search Console must echo the filter back in the response or the
command exits non-zero: an unrecognised filter parameter returns the
**unfiltered** report with HTTP 200, which would silently answer a different
question.

## Read the gap, not just the table

Neither table adds up to the property totals, and each misses in a different
direction, so both print the difference instead of implying a sum.

`queries` under-reports, because Search Console omits anonymised rare queries
from the table while still counting them in the totals:

```
  Named queries: 76 clicks, 848 impressions (78 queries)
  Property totals: 196 clicks, 2790 impressions
  Anonymised gap: 120 clicks, 1942 impressions (61% / 70% not attributed)
```

`pages` over-reports — measured 3569 impressions across 8 pages against 2778 for
the property, 28% more than the property earned. Page rows count per page, the
totals per search, so one result page listing two of your URLs counts twice in
the table and once in the totals. Totals always come from `ds:9`; never sum
either table and call it a total.

If the queries footer says `Unattributed gap` instead, the table was probably
capped and part of the remainder is ordinary queries it did not return — not
anonymisation.

## Run `verify` before trusting a number that matters

```bash
search-console verify   # exit 0 = parsed totals match the rendered scorecards
```

The data is read from positional, undocumented array offsets, so a UI release
breaks it by producing **wrong numbers rather than an error**. `verify` compares
the parsed totals against the scorecards the page displays, and treats a missing
scorecard as a failure too, so it cannot pass vacuously once the page changes.

If a command fails, the message names the likely cause: an expired session, a
property the signed-in account cannot see, a tab on a different Google account,
or a genuine reshape. All of those arrive as HTTP 200, so each is checked
explicitly — details and the measurements behind them in
[references/data-format.md](references/data-format.md).

## Layout

- `scripts/search-console.jsh` — tab discovery, fetching, output.
- `scripts/gsc-parse.js` — all parsing, validation and the cross-check, free of
  `sliccy:`/`fs` imports so the suite can import it.
- `tests/gsc-parse.test.js` — `tst`, 48 tests / 128 assertions. Fixture shapes are
  copied from a live report, not invented, and every assertion was proven red
  against a deliberately broken parser.
- `references/data-format.md` — block layout, dimension and metric type ids, the
  filter echo, and the three HTTP-200 failure modes.

## Related skills

This skill measures. The page-side work lives in Adobe's
[Edge Delivery Services content-ops plugin](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills),
which needs no credentials — it reads the published site. Install one with:

```bash
upskill adobe/skills --path plugins/aem/edge-delivery-services-content-ops --skill sitemap-audit
```

| Adobe skill | Use it when Search Console shows |
|---|---|
| [`sitemap-audit`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/sitemap-audit) | Pages you expect to rank are missing from `pages` |
| [`heading-optimizer`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/heading-optimizer) | Impressions without clicks |
| [`internal-linking`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/internal-linking) | A page ranking far below the rest of the site |
| [`structured-data`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/structured-data) | No rich results for pages that qualify |
| [`image-seo`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/image-seo) | Little or no image-search traffic |
| [`link-rot-scanner`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/link-rot-scanner) | Position decay across a section |
| [`content-audit`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/content-audit) | One page underperforming |
| [`geo-rewrite`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/geo-rewrite) | Nothing — AI-assistant answers are not reported here at all |
| [`cwv-optimizer`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/cwv-optimizer) | Ranking loss with healthy content |
| [`bulk-metadata`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/bulk-metadata) | Titles or descriptions wrong across many pages |
| [`product-page-seo`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/product-page-seo) | Commerce product pages missing from search |
| [`content-diff`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/content-diff) | Traffic changing after a publish |
| [`accessibility-fix`](https://github.com/adobe/skills/tree/main/plugins/aem/edge-delivery-services-content-ops/skills/accessibility-fix) | WCAG violations, which overlap heavily with crawlability |

Those are markdown skills for an agent to follow, not CLIs, and they target AEM
Edge Delivery sites. In this repo,
[`search`](https://github.com/ai-ecoverse/skills/tree/main/skills/search) covers
open-web queries and
[`gcloud`](https://github.com/ai-ecoverse/skills/tree/main/skills/gcloud) is the
reference for the `oauth-token --intercept` pattern this skill had to work
around.
