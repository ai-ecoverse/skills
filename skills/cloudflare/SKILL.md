---
name: cloudflare
description: >-
  Query Cloudflare zone analytics (HTTP requests, status codes, top paths, user
  agents, countries, threats) AND account billing (invoice history, invoice PDFs,
  per-month/per-year spend, contract numbers, Workers excess-usage overage) from
  an open, logged-in `dash.cloudflare.com` tab — no API token, no `wrangler
  login`. Use when investigating traffic spikes, bot scans or error-rate changes
  for a zone you manage, and when you need a Cloudflare invoice, bill, cost or
  spend total, an invoice PDF, a contract number or excess-usage detail. On a
  shared enterprise account the contract number on each invoice is the only way
  to tell your team's spend from the parent org's. Triggers on "cloudflare
  traffic", "why did traffic spike", "404 rate", "bot scan", "top paths for
  example.com", "cloudflare invoice", "cloudflare bill", "how much are we
  spending on Cloudflare", "Workers overage", "cloudflare contract". Not Fastly,
  not AWS CloudFront, not Akamai — Cloudflare only, and both zone analytics AND
  billing.
allowed-tools: bash
---

# Cloudflare — zone analytics and billing via the dashboard

Two CLIs over the active `dash.cloudflare.com` tab, issuing same-origin `fetch`
calls so they inherit the signed-in session — **no `CLOUDFLARE_API_TOKEN`**:

- **`wrangler`** — zone analytics via the GraphQL Analytics API.
- **`wrangler-ext billing`** — invoices, spend and contracts. The real `wrangler`
  CLI has no billing command group, so SLICC-only billing lives in a sibling
  binary (same convention as `fastly-ext billing` / `gcloud-ext billing cost`).

## Prerequisites

1. A `dash.cloudflare.com` tab open and authenticated — run `wrangler open`.
2. Analytics needs access to the zone; billing needs account billing access.
3. Cloudflare publishes **no** billing API: `/api/v4/user/billing/history` is 403
   even when signed in, and no API-token scope reaches invoices. The dashboard
   session is the only door.

## Quick start — analytics

```bash
wrangler open                                     # open/focus the dashboard tab
wrangler zones                                    # zones this session can see
wrangler status sliccy.com --hours=24             # requests, status mix, countries, paths
wrangler timeseries sliccy.com --hours=72         # hourly requests/pageViews/uniques/threats
wrangler statuscodes sliccy.com --hours=24        # spot a 404 storm
wrangler top-paths sliccy.com --hours=6 --limit=30
wrangler top-uas sliccy.com --hours=6             # also: top-countries
wrangler query --zone=sliccy.com --file=q.graphql # arbitrary GraphQL (stdin works too)
```

Flags: `--hours=N` (1-72, default 3), `--limit=N` (default 25), `--zone=<name|id>`,
`--tab=<targetId>`, `--json`.

`timeseries` and `statuscodes` are **unsampled**; `top-*` reads
`httpRequestsAdaptiveGroups` and is **sampled**, so its counts are proportional,
not absolute. Sampling detail, free-plan limits (3-day window, gated dimensions)
and the spike-investigation workflow: [references/analytics.md](references/analytics.md).

## Quick start — billing

```bash
wrangler-ext billing contracts --year 2026        # ← start here on a shared account
wrangler-ext billing invoices --limit 10          # newest first, with the uuid for `pdf`
wrangler-ext billing summary --year 2026          # per-month + per-year totals, unpaid list
wrangler-ext billing pdf IN706358 --out ./inv.pdf # verifies the %PDF magic bytes
wrangler-ext billing lineitems IN706358           # contract #, order type, service period
wrangler-ext billing usage IN702618               # excess-usage cap vs actual, per metric
wrangler-ext billing subscriptions                # products (price is 0 on enterprise)
```

Flags: `--year YYYY`, `--limit N`, `--pdf-limit N`, `--no-pdf`, `--out PATH`,
`--account <32-hex>`, `--tab <id>`, `--json`, `--fixture <file>` (replay a saved
`billing/history` dump offline). Every command takes either the human `receipt_id`
(`IN706358`) or the 36-char record uuid.

- `invoices` lists **credits separately** — `type: "credit"` amounts are negative,
  so a blind sum nets them against spend (309 invoices + 10 credits on one account).
- `summary` names every invoice not marked paid, with the reason per row.
- `lineitems` / `usage` read the PDF, which is where contract numbers and
  excess-usage caps live; `usage` cross-checks its per-metric costs against the
  API amount and warns if they disagree.

## Contract attribution — read before quoting a spend figure

On a shared enterprise account **one Cloudflare account serves many teams**, and
`billing/history` interleaves the parent org's renewals with yours. Nothing in the
JSON separates them — the **contract number** (`IC-######`) printed on each invoice
PDF is the only reliable discriminator. On one real account 2026 YTD totalled
**$3,146,348.73** while the responsible team's slice was **~$159k-421k**: summing
the account overstates a team's cost by roughly **20x**.

`billing contracts` clusters by recurring amount, merges families sharing a contract
number (keeping components visible, since one contract bills several amounts —
`IC-120694` is $240,300 × 8 plus seven smaller add-ons), infers cadence from invoice
gaps or the PDF service period, and flags invoices with **no** contract number and
an "Excess Usage Billing" description as metered overage on your own usage —
unambiguously yours. Attribute each contract number to its owner before publishing
a total. Worked example: [references/BILLING.md](references/BILLING.md).

## Known limitations

- **Same-origin only.** With no logged-in dash tab every command exits 1 with an
  actionable message. Run `wrangler open`.
- **`per_page` on `billing/history` is silently clamped to 50** — a wide request
  looks successful and truncates history. Paginate on `result_info.next_page`;
  there is no `total_pages`.
- **`status: OPEN` is not "unpaid".** Every record measured had
  `amount_remaining: 0` while 42 invoices sat at `OPEN` — Cloudflare's NetSuite
  feed leaves enterprise invoices open long after settlement. `summary` refuses to
  call the OPEN total a balance due. One real invoice also carries no `amount`
  field at all; it counts as $0.00 and is named, never `NaN`.
- **`subscriptions` reports `price: 0`** with `intent: ENTERPRISE_CONTRACT` for
  every enterprise product — the rate lives in the contract, not the API, so
  invoice PDFs are the only route to real line items.
- **Invoice PDFs use CID-encoded fonts.** `pdftk dump_data_utf8` reads them; if that
  fails the tool offloads to `pdftotext -layout` on an `ssh` follower with poppler,
  else **fails loudly rather than emitting glyph noise as line items**.
- Free zones cap analytics at a 3-day window and gate `clientRefererHost`.

## Don't

- Don't set `CLOUDFLARE_API_TOKEN` and expect billing to work — no scope reaches
  invoices. A `Zone:Analytics:Read` token is fine for analytics, but is a separate tool.
- Don't drop `?doctype=invoice&isLegacy=false` from the PDF URL (400 code 1196), and
  don't pass a `receipt_id` where the record uuid belongs.
- Don't query analytics windows wider than 3 days on free zones.

## References

- [references/BILLING.md](references/BILLING.md) — working and dead endpoints with
  exact error codes, record shape, contract families, PDF-endpoint discovery.
- [references/pdf-extraction.md](references/pdf-extraction.md) — the CID-font problem,
  what fails and how convincingly, poppler-over-`ssh`, chunked base64 transfer.
- [references/analytics.md](references/analytics.md) — sampling, plan limits, spike
  workflow, full `wrangler` command table.
