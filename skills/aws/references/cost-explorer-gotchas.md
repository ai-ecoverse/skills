# Cost Explorer gotchas

Every item here was hit for real. They share a shape: the API answers
successfully, the number looks plausible, and it is wrong.

## `End` is EXCLUSIVE

`TimePeriod.End` is not included in the result. To get June you ask for
`Start=2026-06-01, End=2026-07-01`. Asking for `End=2026-06-30` silently drops
the last day of the month — a ~3% understatement that no error tells you about.

The default window in this skill is `--end` = the **1st of next month**, which is
what includes the current month.

## The current month is `Estimated: true` — it is a partial month

Each `ResultsByTime` entry carries an `Estimated` flag. For the in-progress month
it is `true` and the amount covers only the days so far. Read as a data point it
looks like a collapse in spend, and a "spend is down 60%" claim built on it is
just the calendar.

- `aws ce get-cost-and-usage` marks it `[Estimated — partial period]`.
- `aws-ext cost summary` / `discounts` / `detail` mark it and add a note.
- `aws-ext cost breaks` **excludes** it from regime and growth maths entirely.
- `aws-ext cost detail` divides by complete months only when computing `/mo`.

Charges also settle for a few days after month end (late usage, tax, credits), so
a month closed yesterday can still move slightly.

## The 14-month wall

```
ValidationException: You haven't enabled historical data beyond 14 months.
```

Cost Explorer serves 14 months by default; more requires explicitly enabling
historical data on the payer account (and it can take ~48h to backfill). The
limit is measured from **today**, not from a month boundary, so a naive
"14 months back, 1st of the month" start can still be a few days too early.

`aws ce get-cost-and-usage` catches this, clamps `Start`, retries — up to three
times, each a month more conservative — and **warns on stderr each time**, with
the clamp repeated in the output and in `--json` as `Clamped: {from, to,
limitMonths}`. A silently shortened window is the dangerous case: it changes
every growth rate computed from it while looking like a normal result.

## Negative amounts, and the `NoRegion` key

Discounts, credits and refunds come back as **negative** `UnblendedCost` rows.
Two consequences:

1. **Percentages break.** `share = row / total` across mixed signs gives
   nonsense — a measured example produced a share of **162.6%**, because the
   denominator was net (after a 35% discount) while the numerator was gross. All
   commands here compute shares against **gross = sum of positive rows** and list
   negative rows separately.
2. **Grouping by `REGION` invents a region.** Discounts are not attributable to a
   region, so they arrive under the key **`NoRegion`** with a large negative
   amount. It is not a region and not an error; `aws-ext cost summary --group-by
   REGION` says so explicitly.

The same applies to `--group-by SERVICE`, where discounts land under service-like
keys such as `Refund` or under no service at all depending on the account.

## `RECORD_TYPE` semantics

`--group-by RECORD_TYPE` is the only way to see gross vs net. The values:

| Record type | Sign | Meaning |
|---|---|---|
| `Usage` | + | On-demand usage at list price |
| `DiscountedUsage` | + | Usage covered by a Reserved Instance or Savings Plan, billed at the covered rate. **A charge row, not a discount** — the name invites the mistake |
| `SavingsPlanCoveredUsage` | + | Usage covered by a Savings Plan |
| `SavingsPlanRecurringFee` | + | The Savings Plan commitment fee |
| `SavingsPlanNegation` | − | Removes the covered usage so it is not double-counted |
| `Tax` | + | Sales/VAT |
| `Support fee` | + | Enterprise/Business Support |
| `Enterprise Discount Program Discount` | − | The EDP discount. Routinely 30–40% of gross |
| `Private Rate Card Discount` | − | Negotiated per-service rates |
| `Bundled Discount` | − | Free-tier-style bundling |
| `Solution Provider Program Discount` | − | Reseller discount |
| `Credit` | − | Promotional or service credits |
| `Refund` | − | Refunds |

Measured on a real Adobe-adjacent account: **$236,827 gross** usage, EDP
**−$82,949 (35%)**, Private Rate Card **−$8,496**, net **$145,380**. The gap is
larger than most of the differences these numbers get quoted to argue about, so
`aws-ext cost discounts` prints gross, each reduction, and net side by side, and
refuses to imply one is "the" cost.

Rule of thumb: a competitor's **list price** compares to **gross**; a budget,
invoice or actual-spend claim compares to **net**. Say which one you used.

## `LINKED_ACCOUNT` tells you whether you can see anything at all

Cost Explorer in a **member** account shows only that account. If
`--group-by LINKED_ACCOUNT` returns exactly one key, the credential is
standalone (or a member) — and a suspiciously small figure probably means the
spend lives in a different account. One real case: the first credential saw a
$400/mo "delivery tier" and nothing else; the actual spend was in another
account entirely.

Cost Explorer permissions (`ce:GetCostAndUsage`) are granted in the **payer**
account for consolidated billing, so a member-account role often gets
`AccessDenied` even though its credentials are perfectly valid.

## Metrics are not interchangeable

| Metric | Use |
|---|---|
| `UnblendedCost` | What AWS actually charged the account. The default here, and what to use for a bill |
| `BlendedCost` | Organisation-averaged rates. Misleading for a single account |
| `NetUnblendedCost` | Unblended **after** discounts/credits are applied per line |
| `AmortizedCost` | Spreads upfront RI/SP payments across the term |
| `UsageQuantity` | The unit count. **Required** to tell a request-driven bill from a storage-driven one |

`UsageQuantity` sums across incompatible units when you group coarsely (adding
`Requests` to `GB-Month` is meaningless), so only read it per `USAGE_TYPE` —
which is what `aws-ext cost detail` does, keeping the `Unit` beside every row.

## Pagination

`GetCostAndUsage` paginates with `NextPageToken`, and a monthly window grouped by
a high-cardinality dimension (`USAGE_TYPE`) really does paginate. A dropped page
under-reports the total with no error. `aws ce get-cost-and-usage` drains up to 25
pages and **merges same-period results** instead of concatenating them —
concatenating makes one month appear two or three times in the series.

## Other limits worth knowing

- **Two `GroupBy` entries maximum** per call. A third is rejected; this skill
  fails fast with that message instead of letting the API say it obliquely.
- Cost Explorer API calls are **billed** (about $0.01 per paginated request).
  Cheap, but a tight loop over daily granularity across a year is not free.
- Data lags roughly 24h; today's spend is incomplete beyond the `Estimated` flag.
- Rate limiting appears as `LimitExceededException` / `ThrottlingException` —
  retry with backoff rather than immediately.
