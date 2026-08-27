// wrangler-ext.jsh — SLICC-only extensions to the `cloudflare` skill: billing.
//
// The real `wrangler` CLI (github.com/cloudflare/workers-sdk) has NO billing
// command group — it manages Workers, KV, D1, R2 and secrets, and never touches
// invoices. To keep the sibling `wrangler` command-compatible with the upstream
// tool, billing lives here in a separate binary, exactly as the `fastly` skill
// splits invoices into `fastly-ext billing` and `gcloud` into `gcloud-ext
// billing cost`.
//
// Transport: the *dashboard* REST API (`/api/v4/...`), issued same-origin from
// an open, logged-in `dash.cloudflare.com` tab through the `sliccy:browser`
// bridge — the identical auth model `wrangler.jsh` uses for GraphQL analytics.
// There is no public Cloudflare billing API and no API-token scope that reaches
// invoices; the dashboard session is the only door.
//
// Endpoints (all verified live — see references/BILLING.md for dead ends):
//   GET /api/v4/accounts/<acct>/billing/history?page=N&per_page=50
//   GET /api/v4/accounts/<acct>/billing/receipts/<uuid>/pdf?doctype=invoice&isLegacy=false
//   GET /api/v4/accounts/<acct>/subscriptions
//
// The point of this tool is `billing contracts`. On a shared enterprise account
// the invoice list mixes the parent org's multi-hundred-thousand-dollar contract
// renewals with your team's much smaller ones, and the *contract number* printed
// on each PDF is the only reliable discriminator. Summing the account blindly
// overstated one team's real spend by ~20x.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const exec = require('sliccy:exec');
const c = require('sliccy:color');
const fs = require('fs');

// ─── constants ───────────────────────────────────────────────────────────────

const DASH = 'dash.cloudflare.com';

// billing/history silently CLAMPS per_page to 50 — a larger value returns 50
// rows and reports per_page:50 back, so it must be paginated, never widened.
const PER_PAGE = 50;
const MAX_PAGES = 40; // 2000 records; the measured account has 319.

// result_info carries {page, per_page, next_page} — there is NO total_pages and
// no total count. Pagination stops on next_page === false.

// How many PDFs `contracts` will download to look up contract numbers, before
// it stops and says so. Each PDF is ~93-97 KB.
const DEFAULT_PDF_BUDGET = 16;

// Cadence classification from the median gap between invoices in a family.
const CADENCE = [
  { max: 12, name: 'sub-weekly' },
  { max: 45, name: 'monthly' },
  { max: 120, name: 'quarterly' },
  { max: 200, name: 'semi-annual' },
  { max: 500, name: 'annual' },
];

const HOME = (process.env && (process.env.HOME || process.env.USERPROFILE)) || '/root';
const CONFIG_DIR = HOME + '/.config/wrangler';
const ACCOUNT_FILE = CONFIG_DIR + '/billing-account.json';

// ─── tiny helpers ────────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' && v.length ? v : undefined;
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Amounts are `number` on nearly every record — but at least one real invoice
 *  (IN253921, 2022-03-31) carries NO `amount` key at all, which turns a naive
 *  reduce() into NaN. Always coerce. */
function amt(rec) {
  const n = Number(rec && rec.amount);
  return Number.isFinite(n) ? n : 0;
}

function hasAmount(rec) {
  return Number.isFinite(Number(rec && rec.amount));
}

function usd(n, currency) {
  const cur = (currency || 'usd').toUpperCase();
  const sign = n < 0 ? '-' : '';
  const s = Math.abs(num(n, 0)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return sign + '$' + s + (cur === 'USD' ? '' : ' ' + cur);
}

function pad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function lpad(s, n) {
  s = String(s == null ? '' : s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/** Pad by VISIBLE width. c.cyan() and friends wrap the string in ANSI escapes,
 *  so padding the wrapped string right-shifts every column after it. Measure the
 *  plain text, emit the coloured form. */
function padc(plain, colored, n) {
  return String(colored == null ? plain : colored) + (plain.length >= n ? '' : ' '.repeat(n - plain.length));
}

function lpadc(plain, colored, n) {
  return (plain.length >= n ? '' : ' '.repeat(n - plain.length)) + String(colored == null ? plain : colored);
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function day(iso) {
  return String(iso || '').slice(0, 10);
}

function month(iso) {
  return String(iso || '').slice(0, 7);
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort(function (a, b) {
    return a - b;
  });
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function cadenceName(days) {
  for (const c2 of CADENCE) if (days <= c2.max) return c2.name;
  return 'multi-year';
}

// ─── flags ───────────────────────────────────────────────────────────────────

// `process.argv.parseFlags()` is greedy: `--json IN706358` parses as
// flags.json === 'IN706358' and swallows the positional. Every flag below is a
// pure boolean, so recover the argument instead of losing it silently.
const BOOL_FLAGS = ['json', 'help', 'h', 'no-pdf'];

function normalize(parsed) {
  for (const name of BOOL_FLAGS) {
    const v = parsed.flags[name];
    if (typeof v !== 'string') continue;
    if (v === 'true' || v === '1' || v === '') {
      parsed.flags[name] = true;
      continue;
    }
    if (v === 'false' || v === '0') {
      parsed.flags[name] = false;
      continue;
    }
    parsed.flags[name] = true;
    parsed.positional.push(v);
  }
  return parsed;
}

// ─── account + transport ─────────────────────────────────────────────────────

async function dashTab(explicit) {
  if (explicit) return explicit;
  let tab = null;
  try {
    tab = await browser.findTab({ domain: DASH });
  } catch {
    tab = null;
  }
  if (!tab) {
    cli.die(
      'no logged-in ' +
        DASH +
        ' tab found — billing has no API-token path.\n' +
        '  Open the dashboard and sign in, then retry:\n' +
        '    wrangler open          # opens/focuses ' +
        DASH +
        '\n' +
        '  Cloudflare exposes invoices only to a dashboard session: there is no\n' +
        '  CLOUDFLARE_API_TOKEN scope that reaches /billing/history.',
      { prefix: 'wrangler-ext' },
    );
  }
  return tab;
}

async function loadCachedAccount() {
  try {
    const j = JSON.parse(await fs.readFile(ACCOUNT_FILE, 'utf8'));
    return str(j.id) || null;
  } catch {
    return null;
  }
}

async function saveCachedAccount(id, name) {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(ACCOUNT_FILE, JSON.stringify({ id: id, name: name || null }, null, 2));
    if (typeof fs.chmod === 'function') await fs.chmod(ACCOUNT_FILE, 0o600).catch(function () {});
  } catch {
    /* cache is best-effort */
  }
}

async function resolveAccount(tab, explicit) {
  if (explicit) {
    if (!/^[0-9a-f]{32}$/i.test(explicit)) {
      cli.die('--account must be a 32-hex account id, got: ' + explicit, { prefix: 'wrangler-ext' });
    }
    return explicit;
  }
  // 1. The dashboard URL itself carries the account id on every account-scoped
  //    page (…/<32-hex>/billing/invoices). Cheapest and needs no extra call.
  const fromUrl = (String(tab.url || '').match(/[0-9a-f]{32}/) || [])[0];
  if (fromUrl) {
    await saveCachedAccount(fromUrl, null);
    return fromUrl;
  }
  const cached = await loadCachedAccount();
  if (cached) return cached;
  // 2. Otherwise ask the API. Several accounts is ambiguous, not a coin flip.
  const r = await get(tab, '/api/v4/accounts?per_page=50');
  const list = (r && r.result) || [];
  if (list.length === 1) {
    await saveCachedAccount(list[0].id, list[0].name);
    return list[0].id;
  }
  if (!list.length) {
    cli.die('the dashboard session sees no accounts — is it fully signed in?', { prefix: 'wrangler-ext' });
  }
  cli.die(
    'this session sees ' +
      list.length +
      ' accounts — pick one with --account <id>:\n' +
      list
        .map(function (a) {
          return '    ' + a.id + '  ' + (a.name || '');
        })
        .join('\n'),
    { prefix: 'wrangler-ext' },
  );
}

async function get(tab, path) {
  const r = await browser.fetch(tab, path, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const body = r && r.body;
  if (!r.ok || !body || body.success === false) {
    const errs = (body && body.errors) || [];
    const first = errs[0] || {};
    cli.die(
      'GET ' +
        path.replace(/[0-9a-f]{32}/, '<account>') +
        ' → HTTP ' +
        (r ? r.status : '?') +
        (first.code ? ' code ' + first.code : '') +
        (first.message ? ' ' + first.message : '') +
        '\n  See references/BILLING.md for the endpoints that do and do not exist.',
      { prefix: 'wrangler-ext' },
    );
  }
  return body;
}

/** Whole billing history, newest first. Paginated on result_info.next_page. */
async function fetchHistory(tab, acct) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const b = await get(tab, '/api/v4/accounts/' + acct + '/billing/history?page=' + page + '&per_page=' + PER_PAGE);
    const rows = b.result || [];
    out.push(...rows);
    const ri = b.result_info || {};
    if (!ri.next_page || !rows.length) break;
  }
  return out;
}

async function fetchPdf(tab, acct, uuid) {
  const path =
    '/api/v4/accounts/' + acct + '/billing/receipts/' + uuid + '/pdf?doctype=invoice&isLegacy=false';
  const r = await browser.fetch(tab, path, {
    method: 'GET',
    headers: { accept: 'application/pdf' },
    responseType: 'binary',
  });
  if (!r.ok || typeof r.body !== 'string') {
    cli.die(
      'invoice PDF download failed: HTTP ' +
        (r ? r.status : '?') +
        '\n  Expected the doctype/isLegacy query string:\n' +
        '    /billing/receipts/<uuid>/pdf?doctype=invoice&isLegacy=false\n' +
        '  and <uuid> must be the record `id`, not the human receipt_id (IN…).',
      { prefix: 'wrangler-ext' },
    );
  }
  const buf = Buffer.from(r.body, 'base64');
  const magic = buf.slice(0, 5).toString('latin1');
  if (magic !== '%PDF-') {
    cli.die(
      'response was not a PDF (first bytes: ' +
        JSON.stringify(magic) +
        ', ' +
        buf.length +
        ' bytes).\n' +
        '  A JSON error body here usually means the session lost its billing scope.',
      { prefix: 'wrangler-ext' },
    );
  }
  return buf;
}

// ─── record classification ───────────────────────────────────────────────────

/** billing/history mixes debits and credits in one list. `type` is "invoice" or
 *  "credit"; credit amounts are NEGATIVE. Summing the raw list understates
 *  invoiced spend and overstates nothing useful — always split first. */
function split(records) {
  const invoices = [];
  const credits = [];
  const other = [];
  for (const r of records) {
    if (r.type === 'invoice') invoices.push(r);
    else if (r.type === 'credit') credits.push(r);
    else other.push(r);
  }
  invoices.sort(function (a, b) {
    return String(b.occurred_at).localeCompare(String(a.occurred_at));
  });
  credits.sort(function (a, b) {
    return String(b.occurred_at).localeCompare(String(a.occurred_at));
  });
  return { invoices, credits, other };
}

/** "Unsettled" is NOT status alone. On the measured enterprise account every
 *  single record has amount_remaining === 0 and ready_to_pay === false, while 42
 *  invoices from 2023-2026 still sit at status OPEN. status OPEN + amount_to_pay
 *  > 0 means "not yet marked settled in Cloudflare's NetSuite feed" — it does
 *  NOT prove money is owed. Report both signals and never claim a total owed. */
function unsettled(rec) {
  return rec.status === 'OPEN' || num(rec.amount_to_pay, 0) > 0;
}

function trulyOwed(rec) {
  return num(rec.amount_remaining, 0) > 0;
}

// ─── PDF text extraction ─────────────────────────────────────────────────────

const INVOICE_ANCHORS = ['Cloudflare', 'Invoice', 'Subtotal'];

/** Does this look like real invoice prose, or like the tofu/garbage a failed
 *  CID-font extraction produces? Cloudflare invoice PDFs embed Type0 /
 *  CIDFontType2 fonts with /Encoding /Identity-H, so several plausible
 *  extraction routes return font-program noise instead of text. Returning that
 *  noise as "line items" would be worse than failing. */
function looksLikeInvoice(text) {
  if (!text || text.length < 120) return false;
  const hits = INVOICE_ANCHORS.filter(function (a) {
    return text.includes(a);
  });
  if (hits.length < 2) return false;
  let printable = 0;
  for (const ch of text) {
    const cc = ch.codePointAt(0);
    if (cc === 9 || cc === 10 || cc === 13 || (cc >= 32 && cc < 127) || (cc >= 160 && cc !== 0xfffd)) printable++;
  }
  return printable / text.length > 0.9;
}

async function tryLocal(pdfPath) {
  const attempts = [];
  // poppler, if a future SLICC image ever ships it. -layout keeps columns.
  const pt = await exec.spawn(['pdftotext', '-layout', pdfPath, '-']);
  if (pt.exitCode === 0 && looksLikeInvoice(pt.stdout)) {
    return { text: pt.stdout, method: 'pdftotext -layout (local poppler)', attempts };
  }
  attempts.push('pdftotext -layout → ' + (pt.exitCode === 0 ? 'unusable output' : 'not available (exit ' + pt.exitCode + ')'));

  // SLICC's pdftk: `dump_data_utf8` extracts per-page text and DOES resolve the
  // Identity-H CID mapping via the embedded /ToUnicode CMap. This is the
  // primary local path. It does NOT preserve column layout — the table's label
  // block and value block come out as two separate runs — so parse by matching
  // value shapes, never by zipping labels to values positionally.
  const dd = await exec.spawn(['pdftk', pdfPath, 'dump_data_utf8']);
  if (dd.exitCode === 0 && looksLikeInvoice(dd.stdout)) {
    return { text: dd.stdout, method: 'pdftk dump_data_utf8 (local)', attempts };
  }
  attempts.push('pdftk dump_data_utf8 → ' + (dd.exitCode === 0 ? 'unusable output (' + (dd.stdout || '').length + ' chars)' : 'failed (exit ' + dd.exitCode + ')'));
  return { text: null, method: null, attempts };
}

function execTargets(listOutput) {
  return [...String(listOutput || '').matchAll(/follower-[0-9a-f-]{36}/g)].map(function (m) {
    return m[0];
  });
}

/** Offload extraction to a connected `ssh` exec follower running Homebrew
 *  poppler. Only used when the local routes come back unusable. */
async function tryFollower(buf) {
  const ls = await exec.spawn(['ssh', '--list']);
  const targets = ls.exitCode === 0 ? execTargets(ls.stdout) : [];
  if (!targets.length) return { text: null, note: 'no `ssh` exec follower is connected' };
  const id = targets[0];

  const probe = await exec.spawn(['ssh', id, 'command -v pdftotext || true']);
  if (!/pdftotext/.test(probe.stdout || '')) {
    return {
      text: null,
      note: 'follower ' + id + ' has no pdftotext — run `brew install poppler` on it',
    };
  }

  // A single ssh call with a ~129 KB argument fails, and `split` is not
  // available, so stream the base64 across in ~25 KB appends. The base64
  // alphabet (A-Za-z0-9+/=) is safe inside single quotes.
  const dir = '/tmp/wrangler-ext-' + Math.random().toString(36).slice(2, 10);
  const b64 = buf.toString('base64');
  const CHUNK = 25000;
  let rc = await exec.spawn(['ssh', id, 'mkdir -p ' + dir]);
  if (rc.exitCode !== 0) return { text: null, note: 'could not create ' + dir + ' on ' + id };
  for (let i = 0; i < b64.length; i += CHUNK) {
    const op = i === 0 ? '>' : '>>';
    rc = await exec.spawn([
      'ssh',
      id,
      "printf '%s' '" + b64.slice(i, i + CHUNK) + "' " + op + ' ' + dir + '/f.b64',
    ]);
    if (rc.exitCode !== 0) return { text: null, note: 'chunk upload failed at offset ' + i };
  }
  // macOS base64 takes -d (and -D); openssl is the universal fallback.
  const run = await exec.spawn([
    'ssh',
    id,
    'cd ' +
      dir +
      ' && { base64 -d f.b64 > f.pdf 2>/dev/null || base64 -D f.b64 > f.pdf 2>/dev/null || ' +
      'openssl base64 -d -A -in f.b64 -out f.pdf; } && wc -c < f.pdf && pdftotext -layout f.pdf -',
  ]);
  await exec.spawn(['ssh', id, 'rm -rf ' + dir]);
  if (run.exitCode !== 0) {
    return { text: null, note: 'remote extraction failed on ' + id + ': ' + trunc((run.stderr || '').trim(), 200) };
  }
  const nl = run.stdout.indexOf('\n');
  const bytes = num(run.stdout.slice(0, nl).trim(), -1);
  const text = run.stdout.slice(nl + 1);
  if (bytes !== buf.length) {
    return { text: null, note: 'transfer truncated: sent ' + buf.length + ' bytes, follower reassembled ' + bytes };
  }
  if (!looksLikeInvoice(text)) return { text: null, note: 'remote pdftotext produced unusable text' };
  return { text: text, method: 'pdftotext -layout on ' + id + ' (poppler over ssh)', note: null };
}

/** pdftk needs a real path, so the PDF has to land on disk somewhere writable.
 *  `/tmp` is not guaranteed to exist inside every SLICC sandbox — try the
 *  obvious homes in order and give up on the local route rather than crashing. */
async function scratchWrite(buf) {
  const name = 'wrangler-ext-' + Math.random().toString(36).slice(2, 10) + '.pdf';
  const dirs = [str(process.env.TMPDIR), '/tmp', HOME + '/.cache', '.'];
  for (const d of dirs) {
    if (!d) continue;
    const p = d.replace(/\/$/, '') + '/' + name;
    try {
      await fs.mkdir(d, { recursive: true }).catch(function () {});
      await fs.writeFileBinary(p, buf);
      return p;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Extract text or fail loudly. NEVER returns garbled text as if it were data. */
async function extractText(buf, label) {
  let local = { text: null, method: null, attempts: [] };
  const scratch = await scratchWrite(buf);
  if (!scratch) {
    local.attempts.push('no writable scratch dir for the local extractors');
  } else {
    try {
      local = await tryLocal(scratch);
    } finally {
      await fs.rm(scratch).catch(function () {});
    }
  }
  if (local.text) return { text: local.text, method: local.method };

  const remote = await tryFollower(buf);
  if (remote.text) return { text: remote.text, method: remote.method };

  cli.die(
    'could not extract text from the ' +
      (label || 'invoice') +
      ' PDF.\n' +
      '  Cloudflare invoices are generated by pdf-lib with Type0/CIDFontType2\n' +
      '  fonts and /Encoding /Identity-H, so most extractors return glyph ids.\n' +
      '  Tried locally:\n' +
      local.attempts
        .map(function (a) {
          return '    - ' + a;
        })
        .join('\n') +
      '\n  Offload route: ' +
      (remote.note || 'unavailable') +
      '\n\n  Fix one of these:\n' +
      '    * connect a `slicc … follow` exec follower with poppler installed\n' +
      '      (`brew install poppler`; verified with poppler 26.08.0), then retry — see\n' +
      '      `ssh --list` / `host`; or\n' +
      "    * save the PDF with `wrangler-ext billing pdf " +
      (label || '<id>') +
      ' --out ./inv.pdf`\n' +
      '      and read it by hand.\n' +
      '  Refusing to print glyph noise as line items. See references/pdf-extraction.md.',
    { prefix: 'wrangler-ext' },
  );
}

// ─── invoice text parsing ────────────────────────────────────────────────────

/** Flatten wrapped lines into one run of text. Cloudflare's PDF wraps inside
 *  numbers too ("$240,300.0" / "0" on the next line), so stitch a currency
 *  amount that got split across the break back together. */
function flatten(text) {
  let s = String(text || '')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
  // "$240,300.0 0" → "$240,300.00"; runs twice for a two-digit split.
  for (let i = 0; i < 2; i++) s = s.replace(/(\$[\d,]+\.\d)\s(\d)(?![\d.])/g, '$1$2');
  return s;
}

const ORDER_TYPES = [
  { re: /Upsell\s*[-–—]?\s*Insertion\s*Order/i, name: 'Upsell – Insertion Order' },
  { re: /\bNew\s+Business\b/i, name: 'New Business' },
  { re: /\bRenew(al)?\b/i, name: 'Renew' },
  { re: /\bAmend(ment)?\b/i, name: 'Amendment' },
  { re: /\bVariable\b/i, name: 'Variable' },
];

/** Parse one Cloudflare invoice's extracted text.
 *
 *  The header is emitted as a block of LABELS followed by a block of VALUES,
 *  and an empty "PO #" simply drops its value — so zipping labels to values by
 *  index silently shifts every field. Everything below is matched on the shape
 *  of the value instead. */
function parseInvoice(text) {
  const flat = flatten(text);
  const out = {
    receipt_id: (flat.match(/\b(IN[-\d]*\d{4,})\b/) || [])[1] || null,
    contract: (flat.match(/\b(IC-\d{4,})\b/) || [])[1] || null,
    order_type: null,
    terms: (flat.match(/\bNet\s+(\d+)\b/) || [])[0] || null,
    po: (flat.match(/\bPO-\d{4,}\b/) || [])[0] || null,
    currency: (flat.match(/\b(USD|EUR|GBP|JPY|AUD|CAD|SGD)\b/) || [])[1] || null,
    excess_usage: /Excess\s+Usage\s+Billing/i.test(flat),
    service_date: (flat.match(/Service Date:\s*([\d/]+)/) || [])[1] || null,
    period_start: null,
    period_end: null,
    total: null,
    amount_due: null,
    usage: [],
    descriptions: [],
  };
  for (const t of ORDER_TYPES) {
    if (t.re.test(flat)) {
      out.order_type = t.name;
      break;
    }
  }
  // Dates appear as "Aug 20, 2026". The first is the invoice date, then the
  // dunning due date, then service-period start and end.
  const dates = [...flat.matchAll(/\b([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})\b/g)].map(function (m) {
    return m[0];
  });
  if (dates.length >= 4) {
    out.period_start = dates[dates.length - 2];
    out.period_end = dates[dates.length - 1];
  }
  out.invoice_date = dates[0] || null;

  // Subtotal / Tax Total / Total / Amount Due labels, then their values.
  const tail = flat.slice(flat.search(/Subtotal/i));
  const money = [...tail.matchAll(/\$-?[\d,]+\.\d{2}/g)].map(function (m) {
    return Number(m[0].replace(/[$,]/g, ''));
  });
  if (money.length >= 3) {
    out.total = money[2];
    out.amount_due = money.length >= 4 ? money[3] : null;
  }

  // Overage detail on an "Excess Usage Billing" invoice. Real measured shape:
  //   Total Workers Core per MM Requests in MM Cap: 83334 MM Rate: 0.04 /MM
  //   Usage: 206061.224 MM - $4909.09
  const usageRe =
    /Total\s+(.+?)\s+Cap:\s*([\d,.]+)\s*(.*?)\s*Rate:\s*([\d.]+)\s*\/?\s*(.*?)\s*Usage:\s*([\d,.]+)\s*(.*?)\s*-\s*\$([\d,]+\.?\d*)/g;
  for (const m of flat.matchAll(usageRe)) {
    const metric = m[1].replace(/\s+in\s+.*$/, '').trim();
    const cap = num(m[2].replace(/,/g, ''), null);
    const rate = num(m[4], null);
    const used = num(m[6].replace(/,/g, ''), null);
    const cost = num(m[8].replace(/,/g, ''), null);
    out.usage.push({
      metric: metric,
      unit: (m[7] || m[3] || '').trim() || null,
      cap: cap,
      rate: rate,
      usage: used,
      cost: cost,
      over_cap: cap != null && used != null ? used - cap : null,
      cap_pct: cap ? (used / cap) * 100 : null,
    });
  }

  for (const m of flat.matchAll(/Cloudflare Enterprise Services?/g)) out.descriptions.push(m[0]);
  return out;
}

// ─── contract families ───────────────────────────────────────────────────────

/** Phase A: cluster invoices by exact amount. A recurring contract charge bills
 *  the identical figure every period, so an amount seen 2+ times is a family.
 *  Phase B (in cmdContracts) re-keys each family by the contract number read off
 *  its PDF and merges families that share one. */
function groupFamilies(invoices) {
  const buckets = new Map();
  for (const inv of invoices) {
    const key = amt(inv).toFixed(2);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(inv);
  }
  const families = [];
  const singles = [];
  for (const [key, members] of buckets) {
    members.sort(function (a, b) {
      return String(a.occurred_at).localeCompare(String(b.occurred_at));
    });
    if (members.length < 2) {
      singles.push(members[0]);
      continue;
    }
    const gaps = [];
    for (let i = 1; i < members.length; i++) {
      gaps.push(
        (Date.parse(members[i].occurred_at) - Date.parse(members[i - 1].occurred_at)) / 86400000,
      );
    }
    const med = median(gaps);
    families.push({
      key: 'amount:' + key,
      contract: null,
      order_type: null,
      amount: Number(key),
      fixed_amount: true,
      cadence: cadenceName(med),
      median_gap_days: Math.round(med),
      members: members,
      total: members.reduce(function (s, m) {
        return s + amt(m);
      }, 0),
    });
  }
  families.sort(function (a, b) {
    return b.total - a.total;
  });
  return { families, singles };
}

/** Fold a set of invoices with no recurring amount into one variable family. */
function variableFamily(members, label) {
  members.sort(function (a, b) {
    return String(a.occurred_at).localeCompare(String(b.occurred_at));
  });
  const gaps = [];
  for (let i = 1; i < members.length; i++) {
    gaps.push((Date.parse(members[i].occurred_at) - Date.parse(members[i - 1].occurred_at)) / 86400000);
  }
  return {
    key: label,
    contract: null,
    // 'contract-unknown' means we never got the PDF text; the other two mean we
    // DID read it and it genuinely carries no contract number.
    read: label !== 'contract-unknown',
    excess_usage: label === 'excess-usage',
    order_type: label === 'excess-usage' ? 'Variable' : null,
    amount: null,
    fixed_amount: false,
    cadence: members.length > 1 ? cadenceName(median(gaps)) : 'one-off',
    median_gap_days: members.length > 1 ? Math.round(median(gaps)) : null,
    members: members,
    total: members.reduce(function (s, m) {
      return s + amt(m);
    }, 0),
  };
}

/** One recurring charge shape inside a contract: "$240,300.00 monthly ×8". */
function componentOf(f) {
  return {
    amount: f.fixed_amount ? f.amount : null,
    count: f.members.length,
    cadence: f.cadence,
    first: day(f.members[0].occurred_at),
    last: day(f.members[f.members.length - 1].occurred_at),
    total: f.total,
  };
}

/** Fold amount-clustered families that share a contract number into one family.
 *  A single contract legitimately bills several DIFFERENT recurring amounts
 *  (a base charge plus add-ons plus true-ups), so the merged family keeps its
 *  components — collapsing them to "variable" would hide the $240,300 × 8
 *  structure that makes the attribution argument. */
function mergeByContract(families) {
  const byContract = new Map();
  const out = [];
  for (const f of families) {
    if (!f.components) f.components = [componentOf(f)];
    if (!f.contract) {
      out.push(f);
      continue;
    }
    const prev = byContract.get(f.contract);
    if (!prev) {
      byContract.set(f.contract, f);
      out.push(f);
      continue;
    }
    prev.members = prev.members.concat(f.members).sort(function (a, b) {
      return String(a.occurred_at).localeCompare(String(b.occurred_at));
    });
    prev.components = prev.components.concat(f.components).sort(function (a, b) {
      return b.total - a.total;
    });
    prev.total += f.total;
    if (prev.amount !== f.amount) {
      prev.fixed_amount = false;
      prev.amount = null;
    }
    prev.order_type = prev.order_type || f.order_type;
    prev.read = prev.read || f.read;
    prev.excess_usage = prev.excess_usage || f.excess_usage;
  }
  out.sort(function (a, b) {
    return b.total - a.total;
  });
  return out;
}

// ─── fixtures ────────────────────────────────────────────────────────────────

/** `--fixture <file>` replaces the live API with a saved billing/history dump:
 *  a JSON array of records (the exact shape billing/history returns). A record
 *  may carry an extra `pdf_text` string, which stands in for the extracted PDF
 *  so `contracts` / `lineitems` / `usage` work fully offline. This is how the
 *  grouping logic is regression-tested without a dashboard session. */
async function loadFixture(path) {
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    cli.die('cannot read fixture ' + path, { prefix: 'wrangler-ext' });
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    cli.die('fixture ' + path + ' is not valid JSON: ' + e.message, { prefix: 'wrangler-ext' });
  }
  const arr = Array.isArray(j) ? j : j && Array.isArray(j.result) ? j.result : null;
  if (!arr) cli.die('fixture must be a JSON array of billing/history records (or {result:[…]})', { prefix: 'wrangler-ext' });
  return arr;
}

/** Records for a command: fixture if asked for, otherwise the live account. */
async function records(flags) {
  const fixture = str(flags.fixture);
  if (fixture) return { rows: await loadFixture(fixture), tab: null, acct: null, offline: true };
  const tab = await dashTab(str(flags.tab));
  const acct = await resolveAccount(tab, str(flags.account));
  return { rows: await fetchHistory(tab, acct), tab: tab, acct: acct, offline: false };
}

function resolveReceipt(rows, key) {
  if (!key) {
    cli.die('need an invoice: a receipt_id like IN706358 or the 36-char record uuid', { prefix: 'wrangler-ext' });
  }
  const hit =
    rows.find(function (r) {
      return r.receipt_id === key;
    }) ||
    rows.find(function (r) {
      return r.id === key || r.invoice_id === key;
    }) ||
    rows.find(function (r) {
      return String(r.receipt_id || '').toLowerCase() === key.toLowerCase();
    });
  if (!hit) {
    const recent = rows.slice(0, 5).map(function (r) {
      return r.receipt_id;
    });
    cli.die(
      'no invoice ' + key + ' on this account.\n  Recent receipt ids: ' + recent.join(', ') +
        '\n  (list them all with `wrangler-ext billing invoices`)',
      { prefix: 'wrangler-ext' },
    );
  }
  return hit;
}

/** PDF text for one record — from the fixture's pdf_text or the live API. */
async function invoiceText(rec, ctx) {
  if (typeof rec.pdf_text === 'string' && rec.pdf_text.length) {
    return { text: rec.pdf_text, method: 'fixture pdf_text' };
  }
  if (ctx.offline) {
    return { text: null, method: null, note: 'fixture record has no pdf_text' };
  }
  const buf = await fetchPdf(ctx.tab, ctx.acct, rec.id);
  return await extractText(buf, rec.receipt_id);
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdInvoices(flags) {
  const ctx = await records(flags);
  const { invoices, credits, other } = split(ctx.rows);
  const year = str(flags.year);
  const limit = num(flags.limit, 25);
  let inv = invoices;
  let cr = credits;
  if (year) {
    inv = inv.filter(function (r) {
      return String(r.occurred_at).startsWith(year);
    });
    cr = cr.filter(function (r) {
      return String(r.occurred_at).startsWith(year);
    });
  }
  const shown = inv.slice(0, Math.max(0, limit));

  if (flags.json) {
    cli.out({
      account: ctx.acct,
      total_records: ctx.rows.length,
      counts: { invoices: invoices.length, credits: credits.length, other: other.length },
      invoices: shown.map(function (r) {
        return {
          receipt_id: r.receipt_id,
          uuid: r.id,
          occurred_at: r.occurred_at,
          amount: hasAmount(r) ? amt(r) : null,
          currency: r.currency,
          status: r.status,
          amount_to_pay: r.amount_to_pay,
          amount_remaining: r.amount_remaining,
          ready_to_pay: r.ready_to_pay,
          source: r.source,
          unsettled: unsettled(r),
        };
      }),
      credits: cr.map(function (r) {
        return { receipt_id: r.receipt_id, uuid: r.id, occurred_at: r.occurred_at, amount: amt(r), status: r.status };
      }),
    });
    return;
  }

  console.log('');
  console.log(
    '  ' +
      c.bold('invoices') +
      '  ' +
      c.dim(
        ctx.rows.length +
          ' records · ' +
          invoices.length +
          ' invoices · ' +
          credits.length +
          ' credits' +
          (year ? ' · filtered to ' + year : ''),
      ),
  );
  console.log('');
  console.log(
    '    ' +
      pad('date', 12) +
      pad('receipt', 14) +
      lpad('amount', 14) +
      '  ' +
      pad('status', 10) +
      pad('src', 10) +
      'uuid (for `billing pdf`)',
  );
  for (const r of shown) {
    const a = hasAmount(r) ? usd(amt(r), r.currency) : c.yellow('(no amount)');
    console.log(
      '    ' +
        pad(day(r.occurred_at), 12) +
        pad(r.receipt_id || '-', 14) +
        lpad(a, 14) +
        '  ' +
        padc(r.status || '-', unsettled(r) ? c.yellow(r.status) : c.green(r.status), 10) +
        pad(r.source || '-', 10) +
        c.dim(r.id || '-'),
    );
  }
  if (inv.length > shown.length) {
    console.log(c.dim('    … ' + (inv.length - shown.length) + ' more (--limit ' + inv.length + ' for all)'));
  }
  if (cr.length) {
    console.log('');
    console.log('  ' + c.bold('credits') + '  ' + c.dim('negative amounts — never sum these with invoices'));
    for (const r of cr.slice(0, 10)) {
      console.log(
        '    ' + pad(day(r.occurred_at), 12) + pad(r.receipt_id || '-', 14) + lpad(usd(amt(r), r.currency), 14) + '  ' + c.dim(r.status || ''),
      );
    }
  }
  console.log('');
}

async function cmdSummary(flags) {
  const ctx = await records(flags);
  const { invoices, credits } = split(ctx.rows);
  const year = str(flags.year) || String(new Date().getUTCFullYear());

  const byMonth = {};
  const byYear = {};
  for (const r of invoices) {
    const m = month(r.occurred_at);
    const y = m.slice(0, 4);
    byMonth[m] = byMonth[m] || { invoices: 0, total: 0 };
    byMonth[m].invoices++;
    byMonth[m].total += amt(r);
    byYear[y] = byYear[y] || { invoices: 0, total: 0, credits: 0, credit_total: 0 };
    byYear[y].invoices++;
    byYear[y].total += amt(r);
  }
  for (const r of credits) {
    const y = month(r.occurred_at).slice(0, 4);
    byYear[y] = byYear[y] || { invoices: 0, total: 0, credits: 0, credit_total: 0 };
    byYear[y].credits++;
    byYear[y].credit_total += amt(r);
  }
  const open = invoices.filter(unsettled);
  const owed = invoices.filter(trulyOwed);
  const missing = invoices.filter(function (r) {
    return !hasAmount(r);
  });

  if (flags.json) {
    cli.out({
      account: ctx.acct,
      months: Object.entries(byMonth)
        .sort()
        .map(function (e) {
          return { month: e[0], invoices: e[1].invoices, total: e[1].total };
        }),
      years: byYear,
      not_paid: open.map(function (r) {
        return {
          receipt_id: r.receipt_id,
          occurred_at: r.occurred_at,
          amount: hasAmount(r) ? amt(r) : null,
          status: r.status,
          amount_to_pay: r.amount_to_pay,
          amount_remaining: r.amount_remaining,
        };
      }),
      with_balance_remaining: owed.length,
      records_missing_amount: missing.map(function (r) {
        return r.receipt_id;
      }),
    });
    return;
  }

  const months = Object.keys(byMonth)
    .filter(function (m) {
      return m.startsWith(year);
    })
    .sort();
  console.log('');
  console.log('  ' + c.bold(year) + '  ' + c.dim('per month (invoices only — credits listed under annual totals)'));
  console.log('');
  if (!months.length) console.log(c.dim('    no invoices in ' + year));
  for (const m of months) {
    console.log('    ' + m + '  ' + lpad(usd(byMonth[m].total), 15) + c.dim('   ' + byMonth[m].invoices + ' invoice(s)'));
  }
  console.log('');
  console.log('  ' + c.bold('annual totals'));
  for (const [y, v] of Object.entries(byYear).sort()) {
    console.log(
      '    ' +
        y +
        '  ' +
        lpad(usd(v.total), 15) +
        c.dim('  ' + v.invoices + ' invoice(s)') +
        (v.credits ? c.dim('   credits ' + usd(v.credit_total) + ' (' + v.credits + ')') : ''),
    );
  }
  console.log('');
  if (missing.length) {
    console.log(c.yellow('  ⚠ ' + missing.length + ' record(s) carry NO amount field: ' + missing.map(function (r) { return r.receipt_id; }).join(', ')));
    console.log(c.dim('    they are counted as $0.00 above, not as NaN.'));
    console.log('');
  }
  if (!open.length) {
    console.log(c.green('  ✓ every invoice is closed and settled'));
  } else {
    console.log(
      '  ' +
        c.yellow(c.bold('⚠ ' + open.length + ' invoice(s) NOT marked paid')) +
        '  ' +
        c.dim('status OPEN and/or amount_to_pay > 0 — ' + usd(open.reduce(function (s, r) { return s + amt(r); }, 0))),
    );
    // Always print WHY a row is here — status alone is not the signal.
    for (const r of open.slice(0, 20)) {
      const why = [];
      if (r.status === 'OPEN') why.push('status OPEN');
      if (num(r.amount_to_pay, 0) > 0) why.push('to_pay ' + usd(num(r.amount_to_pay, 0)));
      if (trulyOwed(r)) why.push(c.red('remaining ' + usd(num(r.amount_remaining, 0))));
      console.log(
        '    ' +
          pad(day(r.occurred_at), 12) +
          pad(r.receipt_id || '-', 14) +
          lpad(usd(amt(r), r.currency), 14) +
          '  ' +
          padc(r.status || '-', c.yellow(r.status), 10) +
          c.dim(why.join(', ')),
      );
    }
    if (open.length > 20) console.log(c.dim('    … ' + (open.length - 20) + ' more'));
    console.log('');
    console.log(
      c.dim(
        '    ' +
          owed.length +
          ' of these have amount_remaining > 0. On the enterprise account measured,\n' +
          '    EVERY record reported amount_remaining 0 and ready_to_pay false while 42\n' +
          "    invoices from 2023-2026 sat at status OPEN — Cloudflare's NetSuite feed\n" +
          '    leaves enterprise invoices OPEN long after settlement. Read OPEN as "not\n' +
          '    marked settled", not as money owed, and never publish the OPEN sum as a\n' +
          '    balance due.',
      ),
    );
  }
  console.log('');
}

async function cmdPdf(positional, flags) {
  const ctx = await records(flags);
  if (ctx.offline) cli.die('billing pdf needs a live dashboard session (a fixture has no PDFs)', { prefix: 'wrangler-ext' });
  const rec = resolveReceipt(ctx.rows, str(positional[0]));
  const buf = await fetchPdf(ctx.tab, ctx.acct, rec.id);
  const out = str(flags.out) || './' + (rec.receipt_id || rec.id) + '.pdf';
  await fs.writeFileBinary(out, buf);
  if (flags.json) {
    cli.out({ receipt_id: rec.receipt_id, uuid: rec.id, path: out, bytes: buf.length, magic: buf.slice(0, 8).toString('latin1') });
    return;
  }
  console.log(
    c.green('✓') +
      ' ' +
      (rec.receipt_id || rec.id) +
      ' → ' +
      out +
      '  ' +
      c.dim(buf.length + ' bytes, magic ' + JSON.stringify(buf.slice(0, 8).toString('latin1'))),
  );
}

async function cmdLineitems(positional, flags) {
  const ctx = await records(flags);
  const rec = resolveReceipt(ctx.rows, str(positional[0]));
  const got = await invoiceText(rec, ctx);
  if (!got.text) cli.die('no invoice text available: ' + (got.note || 'unknown'), { prefix: 'wrangler-ext' });
  const p = parseInvoice(got.text);

  if (flags.json) {
    cli.out({ receipt_id: rec.receipt_id, uuid: rec.id, api_amount: hasAmount(rec) ? amt(rec) : null, extraction: got.method, parsed: p });
    return;
  }
  console.log('');
  console.log('  ' + c.bold(rec.receipt_id || rec.id) + '  ' + c.dim(day(rec.occurred_at) + ' · ' + got.method));
  console.log('');
  console.log('    ' + pad('contract #', 20) + (p.contract ? c.cyan(p.contract) : c.yellow('(none — usage/variable invoice)')));
  console.log('    ' + pad('order type', 20) + (p.order_type || '-'));
  console.log('    ' + pad('service period', 20) + (p.period_start || '?') + ' → ' + (p.period_end || '?'));
  console.log('    ' + pad('terms', 20) + (p.terms || '-') + (p.po ? c.dim('   PO ' + p.po) : ''));
  console.log('    ' + pad('total (PDF)', 20) + (p.total != null ? usd(p.total) : '-'));
  console.log('    ' + pad('amount due (PDF)', 20) + (p.amount_due != null ? usd(p.amount_due) : '-'));
  console.log('    ' + pad('amount (API)', 20) + (hasAmount(rec) ? usd(amt(rec), rec.currency) : c.yellow('(absent)')));
  if (p.total != null && hasAmount(rec) && Math.abs(p.total - amt(rec)) > 0.005) {
    console.log('    ' + c.yellow('⚠ PDF total and API amount disagree — trust the API amount; the PDF wraps digits mid-number.'));
  }
  if (p.usage.length) {
    console.log('');
    console.log('  ' + c.bold('excess usage detail'));
    console.log('    ' + pad('metric', 42) + lpad('cap', 14) + lpad('usage', 18) + lpad('rate', 10) + lpad('cost', 12) + lpad('% of cap', 10));
    for (const u of p.usage) {
      console.log(
        '    ' +
          pad(trunc(u.metric, 40), 42) +
          lpad(u.cap != null ? u.cap.toLocaleString('en-US') : '-', 14) +
          lpad(u.usage != null ? u.usage.toLocaleString('en-US') : '-', 18) +
          lpad(u.rate != null ? String(u.rate) : '-', 10) +
          lpad(u.cost != null ? usd(u.cost) : '-', 12) +
          lpad(u.cap_pct != null ? u.cap_pct.toFixed(0) + '%' : '-', 10),
      );
    }
  } else if (p.excess_usage) {
    console.log('');
    console.log(c.yellow('  ⚠ invoice says "Excess Usage Billing" but no metric lines parsed — the'));
    console.log(c.yellow('    wording may have changed. Inspect with `billing pdf ' + (rec.receipt_id || '') + ' --out ./inv.pdf`.'));
  }
  console.log('');
}

async function cmdUsage(positional, flags) {
  const ctx = await records(flags);
  const rec = resolveReceipt(ctx.rows, str(positional[0]));
  const got = await invoiceText(rec, ctx);
  if (!got.text) cli.die('no invoice text available: ' + (got.note || 'unknown'), { prefix: 'wrangler-ext' });
  const p = parseInvoice(got.text);
  if (!p.excess_usage && !p.usage.length) {
    cli.die(
      (rec.receipt_id || rec.id) +
        ' is not an Excess Usage Billing invoice' +
        (p.contract ? ' — it is contract ' + p.contract + ' (' + (p.order_type || 'unknown type') + ').' : '.') +
        '\n  `billing contracts` shows which invoices carry usage overage.',
      { prefix: 'wrangler-ext' },
    );
  }
  if (flags.json) {
    cli.out({ receipt_id: rec.receipt_id, uuid: rec.id, extraction: got.method, period: { start: p.period_start, end: p.period_end }, total: hasAmount(rec) ? amt(rec) : p.total, metrics: p.usage });
    return;
  }
  console.log('');
  console.log(
    '  ' + c.bold('excess usage · ' + (rec.receipt_id || rec.id)) + '  ' + c.dim((p.period_start || '?') + ' → ' + (p.period_end || '?')),
  );
  console.log('');
  for (const u of p.usage) {
    console.log('    ' + c.bold(u.metric) + (u.unit ? c.dim('  [' + u.unit + ']') : ''));
    console.log(
      '      cap ' +
        (u.cap != null ? u.cap.toLocaleString('en-US') : '?') +
        '   usage ' +
        (u.usage != null ? u.usage.toLocaleString('en-US') : '?') +
        (u.over_cap != null ? c.yellow('   over by ' + Math.round(u.over_cap).toLocaleString('en-US')) : '') +
        (u.cap_pct != null ? c.dim('   (' + u.cap_pct.toFixed(0) + '% of cap)') : ''),
    );
    console.log('      rate ' + (u.rate != null ? u.rate : '?') + ' per unit   →   ' + c.bold(u.cost != null ? usd(u.cost) : '?'));
  }
  const sum = p.usage.reduce(function (s, u) {
    return s + (u.cost || 0);
  }, 0);
  console.log('');
  console.log('    ' + pad('sum of metric costs', 26) + lpad(usd(sum), 14));
  console.log('    ' + pad('invoice amount (API)', 26) + lpad(hasAmount(rec) ? usd(amt(rec), rec.currency) : '-', 14));
  if (hasAmount(rec) && Math.abs(sum - amt(rec)) > 0.02) {
    console.log('    ' + c.yellow('⚠ they differ by ' + usd(amt(rec) - sum) + ' — a metric line probably failed to parse.'));
  }
  console.log('');
  console.log(
    c.dim(
      '    Cap vs usage is the actionable number: these invoices bill only the\n' +
        '    overage above a contracted cap, so a metric far above its cap is where\n' +
        '    the next contract negotiation (or a Workers optimisation) pays off.',
    ),
  );
  console.log('');
}

async function cmdSubscriptions(flags) {
  const tab = await dashTab(str(flags.tab));
  const acct = await resolveAccount(tab, str(flags.account));
  const b = await get(tab, '/api/v4/accounts/' + acct + '/subscriptions');
  const subs = b.result || [];
  if (flags.json) {
    cli.out(subs);
    return;
  }
  const enterprise = subs.filter(function (s) {
    return num(s.price, 0) === 0;
  });
  console.log('');
  console.log('  ' + c.bold('subscriptions') + '  ' + c.dim(subs.length + ' entries'));
  console.log('');
  console.log('    ' + pad('product', 34) + pad('state', 12) + lpad('price', 12) + '  ' + 'intent / frequency');
  for (const s of subs) {
    const name = (s.rate_plan && (s.rate_plan.public_name || s.rate_plan.id)) || s.product || s.id || '-';
    console.log(
      '    ' +
        pad(trunc(name, 32), 34) +
        pad(s.state || '-', 12) +
        lpad(usd(num(s.price, 0), s.currency), 12) +
        '  ' +
        c.dim((s.intent || '-') + (s.frequency ? ' · ' + s.frequency : '')),
    );
  }
  console.log('');
  if (enterprise.length === subs.length && subs.length) {
    console.log(
      c.yellow('  ⚠ every subscription reports price 0.') +
        c.dim(
          '\n    On an enterprise account the API returns price: 0 with\n' +
            '    intent: "ENTERPRISE_CONTRACT" for every entry — the negotiated rate lives in\n' +
            '    the contract, not the API. There is NO per-product cost here. Invoice PDFs\n' +
            '    (`billing lineitems`, `billing contracts`) are the only route to real money.',
        ),
    );
    console.log('');
  }
  console.log(c.dim('    Note: /billing/profile also responds 200 but carries payment method only —') );
  console.log(c.dim('    no cost data at all. See references/BILLING.md.'));
  console.log('');
}

async function cmdContracts(flags) {
  const ctx = await records(flags);
  const { invoices, credits } = split(ctx.rows);
  const year = str(flags.year);
  const scoped = year
    ? invoices.filter(function (r) {
        return String(r.occurred_at).startsWith(year);
      })
    : invoices;
  if (!scoped.length) cli.die('no invoices' + (year ? ' in ' + year : '') + ' to group', { prefix: 'wrangler-ext' });

  const grouped = groupFamilies(scoped);
  let families = grouped.families;
  const singles = grouped.singles;

  // ── Phase B: read the contract number off the PDFs ────────────────────────
  const budget = num(flags['pdf-limit'], DEFAULT_PDF_BUDGET);
  const skipPdf = flags['no-pdf'] === true;
  let spent = 0; // PDFs actually downloaded from the API
  let read = 0; // invoices whose text was successfully parsed (fixtures included)
  let budgetHit = 0; // skipped purely because the download budget ran out
  const notes = [];

  async function enrich(rec) {
    if (skipPdf) return null;
    const needsDownload = typeof rec.pdf_text !== 'string';
    if (needsDownload && spent >= budget) {
      budgetHit++;
      return null;
    }
    if (needsDownload && !ctx.offline) spent++;
    try {
      const got = await invoiceText(rec, ctx);
      if (!got.text) return null;
      read++;
      return parseInvoice(got.text);
    } catch (e) {
      if (e && e.name === 'NodeExitError') throw e;
      notes.push('could not read ' + (rec.receipt_id || rec.id) + ': ' + trunc(e.message, 90));
      return null;
    }
  }

  /** A family with a single invoice has no gap to measure, but its PDF service
   *  period proves the cadence anyway: Apr 1 2026 → Mar 31 2027 is an ANNUAL
   *  contract billed once up front, not a one-off charge. Getting this wrong
   *  makes a $417k annual renewal look like a stray expense. */
  function cadenceFromPeriod(f, p) {
    if (f.members.length > 1 || !p || !p.period_start || !p.period_end) return f.cadence;
    const a = Date.parse(p.period_start);
    const b = Date.parse(p.period_end);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return f.cadence;
    return cadenceName(Math.round((b - a) / 86400000)) + ' term';
  }

  for (const f of families) {
    // Newest member: the current contract terms, not a superseded one.
    const p = await enrich(f.members[f.members.length - 1]);
    if (!p) continue;
    f.contract = p.contract;
    f.order_type = p.order_type;
    f.period_start = p.period_start;
    f.period_end = p.period_end;
    f.excess_usage = p.excess_usage;
    f.cadence = cadenceFromPeriod(f, p);
    f.read = true;
    if (p.contract) f.key = p.contract;
  }
  for (const f of families) f.components = [componentOf(f)];
  families = mergeByContract(families);

  // Singletons: an unmatched amount is either a real one-off contract charge
  // (has a contract number) or a variable usage bill (has none). Splitting them
  // by contract number is the whole point of this command.
  const usageBucket = [];
  const unknownBucket = [];
  for (const rec of singles) {
    const p = await enrich(rec);
    if (!p) {
      unknownBucket.push(rec);
      continue;
    }
    if (p.contract) {
      const one = {
        key: p.contract,
        contract: p.contract,
        order_type: p.order_type,
        amount: amt(rec),
        fixed_amount: true,
        cadence: cadenceFromPeriod({ members: [rec], cadence: 'one-off' }, p),
        median_gap_days: null,
        members: [rec],
        total: amt(rec),
        period_start: p.period_start,
        period_end: p.period_end,
        read: true,
        excess_usage: p.excess_usage,
      };
      one.components = [componentOf(one)];
      families.push(one);
      continue;
    }
    rec.__usage = p.excess_usage;
    usageBucket.push(rec);
  }
  families = mergeByContract(families);

  const excess = usageBucket.filter(function (r) {
    return r.__usage;
  });
  const otherVariable = usageBucket.filter(function (r) {
    return !r.__usage;
  });
  const extra = [];
  if (excess.length) extra.push(variableFamily(excess, 'excess-usage'));
  if (otherVariable.length) extra.push(variableFamily(otherVariable, 'no-contract-number'));
  if (unknownBucket.length) extra.push(variableFamily(unknownBucket, 'contract-unknown'));

  const all = families.concat(extra).sort(function (a, b) {
    return b.total - a.total;
  });
  const grand = all.reduce(function (s, f) {
    return s + f.total;
  }, 0);

  if (flags.json) {
    cli.out({
      account: ctx.acct,
      scope: year || 'all',
      invoices: scoped.length,
      credits: credits.length,
      grand_total: grand,
      pdfs_downloaded: spent,
      invoices_parsed: read,
      unattributed: unknownBucket.length,
      families: all.map(function (f) {
        return {
          key: f.key,
          contract: f.contract || null,
          order_type: f.order_type || null,
          recurring_amount: f.fixed_amount ? f.amount : null,
          cadence: f.cadence,
          median_gap_days: f.median_gap_days,
          count: f.members.length,
          first: day(f.members[0].occurred_at),
          last: day(f.members[f.members.length - 1].occurred_at),
          service_period: f.period_start ? { start: f.period_start, end: f.period_end } : null,
          pdf_read: f.read === true,
          excess_usage: f.excess_usage === true,
          components: (f.components || []).map(function (p2) {
            return { amount: p2.amount, cadence: p2.cadence, count: p2.count, first: p2.first, last: p2.last, total: p2.total };
          }),
          total: f.total,
          receipt_ids: f.members.map(function (m) {
            return m.receipt_id;
          }),
        };
      }),
      notes: notes,
    });
    return;
  }

  console.log('');
  console.log(
    '  ' +
      c.bold('contract families') +
      '  ' +
      c.dim(
        (year || 'all years') +
          ' · ' +
          scoped.length +
          ' invoices · ' +
          all.length +
          ' families · ' +
          read +
          ' PDF(s) parsed' +
          (spent ? ' (' + spent + ' downloaded)' : ''),
      ),
  );
  console.log('');
  console.log(
    '    ' + pad('contract', 16) + lpad('recurring', 14) + '  ' + pad('cadence', 14) + pad('n', 4) + pad('order type', 26) + pad('window', 25) + lpad('total', 16),
  );
  for (const f of all) {
    // Label truth table: a contract number if we read one; "(none)" when the
    // PDF WAS read and carried no contract number (that is a finding, not a
    // gap); "(unread)" only when no text was available at all.
    const plainLabel = f.contract || (f.read ? '(none)' : '(unread)');
    const label = f.contract ? c.cyan(plainLabel) : f.read ? c.yellow(plainLabel) : c.dim(plainLabel);
    const parts = f.components || [componentOf(f)];
    const fixed = f.fixed_amount && f.amount != null;
    const plainAmt = fixed ? usd(f.amount) : parts.length > 1 ? 'mixed' : 'variable';
    const type =
      f.order_type ||
      (f.excess_usage ? 'Excess Usage Billing' : f.key === 'contract-unknown' ? '(pdf not read)' : '-');
    console.log(
      '    ' +
        padc(plainLabel, label, 16) +
        lpadc(plainAmt, fixed ? plainAmt : c.dim(plainAmt), 14) +
        '  ' +
        pad(f.cadence, 14) +
        pad('×' + f.members.length, 4) +
        pad(trunc(type, 24), 26) +
        pad(day(f.members[0].occurred_at) + ' → ' + day(f.members[f.members.length - 1].occurred_at), 25) +
        lpad(usd(f.total), 16),
    );
    if (f.period_start && f.period_end) {
      console.log('    ' + c.dim(pad('', 16) + 'current service period ' + f.period_start + ' → ' + f.period_end));
    }
    // One contract can bill several distinct recurring amounts. Show them, or
    // a "$240,300.00 monthly ×8" base charge disappears into "mixed".
    if (parts.length > 1) {
      for (const p2 of parts) {
        console.log(
          '    ' +
            c.dim(
              pad('', 16) +
                '↳ ' +
                lpad(p2.amount != null ? usd(p2.amount) : 'variable', 12) +
                '  ' +
                pad(p2.cadence, 14) +
                pad('×' + p2.count, 5) +
                pad(p2.first + ' → ' + p2.last, 25) +
                lpad(usd(p2.total), 15),
            ),
        );
      }
    }
  }
  console.log('');
  console.log('    ' + pad('', 16) + lpad('grand total', 60) + lpad(usd(grand), 16));
  if (credits.length && !year) {
    console.log(
      '    ' +
        pad('', 16) +
        lpad('credits (separate)', 60) +
        lpad(
          usd(
            credits.reduce(function (s, r) {
              return s + amt(r);
            }, 0),
          ),
          16,
        ),
    );
  }
  console.log('');
  for (const n of notes) console.log(c.yellow('    ! ' + n));
  if (skipPdf) console.log(c.dim('    --no-pdf: families grouped by amount only, no contract numbers read.'));
  else if (unknownBucket.length) {
    console.log(
      c.dim(
        '    ' +
          unknownBucket.length +
          ' invoice(s) left unread — ' +
          (budgetHit
            ? budgetHit + ' hit the PDF budget of ' + budget + ' (raise it with --pdf-limit N)'
            : 'no invoice text was available for them') +
          '.\n    Their contract number is UNKNOWN: do not attribute them to anyone yet.',
      ),
    );
  }
  console.log(
    c.dim(
      '\n  Why this matters. On a shared enterprise account the invoice list mixes the\n' +
        "  parent org's contracts with your team's, and the contract number printed on\n" +
        '  each PDF is the only reliable discriminator — not the amount, not the date,\n' +
        '  not the account. Take the family list to whoever owns each contract number\n' +
        '  and attribute it before quoting a spend figure. Summing the whole account\n' +
        "  instead of your own families overstated one team's Cloudflare cost by ~20x.\n" +
        '  Invoices with NO contract number and an "Excess Usage Billing" description\n' +
        '  are metered overage on your own usage — see `billing usage <receipt_id>`.',
    ),
  );
  console.log('');
}

// ─── help + dispatch ─────────────────────────────────────────────────────────

const HELP = [
  'wrangler-ext — SLICC-only extensions to the cloudflare skill. The upstream',
  '               wrangler CLI has no billing command group, so billing lives',
  '               here and `wrangler` stays command-compatible with',
  '               github.com/cloudflare/workers-sdk.',
  '',
  'USAGE',
  '  wrangler-ext billing invoices [--limit N] [--year YYYY] [--json]',
  '      Invoice history, newest first: date, receipt_id (IN…), amount, status',
  '      and the record uuid that `billing pdf` needs. Credits are listed',
  '      separately because their amounts are NEGATIVE.',
  '',
  '  wrangler-ext billing summary [--year YYYY] [--json]',
  '      Per-month totals for a year, per-year totals for the whole history, and',
  '      an explicit list of invoices not marked paid (status OPEN or',
  '      amount_to_pay > 0) with the caveat that OPEN ≠ money owed.',
  '',
  '  wrangler-ext billing contracts [--year YYYY] [--pdf-limit N] [--no-pdf] [--json]',
  '      THE useful one. Groups invoices into recurring contract families and',
  '      reads the contract number (IC-…) off each PDF, so you can tell your',
  '      spend from a parent org\'s on a shared enterprise account. Variable',
  '      "Excess Usage Billing" invoices have no contract number and are flagged',
  '      as their own family — those are definitively yours.',
  '',
  '  wrangler-ext billing pdf <receipt_id|uuid> [--out PATH]',
  '      Download one invoice PDF and verify its %PDF magic bytes. A human',
  '      receipt_id (IN706358) is resolved to its uuid automatically.',
  '',
  '  wrangler-ext billing lineitems <receipt_id|uuid> [--json]',
  '      Download the PDF, extract its text and print contract number, order',
  '      type, service period, totals and any usage detail.',
  '',
  '  wrangler-ext billing usage <receipt_id|uuid> [--json]',
  '      Parse an "Excess Usage Billing" invoice into cap / rate / actual usage /',
  '      cost per metric, so cap-vs-actual is visible.',
  '',
  '  wrangler-ext billing subscriptions [--json]',
  '      Account subscriptions. On enterprise accounts every entry reports',
  '      price: 0 / intent: ENTERPRISE_CONTRACT — the API exposes no per-product',
  '      cost, which is why invoice PDFs are the only route to real line items.',
  '',
  'FLAGS',
  '  --json             Raw JSON instead of the formatted view',
  '  --year YYYY        Restrict to one calendar year',
  '  --limit N          Rows to print (invoices, default 25)',
  '  --pdf-limit N      Max PDFs to download in `contracts` (default ' + DEFAULT_PDF_BUDGET + ')',
  '  --no-pdf           Group by amount only; do not download any PDF',
  '  --out PATH         Destination for `billing pdf`',
  '  --account ID       32-hex account id (default: read from the dash tab URL)',
  '  --tab ID           Override the playwright target id',
  '  --fixture FILE     Read a saved billing/history JSON array instead of the',
  '                     API. A record may carry `pdf_text` to stand in for its',
  '                     PDF, which is how the grouping logic is tested offline.',
  '',
  'REQUIRES',
  '  An open, logged-in dash.cloudflare.com tab (`wrangler open`). Cloudflare',
  '  exposes invoices ONLY to a dashboard session — no CLOUDFLARE_API_TOKEN',
  '  scope reaches /billing/history. PDF text extraction uses `pdftk',
  '  dump_data_utf8` locally and falls back to `pdftotext -layout` on an `ssh`',
  '  exec follower; see references/pdf-extraction.md.',
].join('\n');

const parsed = normalize(process.argv.parseFlags());
const flags = parsed.flags;
const positional = parsed.positional;
const group = positional[0] || '';

async function main() {
  if (flags.help || flags.h || !group || group === 'help') cli.help(HELP);
  try {
    if (group !== 'billing') {
      cli.die("unknown command: " + group + "\n  Only `wrangler-ext billing …` exists. Zone analytics live in `wrangler`.", {
        prefix: 'wrangler-ext',
      });
    }
    const sub = str(positional[1]);
    const rest = positional.slice(2);
    if (sub === 'invoices' || sub === 'list' || sub === 'history') return await cmdInvoices(flags);
    if (sub === 'summary') return await cmdSummary(flags);
    if (sub === 'contracts' || sub === 'families') return await cmdContracts(flags);
    if (sub === 'pdf' || sub === 'download') return await cmdPdf(rest, flags);
    if (sub === 'lineitems' || sub === 'line-items' || sub === 'invoice') return await cmdLineitems(rest, flags);
    if (sub === 'usage' || sub === 'overage') return await cmdUsage(rest, flags);
    if (sub === 'subscriptions' || sub === 'subs') return await cmdSubscriptions(flags);
    cli.die(
      'unknown billing subcommand: ' +
        (sub || '(none)') +
        '\n  wrangler-ext billing invoices | summary | contracts | pdf <id> |\n' +
        '                       lineitems <id> | usage <id> | subscriptions',
      { prefix: 'wrangler-ext' },
    );
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err.message, { prefix: 'wrangler-ext' });
  }
}

await main();
