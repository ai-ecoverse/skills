// az-ext.jsh — SLICC-only extensions to the `azure` skill: Cost Management
// analysis. The real Azure CLI has `az costmanagement query` only as a thin
// passthrough with no analysis, and nothing at all for the Marketplace split
// this command exists for, so — following the fastly-ext / gcloud-ext pattern —
// it lives in a separate binary and `az` stays command-compatible upstream.
//
// Backed by one ARM endpoint:
//   POST /subscriptions/{id}/providers/Microsoft.CostManagement/query
//        ?api-version=2023-11-01
// Auth is the ARM token the sibling `az` command harvests from a logged-in
// portal.azure.com tab (see references/arm-auth.md). This script never harvests
// a token itself; when the stored one is missing or expired it shells out to
// `az login --from-tab` once, so the harvest lives in exactly one place.
//
// THREE MEASURED CONSTRAINTS SHAPE EVERY LINE BELOW (references/cost-management-gotchas.md):
//
//  1. THROTTLING. Historical (`timeframe: Custom`, `granularity: Monthly`)
//     queries 429 hard, and the effective budget is roughly ONE historical
//     query per FIVE MINUTES. The response carries no Retry-After and no
//     x-ms-ratelimit-* header, so backoff must be time-based. Mitigations, in
//     order of value: (a) every successful response is cached to disk so a
//     retry, a re-render, or a --json rerun costs nothing; (b) exponential
//     backoff with visible progress instead of a bare failure; (c) `cost mtd`,
//     which uses the far cheaper MonthToDate + granularity None shape and
//     usually succeeds even while historical queries are throttled.
//
//  2. ONE YEAR PER QUERY. A from/to span over ~366 days is rejected 400
//     "The time period for pulling the data cannot exceed 1 year(s)". Longer
//     ranges are chunked — and each chunk spends quota, hence the caching.
//
//  3. GROUPING DIMENSIONS ARE A CLOSED SET. `PublisherName`, for instance, is
//     not one; ARM answers 400 with the valid list. Learning that costs a
//     throttled request, so dimensions are validated client-side first.
//
// AND ONE DOMAIN INSIGHT, which is why `cost marketplace` exists: grouping by
// MeterCategory can leave a huge "Unassigned" bucket that looks like a mystery
// (measured: $14,467, 61% of a subscription). It is not a mystery — grouping by
// PublisherType reveals it as `Marketplace`, i.e. third-party SaaS resold
// through Azure billing rather than Azure infrastructure. In that same
// subscription Azure-native infra was ~$694/yr against $22,720 of Marketplace
// spend. Any cost analysis that ignores PublisherType can be wrong by 30x.

const cli = require('sliccy:cli');
const skill = require('sliccy:skill');
const c = require('sliccy:color');
const { exec } = require('sliccy:exec');
const fs = require('fs');

// ─── ARM / Cost Management constants ─────────────────────────────────────────

const ARM_BASE = 'https://management.azure.com';
const COST_API_VERSION = '2023-11-01';

/**
 * Valid `dataset.grouping[].name` dimensions. The starred ones were echoed back
 * by ARM's own 400 when an invalid dimension was sent; the rest are the
 * documented Cost Management dimension set. Validated client-side so a typo
 * costs zero quota instead of one throttled round trip.
 */
const VALID_DIMENSIONS = [
  'AccountName',
  'BenefitId',
  'BenefitName',
  'BillingAccountId',
  'BillingMonth', // *
  'BillingPeriod',
  'ChargeType',
  'ConsumedService', // *
  'CostAllocationRuleName',
  'DepartmentName',
  'EnrollmentAccountName',
  'Frequency',
  'InvoiceNumber',
  'MarkupRuleName',
  'Meter',
  'MeterCategory',
  'MeterId', // *
  'MeterSubCategory',
  'PartNumber',
  'PricingModel',
  'Provider',
  'PublisherType',
  'ReservationId',
  'ReservationName',
  'ResourceGroup', // *
  'ResourceGroupName', // *
  'ResourceGuid',
  'ResourceId', // *
  'ResourceLocation', // *
  'ResourceType', // *
  'ServiceName',
  'ServiceTier',
  'SubscriptionId',
  'SubscriptionName',
];

/** Dimensions people reach for that do NOT exist, with the right answer. */
const DIMENSION_ALIASES = {
  publishername: 'PublisherType',
  publisher: 'PublisherType',
  service: 'ServiceName',
  sku: 'MeterSubCategory',
  skuname: 'MeterSubCategory',
  meter_category: 'MeterCategory',
  resourcegroupname: 'ResourceGroup',
  region: 'ResourceLocation',
  location: 'ResourceLocation',
  month: 'BillingMonth',
};

// MEASURED, and stricter than the docs imply: Cost Management counts timePeriod
// INCLUSIVELY, so a from/to exactly 365 days apart spans 366 calendar days and is
// rejected 400 "The time period for pulling the data cannot exceed 1 year(s)".
// Confirmed live on 2026-08-27: from 2025-08-01 to 2026-08-01 (365 days) FAILED,
// while from 2025-08-28 to 2026-08-27 (364 days) succeeded. So the safe maximum
// for (to - from) is 364 days, NOT 366.
const MAX_QUERY_DAYS = 364;

// Time-based backoff, in seconds. Deliberately front-loaded gently then long:
// the observed budget is ~1 historical query / 5 minutes, so the tail steps sit
// at 300s rather than doubling into hours.
const BACKOFF_SECONDS = [20, 45, 90, 180, 300, 300, 300, 300, 300, 300];
const DEFAULT_MAX_WAIT_SECONDS = 900;

// Cache TTLs. Closed historical months never change, so a day is conservative;
// month-to-date moves continuously, so it gets minutes.
const TTL_HISTORICAL_SECONDS = 24 * 3600;
const TTL_MTD_SECONDS = 900;

const HOME = (process.env && (process.env.HOME || process.env.USERPROFILE)) || '/root';
const CACHE_DIR = HOME + '/.cache/az-ext/cost';

// ─── tiny helpers ────────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usd(v) {
  const n = Number(v) || 0;
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(2);
}

function pct(part, whole) {
  if (!whole) return '0.0%';
  return ((100 * part) / whole).toFixed(1) + '%';
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/** Start of the UTC month `back` months before the 1st of the current month. */
function monthStart(back) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (back || 0), 1));
}

function isoStart(dateOrYmd) {
  const s = typeof dateOrYmd === 'string' ? dateOrYmd : ymd(dateOrYmd);
  return s.slice(0, 10) + 'T00:00:00Z';
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

// ─── dimension validation (constraint 3) ─────────────────────────────────────

/**
 * Resolve a user-supplied grouping dimension to its exact ARM spelling.
 * Returns `{ ok: true, dimension }`, or `{ ok: false, message }` carrying the
 * valid alternatives — never a bare boolean, because the whole point is to hand
 * the caller the list ARM would have charged a throttled request to reveal.
 */
function validateDimension(name) {
  const raw = String(name === undefined || name === null ? '' : name).trim();
  if (!raw) {
    return { ok: false, message: 'No grouping dimension given.\nValid dimensions: ' + VALID_DIMENSIONS.join(', ') };
  }
  const exact = VALID_DIMENSIONS.find((d) => d === raw);
  if (exact) return { ok: true, dimension: exact };
  const lower = raw.toLowerCase();
  const ci = VALID_DIMENSIONS.find((d) => d.toLowerCase() === lower);
  if (ci) return { ok: true, dimension: ci };

  const alias = DIMENSION_ALIASES[lower.replace(/[\s_-]/g, '')] || DIMENSION_ALIASES[lower];
  const near = VALID_DIMENSIONS.filter((d) => d.toLowerCase().includes(lower) || lower.includes(d.toLowerCase()));
  const suggestions = [];
  if (alias) suggestions.push(alias);
  for (const n of near) if (!suggestions.includes(n)) suggestions.push(n);

  let message = `"${raw}" is not a valid Cost Management grouping dimension.`;
  if (alias) {
    message += `\nDid you mean ${c.bold(alias)}?`;
    if (alias === 'PublisherType') {
      message +=
        '  PublisherType is the one that splits Azure-native spend from\n' +
        '  third-party Marketplace spend — see: az-ext cost marketplace --help';
    }
  } else if (suggestions.length) {
    message += `\nClosest matches: ${suggestions.join(', ')}`;
  }
  message += '\nValid dimensions: ' + VALID_DIMENSIONS.join(', ');
  message += '\n(Validated locally — ARM would have charged one throttled request to say this.)';
  return { ok: false, message: message };
}

function requireDimension(name) {
  const v = validateDimension(name);
  if (!v.ok) cli.die(v.message, { prefix: 'az-ext' });
  return v.dimension;
}

// ─── 1-year chunking (constraint 2) ──────────────────────────────────────────

/**
 * Split [fromIso, toIso) into windows of at most MAX_QUERY_DAYS days, oldest
 * first. A span inside the limit yields exactly one window, so callers never
 * special-case the common path.
 *
 * Windows are split EVENLY rather than greedily. Greedy chunking of a 365-day
 * range yields [364, 1] — two full-price queries, one of which fetches a single
 * day. Since every chunk costs the same throttle budget regardless of width,
 * even splitting ([183, 182]) is strictly better for the same price.
 */
function chunkRange(fromIso, toIso) {
  const from = isoStart(fromIso);
  const to = isoStart(toIso);
  if (Date.parse(from) >= Date.parse(to)) {
    return [{ from: from, to: to }];
  }
  const spanDays = daysBetween(from, to);
  const count = Math.ceil(spanDays / MAX_QUERY_DAYS);
  const perWindow = Math.ceil(spanDays / count);
  const windows = [];
  let cursor = from;
  while (Date.parse(cursor) < Date.parse(to)) {
    const next = new Date(Date.parse(cursor) + perWindow * 86400000);
    const end = Date.parse(next) < Date.parse(to) ? isoStart(ymd(next)) : to;
    windows.push({ from: cursor, to: end });
    cursor = end;
  }
  return windows;
}

// ─── query builder ───────────────────────────────────────────────────────────

/**
 * Build a Cost Management query body.
 * `granularity` 'None' collapses the time axis (much cheaper); 'Monthly' gives
 * the BillingMonth column back but is the shape that gets throttled hardest.
 */
function buildQuery(opts) {
  const o = opts || {};
  const dataset = {
    granularity: o.granularity || 'None',
    aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
  };
  if (Array.isArray(o.grouping) && o.grouping.length) {
    dataset.grouping = o.grouping.map((d) => ({ type: 'Dimension', name: d }));
  }
  const body = {
    type: o.type || 'ActualCost',
    timeframe: o.timeframe || 'Custom',
    dataset: dataset,
  };
  if (body.timeframe === 'Custom') {
    body.timePeriod = { from: isoStart(o.from), to: isoStart(o.to) };
  }
  return body;
}

// ─── response parsing (positional rows!) ─────────────────────────────────────

/**
 * Cost Management returns `properties.columns[]` (names+types) and
 * `properties.rows[]` as bare positional arrays. Column ORDER IS NOT STABLE
 * across groupings or API versions, so mapping by fixed index is a latent
 * data-corruption bug: build objects keyed by column NAME, always.
 */
function parseRows(response) {
  const props = (response && response.properties) || response || {};
  const columns = Array.isArray(props.columns) ? props.columns : [];
  const names = columns.map((col) => (col && col.name) || '');
  const rows = Array.isArray(props.rows) ? props.rows : [];
  return rows.map((row) => {
    const obj = {};
    for (let i = 0; i < names.length; i++) {
      if (names[i]) obj[names[i]] = Array.isArray(row) ? row[i] : undefined;
    }
    return obj;
  });
}

/** The cost aggregate is `Cost`, but `CostUSD` / `PreTaxCost` appear depending
 *  on currency settings and API version. Resolve by name, in preference order. */
function costOf(row) {
  const candidates = ['Cost', 'CostUSD', 'PreTaxCost', 'PreTaxCostUSD', 'totalCost'];
  for (const key of candidates) {
    if (row && Object.hasOwn(row, key) && row[key] !== null && row[key] !== undefined) {
      return Number(row[key]) || 0;
    }
  }
  return 0;
}

function currencyOf(rows) {
  for (const row of rows || []) {
    const cur = str(row.Currency) || str(row.CurrencyCode) || str(row.BillingCurrency);
    if (cur) return cur;
  }
  return 'USD';
}

/** `BillingMonth` arrives as an ISO datetime; reduce it to YYYY-MM. */
function monthOf(row) {
  const v = row && (row.BillingMonth || row.UsageDate || row.BillingPeriod);
  if (v === undefined || v === null) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : null;
}

// ─── the PublisherType / Marketplace split ───────────────────────────────────

/** PublisherType values that mean "this is Azure's own infrastructure". */
const AZURE_PUBLISHER_TYPES = new Set(['azure', 'microsoft']);

/**
 * Split rows grouped by PublisherType (+ optionally a second dimension) into
 * Azure-native vs third-party buckets.
 *
 * Rows with no PublisherType at all land in `unknown` rather than being
 * silently counted as Azure — quietly folding them into Azure is precisely the
 * mistake that made $14,467 look like Azure infrastructure.
 */
function splitByPublisher(rows) {
  const buckets = new Map();
  let total = 0;
  for (const row of rows || []) {
    const cost = costOf(row);
    total += cost;
    const publisher = str(row.PublisherType) || '(unset)';
    const key = publisher;
    if (!buckets.has(key)) buckets.set(key, { publisherType: publisher, total: 0, items: [] });
    const bucket = buckets.get(key);
    bucket.total += cost;
    const label =
      str(row.ServiceName) ||
      str(row.MeterSubCategory) ||
      str(row.MeterCategory) ||
      str(row.ResourceId) ||
      str(row.MeterId) ||
      '(unnamed)';
    bucket.items.push({ label: label, cost: cost, resourceId: str(row.ResourceId) || null });
  }
  for (const bucket of buckets.values()) bucket.items.sort((a, b) => b.cost - a.cost);

  const azureBuckets = [];
  const thirdPartyBuckets = [];
  const unknownBuckets = [];
  for (const bucket of buckets.values()) {
    const p = bucket.publisherType.toLowerCase();
    if (AZURE_PUBLISHER_TYPES.has(p)) azureBuckets.push(bucket);
    else if (bucket.publisherType === '(unset)') unknownBuckets.push(bucket);
    else thirdPartyBuckets.push(bucket);
  }
  const sum = (list) => list.reduce((acc, b) => acc + b.total, 0);
  const marketplaceBucket = thirdPartyBuckets.find((b) => b.publisherType.toLowerCase() === 'marketplace');

  return {
    total: total,
    azure: { total: sum(azureBuckets), buckets: azureBuckets.sort((a, b) => b.total - a.total) },
    thirdParty: { total: sum(thirdPartyBuckets), buckets: thirdPartyBuckets.sort((a, b) => b.total - a.total) },
    unknown: { total: sum(unknownBuckets), buckets: unknownBuckets },
    marketplaceTotal: marketplaceBucket ? marketplaceBucket.total : 0,
    thirdPartyShare: total ? sum(thirdPartyBuckets) / total : 0,
  };
}

/**
 * Best-effort vendor name from an Azure resource id. Marketplace SaaS resources
 * look like
 *   /subscriptions/<id>/resourceGroups/<rg>/providers/Microsoft.SaaS/resources/clickhouse-cloud-prod
 * so the last segment usually carries the vendor, and the provider namespace
 * tells us it is a SaaS/Marketplace resource at all.
 */
function vendorFromResourceId(resourceId) {
  const id = str(resourceId);
  if (!id) return null;
  const segments = id.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  const providerIndex = segments.findIndex((s) => s.toLowerCase() === 'providers');
  const provider = providerIndex >= 0 ? segments[providerIndex + 1] || '' : '';
  if (!last) return null;
  const pretty = last
    .replace(/[_-]+/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
  return { name: pretty, raw: last, provider: provider || null };
}

// ─── regime-break detection (why a growth rate can be nonsense) ──────────────

/**
 * A Marketplace subscription switching on or off is a regime break, not growth.
 * Measured example: a 13-month series running $1.58 → $11 → $3,574 → $6,668 →
 * $757 fits to +98,766%/yr if you regress the whole thing, which is worse than
 * useless. Detect the break and refuse to annualise across it.
 */
function detectRegimeBreak(series) {
  const points = (series || []).filter((p) => Number.isFinite(p.cost));
  if (points.length < 4) return { break: false, reason: 'too few months to judge' };
  let worst = null;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].cost;
    const curr = points[i].cost;
    if (prev <= 0) continue;
    const ratio = curr / prev;
    if (ratio >= 10 && curr - prev > 100 && (!worst || ratio > worst.ratio)) {
      worst = { month: points[i].month, ratio: ratio, from: prev, to: curr };
    }
  }
  if (!worst) return { break: false, reason: 'no step change above 10x' };
  return {
    break: true,
    at: worst.month,
    ratio: worst.ratio,
    from: worst.from,
    to: worst.to,
    reason:
      `spend stepped ${worst.ratio.toFixed(0)}x at ${worst.month} ` +
      `(${usd(worst.from)} → ${usd(worst.to)}) — typically a Marketplace subscription ` +
      'switching on, which is a regime change, not a growth trend',
  };
}

// ─── on-disk cache (the single most valuable throttling mitigation) ───────────

function cacheKeyFor(subscriptionId, body) {
  const crypto = require('crypto');
  const canonical = String(subscriptionId) + '\n' + JSON.stringify(body);
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
}

function cachePath(key) {
  return CACHE_DIR + '/' + key + '.json';
}

/**
 * Read a cached response. Returns null on a miss, on expiry, or when the stored
 * query does not match byte-for-byte (a hash collision must never silently
 * answer the wrong question).
 */
async function cacheGet(subscriptionId, body) {
  const key = cacheKeyFor(subscriptionId, body);
  let entry;
  try {
    entry = JSON.parse(await fs.readFile(cachePath(key), 'utf8'));
  } catch {
    return null;
  }
  if (!entry || entry.subscriptionId !== subscriptionId) return null;
  if (JSON.stringify(entry.query) !== JSON.stringify(body)) return null;
  if (num(entry.expiresAt, 0) <= nowSeconds()) return null;
  return { key: key, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt, response: entry.response };
}

async function cacheSet(subscriptionId, body, response, ttlSeconds) {
  await ensureCacheDir();
  const key = cacheKeyFor(subscriptionId, body);
  const entry = {
    key: key,
    subscriptionId: subscriptionId,
    query: body,
    fetchedAt: nowSeconds(),
    expiresAt: nowSeconds() + num(ttlSeconds, TTL_HISTORICAL_SECONDS),
    response: response,
  };
  await fs.writeFile(cachePath(key), JSON.stringify(entry));
  return key;
}

async function cacheList() {
  let names;
  try {
    names = await fs.readDir(CACHE_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const fileName = typeof name === 'string' ? name : name && name.name;
    if (!fileName || !fileName.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(await fs.readFile(CACHE_DIR + '/' + fileName, 'utf8'));
      const q = entry.query || {};
      out.push({
        key: entry.key,
        subscriptionId: entry.subscriptionId,
        timeframe: q.timeframe,
        from: q.timePeriod && q.timePeriod.from,
        to: q.timePeriod && q.timePeriod.to,
        granularity: q.dataset && q.dataset.granularity,
        grouping: ((q.dataset && q.dataset.grouping) || []).map((g) => g.name).join('+') || '(none)',
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
        expired: num(entry.expiresAt, 0) <= nowSeconds(),
        rows: ((entry.response && entry.response.properties && entry.response.properties.rows) || []).length,
      });
    } catch {
      out.push({ key: fileName.replace(/\.json$/, ''), corrupt: true });
    }
  }
  return out.sort((a, b) => num(b.fetchedAt, 0) - num(a.fetchedAt, 0));
}

// ─── ARM transport with throttle handling (constraint 1) ──────────────────────

async function armToken(allowLogin) {
  const cfg = (await skill.config()) || {};
  const token = str(cfg.armToken);
  const expiresOn = num(cfg.armTokenExpiresOn, 0);
  const usable = token && (!expiresOn || expiresOn - 120 > nowSeconds());
  if (usable) return token;
  if (!allowLogin) return null;

  // Delegate the harvest to `az` so the MSAL/sessionStorage logic lives in one
  // place. Failure here is almost always "no portal tab open".
  const res = await exec.spawn(['az', 'login', '--from-tab']);
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    cli.die(
      'No usable ARM token, and `az login --from-tab` failed:\n' +
        (detail || '(no output)') +
        '\n\nOpen https://portal.azure.com (signed in), leave the tab open, then retry.',
      { prefix: 'az-ext' }
    );
  }
  const cfg2 = (await skill.config()) || {};
  const fresh = str(cfg2.armToken);
  if (!fresh) {
    cli.die('`az login --from-tab` reported success but stored no token.', { prefix: 'az-ext' });
  }
  return fresh;
}

function throttleGuidance(elapsedSeconds, maxWaitSeconds) {
  return (
    `Cost Management is throttling this subscription (HTTP 429) and did not clear within ` +
    `${elapsedSeconds}s (budget ${maxWaitSeconds}s).\n` +
    'This is normal, not a bug: the measured budget for historical queries is roughly\n' +
    'ONE query per FIVE MINUTES, and no Retry-After header is returned.\n' +
    'What to do, cheapest first:\n' +
    '  1. az-ext cost mtd --subscription <id>      # MonthToDate is a much cheaper shape\n' +
    '                                              # and often succeeds while history 429s\n' +
    '  2. az-ext cost cache --list                 # a previous answer may already be cached\n' +
    '  3. retry in ~5 minutes, or raise --max-wait (e.g. --max-wait 1800)\n' +
    '  4. narrow the window (--months 3) — fewer months is not cheaper per query, but\n' +
    '     it avoids the extra chunked queries a >1-year range needs'
  );
}

/**
 * POST a Cost Management query, cache-first, with time-based backoff on 429.
 *
 * `deps` exists purely so the unit tests can inject a fake fetch and count
 * network calls; production passes nothing and the realm `fetch` is used.
 */
async function costQuery(subscriptionId, body, opts, deps) {
  const options = opts || {};
  const doFetch = (deps && deps.fetch) || fetch;
  const getToken = (deps && deps.token) || armToken;
  const wait = (deps && deps.sleep) || sleep;
  const notify = (deps && deps.notify) || ((msg) => cli.warn(msg, { prefix: 'az-ext' }));
  const ttl = num(options.ttlSeconds, body.timeframe === 'MonthToDate' ? TTL_MTD_SECONDS : TTL_HISTORICAL_SECONDS);
  const maxWait = num(options.maxWaitSeconds, DEFAULT_MAX_WAIT_SECONDS);

  if (!options.refresh) {
    const hit = await cacheGet(subscriptionId, body);
    if (hit) {
      const age = nowSeconds() - num(hit.fetchedAt, nowSeconds());
      return { response: hit.response, cached: true, ageSeconds: age, requests: 0 };
    }
  }

  const token = await getToken(true);
  const url =
    `${ARM_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}` +
    `/providers/Microsoft.CostManagement/query?api-version=${COST_API_VERSION}`;

  let requests = 0;
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    requests++;
    let resp;
    try {
      resp = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      cli.die(`Cost Management request failed: ${err.message}`, { prefix: 'az-ext' });
    }

    const text = await resp.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 1000) };
      }
    }
    const errCode = payload && payload.error ? String(payload.error.code || '') : '';
    const errMessage = payload && payload.error ? String(payload.error.message || '') : '';

    if (resp.status >= 200 && resp.status < 300) {
      await cacheSet(subscriptionId, body, payload, ttl);
      return { response: payload, cached: false, requests: requests, waitedSeconds: waited };
    }

    // ── 429: throttled. Never bury this as a generic failure. ──
    if (resp.status === 429 || errCode === '429' || /too many requests/i.test(errMessage)) {
      // Measured: no Retry-After and no x-ms-ratelimit-* header is returned.
      // Honour one anyway if a future API version starts sending it.
      const headerHint = readRetryAfter(resp);
      const step = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length - 1)];
      const delay = headerHint || step;
      if (waited + delay > maxWait) {
        cli.die(throttleGuidance(waited, maxWait), { prefix: 'az-ext' });
      }
      notify(
        `throttled (HTTP 429) on ${describeQuery(body)}. ` +
          `Attempt ${attempt + 1} — waiting ${delay}s` +
          (headerHint ? ' (server-supplied Retry-After)' : ' (time-based backoff; no Retry-After sent)') +
          `. Waited ${waited}s of ${maxWait}s budget.`
      );
      await wait(delay * 1000);
      waited += delay;
      continue;
    }

    // ── 400: usually the 1-year cap or a bad dimension. Say which. ──
    if (resp.status === 400) {
      let hint = '';
      if (/cannot exceed 1 year/i.test(errMessage)) {
        const span = body.timePeriod ? daysBetween(body.timePeriod.from, body.timePeriod.to) : null;
        hint =
          '\nCost Management counts timePeriod INCLUSIVELY, so the safe maximum for' +
          ` (to - from) is ${MAX_QUERY_DAYS} days` +
          (span ? `, and this one asked for ${span}` : '') +
          '.\nThis command chunks longer ranges automatically — if you hit this via\n' +
          '`az rest`, split the range yourself.';
      } else if (/dimension/i.test(errMessage)) {
        hint = '\nValid grouping dimensions: ' + VALID_DIMENSIONS.join(', ');
      }
      cli.die(`Cost Management rejected the query (400 ${errCode}): ${errMessage}${hint}`, { prefix: 'az-ext' });
    }

    if (resp.status === 401 || resp.status === 403) {
      cli.die(
        `Cost Management returned ${resp.status} (${errCode || 'unauthorized'}): ${errMessage}\n` +
          'The portal ARM token is short-lived. Re-run: az login --from-tab\n' +
          'If it persists, the signed-in account may lack Cost Management Reader on this subscription.',
        { prefix: 'az-ext' }
      );
    }

    cli.die(
      `Cost Management returned HTTP ${resp.status}` +
        (errCode || errMessage ? ` (${errCode}) ${errMessage}` : '') +
        `\nQuery: ${describeQuery(body)}`,
      { prefix: 'az-ext' }
    );
  }
}

/** Retry-After in seconds, if the server ever sends one. Measured: it does not. */
function readRetryAfter(resp) {
  const headers = resp && resp.headers;
  if (!headers || typeof headers.get !== 'function') return 0;
  const raw = headers.get('retry-after') || headers.get('x-ms-ratelimit-microsoft.costmanagement-retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 600);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, Math.min(600, Math.round((when - Date.now()) / 1000)));
  return 0;
}

function describeQuery(body) {
  const grouping = ((body.dataset && body.dataset.grouping) || []).map((g) => g.name).join('+') || 'no grouping';
  const window = body.timePeriod ? `${body.timePeriod.from.slice(0, 10)}→${body.timePeriod.to.slice(0, 10)}` : body.timeframe;
  return `${window}, ${(body.dataset && body.dataset.granularity) || 'None'} granularity, ${grouping}`;
}

// ─── subscription resolution (delegated to `az`) ─────────────────────────────

async function resolveSubscriptionId(flags) {
  const wanted = str(flags.subscription) || str(flags.s);
  const cfg = (await skill.config()) || {};
  if (!wanted) {
    const dflt = str(cfg.subscription);
    if (dflt) return { id: dflt, name: str(cfg.subscriptionName) || dflt };
    cli.die(
      'No subscription given and no default set.\n' +
        '  az account list                                  # see what this session can reach\n' +
        '  az account set --subscription <id|name>          # set a default\n' +
        '  az-ext cost summary --subscription <id|name>     # or pass it per call',
      { prefix: 'az-ext' }
    );
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) {
    const known = (cfg.subscriptions || []).find((s) => String(s.id).toLowerCase() === wanted.toLowerCase());
    return { id: wanted, name: (known && known.name) || wanted };
  }

  let subs = Array.isArray(cfg.subscriptions) ? cfg.subscriptions : [];
  if (!subs.length) {
    const res = await exec.spawn(['az', 'account', 'list', '--json']);
    if (res.exitCode !== 0) {
      cli.die(
        'Could not list subscriptions to resolve "' + wanted + '":\n' + (res.stderr || res.stdout || '').trim(),
        { prefix: 'az-ext' }
      );
    }
    try {
      subs = JSON.parse(res.stdout);
    } catch {
      cli.die('Could not parse `az account list --json` output.', { prefix: 'az-ext' });
    }
  }
  const lower = wanted.toLowerCase();
  let hit = subs.filter((s) => String(s.name).toLowerCase() === lower);
  if (hit.length !== 1) hit = subs.filter((s) => String(s.name).toLowerCase().includes(lower));
  if (hit.length === 1) return { id: hit[0].id, name: hit[0].name };
  cli.die(
    hit.length === 0
      ? `No subscription matches "${wanted}". Known: ${subs.map((s) => s.name).join(', ') || '(none)'}`
      : `"${wanted}" is ambiguous: ${hit.map((s) => s.name).join(', ')}`,
    { prefix: 'az-ext' }
  );
}

// ─── shared query runner (chunking + cache accounting) ───────────────────────

/**
 * Run one logical query, chunking the range to satisfy the 1-year cap and
 * concatenating the parsed rows. Reports how many chunks came from cache so the
 * user can see what the call actually cost.
 */
async function runChunked(subId, spec, options) {
  const windows = spec.timeframe === 'Custom' ? chunkRange(spec.from, spec.to) : [null];
  if (windows.length > 1) {
    cli.warn(
      `range spans ${daysBetween(isoStart(spec.from), isoStart(spec.to))} days — splitting into ` +
        `${windows.length} queries (Cost Management caps a single query at ${MAX_QUERY_DAYS} days). ` +
        'Each uncached chunk spends throttle budget.',
      { prefix: 'az-ext' }
    );
  }
  const rows = [];
  let networkRequests = 0;
  let cachedChunks = 0;
  for (const window of windows) {
    const body = buildQuery(
      window
        ? { ...spec, from: window.from, to: window.to }
        : spec
    );
    const res = await costQuery(subId, body, options);
    if (res.cached) cachedChunks++;
    networkRequests += res.requests || 0;
    for (const row of parseRows(res.response)) rows.push(row);
  }
  return { rows: rows, chunks: windows.length, cachedChunks: cachedChunks, networkRequests: networkRequests };
}

function cacheNote(result) {
  if (result.cachedChunks === result.chunks) return c.dim('(from cache — no ARM request, no throttle budget spent)');
  if (result.cachedChunks > 0) {
    return c.dim(`(${result.cachedChunks}/${result.chunks} chunks from cache, ${result.networkRequests} ARM request(s))`);
  }
  return c.dim(`(${result.networkRequests} ARM request(s); cached for reuse)`);
}

function commonOptions(flags) {
  return {
    refresh: Boolean(flags.refresh || flags['no-cache']),
    maxWaitSeconds: num(flags['max-wait'], DEFAULT_MAX_WAIT_SECONDS),
  };
}

/**
 * Resolve --from/--to/--months into an ISO window.
 *
 * `--months N` means "the N most recent months, including the current partial
 * one": from the 1st of the month N-1 back, to today. Anchoring on N-1 (not N)
 * is deliberate — anchoring on N produced a 365-day span for the default N=12,
 * which Cost Management REJECTS (see MAX_QUERY_DAYS). With N-1 the common
 * 12-month request stays a single query instead of silently costing two.
 */
function resolveWindow(flags, defaultMonths) {
  const months = Math.max(1, num(flags.months, defaultMonths));
  const to = str(flags.to) ? isoStart(str(flags.to)) : isoStart(new Date());
  const from = str(flags.from) ? isoStart(str(flags.from)) : isoStart(monthStart(months - 1));
  if (Date.parse(from) >= Date.parse(to)) {
    cli.die(`--from (${from.slice(0, 10)}) must be before --to (${to.slice(0, 10)}).`, { prefix: 'az-ext' });
  }
  return { from: from, to: to };
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdSummary(flags) {
  const sub = await resolveSubscriptionId(flags);
  const window = resolveWindow(flags, 12);
  const result = await runChunked(
    sub.id,
    { timeframe: 'Custom', granularity: 'Monthly', grouping: [], from: window.from, to: window.to },
    commonOptions(flags)
  );

  const byMonth = new Map();
  for (const row of result.rows) {
    const month = monthOf(row) || '(unknown)';
    byMonth.set(month, (byMonth.get(month) || 0) + costOf(row));
  }
  const series = [...byMonth.entries()]
    .map(([month, cost]) => ({ month: month, cost: cost }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  const total = series.reduce((acc, p) => acc + p.cost, 0);
  const currency = currencyOf(result.rows);
  const regime = detectRegimeBreak(series);

  if (flags.json) {
    cli.out({
      subscription: sub,
      from: window.from,
      to: window.to,
      currency: currency,
      total: total,
      months: series,
      regimeBreak: regime,
      cache: { chunks: result.chunks, cachedChunks: result.cachedChunks, armRequests: result.networkRequests },
    });
    return;
  }

  console.log('');
  console.log(`  ${c.bold(sub.name)}  ${c.dim(window.from.slice(0, 10) + ' → ' + window.to.slice(0, 10))}  ${cacheNote(result)}`);
  console.log('');
  const peak = series.reduce((m, p) => Math.max(m, p.cost), 0);
  for (const point of series) {
    const bar = peak > 0 ? '█'.repeat(Math.max(1, Math.round((28 * point.cost) / peak))) : '';
    console.log(`  ${point.month}  ${usd(point.cost).padStart(12)}  ${c.cyan(bar)}`);
  }
  console.log('');
  console.log(`  ${c.bold('TOTAL'.padEnd(9))} ${usd(total).padStart(11)} ${c.dim(currency)}`);
  if (series.length >= 2) {
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    const delta = prev.cost ? ((last.cost - prev.cost) / prev.cost) * 100 : 0;
    console.log(
      `  ${c.dim('latest month')} ${usd(last.cost)} ${c.dim(`(${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% vs ${prev.month})`)}`
    );
  }
  if (regime.break) {
    console.log('');
    cli.warn(
      `REGIME BREAK at ${regime.at}: ${regime.reason}.\n` +
        'Do NOT fit a growth rate across this point — on the measured example a naive\n' +
        'full-history fit returned +98,766%/yr. Split the series at the break, or use\n' +
        '`az-ext cost marketplace` to see whether third-party spend explains it.',
      { prefix: 'az-ext' }
    );
  }
  console.log('');
}

async function cmdServices(flags) {
  const sub = await resolveSubscriptionId(flags);
  const window = resolveWindow(flags, 12);
  const result = await runChunked(
    sub.id,
    { timeframe: 'Custom', granularity: 'None', grouping: ['ServiceName'], from: window.from, to: window.to },
    commonOptions(flags)
  );
  renderBreakdown('ServiceName', sub, window, result, flags, (row) => str(row.ServiceName) || '(unassigned)');
}

async function cmdSku(flags) {
  const sub = await resolveSubscriptionId(flags);
  const window = resolveWindow(flags, 12);
  const result = await runChunked(
    sub.id,
    {
      timeframe: 'Custom',
      granularity: 'None',
      grouping: ['MeterCategory', 'MeterSubCategory'],
      from: window.from,
      to: window.to,
    },
    commonOptions(flags)
  );
  renderBreakdown(
    'MeterCategory / MeterSubCategory',
    sub,
    window,
    result,
    flags,
    (row) => `${str(row.MeterCategory) || '(unassigned)'} / ${str(row.MeterSubCategory) || '(unassigned)'}`,
    'A large "(unassigned)" MeterCategory bucket is almost always third-party\n' +
      'Marketplace spend, not a mystery. Confirm with: az-ext cost marketplace'
  );
}

function renderBreakdown(dimensionLabel, sub, window, result, flags, labelFn, footnote) {
  const totals = new Map();
  for (const row of result.rows) {
    const key = labelFn(row);
    totals.set(key, (totals.get(key) || 0) + costOf(row));
  }
  const items = [...totals.entries()].map(([label, cost]) => ({ label: label, cost: cost })).sort((a, b) => b.cost - a.cost);
  const total = items.reduce((acc, i) => acc + i.cost, 0);
  const currency = currencyOf(result.rows);
  const limit = num(flags.limit, 25);

  if (flags.json) {
    cli.out({
      subscription: sub,
      groupedBy: dimensionLabel,
      from: window.from,
      to: window.to,
      currency: currency,
      total: total,
      items: items,
      cache: { chunks: result.chunks, cachedChunks: result.cachedChunks, armRequests: result.networkRequests },
    });
    return;
  }
  console.log('');
  console.log(
    `  ${c.bold(sub.name)}  ${c.dim(window.from.slice(0, 10) + ' → ' + window.to.slice(0, 10))}  ` +
      `${c.dim('by ' + dimensionLabel)}  ${cacheNote(result)}`
  );
  console.log('');
  for (const item of items.slice(0, limit)) {
    console.log(
      `  ${c.bold(item.label.slice(0, 46).padEnd(46))} ${usd(item.cost).padStart(12)} ${c.dim(pct(item.cost, total).padStart(6))}`
    );
  }
  if (items.length > limit) console.log(`  ${c.dim(`… ${items.length - limit} more (--limit ${items.length})`)}`);
  console.log('');
  console.log(`  ${c.bold('TOTAL'.padEnd(46))} ${usd(total).padStart(12)} ${c.dim(currency)}`);
  if (footnote) {
    console.log('');
    console.log(
      footnote
        .split('\n')
        .map((line) => '  ' + c.yellow('note: ') + line)
        .join('\n')
    );
  }
  console.log('');
}

async function cmdMarketplace(flags) {
  const sub = await resolveSubscriptionId(flags);
  const window = resolveWindow(flags, 12);
  const options = commonOptions(flags);

  const primary = await runChunked(
    sub.id,
    {
      timeframe: 'Custom',
      granularity: 'None',
      grouping: ['PublisherType', 'ServiceName'],
      from: window.from,
      to: window.to,
    },
    options
  );
  const split = splitByPublisher(primary.rows);
  const currency = currencyOf(primary.rows);

  // Best-effort vendor naming. This is a SECOND throttled query, so it is
  // served from cache when possible and degrades to "not attempted" rather than
  // failing the command — the split above is the answer people came for.
  let vendors = null;
  let vendorNote = null;
  if (flags['no-vendors']) {
    vendorNote = 'vendor lookup skipped (--no-vendors)';
  } else if (split.thirdParty.total <= 0) {
    vendorNote = 'no third-party spend to attribute';
  } else {
    const vendorSpec = {
      timeframe: 'Custom',
      granularity: 'None',
      grouping: ['PublisherType', 'ResourceId'],
      from: window.from,
      to: window.to,
    };
    const cachedOnly = !flags.vendors;
    const body = buildQuery({ ...vendorSpec, from: chunkRange(window.from, window.to)[0].from, to: chunkRange(window.from, window.to)[0].to });
    const hit = await cacheGet(sub.id, body);
    if (hit) {
      vendors = attributeVendors(parseRows(hit.response));
      vendorNote = 'vendors resolved from cached ResourceId query';
    } else if (cachedOnly) {
      vendorNote =
        'vendor names need a second throttled query — pass --vendors to spend one ' +
        '(ResourceId grouping), or read them from `az-ext cost sku`';
    } else {
      try {
        const vres = await runChunked(sub.id, vendorSpec, options);
        vendors = attributeVendors(vres.rows);
        vendorNote = `vendors resolved via ResourceId (${vres.networkRequests} extra ARM request(s))`;
      } catch (err) {
        if (err && err.name === 'NodeExitError') throw err;
        vendorNote = 'vendor lookup failed (likely throttled); the Azure/Marketplace split above still holds';
      }
    }
  }

  if (flags.json) {
    cli.out({
      subscription: sub,
      from: window.from,
      to: window.to,
      currency: currency,
      total: split.total,
      azureNative: split.azure,
      thirdParty: split.thirdParty,
      unknownPublisher: split.unknown,
      thirdPartyShare: split.thirdPartyShare,
      vendors: vendors,
      vendorNote: vendorNote,
      cache: { chunks: primary.chunks, cachedChunks: primary.cachedChunks, armRequests: primary.networkRequests },
    });
    return;
  }

  console.log('');
  console.log(
    `  ${c.bold(sub.name)}  ${c.dim(window.from.slice(0, 10) + ' → ' + window.to.slice(0, 10))}  ` +
      `${c.dim('by PublisherType')}  ${cacheNote(primary)}`
  );
  console.log('');
  console.log(
    `  ${c.bold('Azure-native infrastructure'.padEnd(34))} ${usd(split.azure.total).padStart(12)} ` +
      `${c.dim(pct(split.azure.total, split.total).padStart(7))}`
  );
  for (const bucket of split.azure.buckets) {
    for (const item of bucket.items.slice(0, num(flags.limit, 8))) {
      console.log(`    ${c.dim(item.label.slice(0, 40).padEnd(40))} ${usd(item.cost).padStart(10)}`);
    }
  }
  console.log('');
  console.log(
    `  ${c.bold('Third-party (Marketplace)'.padEnd(34))} ${usd(split.thirdParty.total).padStart(12)} ` +
      `${c.dim(pct(split.thirdParty.total, split.total).padStart(7))}`
  );
  for (const bucket of split.thirdParty.buckets) {
    console.log(`    ${c.yellow(bucket.publisherType)} ${c.dim(usd(bucket.total))}`);
    for (const item of bucket.items.slice(0, num(flags.limit, 8))) {
      const vendor = vendors && vendors.byLabel && vendors.byLabel[item.label];
      const suffix = vendor ? c.dim('  ← ' + vendor) : '';
      console.log(`      ${c.dim(item.label.slice(0, 38).padEnd(38))} ${usd(item.cost).padStart(10)}${suffix}`);
    }
  }
  if (split.unknown.total !== 0) {
    console.log('');
    console.log(
      `  ${c.bold('PublisherType unset'.padEnd(34))} ${usd(split.unknown.total).padStart(12)} ` +
        `${c.dim(pct(split.unknown.total, split.total).padStart(7))}`
    );
  }
  console.log('');
  console.log(`  ${c.bold('TOTAL'.padEnd(34))} ${usd(split.total).padStart(12)} ${c.dim(currency)}`);
  console.log('');
  if (vendors && vendors.top.length) {
    console.log(`  ${c.dim('vendors (from ResourceId):')}`);
    for (const v of vendors.top.slice(0, num(flags.limit, 8))) {
      console.log(`    ${c.bold(v.name.slice(0, 38).padEnd(38))} ${usd(v.cost).padStart(10)} ${c.dim(v.provider || '')}`);
    }
    console.log('');
  }
  if (vendorNote) console.log(`  ${c.dim('note: ' + vendorNote)}`);
  console.log(
    `  ${c.dim('Marketplace spend is third-party software resold through Azure billing —')}\n` +
      `  ${c.dim('it is NOT Azure infrastructure and cannot be optimised with Azure levers.')}`
  );
  console.log('');
}

function attributeVendors(rows) {
  const totals = new Map();
  const byLabel = {};
  for (const row of rows || []) {
    const publisher = str(row.PublisherType) || '';
    if (AZURE_PUBLISHER_TYPES.has(publisher.toLowerCase())) continue;
    const vendor = vendorFromResourceId(row.ResourceId);
    if (!vendor) continue;
    const key = vendor.name;
    const entry = totals.get(key) || { name: key, cost: 0, provider: vendor.provider };
    entry.cost += costOf(row);
    totals.set(key, entry);
    const serviceLabel = str(row.ServiceName);
    if (serviceLabel && !byLabel[serviceLabel]) byLabel[serviceLabel] = key;
  }
  return {
    top: [...totals.values()].sort((a, b) => b.cost - a.cost),
    byLabel: byLabel,
  };
}

async function cmdMtd(flags) {
  const sub = await resolveSubscriptionId(flags);
  const grouping = flags.by ? [requireDimension(flags.by)] : [];
  // MonthToDate + granularity None is the cheapest shape measured, and it often
  // succeeds immediately while a historical Monthly query is being throttled.
  const body = buildQuery({ timeframe: 'MonthToDate', granularity: 'None', grouping: grouping });
  const res = await costQuery(sub.id, body, { ...commonOptions(flags), ttlSeconds: TTL_MTD_SECONDS });
  const rows = parseRows(res.response);
  const total = rows.reduce((acc, row) => acc + costOf(row), 0);
  const currency = currencyOf(rows);

  if (flags.json) {
    cli.out({
      subscription: sub,
      timeframe: 'MonthToDate',
      groupedBy: grouping,
      currency: currency,
      total: total,
      items: rows.map((row) => ({ label: grouping.length ? row[grouping[0]] : 'total', cost: costOf(row) })),
      cached: res.cached,
    });
    return;
  }
  console.log('');
  const note = res.cached
    ? c.dim(`(cached ${Math.round((res.ageSeconds || 0) / 60)}m ago)`)
    : c.dim('(1 ARM request — the cheap MonthToDate shape)');
  console.log(`  ${c.bold(sub.name)}  ${c.dim('month to date')}  ${note}`);
  console.log('');
  if (grouping.length) {
    const items = rows
      .map((row) => ({ label: String(row[grouping[0]] || '(unassigned)'), cost: costOf(row) }))
      .sort((a, b) => b.cost - a.cost);
    for (const item of items.slice(0, num(flags.limit, 25))) {
      console.log(`  ${c.bold(item.label.slice(0, 40).padEnd(40))} ${usd(item.cost).padStart(12)}`);
    }
    console.log('');
  }
  console.log(`  ${c.bold('MONTH TO DATE'.padEnd(40))} ${usd(total).padStart(12)} ${c.dim(currency)}`);
  console.log('');
  console.log(`  ${c.dim('Month-to-date is not a run rate: Marketplace subscriptions can bill in')}`);
  console.log(`  ${c.dim('one lump. Compare against az-ext cost summary before extrapolating.')}`);
  console.log('');
}

async function cmdDimensions(flags) {
  if (flags.check) {
    const v = validateDimension(str(flags.check));
    if (!v.ok) cli.die(v.message, { prefix: 'az-ext' });
    console.log(`${c.green('✓')} ${v.dimension} is a valid grouping dimension.`);
    return;
  }
  if (flags.json) {
    cli.out({ dimensions: VALID_DIMENSIONS });
    return;
  }
  console.log('');
  console.log(`  ${c.bold('Valid Cost Management grouping dimensions')} ${c.dim('(validated locally — 0 quota)')}`);
  console.log('');
  for (let i = 0; i < VALID_DIMENSIONS.length; i += 3) {
    console.log('  ' + VALID_DIMENSIONS.slice(i, i + 3).map((d) => d.padEnd(26)).join(''));
  }
  console.log('');
  console.log(`  ${c.yellow('PublisherType')} ${c.dim('is the important one: it separates Azure-native spend from')}`);
  console.log(`  ${c.dim('third-party Marketplace spend. PublisherName does NOT exist.')}`);
  console.log('');
}

async function cmdCache(flags) {
  if (flags.clear) {
    const entries = await cacheList();
    let removed = 0;
    for (const entry of entries) {
      try {
        await fs.rm(cachePath(entry.key));
        removed++;
      } catch {
        // A cache file we cannot remove is not fatal — report the count we did.
      }
    }
    console.log(
      `${c.green('✓')} cleared ${removed}/${entries.length} cached cost responses from ${CACHE_DIR}\n` +
        c.yellow('  Warning: ') +
        c.dim('the next query re-spends throttle budget (~1 historical query / 5 min).')
    );
    return;
  }
  const entries = await cacheList();
  if (flags.json) {
    cli.out({ dir: CACHE_DIR, entries: entries });
    return;
  }
  console.log('');
  console.log(`  ${c.bold('cost query cache')}  ${c.dim(CACHE_DIR)}`);
  console.log('');
  if (!entries.length) {
    console.log(`  ${c.dim('(empty)')}`);
    console.log('');
    return;
  }
  for (const entry of entries) {
    if (entry.corrupt) {
      console.log(`  ${c.red('corrupt')} ${entry.key}`);
      continue;
    }
    const age = Math.round((nowSeconds() - num(entry.fetchedAt, nowSeconds())) / 60);
    const state = entry.expired ? c.yellow('expired') : c.green('fresh  ');
    console.log(
      `  ${state} ${c.dim(entry.key.slice(0, 12))} ${String(entry.timeframe || '').padEnd(12)} ` +
        `${String(entry.granularity || '').padEnd(8)} ${String(entry.grouping).padEnd(30)} ` +
        `${String(entry.rows).padStart(4)} rows  ${c.dim(age + 'm old')}`
    );
  }
  console.log('');
  console.log(`  ${c.dim('A fresh entry answers without touching ARM — that is the throttle mitigation.')}`);
  console.log('');
}

// ─── help + routing ──────────────────────────────────────────────────────────

const HELP = `
az-ext — SLICC-only Azure Cost Management analysis (not part of the real az CLI).
         Auth comes from \`az login --from-tab\`; run that first.

USAGE
  az-ext cost summary     --subscription <id|name> [--months N] [--from D --to D] [--json]
      Monthly totals (granularity Monthly), cached to disk, with a regime-break
      warning when a Marketplace subscription starts or stops mid-series.

  az-ext cost marketplace --subscription <id|name> [--months N] [--vendors] [--json]
      THE IMPORTANT ONE. Splits spend by PublisherType into Azure-native
      infrastructure vs third-party Marketplace software, and names vendors from
      ResourceId where it can. A big "unassigned" MeterCategory bucket is
      Marketplace spend, not a mystery.

  az-ext cost sku         --subscription <id|name> [--months N] [--limit N] [--json]
      Group by MeterCategory + MeterSubCategory.

  az-ext cost services    --subscription <id|name> [--months N] [--limit N] [--json]
      Group by ServiceName.

  az-ext cost mtd         --subscription <id|name> [--by <dimension>] [--json]
      Month-to-date. The CHEAP fast path (MonthToDate + granularity None) —
      usually succeeds even while historical queries are throttled.

  az-ext cost dimensions  [--check <name>] [--json]
      The valid grouping dimensions, offline. Zero quota.

  az-ext cost cache       [--list] [--clear] [--json]
      Inspect or drop the on-disk response cache.

COMMON FLAGS
  --subscription <id|name>  GUID, exact name, or unique substring. Falls back to
                            the default from \`az account set\`.
  --months N                Window length in whole months, ending at the 1st of
                            the current month. Default 12.
  --from / --to YYYY-MM-DD  Explicit window. Ranges over 366 days are chunked.
  --refresh                 Ignore the cache and re-query (spends quota).
  --max-wait S              Seconds to spend backing off a 429. Default ${DEFAULT_MAX_WAIT_SECONDS}.
  --limit N                 Rows to print. Default 25.
  --json                    Raw structured output.

THROTTLING (read this before scripting anything)
  Historical cost queries are throttled to roughly ONE PER FIVE MINUTES per
  subscription, answered with HTTP 429 and NO Retry-After header. So:
    * every successful response is cached to disk — reruns and --json are free;
    * 429s are backed off with visible progress, never reported as a generic error;
    * \`cost mtd\` is the cheap escape hatch when history is throttled;
    * \`cost dimensions\` validates a dimension name for zero quota.

EXAMPLES
  az login --from-tab
  az-ext cost mtd         --subscription "DMa/Helix PRD"
  az-ext cost summary     --subscription "DMa/Helix PRD" --months 13
  az-ext cost marketplace --subscription "DMa/Helix PRD" --vendors
  az-ext cost sku         --subscription "DMa/Helix PRD" --json
  az-ext cost cache --list
`.trim();

const parsed = process.argv.parseFlags();
const positional = parsed.positional;
const flags = parsed.flags;

async function route() {
  const [group, sub] = positional;
  if (group !== 'cost') {
    cli.die(`unknown command group: ${group}\nOnly 'cost' exists. Run 'az-ext --help'.`, { prefix: 'az-ext' });
  }
  switch (sub) {
    case 'summary':
      return await cmdSummary(flags);
    case 'marketplace':
      return await cmdMarketplace(flags);
    case 'sku':
      return await cmdSku(flags);
    case 'services':
      return await cmdServices(flags);
    case 'mtd':
      return await cmdMtd(flags);
    case 'dimensions':
      return await cmdDimensions(flags);
    case 'cache':
      return await cmdCache(flags);
    default:
      cli.die(
        `unknown cost subcommand: ${sub || '(none)'}\n` +
          'Try: summary | marketplace | sku | services | mtd | dimensions | cache',
        { prefix: 'az-ext' }
      );
  }
}

async function main() {
  if (flags.help || flags.h || positional.length === 0 || positional[0] === 'help') cli.help(HELP);
  try {
    return await route();
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err && err.message ? err.message : String(err), { prefix: 'az-ext' });
  }
}

// Test seam: the unit tests evaluate this file with AZ_EXT_NO_MAIN=1 to exercise
// the parser, the dimension validator, the chunker and the cache/429 path
// against fixtures and a stubbed fetch, without dispatching a command.
module.exports = {
  parseRows,
  costOf,
  currencyOf,
  monthOf,
  splitByPublisher,
  vendorFromResourceId,
  validateDimension,
  chunkRange,
  buildQuery,
  detectRegimeBreak,
  costQuery,
  cacheGet,
  cacheSet,
  cacheKeyFor,
  cacheList,
  describeQuery,
  readRetryAfter,
  VALID_DIMENSIONS,
  BACKOFF_SECONDS,
  MAX_QUERY_DAYS,
  CACHE_DIR,
};

if (process.env.AZ_EXT_NO_MAIN !== '1') {
  // MUST be awaited: the runtime exits before an un-awaited promise settles,
  // which silently yields rc=0 and no output.
  await main();
}
