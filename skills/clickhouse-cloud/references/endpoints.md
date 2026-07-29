# ClickHouse Cloud console API — discovered endpoints

Reverse-engineered from the logged-in console (`console.clickhouse.cloud`) via
page-context fetch + the app JS bundle. Two internal hosts:

- **control-plane** — `https://control-plane-internal.clickhouse.cloud`
- **console-api**   — `https://console-api-internal.clickhouse.cloud`

## Auth

All internal endpoints require **both**:

- `Authorization: Bearer <JWT>` — Auth0 RS256 access token. Lives in
  `localStorage` under the key
  `@@auth0spajs@@::<clientId>::control-plane-web::openid profile email`
  → `JSON.parse(value).body.access_token`.
- `Origin: https://console.clickhouse.cloud` — server validates it.

Because SLICC `fetch()` forces `Origin: localhost` and cannot inject the token,
calls must be made **from the page context** of an open, signed-in console tab
(`playwright-cli eval-file`). Direct Node `fetch()` returns 401 `UNAUTHORIZED`
even with the token; page-context without the token also returns 401 — you need
both. Confirmed live: token + page origin ⇒ 200.

## RPC convention (control-plane)

Control-plane endpoints are POST with `Content-Type: text/plain;charset=UTF-8`.
The body is JSON `{ rpcAction, ...args }` and the action is *also* appended as a
query string, e.g. `POST /api/instance?list` with body `{"rpcAction":"list", ...}`.

---

## Cost / billing — `POST control-plane/api/billing`

`rpcAction` values found in the bundle (billing class):
`getUsageReport`, `getUsageStatement`, `getOrganizationBillingDetails`,
`updateOrganizationBillingDetails`, `updateOrganizationBillingContact`,
`updateOrganizationTier`, `getPricingForAllRegions`, `getMigrationPricing`,
`getSpendAlertConfig`, `updateSpendAlertConfig`, `requestCredits`,
`transferCredits`, `getCreditTransferHistory`, `getClientSecret`,
`confirmUpdatedPaymentMethod`, `handleTackleSubscription`,
`cancelTackleSubscription`, `getTackleEligibleOrganizations`.

### getUsageReport (used by `cost`)

Request:
```json
{ "rpcAction": "getUsageReport", "organizationId": "<orgId>", "usagePeriod": { "type": "BILL_DATE" } }
```

Response `report`:
```
{ organizationId, startDate, endDateExclusive, endDateInclusive, currency,
  dataWarehouseReports: [ {
    organizationTier, cloudProvider, region, id, name, billLocked, deleted, timestamp,
    datawarehouseStorageTBMonthsBackups: { metricValue, cost },
    datawarehouseStorageTBMonthsTables:  { metricValue, cost },
    instanceReports: [ { id, name, profile, dataWarehouseId, cloudProvider, region,
      instanceComputeUnitHours:            { metricValue, cost },
      instancePublicDataTransferGB:        { metricValue, cost },
      instanceInterRegionTier1..4DataTransferGB: { metricValue, cost },
      clickpipeReports: [...], totalClickpipeReport: {...} } ],
    totalInstanceReport: { ...same instance-level line items aggregated... }
  } ],
  pgInstanceReports: [...],           // managed Postgres (empty here)
  totalUsageReport: { ...every line item summed across the org... } }
```

**Cost line-item keys** (each `{ metricValue, cost }`):
`instanceComputeUnitHours`, `instancePublicDataTransferGB`,
`instanceInterRegionTier1DataTransferGB` … `Tier4`,
`datawarehouseStorageTBMonthsBackups`, `datawarehouseStorageTBMonthsTables`,
`clickpipeComputeUnitHours`, `clickpipeDataTransferGB`,
`clickpipeInitialDataTransferGB`, plus `byocInstanceComputeUnitHours` and the
`pgInstance*` family (managed Postgres). Total cost for a service = sum of all
its line-item `cost` values (compute dominates; e.g. a test service was ~$314
period-to-date, of which ~$311 was `instanceComputeUnitHours`).

Storage line items are on the data-warehouse node; compute/transfer are under
`totalInstanceReport` (the `cost` command sums both).

---

## Organizations — `POST control-plane/api/organization`

- `?list` `{ "rpcAction": "list" }` → `{ "<orgId>": { id, name, users, invitations, ... }, ... }`
  (map keyed by org id).
- `?listActivities` `{ rpcAction, organizationId, pagination }` → audit activity.

---

## Services / instances — `POST control-plane/api/instance`

`rpcAction` values (instance class): `list`, `getInstanceDetails`, `create`,
`delete`, `stop`, `start`, `rename`, `warehouseSize`, `updateAutoScaling`,
`saveDefaultAutoscalingConfig`, `updateAutoscalingSchedule`, `getLimits`,
`resetPassword`, `updateIpAccessList`, `updateInstanceState`, `wakeupInstance`,
`updateInstanceBackupConfiguration`, `updateReleaseChannel`,
`startMaintenanceManually`, `updateUpgradeWindow`, `triggerFailover`,
`triggerRecovery`, and many more.

### list (used by `services`)

`{ "rpcAction": "list", "organizationId": "<orgId>" }` → `{ instances: [ ... ] }`.

Instance object keys (relevant to size/replicas/scaling):
```
id, name, state, regionId, cloudProvider, clickhouseVersion, instanceTier,
minReplicas, maxReplicas,                       // replica autoscaling range
minAutoScalingReplicaMemory, maxAutoScalingReplicaMemory,  // per-replica RAM (GB)
minRequiredMemoryGb, customAutoscaleReplicaMemoryValues, autoscalingMode,
enableIdleScaling, idleTimeoutMinutes,          // scale-to-zero config
releaseChannel, dataWarehouseId, isPrimary, isReadonly, database,
endpoints{ https{hostname,port}, nativesecure{hostname,port} },
lastBackupStarted, ipAccessList, backupConfiguration, maintenanceWindows,
creationDate, features[...]
```

### getInstanceDetails

`{ rpcAction:"getInstanceDetails", organizationId, instanceId }` → low-level infra
detail (`iamPrincipal`, cross-tenant ids). The replica/memory config comes from
`list`, not here.

---

## Utilization metrics

### Control-plane batch — `POST control-plane/api/metrics/queryMetrics` (used by `metrics` default / `--type`)

```json
{ "organizationId": "<org>", "instanceId": "<svc>",
  "batch": [ { "type": "CPU_USAGE_MAX", "timePeriod": "LAST_DAY" } ] }
```
Response: `{ batch: [ { type, timePeriod, data: [ [ { node, data: [[tsMs, value], ...] }, ... ] ] } ] }`.
Values can be `null` while a service is idle. (There is also `queryMetricsV2`
and `queryInsights` on the same base.)

**`type` values** (LAST_15_MINUTES | LAST_HOUR | LAST_DAY | LAST_WEEK | LAST_MONTH | LAST_YEAR):
```
CPU_USAGE, CPU_USAGE_MAX, CPU_WAIT, ALLOCATED_CPU_NODE,
OS_USER_CPU_USAGE_NORMALIZED, OS_KERNEL_CPU_USAGE_NORMALIZED,
CGROUP_USER_CPU_USAGE, CGROUP_KERNEL_CPU_USAGE,
MEMORY_USAGE, MEMORY_USAGE_MAX, MEMORY_TRACKED_BYTES,
ALLOCATED_MEMORY, ALLOCATED_MEMORY_NODE,
S3_STORAGE_USAGE, QUERIES_PER_SECOND, SELECTED_BYTES_PER_SEC,
S3_READ_WAIT, S3_READ_ERRORS_PER_SEC, S3_DISK_READ_REQ_PER_SEC, S3_DISK_WRITE_REQ_PER_SEC,
READ_FROM_DISK_BYTES_PER_SEC, READ_FROM_FS_BYTES_PER_SEC, READ_FROM_S3_BYTES_PER_SECOND,
NETWORK_RECEIVE_BYTES_PER_SEC, NETWORK_SEND_BYTES_PER_SEC,
CONCURENT_TCP_CONNECTIONS, CONCURENT_MYSQL_CONNECTIONS, CONCURENT_HTTP_CONNECTIONS
```
(also ClickPipe variants: `CLICKPIPE_CPU_USAGE`, `CLICKPIPE_MEMORY_USAGE`,
`CLICKPIPE_CPU_LIMITS`, `CLICKPIPE_MEMORY_LIMITS`.)

Byte-valued types (formatted GB/TB by the CLI): `S3_STORAGE_USAGE`,
`ALLOCATED_MEMORY(_NODE)`, `MEMORY_USAGE(_MAX)`, `MEMORY_TRACKED_BYTES`,
`SELECTED_BYTES_PER_SEC`, `READ_FROM_*_BYTES_PER_SEC(OND)`, `NETWORK_*_BYTES_PER_SEC`.

### Console time-series — `POST console-api/.api/metrics` (used by `metrics --metric`)

```json
{ "query": { "aggregation": "node_chart_max", "aggregationPeriod": 3600,
             "startTime": <unixSeconds>, "endTime": <unixSeconds>, "metric": "disk_storage" },
  "serviceId": "<svc>" }
```
**Times are in unix SECONDS** (ms → 500 error). Response:
`{ metrics: { boundaries:{xMin,xMax,yMin,yMax}, series:[{ name, values:[{x,y}] }] } }`.
`aggregation` ∈ `node_chart_avg | node_chart_max | node_chart_sum | node_chart_p50 |
node_chart_p90 | node_chart_p95 | node_chart_p99` (also `chart_last` for
autoscaling). Returns empty `series` when a service is idle/scaled to zero.

**`metric` names:**
```
resident_memory_without_page_cache, server_usage_cores, cluster_size_active_replicas,
allocated_memory, allocated_cpu, recommendation_desired_memory,
merges_finished, merges_failed, current_merges, created_mutations, current_mutations,
disk_storage, selected_bytes, inserted_bytes, select_query, insert_query,
successful_all_query, failed_all_query, selected_rows, inserted_rows,
ingress_data_transfer, egress_data_transfer, attached_databases, attached_tables,
total_parts_of_merge_tree_tables
```

Related console-api endpoints on the same `${apiUrl}` base:
`/.api/metrics` (scalar variant `consoleMetricsScalarUrl`), `/.api/autoscaling`
(scaling config; needs specific params — returned 403 with a bare `serviceId`),
`/.api/services/<svcId>`, `/.api/query-endpoints`, `/.api/savedQuery`,
`/.api/clickpipes/v1`, `/.api/env`, `/.api/ubicloud/postgres`.

---

## SQL query proxy — `POST queries.clickhouse.cloud/service/<serviceId>/run` (used by `query`)

The Cloud **SQL console** runs statements through a dedicated query proxy on a
separate host (`queries.clickhouse.cloud`, *not* the `*-internal` control-plane).
It is authenticated with the **same Auth0 bearer token** as everything else — so
no database username/password is needed.

```
POST https://queries.clickhouse.cloud/service/<serviceId>/run
       ?enable_http_compression=1&format=JSONEachRowWithProgress&request_timeout=3600000
Authorization: Bearer <auth0 access_token>
Content-Type:  text/plain;charset=UTF-8

body: { "runId": "liveQueries:<uuid>", "sql": "<SQL>", "database": "default" }
```

Response is **newline-delimited** JSON (`JSONEachRowWithProgress`): interleaved
`{"progress":{…}}` lines, one `{"meta":[{name,type},…]}` line, then a
`{"row":{…}}` line per result row; a query error arrives as `{"exception":"…"}`
(HTTP 200) or as an HTTP 400 with `{"error":{"code","details"}}`. The console
wraps system-table reads in `clusterAllReplicas(default, 'system.<table>')` to
span all replicas, and tags its own internal queries with
`Settings['log_comment']='sql console internal query'` (filter these out when
inspecting `system.query_log`). `queries.clickhouse.cloud` is in the CLI's
allowed-host set alongside the two `*-internal` hosts.

---

## Other control-plane RPC endpoints (not wired into the CLI, reachable via `api`)

- `/api/account` — user/account RPCs (`addUserToCloudWaitlist`, `listOrganizations`
  via `{rpcAction:"list"}`, invitations, `changeUserRole`, `leave`, Stripe linking…).
- `/api/notification` — `getNotifications`, `getLastUINotifications`,
  `getChannelSettings`, Slack channel settings, `updateMarkAsRead`.
- `/api/autoScaling` — autoscaling RPCs.
- `/api/galaxy` — telemetry (`sendGalaxyForensicEvent`); ignore.

## Notes

- Discovery was done live (the recorded HAR lives on the tray and was not
  reachable from the scoop filesystem); the endpoint list came from the app's
  `performance.getEntriesByType('resource')` plus grepping the JS bundle for
  `rpcAction:"..."`, metric enums, and URL builders, then validated with live
  calls against org `22dae0af-…` / service `6f3c51d6-…`.
- Test IDs: org `22dae0af-de0d-46cf-ad85-d0f8b8fcdd94`,
  service `6f3c51d6-c282-421a-a46d-54fc08d4ce99`.
