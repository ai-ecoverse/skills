// gh.jsh — GitHub CLI for SLICC agents (ported to jsh runtime extensions, PR #786)
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
// │ FIX — explicit sliccy: module imports (this PR)                            │
// │                                                                             │
// │ The `.jsh` runtime no longer injects `skill`, `cli`, `fmt`, `c`, `http`,    │
// │ `exec`, `time`, `pool` as bare globals. They still exist and work exactly  │
// │ as before — they now must be obtained explicitly via                       │
// │ `require('sliccy:<name>')`. This script's logic is unchanged; only the     │
// │ following was needed:                                                      │
// │  • Added explicit imports at the top of the file:                          │
// │      const skill = require('sliccy:skill');                               │
// │      const cli   = require('sliccy:cli');                                  │
// │      const fmt   = require('sliccy:fmt');                                  │
// │      const color = require('sliccy:color');  // see rename below           │
// │      const http  = require('sliccy:http');                                 │
// │      const exec  = require('sliccy:exec');                                 │
// │      const time  = require('sliccy:time');   // only used by `monday`      │
// │      const fs    = require('fs');             // plain node-ish builtin,   │
// │                                                //  NOT a sliccy: module    │
// │    (`pool` is not used anywhere in this script, so it was not imported.)   │
// │  • RENAME: the old bare `c` global is now `require('sliccy:color')`, not   │
// │    `sliccy:c` — every `color.xxx(...)` call site was renamed to `color.xxx(...)│
// │    ` accordingly. This is the one change that touches call sites; every    │
// │    other API (`cli.*`, `fmt.*`, `http.*`, `skill.*`, `time.*`, `exec()`)    │
// │    keeps its exact old method names/signatures — no other call sites       │
// │    changed.                                                                 │
// │  • `process.argv.parseFlags()` is genuinely gone (confirmed, no sliccy:    │
// │    replacement) — added a small local `parseFlags()` helper reproducing    │
// │    its documented behavior (positional/flags/subcommand/passthrough,       │
// │    --flag=val, --flag val, -x boolean, repeated-flag-promotes-to-array,    │
// │    -- passthrough). Not currently wired into this script's own routing     │
// │    (which stays manual two-level cmd/sub dispatch, same as before), kept   │
// │    for parity since parseFlags() was part of the API surface referenced    │
// │    in the migration notes above.                                          │
// │  • `skill.token('github')` and `exec('git remote get-url origin ...')`     │
// │    both work correctly again now that they're properly required — no      │
// │    change needed to the token-resolution or repo-inference logic itself.  │
// ├─────────────────────────────────────────────────────────────────────────────┤
// │ FOLLOW-UP (this commit) — real fixes found while triaging stale           │
// │ Copilot review comments anchored to earlier, superseded commits:          │
// │                                                                             │
// │  • The Copilot comments themselves were stale (anchored to commits        │
// │    before the sliccy:* correction above and describing code that no       │
// │    longer exists — no local `colorsEnabled`/`process.stdout.isTTY` check,  │
// │    no `process.env.GITHUB_TOKEN`-centric error message, no `.git/config`  │
// │    file-parsing). But re-checking the underlying instincts against the    │
// │    CURRENT code surfaced two real, distinct issues, fixed here:            │
// │  • Missing-token path: previously `personalToken` could silently end up   │
// │    `''` if `skill.token('github')` throws AND `git config github.token`   │
// │    is empty AND `GITHUB_TOKEN` is unset — the failure only surfaced       │
// │    later as an opaque HTTP 401 from `fail()`. Added an explicit upfront   │
// │    `cli.die()` with an actionable message covering all three fallbacks.   │
// │  • Repo inference (`inferRepo()`): `exec('git remote get-url origin')`    │
// │    does not reliably resolve in this sandbox's git wrapper (observed to   │
// │    echo back the literal argument instead of the configured URL) and,    │
// │    like most git subcommands here, only behaves correctly when cwd is     │
// │    exactly the repo root — it does not walk up to find `.git` the way     │
// │    real git normally does. Fixed by resolving the repo root explicitly    │
// │    via `git rev-parse --show-toplevel` (confirmed to walk up parent       │
// │    directories correctly) and then reading the origin URL from that       │
// │    root specifically via `git -C <root> config --get remote.origin.url`   │
// │    (confirmed origin-specific and subdirectory-safe). This limitation     │
// │    pre-dates this PR — the same `git remote get-url origin` call is       │
// │    present unchanged on `main` today — so this is a genuine improvement,  │
// │    not a regression fix.                                                  │
// └─────────────────────────────────────────────────────────────────────────────┘

const skill = require('sliccy:skill');
const cli = require('sliccy:cli');
const fmt = require('sliccy:fmt');
const color = require('sliccy:color'); // renamed from bare `c` global
const http = require('sliccy:http');
const exec = require('sliccy:exec');
const time = require('sliccy:time'); // only used by `monday`
const fs = require('fs'); // plain node-ish builtin, not a sliccy: module

// ─── Flag parsing (process.argv.parseFlags() no longer exists) ──────────────
// Local reimplementation of the documented old behavior. Not wired into this
// script's own routing (still manual two-level cmd/sub dispatch below), kept
// for parity with the old API surface referenced in the migration notes.

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

let personalToken;
try {
  personalToken = await skill.token('github');
} catch {
  // Fallback to legacy methods
  const _tokenResult = await exec('git config github.token 2>/dev/null');
  personalToken = _tokenResult.stdout.trim() || process.env.GITHUB_TOKEN || '';
}

if (!personalToken) {
  cli.die(
    "No GitHub token available. skill.token('github') failed, `git config github.token` is unset, " +
    'and GITHUB_TOKEN is not set in the environment. Run `oauth-token github` to obtain a token, then ' +
    'either let skill.token(\'github\') pick it up automatically or set it explicitly with ' +
    '`export GITHUB_TOKEN="$(oauth-token github)"` or `git config github.token "$(oauth-token github)"`.',
    { prefix: 'gh' }
  );
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
    const cached = (await fs.readFile(BOT_CACHE)).trim();
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
        await fs.writeFile(BOT_CACHE, result.access_token);
        console.error(`✓ Authenticated — actions will appear as you via as-a-bot.\n`);
        return result.access_token;
      }
      if (result.error && result.error !== 'authorization_pending' && result.error !== 'slow_down') break;
    } catch { break; }
  }
  return personalToken; // timed out, fall back
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────
// Single client with context-aware token (req.method available since fix c4411949)

const api = http.client({
  baseUrl: 'https://api.github.com',
  token: (req) => {
    if (isAI && req && req.method !== 'GET') return getAttributedToken();
    return personalToken;
  },
  headers: {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  retry: { on: [429, 503], maxAttempts: 3 },
  timeoutMs: 30000,
});

// ─── Symbols ─────────────────────────────────────────────────────────────────

const SYM = {
  success:     color.green('✓'),
  failure:     color.red('✗'),
  timed_out:   color.red('✗'),
  action_required: color.red('✗'),
  pending:     color.yellow('●'),
  in_progress: color.yellow('●'),
  queued:      color.yellow('●'),
  waiting:     color.yellow('●'),
  skipped:     color.gray('○'),
  draft:       color.gray('○'),
  cancelled:   color.gray('○'),
  neutral:     color.gray('○'),
  open:        color.green('✓'),
  closed:      color.red('✗'),
  merged:      color.green('✓'),
  stale:       color.gray('○'),
};

function sym(s) { return SYM[s] || color.gray('?'); }

// ─── Repo inference ───────────────────────────────────────────────────────────

async function inferRepo() {
  // `git remote get-url origin` doesn't reliably resolve in this sandbox's
  // git wrapper (it can echo back the literal argument instead of the
  // configured URL) and, like most git subcommands run without `-C`, only
  // works when cwd is exactly the repo root. Resolve the repo root
  // explicitly first (git walks up parent directories for this on its own),
  // then read the origin URL from that root with `git -C <root> config`,
  // which is both origin-specific and subdirectory-safe.
  const top = await exec('git rev-parse --show-toplevel 2>/dev/null');
  if (top.exitCode !== 0 || !top.stdout.trim()) return null;
  const toplevel = top.stdout.trim();
  const r = await exec(`git -C "${toplevel}" config --get remote.origin.url 2>/dev/null`);
  if (r.exitCode !== 0 || !r.stdout.trim()) return null;
  const match = r.stdout.trim().match(/github\.com[:/]([^/\s]+\/[^/\s.]+)/);
  return match ? match[1].replace(/\.git$/, '') : null;
}

async function resolveRepo(arg) {
  if (arg && arg.includes('/')) return validateRepo(arg);
  const inferred = await inferRepo();
  if (inferred) return inferred;
  cli.die('No repo specified and could not infer from git remote. Pass owner/repo explicitly.');
}

// ─── Input validation ────────────────────────────────────────────────────────

function validateNum(val, name) {
  const n = parseInt(val, 10);
  if (!val || isNaN(n) || n <= 0 || String(n) !== String(val).trim()) {
    cli.die(`Invalid ${name}: must be a positive integer (got: ${JSON.stringify(val)})`);
  }
  return n;
}

function validateRepo(val) {
  if (!val) return val;
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(val)) {
    cli.die(`Invalid repo format: expected owner/repo with alphanumeric, hyphens, dots (got: ${JSON.stringify(val)})`);
  }
  return val;
}

function validateVarName(val) {
  if (!val || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(val)) {
    cli.die(`Invalid variable name: must match [a-zA-Z_][a-zA-Z0-9_]* (got: ${JSON.stringify(val)})`);
  }
  return val;
}

function sanitizeBranch(branch) {
  const safe = branch.replace(/[^a-zA-Z0-9/_.\-]/g, '_');
  if (safe !== branch) {
    cli.warn('Branch name contained unsafe characters — sanitized for display');
  }
  return safe;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmtDate(s) {
  if (!s) return '';
  return fmt.date(s, 'locale');
}

// ─── Error helper ────────────────────────────────────────────────────────────

function fail(cmd, err) {
  cli.die(cmd + ' failed: ' + (err.body?.message || err.message), { prefix: 'gh' });
}

// ─── pr list ─────────────────────────────────────────────────────────────────

async function prList(args) {
  const repo = await resolveRepo(args[0]);
  let prs;
  try { prs = await api.get(`/repos/${repo}/pulls`, { params: { state: 'open', per_page: 30 } }); }
  catch (e) { fail('pr list', e); }

  if (!prs.length) { console.log(color.gray('No open pull requests.')); return; }

  const rows = prs.map(pr => [
    color.cyan('#' + pr.number),
    fmt.trunc(pr.title, 52),
    color.gray(fmt.trunc(pr.head.ref, 36)),
    pr.draft ? color.green('open') + '  ' + color.yellow('[DRAFT]') : color.green('open'),
  ]);
  console.log(fmt.table(rows, [6, 54, 38]));
}

// ─── pr view ─────────────────────────────────────────────────────────────────

async function prView(args) {
  if (!args[0]) cli.die('pr view: PR number required');
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  let pr, checks;
  try { pr = await api.get(`/repos/${repo}/pulls/${num}`); }
  catch (e) { fail('pr view', e); }
  try { checks = await api.get(`/repos/${repo}/commits/${pr.head.sha}/check-runs`, { params: { per_page: 30 } }); }
  catch { checks = { check_runs: [] }; }

  const statusStr = pr.merged ? sym('merged') + ' ' + color.green('merged')
    : pr.draft ? sym('draft') + ' ' + color.gray('draft')
    : sym(pr.state) + ' ' + (pr.state === 'open' ? color.green('open') : color.red('closed'));

  console.log(color.bold(pr.title) + '  ' + statusStr);
  console.log(color.gray('Author:') + '  ' + pr.user.login);
  console.log(color.gray('Branch:') + '  ' + pr.head.ref + ' → ' + pr.base.ref);
  console.log(color.gray('URL:') + '     ' + pr.html_url);

  const runs = (checks.check_runs || []);
  if (runs.length) {
    const passed  = runs.filter(r => r.conclusion === 'success').length;
    const failed  = runs.filter(r => r.conclusion === 'failure' || r.conclusion === 'timed_out').length;
    const pending = runs.filter(r => !r.conclusion || r.status === 'in_progress' || r.status === 'queued').length;
    const parts = [
      passed  ? color.green(passed + ' passed')   : null,
      failed  ? color.red(failed + ' failed')     : null,
      pending ? color.yellow(pending + ' pending') : null,
    ].filter(Boolean);
    if (parts.length) console.log(color.gray('Checks:') + '  ' + parts.join('  '));
  }

  if (pr.body) {
    console.log('\n' + color.gray('Body:'));
    console.log(fmt.trunc(pr.body.replace(/\r?\n/g, ' '), 400));
  }
}

// ─── pr merge ────────────────────────────────────────────────────────────────

async function prMerge(args) {
  if (!args[0]) cli.die('pr merge: PR number required');
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
    console.log(sym('merged') + ' ' + color.green('Merged') + ' PR #' + num + ' via ' + method + (res.message ? ' — ' + res.message : ''));
  } catch (e) { fail('pr merge', e); }
}

// ─── pr comment ──────────────────────────────────────────────────────────────

async function prComment(args) {
  if (!args[0]) cli.die('pr comment: PR number required');
  const num = validateNum(args[0], 'PR number');
  if (!args[1]) cli.die('pr comment: message required');
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
  if (!positional[0]) cli.die('pr create: title required\n' + usage);
  if (positional[1] === undefined) cli.die('pr create: body required\n' + usage);
  if (!positional[2]) cli.die('pr create: head branch required\n' + usage);
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
    console.log(sym('success') + ' Created PR ' + color.cyan('#' + res.number) + ': ' + res.title);
    console.log(color.gray('Branch:') + '  ' + res.head.ref + ' → ' + res.base.ref);
    console.log(color.gray('URL:') + '     ' + res.html_url);
    console.log(color.gray('TIP:') + '    run `gh pr watch ' + res.number + '` to get live updates in this scoop as the PR changes.');
  } catch (e) { fail('pr create', e); }
}

// ─── pr checkout ─────────────────────────────────────────────────────────────

async function prCheckout(args) {
  if (!args[0]) cli.die('pr checkout: PR number required');
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  let pr;
  try { pr = await api.get(`/repos/${repo}/pulls/${num}`); }
  catch (e) { fail('pr checkout', e); }

  const branch = sanitizeBranch(pr.head.ref);
  const remoteUrl = pr.head.repo ? pr.head.repo.clone_url : `https://github.com/${repo}.git`;
  console.log(color.gray('# Run these commands to check out this PR:'));
  console.log('git fetch ' + remoteUrl + ' ' + branch);
  console.log('git checkout -b ' + branch + ' FETCH_HEAD');
}

// ─── pr watch / unwatch ──────────────────────────────────────────────────────
// Wires up a live GitHub repo webhook (POST /repos/<owner>/<repo>/hooks) that
// fires PR lifecycle events straight to the calling scoop as licks, via a
// SLICC `webhook create` endpoint. This automates the recipe documented in
// references/webhook-pr-monitoring.md — see that file for the manual
// equivalent, the self-echo-detection pattern a scoop needs when watching
// its own PR, and the (designed-but-not-yet-observed-live) stop condition
// this command's `unwatch` half is meant to satisfy.

const WATCH_EVENTS = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'check_run',
  'check_suite',
  'status',
];

function watchHookName(repo, num) {
  return 'pr-' + repo.replace('/', '-') + '-' + num + '-watch';
}

// Parses the structured stdout of `webhook create` ("Created webhook ...",
// "ID:  <id>", "URL: <url>", "Scoop: <name>") into { id, url }. Not JSON —
// this is the actual shell command's plain-text output format.
function parseWebhookCreateOutput(stdout) {
  const idMatch = stdout.match(/^ID:\s*(\S+)/m);
  const urlMatch = stdout.match(/^URL:\s*(\S+)/m);
  return {
    id: idMatch ? idMatch[1] : null,
    url: urlMatch ? urlMatch[1] : null,
  };
}

async function findExistingWatchWebhook(name) {
  let listResult;
  try { listResult = await exec('webhook list'); }
  catch (e) { cli.die('pr watch: could not query existing webhooks: ' + e.message); }
  if (listResult.exitCode !== 0) return null;
  const line = listResult.stdout.split('\n').find(l => l.includes(name));
  if (!line) return null;
  const idMatch = line.trim().match(/^(\S+)/);
  return idMatch ? idMatch[1] : null;
}

async function prWatch(args) {
  const usage = 'usage: gh pr watch <num> [--filter <js>] [--scoop <name>] [repo]';
  if (!args[0]) cli.die('pr watch: PR number required\n' + usage);
  const num = validateNum(args[0], 'PR number');
  let filter = null, scoopName = process.env.SLICC_SCOOP || null;
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--filter' && args[i + 1]) { filter = args[++i]; }
    else if (args[i] === '--scoop' && args[i + 1]) { scoopName = args[++i]; }
    else positional.push(args[i]);
  }
  const repo = await resolveRepo(positional[0]);

  if (!scoopName) {
    cli.die(
      'pr watch: no scoop specified and none could be inferred from the environment. ' +
      'Pass --scoop <name> explicitly (the name of the scoop that should receive PR update licks).'
    );
  }

  const hookName = watchHookName(repo, num);

  const existingId = await findExistingWatchWebhook(hookName);
  if (existingId) {
    console.log(sym('success') + ' Already watching PR ' + color.cyan('#' + num) + ' in ' + repo + ' (webhook ' + color.gray(existingId) + '). Nothing to do.');
    return;
  }

  // 1. Create the SLICC-side webhook endpoint.
  const createCmd = filter
    ? `webhook create --scoop ${scoopName} --name ${hookName} --filter ${JSON.stringify(filter)}`
    : `webhook create --scoop ${scoopName} --name ${hookName}`;
  let createResult;
  try { createResult = await exec(createCmd); }
  catch (e) { cli.die('pr watch: failed to create SLICC webhook: ' + e.message); }
  if (createResult.exitCode !== 0) {
    cli.die('pr watch: `webhook create` failed: ' + (createResult.stderr || createResult.stdout).trim());
  }
  const { id: webhookId, url: webhookUrl } = parseWebhookCreateOutput(createResult.stdout);
  if (!webhookId || !webhookUrl) {
    cli.die('pr watch: could not parse `webhook create` output — got:\n' + createResult.stdout);
  }

  // 2. Register that URL as a real GitHub repo webhook.
  let hook;
  try {
    hook = await api.post(`/repos/${repo}/hooks`, {
      body: {
        name: 'web',
        active: true,
        events: WATCH_EVENTS,
        config: { url: webhookUrl, content_type: 'json' },
      },
    });
  } catch (e) {
    // Best-effort cleanup of the SLICC-side webhook if the GitHub-side
    // registration failed, so we don't leave an orphaned watcher behind.
    try { await exec(`webhook delete ${webhookId}`); } catch {}
    fail('pr watch', e);
  }

  console.log(sym('success') + ' Watching PR ' + color.cyan('#' + num) + ' in ' + repo);
  console.log(color.gray('SLICC webhook:  ') + webhookId + ' (' + hookName + ') → ' + scoopName);
  console.log(color.gray('GitHub hook:    ') + hook.id);
  console.log(color.gray('Events:         ') + WATCH_EVENTS.join(', '));
  console.log(color.gray('Stop watching:  ') + 'gh pr unwatch ' + num + ' ' + repo);
}

async function prUnwatch(args) {
  const usage = 'usage: gh pr unwatch <num> [repo]';
  if (!args[0]) cli.die('pr unwatch: PR number required\n' + usage);
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  const hookName = watchHookName(repo, num);

  const webhookId = await findExistingWatchWebhook(hookName);
  if (!webhookId) {
    console.log(color.gray('Not watching PR ' + '#' + num + ' in ' + repo + ' — nothing to tear down.'));
    return;
  }

  // Find the GitHub-side hook whose config.url matches this SLICC webhook,
  // so we can remove it too and avoid leaving a dangling registration on
  // the real repo (see automation/SKILL.md's "Don't leave watchers/webhooks
  // orphaned" rule).
  let ghHookId = null;
  try {
    const hooks = await api.get(`/repos/${repo}/hooks`);
    const match = hooks.find(h => h.config && h.config.url && h.config.url.includes('/' + webhookId));
    if (match) ghHookId = match.id;
  } catch {}

  if (ghHookId) {
    try { await api.delete(`/repos/${repo}/hooks/${ghHookId}`); }
    catch (e) { cli.warn('pr unwatch: could not remove GitHub-side hook ' + ghHookId + ': ' + (e.body?.message || e.message)); }
  }

  try { await exec(`webhook delete ${webhookId}`); }
  catch (e) { cli.die('pr unwatch: failed to delete SLICC webhook ' + webhookId + ': ' + e.message); }

  console.log(sym('success') + ' Stopped watching PR ' + color.cyan('#' + num) + ' in ' + repo);
  console.log(color.gray('Removed SLICC webhook:  ') + webhookId);
  console.log(color.gray('Removed GitHub hook:    ') + (ghHookId || color.gray('(none found)')));
}

// ─── pr close ────────────────────────────────────────────────────────────────

async function prClose(args) {
  if (!args[0]) cli.die('pr close: PR number required');
  const num = validateNum(args[0], 'PR number');
  const repo = await resolveRepo(args[1]);
  try {
    const res = await api.patch(`/repos/${repo}/pulls/${num}`, {
      body: { state: 'closed' },
    });
    console.log(sym('closed') + ' Closed PR ' + color.cyan('#' + num) + ': ' + res.title);
    console.log(color.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('pr close', e); }
}

// ─── issue list ──────────────────────────────────────────────────────────────

async function issueList(args) {
  const repo = await resolveRepo(args[0]);
  let issues;
  try { issues = await api.get(`/repos/${repo}/issues`, { params: { state: 'open', per_page: 30 } }); }
  catch (e) { fail('issue list', e); }

  const filtered = issues.filter(i => !i.pull_request);
  if (!filtered.length) { console.log(color.gray('No open issues.')); return; }

  const rows = filtered.map(i => [
    color.cyan('#' + i.number),
    fmt.trunc(i.title, 60),
    i.labels.map(l => color.yellow(l.name)).join(', '),
  ]);
  console.log(fmt.table(rows, [6, 62]));
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
  if (!positional[0]) cli.die('issue create: title required\n' + usage);
  if (positional[1] === undefined) cli.die('issue create: body required\n' + usage);
  const [title, body] = positional;
  const repo = await resolveRepo(positional[2]);

  const payload = { title, body };
  if (labelSet.size) payload.labels = [...labelSet];

  try {
    const res = await api.post(`/repos/${repo}/issues`, { body: payload });
    console.log(sym('success') + ' Created issue ' + color.cyan('#' + res.number) + ' — ' + res.html_url);
  } catch (e) { fail('issue create', e); }
}

// ─── issue view ──────────────────────────────────────────────────────────────

async function issueView(args) {
  if (!args[0]) cli.die('issue view: issue number required');
  const num = validateNum(args[0], 'issue number');
  const repo = await resolveRepo(args[1]);
  let issue;
  try { issue = await api.get(`/repos/${repo}/issues/${num}`); }
  catch (e) { fail('issue view', e); }

  const stateStr = issue.state === 'open' ? color.green('open') : color.red('closed');
  console.log(color.bold(issue.title) + '  ' + sym(issue.state) + ' ' + stateStr);
  console.log(color.gray('Author:') + '  ' + issue.user.login);
  console.log(color.gray('URL:') + '     ' + issue.html_url);
  if (issue.labels.length) console.log(color.gray('Labels:') + '  ' + issue.labels.map(l => color.yellow(l.name)).join(', '));
  if (issue.body) {
    console.log('\n' + color.gray('Body:'));
    console.log(fmt.trunc(issue.body.replace(/\r?\n/g, ' '), 400));
  }
}

// ─── issue comment ───────────────────────────────────────────────────────────

async function issueComment(args) {
  if (!args[0]) cli.die('issue comment: issue number required');
  const num = validateNum(args[0], 'issue number');
  if (!args[1]) cli.die('issue comment: message required');
  const repo = await resolveRepo(args[2]);
  try {
    const res = await api.post(`/repos/${repo}/issues/${num}/comments`, {
      body: { body: args[1] },
    });
    console.log(sym('success') + ' Comment posted: ' + res.html_url);
  } catch (e) { fail('issue comment', e); }
}

// ─── issue close ─────────────────────────────────────────────────────────────

async function issueClose(args) {
  let reason = null;
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--reason=')) reason = a.slice(9).trim();
    else positional.push(a);
  }
  if (!positional[0]) cli.die('issue close: issue number required');
  const num = validateNum(positional[0], 'issue number');
  const repo = await resolveRepo(positional[1]);
  try {
    const res = await api.patch(`/repos/${repo}/issues/${num}`, {
      body: { state: 'closed', ...(reason ? { state_reason: reason } : {}) },
    });
    console.log(sym('closed') + ' Closed issue ' + color.cyan('#' + num) + ': ' + res.title);
    console.log(color.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('issue close', e); }
}

// ─── issue edit ──────────────────────────────────────────────────────────────

async function issueEdit(args) {
  const usage = 'usage: gh issue edit <num> [--title=T] [--body=B] [--label=L]... [--labels=a,b] [--state=open|closed] [repo]';
  let title = null, body = null, state = null;
  const labelSet = new Set();
  let haveLabels = false;
  const positional = [];
  for (const a of args) {
    if (a.startsWith('--title=')) title = a.slice(8);
    else if (a.startsWith('--body=')) body = a.slice(7);
    else if (a.startsWith('--state=')) state = a.slice(8).trim();
    else if (a.startsWith('--label=')) {
      const v = a.slice(8).trim();
      if (v) labelSet.add(v);
      haveLabels = true;
    } else if (a.startsWith('--labels=')) {
      for (const v of a.slice(9).split(',').map(s => s.trim()).filter(Boolean)) labelSet.add(v);
      haveLabels = true;
    } else positional.push(a);
  }
  if (!positional[0]) cli.die('issue edit: issue number required\n' + usage);
  const num = validateNum(positional[0], 'issue number');
  const repo = await resolveRepo(positional[1]);

  const payload = {};
  if (title !== null) payload.title = title;
  if (body !== null) payload.body = body;
  if (state !== null) payload.state = state;
  if (haveLabels) payload.labels = [...labelSet];
  if (!Object.keys(payload).length) cli.die('issue edit: nothing to update — pass --title, --body, --label(s), or --state\n' + usage);

  try {
    const res = await api.patch(`/repos/${repo}/issues/${num}`, { body: payload });
    console.log(sym('success') + ' Edited issue ' + color.cyan('#' + num) + ': ' + res.title);
    console.log(color.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('issue edit', e); }
}

// ─── repo view ───────────────────────────────────────────────────────────────

async function repoView(args) {
  const repo = await resolveRepo(args[0]);
  let r;
  try { r = await api.get(`/repos/${repo}`); }
  catch (e) { fail('repo view', e); }

  console.log(color.bold(r.full_name));
  if (r.description) console.log(r.description);
  console.log('');
  console.log(color.gray('Stars:          ') + color.yellow('★') + ' ' + r.stargazers_count);
  console.log(color.gray('Forks:          ') + r.forks_count);
  console.log(color.gray('Default branch: ') + r.default_branch);
  console.log(color.gray('Language:       ') + (r.language || 'unknown'));
  console.log(color.gray('Last push:      ') + fmtDate(r.pushed_at));
  if (r.topics && r.topics.length) console.log(color.gray('Topics:         ') + r.topics.join(', '));
  console.log(color.gray('URL:            ') + r.html_url);
}

// ─── run list ────────────────────────────────────────────────────────────────

async function runList(args) {
  const repo = await resolveRepo(args[0]);
  let runs;
  try {
    const data = await api.get(`/repos/${repo}/actions/runs`, { params: { per_page: 20 } });
    runs = data.workflow_runs;
  } catch (e) { fail('run list', e); }

  if (!runs || !runs.length) { console.log(color.gray('No workflow runs.')); return; }

  const rows = runs.map(run => {
    const statusStr = run.status === 'completed'
      ? sym(run.conclusion) + ' ' + (run.conclusion || 'unknown')
      : sym('in_progress') + ' ' + run.status;
    return [
      color.gray(String(run.id)),
      fmt.trunc(run.name, 36),
      statusStr,
      color.gray(fmt.trunc(run.head_branch, 28)),
      color.gray(fmtDate(run.created_at)),
    ];
  });
  console.log(fmt.table(rows, [14, 38, 22, 30]));
}

// ─── run view ────────────────────────────────────────────────────────────────

async function runView(args) {
  if (!args[0]) cli.die('run view: run ID required');
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

  console.log(color.bold(run.name) + '  ' + statusStr);
  console.log(color.gray('Branch:  ') + run.head_branch);
  const msg = run.head_commit && run.head_commit.message
    ? fmt.trunc(run.head_commit.message.split('\n')[0], 60) : '';
  console.log(color.gray('Commit:  ') + run.head_sha.slice(0, 7) + (msg ? ' — ' + msg : ''));
  console.log(color.gray('Started: ') + fmtDate(run.created_at));
  console.log(color.gray('URL:     ') + run.html_url);

  const jobs = jobsData.jobs || [];
  if (jobs.length) {
    console.log('\n' + color.bold('Jobs:'));
    for (const job of jobs) {
      const s = job.status === 'completed' ? sym(job.conclusion || 'neutral') : sym('in_progress');
      const dur = (job.completed_at && job.started_at)
        ? color.gray(' (' + Math.round((new Date(job.completed_at) - new Date(job.started_at)) / 1000) + 's)') : '';
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

  if (!releases.length) { console.log(color.gray('No releases.')); return; }

  const rows = releases.map(r => [
    color.cyan(fmt.trunc(r.tag_name, 24)),
    fmt.trunc(r.name || r.tag_name, 48) + (r.prerelease ? color.yellow(' [pre]') : '') + (r.draft ? color.gray(' [draft]') : ''),
    color.gray(fmtDate(r.published_at)),
  ]);
  console.log(fmt.table(rows, [26, 56]));
}

// ─── notifications list ───────────────────────────────────────────────────────

const NOTIF_TYPE_SYM = {
  PullRequest: color.cyan('PR'),
  Issue:       color.green('IS'),
  Release:     color.yellow('RL'),
  Commit:      color.gray('CM'),
  Discussion:  color.cyan('DS'),
  CheckSuite:  color.gray('CS'),
  RepositoryVulnerabilityAlert: color.red('VA'),
};

function notifTypeSym(t) { return NOTIF_TYPE_SYM[t] || color.gray(t.slice(0,2).toUpperCase()); }

const NOTIF_REASON_COLOR = {
  mention:       color.yellow,
  author:        color.cyan,
  comment:       color.gray,
  review_requested: color.yellow,
  assign:        color.cyan,
  subscribed:    color.gray,
  team_mention:  color.yellow,
  ci_activity:   color.gray,
  security_alert: color.red,
};

function reasonStr(r) {
  const fn = NOTIF_REASON_COLOR[r] || color.gray;
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

  if (!notifs.length) { console.log(color.gray('No notifications.')); return; }

  // Group by repo for readability
  const byRepo = {};
  for (const n of notifs) {
    const repo = n.repository.full_name;
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(n);
  }

  for (const [repo, items] of Object.entries(byRepo)) {
    console.log('\n' + color.bold(repo));
    for (const n of items) {
      const type   = notifTypeSym(n.subject.type);
      const title  = fmt.trunc(n.subject.title, 60);
      const reason = reasonStr(n.reason);
      const date   = color.gray(fmtDate(n.updated_at));
      const unread = n.unread ? color.yellow('•') : ' ';
      const numMatch = n.subject.url?.match(/\/(pulls|issues)\/(\d+)$/);
      const num = numMatch ? color.gray('#' + numMatch[2]) : '   ';
      console.log('  ' + unread + ' ' + type + ' ' + fmt.col(num, 7) + fmt.col(title, 62) + '  ' + fmt.col(reason, 18) + '  ' + date);
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
    console.log(sym('success') + ' Marked ' + (repoFilter ? color.cyan(repoFilter) : 'all') + ' notifications as read');
  } catch (e) { fail('notifications read', e); }
}

// ─── search prs ──────────────────────────────────────────────────────────────

async function searchPrs(args) {
  if (!args[0]) cli.die('search prs: query required');
  const repo = args[1] || await inferRepo();
  const q = args[0] + ' type:pr' + (repo ? ' repo:' + repo : '');
  let results;
  try {
    const data = await api.get('/search/issues', { params: { q, per_page: 20 } });
    results = data.items;
  } catch (e) { fail('search prs', e); }

  if (!results.length) { console.log(color.gray('No matching PRs.')); return; }

  const rows = results.map(item => [
    color.cyan('#' + item.number),
    fmt.trunc(item.title, 56),
    color.gray(item.repository_url.replace('https://api.github.com/repos/', '')),
    item.state === 'open' ? color.green('open') : color.red(item.state),
  ]);
  console.log(fmt.table(rows, [6, 58, 36]));
}

// ─── vars list ───────────────────────────────────────────────────────────────

async function varsList(args) {
  const repo = await resolveRepo(args[0]);
  let vars;
  try {
    const data = await api.get(`/repos/${repo}/actions/variables`, { params: { per_page: 30 } });
    vars = data.variables;
  } catch (e) { fail('vars list', e); }

  if (!vars || !vars.length) { console.log(color.gray('No variables.')); return; }

  const rows = vars.map(v => [color.cyan(fmt.trunc(v.name, 32)), fmt.trunc(v.value, 60)]);
  console.log(fmt.table(rows, [36]));
}

// ─── vars set ────────────────────────────────────────────────────────────────

async function varsSet(args) {
  if (!args[0]) cli.die('vars set: name required');
  if (args[1] === undefined) cli.die('vars set: value required');
  const repo = await resolveRepo(args[2]);
  const name = validateVarName(args[0]), value = args[1];

  // Check if variable exists (expecting 404 if not — http.client throws on non-2xx)
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
    console.log(sym('success') + ' Variable ' + color.cyan(name) + ' ' + (exists ? 'updated' : 'created'));
  } catch (e) { fail('vars set', e); }
}

// ─── auth status ─────────────────────────────────────────────────────────────

async function authStatus() {
  const preview = personalToken ? personalToken.slice(0, 8) + '…' : color.red('(not set)');
  let username = color.gray('(unverified)');
  if (personalToken) {
    try {
      const u = await api.get('/user');
      username = u.login;
    } catch { username = color.red('(invalid token)'); }
  }

  let botStatus = color.gray('not cached — will prompt on first write op');
  try {
    const cached = (await fs.readFile(BOT_CACHE)).trim();
    if (cached) {
      const check = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${cached}`, 'User-Agent': 'gh.jsh/1.0' }
      });
      if (check.ok) {
        const bu = await check.json();
        botStatus = color.green('valid') + ' — acting as ' + color.cyan(bu.login);
      } else {
        botStatus = color.yellow('cached but expired — will re-auth on next write op');
      }
    }
  } catch {}

  const writeList = Object.entries(WRITE_OPS)
    .flatMap(([k, vs]) => vs.map(v => `${k}:${v}`)).join(', ');

  console.log(color.bold('\nPersonal token'));
  console.log('  Source:  ' + color.gray('skill.token(github) / env / git config'));
  console.log('  Token:   ' + color.cyan(preview));
  console.log('  User:    ' + color.cyan(username));
  console.log(color.bold('\nAI attribution'));
  console.log('  Enabled: ' + (isAI ? color.green('yes') : color.gray('no (not running as AI agent)')));
  console.log('  Broker:  ' + color.gray(BROKER_URL));
  console.log('  Bot token: ' + botStatus);
  console.log(color.bold('\nWrite operations that trigger attribution:'));
  console.log('  ' + color.gray(writeList));
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

  // Use time.parseDuration for the date spec
  const sinceMs = time.parseDuration(dateSpec);
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
    console.log(sym('success') + ' Archived ' + color.cyan(repo));
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
  if (!positional[0]) cli.die('branch create: branch name required\n' + usage);
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
    else cli.die(`branch create: could not resolve ref '${from}'`);
  }

  try {
    await api.post(`/repos/${repo}/git/refs`, {
      body: { ref: `refs/heads/${branchName}`, sha },
    });
    console.log(sym('success') + ' Created branch ' + color.cyan(branchName) + ' from ' + color.gray(sha.slice(0, 7)) + ' in ' + repo);
  } catch (e) { fail('branch create', e); }
}

// ─── branch delete ───────────────────────────────────────────────────────────

async function branchDelete(args) {
  if (!args[0]) cli.die('branch delete: branch name required');
  const branchName = args[0];
  const repo = await resolveRepo(args[1]);
  try {
    await api.delete(`/repos/${repo}/git/refs/heads/${branchName}`);
    console.log(sym('success') + ' Deleted branch ' + color.cyan(branchName) + ' from ' + repo);
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
  if (!positional[0]) cli.die('content put: file path required\n' + usage);
  if (!positional[1]) cli.die('content put: local file required\n' + usage);
  if (!positional[2]) cli.die('content put: commit message required\n' + usage);
  const [filePath, localFile, message] = positional;
  const repo = await resolveRepo(positional[3]);

  // Read local file and base64-encode (unicode-safe)
  let content;
  try {
    const raw = await fs.readFile(localFile);
    const encoder = new TextEncoder();
    const bytes = encoder.encode(raw);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    content = btoa(binary);
  } catch (e) { cli.die('content put: could not read local file: ' + e.message); }

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
    console.log(sym('success') + ' ' + verb + ' ' + color.cyan(filePath) + ' — ' + color.gray(res.commit.sha.slice(0, 7)));
  } catch (e) { fail('content put', e); }
}

// ─── api (raw passthrough) ───────────────────────────────────────────────────

async function apiPassthrough(args) {
  const usage = 'usage: gh api <path> [-X METHOD] [--field key=value]... [--jq <expr>]';
  if (!args[0]) cli.die(usage);
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
      cli.out(result);
    }
  } catch (e) { fail('api ' + path, e); }
}

// ─── help ────────────────────────────────────────────────────────────────────

function showHelp() {
  cli.help(`${color.bold('gh.jsh')} — GitHub CLI for SLICC agents

${color.bold('USAGE')}
  gh <command> <subcommand> [args] [owner/repo]

${color.bold('COMMANDS')}
  ${color.cyan('pr list')}       [repo]                       List open pull requests
  ${color.cyan('pr view')}       <num> [repo]                 View PR details and checks
  ${color.cyan('pr create')}     <title> <body> <head> [--base=<base>] [--draft] [repo]  Open a PR
  ${color.cyan('pr merge')}      <num> [--squash|--rebase] [repo]  Merge a PR
  ${color.cyan('pr close')}      <num> [repo]                 Close a PR without merging
  ${color.cyan('pr comment')}    <num> <message> [repo]       Post a comment
  ${color.cyan('pr checkout')}   <num> [repo]                 Print checkout commands
  ${color.cyan('pr watch')}      <num> [--filter <js>] [--scoop <name>] [repo]  Watch a PR via webhook
  ${color.cyan('pr unwatch')}    <num> [repo]                 Stop watching a PR, tear down its webhook
  ${color.cyan('issue list')}    [repo]                       List open issues
  ${color.cyan('issue view')}    <num> [repo]                 View issue details
  ${color.cyan('issue create')}  <title> <body> [--label=L]... [--labels=a,b] [repo]  Create issue
  ${color.cyan('issue close')}   <num> [--reason=completed|not_planned] [repo]  Close an issue
  ${color.cyan('issue comment')} <num> <message> [repo]       Post a comment on an issue
  ${color.cyan('issue edit')}    <num> [--title=T] [--body=B] [--label=L]... [--labels=a,b] [--state=open|closed] [repo]  Edit an issue
  ${color.cyan('repo view')}     [repo]                       Show repository info
  ${color.cyan('run list')}      [repo]                       List recent workflow runs
  ${color.cyan('run view')}      <run_id> [repo]              View run details and jobs
  ${color.cyan('release list')}  [repo]                       List recent releases
  ${color.cyan('search prs')}    <query> [repo]               Search PRs by keyword
  ${color.cyan('vars list')}     [repo]                       List Actions variables
  ${color.cyan('vars set')}      <name> <value> [repo]        Set an Actions variable
  ${color.cyan('repo archive')}  [repo]                       Archive a repository
  ${color.cyan('branch create')} <name> [--from=<ref>] [repo]  Create a branch
  ${color.cyan('branch delete')} <name> [repo]                 Delete a branch
  ${color.cyan('content put')}   <path> <local-file> <msg> [--branch=<b>] [repo]  Create/update a file
  ${color.cyan('api')}           <path> [-X METHOD] [-f key=val]... [--jq <expr>]  Raw API call
  ${color.cyan('notifications list')}  [--all] [-p] [--repo=r] [-nN]  List notifications
  ${color.cyan('notifications read')}  [--repo=r]              Mark notifications as read
  ${color.cyan('monday')}            [--limit N] [--date Nd]    Monday protocol inbox (JSON)

${color.bold('AUTH')}
  Uses skill.token('github') (preferred), falls back to:
  git config github.token <PAT>               # persistent PAT
  exp${''}ort GITHUB_TOKEN=<PAT>                   # session PAT

${color.bold('REPO')}
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
  pr:      { list: () => prList(rest),      view: () => prView(rest),    merge: () => prMerge(rest), close: () => prClose(rest), comment: () => prComment(rest), checkout: () => prCheckout(rest), create: () => prCreate(rest), watch: () => prWatch(rest), unwatch: () => prUnwatch(rest) },
  issue:   { list: () => issueList(rest),   view: () => issueView(rest), create: () => issueCreate(rest), comment: () => issueComment(rest), close: () => issueClose(rest), edit: () => issueEdit(rest) },
  repo:    { view: () => repoView(rest), archive: () => repoArchive(rest) },
  branch:  { create: () => branchCreate(rest), delete: () => branchDelete(rest) },
  content: { put: () => contentPut(rest) },
  run:     { list: () => runList(rest),     view: () => runView(rest) },
  release: { list: () => releaseList(rest) },
  search:  { prs:  () => searchPrs(rest) },
  vars:    { list: () => varsList(rest),    set:  () => varsSet(rest) },
  notifications: { list: () => notificationsList(rest), read: () => notificationsRead(rest) },
};

if (!dispatch[cmd]) cli.die("unknown command: '" + cmd + "'. Run gh --help for usage.");
if (!sub || !dispatch[cmd][sub]) cli.die("unknown subcommand: '" + cmd + ' ' + (sub || '') + "'. Run gh --help for usage.");

try {
  await dispatch[cmd][sub]();
} catch (err) {
  if (err.name === 'NodeExitError') throw err; // re-throw exit signals
  cli.die(cmd + ' ' + sub + ' failed: ' + (err.body?.message || err.message), { prefix: 'gh' });
}
