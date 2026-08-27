---
name: azure
description: >-
  Query Azure subscriptions and Azure Cost Management from the command line,
  authenticated by piggybacking an open logged-in portal.azure.com tab — no
  service principal, no `az login`. `az` mirrors the real Azure CLI
  (`az account list/show/set`, `az rest` raw ARM passthrough); the sibling
  `az-ext cost` adds what it lacks — monthly spend summaries, SKU and service
  breakdowns, a month-to-date fast path, and a PublisherType split separating
  Azure-native infrastructure from third-party Marketplace software resold through
  Azure billing. Handles Cost Management’s undocumented throttling (~1 historical
  query per 5 minutes, HTTP 429, no Retry-After) with disk caching and time-based
  backoff. Use for Azure spend, costs, billing or invoices, Azure subscriptions,
  Cost Management, ARM / management.azure.com, Azure Marketplace charges, or a
  ClickHouse/SaaS charge on an Azure bill. Not AWS, not GCP, not Microsoft 365 or
  Entra admin; subscriptions plus Cost Management, not a general VM/AKS
  resource-management CLI.
allowed-tools: bash
command: az
script: scripts/az.jsh
---

# Azure — subscriptions and Cost Management via the portal tab

Two binaries. **`az`** mirrors the real Azure CLI's command and flag names
(`az account list`, `az rest --method --url`) against `https://management.azure.com`,
so copied docs and muscle memory transfer. **`az-ext cost`** holds what the real
CLI has no equivalent for: cost analysis that survives Azure's throttling.

There is no `az` binary and no service principal here. Auth borrows the ARM token
an open, signed-in **`portal.azure.com`** tab already holds in MSAL
`sessionStorage`. It is validated locally, stored, and **never printed**.

## Quick start

```bash
az login --from-tab                 # harvest the ARM token from the portal tab
az account list                     # subscriptions this session can reach
az account set --subscription "Helix PRD"

az-ext cost mtd                     # month to date — the CHEAP query, start here
az-ext cost summary --months 13     # monthly totals + regime-break warning
az-ext cost marketplace             # Azure-native vs third-party Marketplace spend
az-ext cost sku                     # MeterCategory / MeterSubCategory
az-ext cost cache --list            # what is already answered for free
```

If login reports the token **expired**, that is normal — MSAL refreshes lazily, so
an idle portal tab keeps a stale one. Click into a blade that needs ARM
(Subscriptions, or Cost Management → Cost analysis) and re-run, or use
`az login --from-tab --wait 60` to poll while you do.

## Read this before running a cost query

Cost Management is **aggressively throttled and the limit is undocumented.**
Measured: roughly **one historical query per five minutes** per subscription,
answered `HTTP 429 {"error":{"code":"429","message":"Too many requests. Please
retry."}}` with **no `Retry-After` and no rate-limit header** — so backoff must be
time-based. The skill is built around not spending that budget twice:

- **Every successful response is cached to disk**, keyed on subscription + exact
  query body. Measured: the same `cost mtd` took **2m44s** cold and **0.082s**
  warm with zero ARM requests. The most valuable mitigation by far — reruns,
  re-renders and `--json` are free.
- **429s back off visibly** (20s, 45s, 90s, 180s, 300s…) printing the remaining
  `--max-wait` budget, and are always reported *as throttling*, never as a
  generic failure.
- **`az-ext cost mtd`** uses the far cheaper `MonthToDate` + `granularity: None`
  shape and often succeeds while history is throttled. Reach for it first.
- **`az-ext cost dimensions`** validates a grouping name for zero quota, rather
  than spending a throttled request to learn `PublisherName` does not exist.

Full detail incl. the measured 364-day cap:
[`cost-management-gotchas.md`](references/cost-management-gotchas.md).

## The PublisherType insight

Grouping one real subscription by `MeterCategory` left **$14,467 — 61% of spend —
in a bucket called "Unassigned"**, which reads as missing data worth
investigating. Re-grouping by **`PublisherType`** explains it instantly:

| PublisherType | 12 months to 2026-08 | Share |
|---|---|---|
| `Marketplace` | $22,725.00 | **97.0%** |
| `Azure` | $696.13 | 3.0% |

It was third-party SaaS resold through Azure billing — in the same subscription,
`Marketplace / SaaS` was **ClickHouse Cloud at $8,258**. Azure-native
infrastructure (Functions $524.92, Service Bus $60.58, App Service $51.57,
Storage $39.82, and six smaller meters) came to **$696.13 for the whole year** —
less than four days of the ClickHouse charge.

This is not a footnote: "optimise your Azure spend" is meaningless when 97% of it
is a SaaS contract that no Azure lever touches. `az-ext cost marketplace` makes
that split the default view and attributes vendors from `ResourceId` where it
can. Rows with no `PublisherType` go to an explicit `unknown` bucket rather than
being quietly counted as Azure.

## Workflows

**"Why is this subscription expensive?"** — `cost mtd` for a cheap current
number, then `cost marketplace` to learn whether you are even looking at Azure.
Only if it is mostly Azure-native are `cost sku` / `cost services` worth a query.

**"Is spend growing?"** — `cost summary --months 13`, and heed the regime-break
warning: on the measured series a Marketplace subscription switching on in
2026-01 produced a **310× month-on-month step**, and a naive full-history growth
fit returns **+98,766 %/yr** — an artefact of regressing across a step change.

**"Throttled and blocked."** — `cost cache --list` first (the answer may already
be there), then `cost mtd`, then wait five minutes or raise `--max-wait`. Never
loop `az rest`: no cache, no backoff.

**Anything not wrapped** — `az rest --method GET --api-version 2021-04-01
--url /subscriptions/<id>/resourceGroups`.

## Reference

- [`references/COMMANDS.md`](references/COMMANDS.md) — every command, every flag,
  exit codes.
- [`references/arm-auth.md`](references/arm-auth.md) — the MSAL `sessionStorage`
  harvest, why audience selection on `management.core.windows.net` is the whole
  trick (a live tab held 10 access tokens, only 2 for ARM), expiry handling, the
  CDP size cap, and the never-print rule.
- [`references/cost-management-gotchas.md`](references/cost-management-gotchas.md)
  — throttling budget and caching strategy, the measured 364-day cap, the 34 valid
  grouping dimensions, the PublisherType/Marketplace analysis, and why
  `properties.rows` must be mapped by column **name** and never by index.

## Don't

- Don't expect unattended operation: a human must be signed into the portal and
  the token dies in ~1 hour. Interactive reader credential, not a CI principal.
- Don't print, log or pass the token on a command line — argv is visible to `ps`.
- Don't index `properties.rows` positionally; column order is not stable.
- Don't ask for more than **364** days per query — Cost Management counts
  `timePeriod` inclusively, so 365 days is already rejected. And don't chunk a long
  range "to be gentle": each chunk costs a full unit of the same throttle budget.
- Don't read a big `(unassigned)` MeterCategory bucket as missing data. Check
  `PublisherType` first.
