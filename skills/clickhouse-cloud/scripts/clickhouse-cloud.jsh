// clickhouse-cloud — cost & utilization reporting for ClickHouse Cloud.
//
// This is the *console / control-plane* API (org billing, service inventory,
// utilization metrics) — NOT the SQL data-plane (see the `klickhaus` skill for
// running SQL against a ClickHouse service).
//
// Auth model (see references/endpoints.md): the internal APIs
// (control-plane-internal.clickhouse.cloud, console-api-internal.clickhouse.cloud)
// require BOTH an `Authorization: Bearer <JWT>` AND an
// `Origin: https://console.clickhouse.cloud` header. SLICC's own fetch() sends
// Origin: localhost and cannot attach the app's live token, so every call runs
// as a page-context fetch INSIDE the logged-in console tab via
// `playwright-cli eval-file`. The Auth0 access token is read from localStorage
// in-page and never leaves the browser / is never printed.

const exec = require('sliccy:exec');
const fs   = require('fs');

// ─── Constants ───────────────────────────────────────────────────────────────

const CONSOLE_HOST = 'console.clickhouse.cloud';
const CP  = 'https://control-plane-internal.clickhouse.cloud'; // control-plane
const CA  = 'https://console-api-internal.clickhouse.cloud';   // console-api

// console-api /.api/metrics time-series metric names (aggregation node_chart_max,
// times in SECONDS). Discovered from the console bundle.
const CONSOLE_METRICS = [
  'resident_memory_without_page_cache', 'server_usage_cores',
  'cluster_size_active_replicas', 'allocated_memory', 'recommendation_desired_memory',
  'allocated_cpu', 'merges_finished', 'merges_failed', 'current_merges',
  'created_mutations', 'current_mutations', 'disk_storage', 'selected_bytes',
  'inserted_bytes', 'select_query', 'insert_query', 'successful_all_query',
  'failed_all_query', 'selected_rows', 'inserted_rows', 'ingress_data_transfer',
  'egress_data_transfer', 'attached_databases', 'attached_tables',
  'total_parts_of_merge_tree_tables',
];

// control-plane /api/metrics/queryMetrics batch types.
const INSTANCE_METRIC_TYPES = [
  'S3_STORAGE_USAGE', 'ALLOCATED_MEMORY', 'ALLOCATED_MEMORY_NODE', 'MEMORY_USAGE',
  'MEMORY_USAGE_MAX', 'MEMORY_TRACKED_BYTES', 'ALLOCATED_CPU_NODE', 'CPU_USAGE',
  'CPU_USAGE_MAX', 'CPU_WAIT', 'OS_USER_CPU_USAGE_NORMALIZED',
  'OS_KERNEL_CPU_USAGE_NORMALIZED', 'CGROUP_USER_CPU_USAGE', 'CGROUP_KERNEL_CPU_USAGE',
  'QUERIES_PER_SECOND', 'SELECTED_BYTES_PER_SEC', 'S3_READ_WAIT',
  'S3_READ_ERRORS_PER_SEC', 'READ_FROM_DISK_BYTES_PER_SEC', 'READ_FROM_FS_BYTES_PER_SEC',
  'READ_FROM_S3_BYTES_PER_SECOND', 'S3_DISK_WRITE_REQ_PER_SEC', 'S3_DISK_READ_REQ_PER_SEC',
  'NETWORK_RECEIVE_BYTES_PER_SEC', 'NETWORK_SEND_BYTES_PER_SEC',
  'CONCURENT_TCP_CONNECTIONS', 'CONCURENT_MYSQL_CONNECTIONS', 'CONCURENT_HTTP_CONNECTIONS',
];
const TIME_PERIODS = ['LAST_15_MINUTES', 'LAST_HOUR', 'LAST_DAY', 'LAST_WEEK', 'LAST_MONTH', 'LAST_YEAR'];

// Bytes-valued instance metric types (for human formatting).
const BYTE_TYPES = new Set([
  'S3_STORAGE_USAGE', 'ALLOCATED_MEMORY', 'ALLOCATED_MEMORY_NODE', 'MEMORY_USAGE',
  'MEMORY_USAGE_MAX', 'MEMORY_TRACKED_BYTES', 'SELECTED_BYTES_PER_SEC',
  'READ_FROM_DISK_BYTES_PER_SEC', 'READ_FROM_FS_BYTES_PER_SEC',
  'READ_FROM_S3_BYTES_PER_SECOND', 'NETWORK_RECEIVE_BYTES_PER_SEC', 'NETWORK_SEND_BYTES_PER_SEC',
]);

// ─── Tab management ────────────────────────────────────────────────────────────

let _tabId = null;

// Probe a tab: does it hold a live control-plane-web Auth0 access token?
async function tabHasToken(tabId) {
  const probe = '(() => { try { const k = Object.keys(localStorage).find(k => k.startsWith("@@auth0spajs@@") && k.includes("control-plane-web")); return k && JSON.parse(localStorage.getItem(k)).body.access_token ? "yes" : "no"; } catch (e) { return "no"; } })()';
  const tmp = '/shared/.chc_probe_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.js';
  await fs.writeFile(tmp, probe);
  let r;
  try { r = await exec('playwright-cli eval-file ' + tmp + ' --tab=' + tabId); }
  finally { await fs.rm(tmp).catch(function () {}); }
  return r.exitCode === 0 && /yes/.test(r.stdout || '');
}

async function findTab() {
  const list = await exec('playwright-cli tab-list');
  const stdout = list.stdout || '';
  if (_tabId && stdout.includes(_tabId)) return _tabId;
  _tabId = null;

  // Collect every open console.clickhouse.cloud tab.
  const re = new RegExp('\\[([A-F0-9]+)\\]\\s+https?://[^\\s]*' + CONSOLE_HOST.replace(/\./g, '\\.'), 'g');
  const candidates = [];
  let m = re.exec(stdout);
  while (m !== null) {
    candidates.push(m[1]);
    m = re.exec(stdout);
  }

  if (!candidates.length) {
    console.error('No logged-in ClickHouse Cloud console tab found.');
    console.error('Open https://' + CONSOLE_HOST + ' and sign in, then retry.');
    process.exit(1);
  }
  // Prefer a tab that actually carries a live token (tabs can be mid-reload).
  for (const c of candidates) {
    if (await tabHasToken(c)) { _tabId = c; return _tabId; }
  }
  // Fall back to the first candidate; apiCall surfaces a clear no-token error.
  _tabId = candidates[0];
  return _tabId;
}

// ─── Page-context API call (token stays in the browser) ─────────────────────────

async function apiCall(method, url, body, ctype) {
  const tabId = await findTab();
  const bodyJson = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const code = [
    '(async () => {',
    '  const key = Object.keys(localStorage).find(k => k.startsWith("@@auth0spajs@@") && k.includes("control-plane-web"));',
    '  if (!key) return JSON.stringify({ __error: "no-token" });',
    '  let tok; try { tok = JSON.parse(localStorage.getItem(key)).body.access_token; } catch (e) {}',
    '  if (!tok) return JSON.stringify({ __error: "no-token" });',
    '  const h = { "authorization": "Bearer " + tok };',
    '  const bodyStr = ' + JSON.stringify(bodyJson) + ';',
    '  if (bodyStr != null) h["content-type"] = ' + JSON.stringify(ctype || 'text/plain;charset=UTF-8') + ';',
    '  const opts = { method: ' + JSON.stringify(method) + ', credentials: "include", headers: h };',
    '  if (bodyStr != null) opts.body = bodyStr;',
    '  try {',
    '    const r = await fetch(' + JSON.stringify(url) + ', opts);',
    '    const t = await r.text();',
    '    return JSON.stringify({ status: r.status, body: t });',
    '  } catch (e) { return JSON.stringify({ __error: "fetch-failed", detail: String(e) }); }',
    '})()',
  ].join('\n');

  const tmp = '/shared/.chc_eval_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.js';
  await fs.writeFile(tmp, code);
  let result;
  try {
    result = await exec('playwright-cli eval-file ' + tmp + ' --tab=' + tabId);
  } finally {
    await fs.rm(tmp).catch(function () {});
  }
  if (result.exitCode !== 0) {
    throw new Error('page-context eval failed: ' + (result.stderr || result.stdout || 'unknown'));
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim()); }
  catch (e) { throw new Error('Could not parse eval output: ' + result.stdout.slice(0, 300)); }

  if (parsed.__error === 'no-token') {
    console.error('Console session token not found. Sign in at https://' + CONSOLE_HOST + ' and retry.');
    process.exit(1);
  }
  if (parsed.__error) throw new Error('API call error: ' + parsed.__error + ' ' + (parsed.detail || ''));

  if (parsed.status === 401 || parsed.status === 403) {
    console.error('Unauthorized (' + parsed.status + '). Console session may have expired — re-open ' +
      'https://' + CONSOLE_HOST + ' and retry.');
    process.exit(1);
  }
  if (parsed.status >= 400) {
    throw new Error('HTTP ' + parsed.status + ': ' + String(parsed.body).slice(0, 300));
  }
  let json;
  try { json = JSON.parse(parsed.body); }
  catch (e) { return parsed.body; }
  return json;
}

// RPC helpers (control-plane appends ?<action> and echoes rpcAction in the body)
function rpc(base, action, extra) {
  return apiCall('POST', base + '?' + action, Object.assign({ rpcAction: action }, extra || {}));
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) { opts[a.slice(2)] = next; i++; }
        else opts[a.slice(2)] = true;
      }
    } else pos.push(a);
  }
  return { opts, pos };
}

// ─── Formatting ────────────────────────────────────────────────────────────────

function money(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function num(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d == null ? 3 : d }); }
function bytes(n) {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 2) + ' ' + u[i];
}
function pad(s, w) { s = String(s); return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function table(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r) == null ? '-' : c.get(r)).length)));
  const line = cols.map((c, i) => pad(c.label, widths[i])).join('  ');
  console.log(line);
  console.log(cols.map((c, i) => '-'.repeat(widths[i])).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => pad(c.get(r) == null ? '-' : c.get(r), widths[i])).join('  '));
}

// ─── Org resolution ─────────────────────────────────────────────────────────────

async function listOrgs() {
  const res = await rpc(CP + '/api/organization', 'list');
  // response: { <orgId>: { id, name, ... }, ... }
  return Object.values(res).map(o => ({ id: o.id, name: o.name, tier: o.tier || o.organizationTier }));
}

async function resolveOrg(opts) {
  if (opts.org) return opts.org;
  const orgs = await listOrgs();
  if (orgs.length === 1) return orgs[0].id;
  if (orgs.length === 0) { console.error('No organizations found for this account.'); process.exit(1); }
  console.error('Multiple organizations — specify --org=<id>:');
  for (const o of orgs) console.error('  ' + o.id + '  ' + o.name);
  process.exit(1);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdOrgs(opts) {
  const orgs = await listOrgs();
  if (opts.json) { console.log(JSON.stringify(orgs, null, 2)); return; }
  table(orgs, [
    { label: 'ID', get: r => r.id },
    { label: 'NAME', get: r => r.name },
    { label: 'TIER', get: r => r.tier || '-' },
  ]);
}

async function listInstances(orgId) {
  const res = await rpc(CP + '/api/instance', 'list', { organizationId: orgId });
  return (res && res.instances) || [];
}

function replicaSummary(i) {
  const min = i.minReplicas, max = i.maxReplicas;
  return min === max ? String(min) : min + '-' + max;
}
function memSummary(i) {
  const min = i.minAutoScalingReplicaMemory, max = i.maxAutoScalingReplicaMemory;
  if (min == null && max == null) return '-';
  return (min === max ? String(min) : min + '-' + max) + ' GB';
}

async function cmdServices(opts) {
  const orgId = await resolveOrg(opts);
  const insts = await listInstances(orgId);
  if (opts.json) { console.log(JSON.stringify(insts, null, 2)); return; }
  if (!insts.length) { console.log('No services in org ' + orgId); return; }
  table(insts, [
    { label: 'NAME', get: r => r.name },
    { label: 'ID', get: r => r.id },
    { label: 'STATE', get: r => r.state },
    { label: 'TIER', get: r => r.instanceTier || '-' },
    { label: 'REGION', get: r => r.regionId },
    { label: 'VERSION', get: r => r.clickhouseVersion },
    { label: 'REPLICAS', get: r => replicaSummary(r) },
    { label: 'MEM/REPLICA', get: r => memSummary(r) },
    { label: 'IDLE', get: r => (r.enableIdleScaling ? (r.idleTimeoutMinutes + 'm') : 'off') },
  ]);
  console.log('\nReplicas shown as min-max (autoscaling range). MEM/REPLICA is per-replica RAM range.');
}

async function cmdService(pos, opts) {
  const svcId = pos[0];
  if (!svcId) { console.error('Usage: clickhouse-cloud service <serviceId> [--org=ID]'); process.exit(1); }
  const orgId = await resolveOrg(opts);
  const insts = await listInstances(orgId);
  const inst = insts.find(i => i.id === svcId);
  if (!inst) { console.error('Service ' + svcId + ' not found in org ' + orgId); process.exit(1); }
  if (opts.json) { console.log(JSON.stringify(inst, null, 2)); return; }
  const fields = [
    ['Name', inst.name], ['ID', inst.id], ['State', inst.state], ['Tier', inst.instanceTier],
    ['Provider', inst.cloudProvider], ['Region', inst.regionId], ['Version', inst.clickhouseVersion],
    ['Replicas (min-max)', replicaSummary(inst)], ['Memory/replica', memSummary(inst)],
    ['Min required memory', (inst.minRequiredMemoryGb != null ? inst.minRequiredMemoryGb + ' GB' : '-')],
    ['Idle scaling', inst.enableIdleScaling ? ('on (' + inst.idleTimeoutMinutes + ' min)') : 'off'],
    ['Autoscaling mode', inst.autoscalingMode || '-'],
    ['Release channel', inst.releaseChannel || '-'],
    ['Endpoint', inst.endpoints && inst.endpoints.https ? inst.endpoints.https.hostname : '-'],
  ];
  const w = Math.max(...fields.map(f => f[0].length));
  for (const [k, v] of fields) console.log(pad(k, w) + '  ' + (v == null ? '-' : v));
}

// Recursively collect all { key: { metricValue, cost } } line items from a report node.
function collectLineItems(node, out) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object' && 'cost' in v && 'metricValue' in v) {
      out[k] = { metricValue: (out[k] ? out[k].metricValue : 0) + v.metricValue, cost: (out[k] ? out[k].cost : 0) + v.cost };
    }
  }
}

async function cmdCost(opts) {
  const orgId = await resolveOrg(opts);
  const period = opts.period || 'BILL_DATE';
  const res = await rpc(CP + '/api/billing', 'getUsageReport', { organizationId: orgId, usagePeriod: { type: period } });
  const report = res.report || res;
  if (opts.json) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('ClickHouse Cloud usage report');
  console.log('Org:      ' + report.organizationId);
  console.log('Period:   ' + report.startDate + '  ->  ' + report.endDateInclusive + '  (' + period + ')');
  console.log('Currency: ' + report.currency);
  console.log('');

  const svcRows = [];
  let grandTotal = 0;
  for (const dw of (report.dataWarehouseReports || [])) {
    const items = {};
    collectLineItems(dw, items);                    // storage line items live on the warehouse
    collectLineItems(dw.totalInstanceReport, items); // compute/transfer aggregated across instances
    let dwTotal = 0;
    for (const k of Object.keys(items)) dwTotal += items[k].cost;
    grandTotal += dwTotal;
    svcRows.push({ name: dw.name, provider: dw.cloudProvider, region: dw.region, tier: dw.organizationTier, total: dwTotal, items });
  }

  table(svcRows, [
    { label: 'SERVICE', get: r => r.name },
    { label: 'TIER', get: r => r.tier },
    { label: 'REGION', get: r => r.region },
    { label: 'COST', get: r => money(r.total) },
  ]);
  console.log('');
  console.log('TOTAL: ' + money(grandTotal) + ' ' + report.currency + ' (period to date)');

  // Per-service line-item detail
  for (const s of svcRows) {
    const entries = Object.entries(s.items).filter(([, v]) => v.cost > 0 || v.metricValue > 0);
    if (!entries.length) continue;
    console.log('\n' + s.name + ' — line items:');
    const rows = entries.sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => ({ k, v }));
    table(rows, [
      { label: 'LINE ITEM', get: r => r.k },
      { label: 'USAGE', get: r => num(r.v.metricValue) },
      { label: 'COST', get: r => money(r.v.cost) },
    ]);
  }
}

// ── Utilization ──

function seriesStats(values) {
  const nn = values.filter(v => v != null && !isNaN(v));
  if (!nn.length) return { points: values.length, nonNull: 0, min: null, max: null, avg: null, latest: null };
  return {
    points: values.length, nonNull: nn.length,
    min: Math.min(...nn), max: Math.max(...nn),
    avg: nn.reduce((a, b) => a + b, 0) / nn.length,
    latest: nn[nn.length - 1],
  };
}

// queryMetrics data shape: batch[].data = [ [ {node, data:[[tsMs,val],...]}, ... ] ]
function flattenQueryMetrics(data) {
  const vals = [];
  const walk = (x) => {
    if (Array.isArray(x)) {
      if (x.length === 2 && typeof x[0] === 'number') vals.push(x[1]);
      else { for (const el of x) walk(el); }
    } else if (x && x.data) walk(x.data);
  };
  walk(data);
  return vals;
}

async function cmdMetrics(pos, opts) {
  const svcId = pos[0];
  if (!svcId) { console.error('Usage: clickhouse-cloud metrics <serviceId> [--type TYPE | --metric NAME] [--period LAST_DAY] [--org ID]'); process.exit(1); }

  // Console time-series endpoint (--metric)
  if (opts.metric) {
    const metric = opts.metric === true ? 'disk_storage' : opts.metric;
    const now = Math.floor(Date.now() / 1000);
    const endTime = opts.to ? parseInt(opts.to) : now;
    const startTime = opts.from ? parseInt(opts.from) : (endTime - 86400);
    const aggregationPeriod = opts.step ? parseInt(opts.step) : 3600;
    const aggregation = opts.agg || 'node_chart_max';
    const res = await apiCall('POST', CA + '/.api/metrics',
      { query: { aggregation, aggregationPeriod, endTime, metric, startTime }, serviceId: svcId },
      'text/plain;charset=UTF-8');
    const m = res.metrics || {};
    if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }
    console.log('Console metric: ' + metric + '  service ' + svcId);
    console.log('Window: ' + new Date(startTime * 1000).toISOString() + '  ->  ' + new Date(endTime * 1000).toISOString());
    const series = m.series || [];
    if (!series.length) { console.log('No data points (service may be idle / scaled to zero).'); return; }
    for (const s of series) {
      const st = seriesStats((s.values || []).map(p => p.y));
      console.log('  ' + (s.name || 'series') + ': min ' + num(st.min) + '  max ' + num(st.max) + '  avg ' + num(st.avg) + '  latest ' + num(st.latest) + '  (' + st.nonNull + '/' + st.points + ' pts)');
    }
    return;
  }

  // control-plane queryMetrics batch (--type, default a curated set)
  const orgId = await resolveOrg(opts);
  const period = opts.period || 'LAST_DAY';
  if (TIME_PERIODS.indexOf(period) === -1) { console.error('Invalid --period. Valid: ' + TIME_PERIODS.join(', ')); process.exit(1); }
  let types;
  if (opts.type) types = [opts.type === true ? 'CPU_USAGE_MAX' : opts.type];
  else types = ['CPU_USAGE_MAX', 'MEMORY_USAGE_MAX', 'ALLOCATED_MEMORY', 'S3_STORAGE_USAGE', 'QUERIES_PER_SECOND'];

  const res = await apiCall('POST', CP + '/api/metrics/queryMetrics',
    { organizationId: orgId, instanceId: svcId, batch: types.map(t => ({ type: t, timePeriod: period })) });
  if (opts.json) { console.log(JSON.stringify(res, null, 2)); return; }

  console.log('Utilization for service ' + svcId + '  (' + period + ')\n');
  const rows = (res.batch || []).map(item => {
    const st = seriesStats(flattenQueryMetrics(item.data));
    const fmt = BYTE_TYPES.has(item.type) ? bytes : (v => v == null ? '-' : num(v));
    return { type: item.type, min: fmt(st.min), max: fmt(st.max), avg: fmt(st.avg), latest: fmt(st.latest), n: st.nonNull + '/' + st.points };
  });
  table(rows, [
    { label: 'METRIC', get: r => r.type },
    { label: 'MIN', get: r => r.min },
    { label: 'MAX', get: r => r.max },
    { label: 'AVG', get: r => r.avg },
    { label: 'LATEST', get: r => r.latest },
    { label: 'POINTS', get: r => r.n },
  ]);
}

async function cmdApi(pos, opts) {
  const method = (pos[0] || 'GET').toUpperCase();
  const url = pos[1];
  if (!url) { console.error('Usage: clickhouse-cloud api <METHOD> <URL> [--body=JSON] [--ctype=...]'); process.exit(1); }
  const body = opts.body === true ? null : (opts.body || null);
  const res = await apiCall(method, url, body, opts.ctype === true ? undefined : opts.ctype);
  console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 2));
}

function showHelp() {
  console.log('clickhouse-cloud — ClickHouse Cloud cost & utilization reporting\n');
  console.log('(Console/control-plane API — for SQL queries use the `klickhaus` skill.)\n');
  console.log('Commands:');
  console.log('  orgs                             List organizations');
  console.log('  services [--org ID]              List services (state, tier, replicas, memory, idle)');
  console.log('  service <svcId> [--org ID]       Full detail for one service');
  console.log('  cost [--org ID] [--period P]     Usage/billing report: per-service cost + line items');
  console.log('  metrics <svcId> [FLAGS]          Utilization summary (min/max/avg/latest)');
  console.log('  api <METHOD> <URL> [--body=..]   Raw authenticated passthrough\n');
  console.log('Global flags:');
  console.log('  --org=ID       Organization id (auto-detected if you have exactly one)');
  console.log('  --json         Emit raw JSON instead of a formatted table\n');
  console.log('cost flags:');
  console.log('  --period=P     BILL_DATE (default). Billing usage period type.\n');
  console.log('metrics flags:');
  console.log('  --type=TYPE    control-plane instance metric (default: a curated batch)');
  console.log('  --period=P     ' + TIME_PERIODS.join(', ') + ' (default LAST_DAY)');
  console.log('  --metric=NAME  console time-series metric (e.g. disk_storage); times in seconds');
  console.log('  --from=SEC --to=SEC --step=SEC   window for --metric (unix seconds)');
  console.log('  --agg=AGG      console aggregation (default node_chart_max)\n');
  console.log('  instance metric types: ' + INSTANCE_METRIC_TYPES.slice(0, 8).join(', ') + ', ...');
  console.log('  console metrics:       ' + CONSOLE_METRICS.slice(0, 8).join(', ') + ', ...');
  console.log('  (see references/endpoints.md for the full lists)\n');
  console.log('Examples:');
  console.log('  clickhouse-cloud cost');
  console.log('  clickhouse-cloud services');
  console.log('  clickhouse-cloud metrics 6f3c51d6-c282-421a-a46d-54fc08d4ce99 --period=LAST_WEEK');
  console.log('  clickhouse-cloud metrics <svc> --type=S3_STORAGE_USAGE --period=LAST_MONTH');
  console.log('  clickhouse-cloud metrics <svc> --metric=disk_storage');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const raw = process.argv.slice(2);
const cmd = raw[0];
const { opts, pos } = parseArgs(raw.slice(1));

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { showHelp(); process.exit(cmd ? 0 : 1); }

try {
  switch (cmd) {
    case 'orgs':     await cmdOrgs(opts); break;
    case 'services': await cmdServices(opts); break;
    case 'service':  await cmdService(pos, opts); break;
    case 'cost':     await cmdCost(opts); break;
    case 'metrics':  await cmdMetrics(pos, opts); break;
    case 'usage':    await cmdCost(opts); break;
    case 'api':      await cmdApi(pos, opts); break;
    default:
      console.error('Unknown command: ' + cmd);
      showHelp();
      process.exit(1);
  }
} catch (e) {
  console.error('Error: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
