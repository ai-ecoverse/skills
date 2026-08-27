# Command reference

Two binaries. **`az`** mirrors the real Azure CLI's command and flag names.
**`az-ext`** holds the Cost Management analysis the real CLI has no equivalent
for. Add `--json` to any command for structured output.

**Use long flags with values** (`--subscription X`, `--months 12`). This runtime
hands single-dash flags over as booleans and never captures a following value,
so short aliases are deliberately not offered.

---

## `az` — Azure Resource Manager

### `az login --from-tab [--wait S] [--tab <targetId>] [--json]`

Harvest the ARM access token from an open, signed-in `portal.azure.com` tab
(MSAL `sessionStorage`, audience `management.core.windows.net`), validate it
against `GET /subscriptions`, and store it. **The token is never printed** —
only its length, expiry, tenant and audience.

| Flag | Meaning |
|---|---|
| `--from-tab` | The only supported login mode. Accepted for symmetry; it is the default. |
| `--wait S` | Poll the tab for up to `S` seconds for a *non-expired* ARM token. |
| `--tab <targetId>` | Use a specific tab instead of auto-picking the portal tab. |
| `--json` | Emit the summary plus the subscription list as JSON. |

**An idle portal tab can hold an already-expired token** — MSAL refreshes
lazily, not on a timer. When that happens the command refuses to store it and
tells you to interact with the tab; `--wait 60` polls while you do.

Service-principal login is rejected with an explanation, not a generic parse
error: this skill has no client secret.

```bash
az login --from-tab
az login --from-tab --wait 60      # while you click around the portal
```

### `az account list [--json] [--no-refresh]`

Subscriptions visible to the session, via `GET /subscriptions?api-version=2022-12-01`.
`*` marks the default. The list is cached in the skill config so `az-ext` can
resolve names offline; `--no-refresh` reads that cache instead of calling ARM.
This endpoint is **not** part of the throttled Cost Management surface.

```
   ATS/DMa CTI PRD (AZR9971)          2213d7fc-fad6-45ce-8f8e-e3cf93afb46f  Enabled
 * DMa/Helix PRD (AZR3455)            07d1d753-4bfc-4012-9958-35592a40a3fa  Enabled
   DMa/AEM Engineering (AZR0022)      0db92958-3ec7-42ed-89dd-ae47666126f5  Enabled
```

### `az account show [--subscription <id|name>] [--json]`

The current (or named) subscription: id, name, state, tenant, and whether the
stored token is still valid and for how long.

### `az account set --subscription <id|name>`

Set the default subscription for both `az` and `az-ext`. Accepts a GUID, an
exact name, or a **unique** substring — an ambiguous substring is refused with
the candidates listed rather than guessed.

```bash
az account set --subscription "Helix PRD"
```

### `az logout`

Forget the local ARM token. **Local only** — the portal tab keeps its own
session; sign out in the portal to actually revoke.

### `az rest --method M --url <path|full-url> [--api-version V] [--body '<json>'|@file]`

Authenticated raw ARM call — the escape hatch for anything not wrapped. A
leading `/` is resolved against `https://management.azure.com`. `--uri` is
accepted as an alias (the real CLI spells it that way).

The response body is **always** printed, including on an error status, because
an ARM error body is the most useful thing available. A non-2xx also writes a
one-line summary to stderr and exits 1.

```bash
az rest --url /subscriptions --api-version 2022-12-01
az rest --method POST --api-version 2023-11-01 \
        --url /subscriptions/<subId>/providers/Microsoft.CostManagement/query \
        --body @/tmp/query.json
```

> Prefer `az-ext cost` over hand-rolled cost queries through `az rest`:
> `az rest` has **no caching and no 429 backoff**, so a throttled retry loop
> there just burns the ~1-query-per-5-minutes budget.

### `az version`

Skill version, ARM base URL, API versions, and whether a valid token is stored.

---

## `az-ext cost` — Cost Management analysis

All subcommands accept these:

| Flag | Meaning | Default |
|---|---|---|
| `--subscription <id\|name>` | GUID, exact name, or unique substring | the `az account set` default |
| `--months N` | The N most recent months **including** the current partial one: 1st of the month N-1 back → today | `12` |
| `--from` / `--to YYYY-MM-DD` | Explicit window (overrides `--months`). Spans over 364 days are chunked. | — |
| `--refresh` | Ignore the cache and re-query. **Spends quota.** | off |
| `--no-cache` | Synonym for `--refresh` | off |
| `--max-wait S` | Seconds to spend backing off HTTP 429 | `900` |
| `--limit N` | Rows to print | `25` |
| `--json` | Structured output, including cache accounting | off |

### `az-ext cost summary`

Monthly totals (`granularity: "Monthly"`, no grouping), rendered as a bar chart
with the latest month's change, plus a **regime-break warning** when a month
steps ≥10× over the previous one — the signature of a Marketplace subscription
switching on or off, which must not be read as growth.

```bash
az-ext cost summary --subscription "DMa/Helix PRD" --months 13
```

Ranges over 364 days are split into even chunks automatically (with a warning;
each uncached chunk spends quota). `--months N` is anchored so the default
`--months 12` stays a **single** query.

### `az-ext cost marketplace`

**The command that changes conclusions.** Groups by `PublisherType` +
`ServiceName` and splits spend into **Azure-native infrastructure** vs
**third-party Marketplace software**, with percentages.

| Flag | Meaning |
|---|---|
| `--vendors` | Spend a **second** throttled query grouped by `ResourceId` to name vendors |
| `--no-vendors` | Skip vendor naming entirely |

Without `--vendors` it serves vendor names from cache if a `ResourceId` query
happens to be cached, and otherwise says so rather than silently omitting them.
Vendor lookup failure never fails the command — the split is the answer.

Measured on `DMa/Helix PRD`, 12 months to 2026-08: `Marketplace` **$22,720
(97.0%)** against `Azure` **$695.60 (3.0%)**. See
[`cost-management-gotchas.md` §4](cost-management-gotchas.md).

### `az-ext cost sku`

Group by `MeterCategory` + `MeterSubCategory`. Prints a footnote pointing at
`cost marketplace`, because a large `(unassigned)` MeterCategory bucket in this
view is almost always Marketplace spend rather than missing data.

### `az-ext cost services`

Group by `ServiceName`.

### `az-ext cost mtd [--by <dimension>]`

Month-to-date: `timeframe: "MonthToDate"` + `granularity: "None"`, with **no
grouping** by default. This is the measured-cheapest shape and often succeeds
while historical queries are being throttled — **the right first move when
history is stuck**. `--by <dimension>` adds one grouping level (validated
locally) at the cost of a heavier query.

Cached for 15 minutes, not 24 hours, because the value moves.

### `az-ext cost dimensions [--check <name>] [--json]`

The 34 valid grouping dimensions, printed locally. **Zero quota.** `--check`
validates one name and exits non-zero with the alternatives if it is wrong.

```bash
az-ext cost dimensions --check PublisherName   # → rejected, suggests PublisherType
```

### `az-ext cost cache [--list] [--clear] [--json]`

Inspect or drop the on-disk response cache
(`~/.cache/az-ext/cost/<sha256-24>.json`). `--list` shows each entry's
timeframe, granularity, grouping, row count, age and freshness. `--clear` warns
that the next query re-spends throttle budget.

```
  fresh   1544fd656d7f MonthToDate  None     (none)      1 rows  0m old
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (including a cache hit) |
| `1` | Any handled error — no tab, no token, expired token, 429 budget exhausted, 400 bad query, 401/403, ambiguous subscription, invalid dimension |

Every failure path prints the remedy, not just the symptom. A 429 in particular
is always reported **as throttling**, never as a generic failure.
