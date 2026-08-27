# Cost Management: the five things that will bite you

Everything here was measured against a live subscription
(`DMa/Helix PRD (AZR3455)`, 2026-08-27) on
`POST /subscriptions/{id}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`.

---

## 1. Throttling is severe, undocumented, and header-free

Historical queries (`timeframe: "Custom"` + `granularity: "Monthly"`) answer:

```
HTTP 429
{"error":{"code":"429","message":"Too many requests. Please retry."}}
```

**Measured budget: roughly ONE historical query per FIVE MINUTES** per
subscription. Not per tenant, not per token — re-authenticating does not help.

**There is no `Retry-After` header, and no `x-ms-ratelimit-*` header.** The
response carries nothing to tell you how long to wait, so backoff *must* be
time-based. (`az-ext` still reads `Retry-After` in case a future API version
starts sending one, and says in its progress message which of the two it used.)

Measured on a live run of the *cheap* `MonthToDate` shape — even that gets
throttled when the subscription is hot:

```
az-ext: throttled (HTTP 429) … Attempt 1 — waiting 20s (time-based backoff; no Retry-After sent). Waited 0s of 900s budget.
az-ext: throttled (HTTP 429) … Attempt 2 — waiting 45s (time-based backoff; no Retry-After sent). Waited 20s of 900s budget.
az-ext: throttled (HTTP 429) … Attempt 3 — waiting 90s (time-based backoff; no Retry-After sent). Waited 65s of 900s budget.
→ succeeded on attempt 4, total wall clock 2m44s
```

### Mitigations, in order of value

**(a) Cache to disk. This is the single most valuable thing.** Every successful
response is written to `~/.cache/az-ext/cost/<sha256-24>.json` keyed on
subscription id + the exact query body. A rerun, a re-render, a switch to
`--json`, or a second look at the same window costs **zero** quota. Measured:
the same `cost mtd` took **2m44s** cold and **0.082s** warm.

The key is a SHA-256 of `subscriptionId + "\n" + JSON.stringify(body)`, and the
stored entry keeps the full query. On read, the stored query is compared
byte-for-byte with the requested one, so a hash collision can never silently
answer the wrong question. TTLs: **24 h** for historical windows (closed months
do not change), **15 min** for month-to-date.

```bash
az-ext cost cache --list     # what is already answered, and how old
az-ext cost cache --clear    # warns that the next query re-spends budget
az-ext cost summary --refresh   # deliberately bypass the cache
```

**(b) Back off with visible progress, and never bury a 429.** A 429 reported as
a generic failure sends you debugging your auth. Every wait prints what is
happening, how long, why the wait is time-based, and how much of the
`--max-wait` budget (default 900 s) is left. When the budget runs out the error
names the remedy rather than the symptom:

```
az-ext: Cost Management is throttling this subscription (HTTP 429) and did not clear within 20s (budget 30s).
This is normal, not a bug: the measured budget for historical queries is roughly
ONE query per FIVE MINUTES, and no Retry-After header is returned.
What to do, cheapest first:
  1. az-ext cost mtd --subscription <id>      # MonthToDate is a much cheaper shape
                                              # and often succeeds while history 429s
  2. az-ext cost cache --list                 # a previous answer may already be cached
  3. retry in ~5 minutes, or raise --max-wait (e.g. --max-wait 1800)
  4. narrow the window (--months 3) — fewer months is not cheaper per query, but
     it avoids the extra chunked queries a >1-year range needs
```

Backoff schedule: `20, 45, 90, 180, 300, 300, …` seconds. It stops doubling at
300 s deliberately — the budget is ~5 minutes, so waiting 40 minutes for one
query helps nobody.

**(c) `timeframe: "MonthToDate"` + `granularity: "None"` is a different, far
cheaper shape** and frequently succeeds immediately when a historical query is
being throttled. That is `az-ext cost mtd`. It is the right first move whenever
history is stuck. Add `--by <dimension>` only when you need the breakdown —
grouping makes it a heavier query.

**(d) Validate client-side.** A typo in a dimension name costs a full throttled
request to discover. `az-ext cost dimensions` and the validator built into every
command spend **zero** quota.

### What does *not* help

- Re-authenticating. The limit is on the subscription, not the token.
- Retrying immediately. Sub-5-minute retries mostly re-earn a 429.
- Splitting into smaller windows "to be gentler". Each *query* costs the same
  regardless of window size — more chunks is strictly worse (see §2).

---

## 2. One year maximum per query

A `timePeriod` spanning more than ~366 days:

```
HTTP 400
{"error":{"code":"BadRequest",
          "message":"The time period for pulling the data cannot exceed 1 year(s)."}}
```

`az-ext` chunks anything longer into ≤366-day windows automatically, warns that
it is doing so, and caches each chunk separately. **Each chunk spends throttle
budget**, so a 3-year query is three times as likely to hit §1 — combine with
caching and pull long histories one year at a time over several sittings.

If you hit this through `az rest`, split the range yourself. The error message
from `az-ext` reports both the limit and the span you asked for:

```
az-ext: Cost Management rejected the query (400 BadRequest): The time period for pulling the data cannot exceed 1 year(s).
Cost Management allows at most ~366 days per query and this one asked for 731.
```

---

## 3. Grouping dimensions are a closed set

`PublisherName` is **not** a dimension. ARM answers 400 and helpfully echoes the
valid ones, which is how the following list was confirmed:

> `ResourceGroup, ResourceGroupName, ResourceLocation, ConsumedService,
> ResourceType, ResourceId, MeterId, BillingMonth, …`

The full set `az-ext` validates against (34 names):

```
AccountName            BenefitId              BenefitName
BillingAccountId       BillingMonth           BillingPeriod
ChargeType             ConsumedService        CostAllocationRuleName
DepartmentName         EnrollmentAccountName  Frequency
InvoiceNumber          MarkupRuleName         Meter
MeterCategory          MeterId                MeterSubCategory
PartNumber             PricingModel           Provider
PublisherType          ReservationId          ReservationName
ResourceGroup          ResourceGroupName      ResourceGuid
ResourceId             ResourceLocation       ResourceType
ServiceName            ServiceTier            SubscriptionId
SubscriptionName
```

Because learning this from ARM costs one throttled request, validation happens
locally and points at the right answer:

```
az-ext: "PublisherName" is not a valid Cost Management grouping dimension.
Did you mean PublisherType?  PublisherType is the one that splits Azure-native spend from
  third-party Marketplace spend — see: az-ext cost marketplace --help
Valid dimensions: AccountName, BenefitId, … SubscriptionName
(Validated locally — ARM would have charged one throttled request to say this.)
```

---

## 4. `PublisherType` is the dimension that changes your conclusion

**This is the most important thing in this document.**

Grouping the 12 months to 2026-08 by `MeterCategory` produced this, and an
apparent mystery:

| MeterCategory / MeterSubCategory | Cost |
|---|---|
| `Unassigned / Unassigned` | **$14,467** |
| `SaaS / ClickHouse Cloud` | $8,253 |
| `Functions / Functions Premium` | $511 |
| `Service Bus / Standard` | $61 |
| `Azure App Service / Static Web Apps` | $52 |
| `Storage` (all sub-categories) | ~$54 |
| everything else | < $20 each |

**$14,467 — 61% of the subscription — in a bucket called "Unassigned."** It
looks like missing data, or a tagging failure, or something to go investigate.

It is none of those. Re-grouping by `PublisherType` + `ServiceName` resolves it
immediately:

| PublisherType | Total | Share |
|---|---|---|
| `Marketplace` | **$22,720** | **97.0%** |
| `Azure` | $695.60 | 3.0% |
| | **$23,415.60** | |

The "Unassigned" $14,467 is `PublisherType: "Marketplace"` — **third-party SaaS
resold through Azure billing**, which simply has no Azure meter category because
it is not an Azure meter. In the same subscription `Marketplace / SaaS` was
**ClickHouse Cloud at $8,253**.

**Azure-native infrastructure was only ~$694/year. 97% of the subscription was
third-party software.**

### Why this is not a footnote

A cost analysis that misses this is wrong by a factor of ~30 and gives
categorically wrong advice:

- "Optimise your Azure spend" is meaningless when 97% of it is a ClickHouse
  Cloud contract. There is no Azure lever — no reserved instance, no right-sizing,
  no storage tier — that touches it.
- Conversely, the $694 of real Azure infra (Functions Premium, Service Bus,
  Static Web Apps, Storage) is too small to be worth optimising at all.

`az-ext cost marketplace` makes this the default view: it groups by
`PublisherType` + `ServiceName`, prints the Azure/third-party split with
percentages, and (with `--vendors`, which spends a second throttled request)
attributes vendors from `ResourceId` — Marketplace SaaS resources look like
`/subscriptions/…/providers/Microsoft.SaaS/resources/<vendor-ish-name>`.

Rows with **no** `PublisherType` land in an explicit `unknown` bucket rather
than being folded into Azure. Quietly counting them as Azure is precisely the
mistake that made $14,467 look like infrastructure.

---

## 5. `rows` are positional arrays — map by column NAME

The response is:

```json
{
  "properties": {
    "columns": [ {"name":"Cost","type":"Number"},
                 {"name":"BillingMonth","type":"DateTime"},
                 {"name":"Currency","type":"String"} ],
    "rows": [ [1.58, "2025-08-01T00:00:00", "USD"], … ]
  }
}
```

`rows[]` entries are **bare positional arrays**, and **column order is not
stable** across groupings, granularities or API versions. Indexing
`row[0]` for cost is a latent data-corruption bug that produces plausible
numbers attached to the wrong labels. Always build objects keyed by
`columns[i].name` first.

Two more name-level traps:

- The cost column is usually `Cost`, but `CostUSD` / `PreTaxCost` appear
  depending on the billing currency and API version. Resolve by preference order.
- `BillingMonth` is a full ISO datetime (`2026-01-01T00:00:00`), not `2026-01`.

---

## Bonus: a Marketplace subscription starting or stopping is a regime break, not growth

The measured 13-month series for this subscription:

| Month | Cost | | Month | Cost |
|---|---|---|---|---|
| 2025-08 | $1.58 | | 2026-03 | $6,668.30 |
| 2025-09 | $11.93 | | 2026-04 | $3,818.79 |
| 2025-10 | $11.55 | | 2026-05 | $1,499.76 |
| 2025-11 | $11.19 | | 2026-06 | $1,755.94 |
| 2025-12 | $11.54 | | 2026-07 | $879.26 |
| 2026-01 | $3,574.56 | | 2026-08 | $757.74 |
| 2026-02 | $4,415.04 | | | |

A ClickHouse Marketplace subscription switched on in **2026-01** (a **310×**
step from $11.54 to $3,574.56) and wound down by mid-year.

**A naive growth fit over the full history yields +98,766 %/yr.** That number is
not a trend, it is an artefact of regressing across a step change.

`az-ext cost summary` detects the break (any ≥10× month-on-month step over $100)
and refuses to imply a trend across it:

```
az-ext: REGIME BREAK at 2026-01: spend stepped 310x at 2026-01 ($11.54 → $3574.56) —
typically a Marketplace subscription switching on, which is a regime change, not a
growth trend.
Do NOT fit a growth rate across this point — on the measured example a naive
full-history fit returned +98,766%/yr. Split the series at the break, or use
`az-ext cost marketplace` to see whether third-party spend explains it.
```

Related: **month-to-date is not a run rate.** A Marketplace subscription can
bill in one lump, so a MTD figure early in the month can be either the whole
month's third-party charge or almost none of it. Measured cross-check on
2026-08-27: `cost mtd` = **$763.27** against a closed 2026-08 of **$757.74** —
consistent here, but only because the lump had already landed.
