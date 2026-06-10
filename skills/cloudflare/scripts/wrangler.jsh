// Wrangler — Cloudflare zone analytics via authenticated dash.cloudflare.com tab.
// Issues GraphQL via `playwright-cli eval-file` against the open dash tab so the
// browser session cookies are picked up automatically.
//
// IMPORTANT: never use template literals to build GraphQL strings — the eval-file
// wrapper interpolates ${...} even inside backticks, which corrupts $variables.
// Build queries with single-quoted concatenation instead.

const HOME = (process.env && (process.env.HOME || process.env.USERPROFILE)) || '/root';
const CONFIG_DIR = HOME + '/.config/wrangler';
const ZONES_FILE = CONFIG_DIR + '/zones.json';
const TMP_DIR = '/tmp/wrangler';

const argv = (typeof args !== 'undefined' && Array.isArray(args))
  ? args.slice()
  : (process.argv ? process.argv.slice(2) : []);

function parseArgs(av) {
  const opts = { hours: 3, limit: 25, zone: null, tab: null, file: null, json: false };
  const positional = [];
  for (let i = 0; i < av.length; i++) {
    const a = av[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--hours=')) opts.hours = parseInt(a.slice(8), 10);
    else if (a === '--hours') opts.hours = parseInt(av[++i], 10);
    else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice(8), 10);
    else if (a === '--limit') opts.limit = parseInt(av[++i], 10);
    else if (a.startsWith('--zone=')) opts.zone = a.slice(7);
    else if (a === '--zone') opts.zone = av[++i];
    else if (a.startsWith('--tab=')) opts.tab = a.slice(6);
    else if (a === '--tab') opts.tab = av[++i];
    else if (a.startsWith('--file=')) opts.file = a.slice(7);
    else if (a === '--file') opts.file = av[++i];
    else positional.push(a);
  }
  if (isNaN(opts.hours)) opts.hours = 3;
  opts.hours = Math.max(1, Math.min(72, opts.hours));
  if (isNaN(opts.limit)) opts.limit = 25;
  return { opts, positional };
}

async function sh(cmd) {
  // Prefer the jsh runtime's `exec` global; fall back to child_process.
  if (typeof exec === 'function') {
    const r = await exec(cmd);
    return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.exitCode };
  }
  const cp = require('child_process');
  const r = cp.spawnSync('bash', ['-lc', cmd], { encoding: 'utf8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

async function ensureDirs() {
  await fs.mkdir(TMP_DIR, { recursive: true }).catch(function() {});
  await fs.mkdir(CONFIG_DIR, { recursive: true }).catch(function() {});
}

async function findDashTab(override) {
  if (override) return override;
  const r = await sh('playwright-cli tab-list');
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^\[([0-9A-F]+)\]\s+(\S+)/i);
    if (!m) continue;
    try {
      const u = new URL(m[2]);
      if (u.host === 'dash.cloudflare.com') return m[1];
    } catch (e) { /* skip */ }
  }
  return null;
}

async function ensureTab(override) {
  let tab = await findDashTab(override);
  if (tab) return tab;
  await sh('playwright-cli open --foreground https://dash.cloudflare.com');
  for (let i = 0; i < 10; i++) {
    await new Promise(function(r){ setTimeout(r, 1000); });
    tab = await findDashTab(null);
    if (tab) return tab;
  }
  console.error('Could not find or open a dash.cloudflare.com tab.');
  process.exit(1);
}

async function runInTab(tabId, jsBody) {
  await ensureDirs();
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const jsPath = TMP_DIR + '/q-' + stamp + '.js';
  const outPath = TMP_DIR + '/o-' + stamp + '.json';
  await fs.writeFile(jsPath, jsBody);
  const cmd = 'playwright-cli eval-file --tab=' + tabId + ' ' + jsPath + ' --output=' + outPath;
  const r = await sh(cmd);
  if (r.status !== 0) {
    console.error('playwright-cli eval-file failed: ' + (r.stderr || r.stdout));
    process.exit(1);
  }
  let raw;
  try { raw = await fs.readFile(outPath, 'utf8'); }
  catch (e) { console.error('Failed to read output: ' + e.message); process.exit(1); }
  try { return JSON.parse(raw); }
  catch (e) {
    console.error('Failed to parse JSON output: ' + e.message);
    console.error(raw.slice(0, 500));
    process.exit(1);
  }
}

async function gqlFetch(tabId, query, variables) {
  // Body built with JSON-string literals only — no template literals, ever.
  const qLit = JSON.stringify(query);
  const vLit = JSON.stringify(variables || {});
  const js =
    '(async () => {\n' +
    '  const Q = ' + qLit + ';\n' +
    '  const V = ' + vLit + ';\n' +
    '  const r = await fetch("/api/v4/graphql", {\n' +
    '    method: "POST",\n' +
    '    credentials: "include",\n' +
    '    headers: { "content-type": "application/json" },\n' +
    '    body: JSON.stringify({ query: Q, variables: V })\n' +
    '  });\n' +
    '  return r.json();\n' +
    '})()\n';
  return runInTab(tabId, js);
}

async function restGet(tabId, path) {
  const pLit = JSON.stringify(path);
  const js =
    '(async () => {\n' +
    '  const r = await fetch(' + pLit + ', {\n' +
    '    method: "GET",\n' +
    '    credentials: "include",\n' +
    '    headers: { "accept": "application/json" }\n' +
    '  });\n' +
    '  return r.json();\n' +
    '})()\n';
  return runInTab(tabId, js);
}

// --- zones cache ---

async function loadZones() {
  try { return JSON.parse(await fs.readFile(ZONES_FILE, 'utf8')); }
  catch (e) { return null; }
}

async function saveZones(list) {
  await ensureDirs();
  await fs.writeFile(ZONES_FILE, JSON.stringify(list, null, 2));
  if (typeof fs.chmod === 'function') {
    await fs.chmod(ZONES_FILE, 0o600).catch(function() {});
  }
}

async function fetchZonesViaTab(tabId, name) {
  const path = '/api/v4/zones?per_page=50' + (name ? '&name=' + encodeURIComponent(name) : '');
  const data = await restGet(tabId, path);
  if (!data || !data.success) {
    console.error('zones API failure: ' + JSON.stringify((data && data.errors) || data).slice(0, 500));
    process.exit(1);
  }
  return (data.result || []).map(function(z) {
    return {
      id: z.id, name: z.name, status: z.status,
      account: z.account ? { id: z.account.id, name: z.account.name } : null,
    };
  });
}

async function resolveZone(tabId, arg) {
  if (!arg) { console.error('zone is required'); process.exit(1); }
  if (/^[0-9a-f]{32}$/i.test(arg)) return { id: arg, name: arg };
  const cache = await loadZones();
  if (cache) {
    const hit = cache.find(function(z){ return z.name === arg; });
    if (hit) return hit;
  }
  const list = await fetchZonesViaTab(tabId, arg);
  if (list.length > 0) {
    const merged = {};
    if (cache) for (const z of cache) merged[z.id] = z;
    for (const z of list) merged[z.id] = z;
    await saveZones(Object.values(merged));
    return list[0];
  }
  const all = await fetchZonesViaTab(tabId, null);
  await saveZones(all);
  const hit = all.find(function(z){ return z.name === arg; });
  if (!hit) { console.error('Zone not found: ' + arg); process.exit(1); }
  return hit;
}

function timeWindow(hours) {
  const now = new Date();
  const end = new Date(Math.floor(now.getTime() / 3600000) * 3600000);
  const start = new Date(end.getTime() - hours * 3600000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
function fmtNum(n) {
  if (n == null) return '0';
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n/1e3).toFixed(2) + 'K';
  return String(n);
}

// --- GraphQL queries (single-quote concatenation; never template literals) ---

function qHttpReq1h() {
  return 'query(' + '$z:String!,' + '$s:Time!,' + '$e:Time!' + '){' +
    'viewer{zones(filter:{zoneTag:' + '$z' + '}){' +
    'httpRequests1hGroups(limit:200,filter:{datetime_geq:' + '$s' + ',datetime_leq:' + '$e' +
    '},orderBy:[datetime_ASC]){' +
    'dimensions{datetime} ' +
    'sum{requests pageViews bytes cachedRequests threats ' +
    'countryMap{clientCountryName requests} ' +
    'responseStatusMap{edgeResponseStatus requests}} ' +
    'uniq{uniques}}}}}';
}

function qAdaptive(orderBy) {
  return 'query(' + '$z:String!,' + '$s:Time!,' + '$e:Time!,' + '$lim:Int!' + '){' +
    'viewer{zones(filter:{zoneTag:' + '$z' + '}){' +
    'httpRequestsAdaptiveGroups(limit:' + '$lim' +
    ',filter:{datetime_geq:' + '$s' + ',datetime_leq:' + '$e' +
    '},orderBy:[' + orderBy + ']){' +
    'count ' +
    'dimensions{clientRequestPath edgeResponseStatus userAgent clientCountryName}' +
    '}}}}';
}

async function runHourly(tab, zoneId, hours) {
  const w = timeWindow(hours);
  const j = await gqlFetch(tab, qHttpReq1h(), { z: zoneId, s: w.start, e: w.end });
  if (j.errors) {
    console.error('GraphQL errors: ' + JSON.stringify(j.errors).slice(0, 800));
    process.exit(1);
  }
  const groups = (((j.data || {}).viewer || {}).zones || [{}])[0].httpRequests1hGroups || [];
  return { groups, raw: j, window: w };
}

async function runAdaptive(tab, zoneId, hours, limit, orderBy) {
  const w = timeWindow(hours);
  const j = await gqlFetch(tab, qAdaptive(orderBy),
    { z: zoneId, s: w.start, e: w.end, lim: limit });
  if (j.errors) {
    console.error('GraphQL errors: ' + JSON.stringify(j.errors).slice(0, 800));
    process.exit(1);
  }
  const rows = (((j.data || {}).viewer || {}).zones || [{}])[0].httpRequestsAdaptiveGroups || [];
  return { rows, raw: j, window: w };
}

// --- commands ---

async function cmdOpen(av) {
  const { opts } = parseArgs(av);
  const tab = await ensureTab(opts.tab);
  console.log(tab);
}

async function cmdZones(av) {
  const { opts } = parseArgs(av);
  const tab = await ensureTab(opts.tab);
  const zones = await fetchZonesViaTab(tab, null);
  await saveZones(zones);
  if (opts.json) { console.log(JSON.stringify(zones, null, 2)); return; }
  console.log(pad('id', 34) + pad('name', 32) + pad('account', 30) + 'status');
  for (const z of zones) {
    console.log(pad(z.id, 34) + pad(z.name, 32) +
      pad((z.account && z.account.name) || '-', 30) + (z.status || '-'));
  }
}

async function cmdStatus(av) {
  const { opts, positional } = parseArgs(av);
  const zarg = positional[1];
  if (!zarg) { console.error('Usage: wrangler status <zone> [--hours=N]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, zarg);
  const { groups, raw } = await runHourly(tab, zone.id, opts.hours);
  if (opts.json) { console.log(JSON.stringify(raw, null, 2)); return; }

  let totalReq=0, totalPV=0, totalBytes=0, totalCached=0, totalThreats=0, totalUniq=0;
  const statusMix = {}; const countryAgg = {};
  for (const g of groups) {
    const s = g.sum || {}; const u = g.uniq || {};
    totalReq += s.requests || 0; totalPV += s.pageViews || 0;
    totalBytes += s.bytes || 0; totalCached += s.cachedRequests || 0;
    totalThreats += s.threats || 0; totalUniq += u.uniques || 0;
    for (const r of (s.responseStatusMap || []))
      statusMix[r.edgeResponseStatus] = (statusMix[r.edgeResponseStatus] || 0) + (r.requests || 0);
    for (const c of (s.countryMap || []))
      countryAgg[c.clientCountryName] = (countryAgg[c.clientCountryName] || 0) + (c.requests || 0);
  }

  console.log('Zone:     ' + zone.name + '  (' + zone.id + ')');
  console.log('Window:   last ' + opts.hours + 'h  [' + groups.length + ' hourly buckets]');
  console.log('Requests: ' + fmtNum(totalReq) + '   PageViews: ' + fmtNum(totalPV) +
              '   Cached: ' + fmtNum(totalCached) + '   Threats: ' + fmtNum(totalThreats) +
              '   Uniques: ' + fmtNum(totalUniq));
  console.log('Bytes:    ' + fmtNum(totalBytes));
  console.log('');
  console.log('Status mix:');
  const sm = Object.entries(statusMix).sort(function(a,b){ return b[1]-a[1]; });
  for (const [code, n] of sm) console.log('  ' + pad(code, 6) + fmtNum(n));
  console.log('');
  console.log('Top countries:');
  const cc = Object.entries(countryAgg).sort(function(a,b){ return b[1]-a[1]; }).slice(0, 8);
  for (const [c, n] of cc) console.log('  ' + pad(c, 6) + fmtNum(n));

  const ad = await runAdaptive(tab, zone.id, opts.hours, 6, 'count_DESC');
  console.log('');
  console.log('Top paths (sampled):');
  console.log('  ' + pad('count', 9) + pad('status', 7) + pad('country', 8) + 'path');
  for (const r of ad.rows) {
    const d = r.dimensions || {};
    console.log('  ' + pad(fmtNum(r.count), 9) + pad(d.edgeResponseStatus, 7) +
                pad(d.clientCountryName || '-', 8) + trunc(d.clientRequestPath || '-', 60));
  }
}

async function cmdTimeseries(av) {
  const { opts, positional } = parseArgs(av);
  const zarg = positional[1];
  if (!zarg) { console.error('Usage: wrangler timeseries <zone> [--hours=N]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, zarg);
  const { groups, raw } = await runHourly(tab, zone.id, opts.hours);
  if (opts.json) { console.log(JSON.stringify(raw, null, 2)); return; }
  console.log(pad('datetime', 22) + pad('requests', 10) + pad('pageViews', 11) +
              pad('uniques', 9) + pad('threats', 9) + 'cached');
  for (const g of groups) {
    const s = g.sum || {}; const u = g.uniq || {};
    console.log(
      pad((g.dimensions && g.dimensions.datetime) || '-', 22) +
      pad(fmtNum(s.requests), 10) + pad(fmtNum(s.pageViews), 11) +
      pad(fmtNum(u.uniques), 9) + pad(fmtNum(s.threats), 9) +
      fmtNum(s.cachedRequests));
  }
}

async function cmdStatuscodes(av) {
  const { opts, positional } = parseArgs(av);
  const zarg = positional[1];
  if (!zarg) { console.error('Usage: wrangler statuscodes <zone> [--hours=N]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, zarg);
  const { groups, raw } = await runHourly(tab, zone.id, opts.hours);
  if (opts.json) { console.log(JSON.stringify(raw, null, 2)); return; }
  const codes = new Set();
  for (const g of groups) for (const r of ((g.sum || {}).responseStatusMap || [])) codes.add(r.edgeResponseStatus);
  const codesArr = [...codes].sort(function(a,b){ return a-b; });
  console.log(pad('datetime', 22) + pad('total', 10) + codesArr.map(function(c){ return pad(String(c), 8); }).join(''));
  for (const g of groups) {
    const map = {};
    for (const r of ((g.sum || {}).responseStatusMap || [])) map[r.edgeResponseStatus] = r.requests;
    const total = (g.sum && g.sum.requests) || 0;
    console.log(
      pad((g.dimensions && g.dimensions.datetime) || '-', 22) +
      pad(fmtNum(total), 10) +
      codesArr.map(function(c){ return pad(fmtNum(map[c] || 0), 8); }).join(''));
  }
}

async function cmdTopPaths(av) {
  const { opts, positional } = parseArgs(av);
  const zarg = positional[1];
  if (!zarg) { console.error('Usage: wrangler top-paths <zone> [--hours=N] [--limit=N]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, zarg);
  const { rows, raw } = await runAdaptive(tab, zone.id, opts.hours, opts.limit, 'count_DESC');
  if (opts.json) { console.log(JSON.stringify(raw, null, 2)); return; }
  console.log(pad('count', 9) + pad('status', 7) + pad('country', 8) + pad('path', 62) + 'ua');
  for (const r of rows) {
    const d = r.dimensions || {};
    console.log(
      pad(fmtNum(r.count), 9) + pad(d.edgeResponseStatus, 7) +
      pad(d.clientCountryName || '-', 8) +
      pad(trunc(d.clientRequestPath || '-', 60), 62) +
      trunc(d.userAgent || '-', 60));
  }
}

async function cmdTopUAs(av) {
  const { opts, positional } = parseArgs(av);
  const zarg = positional[1];
  if (!zarg) { console.error('Usage: wrangler top-uas <zone> [--hours=N] [--limit=N]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, zarg);
  const sampleLimit = Math.max(opts.limit * 20, 200);
  const { rows, raw } = await runAdaptive(tab, zone.id, opts.hours, sampleLimit, 'count_DESC');
  if (opts.json) { console.log(JSON.stringify(raw, null, 2)); return; }
  const agg = {};
  for (const r of rows) {
    const ua = (r.dimensions && r.dimensions.userAgent) || '-';
    agg[ua] = (agg[ua] || 0) + (r.count || 0);
  }
  const sorted = Object.entries(agg).sort(function(a,b){ return b[1]-a[1]; }).slice(0, opts.limit);
  console.log(pad('count', 10) + 'userAgent');
  for (const [ua, n] of sorted) console.log(pad(fmtNum(n), 10) + trunc(ua, 60));
}

async function cmdTopCountries(av) {
  const { opts, positional } = parseArgs(av);
  const zarg = positional[1];
  if (!zarg) { console.error('Usage: wrangler top-countries <zone> [--hours=N] [--limit=N]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, zarg);
  const sampleLimit = Math.max(opts.limit * 20, 200);
  const { rows, raw } = await runAdaptive(tab, zone.id, opts.hours, sampleLimit, 'count_DESC');
  if (opts.json) { console.log(JSON.stringify(raw, null, 2)); return; }
  const agg = {};
  for (const r of rows) {
    const c = (r.dimensions && r.dimensions.clientCountryName) || '-';
    agg[c] = (agg[c] || 0) + (r.count || 0);
  }
  const sorted = Object.entries(agg).sort(function(a,b){ return b[1]-a[1]; }).slice(0, opts.limit);
  console.log(pad('count', 10) + 'country');
  for (const [c, n] of sorted) console.log(pad(fmtNum(n), 10) + c);
}

async function readStdin() {
  // Try multiple jsh stdin shapes.
  if (process && process.stdin && typeof process.stdin.read === 'function') {
    try {
      const v = await process.stdin.read();
      if (typeof v === 'string') return v;
      if (v && v.toString) return v.toString();
    } catch (e) { /* fall through */ }
  }
  return new Promise(function(resolve, reject) {
    let buf = '';
    if (!process.stdin || !process.stdin.on) return resolve('');
    try { process.stdin.setEncoding('utf8'); } catch (e) {}
    process.stdin.on('data', function(c){ buf += c; });
    process.stdin.on('end', function(){ resolve(buf); });
    process.stdin.on('error', reject);
  });
}

async function cmdQuery(av) {
  const { opts } = parseArgs(av);
  if (!opts.zone) { console.error('Usage: wrangler query --zone=<name|id> [--file=path]'); process.exit(1); }
  const tab = await ensureTab(opts.tab);
  const zone = await resolveZone(tab, opts.zone);
  let query;
  if (opts.file) {
    query = await fs.readFile(opts.file, 'utf8');
  } else {
    query = await readStdin();
    if (!query || !query.trim()) {
      console.error('No GraphQL query provided. Use --file=path or pipe via stdin.');
      process.exit(1);
    }
  }
  const j = await gqlFetch(tab, query, { zoneTag: zone.id, zone: zone.id, z: zone.id });
  console.log(JSON.stringify(j, null, 2));
}

function showHelp() {
  console.log('wrangler — Cloudflare zone analytics via authenticated dash tab');
  console.log('');
  console.log('Commands:');
  console.log('  open                              Open or focus dash.cloudflare.com tab');
  console.log('  zones                             List zones the dash session can see');
  console.log('  status <zone>                     Summary: requests, status mix, countries, top paths');
  console.log('  timeseries <zone>                 Hourly requests/pageViews/uniques/threats');
  console.log('  statuscodes <zone>                Hourly breakdown by edgeResponseStatus');
  console.log('  top-paths <zone>                  Most-requested paths (sampled)');
  console.log('  top-uas <zone>                    Most-common user agents (sampled)');
  console.log('  top-countries <zone>              Top source countries (sampled)');
  console.log('  query --zone=<z> [--file=path]    Run arbitrary GraphQL (stdin if no --file)');
  console.log('');
  console.log('Flags:');
  console.log('  --hours=N    Window size in hours (1..72, default 3)');
  console.log('  --limit=N    Max rows for top-* (default 25)');
  console.log('  --zone=Z     Zone name or 32-char id (for `query`)');
  console.log('  --tab=ID     Override playwright tab id');
  console.log('  --json       Emit raw GraphQL JSON');
  console.log('');
  console.log('Auth: piggybacks on the open dash.cloudflare.com tab cookies — no token.');
}

const cmd = argv[0];
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  showHelp();
  process.exit(cmd ? 0 : 1);
}

switch (cmd) {
  case 'open':           await cmdOpen(argv); break;
  case 'zones':          await cmdZones(argv); break;
  case 'status':         await cmdStatus(argv); break;
  case 'timeseries':     await cmdTimeseries(argv); break;
  case 'statuscodes':    await cmdStatuscodes(argv); break;
  case 'top-paths':      await cmdTopPaths(argv); break;
  case 'top-uas':        await cmdTopUAs(argv); break;
  case 'top-countries':  await cmdTopCountries(argv); break;
  case 'query':          await cmdQuery(argv); break;
  default:
    console.error('Unknown command: ' + cmd);
    showHelp();
    process.exit(1);
}
