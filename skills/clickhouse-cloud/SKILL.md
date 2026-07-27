---
name: clickhouse-cloud
description: Report on ClickHouse Cloud cost, spend, and utilization via the ClickHouse Cloud console/control-plane API. Use when the user asks about ClickHouse Cloud billing, spend, cost, usage report, compute unit hours, storage cost, data transfer cost, or wants to inspect ClickHouse Cloud services — their size, replica count, memory/autoscaling configuration, state, or region — or to check utilization metrics (CPU, memory, disk/S3 storage, queries per second, connections, network) for a service over time. Activate on mentions of "ClickHouse Cloud cost", "ClickHouse spend", "ClickHouse usage report", "ClickHouse Cloud services", "ClickHouse replicas", "ClickHouse utilization", "ClickHouse metrics", "ClickHouse Cloud billing". For running SQL against a ClickHouse service, use the `klickhaus` skill instead — this skill covers the cloud console (cost + infra + metrics), NOT SQL.
allowed-tools: bash
---

# clickhouse-cloud

Cost and utilization reporting for **ClickHouse Cloud** — the management console
(organizations, service inventory, billing/usage reports, and utilization
metrics). This is distinct from the `klickhaus` skill, which runs SQL against a
ClickHouse service's data plane.

## Setup

The CLI is a `.jsh` script. Register it once per session:

```bash
touch /usr/bin/clickhouse-cloud; hash -r
```

## Auth (page-context, no secrets stored)

The ClickHouse Cloud internal APIs
(`control-plane-internal.clickhouse.cloud`, `console-api-internal.clickhouse.cloud`)
require **both** an `Authorization: Bearer <JWT>` **and** an
`Origin: https://console.clickhouse.cloud` header. SLICC's own `fetch()` sends
`Origin: localhost` and cannot attach the app's live token, so a direct fetch is
CORS/401-rejected.

Instead, every call runs as a **page-context fetch inside the logged-in console
tab** via `playwright-cli eval-file`. The Auth0 access token is read from
`localStorage` in-page and used only there — it is never printed, stored, or
committed. This requires an open, signed-in **console.clickhouse.cloud** tab. If
none is found (or the session expired), the CLI tells the user to sign in at
https://console.clickhouse.cloud and retry.

## Commands

```
clickhouse-cloud orgs                             # list organizations
clickhouse-cloud services [--org ID]              # services: state, tier, replicas, memory, idle scaling
clickhouse-cloud service <svcId> [--org ID]       # full detail for one service
clickhouse-cloud cost [--org ID] [--period P]     # usage/billing report: per-service cost + line items + total
clickhouse-cloud metrics <svcId> [FLAGS]          # utilization summary (min/max/avg/latest)
clickhouse-cloud api <METHOD> <URL> [--body=..]   # raw authenticated passthrough
```

Global flags: `--org=ID` (auto-detected when you have exactly one org),
`--json` (raw JSON instead of a table).

### cost

`getUsageReport` for the current billing period. Prints a per-service cost table,
a grand total, and a per-service line-item breakdown (compute unit hours,
storage TB-months for tables + backups, public/inter-region data transfer,
ClickPipes). `--period` defaults to `BILL_DATE`.

### metrics

Two data sources:

- **Default / `--type=TYPE`** → control-plane `queryMetrics` (per-node
  time-series). This is the reliable source and works even when the console
  time-series is empty. Default batch: `CPU_USAGE_MAX`, `MEMORY_USAGE_MAX`,
  `ALLOCATED_MEMORY`, `S3_STORAGE_USAGE`, `QUERIES_PER_SECOND`.
  `--period` ∈ `LAST_15_MINUTES, LAST_HOUR, LAST_DAY, LAST_WEEK, LAST_MONTH, LAST_YEAR`
  (default `LAST_DAY`). Byte-valued metrics are auto-formatted (GB/TB).
- **`--metric=NAME`** → console-api time-series (`node_chart_max` aggregation,
  times in **unix seconds**). Flags: `--from=SEC --to=SEC --step=SEC --agg=AGG`.
  May return no points when a service is idle/scaled to zero.

See `references/endpoints.md` for the full endpoint surface, the complete list of
instance metric types + console metric names, cost line-item keys, and response
schemas.

## Examples

```bash
clickhouse-cloud cost --org=22dae0af-de0d-46cf-ad85-d0f8b8fcdd94
clickhouse-cloud services --org=22dae0af-de0d-46cf-ad85-d0f8b8fcdd94
clickhouse-cloud metrics 6f3c51d6-c282-421a-a46d-54fc08d4ce99 --org=<org> --period=LAST_WEEK
clickhouse-cloud metrics 6f3c51d6-c282-421a-a46d-54fc08d4ce99 --org=<org> --type=S3_STORAGE_USAGE --period=LAST_MONTH
clickhouse-cloud metrics 6f3c51d6-c282-421a-a46d-54fc08d4ce99 --metric=disk_storage
```
