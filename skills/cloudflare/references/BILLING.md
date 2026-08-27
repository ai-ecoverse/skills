# Cloudflare billing: the dashboard API

Everything here was measured with live calls against a real Cloudflare
enterprise account (319 billing records, 2017-2026). Re-verify before you rely
on it: these are **private dashboard endpoints**, not a published API, and
Cloudflare can change them without notice.

## Auth: there is no token path

Cloudflare publishes no billing API. No `CLOUDFLARE_API_TOKEN` scope reaches
invoices, and `/api/v4/user/billing/history` answers **403 code 10000
"Authentication error"** even to a fully signed-in session. The only door is a
**same-origin request from a logged-in `dash.cloudflare.com` tab**, which is why
`wrangler-ext` runs every call through the `sliccy:browser` page-context bridge —
the same mechanism `wrangler.jsh` already uses for GraphQL analytics.

The account id is a 32-hex string. Every account-scoped dashboard URL contains
it (`https://dash.cloudflare.com/<32-hex>/billing/invoices`), so read it off the
tab URL before spending a request on `/api/v4/accounts`.

## Endpoints that work

| Method / path | Notes |
|---|---|
| `GET /api/v4/accounts/<acct>/billing/history?page=N&per_page=50` | The invoice list. NetSuite-sourced records. |
| `GET /api/v4/accounts/<acct>/billing/receipts/<uuid>/pdf?doctype=invoice&isLegacy=false` | The invoice PDF. `application/pdf`, 93-97 KB in practice. |
| `GET /api/v4/accounts/<acct>/subscriptions` | Product subscriptions. **No cost data on enterprise accounts** — see below. |
| `GET /api/v4/accounts/<acct>/billing/profile` | 200, but only `{id, first_name, last_name, billing_email, address, city, state, zipcode}`. **No cost data.** |
| `GET /api/v4/accounts?per_page=50` | Account list, for resolving an id when the tab is not on an account page. |

### `billing/history` record shape

```json
{
  "id": "e0911e59-aff1-5307-bf12-90c4f673a41c",
  "type": "invoice",
  "occurred_at": "2026-08-20T00:00:00Z",
  "amount": 582.54,
  "amount_to_pay": 582.54,
  "amount_remaining": 0,
  "ready_to_pay": false,
  "currency": "usd",
  "invoice_id": "e0911e59-aff1-5307-bf12-90c4f673a41c",
  "receipt_id": "IN705825",
  "status": "OPEN",
  "source": "netsuite"
}
```

Gotchas that each cost real debugging time:

- **`type` is `"invoice"` or `"credit"`, and credit amounts are NEGATIVE.**
  Measured: 309 invoices + 10 credits across 319 records. Filter by `type`
  before summing anything; a blind `reduce` silently nets credits against spend.
- **`amount` is sometimes ABSENT.** One real record (`IN253921`, 2022-03-31) has
  no `amount` key at all, which turns a naive `reduce` into `NaN`. Coerce with
  `Number(r.amount) || 0` and report the affected receipt ids rather than
  printing `NaN` or silently swallowing them.
- **`result_info` has NO `total_pages` and no total count** — only
  `{page, per_page, next_page}`. Paginate until `next_page === false`.
- **`per_page` above 50 is SILENTLY CLAMPED.** `per_page=1000` returns 50 rows
  and reports `per_page: 50` back with `success: true`. It does not error, so a
  single wide request looks like it worked and quietly truncates the history to
  the newest 50 records. Always paginate.
  (Contrast: `/subscriptions?per_page=100` *does* error, **400 code 1196**
  `invalid query parameter value for 'per_page'`. The two endpoints disagree.)
- **`id` === `invoice_id`** on every record measured. Both are the 36-char uuid
  the PDF endpoint wants. `receipt_id` (`IN705825`) is the human-facing number
  printed on the invoice and is **not** accepted by the PDF endpoint.
- **`status: "OPEN"` does NOT mean money is owed.** On the account measured,
  **every** record had `amount_remaining: 0` and `ready_to_pay: false`, while 42
  invoices from 2023-2026 still sat at `OPEN`. Cloudflare's NetSuite feed leaves
  enterprise invoices `OPEN` long after settlement. Observed statuses: `OPEN`,
  `CLOSED`, `CREDIT_FULLY_APPLIED`. Read `OPEN` as "not marked settled" and never
  publish the sum of `OPEN` invoices as a balance due.
- `source` is `netsuite` for enterprise invoices and `stripe` for the occasional
  self-serve charge. `stripe` receipt ids look different (`IN-64539162`).
- `currency` is **lowercase** (`"usd"`).

### The invoice PDF endpoint

```
GET /api/v4/accounts/<acct>/billing/receipts/<uuid>/pdf?doctype=invoice&isLegacy=false
```

- **The query string is MANDATORY.** Without it the same path returns
  **400 code 1196** `invalid query parameter value for 'doctype'`. Dropping the
  query string is the single easiest way to conclude, wrongly, that the endpoint
  does not exist.
- `<uuid>` is the record `id` / `invoice_id`, **never** the `receipt_id`.
- Returns `content-type: application/pdf`. Verify the `%PDF` magic bytes before
  writing the file — a lost billing scope returns a JSON error body with HTTP
  200-ish framing.
- Fetch it with the page-context bridge's binary mode
  (`browser.fetch(tab, path, { responseType: 'binary' })` → base64 `body`). A
  93,576-byte PDF came back as 124,768 base64 chars **without truncation**, so
  the `playwright-cli eval` output cap does not apply to this route.

## Dead ends — measured, do not re-guess

| Path | Result |
|---|---|
| `/api/v4/user/billing/history` | 403 code 10000 "Authentication error" |
| `/api/v4/accounts/<a>/invoices` | 400 code 7003 "Could not route to …" |
| `/api/v4/accounts/<a>/billing/invoices` | 400 code 7003 |
| `/api/v4/accounts/<a>/billing/history/<uuid>` | 404 code 1199 (no single-record GET) |
| `/api/v4/accounts/<a>/billing/history/<uuid>/pdf` | 404 code 1199 |
| `/api/v4/accounts/<a>/billing/invoice/<uuid>/pdf` | 400 code 7003 |
| `/api/v4/billing/invoices/<uuid>/pdf` | 400 code 7000 "No route for that URI" |
| `/api/v4/accounts/<a>/billing/receipts/<uuid>/pdf` *(no query string)* | 400 code 1196 |
| `/api/v4/accounts/<a>/billing/profile` | 200 but **no cost data** |
| `/api/v4/accounts/<a>/subscriptions?per_page=100` | 400 code 1196 (max 50) |

There is **no** single-invoice JSON endpoint. `billing/history` is a list-only
resource: to inspect one invoice you list, match on `receipt_id`, and download
its PDF.

## Enterprise accounts expose no per-product cost

`GET /api/v4/accounts/<acct>/subscriptions` returns the full product list — 20
entries on the account measured (Workers Paid for Ent, R2 Storage for Enterprise,
Zero Trust Enterprise, Images Enterprise, Load Balancing, ACM, Core Base Bundle,
…) — and **every single one reports `price: 0`**, with `intent` in
`ENTERPRISE_CONTRACT`, `MIGRATED`, `FREE`, `TRYOUT` and `frequency:
"not-applicable"`.

That is not a bug and not a permissions problem: on an enterprise account the
negotiated rate lives in the contract, not in the API. **Consequence: invoice
PDFs are the only route to real line items and real money.** Any tool that tries
to attribute enterprise cost per product from `/subscriptions` is reading zeros.

## Contract families — the attribution problem

A large org has ONE Cloudflare account shared by many teams. `billing/history`
therefore interleaves the parent org's contract renewals with your team's, and
nothing in the JSON says which is which — not the amount, not the date, not the
source. The **contract number** printed on each PDF (`IC-` followed by 6 digits)
is the only reliable discriminator.

Measured on one real account, 2026 YTD:

| Contract | Amount | Cadence | Order type | Whose |
|---|---|---|---|---|
| `IC-120694` | $240,300.00 | monthly × 8 | Renew | parent org |
| `IC-140105` | $564,407.28 | annual (Aug 15 → Aug 14 2027) | Renew | parent org |
| `IC-164916` | $417,000.00 | annual (Apr 1 → Mar 31 2027) | Renew | parent org |
| `IC-148869` | $7,839.99 | monthly × 8 | Renew | the team's |
| `IC-168642` | $21,848.80 | monthly from May 2026 | **Upsell – Insertion Order** | the team's, attribution uncertain |
| *(none)* | variable, ~$0.5k-11.6k | ~monthly | **Excess Usage Billing** | definitively the team's |

Account 2026 YTD totalled **$3,146,348.73**; the team's actual slice was roughly
**$159k-421k** depending on how `IC-168642` is attributed. **Summing the account
instead of your own contract families overstates a team's Cloudflare cost by
about 20x.** That error is the entire reason `wrangler-ext billing contracts`
exists.

Practical notes on grouping:

- A recurring contract charge bills the **identical amount** every period, so
  clustering by exact amount recovers families without reading any PDF
  (`--no-pdf` does exactly this). Cadence follows from the median gap between
  invoice dates.
- **One contract legitimately bills several different amounts.** `IC-120694`
  carries the $240,300 × 8 base charge *plus* seven smaller monthly add-on
  invoices ($1,363-$7,580). `contracts` merges families that share a contract
  number but keeps the components visible, because collapsing them to "variable"
  hides the base charge that makes the attribution argument.
- A family with a single invoice still has a cadence: the PDF's **service
  period** proves it (Apr 1 2026 → Mar 31 2027 is an annual contract billed once
  up front, not a stray expense).
- Invoices with **no contract number** and an `Excess Usage Billing` description
  are metered overage on your own usage. Those are unambiguously yours — parse
  them with `billing usage <receipt_id>`.
- `Order Type` observed: `Renew`, `Upsell - Insertion Order`, `Variable`. An
  `Upsell – Insertion Order` mid-term is the ambiguous case: it may be a new
  team's spend added to an existing parent contract.

## Working offline: `--fixture`

`--fixture <file>` replaces the live API with a saved `billing/history` dump, so
grouping and parsing can be exercised (and regression-tested) with no dashboard
session. The file is a JSON **array** of history records — exactly what
`billing/history` returns — or `{ "result": [ … ] }`. Any record may carry an
extra `pdf_text` string, which stands in for that invoice's extracted PDF text so
`contracts`, `lineitems` and `usage` work fully offline:

```json
[
  { "id": "0000-…", "type": "invoice", "occurred_at": "2026-04-01T00:00:00Z",
    "amount": 417000, "currency": "usd", "receipt_id": "IN668428",
    "status": "CLOSED", "source": "netsuite",
    "pdf_text": "Invoice\nCloudflare, Inc\n…\nCloudflare Enterprise Service Renew IC-164916 0% $0.00 $417,000.0\n0\n…" }
]
```

Save a real dump with `wrangler-ext billing invoices --limit 1000 --json`, or capture
one page verbatim from `billing/history`. `billing pdf` is the one command that
still requires a live session (a fixture has no PDFs) and says so.

## How the PDF endpoint was found

Guessing failed on eight plausible paths (table above). What worked: patch the
dashboard page's own network surface, then let the UI make the call.

1. Open the account's **Billing → Invoices** page in the dashboard tab.
2. From the page context, wrap `window.fetch`, `XMLHttpRequest.prototype.open`
   and `URL.createObjectURL`, each recording its URL into a global array.
3. Click the row's **Download** menu item.
4. Read the captured URL back out.

The `?doctype=invoice&isLegacy=false` query string only ever appeared this way —
it is not guessable, and without it the endpoint returns 400. This technique
generalises to any dashboard whose private API you need: **make the app issue the
request and record what it issued**, rather than guessing REST shapes. (Prefer
`browser.websocket` for WebSocket traffic; prototype patching is for one-off
discovery in a page you own the session for, not for shipped skill code.)
