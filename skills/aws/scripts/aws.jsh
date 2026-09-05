// aws.jsh — a working subset of the official AWS CLI (`aws`), implemented
// directly against the AWS query/JSON APIs with a hand-rolled SigV4 signer.
//
// Design rule: command and flag names mirror the real AWS CLI EXACTLY
// (`aws sts get-caller-identity`, `aws ce get-cost-and-usage --time-period
// Start=…,End=…`, `aws configure list`) so copied docs and muscle memory
// transfer. Anything the upstream CLI does NOT have — cost analysis, discount
// breakouts, regime-break detection, the signer self-test — lives in the
// sibling binary `aws-ext` (scripts/aws-ext.jsh), exactly as the fastly skill
// splits billing into `fastly-ext` and gcloud splits cost into `gcloud-ext`.
//
// Auth: SigV4 over credentials from the environment (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN — env wins, as in the real CLI) or
// from skill.config() via `aws configure set`. Secrets are never printed.
//
// RUNTIME NOTE: everything here is awaited from top-level await. WebCrypto HMAC
// is async and this runtime EXITS BEFORE AN UN-AWAITED PROMISE SETTLES — a bare
// `main()` or `(async()=>{…})()` exits rc=0 with no output at all.

const cli = require('sliccy:cli');
const skill = require('sliccy:skill');
const c = require('sliccy:color');
// Literal require: this runtime pre-registers VFS modules by scanning literal
// specifiers, so a computed path would fail with "Cannot find module".
const sigv4 = require('./lib/sigv4.js');

const SKILL_VERSION = '1.0.0';

// ─── Service endpoints ───────────────────────────────────────────────────────

// Cost Explorer is a single-region service: the endpoint is us-east-1 no matter
// where your resources live, and the SigV4 region must match the endpoint.
const CE_HOST = 'ce.us-east-1.amazonaws.com';
const CE_REGION = 'us-east-1';
const CE_SERVICE = 'ce';
const CE_TARGET_PREFIX = 'AWSInsightsIndexService';
const CE_CONTENT_TYPE = 'application/x-amz-json-1.1';

// STS's global endpoint is signed for us-east-1.
const STS_HOST = 'sts.amazonaws.com';
const STS_REGION = 'us-east-1';
const STS_SERVICE = 'sts';

const VALID_DIMENSIONS = [
  'SERVICE',
  'USAGE_TYPE',
  'USAGE_TYPE_GROUP',
  'REGION',
  'RECORD_TYPE',
  'LINKED_ACCOUNT',
  'OPERATION',
  'PURCHASE_TYPE',
  'INSTANCE_TYPE',
  'AZ',
  'PLATFORM',
  'TENANCY',
];

const HELP = `aws — AWS CLI subset for SLICC (SigV4-signed, no aws binary required)

Usage: aws <service> <command> [flags]

  aws sts get-caller-identity [--json]
      Verify credentials. Prints Account, Arn, UserId — the fastest check that
      a key pair or STS session token is live and which account it belongs to.

  aws ce get-cost-and-usage [flags]
      Cost Explorer GetCostAndUsage.
        --start YYYY-MM-DD        window start (inclusive)  default: 6 months ago
        --end YYYY-MM-DD          window end (EXCLUSIVE)    default: next month
        --time-period Start=..,End=..   real-CLI form, equivalent to the above
        --granularity MONTHLY|DAILY|HOURLY                   default: MONTHLY
        --metrics UnblendedCost[,UsageQuantity,...]           default: UnblendedCost
        --group-by SERVICE|RECORD_TYPE|REGION|...  (repeatable, or comma-separated)
        --group-by Type=DIMENSION,Key=SERVICE      (real-CLI form)
        --filter '<json>'         raw Cost Explorer Expression
        --json                    raw API response

  aws ce get-dimension-values --dimension SERVICE [--start D] [--end D] [--json]
      Enumerate the values a dimension actually has in your account.

  aws configure list                 Credential + region status (secrets masked)
  aws configure set <key> <value>    aws_access_key_id | aws_secret_access_key |
                                     aws_session_token | region
  aws configure unset <key>          Remove one stored value
  aws --version                      Skill version and endpoints

Credentials come from the environment first (AWS_ACCESS_KEY_ID,
AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN), then from stored skill config.

Cost ANALYSIS (monthly summaries, gross-vs-net discounts, regime breaks,
per-service drilldown, linked accounts) is not in the upstream CLI and lives in
the sibling binary:  aws-ext cost --help

Use long flags with values (--start 2026-01-01): this runtime hands single-dash
flags over as booleans and never captures a following value.`;

// ─── Small helpers ───────────────────────────────────────────────────────────

/** Flag values are strings only when a value was actually supplied; a bare
 *  `--flag` or a single-dash short flag arrives as boolean true. Coerce those
 *  to undefined so `true` never leaks into a URL, header or API payload. */
function str(v) {
  if (Array.isArray(v)) {
    const last = v.filter((x) => typeof x === 'string').pop();
    return last;
  }
  return typeof v === 'string' ? v : undefined;
}

/** Collect a repeatable flag into an array of strings. */
function list(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .filter((x) => typeof x === 'string')
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);
}

/** ISO date (YYYY-MM-DD) for the first of the month, `delta` months from the
 *  first of the current UTC month. All Cost Explorer dates are UTC. */
function monthStart(delta) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + (delta || 0), 1));
  return d.toISOString().slice(0, 10);
}

/** A real calendar date in Cost Explorer's YYYY-MM-DD form. Shape alone is not
 *  enough: "2026-13-99" matches the regex, and letting it through produces a
 *  baffling downstream comparison error instead of naming the bad flag. */
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function fmtUSD(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '-' : ''}$${s}`;
}

function pad(s, w) {
  const t = String(s);
  return t.length >= w ? t : t + ' '.repeat(w - t.length);
}

function padLeft(s, w) {
  const t = String(s);
  return t.length >= w ? t : ' '.repeat(w - t.length) + t;
}

async function loadConfig() {
  // MUST await before the `|| {}` fallback: skill.config() returns a Promise,
  // which is always truthy, so `skill.config() || {}` never falls back and then
  // reading a property off a null resolved config throws.
  const raw = (await skill.config()) || {};
  // Treat null/'' as absent: a cleared value must not read as a stored
  // credential further down (and `null` is what an older unset could leave).
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

// ─── Credentials ─────────────────────────────────────────────────────────────

const CRED_HELP = `No AWS credentials found.

Export them for this session (the environment always wins, as in the real CLI):
  export AWS_ACCESS_KEY_ID=ASIA...
  export AWS_SECRET_ACCESS_KEY=...
  export AWS_SESSION_TOKEN=...        # required for federated/STS credentials
                                      # (e.g. an Adobe klam-master-role session)

Or store them durably in the skill config:
  aws configure set aws_access_key_id ASIA...
  aws configure set aws_secret_access_key ...
  aws configure set aws_session_token ...

Then verify with:
  aws sts get-caller-identity`;

/** Resolve credentials: environment first, then stored skill config. Returns
 *  { accessKeyId, secretAccessKey, sessionToken?, source } or dies with an
 *  actionable message — never a stack trace. */
async function getCredentials() {
  const fromEnv = sigv4.credentialsFromEnv(process.env);
  if (fromEnv) return fromEnv;
  const cfg = await loadConfig();
  if (cfg.aws_access_key_id && cfg.aws_secret_access_key) {
    warnIfExpired(cfg.expiration);
    return {
      accessKeyId: cfg.aws_access_key_id,
      secretAccessKey: cfg.aws_secret_access_key,
      sessionToken: cfg.aws_session_token || undefined,
      source: 'skill config',
    };
  }
  cli.die(CRED_HELP, { prefix: 'aws' });
}

function warnIfExpired(expiration) {
  if (!expiration) return;
  const t = Date.parse(expiration);
  if (!Number.isFinite(t)) return;
  if (t < Date.now()) {
    cli.warn(
      `stored credentials expired at ${new Date(t).toISOString()} — refresh them (see \`aws configure list\`)`,
      { prefix: 'aws' },
    );
  }
}

/** Turn an AWS auth failure into an instruction. Temporary STS credentials are
 *  the common case (an Adobe klam-master-role session lasts ~4h), so an expired
 *  token must not read as "wrong key" or "no permission". */
function credentialErrorHelp(cred, bodyText) {
  if (sigv4.isExpiredCredentialError(bodyText)) {
    const temp = !!cred.sessionToken;
    return (
      `\n\nThese credentials are no longer valid${temp ? ' — they look like temporary STS session credentials' : ''}.` +
      (temp
        ? '\n  Temporary session credentials are short-lived (an Adobe klam-master-role session is ~4h).' +
          '\n  Re-federate, then re-export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN' +
          '\n  (all three — a refreshed key pair with a stale AWS_SESSION_TOKEN fails exactly like this).'
        : '\n  Check the key pair, or that AWS_SESSION_TOKEN is set if these are temporary credentials.') +
      `\n  Credential source: ${cred.source}. Verify with: aws sts get-caller-identity`
    );
  }
  if (/AccessDenied|not authorized|UnauthorizedOperation/i.test(bodyText || '')) {
    return (
      '\n\nThe credentials are valid but lack permission for this call.' +
      '\n  Cost Explorer needs ce:GetCostAndUsage (and ce:GetDimensionValues).' +
      '\n  Note that Cost Explorer permissions are granted in the PAYER account for' +
      '\n  consolidated billing — a member-account role often cannot read them.'
    );
  }
  return '';
}

// ─── Signed transport ────────────────────────────────────────────────────────

/** Sign and send one request, and render AWS's own error shape when it fails. */
async function awsCall({ host, region, service, target, contentType, body, method }) {
  const cred = await getCredentials();
  const headers = { 'content-type': contentType };
  if (target) headers['x-amz-target'] = target;

  let res;
  try {
    res = await sigv4.request({
      method: method || 'POST',
      host,
      path: '/',
      service,
      region,
      headers,
      body,
      credentials: cred,
    });
  } catch (err) {
    cli.die(`request to ${host} failed: ${err.message}`, { prefix: 'aws' });
  }

  if (!res.ok) {
    const j = res.json || {};
    const code = j.__type || j.Code || errorCodeFromXml(res.text) || `HTTP ${res.status}`;
    const msg = j.message || j.Message || errorMessageFromXml(res.text) || res.text.slice(0, 500);
    cli.die(`${String(code).replace(/^.*#/, '')}: ${msg}${credentialErrorHelp(cred, res.text)}`, {
      prefix: 'aws',
    });
  }
  return res;
}

function errorCodeFromXml(xml) {
  const m = /<Code>([^<]+)<\/Code>/.exec(xml || '');
  return m ? m[1] : undefined;
}

function errorMessageFromXml(xml) {
  const m = /<Message>([^<]*)<\/Message>/.exec(xml || '');
  return m ? m[1] : undefined;
}

// ─── Cost Explorer transport, with the 14-month clamp ────────────────────────

/** Cost Explorer refuses a window older than 14 months unless the account has
 *  historical data enabled:
 *    ValidationException: You haven't enabled historical data beyond 14 months.
 *  Clamping and retrying once is far more useful than failing, so long as the
 *  clamp is reported loudly — a silently shortened window would corrupt any
 *  growth-rate conclusion drawn from it. */
async function ceCall(target, payload) {
  const cred = await getCredentials();
  const send = async (p) => {
    const res = await sigv4.request({
      method: 'POST',
      host: CE_HOST,
      path: '/',
      service: CE_SERVICE,
      region: CE_REGION,
      headers: { 'content-type': CE_CONTENT_TYPE, 'x-amz-target': `${CE_TARGET_PREFIX}.${target}` },
      body: JSON.stringify(p),
      credentials: cred,
    });
    return res;
  };

  let current = payload;
  let clamped = null;
  // Up to 3 clamp attempts, each a month more conservative. The limit is
  // measured from TODAY, not from a month boundary, so the first candidate can
  // still be a few days too early — retrying one month later converges instead
  // of dying with a raw ValidationException.
  for (let attempt = 0; attempt <= 3; attempt++) {
    let res;
    try {
      res = await send(current);
    } catch (err) {
      cli.die(`request to ${CE_HOST} failed: ${err.message}`, { prefix: 'aws' });
    }
    if (res.ok) {
      if (clamped) res.clamped = clamped;
      return res;
    }

    const limit = /historical data beyond (\d+) month/i.exec(res.text || '');
    if (limit && current.TimePeriod && attempt < 3) {
      const months = Number(limit[1]) || 14;
      const candidate = monthStart(-(months - 1 - attempt));
      if (candidate > current.TimePeriod.Start) {
        cli.warn(
          `Cost Explorer allows only ${months} months of history on this account ` +
            `(historical data beyond ${months} months is not enabled).\n` +
            `  Start ${current.TimePeriod.Start} → clamped to ${candidate}. ` +
            'Any trend or growth rate from this window is truncated at the left edge.',
          { prefix: 'aws' },
        );
        current = { ...current, TimePeriod: { ...current.TimePeriod, Start: candidate } };
        clamped = { from: payload.TimePeriod.Start, to: candidate, limitMonths: months };
        continue;
      }
    }

    const j = res.json || {};
    const code = String(j.__type || `HTTP ${res.status}`).replace(/^.*#/, '');
    const msg = j.message || j.Message || (res.text || '').slice(0, 500);
    const clampNote = clamped
      ? `\n\nAlready clamped the window to ${clamped.to} (${clamped.limitMonths}-month limit) and it still failed.` +
        '\n  Pass an explicit, narrower window: --start <YYYY-MM-DD> --end <YYYY-MM-DD>.'
      : '';
    cli.die(`${code}: ${msg}${clampNote}${credentialErrorHelp(cred, res.text)}`, { prefix: 'aws' });
  }
}

/** GetCostAndUsage is paginated by NextPageToken. A monthly window with a
 *  high-cardinality group-by (USAGE_TYPE) really does paginate, and a missing
 *  page silently under-reports the total, so always drain it. */
async function ceGetCostAndUsage(payload) {
  const pages = [];
  let token;
  let clamped;
  let effective = payload;
  for (let i = 0; i < 25; i++) {
    const p = token ? { ...effective, NextPageToken: token } : effective;
    const res = await ceCall('GetCostAndUsage', p);
    if (res.clamped) {
      clamped = res.clamped;
      effective = { ...effective, TimePeriod: { ...effective.TimePeriod, Start: res.clamped.to } };
    }
    const j = res.json || {};
    pages.push(j);
    token = j.NextPageToken;
    if (!token) break;
  }
  const merged = { ...pages[0] };
  merged.ResultsByTime = [];
  // Merge same-period results across pages rather than concatenating them,
  // otherwise one month can appear two or three times in the series.
  const byPeriod = new Map();
  for (const page of pages) {
    for (const r of page.ResultsByTime || []) {
      const key = `${r.TimePeriod.Start}..${r.TimePeriod.End}`;
      if (!byPeriod.has(key)) byPeriod.set(key, { ...r, Groups: [...(r.Groups || [])] });
      else {
        const acc = byPeriod.get(key);
        acc.Groups.push(...(r.Groups || []));
        acc.Estimated = acc.Estimated || r.Estimated;
      }
    }
  }
  merged.ResultsByTime = Array.from(byPeriod.values()).sort((a, b) =>
    a.TimePeriod.Start < b.TimePeriod.Start ? -1 : 1,
  );
  merged.DimensionValueAttributes = pages.flatMap((p) => p.DimensionValueAttributes || []);
  delete merged.NextPageToken;
  if (clamped) merged.Clamped = clamped;
  merged.Pages = pages.length;
  return merged;
}

// ─── Window / group-by parsing ───────────────────────────────────────────────

/** Resolve the time period from --start/--end or the real CLI's
 *  --time-period Start=YYYY-MM-DD,End=YYYY-MM-DD. `End` is EXCLUSIVE in the
 *  Cost Explorer API, so the default end is the 1st of NEXT month — that is
 *  what includes the current (partial, Estimated) month. */
function timePeriod(flags, defaultMonthsBack) {
  let start = str(flags.start);
  let end = str(flags.end);
  const tp = str(flags['time-period']);
  if (tp) {
    for (const part of tp.split(',')) {
      const [k, v] = part.split('=');
      if (!k || !v) continue;
      if (k.trim().toLowerCase() === 'start') start = v.trim();
      if (k.trim().toLowerCase() === 'end') end = v.trim();
    }
  }
  start = start || monthStart(-(defaultMonthsBack === undefined ? 6 : defaultMonthsBack));
  end = end || monthStart(1);
  for (const [name, v] of [
    ['start', start],
    ['end', end],
  ]) {
    if (!isDate(v)) cli.die(`--${name} must be YYYY-MM-DD (got ${JSON.stringify(v)})`, { prefix: 'aws' });
  }
  if (end <= start) {
    cli.die(`--end (${end}) must be after --start (${start}); End is EXCLUSIVE in Cost Explorer.`, {
      prefix: 'aws',
    });
  }
  return { Start: start, End: end };
}

/** Accept both `--group-by SERVICE` and the real CLI's
 *  `--group-by Type=DIMENSION,Key=SERVICE`, repeatable up to the API's max 2. */
function groupBy(flags) {
  const raw = Array.isArray(flags['group-by']) ? flags['group-by'] : [flags['group-by']];
  const specs = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (/type\s*=/i.test(item)) {
      const obj = {};
      for (const part of item.split(',')) {
        const [k, v] = part.split('=');
        if (!k || !v) continue;
        if (k.trim().toLowerCase() === 'type') obj.Type = v.trim().toUpperCase();
        if (k.trim().toLowerCase() === 'key') obj.Key = v.trim();
      }
      if (obj.Type && obj.Key) specs.push(obj);
      continue;
    }
    for (const key of item.split(',').map((s) => s.trim()).filter(Boolean)) {
      const type = String(str(flags['group-by-type']) || 'DIMENSION').toUpperCase();
      specs.push({ Type: type, Key: type === 'DIMENSION' ? key.toUpperCase() : key });
    }
  }
  for (const s of specs) {
    if (s.Type === 'DIMENSION' && !VALID_DIMENSIONS.includes(s.Key)) {
      cli.warn(`unusual group-by dimension "${s.Key}" — known values: ${VALID_DIMENSIONS.join(', ')}`, {
        prefix: 'aws',
      });
    }
  }
  if (specs.length > 2) {
    cli.die('Cost Explorer accepts at most 2 --group-by dimensions per call.', { prefix: 'aws' });
  }
  return specs;
}

function metrics(flags, dflt) {
  const m = list(flags.metrics);
  return m.length ? m : dflt || ['UnblendedCost'];
}

function parseFilter(flags) {
  const f = str(flags.filter);
  if (!f) return undefined;
  try {
    return JSON.parse(f);
  } catch (err) {
    cli.die(
      `--filter must be a Cost Explorer Expression as JSON: ${err.message}\n` +
        `  e.g. --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon Simple Storage Service"]}}'`,
      { prefix: 'aws' },
    );
  }
}

// ─── Commands: sts ───────────────────────────────────────────────────────────

async function cmdGetCallerIdentity(flags) {
  // The STS query API answers XML for GetCallerIdentity; this is the exact
  // request shape documented for SigV4 form POSTs.
  const res = await awsCall({
    host: STS_HOST,
    region: STS_REGION,
    service: STS_SERVICE,
    contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    body: 'Action=GetCallerIdentity&Version=2011-06-15',
  });
  const pick = (tag) => {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(res.text || '');
    return m ? m[1] : undefined;
  };
  const out = { UserId: pick('UserId'), Account: pick('Account'), Arn: pick('Arn') };
  if (flags.json) return cli.out(out);
  const cred = await getCredentials();
  cli.out(
    `${c.bold('Account')}  ${out.Account}\n` +
      `${c.bold('Arn')}      ${out.Arn}\n` +
      `${c.bold('UserId')}   ${out.UserId}\n` +
      c.dim(
        `credentials: ${cred.source}${cred.sessionToken ? ' (temporary STS session credentials)' : ' (long-term key pair)'}`,
      ),
  );
}

// ─── Commands: ce ────────────────────────────────────────────────────────────

async function cmdGetCostAndUsage(flags) {
  const payload = {
    TimePeriod: timePeriod(flags, 6),
    Granularity: String(str(flags.granularity) || 'MONTHLY').toUpperCase(),
    Metrics: metrics(flags),
  };
  const gb = groupBy(flags);
  if (gb.length) payload.GroupBy = gb;
  const filter = parseFilter(flags);
  if (filter) payload.Filter = filter;

  const data = await ceGetCostAndUsage(payload);
  if (flags.json) return cli.out(data);

  const metric = payload.Metrics[0];
  const lines = [];
  lines.push(
    c.dim(
      `${payload.TimePeriod.Start} → ${payload.TimePeriod.End} (End exclusive), ` +
        `${payload.Granularity}, ${payload.Metrics.join('+')}` +
        (gb.length ? `, grouped by ${gb.map((g) => g.Key).join(' × ')}` : ''),
    ),
  );
  for (const r of data.ResultsByTime || []) {
    const est = r.Estimated ? c.yellow(' [Estimated — partial period]') : '';
    if (!r.Groups || r.Groups.length === 0) {
      const amt = Number(r.Total?.[metric]?.Amount || 0);
      lines.push(`${c.bold(r.TimePeriod.Start)}  ${padLeft(fmtUSD(amt), 14)}${est}`);
      continue;
    }
    const rows = r.Groups.map((g) => ({
      key: (g.Keys || []).join(' / '),
      amount: Number(g.Metrics?.[metric]?.Amount || 0),
      quantity: g.Metrics?.UsageQuantity?.Amount,
    })).sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, x) => s + x.amount, 0);
    lines.push(`\n${c.bold(r.TimePeriod.Start)}  total ${fmtUSD(total)}${est}`);
    const width = Math.min(46, Math.max(...rows.map((x) => x.key.length), 8));
    for (const row of rows) {
      if (row.amount === 0 && !row.quantity) continue;
      const q = row.quantity ? c.dim(`  ${Number(row.quantity).toLocaleString('en-US')} units`) : '';
      const amt = row.amount < 0 ? c.green(padLeft(fmtUSD(row.amount), 14)) : padLeft(fmtUSD(row.amount), 14);
      lines.push(`  ${pad(row.key.slice(0, width), width)} ${amt}${q}`);
    }
  }
  if (data.Clamped) {
    lines.push(
      c.yellow(
        `\nWindow clamped: start ${data.Clamped.from} → ${data.Clamped.to} ` +
          `(${data.Clamped.limitMonths}-month Cost Explorer history limit).`,
      ),
    );
  }
  cli.out(lines.join('\n'));
}

async function cmdGetDimensionValues(flags) {
  const dim = String(str(flags.dimension) || '').toUpperCase();
  if (!dim) {
    cli.die(`--dimension is required, e.g. --dimension SERVICE\n  known: ${VALID_DIMENSIONS.join(', ')}`, {
      prefix: 'aws',
    });
  }
  const res = await ceCall('GetDimensionValues', {
    TimePeriod: timePeriod(flags, 1),
    Dimension: dim,
    Context: 'COST_AND_USAGE',
  });
  const j = res.json || {};
  if (flags.json) return cli.out(j);
  const vals = (j.DimensionValues || []).map((v) => v.Value);
  cli.out(
    `${c.bold(`${dim} (${vals.length})`)}\n${vals.map((v) => `  ${v}`).join('\n')}` +
      (j.ReturnSize && j.TotalSize && j.ReturnSize < j.TotalSize
        ? c.dim(`\n  … ${j.ReturnSize} of ${j.TotalSize} (paginated)`)
        : ''),
  );
}

// ─── Commands: configure ─────────────────────────────────────────────────────

const CONFIG_KEYS = ['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token', 'region', 'expiration'];

/** Mask a value for display. An access key id is safe-ish to tail (that is what
 *  the real CLI does); a secret or a session token is never partially shown. */
function maskKeyId(v) {
  if (!v) return null;
  return `${'*'.repeat(Math.max(0, String(v).length - 4))}${String(v).slice(-4)}`;
}

async function cmdConfigureList(flags) {
  const cfg = await loadConfig();
  const env = process.env || {};
  const rows = [];
  const add = (name, value, type, loc) =>
    rows.push({ name, value: value || c.dim('<not set>'), type: value ? type : '', location: value ? loc : '' });

  const envKey = env.AWS_ACCESS_KEY_ID || env.AWS_ACCESS_KEY;
  const envSecret = env.AWS_SECRET_ACCESS_KEY || env.AWS_SECRET_KEY;
  const envToken = env.AWS_SESSION_TOKEN || env.AWS_SECURITY_TOKEN;

  add('access_key', maskKeyId(envKey || cfg.aws_access_key_id), envKey ? 'env' : 'config', envKey ? 'AWS_ACCESS_KEY_ID' : 'skill config');
  add(
    'secret_key',
    (envSecret || cfg.aws_secret_access_key) ? '****************' : null,
    envSecret ? 'env' : 'config',
    envSecret ? 'AWS_SECRET_ACCESS_KEY' : 'skill config',
  );
  add(
    'session_token',
    (envToken || cfg.aws_session_token) ? `<set, ${String(envToken || cfg.aws_session_token).length} chars>` : null,
    envToken ? 'env' : 'config',
    envToken ? 'AWS_SESSION_TOKEN' : 'skill config',
  );
  add('region', env.AWS_REGION || env.AWS_DEFAULT_REGION || cfg.region || CE_REGION, env.AWS_REGION ? 'env' : 'config', env.AWS_REGION ? 'AWS_REGION' : 'skill config (Cost Explorer is always us-east-1)');

  if (flags.json) {
    return cli.out({
      access_key: maskKeyId(envKey || cfg.aws_access_key_id),
      secret_key_set: !!(envSecret || cfg.aws_secret_access_key),
      session_token_set: !!(envToken || cfg.aws_session_token),
      region: env.AWS_REGION || cfg.region || CE_REGION,
      source: envKey ? 'environment' : cfg.aws_access_key_id ? 'skill config' : 'none',
    });
  }

  const out = [
    `${pad('      Name', 18)}${pad('Value', 26)}${pad('Type', 9)}Location`,
    `${pad('      ----', 18)}${pad('-----', 26)}${pad('----', 9)}--------`,
  ];
  for (const r of rows) out.push(`${pad(r.name, 18)}${pad(r.value, 26)}${pad(r.type, 9)}${c.dim(r.location)}`);
  const anyCreds = (envKey && envSecret) || (cfg.aws_access_key_id && cfg.aws_secret_access_key);
  out.push('');
  out.push(anyCreds ? c.dim('Verify they actually work: aws sts get-caller-identity') : c.yellow(CRED_HELP));
  if (cfg.expiration) {
    const t = Date.parse(cfg.expiration);
    out.push(
      Number.isFinite(t) && t < Date.now()
        ? c.red(`Stored credentials EXPIRED at ${cfg.expiration}`)
        : c.dim(`Stored credentials expire at ${cfg.expiration}`),
    );
  }
  cli.out(out.join('\n'));
}

async function cmdConfigureSet(args) {
  const [key, ...rest] = args;
  const value = rest.join(' ');
  if (!key || !value) {
    cli.die(`usage: aws configure set <key> <value>\n  keys: ${CONFIG_KEYS.join(', ')}`, { prefix: 'aws' });
  }
  const k = key.toLowerCase();
  if (!CONFIG_KEYS.includes(k)) {
    cli.die(`unknown config key "${key}"\n  keys: ${CONFIG_KEYS.join(', ')}`, { prefix: 'aws' });
  }
  await saveConfig({ [k]: value });
  // Deliberately does not echo the value.
  cli.out(c.green(`stored ${k} (${value.length} chars) in the skill config`));
}

async function cmdConfigureUnset(args) {
  const k = (args[0] || '').toLowerCase();
  if (!CONFIG_KEYS.includes(k)) {
    cli.die(`usage: aws configure unset <key>\n  keys: ${CONFIG_KEYS.join(', ')}`, { prefix: 'aws' });
  }
  const cur = await loadConfig();
  if (cur[k] === undefined) {
    cli.out(c.dim(`${k} was not set in the skill config`));
    return;
  }
  // skill.config() MERGES — writing a whole object with the key deleted leaves
  // the old value in place (and would print a reassuring lie). Passing
  // `undefined` for the key is what actually removes it.
  await skill.config({ [k]: undefined });
  const after = await loadConfig();
  if (after[k] !== undefined) {
    cli.die(`could not remove ${k} from the skill config — it is still set.`, { prefix: 'aws' });
  }
  cli.out(c.green(`removed ${k} from the skill config`));
}

async function cmdVersion() {
  cli.out(
    `aws-skill/${SKILL_VERSION} (SLICC .jsh, SigV4 via WebCrypto — crypto.createHmac does not exist here)\n` +
      c.dim(`  cost explorer: https://${CE_HOST} (service ce, region ${CE_REGION})\n`) +
      c.dim(`  sts:           https://${STS_HOST} (service sts, region ${STS_REGION})\n`) +
      c.dim('  extensions:    aws-ext cost --help'),
  );
}

// ─── Router ──────────────────────────────────────────────────────────────────

const parsed = process.argv.parseFlags();
const { positional, flags } = parsed;
const service = (positional[0] || '').toLowerCase();
const command = (positional[1] || '').toLowerCase();

try {
  if (flags.help || flags.h || !service || service === 'help') cli.help(HELP);
  if (flags.version || service === '--version' || service === 'version') {
    await cmdVersion();
  } else if (service === 'sts') {
    if (command === 'get-caller-identity' || !command) await cmdGetCallerIdentity(flags);
    else
      cli.die(`unknown sts command: ${command}\n  aws sts get-caller-identity`, { prefix: 'aws' });
  } else if (service === 'ce' || service === 'cost-explorer') {
    if (command === 'get-cost-and-usage') await cmdGetCostAndUsage(flags);
    else if (command === 'get-dimension-values') await cmdGetDimensionValues(flags);
    else
      cli.die(
        `unknown ce command: ${command || '(none)'}\n` +
          '  aws ce get-cost-and-usage --start D --end D --granularity MONTHLY --group-by SERVICE\n' +
          '  aws ce get-dimension-values --dimension SERVICE\n' +
          '  analysis (discounts, breaks, drilldown): aws-ext cost --help',
        { prefix: 'aws' },
      );
  } else if (service === 'configure') {
    if (command === 'list' || !command) await cmdConfigureList(flags);
    else if (command === 'set') await cmdConfigureSet(positional.slice(2));
    else if (command === 'unset') await cmdConfigureUnset(positional.slice(2));
    else if (command === 'get')
      cli.die('`aws configure get` is not supported: it would print a secret to stdout. Use `aws configure list`.', {
        prefix: 'aws',
      });
    else cli.die(`unknown configure command: ${command}\n  aws configure list | set <k> <v> | unset <k>`, { prefix: 'aws' });
  } else if (service === 'cost' || service === 'ce-ext') {
    cli.die(
      'Cost analysis is not part of the upstream AWS CLI, so it lives in a separate binary.\n' +
        '  Try: aws-ext cost summary | discounts | breaks | detail | accounts',
      { prefix: 'aws' },
    );
  } else {
    cli.die(
      `unknown service: ${service}\n  aws sts | ce | configure    (see aws --help)\n` +
        '  Only Cost Explorer and STS are wrapped. This is a cost/billing skill, not an EC2/S3 management CLI.',
      { prefix: 'aws' },
    );
  }
} catch (err) {
  if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw
  cli.die(err.message, { prefix: 'aws' });
}
