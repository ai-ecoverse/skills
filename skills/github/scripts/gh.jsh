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
// │  • `process.argv.parseFlags()`: at migration time this looked gone, so a  │
// │    local parseFlags() copy was added "for parity". The runtime helper is  │
// │    back (attached non-enumerably to process.argv) and the local copy was  │
// │    never wired into this script's routing (still manual two-level         │
// │    cmd/sub dispatch, same as before), so the dead copy was removed.       │
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

// Single POSIX-shell-quote a value for safe interpolation into an exec()
// command line (exec runs through the jsh shell bridge).
function escapeShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

const exec = require('sliccy:exec');
const time = require('sliccy:time'); // only used by `monday`
const fs = require('fs'); // plain node-ish builtin, not a sliccy: module

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
  project:       ['add-draft', 'set-title'],
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
  const r = await exec(`git -C ${escapeShellArg(toplevel)} config --get remote.origin.url 2>/dev/null`);
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

// ─── Upstream-gh argument compatibility ──────────────────────────────────────
// SLICC is a harness for AI agents, and agents arrive with strong priors from
// the real GitHub CLI (cli/cli): named flags (`--title`, `-R owner/repo`),
// `--json f1,f2`, `--help` on every subcommand. Historically this script only
// accepted positional arguments, so intuitive commands failed.
//
// Everything below is ADDITIVE: each command accepts the upstream flag form
// AND the original positional form. Rules:
//  • a flag wins over the equivalent positional slot;
//  • the same value supplied twice is a hard error, never a silent pick;
//  • an unrecognised flag is passed through as a positional (with a warning),
//    exactly as it was before, so no previously-working invocation changes.

// Flag spec: { name: { type, short } } where type is one of
//   'string' — takes a value (`--title T`, `--title=T`)
//   'bool'   — no value (`--draft`, `--draft=false`)
//   'list'   — repeatable and/or comma-separated (`--label a --label b,c`)
//   'fields' — like 'string' but usable bare (`--json` == every field)
const REPO_FLAG = { repo: { type: 'string', short: 'R' } };
const JSON_FLAGS = { json: { type: 'fields' }, jq: { type: 'string', short: 'q' } };
const PROJECT_OWNER_FLAG = { owner: { type: 'string', short: 'o' } };

// Every command's flag spec lives here, keyed by the command label, so that the
// help interception at the bottom of the file can ask the SAME definitions
// whether a flag consumes the token after it. Hand-maintained lists of
// "boolean flags" drift; this cannot. `api` and `monday` keep their own
// hand-rolled parsers but still declare their flags here for that reason.
const FLAG_SPECS = {
  'pr list': {
    ...REPO_FLAG, ...JSON_FLAGS,
    state: { type: 'string', short: 's' },
    limit: { type: 'string', short: 'L' },
    base: { type: 'string', short: 'B' },
    head: { type: 'string', short: 'H' },
    draft: { type: 'bool', short: 'd' },
  },
  'pr view': {
    ...REPO_FLAG, ...JSON_FLAGS,
    comments: { type: 'bool', short: 'c' },
  },
  'pr checks': {
    ...REPO_FLAG, ...JSON_FLAGS,
    watch: { type: 'bool' },
    filter: { type: 'string' },
    scoop: { type: 'string' },
  },
  'pr merge': {
    ...REPO_FLAG,
    merge: { type: 'bool', short: 'm' },
    squash: { type: 'bool', short: 's' },
    rebase: { type: 'bool', short: 'r' },
    'delete-branch': { type: 'bool', short: 'd' },
    subject: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
  },
  'pr comment': {
    ...REPO_FLAG,
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
  },
  'pr create': {
    ...REPO_FLAG,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    head: { type: 'string', short: 'H' },
    base: { type: 'string', short: 'B' },
    draft: { type: 'bool', short: 'd' },
    label: { type: 'list', short: 'l' },
    labels: { type: 'list' },
    assignee: { type: 'list', short: 'a' },
    reviewer: { type: 'list', short: 'r' },
  },
  'pr checkout': { ...REPO_FLAG },
  'pr watch': {
    ...REPO_FLAG,
    filter: { type: 'string' },
    scoop: { type: 'string' },
  },
  'pr unwatch': { ...REPO_FLAG },
  'pr close': {
    ...REPO_FLAG,
    'delete-branch': { type: 'bool', short: 'd' },
    comment: { type: 'string', short: 'c' },
  },
  'issue list': {
    ...REPO_FLAG, ...JSON_FLAGS,
    state: { type: 'string', short: 's' },
    limit: { type: 'string', short: 'L' },
    label: { type: 'list', short: 'l' },
    labels: { type: 'list' },
    assignee: { type: 'string', short: 'a' },
    author: { type: 'string', short: 'A' },
    milestone: { type: 'string', short: 'm' },
  },
  'issue create': {
    ...REPO_FLAG,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    label: { type: 'list', short: 'l' },
    labels: { type: 'list' },
    assignee: { type: 'list', short: 'a' },
    milestone: { type: 'string', short: 'm' },
  },
  'issue view': {
    ...REPO_FLAG, ...JSON_FLAGS,
    comments: { type: 'bool', short: 'c' },
  },
  'issue comment': {
    ...REPO_FLAG,
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
  },
  'issue close': {
    ...REPO_FLAG,
    reason: { type: 'string' },
    comment: { type: 'string', short: 'c' },
  },
  'issue edit': {
    ...REPO_FLAG,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
    state: { type: 'string' },
    label: { type: 'list', short: 'l' },
    labels: { type: 'list' },
    'add-label': { type: 'list' },
    'remove-label': { type: 'list' },
    'add-assignee': { type: 'list' },
    'remove-assignee': { type: 'list' },
    milestone: { type: 'string', short: 'm' },
  },
  'project list': { ...PROJECT_OWNER_FLAG, ...JSON_FLAGS },
  'project list-items': { ...PROJECT_OWNER_FLAG, ...JSON_FLAGS },
  'project add-draft': {
    ...PROJECT_OWNER_FLAG,
    title: { type: 'string', short: 't' },
    body: { type: 'string', short: 'b' },
    'body-file': { type: 'string', short: 'F' },
  },
  'project set-title': {
    ...PROJECT_OWNER_FLAG,
    title: { type: 'string', short: 't' },
  },
  'repo view': { ...REPO_FLAG, ...JSON_FLAGS },
  'repo archive': { ...REPO_FLAG },
  'run list': {
    ...REPO_FLAG, ...JSON_FLAGS,
    limit: { type: 'string', short: 'L' },
    branch: { type: 'string', short: 'b' },
    workflow: { type: 'string', short: 'w' },
    event: { type: 'string', short: 'e' },
    status: { type: 'string', short: 's' },
    user: { type: 'string', short: 'u' },
  },
  'run view': {
    ...REPO_FLAG, ...JSON_FLAGS,
    log: { type: 'bool' },
    'log-failed': { type: 'bool' },
    'log-tail': { type: 'string' },
    job: { type: 'string', short: 'j' },
  },
  'release list': {
    ...REPO_FLAG, ...JSON_FLAGS,
    limit: { type: 'string', short: 'L' },
  },
  'notifications list': {
    ...REPO_FLAG, ...JSON_FLAGS,
    participating: { type: 'bool', short: 'p' },
    all: { type: 'bool', short: 'a' },
    limit: { type: 'string', short: 'n' },
  },
  'notifications read': { ...REPO_FLAG },
  'search prs': {
    ...REPO_FLAG, ...JSON_FLAGS,
    limit: { type: 'string', short: 'L' },
    state: { type: 'string' },
  },
  'vars list': {
    ...REPO_FLAG, ...JSON_FLAGS,
    limit: { type: 'string', short: 'L' },
  },
  'vars set': {
    ...REPO_FLAG,
    body: { type: 'string', short: 'b' },
  },
  'branch create': {
    ...REPO_FLAG,
    from: { type: 'string' },
  },
  'branch delete': { ...REPO_FLAG },
  'content put': {
    ...REPO_FLAG,
    branch: { type: 'string', short: 'b' },
    message: { type: 'string', short: 'm' },
  },
  // Hand-rolled parsers (apiPassthrough / mondayGh) — declared for help detection.
  api: {
    method: { type: 'string', short: 'X' },
    jq: { type: 'string', short: 'q' },
    field: { type: 'string', short: 'f' },
    'raw-field': { type: 'string', short: 'F' },
  },
  monday: {
    limit: { type: 'string' },
    depth: { type: 'string' },
    date: { type: 'string' },
  },
  auth: {},
  version: {},
};

function findFlagSpec(spec, name) {
  if (Object.hasOwn(spec, name)) return [name, spec[name]];
  for (const [k, v] of Object.entries(spec)) if (v.short === name) return [k, v];
  return [null, null];
}

// A 'fields' flag (`--json`) is usable bare, so it only swallows the next token
// when that token actually looks like a field list. Shared with the help
// interception so both agree on what a flag consumes.
function fieldsFlagConsumes(next) {
  return next !== undefined && next[0] !== '-' && !/^\d+$/.test(next) && !next.includes('/');
}

// True when the flag token `tok` (as written, e.g. `--title` or `-t`) consumes
// the token that follows it, given a command's flag spec. Mirrors parseArgs
// exactly: `--x=y` is self-contained, unrecognised flags are passed through as
// positionals (and so consume nothing), bools take no value.
function flagConsumesNext(spec, tok, next) {
  if (tok.includes('=')) return false;
  const [key, def] = findFlagSpec(spec || {}, tok.replace(/^--?/, ''));
  if (!key) return false;
  if (def.type === 'bool') return false;
  if (def.type === 'fields') return fieldsFlagConsumes(next);
  return next !== undefined;
}

function parseArgs(cmdLabel, args, spec) {
  const flags = {};
  const positional = [];
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (literal) { positional.push(a); continue; }
    if (a === '--') { literal = true; continue; }
    if (a.length < 2 || a[0] !== '-') { positional.push(a); continue; }

    const eq = a.indexOf('=');
    const raw = eq === -1 ? a : a.slice(0, eq);
    const [key, def] = findFlagSpec(spec, raw.replace(/^--?/, ''));
    if (!key) {
      cli.warn(
        `${cmdLabel}: unrecognised flag ${raw} — passing it through as a positional argument ` +
        `(run \`gh ${cmdLabel} --help\` for the supported flags)`
      );
      positional.push(a);
      continue;
    }

    let value;
    if (eq !== -1) value = a.slice(eq + 1);
    else if (def.type === 'bool') value = true;
    else if (def.type === 'fields') {
      // `--json` is legal bare (meaning "every field"), so only swallow the
      // next token when it actually looks like a field list — never a number
      // (`gh pr view --json 42`) or an owner/repo or another flag.
      value = fieldsFlagConsumes(args[i + 1]) ? args[++i] : '';
    } else {
      if (args[i + 1] === undefined) cli.die(`${cmdLabel}: flag ${raw} requires a value`);
      value = args[++i];
    }

    if (def.type === 'list') {
      flags[key] = flags[key] || [];
      for (const v of String(value).split(',').map(s => s.trim()).filter(Boolean)) flags[key].push(v);
    } else if (def.type === 'bool') {
      flags[key] = value === true ? true : !/^(false|0|no)$/i.test(String(value));
    } else {
      if (flags[key] !== undefined) {
        cli.die(`${cmdLabel}: ${raw} given more than once (${JSON.stringify(flags[key])} and ${JSON.stringify(value)})`);
      }
      flags[key] = value;
    }
  }
  return { flags, positional };
}

// Maps leftover positionals onto named slots, honouring values already taken
// from flags, and peels off a trailing [repo] the way this CLI always has.
// A positional is only treated as the repo when there are more positionals
// than unfilled slots — so `pr create T B feat/x` still means head=feat/x.
const REPO_SHAPE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function distribute(cmdLabel, positional, slotNames, fromFlags) {
  const values = {};
  for (const n of slotNames) values[n] = fromFlags[n] === undefined ? null : fromFlags[n];
  const fromFlagNames = slotNames.filter(n => values[n] !== null);
  const unfilled = slotNames.filter(n => values[n] === null);
  const pos = [...positional];
  let repoArg = null;
  if (pos.length > unfilled.length && REPO_SHAPE.test(pos[pos.length - 1])) repoArg = pos.pop();
  for (const n of unfilled) { if (pos.length) values[n] = pos.shift(); }
  if (pos.length) {
    if (fromFlagNames.length) {
      cli.die(
        `${cmdLabel}: value supplied twice — ${fromFlagNames.map(n => '--' + n).join(', ')} ` +
        `given as a flag and extra positional argument(s) present (${pos.join(' ')}). ` +
        'Use either the flag form or the positional form, not both.'
      );
    }
    cli.warn(`${cmdLabel}: ignoring unexpected extra argument(s): ${pos.join(' ')}`);
  }
  return { values, repoArg };
}

async function repoFrom(cmdLabel, flags, repoArg) {
  if (flags.repo && repoArg) {
    cli.die(
      `${cmdLabel}: repository specified twice — --repo ${flags.repo} and positional ${repoArg}. ` +
      'Pass only one.'
    );
  }
  return await resolveRepo(flags.repo || repoArg);
}

// Merges the historical `--label=`/`--labels=` spellings into one list.
function labelList(flags) {
  const out = [];
  for (const v of [...(flags.label || []), ...(flags.labels || [])]) if (!out.includes(v)) out.push(v);
  return out;
}

// Upstream spells this flag `--milestone <name>`, but the REST API wants the
// milestone's *number* (the create/edit payloads reject a title outright, and
// the issue-list filter only understands a number, `*` or `none`). So a
// non-numeric value is looked up by title first.
async function resolveMilestone(cmdLabel, repo, value, { allowSentinels = false } = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  const want = String(value).trim();
  if (/^\d+$/.test(want)) return Number(want);
  if (allowSentinels && (want === '*' || want === 'none')) return want;

  let list;
  try {
    list = await api.get(`/repos/${repo}/milestones`, { params: { state: 'all', per_page: 100 } });
  } catch (e) { fail(cmdLabel, e); }
  const all = Array.isArray(list) ? list : [];
  const hit = all.find(m => m.title === want)
    || all.find(m => String(m.title).toLowerCase() === want.toLowerCase());
  if (!hit) {
    cli.die(
      `${cmdLabel}: no milestone titled "${want}" in ${repo}` +
      (all.length
        ? `\nAvailable milestones: ${all.map(m => `${m.title} (#${m.number})`).join(', ')}`
        : '\nThis repository has no milestones.')
    );
  }
  return hit.number;
}

async function bodyFrom(cmdLabel, body, bodyFile) {
  if (bodyFile) {
    if (body !== null && body !== undefined) {
      cli.die(`${cmdLabel}: body specified twice — --body and --body-file. Pass only one.`);
    }
    try { return await fs.readFile(bodyFile); }
    catch (e) { cli.die(`${cmdLabel}: could not read --body-file ${bodyFile}: ${e.message}`); }
  }
  return body;
}

// ─── JSON output (--json / --jq, upstream semantics) ─────────────────────────

function normField(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Returns undefined when --json wasn't used, null for "every field", or the
// resolved field list. Field names are matched case/shape-insensitively so
// `statusCheckRollup`, `status_check_rollup` and `statuscheckrollup` all work.
function parseFields(cmdLabel, raw, available) {
  if (raw === undefined) return undefined;
  const requested = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!requested.length) return null;
  const index = new Map(available.map(f => [normField(f), f]));
  const out = [];
  for (const f of requested) {
    const hit = index.get(normField(f));
    if (!hit) {
      cli.die(`${cmdLabel}: unknown JSON field "${f}"\nAvailable fields: ${available.join(', ')}`);
    }
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

function wants(fields, name) { return !fields || fields.includes(name); }

function pickFields(obj, fields) {
  if (!fields) return obj;
  const out = {};
  for (const f of fields) out[f] = obj[f];
  return out;
}

// Minimal jq fallback (`.a.b`, `.a[].b`, `.a[0]`) for when the shell's jq is
// unavailable; the real jq is preferred whenever it runs.
function jqLite(expr, data) {
  const path = expr.trim().replace(/^\./, '');
  if (!path) return JSON.stringify(data, null, 2);
  let cur = [data];
  for (const seg of path.split('.')) {
    const m = seg.match(/^([^[\]]*)\[(\d*)\]$/);
    const key = m ? m[1] : seg;
    const iterate = !!m && m[2] === '';
    const idx = m && m[2] !== '' ? parseInt(m[2], 10) : null;
    const next = [];
    for (const v of cur) {
      const val = key ? v?.[key] : v;
      if (iterate && Array.isArray(val)) next.push(...val);
      else if (idx !== null && Array.isArray(val)) next.push(val[idx]);
      else next.push(val);
    }
    cur = next;
  }
  return cur.map(v => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))).join('\n');
}

async function applyJq(expr, data) {
  // Piped through the shell's jq when available (full jq semantics), falling
  // back to the built-in path evaluator below when jq is missing or errors.
  try {
    const json = JSON.stringify(data);
    const r = await exec(`printf '%s' ${escapeShellArg(json)} | jq -r ${escapeShellArg(expr)}`);
    if (r.exitCode === 0 && !/^jq: error/m.test(r.stderr || '')) return r.stdout.replace(/\n+$/, '');
  } catch {}
  return jqLite(expr, data);
}

async function outputJson(data, flags) {
  if (flags.jq) { console.log(await applyJq(flags.jq, data)); return; }
  console.log(JSON.stringify(data, null, 2));
}

function upper(s) { return s ? String(s).toUpperCase() : s; }
function userRef(u) { return u ? { login: u.login, id: u.id, url: u.html_url } : null; }
function labelRefs(list) { return (list || []).map(l => ({ name: l.name, color: l.color, description: l.description })); }

// ─── pr list ─────────────────────────────────────────────────────────────────

const PR_LIST_FIELDS = [
  'number', 'title', 'body', 'state', 'isDraft', 'author', 'headRefName', 'baseRefName',
  'headRefOid', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'labels',
  'assignees', 'reviewRequests', 'milestone', 'id',
];

function prListJson(pr) {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    state: pr.merged_at ? 'MERGED' : upper(pr.state),
    isDraft: !!pr.draft,
    author: userRef(pr.user),
    headRefName: pr.head?.ref,
    baseRefName: pr.base?.ref,
    headRefOid: pr.head?.sha,
    url: pr.html_url,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    labels: labelRefs(pr.labels),
    assignees: (pr.assignees || []).map(userRef),
    reviewRequests: (pr.requested_reviewers || []).map(userRef),
    milestone: pr.milestone ? { title: pr.milestone.title, number: pr.milestone.number } : null,
    id: pr.node_id,
  };
}

// The plain-output state column: `--state closed|merged|all` must not label
// everything `open`. Derived from pr.state + pr.merged_at, like upstream.
function prStateLabel(pr) {
  if (pr.merged_at) return color.cyan('merged');
  if (pr.state !== 'open') return color.red('closed');
  return pr.draft ? color.green('open') + '  ' + color.yellow('[DRAFT]') : color.green('open');
}
async function prList(args) {
  const { flags, positional } = parseArgs('pr list', args, FLAG_SPECS['pr list']);
  const { repoArg } = distribute('pr list', positional, [], flags);
  const repo = await repoFrom('pr list', flags, repoArg);

  const state = (flags.state || 'open').toLowerCase();
  const params = {
    state: state === 'merged' ? 'closed' : state,
    per_page: Math.min(parseInt(flags.limit, 10) || 30, 100),
  };
  if (flags.base) params.base = flags.base;
  if (flags.head) params.head = flags.head.includes(':') ? flags.head : `${repo.split('/')[0]}:${flags.head}`;

  let prs;
  try { prs = await api.get(`/repos/${repo}/pulls`, { params }); }
  catch (e) { fail('pr list', e); }

  if (state === 'merged') prs = prs.filter(pr => pr.merged_at);
  if (flags.draft) prs = prs.filter(pr => pr.draft);

  const fields = parseFields('pr list', flags.json, PR_LIST_FIELDS);
  if (fields !== undefined) {
    await outputJson(prs.map(pr => pickFields(prListJson(pr), fields)), flags);
    return;
  }

  if (!prs.length) {
    console.log(color.gray('No ' + (state === 'all' ? '' : state + ' ') + 'pull requests.'));
    return;
  }

  const rows = prs.map(pr => [
    color.cyan('#' + pr.number),
    fmt.trunc(pr.title, 52),
    color.gray(fmt.trunc(pr.head.ref, 36)),
    prStateLabel(pr),
  ]);
  console.log(fmt.table(rows, [6, 54, 38]));
}

// ─── pr view ─────────────────────────────────────────────────────────────────

const PR_VIEW_FIELDS = [
  ...PR_LIST_FIELDS,
  'merged', 'mergeable', 'mergeStateStatus', 'mergeCommit', 'additions', 'deletions',
  'changedFiles', 'commits', 'commitsCount', 'statusCheckRollup', 'reviews', 'reviewDecision',
  'comments',
];

// Normalises check-runs + commit statuses into upstream's statusCheckRollup shape.
function rollupEntries(checkRuns, statuses) {
  const out = (checkRuns || []).map(r => ({
    __typename: 'CheckRun',
    name: r.name,
    status: upper(r.status),
    conclusion: upper(r.conclusion),
    detailsUrl: r.details_url,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    workflowName: r.app ? r.app.name : null,
  }));
  for (const s of statuses || []) {
    out.push({
      __typename: 'StatusContext',
      name: s.context,
      context: s.context,
      state: upper(s.state),
      status: s.state === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: s.state === 'pending' ? null : upper(s.state),
      detailsUrl: s.target_url,
      startedAt: s.created_at,
      completedAt: s.updated_at,
      targetUrl: s.target_url,
      description: s.description,
    });
  }
  return out;
}

function rollupBucket(entry) {
  const v = entry.conclusion || entry.state || entry.status;
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) return 'pass';
  if (['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(v)) return 'fail';
  if (['CANCELLED', 'STALE'].includes(v)) return 'skipping';
  return 'pending';
}

// Keeps only the newest status per context. `/statuses` is a full history, so a
// context that reported `failure` and later `success` shows up twice there and
// the obsolete entry would be counted as a current failure.
function latestStatusPerContext(statuses) {
  const newest = new Map();
  for (const s of statuses || []) {
    const prev = newest.get(s.context);
    const t = Date.parse(s.updated_at || s.created_at || 0) || 0;
    const pt = prev ? (Date.parse(prev.updated_at || prev.created_at || 0) || 0) : -1;
    if (!prev || t > pt || (t === pt && (s.id || 0) > (prev.id || 0))) newest.set(s.context, s);
  }
  return [...newest.values()];
}

async function fetchRollup(repo, sha) {
  let checkRuns = [];
  let statuses = [];
  try {
    const c = await api.get(`/repos/${repo}/commits/${sha}/check-runs`, { params: { per_page: 100 } });
    checkRuns = c.check_runs || [];
  } catch {}
  try {
    // Combined status: GitHub already collapses this to the latest status per
    // context. `latestStatusPerContext` is belt-and-braces for the fallback.
    const s = await api.get(`/repos/${repo}/commits/${sha}/status`, { params: { per_page: 100 } });
    statuses = Array.isArray(s?.statuses) ? s.statuses : [];
  } catch {
    try {
      const s = await api.get(`/repos/${repo}/commits/${sha}/statuses`, { params: { per_page: 100 } });
      statuses = Array.isArray(s) ? s : [];
    } catch {}
  }
  return rollupEntries(checkRuns, latestStatusPerContext(statuses));
}

async function fetchReviews(repo, num) {
  try {
    const rs = await api.get(`/repos/${repo}/pulls/${num}/reviews`, { params: { per_page: 100 } });
    return (rs || []).map(r => ({
      id: r.id,
      author: userRef(r.user),
      authorAssociation: r.author_association,
      state: upper(r.state),
      body: r.body || '',
      submittedAt: r.submitted_at,
      url: r.html_url,
    }));
  } catch { return []; }
}

// Upstream's `commits` JSON field is an array of commit objects (consumers do
// `.commits[].oid`), whereas the REST pull-request payload only carries a
// numeric commit count. Fetched lazily — only when the field is asked for.
async function fetchCommits(repo, num) {
  try {
    const cs = await api.get(`/repos/${repo}/pulls/${num}/commits`, { params: { per_page: 100 } });
    return (cs || []).map(c => {
      const msg = c.commit?.message || '';
      const nl = msg.indexOf('\n');
      return {
        oid: c.sha,
        messageHeadline: nl === -1 ? msg : msg.slice(0, nl),
        messageBody: nl === -1 ? '' : msg.slice(nl + 1).replace(/^\n+/, ''),
        authoredDate: c.commit?.author?.date || null,
        committedDate: c.commit?.committer?.date || null,
        authors: [{
          name: c.commit?.author?.name || null,
          email: c.commit?.author?.email || null,
          login: c.author ? c.author.login : null,
        }],
        url: c.html_url,
      };
    });
  } catch { return []; }
}

async function fetchComments(repo, num) {
  try {
    const cs = await api.get(`/repos/${repo}/issues/${num}/comments`, { params: { per_page: 100 } });
    return (cs || []).map(c => ({
      id: c.id,
      author: userRef(c.user),
      authorAssociation: c.author_association,
      body: c.body || '',
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      url: c.html_url,
    }));
  } catch { return []; }
}

function reviewDecision(reviews) {
  const latest = new Map();
  for (const r of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    latest.set(r.author?.login, r.state);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  if (states.includes('APPROVED')) return 'APPROVED';
  return null;
}

async function prViewJson(repo, pr, fields, flags) {
  const data = prListJson(pr);
  data.merged = !!pr.merged;
  data.mergeable = pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
  data.mergeStateStatus = upper(pr.mergeable_state);
  data.mergeCommit = pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null;
  data.additions = pr.additions;
  data.deletions = pr.deletions;
  data.changedFiles = pr.changed_files;
  // REST gives a count; upstream's `commits` is an array of commit objects, so
  // the count keeps its own field and `commits` is fetched on demand.
  data.commitsCount = pr.commits;
  if (wants(fields, 'commits')) data.commits = await fetchCommits(repo, pr.number);

  if (wants(fields, 'statusCheckRollup')) data.statusCheckRollup = await fetchRollup(repo, pr.head.sha);
  if (wants(fields, 'reviews') || wants(fields, 'reviewDecision')) {
    const reviews = await fetchReviews(repo, pr.number);
    data.reviews = reviews;
    data.reviewDecision = reviewDecision(reviews);
  }
  if (wants(fields, 'comments')) data.comments = await fetchComments(repo, pr.number);

  await outputJson(pickFields(data, fields), flags);
}

async function prView(args) {
  const { flags, positional } = parseArgs('pr view', args, FLAG_SPECS['pr view']);
  const { values, repoArg } = distribute('pr view', positional, ['number'], flags);
  if (!values.number) cli.die('pr view: PR number required');
  const num = validateNum(values.number, 'PR number');
  const repo = await repoFrom('pr view', flags, repoArg);
  let pr, checks;
  try { pr = await api.get(`/repos/${repo}/pulls/${num}`); }
  catch (e) { fail('pr view', e); }

  const fields = parseFields('pr view', flags.json, PR_VIEW_FIELDS);
  if (fields !== undefined) {
    await prViewJson(repo, pr, fields, flags);
    return;
  }

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

  if (flags.comments) {
    const comments = await fetchComments(repo, num);
    console.log('\n' + color.bold('Comments:') + (comments.length ? '' : ' ' + color.gray('(none)')));
    for (const c of comments) {
      console.log('\n' + color.cyan('@' + (c.author?.login || '?')) + '  ' + color.gray(fmtDate(c.createdAt)));
      console.log(fmt.trunc(c.body.replace(/\r?\n/g, ' '), 400));
    }
  }
}

// ─── pr checks ───────────────────────────────────────────────────────────────
// Upstream `gh pr checks <num>` — per-check status/conclusion for a PR's head
// commit. Previously this only existed folded into `pr view`'s summary line.

const PR_CHECKS_FIELDS = [
  'name', 'state', 'bucket', 'status', 'conclusion', 'link', 'workflow',
  'startedAt', 'completedAt', 'description',
];

async function prChecks(args) {
  const { flags, positional } = parseArgs('pr checks', args, FLAG_SPECS['pr checks']);
  const { values, repoArg } = distribute('pr checks', positional, ['number'], flags);
  if (!values.number) cli.die('pr checks: PR number required');
  const num = validateNum(values.number, 'PR number');
  const repo = await repoFrom('pr checks', flags, repoArg);

  let pr;
  try { pr = await api.get(`/repos/${repo}/pulls/${num}`); }
  catch (e) { fail('pr checks', e); }

  const rollup = await fetchRollup(repo, pr.head.sha);
  const entries = rollup.map(e => ({
    name: e.name,
    state: e.conclusion || e.state || e.status,
    bucket: rollupBucket(e),
    status: e.status,
    conclusion: e.conclusion || null,
    link: e.detailsUrl || null,
    workflow: e.workflowName || null,
    startedAt: e.startedAt || null,
    completedAt: e.completedAt || null,
    description: e.description || null,
  }));

  const failed = entries.filter(e => e.bucket === 'fail').length;
  const pending = entries.filter(e => e.bucket === 'pending').length;

  const fields = parseFields('pr checks', flags.json, PR_CHECKS_FIELDS);
  if (fields !== undefined) {
    await outputJson(entries.map(e => pickFields(e, fields)), flags);
  } else if (!entries.length) {
    console.log(color.gray('No checks reported for ' + pr.head.sha.slice(0, 7) + '.'));
  } else {
    const rows = entries.map(e => [
      e.bucket === 'pass' ? sym('success') : e.bucket === 'fail' ? sym('failure') : e.bucket === 'pending' ? sym('pending') : sym('skipped'),
      fmt.trunc(e.name, 44),
      color.gray(String(e.state || '').toLowerCase() || 'pending'),
      color.gray(fmt.trunc(e.link || '', 60)),
    ]);
    console.log(fmt.table(rows, [3, 46, 16]));
    if (failed) console.log('\n' + color.red(failed + ' check(s) failed') + color.gray(' — `gh run list ' + repo + '` then `gh run view <id> --log-failed` for details'));
    else if (pending) console.log('\n' + color.yellow(pending + ' check(s) still running'));
    else console.log('\n' + color.green('All checks passing'));
  }

  // Polling is the wrong shape for a SLICC agent, so `--watch` installs the
  // event-driven webhook watch instead (same plumbing as `gh pr watch`): the
  // scoop gets check_run/check_suite licks as they happen. Mutates the repo
  // (installs a webhook) — call `gh pr unwatch <num>` when done.
  // Entering watch mode is a success in itself, so it exits 0 (upstream does
  // the same: the status code reflects the final state it watched, and here the
  // final state arrives later as webhook licks).
  if (flags.watch) {
    console.log(color.gray('\n--watch: installing the event-driven watch (SLICC equivalent of upstream polling)…'));
    await prWatch([
      String(num), repo,
      ...(flags.filter ? ['--filter', flags.filter] : []),
      ...(flags.scoop ? ['--scoop', flags.scoop] : []),
    ]);
    return;
  }

  // Upstream exit-status contract, so that `gh pr checks && gh pr merge` is
  // safe: 0 = every check passed, 1 = at least one failed (or no checks were
  // reported at all), 8 = nothing failed but some checks are still pending.
  if (failed) process.exit(1);
  if (!entries.length) {
    if (fields !== undefined) cli.warn('pr checks: no checks reported for ' + pr.head.sha.slice(0, 7));
    else console.log(color.gray('(upstream gh treats "no checks reported" as a failure — exiting 1)'));
    process.exit(1);
  }
  if (pending) process.exit(8);
  process.exit(0);
}

// ─── pr merge ────────────────────────────────────────────────────────────────

async function prMerge(args) {
  const { flags, positional } = parseArgs('pr merge', args, FLAG_SPECS['pr merge']);
  const { values, repoArg } = distribute('pr merge', positional, ['number'], flags);
  if (!values.number) cli.die('pr merge: PR number required');
  const num = validateNum(values.number, 'PR number');
  const chosen = ['merge', 'squash', 'rebase'].filter(m => flags[m]);
  if (chosen.length > 1) cli.die('pr merge: pick one of --merge, --squash, --rebase (got: ' + chosen.map(m => '--' + m).join(' ') + ')');
  const method = chosen[0] || 'merge';
  const repo = await repoFrom('pr merge', flags, repoArg);

  const body = { merge_method: method };
  if (flags.subject) body.commit_title = flags.subject;
  const msg = await bodyFrom('pr merge', flags.body ?? null, flags['body-file']);
  if (msg !== null && msg !== undefined) body.commit_message = msg;

  try {
    const res = await api.put(`/repos/${repo}/pulls/${num}/merge`, { body });
    console.log(sym('merged') + ' ' + color.green('Merged') + ' PR #' + num + ' via ' + method + (res.message ? ' — ' + res.message : ''));
  } catch (e) { fail('pr merge', e); }

  if (flags['delete-branch']) await deleteHeadBranch('pr merge', repo, num);
}

// Shared by `pr merge --delete-branch` / `pr close --delete-branch`.
async function deleteHeadBranch(cmdLabel, repo, num) {
  try {
    const pr = await api.get(`/repos/${repo}/pulls/${num}`);
    if (pr.head.repo && pr.head.repo.full_name !== repo) {
      cli.warn(`${cmdLabel}: --delete-branch skipped — head branch lives in a fork (${pr.head.repo.full_name})`);
      return;
    }
    await api.delete(`/repos/${repo}/git/refs/heads/${pr.head.ref}`);
    console.log(sym('success') + ' Deleted branch ' + color.cyan(pr.head.ref));
  } catch (e) {
    cli.warn(`${cmdLabel}: could not delete head branch: ` + (e.body?.message || e.message));
  }
}

// ─── pr comment ──────────────────────────────────────────────────────────────

async function prComment(args) {
  const { flags, positional } = parseArgs('pr comment', args, FLAG_SPECS['pr comment']);
  const { values, repoArg } = distribute('pr comment', positional, ['number', 'body'], flags);
  if (!values.number) cli.die('pr comment: PR number required');
  const num = validateNum(values.number, 'PR number');
  const message = await bodyFrom('pr comment', values.body, flags['body-file']);
  if (!message) cli.die('pr comment: message required (positional <message>, --body or --body-file)');
  const repo = await repoFrom('pr comment', flags, repoArg);
  try {
    const res = await api.post(`/repos/${repo}/issues/${num}/comments`, {
      body: { body: message },
    });
    console.log(sym('success') + ' Comment posted: ' + res.html_url);
  } catch (e) { fail('pr comment', e); }
}

// ─── pr create ───────────────────────────────────────────────────────────────

async function prCreate(args) {
  const usage = 'usage: gh pr create --title <t> --body <b> --head <branch> [--base <base>] [--draft] [-R owner/repo]\n'
    + '       gh pr create <title> <body> <head-branch> [--base=<base>] [--draft] [repo]   (original positional form)';
  const { flags, positional } = parseArgs('pr create', args, FLAG_SPECS['pr create']);
  if (flags['body-file']) flags.body = await bodyFrom('pr create', flags.body ?? null, flags['body-file']);
  const { values, repoArg } = distribute('pr create', positional, ['title', 'body', 'head'], flags);
  if (!values.title) cli.die('pr create: title required (--title or positional <title>)\n' + usage);
  if (values.body === null || values.body === undefined) cli.die('pr create: body required (--body, --body-file or positional <body>)\n' + usage);
  if (!values.head) cli.die('pr create: head branch required (--head or positional <head-branch>)\n' + usage);
  const { title, body, head } = values;
  const repo = await repoFrom('pr create', flags, repoArg);
  let base = flags.base || null;
  const draft = !!flags.draft;

  // Default base to the repo's default branch if not specified
  if (!base) {
    try {
      const r = await api.get(`/repos/${repo}`);
      base = r.default_branch || 'main';
    } catch { base = 'main'; }
  }

  let res;
  try {
    res = await api.post(`/repos/${repo}/pulls`, {
      body: { title, body, head, base, draft },
    });
    console.log(sym('success') + ' Created PR ' + color.cyan('#' + res.number) + ': ' + res.title);
    console.log(color.gray('Branch:') + '  ' + res.head.ref + ' → ' + res.base.ref);
    console.log(color.gray('URL:') + '     ' + res.html_url);
    console.log(color.gray('TIP:') + '    run `gh pr watch ' + res.number + '` to get live updates in this scoop as the PR changes.');
  } catch (e) { fail('pr create', e); }

  // Labels/assignees go through the issues endpoint (a PR is an issue);
  // reviewers have their own endpoint. Both are best-effort follow-ups so a
  // permissions failure never loses the created PR.
  const labels = labelList(flags);
  if (labels.length || (flags.assignee || []).length) {
    try {
      await api.patch(`/repos/${repo}/issues/${res.number}`, {
        body: {
          ...(labels.length ? { labels } : {}),
          ...((flags.assignee || []).length ? { assignees: flags.assignee } : {}),
        },
      });
      if (labels.length) console.log(color.gray('Labels:') + '  ' + labels.join(', '));
      if ((flags.assignee || []).length) console.log(color.gray('Assignees:') + ' ' + flags.assignee.join(', '));
    } catch (e) { cli.warn('pr create: PR created but labels/assignees could not be applied: ' + (e.body?.message || e.message)); }
  }
  if ((flags.reviewer || []).length) {
    const users = flags.reviewer.filter(r => !r.includes('/'));
    const teams = flags.reviewer.filter(r => r.includes('/')).map(r => r.split('/').pop());
    try {
      await api.post(`/repos/${repo}/pulls/${res.number}/requested_reviewers`, {
        body: { ...(users.length ? { reviewers: users } : {}), ...(teams.length ? { team_reviewers: teams } : {}) },
      });
      console.log(color.gray('Reviewers:') + ' ' + flags.reviewer.join(', '));
    } catch (e) { cli.warn('pr create: PR created but reviewers could not be requested: ' + (e.body?.message || e.message)); }
  }
}

// ─── pr checkout ─────────────────────────────────────────────────────────────

async function prCheckout(args) {
  const { flags, positional } = parseArgs('pr checkout', args, FLAG_SPECS['pr checkout']);
  const { values, repoArg } = distribute('pr checkout', positional, ['number'], flags);
  if (!values.number) cli.die('pr checkout: PR number required');
  const num = validateNum(values.number, 'PR number');
  const repo = await repoFrom('pr checkout', flags, repoArg);
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
  const usage = 'usage: gh pr watch <num> [--filter <js>] [--scoop <name>] [-R owner/repo] [repo]';
  const { flags, positional } = parseArgs('pr watch', args, FLAG_SPECS['pr watch']);
  const { values, repoArg } = distribute('pr watch', positional, ['number'], flags);
  if (!values.number) cli.die('pr watch: PR number required\n' + usage);
  const num = validateNum(values.number, 'PR number');
  const filter = flags.filter || null;
  const scoopName = flags.scoop || process.env.SLICC_SCOOP || null;
  const repo = await repoFrom('pr watch', flags, repoArg);

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
    try { await exec(`webhook delete ${escapeShellArg(webhookId)}`); } catch {}
    fail('pr watch', e);
  }

  console.log(sym('success') + ' Watching PR ' + color.cyan('#' + num) + ' in ' + repo);
  console.log(color.gray('SLICC webhook:  ') + webhookId + ' (' + hookName + ') → ' + scoopName);
  console.log(color.gray('GitHub hook:    ') + hook.id);
  console.log(color.gray('Events:         ') + WATCH_EVENTS.join(', '));
  console.log(color.gray('Stop watching:  ') + 'gh pr unwatch ' + num + ' ' + repo);
}

async function prUnwatch(args) {
  const usage = 'usage: gh pr unwatch <num> [-R owner/repo] [repo]';
  const { flags, positional } = parseArgs('pr unwatch', args, FLAG_SPECS['pr unwatch']);
  const { values, repoArg } = distribute('pr unwatch', positional, ['number'], flags);
  if (!values.number) cli.die('pr unwatch: PR number required\n' + usage);
  const num = validateNum(values.number, 'PR number');
  const repo = await repoFrom('pr unwatch', flags, repoArg);
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

  try { await exec(`webhook delete ${escapeShellArg(webhookId)}`); }
  catch (e) { cli.die('pr unwatch: failed to delete SLICC webhook ' + webhookId + ': ' + e.message); }

  console.log(sym('success') + ' Stopped watching PR ' + color.cyan('#' + num) + ' in ' + repo);
  console.log(color.gray('Removed SLICC webhook:  ') + webhookId);
  console.log(color.gray('Removed GitHub hook:    ') + (ghHookId || color.gray('(none found)')));
}

// ─── pr close ────────────────────────────────────────────────────────────────

async function prClose(args) {
  const { flags, positional } = parseArgs('pr close', args, FLAG_SPECS['pr close']);
  const { values, repoArg } = distribute('pr close', positional, ['number'], flags);
  if (!values.number) cli.die('pr close: PR number required');
  const num = validateNum(values.number, 'PR number');
  const repo = await repoFrom('pr close', flags, repoArg);
  if (flags.comment) {
    try { await api.post(`/repos/${repo}/issues/${num}/comments`, { body: { body: flags.comment } }); }
    catch (e) { cli.warn('pr close: could not post --comment: ' + (e.body?.message || e.message)); }
  }
  try {
    const res = await api.patch(`/repos/${repo}/pulls/${num}`, {
      body: { state: 'closed' },
    });
    console.log(sym('closed') + ' Closed PR ' + color.cyan('#' + num) + ': ' + res.title);
    console.log(color.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('pr close', e); }
  if (flags['delete-branch']) await deleteHeadBranch('pr close', repo, num);
}

// ─── issue list ──────────────────────────────────────────────────────────────

const ISSUE_FIELDS = [
  'number', 'title', 'body', 'state', 'stateReason', 'author', 'url', 'createdAt', 'updatedAt',
  'closedAt', 'labels', 'assignees', 'milestone', 'commentsCount', 'id',
];

function issueJson(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body || '',
    state: upper(issue.state),
    stateReason: upper(issue.state_reason),
    author: userRef(issue.user),
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    labels: labelRefs(issue.labels),
    assignees: (issue.assignees || []).map(userRef),
    milestone: issue.milestone ? { title: issue.milestone.title, number: issue.milestone.number } : null,
    commentsCount: issue.comments,
    id: issue.node_id,
  };
}

async function issueList(args) {
  const { flags, positional } = parseArgs('issue list', args, FLAG_SPECS['issue list']);
  const { repoArg } = distribute('issue list', positional, [], flags);
  const repo = await repoFrom('issue list', flags, repoArg);

  // The issues endpoint returns PRs too and they are filtered out below, so an
  // explicit --limit over-fetches and trims afterwards; without --limit the page
  // size stays exactly what it always was.
  const limit = Math.min(parseInt(flags.limit, 10) || 30, 100);
  const params = {
    state: (flags.state || 'open').toLowerCase(),
    per_page: flags.limit === undefined ? limit : Math.min(limit * 3, 100),
  };
  const labels = labelList(flags);
  if (labels.length) params.labels = labels.join(',');
  if (flags.assignee) params.assignee = flags.assignee;
  if (flags.author) params.creator = flags.author;
  if (flags.milestone) {
    // `*` and `none` are meaningful to the list filter; a title is resolved to its number.
    params.milestone = String(await resolveMilestone('issue list', repo, flags.milestone, { allowSentinels: true }));
  }

  let issues;
  try { issues = await api.get(`/repos/${repo}/issues`, { params }); }
  catch (e) { fail('issue list', e); }

  const filtered = issues.filter(i => !i.pull_request).slice(0, limit);

  const fields = parseFields('issue list', flags.json, ISSUE_FIELDS);
  if (fields !== undefined) {
    await outputJson(filtered.map(i => pickFields(issueJson(i), fields)), flags);
    return;
  }

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
  const usage = 'usage: gh issue create --title <t> --body <b> [--label L]... [--assignee U]... [-R owner/repo]\n'
    + '       gh issue create <title> <body> [--label=L]... [--labels=a,b] [repo]   (original positional form)';
  const { flags, positional } = parseArgs('issue create', args, FLAG_SPECS['issue create']);
  if (flags['body-file']) flags.body = await bodyFrom('issue create', flags.body ?? null, flags['body-file']);
  const { values, repoArg } = distribute('issue create', positional, ['title', 'body'], flags);
  if (!values.title) cli.die('issue create: title required (--title or positional <title>)\n' + usage);
  if (values.body === null || values.body === undefined) cli.die('issue create: body required (--body, --body-file or positional <body>)\n' + usage);
  const { title, body } = values;
  const repo = await repoFrom('issue create', flags, repoArg);

  const labels = labelList(flags);
  const payload = { title, body };
  if (labels.length) payload.labels = labels;
  if ((flags.assignee || []).length) payload.assignees = flags.assignee;
  if (flags.milestone) payload.milestone = await resolveMilestone('issue create', repo, flags.milestone);

  try {
    const res = await api.post(`/repos/${repo}/issues`, { body: payload });
    console.log(sym('success') + ' Created issue ' + color.cyan('#' + res.number) + ' — ' + res.html_url);
  } catch (e) { fail('issue create', e); }
}

// ─── issue view ──────────────────────────────────────────────────────────────

async function issueView(args) {
  const { flags, positional } = parseArgs('issue view', args, FLAG_SPECS['issue view']);
  const { values, repoArg } = distribute('issue view', positional, ['number'], flags);
  if (!values.number) cli.die('issue view: issue number required');
  const num = validateNum(values.number, 'issue number');
  const repo = await repoFrom('issue view', flags, repoArg);
  let issue;
  try { issue = await api.get(`/repos/${repo}/issues/${num}`); }
  catch (e) { fail('issue view', e); }

  const ISSUE_VIEW_FIELDS = [...ISSUE_FIELDS, 'comments'];
  const fields = parseFields('issue view', flags.json, ISSUE_VIEW_FIELDS);
  if (fields !== undefined) {
    const data = issueJson(issue);
    if (wants(fields, 'comments')) data.comments = await fetchComments(repo, num);
    await outputJson(pickFields(data, fields), flags);
    return;
  }

  const stateStr = issue.state === 'open' ? color.green('open') : color.red('closed');
  console.log(color.bold(issue.title) + '  ' + sym(issue.state) + ' ' + stateStr);
  console.log(color.gray('Author:') + '  ' + issue.user.login);
  console.log(color.gray('URL:') + '     ' + issue.html_url);
  if (issue.labels.length) console.log(color.gray('Labels:') + '  ' + issue.labels.map(l => color.yellow(l.name)).join(', '));
  if (issue.body) {
    console.log('\n' + color.gray('Body:'));
    console.log(fmt.trunc(issue.body.replace(/\r?\n/g, ' '), 400));
  }

  if (flags.comments) {
    const comments = await fetchComments(repo, num);
    console.log('\n' + color.bold('Comments:') + (comments.length ? '' : ' ' + color.gray('(none)')));
    for (const c of comments) {
      console.log('\n' + color.cyan('@' + (c.author?.login || '?')) + '  ' + color.gray(fmtDate(c.createdAt)));
      console.log(fmt.trunc(c.body.replace(/\r?\n/g, ' '), 400));
    }
  }
}

// ─── issue comment ───────────────────────────────────────────────────────────

async function issueComment(args) {
  const { flags, positional } = parseArgs('issue comment', args, FLAG_SPECS['issue comment']);
  const { values, repoArg } = distribute('issue comment', positional, ['number', 'body'], flags);
  if (!values.number) cli.die('issue comment: issue number required');
  const num = validateNum(values.number, 'issue number');
  const message = await bodyFrom('issue comment', values.body, flags['body-file']);
  if (!message) cli.die('issue comment: message required (positional <message>, --body or --body-file)');
  const repo = await repoFrom('issue comment', flags, repoArg);
  try {
    const res = await api.post(`/repos/${repo}/issues/${num}/comments`, {
      body: { body: message },
    });
    console.log(sym('success') + ' Comment posted: ' + res.html_url);
  } catch (e) { fail('issue comment', e); }
}

// ─── issue close ─────────────────────────────────────────────────────────────

async function issueClose(args) {
  const { flags, positional } = parseArgs('issue close', args, FLAG_SPECS['issue close']);
  const { values, repoArg } = distribute('issue close', positional, ['number'], flags);
  if (!values.number) cli.die('issue close: issue number required');
  const num = validateNum(values.number, 'issue number');
  const reason = flags.reason ? flags.reason.trim() : null;
  const repo = await repoFrom('issue close', flags, repoArg);
  if (flags.comment) {
    try { await api.post(`/repos/${repo}/issues/${num}/comments`, { body: { body: flags.comment } }); }
    catch (e) { cli.warn('issue close: could not post --comment: ' + (e.body?.message || e.message)); }
  }
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
  const usage = 'usage: gh issue edit <num> [--title T] [--body B] [--body-file F] [--label L]... '
    + '[--add-label L]... [--remove-label L]... [--state open|closed] [-R owner/repo] [repo]';
  const { flags, positional } = parseArgs('issue edit', args, FLAG_SPECS['issue edit']);
  const { values, repoArg } = distribute('issue edit', positional, ['number'], flags);
  if (!values.number) cli.die('issue edit: issue number required\n' + usage);
  const num = validateNum(values.number, 'issue number');
  const repo = await repoFrom('issue edit', flags, repoArg);

  const title = flags.title ?? null;
  const body = await bodyFrom('issue edit', flags.body ?? null, flags['body-file']);
  const state = flags.state ? flags.state.trim() : null;
  const setLabels = labelList(flags);
  const addLabels = flags['add-label'] || [];
  const removeLabels = flags['remove-label'] || [];
  const addAssignees = flags['add-assignee'] || [];
  const removeAssignees = flags['remove-assignee'] || [];

  const payload = {};
  if (title !== null) payload.title = title;
  if (body !== null && body !== undefined) payload.body = body;
  if (state !== null) payload.state = state;
  if (flags.milestone) payload.milestone = await resolveMilestone('issue edit', repo, flags.milestone);
  if (setLabels.length) payload.labels = setLabels;
  else if (addLabels.length || removeLabels.length) {
    let current = [];
    try {
      const issue = await api.get(`/repos/${repo}/issues/${num}`);
      current = (issue.labels || []).map(l => l.name);
    } catch (e) { fail('issue edit', e); }
    payload.labels = [...new Set([...current, ...addLabels])].filter(l => !removeLabels.includes(l));
  }
  if (addAssignees.length || removeAssignees.length) {
    let current = [];
    try {
      const issue = await api.get(`/repos/${repo}/issues/${num}`);
      current = (issue.assignees || []).map(a => a.login);
    } catch (e) { fail('issue edit', e); }
    payload.assignees = [...new Set([...current, ...addAssignees])].filter(a => !removeAssignees.includes(a));
  }
  if (!Object.keys(payload).length) {
    cli.die('issue edit: nothing to update — pass --title, --body, --label(s), --add-label/--remove-label, '
      + '--add-assignee/--remove-assignee, --milestone or --state\n' + usage);
  }

  try {
    const res = await api.patch(`/repos/${repo}/issues/${num}`, { body: payload });
    console.log(sym('success') + ' Edited issue ' + color.cyan('#' + num) + ': ' + res.title);
    console.log(color.gray('URL:') + '     ' + res.html_url);
  } catch (e) { fail('issue edit', e); }
}

// ─── project (org-owned Projects v2) ─────────────────────────────────────────
// Projects v2 items are org-scoped, not repo-scoped — there is no owner/repo
// argument here, only an org login and a project number. REST support for
// Projects v2 (including standalone draft issues with no linked repo) is
// documented at https://docs.github.com/en/rest/projects — no GraphQL needed.

function validateOrg(val) {
  if (!val || !/^[a-zA-Z0-9._-]+$/.test(val)) {
    cli.die(`Invalid org: expected a plain org login (got: ${JSON.stringify(val)})`);
  }
  return val;
}

async function projectList(args) {
  const usage = 'usage: gh project list <org>   (or: gh project list --owner <org>)';
  const { flags, positional } = parseArgs('project list', args, FLAG_SPECS['project list']);
  const { values } = distribute('project list', positional, ['org'], { org: flags.owner ?? null });
  if (!values.org) cli.die('project list: org required\n' + usage);
  const org = validateOrg(values.org);
  let projects;
  try { projects = await api.get(`/orgs/${org}/projectsV2`); }
  catch (e) { fail('project list', e); }

  const fields = parseFields('project list', flags.json, ['number', 'title', 'state', 'url', 'id']);
  if (fields !== undefined) {
    await outputJson(projects.map(pj => pickFields({
      number: pj.number,
      title: pj.title,
      state: pj.state,
      url: `https://github.com/orgs/${org}/projects/${pj.number}`,
      id: pj.id,
    }, fields)), flags);
    return;
  }

  if (!projects.length) { console.log(color.gray('No projects.')); return; }

  const rows = projects.map(p => [
    color.cyan('#' + p.number),
    fmt.trunc(p.title, 52),
    p.state === 'open' ? color.green('open') : color.red(p.state),
    color.gray(`https://github.com/orgs/${org}/projects/${p.number}`),
  ]);
  console.log(fmt.table(rows, [6, 54, 10]));
}

async function projectListItems(args) {
  const usage = 'usage: gh project list-items <org> <project_number>';
  const { flags, positional } = parseArgs('project list-items', args, FLAG_SPECS['project list-items']);
  const { values } = distribute('project list-items', positional, ['org', 'number'], { org: flags.owner ?? null });
  if (!values.org) cli.die('project list-items: org required\n' + usage);
  if (!values.number) cli.die('project list-items: project number required\n' + usage);
  const org = validateOrg(values.org);
  const num = validateNum(values.number, 'project number');
  let items;
  try { items = await api.get(`/orgs/${org}/projectsV2/${num}/items`); }
  catch (e) { fail('project list-items', e); }

  const fields = parseFields('project list-items', flags.json, ['id', 'title', 'contentType', 'url']);
  if (fields !== undefined) {
    await outputJson(items.map(it => pickFields({
      id: it.id,
      title: it.content?.title || null,
      contentType: it.content_type || null,
      url: it.content?.html_url || null,
    }, fields)), flags);
    return;
  }

  if (!items.length) { console.log(color.gray('No items.')); return; }

  const rows = items.map(it => {
    const title = it.content?.title || '(untitled)';
    const kind = it.content_type || '(unknown)';
    return [
      color.cyan(String(it.id)),
      fmt.trunc(title, 50),
      color.gray(kind),
    ];
  });
  console.log(fmt.table(rows, [10, 52]));
}

async function projectAddDraft(args) {
  const usage = 'usage: gh project add-draft <org> <project_number> <title> [body]\n'
    + '       gh project add-draft <org> <project_number> --title <t> [--body <b>]';
  const { flags, positional } = parseArgs('project add-draft', args, FLAG_SPECS['project add-draft']);
  if (flags['body-file']) flags.body = await bodyFrom('project add-draft', flags.body ?? null, flags['body-file']);
  const { values } = distribute('project add-draft', positional, ['org', 'number', 'title', 'body'], {
    org: flags.owner ?? null,
    title: flags.title ?? null,
    body: flags.body ?? null,
  });
  if (!values.org) cli.die('project add-draft: org required\n' + usage);
  if (!values.number) cli.die('project add-draft: project number required\n' + usage);
  if (!values.title) cli.die('project add-draft: title required\n' + usage);
  const org = validateOrg(values.org);
  const num = validateNum(values.number, 'project number');
  const title = values.title;
  const body = values.body === null ? undefined : values.body;

  const payload = { title };
  if (body !== undefined) payload.body = body;

  try {
    const res = await api.post(`/orgs/${org}/projectsV2/${num}/drafts`, { body: payload });
    const item = res.value || res;
    console.log(sym('success') + ' Created draft item ' + color.cyan(String(item.id)) + ' in ' + org + ' project #' + num);
    if (item.content && item.content.title) console.log(color.gray('Title:') + '   ' + item.content.title);
  } catch (e) { fail('project add-draft', e); }
}

// ─── project set-title ────────────────────────────────────────────────────────
// Project item field updates are field-ID-based (PATCH .../items/{item_id} with
// {"fields":[{"id":<field_id>,"value":<new_value>}]}), not a direct {title:...}
// body — this looks up the item's own "Title" field ID first so the caller only
// ever has to think in terms of item_id + new title.

async function projectSetTitle(args) {
  const usage = 'usage: gh project set-title <org> <project_number> <item_id> <new_title>\n'
    + '       gh project set-title <org> <project_number> <item_id> --title <t>';
  const { flags, positional } = parseArgs('project set-title', args, FLAG_SPECS['project set-title']);
  const { values } = distribute('project set-title', positional, ['org', 'number', 'itemId', 'title'], {
    org: flags.owner ?? null,
    title: flags.title ?? null,
  });
  if (!values.org) cli.die('project set-title: org required\n' + usage);
  if (!values.number) cli.die('project set-title: project number required\n' + usage);
  if (!values.itemId) cli.die('project set-title: item id required\n' + usage);
  if (values.title === null || values.title === undefined) cli.die('project set-title: new title required\n' + usage);
  const org = validateOrg(values.org);
  const num = validateNum(values.number, 'project number');
  const itemId = validateNum(values.itemId, 'item id');
  const newTitle = values.title;

  let item;
  try { item = await api.get(`/orgs/${org}/projectsV2/${num}/items/${itemId}`); }
  catch (e) { fail('project set-title', e); }

  const titleField = (item.fields || []).find(f => f.data_type === 'title');
  if (!titleField) cli.die('project set-title: could not find a title field on item ' + itemId);

  try {
    await api.patch(`/orgs/${org}/projectsV2/${num}/items/${itemId}`, {
      body: { fields: [{ id: titleField.id, value: newTitle }] },
    });
    console.log(sym('success') + ' Updated item ' + color.cyan(String(itemId)) + ' title to: ' + newTitle);
  } catch (e) { fail('project set-title', e); }
}

// ─── repo view ───────────────────────────────────────────────────────────────

const REPO_FIELDS = [
  'name', 'nameWithOwner', 'owner', 'description', 'url', 'sshUrl', 'defaultBranchRef',
  'isPrivate', 'isFork', 'isArchived', 'stargazerCount', 'forkCount', 'openIssuesCount',
  'primaryLanguage', 'licenseInfo', 'repositoryTopics', 'visibility', 'createdAt', 'updatedAt',
  'pushedAt', 'homepageUrl', 'hasIssuesEnabled', 'id',
];

function repoJson(r) {
  return {
    name: r.name,
    nameWithOwner: r.full_name,
    owner: r.owner ? { login: r.owner.login, id: r.owner.id } : null,
    description: r.description,
    url: r.html_url,
    sshUrl: r.ssh_url,
    defaultBranchRef: { name: r.default_branch },
    isPrivate: r.private,
    isFork: r.fork,
    isArchived: r.archived,
    stargazerCount: r.stargazers_count,
    forkCount: r.forks_count,
    openIssuesCount: r.open_issues_count,
    primaryLanguage: r.language ? { name: r.language } : null,
    licenseInfo: r.license ? { key: r.license.key, name: r.license.name } : null,
    repositoryTopics: r.topics || [],
    visibility: upper(r.visibility),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    pushedAt: r.pushed_at,
    homepageUrl: r.homepage,
    hasIssuesEnabled: r.has_issues,
    id: r.node_id,
  };
}

async function repoView(args) {
  const { flags, positional } = parseArgs('repo view', args, FLAG_SPECS['repo view']);
  const { repoArg } = distribute('repo view', positional, [], flags);
  const repo = await repoFrom('repo view', flags, repoArg);
  let r;
  try { r = await api.get(`/repos/${repo}`); }
  catch (e) { fail('repo view', e); }

  const fields = parseFields('repo view', flags.json, REPO_FIELDS);
  if (fields !== undefined) {
    await outputJson(pickFields(repoJson(r), fields), flags);
    return;
  }

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

const RUN_FIELDS = [
  'databaseId', 'number', 'name', 'displayTitle', 'status', 'conclusion', 'event',
  'headBranch', 'headSha', 'workflowName', 'workflowDatabaseId', 'url', 'createdAt',
  'updatedAt', 'startedAt', 'attempt',
];

function runJson(run) {
  return {
    databaseId: run.id,
    number: run.run_number,
    name: run.name,
    displayTitle: run.display_title,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    workflowName: run.name,
    workflowDatabaseId: run.workflow_id,
    url: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    startedAt: run.run_started_at,
    attempt: run.run_attempt,
  };
}

async function runList(args) {
  const { flags, positional } = parseArgs('run list', args, FLAG_SPECS['run list']);
  const { repoArg } = distribute('run list', positional, [], flags);
  const repo = await repoFrom('run list', flags, repoArg);
  let runs;
  const params = { per_page: Math.min(parseInt(flags.limit, 10) || 20, 100) };
  if (flags.branch) params.branch = flags.branch;
  if (flags.event) params.event = flags.event;
  if (flags.status) params.status = flags.status;
  if (flags.user) params.actor = flags.user;
  try {
    const path = flags.workflow
      ? `/repos/${repo}/actions/workflows/${encodeURIComponent(flags.workflow)}/runs`
      : `/repos/${repo}/actions/runs`;
    const data = await api.get(path, { params });
    runs = data.workflow_runs;
  } catch (e) { fail('run list', e); }

  const fields = parseFields('run list', flags.json, RUN_FIELDS);
  if (fields !== undefined) {
    await outputJson((runs || []).map(r => pickFields(runJson(r), fields)), flags);
    return;
  }

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

const RUN_VIEW_FIELDS = [...RUN_FIELDS, 'jobs'];

function jobJson(job) {
  return {
    databaseId: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url,
    steps: (job.steps || []).map(st => ({
      name: st.name,
      number: st.number,
      status: st.status,
      conclusion: st.conclusion,
      startedAt: st.started_at,
      completedAt: st.completed_at,
    })),
  };
}

// Actions job logs. `http.client` throws on the 302 the logs endpoint answers
// with, so this uses plain fetch (which follows the redirect) and returns text.
async function fetchJobLog(repo, jobId) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers: {
        Authorization: `Bearer ${personalToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gh.jsh/1.0',
      },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, text: await r.text() };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Picks the most useful window of a job log: the lines leading up to the LAST
// `##[error]` annotation (the actual failure) when there is one, otherwise the
// tail — a raw tail usually lands in post-job cleanup. n = 0 means the whole log.
function logExcerpt(text, n) {
  const lines = text.replace(/\r/g, '').split('\n');
  if (!n || n <= 0 || lines.length <= n) return lines.join('\n');
  let lastError = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('##[error]')) { lastError = i; break; }
  }
  if (lastError === -1) return lines.slice(-n).join('\n');
  const end = Math.min(lines.length, lastError + 6);
  return lines.slice(Math.max(0, end - n), end).join('\n');
}

async function printJobLogs(repo, jobs, tail) {
  for (const job of jobs) {
    console.log('\n' + color.bold('── log: ' + job.name + ' ') + color.gray('(job ' + job.id + ')'));
    const failedSteps = (job.steps || []).filter(st => st.conclusion && st.conclusion !== 'success' && st.conclusion !== 'skipped');
    if (failedSteps.length) {
      console.log(color.gray('Failed steps: ') + failedSteps.map(st => `#${st.number} ${st.name} (${st.conclusion})`).join(', '));
    }
    const log = await fetchJobLog(repo, job.id);
    if (!log.ok) {
      console.log(color.yellow('Could not download the log (' + log.error + ') — showing step conclusions only:'));
      for (const st of job.steps || []) {
        console.log('  ' + (st.conclusion === 'success' ? sym('success') : st.conclusion === 'skipped' ? sym('skipped') : sym('failure')) + '  ' + st.name + color.gray(' — ' + (st.conclusion || st.status)));
      }
      continue;
    }
    console.log(logExcerpt(log.text, tail));
  }
}

async function runView(args) {
  const { flags, positional } = parseArgs('run view', args, FLAG_SPECS['run view']);
  const { values, repoArg } = distribute('run view', positional, ['runId'], flags);
  if (!values.runId) cli.die('run view: run ID required');
  const runId = validateNum(values.runId, 'run ID');
  const repo = await repoFrom('run view', flags, repoArg);
  let run, jobsData;
  try { run = await api.get(`/repos/${repo}/actions/runs/${runId}`); }
  catch (e) { fail('run view', e); }
  try { jobsData = await api.get(`/repos/${repo}/actions/runs/${runId}/jobs`, { params: { per_page: 100 } }); }
  catch { jobsData = { jobs: [] }; }

  const fields = parseFields('run view', flags.json, RUN_VIEW_FIELDS);
  if (fields !== undefined) {
    const data = runJson(run);
    data.jobs = (jobsData.jobs || []).map(jobJson);
    await outputJson(pickFields(data, fields), flags);
    return;
  }

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
      const failedSteps = (job.steps || []).filter(st => st.conclusion === 'failure' || st.conclusion === 'timed_out');
      for (const st of failedSteps) {
        console.log('      ' + sym('failure') + '  ' + color.red('step ' + st.number + ': ' + st.name));
      }
    }
  }

  // `--log` / `--log-failed` — the natural next step after a red run. Logs come
  // from the Actions logs API (GET /actions/jobs/<id>/logs); output is tailed to
  // --log-tail lines (default 200, 0 = whole log) so a huge log stays readable.
  if (flags.log || flags['log-failed']) {
    const tail = flags['log-tail'] === undefined ? 200 : parseInt(flags['log-tail'], 10) || 0;
    let selected = jobs;
    if (flags['log-failed']) {
      selected = jobs.filter(j => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
    }
    if (flags.job) selected = selected.filter(j => String(j.id) === String(flags.job) || j.name === flags.job);
    if (!selected.length) {
      console.log('\n' + color.gray(flags['log-failed'] ? 'No failed jobs in this run.' : 'No jobs to show logs for.'));
    } else {
      await printJobLogs(repo, selected, tail);
    }
  }
}

// ─── release list ────────────────────────────────────────────────────────────

const RELEASE_FIELDS = [
  'name', 'tagName', 'isDraft', 'isPrerelease', 'isLatest', 'publishedAt', 'createdAt',
  'url', 'body', 'author', 'id',
];

// `latestTag` is the repository's actual latest release tag (from
// /releases/latest) — without it every stable release would claim isLatest.
function releaseJson(r, latestTag) {
  return {
    name: r.name || r.tag_name,
    tagName: r.tag_name,
    isDraft: r.draft,
    isPrerelease: r.prerelease,
    isLatest: !!latestTag && r.tag_name === latestTag,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    url: r.html_url,
    body: r.body || '',
    author: userRef(r.author),
    id: r.node_id,
  };
}

async function releaseList(args) {
  const { flags, positional } = parseArgs('release list', args, FLAG_SPECS['release list']);
  const { repoArg } = distribute('release list', positional, [], flags);
  const repo = await repoFrom('release list', flags, repoArg);
  let releases;
  try { releases = await api.get(`/repos/${repo}/releases`, { params: { per_page: Math.min(parseInt(flags.limit, 10) || 15, 100) } }); }
  catch (e) { fail('release list', e); }

  const fields = parseFields('release list', flags.json, RELEASE_FIELDS);
  if (fields !== undefined) {
    // Exactly one release is the latest; ask GitHub which one (only when asked for).
    let latestTag = null;
    if (wants(fields, 'isLatest')) {
      try { latestTag = (await api.get(`/repos/${repo}/releases/latest`)).tag_name; }
      catch { latestTag = null; } // no published release, or none visible
    }
    await outputJson(releases.map(r => pickFields(releaseJson(r, latestTag), fields)), flags);
    return;
  }

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
  // The historical glued `-nN` form (`-n30`) is normalised to `-n 30` first so
  // the shared parser sees it; both spellings keep working.
  const normalised = [];
  for (const a of args) {
    const glued = /^-n(\d+)$/.exec(a);
    if (glued) { normalised.push('-n', glued[1]); continue; }
    normalised.push(a);
  }
  const { flags, positional } = parseArgs('notifications list', normalised, FLAG_SPECS['notifications list']);
  const participating = !!flags.participating;
  const showAll = !!flags.all;
  const limit = parseInt(flags.limit, 10) || 30;
  let repoFilter = flags.repo || null;
  const rest = positional;
  if (rest[0] && rest[0].includes('/')) {
    if (repoFilter && repoFilter !== rest[0]) {
      cli.die(`notifications list: repository specified twice — --repo ${repoFilter} and positional ${rest[0]}. Pass only one.`);
    }
    repoFilter = rest[0];
  }
  if (repoFilter) validateRepo(repoFilter);

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

  const fields = parseFields('notifications list', flags.json, [
    'id', 'reason', 'unread', 'updatedAt', 'title', 'type', 'repository', 'url', 'subjectUrl',
  ]);
  if (fields !== undefined) {
    await outputJson(notifs.map(n => pickFields({
      id: n.id,
      reason: n.reason,
      unread: n.unread,
      updatedAt: n.updated_at,
      title: n.subject?.title,
      type: n.subject?.type,
      repository: { nameWithOwner: n.repository?.full_name },
      url: n.repository?.html_url,
      subjectUrl: n.subject?.url,
    }, fields)), flags);
    return;
  }

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
  const { flags, positional } = parseArgs('notifications read', args, FLAG_SPECS['notifications read']);
  let repoFilter = flags.repo || null;
  for (const a of positional) {
    if (a.includes('/')) {
      if (repoFilter && repoFilter !== a) {
        cli.die(`notifications read: repository specified twice — --repo ${repoFilter} and positional ${a}. Pass only one.`);
      }
      repoFilter = a;
    }
  }
  if (repoFilter) validateRepo(repoFilter);

  try {
    const endpoint = repoFilter
      ? `/repos/${repoFilter}/notifications`
      : `/notifications`;
    await api.put(endpoint, { body: { read: true } });
    console.log(sym('success') + ' Marked ' + (repoFilter ? color.cyan(repoFilter) : 'all') + ' notifications as read');
  } catch (e) { fail('notifications read', e); }
}

// ─── search prs ──────────────────────────────────────────────────────────────

const SEARCH_PR_FIELDS = [
  'number', 'title', 'body', 'state', 'author', 'repository', 'url', 'createdAt',
  'updatedAt', 'closedAt', 'labels', 'isDraft', 'commentsCount', 'id',
];

function searchPrJson(item) {
  return {
    number: item.number,
    title: item.title,
    body: item.body || '',
    state: item.pull_request?.merged_at ? 'MERGED' : upper(item.state),
    author: userRef(item.user),
    repository: { nameWithOwner: item.repository_url.replace('https://api.github.com/repos/', '') },
    url: item.html_url,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    closedAt: item.closed_at,
    labels: labelRefs(item.labels),
    isDraft: !!item.draft,
    commentsCount: item.comments,
    id: item.node_id,
  };
}

async function searchPrs(args) {
  const { flags, positional } = parseArgs('search prs', args, FLAG_SPECS['search prs']);
  const { values, repoArg } = distribute('search prs', positional, ['query'], flags);
  if (!values.query) cli.die('search prs: query required');
  if (flags.repo && repoArg) {
    cli.die(`search prs: repository specified twice — --repo ${flags.repo} and positional ${repoArg}. Pass only one.`);
  }
  const repo = flags.repo || repoArg || await inferRepo();
  const q = values.query + ' type:pr' + (repo ? ' repo:' + repo : '') + (flags.state ? ' state:' + flags.state : '');
  let results;
  try {
    const data = await api.get('/search/issues', { params: { q, per_page: Math.min(parseInt(flags.limit, 10) || 20, 100) } });
    results = data.items;
  } catch (e) { fail('search prs', e); }

  const fields = parseFields('search prs', flags.json, SEARCH_PR_FIELDS);
  if (fields !== undefined) {
    await outputJson(results.map(i => pickFields(searchPrJson(i), fields)), flags);
    return;
  }

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
  const { flags, positional } = parseArgs('vars list', args, FLAG_SPECS['vars list']);
  const { repoArg } = distribute('vars list', positional, [], flags);
  const repo = await repoFrom('vars list', flags, repoArg);
  let vars;
  try {
    const data = await api.get(`/repos/${repo}/actions/variables`, { params: { per_page: Math.min(parseInt(flags.limit, 10) || 30, 100) } });
    vars = data.variables;
  } catch (e) { fail('vars list', e); }

  const fields = parseFields('vars list', flags.json, ['name', 'value', 'createdAt', 'updatedAt']);
  if (fields !== undefined) {
    await outputJson((vars || []).map(v => pickFields({
      name: v.name, value: v.value, createdAt: v.created_at, updatedAt: v.updated_at,
    }, fields)), flags);
    return;
  }

  if (!vars || !vars.length) { console.log(color.gray('No variables.')); return; }

  const rows = vars.map(v => [color.cyan(fmt.trunc(v.name, 32)), fmt.trunc(v.value, 60)]);
  console.log(fmt.table(rows, [36]));
}

// ─── vars set ────────────────────────────────────────────────────────────────

async function varsSet(args) {
  const { flags, positional } = parseArgs('vars set', args, FLAG_SPECS['vars set']);
  const { values, repoArg } = distribute('vars set', positional, ['name', 'value'], flags);
  if (!values.name) cli.die('vars set: name required');
  const rawValue = values.value !== null && values.value !== undefined ? values.value : flags.body;
  if (rawValue === undefined || rawValue === null) cli.die('vars set: value required');
  const repo = await repoFrom('vars set', flags, repoArg);
  const name = validateVarName(values.name), value = rawValue;

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
  const { flags, positional } = parseArgs('repo archive', args, FLAG_SPECS['repo archive']);
  const { repoArg } = distribute('repo archive', positional, [], flags);
  const repo = await repoFrom('repo archive', flags, repoArg);
  try {
    await api.patch(`/repos/${repo}`, { body: { archived: true } });
    console.log(sym('success') + ' Archived ' + color.cyan(repo));
  } catch (e) { fail('repo archive', e); }
}

// ─── branch create ───────────────────────────────────────────────────────────

async function branchCreate(args) {
  const usage = 'usage: gh branch create <name> [--from <ref>] [-R owner/repo] [repo]';
  const { flags, positional } = parseArgs('branch create', args, FLAG_SPECS['branch create']);
  const { values, repoArg } = distribute('branch create', positional, ['name'], flags);
  if (!values.name) cli.die('branch create: branch name required\n' + usage);
  const branchName = values.name;
  let from = flags.from ? flags.from.trim() : null;
  const repo = await repoFrom('branch create', flags, repoArg);

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
  const { flags, positional } = parseArgs('branch delete', args, FLAG_SPECS['branch delete']);
  const { values, repoArg } = distribute('branch delete', positional, ['name'], flags);
  if (!values.name) cli.die('branch delete: branch name required');
  const branchName = values.name;
  const repo = await repoFrom('branch delete', flags, repoArg);
  try {
    await api.delete(`/repos/${repo}/git/refs/heads/${branchName}`);
    console.log(sym('success') + ' Deleted branch ' + color.cyan(branchName) + ' from ' + repo);
  } catch (e) { fail('branch delete', e); }
}

// ─── content put ─────────────────────────────────────────────────────────────

async function contentPut(args) {
  const usage = 'usage: gh content put <path> <local-file> <message> [--branch <branch>] [-R owner/repo] [repo]';
  const { flags, positional } = parseArgs('content put', args, FLAG_SPECS['content put']);
  const { values, repoArg } = distribute('content put', positional, ['path', 'file', 'message'], {
    ...flags,
    message: flags.message,
  });
  if (!values.path) cli.die('content put: file path required\n' + usage);
  if (!values.file) cli.die('content put: local file required\n' + usage);
  if (!values.message) cli.die('content put: commit message required\n' + usage);
  const filePath = values.path, localFile = values.file, message = values.message;
  const branch = flags.branch ? flags.branch.trim() : null;
  const repo = await repoFrom('content put', flags, repoArg);

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

// Expand upstream-style bracket notation in `-f` keys into a nested request
// body, so `-f 'tree[0][path]=x' -f 'parents[]=sha'` builds
// `{tree:[{path:"x"}], parents:["sha"]}` rather than storing the bracketed key
// literally. references/gotchas.md has documented this syntax as the way to
// commit a mode-120000 symlink through the Git Data API, but the parser used to
// keep `tree[0][path]` as a flat key, so GitHub answered "Invalid tree info".
// Keys with no brackets are assigned verbatim, so existing callers are unaffected.
function assignField(body, rawKey, value) {
  const m = rawKey.match(/^([^[\]]+)((?:\[[^[\]]*\])*)$/);
  if (!m || !m[2]) { body[rawKey] = value; return; }
  const segs = [m[1]];
  for (const b of m[2].matchAll(/\[([^[\]]*)\]/g)) segs.push(b[1]);
  let cur = body;
  for (let i = 0; i < segs.length; i++) {
    const raw = segs[i];
    const isLast = i === segs.length - 1;
    // An empty `[]` appends; a numeric index addresses an array slot.
    const key = raw === '' ? (Array.isArray(cur) ? cur.length : 0)
      : /^\d+$/.test(raw) ? Number(raw) : raw;
    if (isLast) { cur[key] = value; continue; }
    const nxt = segs[i + 1];
    const nextIsIndex = nxt === '' || /^\d+$/.test(nxt);
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = nextIsIndex ? [] : {};
    cur = cur[key];
  }
}

async function apiPassthrough(args) {
  const usage = 'usage: gh api <path> [-X METHOD] [-f key=value]... [--jq <expr>]';
  if (!args[0]) cli.die(usage);
  let method = 'GET', jqExpr = null;
  const fields = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    // Upstream spells the verb -X/--method and the filter --jq/-q; both work.
    if ((args[i] === '-X' || args[i] === '--method') && args[i+1]) { method = args[++i].toUpperCase(); }
    else if (args[i].startsWith('--method=')) { method = args[i].slice(9).toUpperCase(); }
    else if ((args[i] === '--jq' || args[i] === '-q') && args[i+1]) { jqExpr = args[++i]; }
    else if (args[i].startsWith('--jq=')) { jqExpr = args[i].slice(5); }
    else if ((args[i] === '-f' || args[i] === '--field' || args[i] === '-F' || args[i] === '--raw-field') && args[i+1]) {
      const [k, ...vParts] = args[++i].split('=');
      assignField(fields, k, vParts.join('='));
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
      // Full jq when the shell provides it, path-evaluator fallback otherwise.
      console.log(await applyJq(jqExpr, result));
    } else {
      cli.out(result);
    }
  } catch (e) { fail('api ' + path, e); }
}

// ─── help ────────────────────────────────────────────────────────────────────
// Every command and subcommand group is self-documenting, and --help/-h is
// intercepted BEFORE any argument validation (see the router at the bottom) so
// that `gh pr --help` and `gh pr watch --help` print usage instead of dying
// with "unknown subcommand" / "Invalid PR number". `gh help <cmd> [<sub>]`
// works too. Discoverability is the point: an agent's first move on an
// unfamiliar CLI is --help, and if that fails it has no path to anything else.

const REPO_HELP = '-R, --repo <owner/repo>   target repository (or pass it as the trailing positional)';
const JSON_HELP = '--json [fields]           JSON output, optionally restricted to a comma-separated field list';
const JQ_HELP = '-q, --jq <expr>           filter the --json output through a jq expression';

const HELP = {
  pr: {
    summary: 'Work with pull requests',
    subs: {
      list: {
        usage: [
          'gh pr list [--state open|closed|merged|all] [--limit N] [--base B] [--head H] [--draft]',
          'gh pr list [repo]',
        ],
        desc: 'List pull requests',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '-s, --state <state>       open (default), closed, merged, all',
          '-L, --limit <n>           max results (default 30)',
          '-B, --base <branch>       filter by base branch',
          '-H, --head <branch>       filter by head branch',
          '-d, --draft               only draft PRs'],
      },
      view: {
        usage: [
          'gh pr view <num> [--json statusCheckRollup,reviews,comments,mergeable] [--comments]',
          'gh pr view <num> [repo]',
        ],
        desc: 'View a PR: title, author, branches, check summary, body',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP, '-c, --comments            also print the PR comments'],
        notes: ['JSON fields: ' + PR_VIEW_FIELDS.join(', ')],
      },
      checks: {
        usage: ['gh pr checks <num> [--json] [--watch]', 'gh pr checks <num> [repo]'],
        desc: 'Per-check status/conclusion for the PR head commit',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '--watch                   install the event-driven watch (SLICC equivalent of upstream polling;',
          '                          mutates the repo — see `gh pr watch`)',
          '--filter <js>             passed through to the watch; drops events before they reach the scoop',
          '--scoop <name>            scoop that should receive the watch licks'],
        notes: ['JSON fields: ' + PR_CHECKS_FIELDS.join(', ')],
      },
      create: {
        usage: [
          'gh pr create --title <t> --body <b> --head <branch> [--base <base>] [--draft]',
          'gh pr create <title> <body> <head-branch> [--base=<base>] [--draft] [repo]',
        ],
        desc: 'Open a pull request',
        flags: [REPO_HELP,
          '-t, --title <title>       PR title',
          '-b, --body <body>         PR body',
          '-F, --body-file <path>    read the body from a file',
          '-H, --head <branch>       branch to merge from',
          '-B, --base <branch>       branch to merge into (default: the repo default branch)',
          '-d, --draft               open as a draft',
          '-l, --label <name>        add a label (repeatable, comma-separated ok)',
          '-a, --assignee <user>     assign a user (repeatable)',
          '-r, --reviewer <user>     request a reviewer (repeatable; org/team for teams)'],
        notes: ['A value supplied both as a flag and as a positional is an error, never silently picked.'],
      },
      merge: {
        usage: ['gh pr merge <num> [--squash|--rebase|--merge] [--delete-branch]', 'gh pr merge <num> [--squash] [repo]'],
        desc: 'Merge a pull request',
        flags: [REPO_HELP,
          '-m, --merge               merge commit (default)',
          '-s, --squash              squash merge',
          '-r, --rebase              rebase merge',
          '-d, --delete-branch       delete the head branch afterwards',
          '-t, --subject <text>      commit title',
          '-b, --body <text>         commit message body',
          '-F, --body-file <path>    read the commit message body from a file'],
      },
      close: {
        usage: ['gh pr close <num> [--comment <text>] [--delete-branch]', 'gh pr close <num> [repo]'],
        desc: 'Close a pull request without merging',
        flags: [REPO_HELP, '-c, --comment <text>      leave a closing comment', '-d, --delete-branch       delete the head branch'],
      },
      comment: {
        usage: ['gh pr comment <num> --body <text>', 'gh pr comment <num> <message> [repo]'],
        desc: 'Post a comment on a pull request',
        flags: [REPO_HELP, '-b, --body <text>         comment body', '-F, --body-file <path>    read the body from a file'],
      },
      checkout: {
        usage: ['gh pr checkout <num> [-R owner/repo]', 'gh pr checkout <num> [repo]'],
        desc: 'Print the git fetch/checkout commands for a PR (does not execute them)',
        flags: [REPO_HELP],
      },
      watch: {
        usage: ['gh pr watch <num> [--filter <js>] [--scoop <name>] [-R owner/repo]', 'gh pr watch <num> [repo]'],
        desc: 'Watch a PR event-driven: PR/review/CI events arrive as licks',
        flags: [REPO_HELP,
          '--filter <js>             JS predicate passed to `webhook create --filter`, drops noisy events',
          '--scoop <name>            receiving scoop (default: $SLICC_SCOOP)'],
        notes: [
          'Installs a SLICC webhook plus a GitHub repo webhook. Idempotent.',
          'Mutates the repository. Tear it down with `gh pr unwatch <num>`.',
          'See references/webhook-pr-monitoring.md for the self-echo-detection pattern',
          'a scoop needs when watching its own PR.',
        ],
      },
      unwatch: {
        usage: ['gh pr unwatch <num> [-R owner/repo]', 'gh pr unwatch <num> [repo]'],
        desc: 'Stop watching a PR; removes the GitHub hook and the SLICC webhook',
        flags: [REPO_HELP],
      },
    },
  },
  issue: {
    summary: 'Work with issues',
    subs: {
      list: {
        usage: ['gh issue list [--state open|closed|all] [--label L] [--assignee U] [--json]', 'gh issue list [repo]'],
        desc: 'List issues (pull requests filtered out)',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '-s, --state <state>       open (default), closed, all',
          '-L, --limit <n>           max results (default 30)',
          '-l, --label <name>        filter by label (repeatable)',
          '-a, --assignee <user>     filter by assignee',
          '-A, --author <user>       filter by author',
          '-m, --milestone <ms>      filter by milestone'],
      },
      view: {
        usage: ['gh issue view <num> [--json] [--comments]', 'gh issue view <num> [repo]'],
        desc: 'View an issue',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP, '-c, --comments            also print the issue comments'],
        notes: ['JSON fields: ' + [...ISSUE_FIELDS, 'comments'].join(', ')],
      },
      create: {
        usage: [
          'gh issue create --title <t> --body <b> [--label L] [--assignee U]',
          'gh issue create <title> <body> [--label=L]... [--labels=a,b] [repo]',
        ],
        desc: 'Create an issue',
        flags: [REPO_HELP,
          '-t, --title <title>       issue title',
          '-b, --body <body>         issue body',
          '-F, --body-file <path>    read the body from a file',
          '-l, --label <name>        add a label (repeatable, comma-separated ok)',
          '--labels <a,b>            comma-separated labels (original spelling)',
          '-a, --assignee <user>     assign a user (repeatable)',
          '-m, --milestone <ms>      milestone number'],
      },
      comment: {
        usage: ['gh issue comment <num> --body <text>', 'gh issue comment <num> <message> [repo]'],
        desc: 'Post a comment on an issue',
        flags: [REPO_HELP, '-b, --body <text>         comment body', '-F, --body-file <path>    read the body from a file'],
      },
      close: {
        usage: ['gh issue close <num> [--reason completed|not_planned] [--comment <text>]', 'gh issue close <num> [--reason=completed] [repo]'],
        desc: 'Close an issue',
        flags: [REPO_HELP, '--reason <reason>         completed | not_planned', '-c, --comment <text>      leave a closing comment'],
      },
      edit: {
        usage: [
          'gh issue edit <num> [--title T] [--body B] [--add-label L] [--remove-label L] [--state S]',
          'gh issue edit <num> [--title=T] [--body=B] [--label=L]... [repo]',
        ],
        desc: 'Edit an issue',
        flags: [REPO_HELP,
          '-t, --title <title>       new title',
          '-b, --body <body>         new body',
          '-F, --body-file <path>    read the new body from a file',
          '--state <state>           open | closed',
          '-l, --label <name>        replace the label set (repeatable)',
          '--add-label <name>        add a label, keeping existing ones',
          '--remove-label <name>     remove a label',
          '--add-assignee <user>     add an assignee',
          '--remove-assignee <user>  remove an assignee',
          '-m, --milestone <ms>      milestone number'],
      },
    },
  },
  repo: {
    summary: 'Work with repositories',
    subs: {
      view: {
        usage: ['gh repo view [-R owner/repo] [--json]', 'gh repo view [repo]'],
        desc: 'Show repository information',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP],
        notes: ['JSON fields: ' + REPO_FIELDS.join(', ')],
      },
      archive: {
        usage: ['gh repo archive [-R owner/repo]', 'gh repo archive [repo]'],
        desc: 'Archive a repository (irreversible without admin unarchive)',
        flags: [REPO_HELP],
      },
    },
  },
  branch: {
    summary: 'Create and delete branches via the git refs API',
    subs: {
      create: {
        usage: ['gh branch create <name> [--from <ref>] [-R owner/repo]', 'gh branch create <name> [--from=<ref>] [repo]'],
        desc: 'Create a branch from a ref or SHA (default: the repo default branch)',
        flags: [REPO_HELP, '--from <ref>              branch, tag or 40-char SHA to branch from'],
      },
      delete: {
        usage: ['gh branch delete <name> [-R owner/repo]', 'gh branch delete <name> [repo]'],
        desc: 'Delete a branch',
        flags: [REPO_HELP],
      },
    },
  },
  content: {
    summary: 'Create or update files through the Contents API',
    subs: {
      put: {
        usage: [
          'gh content put <path> <local-file> <message> [--branch <b>] [-R owner/repo]',
          'gh content put <path> <local-file> <msg> [--branch=<b>] [repo]',
        ],
        desc: 'Upload a local file to a repository path (SHA lookup is automatic)',
        flags: [REPO_HELP, '-b, --branch <branch>     target branch', '-m, --message <msg>       commit message (or pass it positionally)'],
      },
    },
  },
  run: {
    summary: 'Inspect GitHub Actions workflow runs',
    subs: {
      list: {
        usage: ['gh run list [--branch B] [--workflow W] [--status S] [--limit N] [--json]', 'gh run list [repo]'],
        desc: 'List recent workflow runs',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '-L, --limit <n>           max results (default 20)',
          '-b, --branch <branch>     filter by branch',
          '-w, --workflow <file|id>  filter by workflow',
          '-e, --event <event>       filter by triggering event',
          '-s, --status <status>     filter by status/conclusion',
          '-u, --user <login>        filter by actor'],
      },
      view: {
        usage: ['gh run view <run_id> [--log-failed] [--log] [--json]', 'gh run view <run_id> [repo]'],
        desc: 'View a run, its jobs, and optionally the job logs',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '--log-failed              print logs for the failed jobs only',
          '--log                     print logs for every job',
          '--log-tail <n>            tail the log to n lines (default 200, 0 = whole log)',
          '-j, --job <id|name>       restrict --log/--log-failed to one job'],
        notes: [
          'Logs come from the Actions logs API (GET /actions/jobs/<id>/logs).',
          'If a download is refused, the failed steps and their conclusions are printed instead.',
        ],
      },
    },
  },
  release: {
    summary: 'Inspect releases',
    subs: {
      list: {
        usage: ['gh release list [--limit N] [--json]', 'gh release list [repo]'],
        desc: 'List recent releases',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP, '-L, --limit <n>           max results (default 15)'],
      },
    },
  },
  search: {
    summary: 'Search GitHub',
    subs: {
      prs: {
        usage: ['gh search prs <query> [-R owner/repo] [--json]', 'gh search prs <query> [repo]'],
        desc: 'Search pull requests by keyword',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '-L, --limit <n>           max results (default 20)',
          '--state <state>           add state: to the query'],
      },
    },
  },
  vars: {
    summary: 'Manage Actions variables',
    subs: {
      list: {
        usage: ['gh vars list [-R owner/repo] [--json]', 'gh vars list [repo]'],
        desc: 'List Actions variables',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP, '-L, --limit <n>           max results (default 30)'],
      },
      set: {
        usage: ['gh vars set <name> <value> [-R owner/repo]', 'gh vars set <name> <value> [repo]'],
        desc: 'Create or update an Actions variable',
        flags: [REPO_HELP, '-b, --body <value>        variable value (alternative to the positional)'],
      },
    },
  },
  notifications: {
    summary: 'Read your notification inbox',
    subs: {
      list: {
        usage: ['gh notifications list [--all] [-p] [-R owner/repo] [-n 30] [--json]', 'gh notifications list [--all] [-p] [--repo=r] [-nN]'],
        desc: 'List notifications, grouped by repository',
        flags: [REPO_HELP, JSON_HELP, JQ_HELP,
          '-a, --all                 include read notifications',
          '-p, --participating       only notifications you participate in',
          '-n, --limit <n>           max results (default 30; the glued -nN form still works)'],
      },
      read: {
        usage: ['gh notifications read [-R owner/repo]', 'gh notifications read [--repo=r]'],
        desc: 'Mark notifications as read (all, or one repository)',
        flags: [REPO_HELP],
      },
    },
  },
  project: {
    summary: 'Org-owned Projects (v2) — org-scoped, never owner/repo. Needs the `project` token scope.',
    subs: {
      list: {
        usage: ['gh project list <org>', 'gh project list --owner <org>'],
        desc: "List an organisation's Projects (v2)",
        flags: ['-o, --owner <org>         org login (alternative to the positional)'],
      },
      'list-items': {
        usage: ['gh project list-items <org> <project_number>'],
        desc: 'List the items in a project',
        flags: ['-o, --owner <org>         org login (alternative to the positional)'],
      },
      'add-draft': {
        usage: [
          'gh project add-draft <org> <project_number> <title> [body]',
          'gh project add-draft <org> <project_number> --title <t> [--body <b>]',
        ],
        desc: 'Create a standalone draft item (no repo or real issue needed)',
        flags: ['-o, --owner <org>         org login (alternative to the positional)',
          '-t, --title <title>       draft title',
          '-b, --body <body>         draft body'],
      },
      'set-title': {
        usage: [
          'gh project set-title <org> <project_number> <item_id> <new_title>',
          'gh project set-title <org> <project_number> <item_id> --title <t>',
        ],
        desc: 'Rename a project item (draft or linked issue/PR)',
        flags: ['-o, --owner <org>         org login (alternative to the positional)',
          '-t, --title <title>       new title'],
      },
    },
  },
  api: {
    summary: 'Raw GitHub REST API passthrough',
    standalone: {
      usage: ['gh api <path> [-X METHOD] [-f key=value]... [--jq <expr>]'],
      desc: 'Call any REST endpoint with this tool\u2019s auth',
      flags: ['-X, --method <verb>       GET (default), POST, PUT, PATCH, DELETE',
        '-f, --field <key=value>   body field (repeatable), sent as JSON on non-GET',
        '-q, --jq <expr>           filter the response through a jq expression'],
      notes: [
        'Bodies are built from -f flags, never from @file — see references/gotchas.md.',
        "-f keys accept bracket notation for nested bodies: -f 'tree[0][path]=x' and",
        '-f \'parents[]=sha\' build {"tree":[{"path":"x"}],"parents":["sha"]}.',
      ],
    },
  },
  auth: {
    summary: 'Show authentication status',
    standalone: {
      usage: ['gh auth status'],
      desc: 'Show which token is in use, the authenticated user, and AI-attribution status',
      flags: [],
      notes: ["Token resolution: skill.token('github'), then `git config github.token`, then $GITHUB_TOKEN."],
    },
  },
  monday: {
    summary: 'Monday-protocol inbox (machine-readable JSON)',
    standalone: {
      usage: ['gh monday [--limit N] [--depth N] [--date 7d]'],
      desc: 'Emit notifications, review requests and assigned issues as one JSON array',
      flags: ['--limit <n>               max items (default 50)',
        '--depth <n>               comment thread depth (default 5)',
        '--date <spec>             lookback window, e.g. 7d (default 7d)'],
    },
  },
  version: {
    summary: 'Print the gh.jsh version',
    standalone: { usage: ['gh version'], desc: 'Print the version of this GitHub CLI', flags: [] },
  },
};

const GH_VERSION = 'gh.jsh (SLICC GitHub CLI) 2.0.0';

function helpBlock(lines) {
  return lines.map((l) => '  ' + l).join('\n');
}

function renderSubHelp(cmd, sub, entry) {
  const parts = [color.bold('gh ' + cmd + (sub ? ' ' + sub : '')) + (entry.desc ? ' — ' + entry.desc : '')];
  parts.push('\n' + color.bold('USAGE') + '\n' + helpBlock(entry.usage));
  if (entry.flags && entry.flags.length) parts.push('\n' + color.bold('FLAGS') + '\n' + helpBlock(entry.flags));
  if (entry.notes && entry.notes.length) parts.push('\n' + color.bold('NOTES') + '\n' + helpBlock(entry.notes));
  parts.push('\n' + color.gray('Upstream-gh flag forms and this CLI\u2019s original positional forms are both accepted.'));
  cli.help(parts.join('\n'));
}

function renderCommandHelp(cmd, entry) {
  if (entry.standalone) { renderSubHelp(cmd, null, entry.standalone); return; }
  const lines = [color.bold('gh ' + cmd) + ' — ' + entry.summary];
  lines.push('\n' + color.bold('SUBCOMMANDS'));
  for (const [sub, e] of Object.entries(entry.subs)) {
    lines.push('  ' + color.cyan(fmt.col(sub, 13)) + (e.desc || ''));
  }
  lines.push('\n' + color.bold('USAGE'));
  for (const e of Object.values(entry.subs)) lines.push('  ' + e.usage[0]);
  lines.push('\n' + color.gray('Run `gh ' + cmd + ' <subcommand> --help` for one subcommand\u2019s flags.'));
  cli.help(lines.join('\n'));
}

// Prints the most specific help available for what the caller reached for, and
// exits 0 — never an error, whatever the rest of the command line looks like.
function showScopedHelp(cmd, sub) {
  if (!cmd || !HELP[cmd]) { showHelp(); return; }
  const entry = HELP[cmd];
  if (sub && entry.subs && entry.subs[sub]) { renderSubHelp(cmd, sub, entry.subs[sub]); return; }
  if (sub && entry.subs) {
    cli.help(
      color.bold('gh ' + cmd) + ' — ' + entry.summary + '\n\n' +
      color.yellow('No subcommand "' + sub + '" under `gh ' + cmd + '`.') + '\n\n' +
      color.bold('SUBCOMMANDS') + '\n' +
      Object.entries(entry.subs).map(([k, e]) => '  ' + color.cyan(fmt.col(k, 13)) + (e.desc || '')).join('\n')
    );
    return;
  }
  renderCommandHelp(cmd, entry);
}

function showHelp() {
  cli.help(`${color.bold('gh.jsh')} — GitHub CLI for SLICC agents

${color.bold('USAGE')}
  gh <command> <subcommand> [args] [flags] [owner/repo]

${color.bold('UPSTREAM-COMPATIBLE')}
  Named flags (${color.cyan('--title')}, ${color.cyan('--body')}, ${color.cyan('-R owner/repo')}), ${color.cyan('--json [fields]')} with ${color.cyan('--jq')},
  and ${color.cyan('--help')} on every command behave as they do in the real GitHub CLI.
  The original all-positional forms keep working unchanged.

${color.bold('COMMANDS')}
  ${color.cyan('pr list')}       [--state S] [--limit N] [--json] [repo]      List pull requests
  ${color.cyan('pr view')}       <num> [--json f1,f2] [--comments] [repo]     View PR details and checks
  ${color.cyan('pr checks')}     <num> [--json] [--watch] [repo]              Per-check status for the PR head
  ${color.cyan('pr create')}     --title T --body B --head BR [--base M] [--draft]  Open a PR
  ${color.cyan('pr merge')}      <num> [--squash|--rebase] [--delete-branch]  Merge a PR
  ${color.cyan('pr close')}      <num> [--comment T] [repo]                   Close a PR without merging
  ${color.cyan('pr comment')}    <num> --body T [repo]                        Post a comment
  ${color.cyan('pr checkout')}   <num> [repo]                                 Print checkout commands
  ${color.cyan('pr watch')}      <num> [--filter <js>] [--scoop <name>]       Watch a PR via webhook
  ${color.cyan('pr unwatch')}    <num> [repo]                                 Stop watching a PR
  ${color.cyan('issue list')}    [--state S] [--label L] [--json] [repo]      List issues
  ${color.cyan('issue view')}    <num> [--json] [--comments] [repo]           View issue details
  ${color.cyan('issue create')}  --title T --body B [--label L] [repo]        Create issue
  ${color.cyan('issue close')}   <num> [--reason completed|not_planned]       Close an issue
  ${color.cyan('issue comment')} <num> --body T [repo]                        Comment on an issue
  ${color.cyan('issue edit')}    <num> [--title T] [--add-label L] [--state S]  Edit an issue
  ${color.cyan('repo view')}     [--json] [repo]                              Show repository info
  ${color.cyan('repo archive')}  [repo]                                       Archive a repository
  ${color.cyan('run list')}      [--branch B] [--json] [repo]                 List recent workflow runs
  ${color.cyan('run view')}      <run_id> [--log-failed] [--json] [repo]      Run details, jobs and logs
  ${color.cyan('release list')}  [--json] [repo]                              List recent releases
  ${color.cyan('search prs')}    <query> [--json] [repo]                      Search PRs by keyword
  ${color.cyan('vars list')}     [--json] [repo]                              List Actions variables
  ${color.cyan('vars set')}      <name> <value> [repo]                        Set an Actions variable
  ${color.cyan('branch create')} <name> [--from <ref>] [repo]                 Create a branch
  ${color.cyan('branch delete')} <name> [repo]                                Delete a branch
  ${color.cyan('content put')}   <path> <local-file> <msg> [--branch B]       Create/update a file
  ${color.cyan('project list')}       <org>                                   List org-owned Projects (v2)
  ${color.cyan('project list-items')} <org> <project_number>                   List items in a project
  ${color.cyan('project add-draft')}  <org> <project_number> <title> [body]    Create a draft item
  ${color.cyan('project set-title')}  <org> <project_number> <item_id> <title>  Rename a project item
  ${color.cyan('api')}           <path> [-X METHOD] [-f key=val]... [--jq E]  Raw API call
  ${color.cyan('notifications list')}  [--all] [-p] [-n N] [--json]           List notifications
  ${color.cyan('notifications read')}  [-R owner/repo]                        Mark notifications as read
  ${color.cyan('auth')}          status                                       Show auth status
  ${color.cyan('monday')}        [--limit N] [--date Nd]                      Monday protocol inbox (JSON)
  ${color.cyan('version')}                                                    Print the version

${color.bold('HELP')}
  gh <command> --help                 e.g. gh pr --help
  gh <command> <subcommand> --help    e.g. gh pr create --help
  gh help <command> [<subcommand>]

${color.bold('AUTH')}
  Uses skill.token('github') (preferred), falls back to:
  git config github.token <PAT>               # persistent PAT
  exp${''}ort GITHUB_TOKEN=<PAT>                   # session PAT

${color.bold('REPO')}
  Defaults to the current git remote origin. Override with ${color.cyan('-R owner/repo')} or the
  trailing positional ${color.cyan('owner/repo')} — but never both.`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

// --help / -h is handled FIRST — before dispatch, before any argument
// validation — so it can never be mistaken for a subcommand or a PR number.
const HELP_FLAGS = ['--help', '-h', '-?'];

// Help wins early, but must never swallow a help-looking *value*: `gh issue
// create "title" "-h"` and `gh pr comment 5 --body "-h"` have to post the data,
// not print help. So a token only counts as a help request when it is in a flag
// position (not consumed as the value of a preceding flag, not after `--`), and
// the terse `-h`/`-?` spellings additionally only count while we are still in
// the leading command-word region — after positional data has started they are
// treated as data. `--help` keeps working anywhere, e.g. `gh pr view 1 --help`.
//
// Crucially, "consumed as the value of a preceding flag" is decided from the
// real flag definitions (FLAG_SPECS) rather than assumed: a boolean flag takes
// no value, so `gh pr merge 42 --squash --help` prints help instead of merging.

// Resolves the FLAG_SPECS entry for an argv, so help detection can ask the same
// definitions the command itself will use. Unknown command/subcommand ⇒ empty
// spec, in which case nothing is treated as consuming a value (matching
// parseArgs, which passes unrecognised flags through as positionals).
function specForArgv(args) {
  const a = args[0] === 'help' ? args.slice(1) : args;
  const cmd = a[0] && a[0][0] !== '-' ? a[0] : null;
  const sub = a[1] && a[1][0] !== '-' ? a[1] : null;
  if (cmd && sub && FLAG_SPECS[`${cmd} ${sub}`]) return FLAG_SPECS[`${cmd} ${sub}`];
  if (cmd && FLAG_SPECS[cmd]) return FLAG_SPECS[cmd];
  return {};
}

function helpRequested(args) {
  const spec = specForArgv(args);
  const mutating = !!isMutating(args[0], args[1]);
  let words = 0;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') return false;
    if (t === '--help') return true;
    if (HELP_FLAGS.includes(t)) {
      // Terse `-h`/`-?`: help while still in the command-word region AND with
      // no positional data after it, so `gh search prs "-h" owner/repo`
      // searches for the literal string while `gh pr create -h` prints help.
      // For mutating commands a bare, unconsumed `-h` always means help — no
      // such command takes `-h` as a real flag, and silently treating it as
      // data (or ignoring it) would perform a write the caller never asked
      // for. Use `--` to pass a literal `-h`: `gh vars set FOO -- -h`.
      if (mutating) return true;
      if (words > 2) return false;
      return !args.slice(i + 1).some((later) => later[0] !== '-');
    }
    if (t[0] === '-' && t.length > 1) {
      // Only skip the next token when this flag really consumes a value.
      if (flagConsumesNext(spec, t, args[i + 1])) i++;
      continue;
    }
    words++;
  }
  return false;
}

if (!argv.length || argv[0] === 'help' || helpRequested(argv)) {
  const words = (argv[0] === 'help' ? argv.slice(1) : argv).filter((a) => a[0] !== '-');
  showScopedHelp(words[0], words[1]);
  process.exit(0); // defensive: cli.help() already exits 0
}

if (argv[0] === 'version' || argv[0] === '--version') {
  console.log(GH_VERSION);
  process.exit(0);
}

const cmd  = argv[0];
const sub  = argv[1];
const rest = argv.slice(2);

if (cmd === 'auth') { await authStatus(); process.exit(0); }
if (cmd === 'api') { await apiPassthrough(argv.slice(1)); process.exit(0); }
// slice(1), not slice(2): `cmd` is argv[0], so argv[1] is already the first
// flag. Slicing 2 silently ate `--limit` (the first flag monday passes), which
// left limit pinned at its 50 default while --depth/--date still parsed.
if (cmd === 'monday') { await mondayGh(argv.slice(1)); process.exit(0); }

const dispatch = {
  pr:      { list: () => prList(rest),      view: () => prView(rest),    checks: () => prChecks(rest), merge: () => prMerge(rest), close: () => prClose(rest), comment: () => prComment(rest), checkout: () => prCheckout(rest), create: () => prCreate(rest), watch: () => prWatch(rest), unwatch: () => prUnwatch(rest) },
  issue:   { list: () => issueList(rest),   view: () => issueView(rest), create: () => issueCreate(rest), comment: () => issueComment(rest), close: () => issueClose(rest), edit: () => issueEdit(rest) },
  repo:    { view: () => repoView(rest), archive: () => repoArchive(rest) },
  branch:  { create: () => branchCreate(rest), delete: () => branchDelete(rest) },
  content: { put: () => contentPut(rest) },
  run:     { list: () => runList(rest),     view: () => runView(rest) },
  release: { list: () => releaseList(rest) },
  search:  { prs:  () => searchPrs(rest) },
  vars:    { list: () => varsList(rest),    set:  () => varsSet(rest) },
  notifications: { list: () => notificationsList(rest), read: () => notificationsRead(rest) },
  project: { list: () => projectList(rest), 'list-items': () => projectListItems(rest), 'add-draft': () => projectAddDraft(rest), 'set-title': () => projectSetTitle(rest) },
};

if (!dispatch[cmd]) cli.die("unknown command: '" + cmd + "'. Run gh --help for usage.");
if (!sub || !dispatch[cmd][sub]) {
  cli.die(
    "unknown subcommand: '" + cmd + ' ' + (sub || '') + "'. Run `gh " + cmd +
    ' --help` for this command\u2019s subcommands, or `gh --help` for everything.'
  );
}

try {
  await dispatch[cmd][sub]();
} catch (err) {
  if (err.name === 'NodeExitError') throw err; // re-throw exit signals
  cli.die(cmd + ' ' + sub + ' failed: ' + (err.body?.message || err.message), { prefix: 'gh' });
}
