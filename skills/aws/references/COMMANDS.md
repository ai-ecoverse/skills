# Command reference

Two binaries: `aws` mirrors the real AWS CLI, `aws-ext` holds the SLICC-only
analysis. **Always use long flags with values** (`--start 2026-01-01`): this
runtime hands single-dash flags over as booleans and never captures a following
value, so short aliases are deliberately not offered.

Every command accepts `--json` for machine-readable output, and `--help` prints
usage without making a request.

---

## `aws` — AWS CLI subset

### `aws sts get-caller-identity [--json]`

Verify credentials and find out which account you are in. Signed against
`sts.amazonaws.com` (service `sts`, region `us-east-1`) as a
`application/x-www-form-urlencoded` POST of
`Action=GetCallerIdentity&Version=2011-06-15`. The reply is XML; `Account`,
`Arn` and `UserId` are extracted.

```
Account  123456789012
Arn      arn:aws:sts::123456789012:assumed-role/klam-master-role/lars
UserId   AROAEXAMPLEID:lars
credentials: environment (temporary STS session credentials)
```

Run this first, always. Every "the numbers look too small" problem starts with a
credential pointed at a different account than you assumed.

### `aws ce get-cost-and-usage [flags]`

Cost Explorer `GetCostAndUsage` against `ce.us-east-1.amazonaws.com` (service
`ce`, region `us-east-1` regardless of where your resources are).

| Flag | Meaning |
|---|---|
| `--start YYYY-MM-DD` | Window start, inclusive. Default: 6 months back, 1st of month |
| `--end YYYY-MM-DD` | Window end, **EXCLUSIVE**. Default: the 1st of next month |
| `--time-period Start=..,End=..` | The real CLI's form; equivalent to `--start`/`--end` |
| `--granularity MONTHLY\|DAILY\|HOURLY` | Default `MONTHLY` |
| `--metrics UnblendedCost[,UsageQuantity,…]` | Default `UnblendedCost`. `BlendedCost`, `NetUnblendedCost`, `AmortizedCost`, `UsageQuantity` also valid |
| `--group-by SERVICE` | Dimension key; repeatable or comma-separated, max 2 (an API limit) |
| `--group-by Type=DIMENSION,Key=SERVICE` | The real CLI's form |
| `--group-by-type DIMENSION\|TAG\|COST_CATEGORY` | Applies to the short form. Default `DIMENSION` |
| `--filter '<json>'` | A raw Cost Explorer `Expression` |
| `--json` | Raw merged API response |

Known dimensions: `SERVICE`, `USAGE_TYPE`, `USAGE_TYPE_GROUP`, `REGION`,
`RECORD_TYPE`, `LINKED_ACCOUNT`, `OPERATION`, `PURCHASE_TYPE`, `INSTANCE_TYPE`,
`AZ`, `PLATFORM`, `TENANCY`. An unrecognised one warns rather than failing —
Cost Explorer adds dimensions over time.

```bash
aws ce get-cost-and-usage --start 2026-01-01 --end 2026-07-01 --group-by RECORD_TYPE
aws ce get-cost-and-usage --group-by SERVICE --group-by REGION
aws ce get-cost-and-usage --metrics UnblendedCost,UsageQuantity --group-by USAGE_TYPE \
  --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Simple Storage Service"]}}'
```

`NextPageToken` pagination is drained automatically (up to 25 pages) and
same-period results are **merged**, not concatenated — otherwise one month
appears two or three times in the series. A partial page would silently
under-report a total, which is why this is not optional.

### `aws ce get-dimension-values --dimension SERVICE [--start D] [--end D] [--json]`

Enumerate the values a dimension actually has in your account. Use it to get the
exact `SERVICE` string for `aws-ext cost detail --service` — the names are
awkward (`Amazon Elastic Compute Cloud - Compute`, `AmazonCloudFront`) and an
inexact one returns nothing rather than an error.

### `aws configure list | set <key> <value> | unset <key>`

| Key | Notes |
|---|---|
| `aws_access_key_id` | |
| `aws_secret_access_key` | Never displayed, not even partially |
| `aws_session_token` | Required for federated/temporary credentials |
| `region` | Cost Explorer ignores it (always `us-east-1`) |
| `expiration` | Optional ISO timestamp; `configure list` flags it once past |

`configure list` prints a real-CLI-style table with `Type` (`env` or `config`)
and `Location` so you can see **which** credential is in play. `aws configure
get` is deliberately unimplemented: it would print a secret to stdout.

`configure unset` removes the key and then **re-reads the config to confirm it is
gone**. That check is not paranoia: `skill.config()` *merges*, so writing back an
object with the key deleted leaves the old value in place — the naive
implementation printed "removed" while changing nothing.

### `aws --version`

Skill version plus the endpoints and signing regions in use.

---

## `aws-ext` — analysis the upstream CLI has no command for

All of these take `--months N` (default varies, counted back from the current
month), or explicit `--start`/`--end`, plus `--json`. Data is fetched by shelling
out to `aws ce get-cost-and-usage --json`, so credential resolution, signing,
pagination and the 14-month clamp exist in exactly one place.

### `aws-ext cost summary [--months 12] [--group-by SERVICE] [--json]`

Monthly net totals with a sparkline, mean of complete months, top contributors,
and negative rows listed **separately** with their share of gross. Marks the
current partial month `[Estimated]`.

### `aws-ext cost discounts [--months 12] [--json]`

Groups by `RECORD_TYPE` and separates charges from reductions:

```
  Charges
    Usage                                   $222,617.68
    DiscountedUsage                          $11,835.30
    Tax                                       $2,367.06
    gross                                   $236,827.00

  Discounts, credits and refunds
    Enterprise Discount Program Discount    -$82,949.00    35.0% of gross
    Private Rate Card Discount               -$8,496.00     3.6% of gross
    total reductions                        -$91,445.00    38.6% of gross

    NET (what AWS invoices)                 $145,380.00    61.4% of gross
```

Plus a per-month gross/discount/net table. `DiscountedUsage` is a **charge** row
(Reserved-Instance or Savings-Plan-covered usage), not a discount — the naming
invites exactly that mistake.

### `aws-ext cost breaks [--months 18] [--group-by DIM] [--json]`

Finds the single most significant step change in the monthly series (largest
standardised difference of means over all splits with ≥2 months per side) and
calls it a break only when the step is **both** ≥25% in relative terms **and**
`t ≥ 3` against within-regime noise — a false break is worse than a missed one.
The current `Estimated` month is excluded. Output gives per-regime mean ± sd,
plus full-history and last-6-month annualised growth *labelled as artefacts*
when a break exists. Needs ≥4 complete months.

### `aws-ext cost detail --service "<name>" [--usage-type] [--group-by DIM] [--months 6] [--json]`

One service, grouped by `USAGE_TYPE` (the default, and what `--usage-type` asks
for explicitly; `--group-by OPERATION|REGION|USAGE_TYPE_GROUP` pivots instead),
with `UsageQuantity` alongside cost and a
per-month mean computed from **complete months only**. Then it classifies the
drivers into requests / storage / data transfer and says which one dominates,
because those three demand different fixes.

### `aws-ext cost accounts [--months 6] [--json]`

Groups by `LINKED_ACCOUNT`, resolves account names from
`DimensionValueAttributes` where the payer exposes them, and marks the calling
account (cross-checked with `aws sts get-caller-identity`). A single account is
called out as **standalone** with the warning that the spend you want may live
elsewhere.

### `aws-ext sigv4 verify [--json]`

Signs the bundled official AWS SigV4 test vectors and compares canonical
request, string-to-sign and `Authorization` **byte-for-byte**. No credentials, no
network. Also checks the HMAC primitive and the signing-key derivation chain
against their published values. Exits 1 on any mismatch. This is the first thing
to run when signing fails.
