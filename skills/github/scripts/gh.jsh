// gh.jsh — GitHub CLI for SLICC agents
// Usage: gh <command> <subcommand> [args] [owner/repo]
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ MIGRATION NOTES                                                             │
// │                                                                             │
// │ Migrated to new APIs (PR #117, "feat(github): port gh.jsh to PR #786       │
// │ runtime extensions"):                                                       │
// │  • Colors: Custom `C` object → `c` global                                  │
// │  • Formatting: Custom trunc(), pad(), table() → `fmt.trunc`, `fmt.col`,    │
// │    `fmt.table`                                                              │
// │  • Date formatting: Custom fmtDate() → `fmt.date(s, 'short')`              │
// │  • Error handling: Custom die() → `cli.die()`                              │
// │  • API calls: Custom api() fetch wrapper → single `http.client()` with     │
// │    context-aware token function (req.method for read/write routing)         │
// │  • Token resolution: Manual exec/env → `skill.token('github')` with        │
// │    fallback to env var / git config for backward compat                     │
// │  • Flag parsing: parseMondayFlags() → `process.argv.parseFlags()` used     │
// │    at top level for cmd/sub routing; per-command flags still manual where   │
// │    parseFlags()'s single-subcommand model doesn't fit 2-level routing      │
// │  • Duration parsing: Custom parseDateFlag() → `time.parseDuration()`       │
// │  • Help: console.log → `cli.help()` (exits 0 automatically)               │
// │  • Output: JSON output → `cli.out()` for structured data                   │
// │                                                                             │
// │ Resolved after initial port (fixes in c4411949/f99c0395):                   │
// │  • Token function now receives request context → single api client          │
// │  • cli.die supports { prefix: 'gh' } → domain-specific error output        │
// │  • fmt.date('locale') → "May 29, 2026" style available                     │
// │  • http.client opts.raw:true → access response headers for pagination      │
// │  • http.client timeoutMs → per-attempt timeout support                      │
// │                                                                             │
// │ Remaining patterns that stayed manual (as of the PR #117 port):            │
// │  • 2-level command routing (parseFlags gives positional[0] as subcommand    │
// │    but we need cmd+sub, so routing is explicit)                            │
// │  • http.client throws on non-2xx — vars set existence check uses           │
// │    try/catch for expected 404                                              │
// │  • AI attribution device flow — too specialized for any runtime API        │
// │  • Monday protocol outputs raw JSON (cli.out pretty-prints; using          │
// │    console.log + JSON.stringify instead)                                    │
// ├─────────────────────────────────────────────────────────────────────────────┤
// │ MIGRATED (AGAIN) TO NODE-LIKE API — this PR                                │
// │                                                                             │
// │ The .jsh runtime API changed again: it removed essentially all of the old  │
// │ globals-heavy helper objects (`skill`, `cli`, `fmt`, `c`, `http`, `exec`,   │
// │ `time`, `pool`, `browser`) in favor of a standard, node-like environment   │
// │ (`require()`, global `fetch`, `process.env`, `process.argv`, `console`).   │
// │ Every one of the API surfaces the PR #117 migration introduced is now      │
// │ gone, so this is a straight re-port of the same behavior onto the new      │
// │ primitives:                                                                 │
// │                                                                             │
// │  • `skill.token('github')` + exec-based `git config` fallback              │
// │      → `process.env.GITHUB_TOKEN` directly (die with a clear message if    │
// │        unset — no more silent fallback chains).                            │
// │  • `exec('git remote get-url origin ...')` (repo inference)                │
// │      → best-effort read + regex-parse of `.git/config` via                 │
// │        `fs.promises.readFile`; non-fatal, callers that need a repo still   │
// │        die with a clear message if inference fails and none was passed.    │
// │  • `http.client({...})` → small local `apiRequest()` helper built on       │
// │        global `fetch`, with the same 429/503 retry-with-backoff behavior,  │
// │        a custom `HttpError` shape ({status, statusText, url, body}), and   │
// │        the same context-aware (AI attribution) token selection.            │
// │  • `cli.die/out/warn/help` → small local `die()`, `out()`, `warn()`,       │
// │        `help()` functions using `console.error`/`console.log`/            │
// │        `process.exit()`.                                                   │
// │  • `c.*` ANSI helpers → local color functions using raw ANSI escapes,      │
// │        disabled when `NO_COLOR` is set or `process.stdout.isTTY` is        │
// │        falsy.                                                              │
// │  • `fmt.table/trunc/col/date` → local reimplementations (`table()`,        │
// │        `trunc()`, `col()`, `fmtDate()`), same output shape/styles.         │
// │  • `time.parseDuration()` (only used by `monday`) → local                  │
// │        `parseDuration()` mini-parser for the same `ms/s/m/h/d/w/M/y`       │
// │        suffix language.                                                    │
// │  • `process.argv.parseFlags()` → local `parseFlags()` reproducing the      │
// │        documented positional/flags/subcommand/passthrough behavior         │
// │        (kept for parity, though this script's own routing remains manual   │
// │        two-level dispatch, same as before).                                │
// │  • `fs.readFile`/`fs.writeFile` (old globals-style) → `require('fs')` and  │
// │        `fs.promises.readFile`/`fs.promises.writeFile`, with               │
// │        `fs.promises.readFileBinary` used for byte-faithful base64          │
// │        encoding in `content put` (see references/gotchas.md — naive       │
// │        utf8-decode-then-reencode double-encodes non-ASCII bytes).          │
// │  • AI attribution device flow, bot-token cache file plumbing: same         │
// │        intent, just ported to `fs.promises` for the cache file and         │
// │        global `fetch` for the broker calls (both already worked this way  │
// │        under the old runtime, so minimal change here).                    │
// │                                                                             │
// │ All command names, flags, and output formatting are unchanged — this is    │
// │ purely a runtime-API port, not a feature change.                          │
// └─────────────────────────────────────────────────────────────────────────────┘

const fs = require('fs');
const path = require('path');

// ─── console/exit helpers (formerly cli.die/out/warn/help) ──────────────────

function die(msg, opts) {
  const prefix = opts && opts.prefix;
  console.error(prefix ? `${prefix}: ${msg}` : msg);
  process.exit(1);
}

function out(value) {
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function warn(msg) {
  console.error(msg);
}

function help(text) {
  console.log(text);
  process.exit(0);
}

// ─── colors (formerly the `c` global) ────────────────────────────────────────

const colorsEnabled = !process.env.NO_COLOR && (process.stdout.isTTY !== false);

function wrap(code) {
  return (s) => (colorsEnabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

const c = {
  green:  wrap(32),
  red:    wrap(31),
  yellow: wrap(33),
  gray:   wrap(90),
  bold:   wrap(1),
  cyan:   wrap(36),
  dim:    wrap(2),
};

// ─── formatting helpers (formerly the `fmt` global) ─────────────────────────

function trunc(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, n);
  return s.slice(0, n - 1) + '…';
}

// Strip ANSI escapes to measure visible width for padding.
function visibleLength(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function col(s, width) {
  s = String(s == null ? '' : s);
  const len = visibleLength(s);
  if (len >= width) return s;
  return s + ' '.repeat(width - len);
}

function table(rows, widths) {
  if (!rows.length) return '';
  const numCols = rows[0].length;
  const colWidths = [];
  for (let i = 0; i < numCols; i++) {
    if (widths && widths[i] != null) {
      colWidths.push(widths[i]);
    } else {
      let max = 0;
      for (const row of rows) max = Math.max(max, visibleLength(row[i]));
      colWidths.push(max + 2);
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? String(cell == null ? '' : cell) : col(cell, colWidths[i])))
        .join('')
    )
    .join('\n');
}

function fmtDate(value, style) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  style = style || 'short';
  if (style === 'iso') return d.toISOString();
  if (style === 'human') {
    const now = Date.now();
    const diffMs = now - d.getTime();
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return sec + 's ago';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const day = Math.floor(hr / 24);
    if (day < 30) return day + 'd ago';
    const mon = Math.floor(day / 30);
    if (mon < 12) return mon + 'mo ago';
    return Math.floor(day / 365) + 'y ago';
  }
  if (style === 'locale') {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }
  // 'short' (default)
  return d.toISOString().slice(0, 10);
}

// ─── duration parser (formerly time.parseDuration) — only used by `monday` ──

function parseDuration(spec) {
  const m = /^(\d+)\s*(ms|s|m|h|d|w|M|y)$/.exec(String(spec).trim());
  if (!m) die(`Invalid duration: ${JSON.stringify(spec)}`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const unitMs = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    M: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return n * unitMs[unit];
}

// ─── flag parser (formerly process.argv.parseFlags()) ───────────────────────
// Not used for this script's own (manual, two-level) command routing, but
// kept available/documented since it was part of the old API surface this
// script relied on. Reproduces: positional args, --flag=val, --flag val,
// -x short boolean flags, repeated flags promote to arrays, `--` passthrough.

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  const passthrough = [];
  let sawDashDash = false;

  const addFlag = (name, value) => {
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      if (Array.isArray(flags[name])) flags[name].push(value);
      else flags[name] = [flags[name], value];
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (sawDashDash) {
      passthrough.push(a);
      continue;
    }
    if (a === '--') {
      sawDashDash = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        addFlag(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          addFlag(name, next);
          i++;
        } else {
          addFlag(name, true);
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      addFlag(a.slice(1), true);
    } else {
      positional.push(a);
    }
  }

  return {
    positional,
    flags,
    subcommand: positional[0] || null,
    passthrough,
  };
}

// ─── Auth ────────────────────────────────────────────────────────────────────

const personalToken = process.env.GITHUB_TOKEN || '';
if (!personalToken) {
  die('No GitHub token found. GITHUB_TOKEN is not set in the environment. Run `oauth-token github` to obtain one.', { prefix: 'gh' });
}

// ─── AI attribution (ai-aligned-gh) ──────────────────────────────────────────

const isAI = !!(process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT
  || process.env.GEMINI_CLI || process.env.CODEX_CLI || process.env.CURSOR_AGENT);

const BROKER_URL = process.env.AS_A_BOT_URL || 'https://as-bot-worker.minivelos.workers.dev';
const BOT_CACHE = '/.cache/ai-aligned-gh/token';

const WRITE_OPS = {
  pr:            ['merge','comment','create','edit','close','review'],
  issue:         ['create','edit','close','comment'],
  vars:          ['set'],
  release:       ['create','upload','delete'],
  notifications: ['read'],
};

function isMutating(cmd, sub) {
  return WRITE_OPS[cmd]?.includes(sub);
}

async function getAttributedToken() {
  // 1. Check cache
  try {
    const cached = (await fs.promises.readFile(BOT_CACHE, 'utf8')).trim();
    if (cached) {
      const check = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${cached}`, 'User-Agent': 'gh.jsh/1.0' }
      });
      if (check.ok) return cached;
    }
  } catch {}

  // 2. Start device flow
  let flow;
  try {
    const r = await fetch(`${BROKER_URL}/user-token/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: 'repo' })
    });
    flow = await r.json();
  } catch { return personalToken; } // broker unreachable, fall back

  if (!flow.device_code) return personalToken;

  console.error(`\n⚡ AI attribution required — authorize as-a-bot:\n`);
  console.error(`   Visit: ${flow.verification_uri}`);
  console.error(`   Code:  ${flow.user_code}\n`);

  // 3. Poll
  const interval = (flow.interval || 5) * 1000;
  const expires  = Date.now() + (flow.expires_in || 900) * 1000;
  while (Date.now() < expires) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const p = await fetch(`${BROKER_URL}/user-token/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: flow.device_code })
      });
      const result = await p.json();
      if (result.access_token) {
        await fs.promises.mkdir(path.dirname(BOT_CACHE), { recursive: true }).catch(() => {});
        await fs.promises.writeFile(BOT_CACHE, result.access_token);
        console.error(`✓ Authenticated — actions will appear as you via as-a-bot.\n`);
        return result.access_token;
      }
      if (result.error && result.error !== 'authorization_pending' && result.error !== 'slow_down') break;
    } catch { break; }
  }
  return personalToken; // timed out, fall back
}

// ─── HTTP Client (formerly http.client()) ────────────────────────────────────

class HttpError extends Error {
  constructor(status, statusText, url, body) {
    super(`HTTP ${status} ${statusText} — ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
  }
}

const API_BASE = 'https://api.github.com';

function buildUrl(pathOrUrl, params) {
  const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : API_BASE + pathOrUrl;
  if (!params || !Object.keys(params).length) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function apiRequest(method, pathOrUrl, opts) {
  opts = opts || {};
  const url = buildUrl(pathOrUrl, opts.params);

  const token = (isAI && method !== 'GET') ? await getAttributedToken() : personalToken;

  const headers = Object.assign({
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'gh.jsh/1.0',
  }, opts.headers || {});

  let bodyStr;
  if (opts.body !== undefined) {
    bodyStr = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }

  const maxAttempts = 3;
  const retryOn = [429, 503];
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: bodyStr,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      throw e;
    }

    if (resp.status === 204) return null;

    let parsed;
    const text = await resp.text();
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

    if (!resp.ok) {
      if (retryOn.includes(resp.status) && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      throw new HttpError(resp.status, resp.statusText, url, parsed);
    }

    if (opts.raw) {
      return { body: parsed, headers: resp.headers, status: resp.status };
    }
    return parsed;
  }

  throw lastErr || new Error('request failed');
}

const api = {
  get:    (p, opts) => apiRequest('GET', p, opts),
  post:   (p, opts) => apiRequest('POST', p, opts),
  put:    (p, opts) => apiRequest('PUT', p, opts),
  patch:  (p, opts) => apiRequest('PATCH', p, opts),
  delete: (p, opts) => apiRequest('DELETE', p, opts),
};

// ─── Symbols ─────────────────────────────────────────────────────────────────

const SYM = {
  success:     c.green('✓'),
  failure:     c.red('✗'),
  timed_out:   c.red('✗'),
  action_required: c.red('✗'),
  pending:     c.yellow('●'),
  in_progress: c.yellow('●'),
  queued:      c.yellow('●'),
  waiting:     c.yellow('●'),
  skipped:     c.gray('○'),
  draft:       c.gray('○'),
  cancelled:   c.gray('○'),
  neutral:     c.gray('○'),
  open:        c.green('✓'),
  closed:      c.red('✗'),
  merged:      c.green('✓'),
  stale:       c.gray('○'),
};

function sym(s) { return SYM[s] || c.gray('?'); }

// ─── Repo inference ───────────────────────────────────────────────────────────

async function inferRepo() {
  let configText;
  try {
    configText = await fs.promises.readFile(path.join(process.cwd(), '.git', 'config'), 'utf8');
  } catch {
    return null;
  }
  const match = configText.match(/url\s*=\s*.*github\.com[:/]([^/\s]+\/[^/\s.]+)(?:\.git)?/);
  return match ? match[1] : null;
}

async function resolveRepo(arg) {
  if (arg && arg.includes('/')) return validateRepo(arg);
  const inferred = await inferRepo();
  if (inferred) return inferred;
  die('No repo specified and could not infer from git remote. Pass owner/repo explicitly.');
}

// ─── Input validation ────────────────────────────────────────────────────────

function validateNum(val, name) {
  const n = parseInt(val, 10);
  if (!val || isNaN(n) || n <= 0 || String(n) !== String(val).trim()) {
    die(`Invalid ${name}: must be a positive integer (got: ${JSON.stringify(val)})`);
  }
  return n;
}

function validateRepo(val) {
  if (!val) return val;
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(val)) {
    die(`Invalid repo format: expected owner/repo with alphanumeric, hyphens, dots (got: ${JSON.stringify(val)})`);
  }
  return val;
}

function validateVarName(val) {
  if (!val || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) {
    die(`Invalid variable name: must match [a-zA-Z_][a-zA-Z0-9_]* (got: ${JSON.stringify(val)})`);
  }
  return val;
}

function sanitizeBranch(branch) {
  const safe = branch.replace(/[^a-zA-Z0-9/_.\-]/g, '_');
  if (safe !== branch) {
    warn('Branch name contained unsafe characters — sanitized for display');
  }
  return safe;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmtDateLocale(s) {
  if (!s) return '';
  return fmtDate(s, 'locale');
}

// ─── Error helper ────────────────────────────────────────────────────────────

function fail(cmd, err) {
  die(cmd + ' failed: ' + (err.body?.message || err.message), { prefix: 'gh' });
}

// ─── pr list ─────────────────────────────────────────────────────────────────

async function prList(args) {
  const repo = await resolveRepo(args[0]);
  let prs;
  try { prs = await api.get(`/repos/${repo}/pulls`, { params: { state: 'open', per_page: 30 } }); }
  catch (e) { fail('pr list', e); }

  if (!prs.length) { console.log(c.gray('No open pull requests.')); return; }

  const rows = prs.map(pr => [
    c.cyan('#' + pr.number),
    trunc(pr.title, 52),
    c.gray(trunc(pr.head.ref, 36)),
    pr.draft ? c.green('open') + '  ' + c.yellow('[DRAFT]') : c.green('open'),
  ]);
  console.log(table(rows, [6, 54, 38]));
}

// ─── pr view ─────────────────────────────────────────────────────────────────

async function prView(args) {
  if (!args[0]) die('pr view: PR number required');
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  let pr, checks;
  try { pr = await api.get(`/repos/${repo}/pulls/${num}`); }
  catch (e) { fail('pr view', e); }
  try { checks = await api.get(`/repos/${repo}/commits/${pr.head.sha}/check-runs`, { params: { per_page: 30 } }); }
  catch { checks = { check_runs: [] }; }

  const statusStr = pr.merged ? sym('merged') + ' ' + c.green('merged')
    : pr.draft ? sym('draft') + ' ' + c.gray('draft')
    : sym(pr.state) + ' ' + (pr.state === 'open' ? c.green('open') : c.red('closed'));

  console.log(c.bold(pr.title) + '  ' + statusStr);
  console.log(c.gray('Author:') + '  ' + pr.user.login);
  console.log(c.gray('Branch:') + '  ' + pr.head.ref + ' → ' + pr.base.ref);
  console.log(c.gray('URL:') + '     ' + pr.html_url);

  const runs = (checks.check_runs || []);
  if (runs.length) {
    const passed  = runs.filter(r => r.conclusion === 'success').length;
    const failed  = runs.filter(r => r.conclusion === 'failure' || r.conclusion === 'timed_out').length;
    const pending = runs.filter(r => !r.conclusion || r.status === 'in_progress' || r.status === 'queued').length;
    const parts = [
      passed  ? c.green(passed + ' passed')   : null,
      failed  ? c.red(failed + ' failed')     : null,
      pending ? c.yellow(pending + ' pending') : null,
    ].filter(Boolean);
    if (parts.length) console.log(c.gray('Checks:') + '  ' + parts.join('  '));
  }

  if (pr.body) {
    console.log('\n' + c.gray('Body:'));
    console.log(trunc(pr.body.replace(/\r?\n/g, ' '), 400));
  }
}

// ─── pr merge ────────────────────────────────────────────────────────────────

async function prMerge(args) {
  if (!args[0]) die('pr merge: PR number required');
  const num = validateNum(args[0], 'PR number');
  let method = 'merge';
  const rest = [];
  for (const a of args.slice(1)) {
    if (a === '--squash') method = 'squash';
    else if (a === '--rebase') method = 'rebase';
    else if (a === '--merge') method = 'merge';
    else rest.push(a);
  }
  const repo = await resolveRepo(rest[0]);
  try {
    const res = await api.put(`/repos/${repo}/pulls/${num}/merge`, {
      body: { merge_method: method },
    });
    console.log(sym('merged') + ' ' + c.green('Merged') + ' PR #' + num + ' via ' + method + (res.message ? ' — ' + res.message : ''));
  } catch (e) { fail('pr merge', e); }
}

// ─── pr comment ──────────────────────────────────────────────────────────────

async function prComment(args) {
  if (!args[0]) die('pr comment: PR number required');
  const num = validateNum(args[0], 'PR number');
  if (!args[1]) die('pr comment: message required');
  const repo = await resolveRepo(args[2]);
  try {
    const res = await api.post(`/repos/${repo}/issues/${num}/comments`, {
      body: { body: args[1] },
    });
    console.log(sym('success') + ' Comment posted: ' + res.html_url);
  } catch (e) { fail('pr comment', e); }
}

// ─── pr create ───────────────────────────────────────────────────────────────

async function prCreate(args) {
  const usage = 'usage: gh pr create <title> <body> <head-branch> [--base=<base>] [--draft] [repo]';
  let base = null, draft = false;
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--base=')) base = a.slice(7).trim();
    else if (a === '--draft') draft = true;
    else positional.push(a);
  }
  if (!positional[0]) die('pr create: title required\n' + usage);
  if (positional[1] === undefined) die('pr create: body required\n' + usage);
  if (!positional[2]) die('pr create: head branch required\n' + usage);
  const [title, body, head] = positional;
  const repo = await resolveRepo(positional[3]);

  // Default base to the repo's default branch if not specified
  if (!base) {
    try {
      const r = await api.get(`/repos/${repo}`);
      base = r.default_branch || 'main';
    } catch { base = 'main'; }
  }

  try {
    const res = await api.post(`/repos/${repo}/pulls`, {
      body: { title, body, head, base, draft },
    });
    console.log(sym('success') + ' Created PR ' + c.cyan('#' + res.number) + ': ' + res.title);
    console.log(c.gray('Branch:') + '  ' + res.head.ref + ' → ' + res.base.ref);
    console.log(c.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('pr create', e); }
}

// ─── pr checkout ─────────────────────────────────────────────────────────────

async function prCheckout(args) {
  if (!args[0]) die('pr checkout: PR number required');
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  let pr;
  try { pr = await api.get(`/repos/${repo}/pulls/${num}`); }
  catch (e) { fail('pr checkout', e); }

  const branch = sanitizeBranch(pr.head.ref);
  const remoteUrl = pr.head.repo ? pr.head.repo.clone_url : `https://github.com/${repo}.git`;
  console.log(c.gray('# Run these commands to check out this PR:'));
  console.log('git fetch ' + remoteUrl + ' ' + branch);
  console.log('git checkout -b ' + branch + ' FETCH_HEAD');
}

// ─── pr close ────────────────────────────────────────────────────────────────

async function prClose(args) {
  if (!args[0]) die('pr close: PR number required');
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  try {
    const res = await api.patch(`/repos/${repo}/pulls/${num}`, {
      body: { state: 'closed' },
    });
    console.log(sym('closed') + ' Closed PR ' + c.cyan('#' + num) + ': ' + res.title);
    console.log(c.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('pr close', e); }
}

// ─── issue list ──────────────────────────────────────────────────────────────

async function issueList(args) {
  const repo = await resolveRepo(args[0]);
  let issues;
  try { issues = await api.get(`/repos/${repo}/issues`, { params: { state: 'open', per_page: 30 } }); }
  catch (e) { fail('issue list', e); }

  const filtered = issues.filter(i => !i.pull_request);
  if (!filtered.length) { console.log(c.gray('No open issues.')); return; }

  const rows = filtered.map(i => [
    c.cyan('#' + i.number),
    trunc(i.title, 60),
    i.labels.map(l => c.yellow(l.name)).join(', '),
  ]);
  console.log(table(rows, [6, 62]));
}

// ─── issue create ────────────────────────────────────────────────────────────

async function issueCreate(args) {
  const usage = 'usage: gh issue create <title> <body> [--label=L]... [--labels=a,b] [repo]';
  const labelSet = new Set();
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--label=')) {
      const v = a.slice(8).trim();
      if (v) labelSet.add(v);
    } else if (a.startsWith('--labels=')) {
      for (const v of a.slice(9).split(',').map(s => s.trim()).filter(Boolean)) labelSet.add(v);
    } else positional.push(a);
  }
  if (!positional[0]) die('issue create: title required\n' + usage);
  if (positional[1] === undefined) die('issue create: body required\n' + usage);
  const [title, body] = positional;
  const repo = await resolveRepo(positional[2]);

  const payload = { title, body };
  if (labelSet.size) payload.labels = [...labelSet];

  try {
    const res = await api.post(`/repos/${repo}/issues`, { body: payload });
    console.log(sym('success') + ' Created issue ' + c.cyan('#' + res.number) + ' — ' + res.html_url);
  } catch (e) { fail('issue create', e); }
}

// ─── issue view ──────────────────────────────────────────────────────────────

async function issueView(args) {
  if (!args[0]) die('issue view: issue number required');
  const num = validateNum(args[0], 'issue number');
  const repo = await resolveRepo(args[1]);
  let issue;
  try { issue = await api.get(`/repos/${repo}/issues/${num}`); }
  catch (e) { fail('issue view', e); }

  const stateStr = issue.state === 'open' ? c.green('open') : c.red('closed');
  console.log(c.bold(issue.title) + '  ' + sym(issue.state) + ' ' + stateStr);
  console.log(c.gray('Author:') + '  ' + issue.user.login);
  console.log(c.gray('URL:') + '     ' + issue.html_url);
  if (issue.labels.length) console.log(c.gray('Labels:') + '  ' + issue.labels.map(l => c.yellow(l.name)).join(', '));
  if (issue.body) {
    console.log('\n' + c.gray('Body:'));
    console.log(trunc(issue.body.replace(/\r?\n/g, ' '), 400));
  }
}

// ─── repo view ───────────────────────────────────────────────────────────────

async function repoView(args) {
  const repo = await resolveRepo(args[0]);
  let r;
  try { r = await api.get(`/repos/${repo}`); }
  catch (e) { fail('repo view', e); }

  console.log(c.bold(r.full_name));
  if (r.description) console.log(r.description);
  console.log('');
  console.log(c.gray('Stars:          ') + c.yellow('★') + ' ' + r.stargazers_count);
  console.log(c.gray('Forks:          ') + r.forks_count);
  console.log(c.gray('Default branch: ') + r.default_branch);
  console.log(c.gray('Language:       ') + (r.language || 'unknown'));
  console.log(c.gray('Last push:      ') + fmtDateLocale(r.pushed_at));
  if (r.topics && r.topics.length) console.log(c.gray('Topics:         ') + r.topics.join(', '));
  console.log(c.gray('URL:            ') + r.html_url);
}

// ─── run list ────────────────────────────────────────────────────────────────

async function runList(args) {
  const repo = await resolveRepo(args[0]);
  let runs;
  try {
    const data = await api.get(`/repos/${repo}/actions/runs`, { params: { per_page: 20 } });
    runs = data.workflow_runs;
  } catch (e) { fail('run list', e); }

  if (!runs || !runs.length) { console.log(c.gray('No workflow runs.')); return; }

  const rows = runs.map(run => {
    const statusStr = run.status === 'completed'
      ? sym(run.conclusion) + ' ' + (run.conclusion || 'unknown')
      : sym('in_progress') + ' ' + run.status;
    return [
      c.gray(String(run.id)),
      trunc(run.name, 36),
      statusStr,
      c.gray(trunc(run.head_branch, 28)),
      c.gray(fmtDateLocale(run.created_at)),
    ];
  });
  console.log(table(rows, [14, 38, 22, 30]));
}

// ─── run view ────────────────────────────────────────────────────────────────

async function runView(args) {
  if (!args[0]) die('run view: run ID required');
  const runId = validateNum(args[0], 'run ID');
  const repo = await resolveRepo(args[1]);
  let run, jobsData;
  try { run = await api.get(`/repos/${repo}/actions/runs/${runId}`); }
  catch (e) { fail('run view', e); }
  try { jobsData = await api.get(`/repos/${repo}/actions/runs/${runId}/jobs`); }
  catch { jobsData = { jobs: [] }; }

  const statusStr = run.status === 'completed'
    ? sym(run.conclusion || 'neutral') + ' ' + run.status + ' / ' + (run.conclusion || 'unknown')
    : sym('in_progress') + ' ' + run.status;

  console.log(c.bold(run.name) + '  ' + statusStr);
  console.log(c.gray('Branch:  ') + run.head_branch);
  const msg = run.head_commit && run.head_commit.message
    ? trunc(run.head_commit.message.split('\n')[0], 60) : '';
  console.log(c.gray('Commit:  ') + run.head_sha.slice(0, 7) + (msg ? ' — ' + msg : ''));
  console.log(c.gray('Started: ') + fmtDateLocale(run.created_at));
  console.log(c.gray('URL:     ') + run.html_url);

  const jobs = jobsData.jobs || [];
  if (jobs.length) {
    console.log('\n' + c.bold('Jobs:'));
    for (const job of jobs) {
      const s = job.status === 'completed' ? sym(job.conclusion || 'neutral') : sym('in_progress');
      const dur = (job.completed_at && job.started_at)
        ? c.gray(' (' + Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000) + 's)') : '';
      console.log('  ' + s + '  ' + job.name + dur);
    }
  }
}

// ─── release list ────────────────────────────────────────────────────────────

async function releaseList(args) {
  const repo = await resolveRepo(args[0]);
  let releases;
  try { releases = await api.get(`/repos/${repo}/releases`, { params: { per_page: 15 } }); }
  catch (e) { fail('release list', e); }

  if (!releases.length) { console.log(c.gray('No releases.')); return; }

  const rows = releases.map(r => [
    c.cyan(trunc(r.tag_name, 24)),
    trunc(r.name || r.tag_name, 48) + (r.prerelease ? c.yellow(' [pre]') : '') + (r.draft ? c.gray(' [draft]') : ''),
    c.gray(fmtDateLocale(r.published_at)),
  ]);
  console.log(table(rows, [26, 56]));
}

// ─── notifications list ───────────────────────────────────────────────────────

const NOTIF_TYPE_SYM = {
  PullRequest: c.cyan('PR'),
  Issue:       c.green('IS'),
  Release:     c.yellow('RL'),
  Commit:      c.gray('CM'),
  Discussion:  c.cyan('DS'),
  CheckSuite:  c.gray('CS'),
  RepositoryVulnerabilityAlert: c.red('VA'),
};

function notifTypeSym(t) { return NOTIF_TYPE_SYM[t] || c.gray(t.slice(0,2).toUpperCase()); }

const NOTIF_REASON_COLOR = {
  mention:       c.yellow,
  author:        c.cyan,
  comment:       c.gray,
  review_requested: c.yellow,
  assign:        c.cyan,
  subscribed:    c.gray,
  team_mention:  c.yellow,
  ci_activity:   c.gray,
  security_alert: c.red,
};

function reasonStr(r) {
  const fn = NOTIF_REASON_COLOR[r] || c.gray;
  return fn(r.replace('_', ' '));
}

async function notificationsList(args) {
  let participating = false, repoFilter = null, showAll = false, limit = 30;
  const rest = [];
  for (const a of args) {
    if (a === '--participating' || a === '-p') participating = true;
    else if (a === '--all' || a === '-a') showAll = true;
    else if (a.startsWith('--repo=')) repoFilter = a.slice(7);
    else if (a.startsWith('-n')) limit = parseInt(a.slice(2)) || 30;
    else rest.push(a);
  }
  if (rest[0] && rest[0].includes('/')) repoFilter = rest[0];

  const params = {
    all: showAll ? 'true' : 'false',
    participating: participating ? 'true' : 'false',
    per_page: String(Math.min(limit, 50)),
  };

  let notifs;
  try {
    const endpoint = repoFilter
      ? `/repos/${repoFilter}/notifications`
      : `/notifications`;
    notifs = await api.get(endpoint, { params });
  } catch (e) { fail('notifications list', e); }

  if (!notifs.length) { console.log(c.gray('No notifications.')); return; }

  // Group by repo for readability
  const byRepo = {};
  for (const n of notifs) {
    const repo = n.repository.full_name;
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(n);
  }

  for (const [repo, items] of Object.entries(byRepo)) {
    console.log('\n' + c.bold(repo));
    for (const n of items) {
      const type   = notifTypeSym(n.subject.type);
      const title  = trunc(n.subject.title, 60);
      const reason = reasonStr(n.reason);
      const date   = c.gray(fmtDateLocale(n.updated_at));
      const unread = n.unread ? c.yellow('•') : ' ';
      const numMatch = n.subject.url?.match(/\/(pulls|issues)\/(\d+)$/);
      const num = numMatch ? c.gray('#' + numMatch[2]) : '   ';
      console.log('  ' + unread + ' ' + type + ' ' + col(num, 7) + col(title, 62) + '  ' + col(reason, 18) + '  ' + date);
    }
  }
  console.log('');
}

async function notificationsRead(args) {
  let repoFilter = null;
  for (const a of args) {
    if (a.includes('/')) repoFilter = a;
    else if (a.startsWith('--repo=')) repoFilter = a.slice(7);
  }

  try {
    const endpoint = repoFilter
      ? `/repos/${repoFilter}/notifications`
      : `/notifications`;
    await api.put(endpoint, { body: { read: true } });
    console.log(sym('success') + ' Marked ' + (repoFilter ? c.cyan(repoFilter) : 'all') + ' notifications as read');
  } catch (e) { fail('notifications read', e); }
}

// ─── search prs ──────────────────────────────────────────────────────────────

async function searchPrs(args) {
  if (!args[0]) die('search prs: query required');
  const repo = args[1] || await inferRepo();
  const q = args[0] + ' type:pr' + (repo ? ' repo:' + repo : '');
  let results;
  try {
    const data = await api.get('/search/issues', { params: { q, per_page: 20 } });
    results = data.items;
  } catch (e) { fail('search prs', e); }

  if (!results.length) { console.log(c.gray('No matching PRs.')); return; }

  const rows = results.map(item => [
    c.cyan('#' + item.number),
    trunc(item.title, 56),
    c.gray(item.repository_url.replace('https://api.github.com/repos/', '')),
    item.state === 'open' ? c.green('open') : c.red(item.state),
  ]);
  console.log(table(rows, [6, 58, 36]));
}

// ─── vars list ───────────────────────────────────────────────────────────────

async function varsList(args) {
  const repo = await resolveRepo(args[0]);
  let vars;
  try {
    const data = await api.get(`/repos/${repo}/actions/variables`, { params: { per_page: 30 } });
    vars = data.variables;
  } catch (e) { fail('vars list', e); }

  if (!vars || !vars.length) { console.log(c.gray('No variables.')); return; }

  const rows = vars.map(v => [c.cyan(trunc(v.name, 32)), trunc(v.value, 60)]);
  console.log(table(rows, [36]));
}

// ─── vars set ────────────────────────────────────────────────────────────────

async function varsSet(args) {
  if (!args[0]) die('vars set: name required');
  if (args[1] === undefined) die('vars set: value required');
  const repo = await resolveRepo(args[2]);
  const name = validateVarName(args[0]), value = args[1];

  // Check if variable exists (expecting 404 if not — api throws on non-2xx)
  let exists = false;
  try { await api.get(`/repos/${repo}/actions/variables/${name}`); exists = true; } catch {}

  try {
    if (exists) {
      await api.patch(`/repos/${repo}/actions/variables/${name}`, {
        body: { name, value },
      });
    } else {
      await api.post(`/repos/${repo}/actions/variables`, {
        body: { name, value },
      });
    }
    console.log(sym('success') + ' Variable ' + c.cyan(name) + ' ' + (exists ? 'updated' : 'created'));
  } catch (e) { fail('vars set', e); }
}

// ─── auth status ─────────────────────────────────────────────────────────────

async function authStatus() {
  const preview = personalToken ? personalToken.slice(0, 8) + '…' : c.red('(not set)');
  let username = c.gray('(unverified)');
  if (personalToken) {
    try {
      const u = await api.get('/user');
      username = u.login;
    } catch { username = c.red('(invalid token)'); }
  }

  let botStatus = c.gray('not cached — will prompt on first write op');
  try {
    const cached = (await fs.promises.readFile(BOT_CACHE, 'utf8')).trim();
    if (cached) {
      const check = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${cached}`, 'User-Agent': 'gh.jsh/1.0' }
      });
      if (check.ok) {
        const bu = await check.json();
        botStatus = c.green('valid') + ' — acting as ' + c.cyan(bu.login);
      } else {
        botStatus = c.yellow('cached but expired — will re-auth on next write op');
      }
    }
  } catch {}

  const writeList = Object.entries(WRITE_OPS)
    .flatMap(([k, vs]) => vs.map(v => `${k}:${v}`)).join(', ');

  console.log(c.bold('\nPersonal token'));
  console.log('  Source:  ' + c.gray('process.env.GITHUB_TOKEN'));
  console.log('  Token:   ' + c.cyan(preview));
  console.log('  User:    ' + c.cyan(username));
  console.log(c.bold('\nAI attribution'));
  console.log('  Enabled: ' + (isAI ? c.green('yes') : c.gray('no (not running as AI agent)')));
  console.log('  Broker:  ' + c.gray(BROKER_URL));
  console.log('  Bot token: ' + botStatus);
  console.log(c.bold('\nWrite operations that trigger attribution:'));
  console.log('  ' + c.gray(writeList));
  console.log('');
}

// ─── monday protocol ─────────────────────────────────────────────────────────

async function mondayGh(args) {
  // Parse monday-specific flags from args
  let limit = 50, depth = 5, dateSpec = '7d';
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i+1]) { limit = parseInt(args[i+1]); i++; }
    else if (args[i] === '--depth' && args[i+1]) { depth = parseInt(args[i+1]); i++; }
    else if (args[i] === '--date' && args[i+1]) { dateSpec = args[i+1]; i++; }
    else rest.push(args[i]);
  }

  // Use local parseDuration for the date spec
  const sinceMs = parseDuration(dateSpec);
  const since = new Date(Date.now() - sinceMs);
  const sinceISO = since.toISOString();

  // Resolve current user login for search queries
  let username = 'trieloff';
  try {
    const user = await api.get('/user');
    username = user.login;
  } catch {}

  const items = [];
  const seen = new Set();

  function addItem(item) {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  }

  // Helper: fetch up to `depth` comments for a PR or issue and append to body
  async function fetchThread(repo, num, type, currentBody, threadDepth) {
    if (threadDepth <= 0) return currentBody;
    try {
      const comments = await api.get(`/repos/${repo}/issues/${num}/comments`, {
        params: { per_page: Math.min(threadDepth, 100), sort: 'created', direction: 'asc' },
      });
      if (!Array.isArray(comments) || comments.length === 0) return currentBody;
      const thread = comments.map(cc => `@${cc.user.login}: ${(cc.body || '').slice(0, 300)}`).join('\n\n');
      return (currentBody ? currentBody + '\n\n---\n' : '') + thread;
    } catch {
      return currentBody;
    }
  }

  // 1. Notifications
  try {
    const notifs = await api.get('/notifications', {
      params: {
        all: 'false',
        participating: 'true',
        since: sinceISO,
        per_page: String(Math.min(limit, 50)),
      },
    });
    for (const n of notifs) {
      const repo = n.repository.full_name;
      const numMatch = n.subject.url?.match(/\/(\d+)$/);
      const num = numMatch ? numMatch[1] : '';
      const subjectType = n.subject.type;
      const type = subjectType === 'PullRequest' ? 'pr'
        : subjectType === 'Issue' ? 'issue'
        : 'notification';
      const htmlUrl = num
        ? `https://github.com/${repo}/${subjectType === 'PullRequest' ? 'pull' : 'issues'}/${num}`
        : `https://github.com/${repo}`;
      const baseBody = `${n.reason.replace(/_/g, ' ')} — ${n.subject.title}`.slice(0, 500);
      const body = (num && depth > 0)
        ? await fetchThread(repo, num, type, baseBody, depth)
        : baseBody;
      addItem({
        id: `gh-notif-${n.id}`,
        source: 'gh',
        type,
        title: n.subject.title,
        subtitle: num ? `${repo} #${num}` : repo,
        url: htmlUrl,
        ts: n.updated_at,
        body,
        participants: [],
        meta: { reason: n.reason, unread: n.unread },
      });
    }
  } catch {}

  // 2. PRs needing review
  try {
    const q = `is:pr is:open review-requested:${username}`;
    const data = await api.get('/search/issues', { params: { q, per_page: Math.min(limit, 50) } });
    for (const pr of (data.items || [])) {
      const repoUrl = pr.repository_url.replace('https://api.github.com/repos/', '');
      const baseBody = (pr.body || '').slice(0, 500);
      const body = depth > 0
        ? await fetchThread(repoUrl, pr.number, 'pr', baseBody, depth)
        : baseBody;
      addItem({
        id: `gh-pr-${pr.id}`,
        source: 'gh',
        type: 'pr',
        title: pr.title,
        subtitle: `${repoUrl} #${pr.number}`,
        url: pr.html_url,
        ts: pr.updated_at,
        body,
        participants: [pr.user.login, ...(pr.assignees || []).map(a => a.login)].filter((v, i, a) => a.indexOf(v) === i),
        meta: { state: pr.state, draft: pr.draft || false },
      });
    }
  } catch {}

  // 3. Assigned issues
  try {
    const q = `is:issue is:open assignee:${username}`;
    const data = await api.get('/search/issues', { params: { q, per_page: Math.min(limit, 50) } });
    for (const issue of (data.items || [])) {
      const repoUrl = issue.repository_url.replace('https://api.github.com/repos/', '');
      const baseBody = (issue.body || '').slice(0, 500);
      const body = depth > 0
        ? await fetchThread(repoUrl, issue.number, 'issue', baseBody, depth)
        : baseBody;
      addItem({
        id: `gh-issue-${issue.id}`,
        source: 'gh',
        type: 'issue',
        title: issue.title,
        subtitle: `${repoUrl} #${issue.number}`,
        url: issue.html_url,
        ts: issue.updated_at,
        body,
        participants: [issue.user.login, ...(issue.assignees || []).map(a => a.login)].filter((v, i, a) => a.indexOf(v) === i),
        meta: { state: issue.state, labels: (issue.labels || []).map(l => l.name) },
      });
    }
  } catch {}

  // Trim to limit and output (raw JSON for machine consumption)
  const output = items.slice(0, limit);
  console.log(JSON.stringify(output));
}

// ─── repo archive ────────────────────────────────────────────────────────────

async function repoArchive(args) {
  const repo = await resolveRepo(args[0]);
  try {
    await api.patch(`/repos/${repo}`, { body: { archived: true } });
    console.log(sym('success') + ' Archived ' + c.cyan(repo));
  } catch (e) { fail('repo archive', e); }
}

// ─── branch create ───────────────────────────────────────────────────────────

async function branchCreate(args) {
  const usage = 'usage: gh branch create <name> [--from=<ref>] [repo]';
  let from = null;
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--from=')) from = a.slice(7).trim();
    else positional.push(a);
  }
  if (!positional[0]) die('branch create: branch name required\n' + usage);
  const branchName = positional[0];
  const repo = await resolveRepo(positional[1]);

  // Resolve the SHA to branch from
  if (!from) {
    try {
      const r = await api.get(`/repos/${repo}`);
      from = r.default_branch || 'main';
    } catch { from = 'main'; }
  }

  let sha;
  try {
    const ref = await api.get(`/repos/${repo}/git/ref/heads/${from}`);
    sha = ref.object.sha;
  } catch {
    if (/^[0-9a-f]{40}$/.test(from)) sha = from;
    else die(`branch create: could not resolve ref '${from}'`);
  }

  try {
    await api.post(`/repos/${repo}/git/refs`, {
      body: { ref: `refs/heads/${branchName}`, sha },
    });
    console.log(sym('success') + ' Created branch ' + c.cyan(branchName) + ' from ' + c.gray(sha.slice(0, 7)) + ' in ' + repo);
  } catch (e) { fail('branch create', e); }
}

// ─── branch delete ───────────────────────────────────────────────────────────

async function branchDelete(args) {
  if (!args[0]) die('branch delete: branch name required');
  const branchName = args[0];
  const repo = await resolveRepo(args[1]);
  try {
    await api.delete(`/repos/${repo}/git/refs/heads/${branchName}`);
    console.log(sym('success') + ' Deleted branch ' + c.cyan(branchName) + ' from ' + repo);
  } catch (e) { fail('branch delete', e); }
}

// ─── content put ─────────────────────────────────────────────────────────────

async function contentPut(args) {
  const usage = 'usage: gh content put <path> <local-file> <message> [--branch=<branch>] [repo]';
  let branch = null;
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--branch=')) branch = a.slice(9).trim();
    else positional.push(a);
  }
  if (!positional[0]) die('content put: file path required\n' + usage);
  if (!positional[1]) die('content put: local file required\n' + usage);
  if (!positional[2]) die('content put: commit message required\n' + usage);
  const [filePath, localFile, message] = positional;
  const repo = await resolveRepo(positional[3]);

  // Read local file as raw bytes and base64-encode (byte-faithful — see
  // references/gotchas.md: fs.promises.readFile(path, 'utf8') + TextEncoder
  // re-encode would double-encode non-ASCII bytes. readFileBinary gives us
  // the real on-disk Uint8Array.)
  let content;
  try {
    const bytes = await fs.promises.readFileBinary(localFile);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    content = btoa(binary);
  } catch (e) { die('content put: could not read local file: ' + e.message); }

  // Check if file exists (to get SHA for update) — expects 404 if not found
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  let sha = null;
  try {
    const params = branch ? { ref: branch } : {};
    const existing = await api.get(`/repos/${repo}/contents/${encodedPath}`, { params });
    sha = existing.sha;
  } catch {}

  const payload = { message, content };
  if (branch) payload.branch = branch;
  if (sha) payload.sha = sha;

  try {
    const res = await api.put(`/repos/${repo}/contents/${encodedPath}`, { body: payload });
    const verb = sha ? 'Updated' : 'Created';
    console.log(sym('success') + ' ' + verb + ' ' + c.cyan(filePath) + ' — ' + c.gray(res.commit.sha.slice(0, 7)));
  } catch (e) { fail('content put', e); }
}

// ─── api (raw passthrough) ───────────────────────────────────────────────────

async function apiPassthrough(args) {
  const usage = 'usage: gh api <path> [-X METHOD] [--field key=value]... [--jq <expr>]';
  if (!args[0]) die(usage);
  let method = 'GET', jqExpr = null;
  const fields = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-X' && args[i+1]) { method = args[++i].toUpperCase(); }
    else if (args[i] === '--jq' && args[i+1]) { jqExpr = args[++i]; }
    else if ((args[i] === '-f' || args[i] === '--field') && args[i+1]) {
      const [k, ...vParts] = args[++i].split('=');
      fields[k] = vParts.join('=');
    }
    else positional.push(args[i]);
  }

  const path = positional[0];

  try {
    const opts = {};
    if (method !== 'GET' && Object.keys(fields).length) {
      opts.body = fields;
    }

    let result;
    switch (method) {
      case 'GET':    result = await api.get(path, opts); break;
      case 'POST':   result = await api.post(path, opts); break;
      case 'PUT':    result = await api.put(path, opts); break;
      case 'PATCH':  result = await api.patch(path, opts); break;
      case 'DELETE': result = await api.delete(path, opts); break;
      default:       result = await api.get(path, opts); break;
    }

    if (jqExpr && typeof result === 'object') {
      // Simple jq: support .key and .key.subkey
      const keys = jqExpr.replace(/^\./, '').split('.');
      let val = result;
      for (const k of keys) { val = val?.[k]; }
      console.log(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
    } else {
      out(result);
    }
  } catch (e) { fail('api ' + path, e); }
}

// ─── help ────────────────────────────────────────────────────────────────────

function showHelp() {
  help(`${c.bold('gh.jsh')} — GitHub CLI for SLICC agents

${c.bold('USAGE')}
  gh <command> <subcommand> [args] [owner/repo]

${c.bold('COMMANDS')}
  ${c.cyan('pr list')}       [repo]                       List open pull requests
  ${c.cyan('pr view')}       <num> [repo]                 View PR details and checks
  ${c.cyan('pr create')}     <title> <body> <head> [--base=<base>] [--draft] [repo]  Open a PR
  ${c.cyan('pr merge')}      <num> [--squash|--rebase] [repo]  Merge a PR
  ${c.cyan('pr close')}      <num> [repo]                 Close a PR without merging
  ${c.cyan('pr comment')}    <num> <message> [repo]       Post a comment
  ${c.cyan('pr checkout')}   <num> [repo]                 Print checkout commands
  ${c.cyan('issue list')}    [repo]                       List open issues
  ${c.cyan('issue view')}    <num> [repo]                 View issue details
  ${c.cyan('issue create')}  <title> <body> [--label=L]... [--labels=a,b] [repo]  Create issue
  ${c.cyan('repo view')}     [repo]                       Show repository info
  ${c.cyan('run list')}      [repo]                       List recent workflow runs
  ${c.cyan('run view')}      <run_id> [repo]              View run details and jobs
  ${c.cyan('release list')}  [repo]                       List recent releases
  ${c.cyan('search prs')}    <query> [repo]               Search PRs by keyword
  ${c.cyan('vars list')}     [repo]                       List Actions variables
  ${c.cyan('vars set')}      <name> <value> [repo]        Set an Actions variable
  ${c.cyan('repo archive')}  [repo]                       Archive a repository
  ${c.cyan('branch create')} <name> [--from=<ref>] [repo]  Create a branch
  ${c.cyan('branch delete')} <name> [repo]                 Delete a branch
  ${c.cyan('content put')}   <path> <local-file> <msg> [--branch=<b>] [repo]  Create/update a file
  ${c.cyan('api')}           <path> [-X METHOD] [-f key=val]... [--jq <expr>]  Raw API call
  ${c.cyan('notifications list')}  [--all] [-p] [--repo=r] [-nN]  List notifications
  ${c.cyan('notifications read')}  [--repo=r]              Mark notifications as read
  ${c.cyan('monday')}            [--limit N] [--date Nd]    Monday protocol inbox (JSON)

${c.bold('AUTH')}
  Uses process.env.GITHUB_TOKEN — populated automatically by the SLICC
  environment. If unset, run:
  oauth-token github                          # obtain a fresh token

${c.bold('REPO')}
  Defaults to current git remote origin. Pass owner/repo to override.`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd  = argv[0];
const sub  = argv[1];
const rest = argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  showHelp();
}

if (cmd === 'auth') { await authStatus(); process.exit(0); }
if (cmd === 'api') { await apiPassthrough(argv.slice(1)); process.exit(0); }
if (cmd === 'monday') { await mondayGh(argv.slice(2)); process.exit(0); }

const dispatch = {
  pr:      { list: () => prList(rest),      view: () => prView(rest),    merge: () => prMerge(rest), close: () => prClose(rest), comment: () => prComment(rest), checkout: () => prCheckout(rest), create: () => prCreate(rest) },
  issue:   { list: () => issueList(rest),   view: () => issueView(rest), create: () => issueCreate(rest) },
  repo:    { view: () => repoView(rest), archive: () => repoArchive(rest) },
  branch:  { create: () => branchCreate(rest), delete: () => branchDelete(rest) },
  content: { put: () => contentPut(rest) },
  run:     { list: () => runList(rest),     view: () => runView(rest) },
  release: { list: () => releaseList(rest) },
  search:  { prs:  () => searchPrs(rest) },
  vars:    { list: () => varsList(rest),    set:  () => varsSet(rest) },
  notifications: { list: () => notificationsList(rest), read: () => notificationsRead(rest) },
};

if (!dispatch[cmd]) die("unknown command: '" + cmd + "'. Run gh --help for usage.");
if (!sub || !dispatch[cmd][sub]) die("unknown subcommand: '" + cmd + ' ' + (sub || '') + "'. Run gh --help for usage.");

try {
  await dispatch[cmd][sub]();
} catch (err) {
  if (err.name === 'NodeExitError') throw err; // re-throw exit signals
  die(cmd + ' ' + sub + ' failed: ' + (err.body?.message || err.message), { prefix: 'gh' });
}
