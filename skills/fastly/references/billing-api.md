# Fastly Billing v3 API and the forecast model

Everything here was verified with live calls against a real account. Re-verify
anything you rely on; Fastly has retired billing endpoints before.

## Endpoints that work

| Method / path | Notes |
|---|---|
| `GET /billing/v3/invoices` | `{ data: [...], meta: { next_cursor, limit, total, sort } }`. Default sort `-billing_start_date` (newest first). `?limit=N` — 100 is safe, ~200 is silently clamped, 500 returns 400. Cursor pagination via `meta.next_cursor`. |
| `GET /billing/v3/invoices/{invoice_id}` | One closed invoice. A bad id returns `{"title":"requested id:<id> doesn't exist","status":404}`. |
| `GET /billing/v3/invoices/month-to-date` | Synthetic in-progress invoice. `invoice_id` is `<customer_id>-<epoch>`, and there is no `payment_status`, `currency_code` or usable `statement_number`. |

## Endpoints that are gone — do not implement

All of these 404 on current accounts:
`/billing/v2/account_customers/{cust}/invoices`, `/billing/year/{y}/month/{m}`,
`/billing/v2/year/{y}/month/{m}`, `/billing/v3/estimate`,
`/billing/v3/estimates`, `/billing/v3/service-level-usage`,
`/billing/v3/service-level-usage-types`.

There is no per-service cost breakdown in the billing API. Invoice line items
are grouped by product and region, never by service id. To attribute spend to a
service you have to correlate `fastly stats` request/bandwidth volumes against
the invoice's regional line items yourself — and the blended rate drifts, so
treat that as an estimate.

## Invoice shape

```json
{
  "customer_id": "…",
  "invoice_id": "INV-375119",
  "invoice_posted_on": "2026-07-01T00:00:00Z",
  "billing_start_date": "2026-07-01T00:00:00Z",
  "billing_end_date": "2026-07-31T00:00:00Z",
  "statement_number": "INV-375119",
  "currency_code": "USD",
  "monthly_transaction_amount": 6604.19,
  "payment_status": "outstanding",
  "transaction_line_items": [
    { "description": "Asia Requests", "amount": 292.03, "credit_coupon_code": "",
      "rate": 0.002, "units": 146017.0369, "product_name": "Asia Requests",
      "product_group": "Full Site Delivery", "product_line": "Network Services",
      "region": "Asia", "usage_type": "Requests" }
  ]
}
```

Gotchas that cost real debugging time:

- **`monthly_transaction_amount` is a number on closed invoices and a STRING on
  `month-to-date`.** Coerce with `Number()` before arithmetic.
- `payment_status` observed: `paid`, `outstanding`. Absent on `month-to-date`.
- `product_group` observed: `Full Site Delivery`, `CS: CSE` (Enterprise Support),
  `TLS`, `N/A`, `Unknown`.
- **Cursors are base64** and can contain `+` and `=`. Percent-encode them into
  the query string or pagination silently breaks.
- Invoice ids changed format historically: `INV-375119` recently, bare numeric
  statement numbers (`29239985`) for older months. Both resolve.

## Fixed vs usage — the thing that makes MTD misleading

`fastly-ext` classifies product groups `CS: CSE` and `TLS` as **fixed monthly
charges** and everything else as usage. Fixed charges are billed in full on day 1
of the period, so a raw month-to-date total is not a run rate:

```
2026-07 invoice   $6604.19 = $2600.00 support + $880.00 TLS (44 certs @ $20) + $3124.19 usage
2026-08 MTD (day 4) $2890.32 = $2600.00 support + $290.32 usage
```

Three days in, 90% of the MTD figure is a subscription that will not grow.

A second wrinkle: the **TLS certificate subscription is not priced in
`month-to-date`**. Mid-month it appears as `$0` line items under `product_group`
`N/A` / `Unknown` and is only valued at invoice close. `billing mtd` therefore
compares MTD fixed against the prior invoice's fixed and flags the difference,
and `billing forecast` takes fixed from
`max(prior_invoice_fixed, mtd_fixed)` rather than from MTD alone.

## The forecast model

`fastly-ext billing forecast` predicts the current month's invoice as
`fixed + usage`.

**Fixed** is carried from the prior invoice. Across 30 months it moved only with
support-tier and certificate-count changes (`$3420` → `$3500` → `$3480`), so
carry-forward is accurate to a few dollars.

**Usage** is the prior month's usage rescaled by *billable month size*:

```
W(month) = Σ over days   dow_weight[weekday(day)]
usage_raw = usage[prior] × W(current) / W(prior)
```

`dow_weight` is this account's measured day-of-week traffic profile as a fraction
of the month's mean day (2024-01 → 2026-08):

| Sun | Mon | Tue | Wed | Thu | Fri | Sat |
|---|---|---|---|---|---|---|
| 0.694 | 1.079 | 1.154 | 1.113 | 1.162 | 1.058 | 0.738 |

Two months of the same length can differ in billable size by ~3% purely from
which weekdays they contain, which is why a naive day-count ratio is not used.

**Why dollars and not requests.** Effective $/request drifted ~10%
month-over-month across 30 months because the regional mix changes the blended
rate. Forecasting dollars from request counts is therefore worse than
forecasting dollars directly.

### Where the interval comes from

The same estimator is **backtested one month ahead** over the last `--window`
(default 12) consecutive invoice pairs. For each month it predicts usage from the
immediately preceding invoice only — data that was available before the month
started — and records the relative error `e = (pred − actual) / actual`. Months
with a gap in the series are skipped.

Since `pred = actual × (1 + e)`, the observed error distribution inverts onto the
prediction:

```
point = usage_raw / (1 + median(e))
low   = usage_raw / (1 + p90(e))
high  = usage_raw / (1 + p10(e))
```

The median correction matters: on this account the naive carry-forward
systematically **under**-predicts (median error ≈ −5% over 12 months, −9% over
24) because usage is growing.

**What the band means, precisely.** It is the 10th–90th percentile of the
backtested errors, so 80% of the backtested months fall inside it *by
construction*. It is an empirical error band, not a statistical confidence
interval, and it carries no guarantee about a month whose traffic pattern differs
from the window. Widening `--window` includes older, noisier months and widens
the band (MAPE 6.2% at 12 months vs 11.2% at 24). Below 4 usable backtest
samples, only a point estimate is printed — no interval is fabricated.

### The cross-check

A second, independent projection scales this month's accrued usage by the
weighted fraction of the month elapsed (using `billing_end_date` from MTD,
including the partial final day). It is printed alongside the forecast and
explicitly labelled **not backtested**: the API exposes no historical
month-to-date snapshots, so this estimator's error cannot be measured. A large
gap between the two numbers is the useful signal — it means the month is
genuinely off-trend rather than that one estimator is broken.

Worked example (2026-08, on day 4):

```
usage = 2026-07 usage $3124.19 × 30.50/31.32 = $3042.21 raw
      → bias-corrected $3199.70   band $2977 – $3451
total = $3480.00 fixed + $3199.70 = $6679.70   band $6457.13 – $6930.63
cross-check from MTD: $290.32 over 3.31 weighted days → $3083.84 usage ($6563.84 total)
```
