/**
 * fetch-snapshot.mjs — the build system for the github-dashboard sprinkle.
 *
 * CANONICAL PATH: /shared/sprinkles/github-dashboard/fetch-snapshot.mjs
 * It used to live in /tmp/ghd/, which is scratch: one reboot away from losing
 * the only copy of the whole pipeline. Any copy still under /tmp/ghd/ is a
 * scratch duplicate with no authority, and
 * a .bak copy next to this file is the operator's safety net —
 * not a home, and not to be edited.
 *
 * CONFIGURATION lives in /shared/github-monitor/config.json (which repos to
 * watch, their bb project ids, the bb origin). Nothing about the monitored set
 * is hard-coded here any more; see loadMonitorConfig() for what happens when
 * that file is absent, malformed, or incomplete. `--check-config` resolves the
 * configuration, prints it and exits without fetching anything.
 *
 * Emits data/snapshot.json in the record shape the panel already consumes
 * (contract measured from the panel itself, not assumed).
 *
 * Auth: the credential is obtained in-process (see obtainToken) and used only
 * as a Bearer header. It is never logged, never printed, never written to a
 * file, and never placed on a command line.
 *
 * Rate limit: remaining/limit/reset come ONLY from real response headers of the
 * calls we make. /rate_limit is never consulted (it reports a hardcoded
 * core 5000/5000 while real calls throttle).
 */

const cp = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
// Phase 7b: the panel's own working-day arithmetic, so the "this record will be
// hidden, do not spawn an agent" test is the same rule the panel classifies by.
// Shipped beside this file (it used to be required from /tmp/ghd/, scratch that a
// clean install does not have). A LITERAL relative path: this realm resolves it
// against this file, independent of the cwd; a computed path (new URL(..., import.meta.url))
// was not found by the realm's require, measured 2026-09-23.
const { workingDaysSince } = require('./workdays-shared.cjs');

/* Phase 7b: the fetcher obtains its own credential.

   TWICE now a token has leaked into a BACKGROUNDED job's captured output when it
   was passed as `GH_TOK="$(oauth-token github)" node fetch-snapshot.mjs`: once in
   phase 6b (which I wrongly blamed on the `time` prefix) and once in the first 7b
   run, which had no `time` at all. The common factor is the detached job, not the
   prefix — a foreground control of the same form leaks nothing. So the shell never
   sees the value: node asks for it, keeps it in memory, and prints it nowhere.
   GH_TOK is still honoured for a foreground run, and stays out of every log,
   prompt and artefact either way. */
function obtainToken() {
  if (process.env.GH_TOK) return process.env.GH_TOK;
  try {
    const out = cp.execSync('oauth-token github', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1e6 });
    const tok = String(out).trim();
    if (tok) return tok;
  } catch (err) {
    console.error('oauth-token github failed: ' + String(err.message).slice(0, 120));
  }
  return '';
}

const TOK = obtainToken();
if (!TOK) {
  console.error('no GitHub credential — refusing to run anonymously (60/hr, and no private data).');
  process.exit(1);
}

/* ------------------------------------------------------- monitor config

   WHICH REPOS THIS WATCHES IS NOT A PROPERTY OF THIS SCRIPT. It lives in
   /shared/github-monitor/config.json, so that a future `gh monitor
   add|list|rm` command owns the file and this script only reads it.

   SCHEMA (v1) — designed for that command, not for this reader:

     {
       "version": 1,
       "bbOrigin": "https://bb.example.invalid",
       "repos": [
         { "slug": "owner/repo", "bbProject": "proj_xxx" | null }
       ]
     }

   • `repos` is an ARRAY of objects, not a map keyed by slug: `add` appends,
     `rm` filters, `list` prints in order, and an object leaves room for future
     per-repo fields (enabled, labels, window overrides) without a migration.
   • `slug` is the identity. Duplicates are a config ERROR rather than something
     silently deduped, because two entries for one repo means the command lost
     track and the human should hear about it.
   • `bbProject` MUST BE PRESENT, and may be explicitly `null`. This is the one
     deliberately awkward rule: thread state is bb state, and this map is its
     only source, so a repo whose project id was merely FORGOTTEN would quietly
     produce cards that can never link to a thread. Requiring the key forces
     `gh monitor add` to decide, and `null` records that the decision was "no bb
     project" rather than an oversight.

   FAILURE POLICY, one decision per case:
     absent    → fall back to the two repos this dashboard was built on and say
                 so loudly in the log and in meta.config.source. Absence is the
                 pre-7e state, not a mistake; refusing to run would break a
                 working dashboard because of a file nobody has created yet.
     malformed → REFUSE. Exit non-zero before a single request, leaving the
                 previous snapshot in place. A partial dashboard is worse than a
                 stale one: the panel labels its own age honestly, but it cannot
                 know that half the work is missing.
     bbProject
       null    → accept, and degrade LOUDLY: the repo is fetched, no bb threads
                 are looked up for it, and meta.config.reposWithoutBbProject
                 names it so the omission is visible in the artefact, not just
                 in a log line nobody re-reads.
   ---------------------------------------------------------------------- */

/* Phase 7g: CLI overrides for measurement runs.
   --cache <path>          use a different status cache (so a COLD-run measurement
                           never has to delete or move the live one)
   --prompt-version <tag>  override PROMPT_VERSION, the other way to force misses
   Both print what they did; neither changes where the snapshot is written. */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const MONITOR_CONFIG_PATH = argValue('--config') || '/shared/github-monitor/config.json';

// The set this dashboard was built on, used ONLY when the config file does not
// exist yet. Not a default to fall back to when the file is broken.
/* No built-in repositories: this skill ships without a target. The monitor
   config is REQUIRED (see MONITOR_CONFIG_PATH below and SKILL.md), because a
   dashboard that silently follows repositories the operator did not choose is
   worse than one that refuses to start. */
const BUILTIN_REPOS = [];
const BUILTIN_BB_ORIGIN = 'https://bb.example.invalid';

function configError(what) {
  console.error(`\nCONFIG ERROR in ${MONITOR_CONFIG_PATH}:\n  ${what}\n`);
  console.error('Refusing to fetch: a partial dashboard would look complete.');
  console.error('Fix the file (or delete it to fall back to the built-in repos) and run again.');
  process.exit(2);
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function loadMonitorConfig() {
  let raw;
  try {
    raw = fs.readFileSync(MONITOR_CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No config and no built-ins: REFUSE, with the shape to write. Silently
      // monitoring nothing looks like "no work today", which is a lie, and
      // defaulting to repositories the operator never chose is worse.
      configError(
        `not found. Create it with the monitored set, e.g.\n` +
          `  {\n` +
          `    "version": 1,\n` +
          `    "bbOrigin": "https://bb.example.invalid",\n` +
          `    "repos": [{ "slug": "owner/repo", "bbProject": null }]\n` +
          `  }`,
      );
    }
    configError(`unreadable (${err.message})`);
  }
  if (!raw.trim()) configError('the file is empty');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    configError(`not valid JSON — ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) configError('the top level must be a JSON object');
  if (parsed.version !== 1) configError(`unsupported "version": ${JSON.stringify(parsed.version)} (this fetcher understands 1)`);
  if (!Array.isArray(parsed.repos)) configError('"repos" must be an array');
  if (!parsed.repos.length) configError('"repos" is empty — there is nothing to monitor. Add at least one { "slug": "owner/repo", "bbProject": null } entry; there are no built-in repositories.');
  const bbOrigin = typeof parsed.bbOrigin === 'string' ? parsed.bbOrigin.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^\s/]+$/.test(bbOrigin)) configError(`"bbOrigin" must be an http(s) origin, got ${JSON.stringify(parsed.bbOrigin)}`);

  const repos = [];
  const seen = new Set();
  const without = [];
  for (const [i, entry] of parsed.repos.entries()) {
    const at = `repos[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) configError(`${at} must be an object`);
    const slug = typeof entry.slug === 'string' ? entry.slug.trim() : '';
    if (!SLUG_RE.test(slug)) configError(`${at}.slug must be "owner/repo", got ${JSON.stringify(entry.slug)}`);
    if (seen.has(slug)) configError(`${at}.slug duplicates an earlier entry (${slug})`);
    seen.add(slug);
    if (!('bbProject' in entry)) {
      configError(
        `${at} (${slug}) has no "bbProject" key. Thread state comes only from bb, so a missing ` +
          'project id would silently produce cards that can never link to a thread. Set it to a ' +
          'proj_... id, or to null to say explicitly that this repo has no bb project.',
      );
    }
    const bbProject = entry.bbProject === null ? null : typeof entry.bbProject === 'string' ? entry.bbProject.trim() : undefined;
    if (bbProject === undefined || (bbProject !== null && !/^proj_[A-Za-z0-9]+$/.test(bbProject))) {
      configError(`${at}.bbProject must be a "proj_..." id or null, got ${JSON.stringify(entry.bbProject)}`);
    }
    if (bbProject === null) without.push(slug);
    repos.push({ slug, bbProject });
  }
  if (without.length) {
    console.log(`config         : WARNING — no bb project for ${without.join(', ')}: their cards can never link to a thread`);
  }
  return {
    source: 'file',
    path: MONITOR_CONFIG_PATH,
    bbOrigin,
    repos,
    reposWithoutBbProject: without,
    note: null,
  };
}

const MONITOR = loadMonitorConfig();
const REPOS = MONITOR.repos.map((r) => r.slug);
// bb projects that correspond to those repos. Thread state is SLICC/bb state:
// it is NOT on GitHub, and this map is the only source for it. Repos configured
// with bbProject: null are deliberately absent here, so no thread lookup runs.
const BB_PROJECT = Object.fromEntries(MONITOR.repos.filter((r) => r.bbProject).map((r) => [r.slug, r.bbProject]));
const BB_ORIGIN = MONITOR.bbOrigin;

if (process.argv.includes('--check-config')) {
  console.log(JSON.stringify({ ...MONITOR, resolvedRepos: REPOS, resolvedBbProjects: BB_PROJECT }, null, 2));
  console.log('\n--check-config: configuration resolved, nothing fetched.');
  process.exit(0);
}

/* Status prose is generated ONE AGENT PER RECORD through a small worker pool,
   following ai-ecoverse/skills/monday (its rateAllItems()/worker() pattern).
   A single call for every record was the phase-3 shape; per-record agents give
   each item the model's full attention and isolate failures.

   STATUS_MODEL_HINT is a FRAGMENT, never passed to `agent` directly:
   resolveStatusModel() turns it into an EXACT id from `models --json`.
   the sibling skill documents why: `agent --model
   claude-haiku-4-5` passes validation but silently spawns the PARENT model —
   opus, ~5x the price. Exact ids are proven to carry through. */
const STATUS_MODEL_HINT = 'haiku';
// Phase 7b: 4 workers took 21m53s for 101 records (~52s per agent). The longer
// summaries this phase asks for make each call slower, so the pool grows to keep
// the wall clock in the same place. Raised deliberately, not casually: every
// worker is one more concurrent sub-scoop.
const STATUS_CONCURRENCY = 6;

/* Phase 7b, the STATUS CACHE.

   A poll cycle cannot afford 101 agent calls, and it does not need them: a
   record whose lastActivityAt has not moved has nothing new to say. The cache
   lives in its OWN file so that:
     - a fetcher run cannot lose it (snapshot.json is overwritten wholesale);
     - it is never confused with user-state.json, which belongs to panel clicks
       alone and must never be written by this script.
   Key: `owner/repo#number` — the 7a lesson, because GitHub numbers are per
   repository, so a bare `403` can name a PR in more than one of them.
   A hit requires ALL of: same lastActivityAt, same prompt version, same model.
   The prompt version is part of the key because a changed contract produces
   different prose; serving 6b text under a 7b contract would be a silent lie. */
const STATUS_CACHE_PATH = argValue('--cache') || '/shared/sprinkles/github-dashboard/data/status-cache.json';
const PROMPT_VERSION = argValue('--prompt-version') || '7b-1';

/* Target length of the CARD line. The design reserves four lines of card space, so
   a 65-character status would leave three of them blank. Measured: the status
   column is ~300px at 12px, i.e. ~48 characters per line, so four lines is
   ~190 characters. Under MIN the text is re-requested ONCE with a stricter
   instruction (a retry is far cheaper than a card that cannot fill its space);
   over MAX it is kept — an over-long line costs a fifth line, not a lie. */
const CARD_CHARS_MIN = 150;
const CARD_CHARS_TARGET = 190;
const CARD_CHARS_MAX = 240;

// The closed action vocabulary. Anything else the model emits is DROPPED and
// counted — an unknown kind reaching the panel would render as a button whose
// behaviour nobody defined.
const ACTION_KINDS = ['nudge', 'approve', 'clarify'];
const ACTION_LABEL_MAX = 40;
const ACTION_QUESTION_MAX = 160;
const ACTION_BECAUSE_MAX = 140;
const MAX_ACTIONS = 3;

// How much of an item's own text the model may see. Bodies can be enormous
// (some are long checkbox lists), so they are truncated, not summarised
// here — the model does the summarising.
const BODY_CHARS = 1200;
const COMMENT_CHARS = 400;
const MAX_COMMENTS = 3;

let STATUS_MODEL = null; // set by resolveStatusModel(), an exact catalog id

function shellArg(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

function execAsync(cmd) {
  return new Promise((resolve) => {
    cp.exec(cmd, { encoding: 'utf8', maxBuffer: 20e6 }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Exact id from the catalog, cheapest haiku-class match. Fails loudly rather
 *  than letting a bad hint fall back to an expensive parent model. */
async function resolveStatusModel(hint) {
  const r = await execAsync('models --json');
  if (r.exitCode !== 0) throw new Error('models --json failed: ' + r.stderr.slice(0, 200));
  let catalog;
  try {
    catalog = JSON.parse(r.stdout);
  } catch {
    throw new Error('models --json did not return JSON');
  }
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('models --json returned no models');
  const ids = catalog.map((m) => m.id);
  if (ids.includes(hint)) return hint;
  const costOf = (m) => (m.cost?.input || 0) + (m.cost?.output || 0);
  const matches = catalog.filter((m) => m.id.toLowerCase().includes(String(hint).toLowerCase()));
  if (!matches.length) {
    throw new Error(`no model matches "${hint}". Available: ${ids.join(', ')}`);
  }
  const pick = matches.sort((a, b) => costOf(a) - costOf(b))[0];
  return pick.id;
}

/* Events that count as "something happened TO this issue", for the
   five-working-day counter. INCLUDED because each is a change to the issue
   itself or a comment on it:
     ISSUE_COMMENT        someone commented (comments reset the counter)
     LABELED/UNLABELED    triage state changed
     ASSIGNED/UNASSIGNED  someone took it or dropped it
     RENAMED_TITLE        the issue itself was edited
     REOPENED/CLOSED      status changed
     MILESTONED/DEMILESTONED  planning changed
   EXCLUDED, deliberately:
     CROSS_REFERENCED  fires when any OTHER issue/PR mentions this one. The
                       rule says it must not reset, and phase 4 showed it
                       manufactures relationships (5 false merges over 12 PRs).
     MENTIONED         a @user mention inside the issue body/comment; not a
                       change to the issue, and it rides along with comments
                       that already count.
     REFERENCED        a commit message mentioned it. Same manufactured-link
                       risk; genuine work shows up as a closing PR, which takes
                       the item out of this rule entirely.
     SUBSCRIBED/UNSUBSCRIBED  notification preference, invisible to others, and
                       GitHub returns no createdAt for it at all.
     LOCKED/UNLOCKED   moderation, not work.
   Nothing here is inferred: every name below was executed against the API. */
const COUNTER_EVENT_TYPES = [
  'ISSUE_COMMENT', 'LABELED_EVENT', 'UNLABELED_EVENT', 'ASSIGNED_EVENT', 'UNASSIGNED_EVENT',
  'RENAMED_TITLE_EVENT', 'REOPENED_EVENT', 'CLOSED_EVENT', 'MILESTONED_EVENT', 'DEMILESTONED_EVENT',
];
// Scope: every OPEN issue/PR, plus items closed or merged within this many
// hours. A dashboard needs live work and a short tail of just-finished work;
// widening this is what makes the request count grow.
// Phase 6b: five calendar days, so a Friday item is still here on Tuesday.
// The PANEL caps the done group at DONE_RETENTION_WORKING_DAYS (2 working
// days); this window only has to supply enough for that cap to bite. A 24h
// window made the retention rule inert.
const CLOSED_WINDOW_HOURS = 120;
/* --out <path> redirects BOTH the snapshot and its version file, so a diagnostic
   run (say, proving the truncation guard fires) cannot push a deliberately broken
   snapshot into the panel someone is reading. The version file is derived from the
   snapshot path rather than given separately: the two must never disagree. */
const OUT = argValue('--out') || '/shared/sprinkles/github-dashboard/data/snapshot.json';
/* Phase 7f: the change-detection signal for an OPEN panel.

   The panel polls this ~150-byte file instead of the 300 KB snapshot, and reads
   the snapshot only when `snapshotHash` moves. Two rules, both load-bearing:

   1. It is written STRICTLY AFTER the snapshot. A version file that appeared
      first would advertise a snapshot still being written, and the panel would
      parse a truncated file.
   2. The signal is a CONTENT HASH, never mtime. mtime has been unreliable in
      this runtime, and a stale-mtime false negative is the worst failure mode
      available here: the panel would silently stop updating and look fine. */
const VERSION_OUT = argValue('--out') ? OUT.replace(/[.]json$/, '') + '.version.json' : '/shared/sprinkles/github-dashboard/data/version.json';
/* --scratch <dir> redirects the run's scratch/audit files (thread-link audit,
   merge audit, last-comment audit, progress log, request log). Default is the
   historical /tmp/ghd, so a normal run behaves exactly as before; a test run
   given --out/--cache/--scratch touches nothing the live poller reads. */
const SCRATCH_DIR = argValue('--scratch') || '/tmp/ghd';
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
const API = 'https://api.github.com';

/* ------------------------------------------------------------------ requests */

const log = [];
let rl = { limit: null, remaining: null, reset: null, firstRemaining: null };
const transportRetries = [];

/* Phase 7b: the first 7b run died 6.5 minutes in with "Proxy fetch failed
   (AsyncHTTPClient error 1)" — a TRANSPORT failure in this runtime's fetch
   proxy, not an answer from GitHub. A run that throws away a whole REST phase
   because one socket blinked is not usable in a poll loop, so transport errors
   and 5xx get a bounded retry with backoff. 403/429 are deliberately NOT
   retried: they are real answers about rate limiting and must stay loud. Every
   retry is recorded so a flaky run cannot look like a clean one. */
async function fetchWithRetry(url, init, label) {
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        transportRetries.push({ label, attempt, reason: `HTTP ${res.status}` });
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      transportRetries.push({ label, attempt, reason: String(err.message || err).slice(0, 120) });
      console.error(`[net] transport failure on ${label} (attempt ${attempt}/${MAX_ATTEMPTS}): ${String(err.message || err).slice(0, 120)} — retrying`);
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr && lastErr.message || lastErr)}`);
}

async function api(path, { allow404 = false, withLink = false } = {}) {
  const url = path.startsWith('http') ? path : `${API}/${path.replace(/^\//, '')}`;
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: 'Bearer ' + TOK,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'slicc-github-dashboard',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, `GET ${path}`);
  const h = (n) => res.headers.get(n);
  rl.limit = h('x-ratelimit-limit');
  rl.remaining = h('x-ratelimit-remaining');
  rl.reset = h('x-ratelimit-reset');
  if (rl.firstRemaining === null) rl.firstRemaining = rl.remaining;
  log.push({ path, status: res.status, remaining: rl.remaining, etag: h('etag') || null });

  if (res.status === 404 && allow404) return { notFound: true };
  if (res.status === 403 || res.status === 429) {
    const body = await res.text();
    throw new Error(`RATE LIMITED or FORBIDDEN on ${path}: ${res.status} ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  // The empty-string trap, generalised: never let an absent value flow onward.
  if (json === null || json === undefined) throw new Error(`empty body on ${path}`);
  // Opt-in, for the paginated comments read: the Link header says whether the
  // page asked for really is the last one. Every other caller is unchanged.
  if (withLink) return { body: json, link: h('link') || null };
  return json;
}

const must = (v, what) => {
  if (v === undefined || v === null || v === '') throw new Error(`refusing to continue: ${what} is empty`);
  return v;
};

/* --------------------------------------------------------------- derivation */

// Human names for the stages, so the model never sees a stage NUMBER.
const STATE_LABEL = {
  1: 'open issue', 2: 'thread started', 3: 'thread waiting for input', 4: 'agent working',
  5: 'draft PR, CI running', '5a': 'CI failing', '5b': 'merge conflicts',
  6: 'in review', '6a': 'approved', '6b': 'changes requested', 7: 'ready to merge',
  8: 'in merge queue', '8a': 'merge queue conflicts', '8b': 'merge queue checks failed',
  9: 'merged, awaiting release', 10: 'released', 11: 'closed',
};

const iso = (s) => (s ? new Date(s).toISOString().replace('.000Z', 'Z') : undefined);
const maxDate = (...xs) => {
  const ds = xs.filter(Boolean).map((x) => new Date(x).getTime()).filter((n) => !Number.isNaN(n));
  return ds.length ? new Date(Math.max(...ds)).toISOString().replace('.000Z', 'Z') : undefined;
};

/** Latest review state per reviewer, author excluded. Approximates GitHub's
 *  own reviewDecision (which also honours CODEOWNERS / required reviewers). */
function reviewState(reviews, authorLogin) {
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user || r.user.login === authorLogin) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    const prev = latest.get(r.user.login);
    if (!prev || new Date(r.submitted_at) >= new Date(prev.submitted_at)) latest.set(r.user.login, r);
  }
  const states = [...latest.values()].map((r) => r.state);
  const decision = states.includes('CHANGES_REQUESTED')
    ? 'CHANGES_REQUESTED'
    : states.includes('APPROVED')
      ? 'APPROVED'
      : null;
  const reviewers = [...latest.values()].map(
    (r) => `@${r.user.login} (${r.state.toLowerCase().replace('_', ' ')})`,
  );
  const lastSubmitted = maxDate(...[...latest.values()].map((r) => r.submitted_at));
  return { decision, reviewers, lastSubmitted };
}

/** CI verdict from check runs + commit statuses. */
function ciVerdict(checkRuns) {
  const runs = checkRuns?.check_runs ?? [];
  if (!runs.length) return { state: 'none', text: undefined, lastCompleted: undefined };
  const failed = runs.filter((r) =>
    ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(r.conclusion),
  );
  const running = runs.filter((r) => r.status !== 'completed');
  const lastCompleted = maxDate(...runs.map((r) => r.completed_at));
  if (failed.length) {
    return {
      state: 'failing',
      text: `failing (${failed.slice(0, 3).map((r) => r.name).join(', ')})`,
      lastCompleted,
    };
  }
  if (running.length) {
    return { state: 'pending', text: `pending (${running.length} of ${runs.length} running)`, lastCompleted };
  }
  return { state: 'success', text: `green (${runs.length} checks)`, lastCompleted };
}

/**
 * STAGE MAPPING — observable GitHub state -> panel stage.
 * Every branch below is reachable from REST data. Stages 2, 3, 4 and 8 are NOT
 * emitted; see `unobservableStages` in the snapshot meta for why.
 */
function deriveStage({ isPr, state, draft, merged, mergeableState, ci, review, released }) {
  if (!isPr) {
    if (state === 'open') return { stage: 1, why: 'issue is open' };
    return { stage: 11, why: 'issue is closed' };
  }
  if (merged) {
    if (released === true) return { stage: 10, why: 'PR merged and contained in the latest release' };
    if (released === false) return { stage: 9, why: 'PR merged, not yet in a release (latest release predates the merge)' };
    // No release process in this repo: "awaiting release" would be a false
    // claim and would park finished work in the snoozed group, so merged is
    // terminal here. Stage 10's label is "released", which is also not exactly
    // true -- the honest bit is recorded in stageWhy.
    return { stage: 10, why: 'PR merged; this repo publishes no releases, so a merge is terminal (not awaiting a release)' };
  }
  if (state === 'closed') {
    return { stage: 11, why: 'PR closed without merging (GitHub calls this closed-unmerged; the panel has no distinct stage)' };
  }
  // open PR
  if (mergeableState === 'dirty') {
    return { stage: 5, substage: '5b', why: 'open PR with merge conflicts (mergeable_state=dirty)' };
  }
  if (ci.state === 'failing') {
    return { stage: 5, substage: '5a', why: `open PR with failing checks (${ci.text})` };
  }
  if (draft) {
    return { stage: 5, why: 'draft PR, checks not failing' };
  }
  if (review.decision === 'CHANGES_REQUESTED') {
    return { stage: 6, substage: '6b', why: 'changes requested by a reviewer' };
  }
  if (review.decision === 'APPROVED') {
    if (ci.state === 'success' && mergeableState === 'clean') {
      return { stage: 7, why: 'approved, checks green, mergeable_state=clean' };
    }
    return { stage: 6, substage: '6a', why: `approved, but not all-green yet (ci=${ci.state}, mergeable_state=${mergeableState})` };
  }
  return { stage: 6, why: 'open non-draft PR awaiting review' };
}

/** Mechanical sentence built ONLY from measured fields. Marked 'derived' so it
 *  can never be mistaken for the human-authored 'placeholder' prose. */
/** True only when the reason contributes a word the lead clause has not
 *  already said. "Open issue" + reason "open" stutters, so it is dropped;
 *  "Closed issue" + "completed" or "not_planned" adds information, so it stays. */
function reasonAddsInfo(lead, reason) {
  if (!reason) return false;
  const leadWords = new Set((lead.toLowerCase().match(/[a-z]+/g) || []));
  const reasonWords = reason.toLowerCase().split(/[_\s]+/).filter(Boolean);
  return reasonWords.some((w) => !leadWords.has(w));
}

function derivedStatus(r) {
  const bits = [];
  if (r.kind === 'issue') {
    const lead = r.stage === 11 ? 'Closed issue' : 'Open issue';
    bits.push(lead);
    // The parenthetical only earns its place when it is not a restatement.
    if (reasonAddsInfo(lead, r.stateReason)) bits.push(`(${r.stateReason.replace(/_/g, ' ')})`);
  } else {
    // For PRs the lead clause IS the state reason in prose ("Merged PR",
    // "Closed without merging", "Draft PR", "Open PR"), so a parenthetical
    // would always restate it. stateReason stays on the record as a field.
    if (r.merged) bits.push('Merged PR');
    else if (r.stage === 11) bits.push('Closed without merging');
    else bits.push(r.draft ? 'Draft PR' : 'Open PR');
    if (r.ci) bits.push(`checks ${r.ci}`);
    if (r.reviewers?.length) bits.push(`reviews: ${r.reviewers.join(', ')}`);
    if (r.mergeableState === 'dirty') bits.push('has conflicts');
  }
  const n = r.commentsCount ?? 0;
  bits.push(`${n} ${n === 1 ? 'comment' : 'comments'}`);
  return bits.join('; ') + '.';
}

/* --------------------------------------------- closing links, via GraphQL

   ONE batched, aliased GraphQL request covers every in-window issue and PR.
   Measured 2026-09-21: 11 issues + 20 PRs = cost 1 point on the SEPARATE
   'graphql' rate-limit resource (5000 points/hr), nodeCount 100. That is why
   phase 1's cost objection to per-item crawling no longer applies.

   WHY NOT THE REST TIMELINE: 'cross-referenced' fires on any mention, so it
   manufactures links. Measured on this very data set, the timeline would have
   claimed one record is closed by SEVEN different PRs
   3286, 3308) and skills#389 by two (406, 407) — GraphQL says none of them
   close anything. Same error class as the phase-3 branch-digit trap.
   ------------------------------------------------------------------------ */

async function graphql(query) {
  const res = await fetchWithRetry('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOK,
      'Content-Type': 'application/json',
      'User-Agent': 'slicc-github-dashboard',
    },
    body: JSON.stringify({ query }),
  }, 'POST /graphql');
  const h = (n) => res.headers.get(n);
  log.push({ path: 'POST /graphql', status: res.status, remaining: h('x-ratelimit-remaining'), resource: h('x-ratelimit-resource') });
  if (!res.ok) throw new Error(`graphql HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.errors) throw new Error('graphql errors: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}

/** Closing relationships for every record in the window, both directions.
 *  Returns { closedBy: {issueKey: [prRef]}, closes: {prKey: [issueRef]}, cost } */
async function closingLinks(records) {
  const issues = records.filter((r) => r.kind === 'issue');
  const prs = records.filter((r) => r.kind === 'pr');
  if (!issues.length && !prs.length) return { closedBy: {}, closes: {}, cost: 0 };
  const iq = issues.map((r, i) => `
    i${i}: repository(owner:"${r.repo.split('/')[0]}", name:"${r.repo.split('/')[1]}") {
      issue(number:${r.id}) { number state createdAt
        closedByPullRequestsReferences(first:10, includeClosedPrs:true) {
          totalCount nodes { number state isDraft title updatedAt repository { nameWithOwner } } }
        counterEvents: timelineItems(last:20, itemTypes:[${COUNTER_EVENT_TYPES.join(',')}]) {
          totalCount
          nodes { __typename
            ... on IssueComment { createdAt body author { login __typename } }
            ... on LabeledEvent { createdAt }
            ... on UnlabeledEvent { createdAt }
            ... on AssignedEvent { createdAt }
            ... on UnassignedEvent { createdAt }
            ... on RenamedTitleEvent { createdAt }
            ... on ReopenedEvent { createdAt }
            ... on ClosedEvent { createdAt }
            ... on MilestonedEvent { createdAt }
            ... on DemilestonedEvent { createdAt } } } } }`).join('');
  const pq = prs.map((r, i) => `
    p${i}: repository(owner:"${r.repo.split('/')[0]}", name:"${r.repo.split('/')[1]}") {
      pullRequest(number:${r.id}) { number state isDraft
        closingIssuesReferences(first:10) {
          totalCount nodes { number state title url labels(first:20){nodes{name}} repository { nameWithOwner } } } } }`).join('');
  // viewer { login } is the authenticated identity at no extra request, so the
  // mirror exclusion below holds even on a run whose comment phase was all
  // cache hits (and so never called GET /user).
  const data = await graphql(`query {${iq}${pq}
 viewer { login }
 rateLimit { cost remaining nodeCount } }`);
  const viewerLogin = data.viewer && typeof data.viewer.login === 'string' && data.viewer.login ? data.viewer.login : null;
  const counters = {};
  issues.forEach((r, i) => {
    const node = data['i' + i] && data['i' + i].issue;
    if (!node) return;
    // updated_at is NOT used: measured on a real PR it equals created_at while
    // a LabeledEvent exists 2s later, and on another it tracked a label change
    // exactly — it is not a faithful instrument either way.
    // Fail safe: with no identity the mirror cannot be told apart, so the
    // counter is left UNDETERMINED rather than reset by our own comment.
    if (!viewerLogin) {
      counters[`${r.repo}#${r.id}`] = { undeterminedLogin: true };
      return;
    }
    counters[`${r.repo}#${r.id}`] = counterFromTimeline({
      nodes: node.counterEvents ? node.counterEvents.nodes : [],
      totalCount: node.counterEvents ? node.counterEvents.totalCount : 0,
      createdAt: node.createdAt,
      selfLogin: viewerLogin,
      maxComments: MAX_COMMENTS,
      commentChars: COMMENT_CHARS,
    });
  });
  const closedBy = {};
  issues.forEach((r, i) => {
    const node = data['i' + i] && data['i' + i].issue;
    if (!node) return;
    closedBy[`${r.repo}#${r.id}`] = node.closedByPullRequestsReferences.nodes.map((p) => ({
      key: `${p.repository.nameWithOwner}#${p.number}`,
      number: String(p.number), repo: p.repository.nameWithOwner,
      state: p.state, isDraft: p.isDraft, title: p.title, updatedAt: p.updatedAt,
    }));
  });
  const closes = {};
  prs.forEach((r, i) => {
    const node = data['p' + i] && data['p' + i].pullRequest;
    if (!node) return;
    closes[`${r.repo}#${r.id}`] = node.closingIssuesReferences.nodes.map((iss) => ({
      key: `${iss.repository.nameWithOwner}#${iss.number}`,
      number: String(iss.number), repo: iss.repository.nameWithOwner,
      state: iss.state, title: iss.title, url: iss.url,
      labels: (iss.labels && iss.labels.nodes ? iss.labels.nodes.map((l) => l.name) : []),
    }));
  });
  return { closedBy, closes, counters, viewerLogin, cost: data.rateLimit ? data.rateLimit.cost : null };
}

/* ---- 8< threadLinks --------------------------------------------------------
   bb thread <-> GitHub record LINKING. Rules approved by the operator on
   2026-09-25; evidence in the bb-association audit (final addendum, A3/A4).

   A thread links to a record ONLY within the repo its bb project maps to, and
   every link carries matchedBy:

     'title' / 'both'  UNCHANGED issue signal: an explicit "#N" in the thread
                       title or titleFallback (so "owner/repo#N" matches too).
                       The branch pattern ^bb/.*-(N)-thr_x may only corroborate
                       one ('both'); branch digits alone are rejected (measured
                       2026-09-21: -331 was a truncation of #3310, -380 named an
                       unrelated issue). Bare numbers, a number anywhere in the
                       branch, and fuzzy title overlap are deliberately NOT
                       signals: the audit measured them as alternates or noise.
     'pr-env'          bb's own github plugin, `bb rpc github pullForThread`: the
                       PR of a LIVE thread's environment. Exact, but IGNORED when
                       several live threads in the listing share that
                       environmentId (the audit found 17 live threads on one
                       environment, all resolving to one old closed PR).
     'pr-branch'       the fallback, and the only PR signal for ARCHIVED threads:
                       the PR's head branch (head repo = this repo) equals the
                       thread's environmentBranchName AND the thread was updated
                       at or after the PR was created. The time condition removes
                       Renovate's branch-name reuse (3 false links without it, 0
                       with it).
     'pr-env+branch'   both PR signals agree. A title match on the same pair is
                       joined with '+', e.g. 'title+pr-env'.
     'refs-pr'         carry-over: an ISSUE in the window with no thread of its
                       own inherits the thread of a PR in the window (same repo)
                       whose title or body says "Refs #N", "Ref #N" or
                       "References #N" (case-insensitive). Non-closing only:
                       closing references already fold the issue into the PR card.

   WHICH THREAD WINS when several match one record: a link that includes
   'pr-env' outranks one that does not ("A is exact, B is the fallback"); within
   a rank the most recently updated thread wins, as before, and threadCandidates
   counts every matching thread.

   Pure: bb and GitHub data come in as arguments. Fenced, so
   tests/thread-links.test.js evaluates this exact text. */
const BRANCH_RE = /^bb\/.*?-(\d+)-thr_[a-z0-9]+$/;
const HASH_RE = /#(\d+)/g;

function threadCandidates(t) {
  const fromBranch = new Set();
  const fromTitle = new Set();
  const b = t.environmentBranchName || '';
  const mb = b.match(BRANCH_RE);
  if (mb) fromBranch.add(mb[1]);
  for (const field of [t.title, t.titleFallback]) {
    if (!field) continue;
    for (const m of String(field).matchAll(HASH_RE)) fromTitle.add(m[1]);
  }
  return { fromBranch, fromTitle };
}

/** Live = exists, not archived/deleted. Archived threads are still attached
 *  (the work happened there) but never imply live agent activity. */
function threadIsLive(t) {
  return !t.archivedAt && !t.deletedAt;
}

function threadIsBusy(t) {
  const a = t.activity || {};
  const counts =
    (a.activeBackgroundAgentCount || 0) +
    (a.activeBackgroundCommandCount || 0) +
    (a.activeGoalCount || 0) +
    (a.activePlanModeCount || 0) +
    (a.activeWorkflowCount || 0);
  const queued = t.queuedWork && t.queuedWork !== 'none';
  const running = t.status === 'running' || t.status === 'working';
  return counts > 0 || !!queued || running;
}

/** "Refs #N" / "Ref #N" / "References #N", case-insensitive, same repo only
    (a repo-qualified "other/repo#N" has no space before the '#', so it never
    matches). Returns the set of N as strings. */
const REFS_RE = /\b(?:refs?|references)\s+#(\d+)\b/gi;
function nonClosingRefs(...texts) {
  const out = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const m of String(text).matchAll(REFS_RE)) out.add(m[1]);
  }
  return out;
}

function threadUpdatedMs(t) {
  const ms = new Date(t && t.updatedAt).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** environmentId -> number of LIVE threads on it, for ids used more than once. */
function sharedEnvironmentIds(threads) {
  const n = new Map();
  for (const t of threads || []) {
    if (!t || !t.environmentId || !threadIsLive(t)) continue;
    n.set(t.environmentId, (n.get(t.environmentId) || 0) + 1);
  }
  for (const [k, v] of n) if (v < 2) n.delete(k);
  return n;
}

/** Feature-detect `bb rpc` from the output of a bare `bb rpc`. Both the old and
    the new bb exit non-zero here, so only the message tells them apart:
    new bb prints its rpc usage (before any request); old bb prints
    "unknown command: rpc". Anything else counts as unavailable. */
function detectBbRpc(r) {
  const text = String(((r && r.stdout) || '') + '\n' + ((r && r.stderr) || '')).replace(/\u001b\[[0-9;]*m/g, '');
  if (/usage:\s*bb rpc\b/.test(text)) return { available: true, why: 'bb rpc present' };
  if (/unknown command:\s*rpc\b/.test(text)) return { available: false, why: 'bb rpc is unknown to the installed bb skill (it arrives with skills#435)' };
  const first = text.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '(no output)';
  return { available: false, why: `bb rpc probe unclear (exit ${r && r.exitCode}): ${first.slice(0, 120)}` };
}

/** The pull from `bb rpc github pullForThread ... --json`: the envelope is
    {ok, result: {pull: {repo, number, environmentId} | null}}. Throws on
    ok:false or on any other shape, so an error is never read as "no PR". */
function parsePullForThread(stdout) {
  const j = JSON.parse(String(stdout || '').trim());
  if (!j || typeof j !== 'object' || j.ok === false) throw new Error(`pullForThread not ok: ${JSON.stringify(j && j.error ? j.error : j).slice(0, 160)}`);
  if (!j.result || typeof j.result !== 'object' || !('pull' in j.result)) throw new Error('pullForThread: unexpected envelope');
  const p = j.result.pull;
  if (p === null) return null;
  if (!p || typeof p.repo !== 'string' || !Number.isFinite(Number(p.number))) throw new Error('pullForThread: malformed pull');
  return { repo: p.repo, number: String(Number(p.number)), environmentId: p.environmentId || null };
}

function threadRef(t, matchedBy) {
  return {
    id: t.id,
    provider: t.providerId || null,
    state: t.status || null,
    title: t.title || t.titleFallback || null,
    branch: t.environmentBranchName || null,
    archived: !!t.archivedAt,
    live: threadIsLive(t),
    busy: threadIsBusy(t),
    hasPendingInteraction: !!t.hasPendingInteraction,
    queuedWork: t.queuedWork || null,
    updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
    matchedBy,
  };
}

const linkRank = (c) => (/pr-env/.test(c.matchedBy) ? 2 : 1);

function offerThread(rec, cand) {
  rec.threadCandidates = (rec.threadCandidates || 0) + 1;
  const cur = rec.thread;
  if (!cur || linkRank(cand) > linkRank(cur) || (linkRank(cand) === linkRank(cur) && (cand.updatedAt || '') > (cur.updatedAt || ''))) rec.thread = cand;
}

/** Attach threads to records (mutates rec.thread / rec.threadCandidates).
    pulls: Map threadId -> pull|null (only for threads that were asked).
    prInfo: Map "owner/repo#N" -> { headRef, headRepo, createdAt, refs:Set }. */
function linkThreads({ records, threadsByRepo, pulls = new Map(), prInfo = new Map() }) {
  const rejected = [];
  const stats = { prEnvSharedEnvIgnored: 0, prEnvOtherRepo: 0, prEnvNoRecord: 0, prEnvNoEnvironmentId: 0, prBranchBeforePr: 0, prBranchForkHead: 0 };
  const byKey = new Map(records.map((r) => [`${r.repo}#${r.id}`, r]));
  const shared = sharedEnvironmentIds(Object.values(threadsByRepo).flat());
  const reject = (t, repo, number, matchedBy, reason) =>
    rejected.push({ thread: t.id, repo, number: String(number), matchedBy, threadTitle: t.title || t.titleFallback || null, reason });
  for (const repo of Object.keys(threadsByRepo)) {
    const prs = records.filter((r) => r.repo === repo && r.kind === 'pr' && prInfo.has(`${r.repo}#${r.id}`));
    for (const t of threadsByRepo[repo]) {
      const hits = new Map();
      const hit = (num) => {
        if (!hits.has(num)) hits.set(num, { title: null, env: false, branch: false });
        return hits.get(num);
      };
      // 1. title "#N" (unchanged rule)
      const { fromBranch, fromTitle } = threadCandidates(t);
      for (const num of new Set([...fromBranch, ...fromTitle])) {
        const m = fromBranch.has(num) && fromTitle.has(num) ? 'both' : fromTitle.has(num) ? 'title' : 'branch';
        if (m === 'branch') { reject(t, repo, num, m, 'branch digits only, no explicit #N reference — not trusted'); continue; }
        if (!byKey.has(`${repo}#${num}`)) { reject(t, repo, num, m, 'no record with that number in the window'); continue; }
        hit(num).title = m;
      }
      // 2. pr-env: bb's pullForThread, live threads only
      if (threadIsLive(t) && pulls.has(t.id)) {
        const pull = pulls.get(t.id);
        if (pull) {
          const envCount = t.environmentId ? shared.get(t.environmentId) || 1 : 0;
          if (!t.environmentId) {
            stats.prEnvNoEnvironmentId++;
            reject(t, pull.repo, pull.number, 'pr-env', 'pr-env: the thread has no environmentId, so sharing cannot be ruled out — ignored');
          } else if (envCount > 1) {
            stats.prEnvSharedEnvIgnored++;
            reject(t, pull.repo, pull.number, 'pr-env', `pr-env: environment ${t.environmentId} is shared by ${envCount} live threads — ignored`);
          } else if (pull.repo !== repo) {
            stats.prEnvOtherRepo++;
            reject(t, pull.repo, pull.number, 'pr-env', `pr-env: the PR is in ${pull.repo}, but this thread's project maps to ${repo}`);
          } else {
            const r = byKey.get(`${repo}#${pull.number}`);
            if (!r || r.kind !== 'pr') {
              stats.prEnvNoRecord++;
              reject(t, repo, pull.number, 'pr-env', 'pr-env: no PR record with that number in the window');
            } else hit(String(pull.number)).env = true;
          }
        }
      }
      // 3. pr-branch: head branch == thread branch, thread updated >= PR created
      const branch = t.environmentBranchName || '';
      if (branch) {
        for (const pr of prs) {
          const info = prInfo.get(`${pr.repo}#${pr.id}`);
          if (!info.headRef || info.headRef !== branch) continue;
          if (info.headRepo !== repo) {
            stats.prBranchForkHead++;
            reject(t, repo, pr.id, 'pr-branch', `pr-branch: the PR head is in ${info.headRepo || 'an unknown repo'}, not ${repo}`);
            continue;
          }
          if (!(threadUpdatedMs(t) >= Date.parse(info.createdAt))) {
            stats.prBranchBeforePr++;
            reject(t, repo, pr.id, 'pr-branch', 'pr-branch: the thread was last updated before the PR was created (branch-name reuse)');
            continue;
          }
          hit(pr.id).branch = true;
        }
      }
      for (const [num, h] of hits) {
        const prPart = h.env && h.branch ? 'pr-env+branch' : h.env ? 'pr-env' : h.branch ? 'pr-branch' : '';
        const matchedBy = [h.title, prPart].filter(Boolean).join('+');
        if (matchedBy) offerThread(byKey.get(`${repo}#${num}`), threadRef(t, matchedBy));
      }
    }
  }
  return { rejected, stats };
}

/** 'refs-pr': issues with no thread inherit one from a referencing PR. Run
    AFTER linkThreads. Returns Map issueKey -> [referencing PR keys that carry
    a thread]; those PRs also drive the issue's aging (applyRefsAging). */
function carryRefsThreads({ records, prInfo = new Map() }) {
  const carried = new Map();
  for (const rec of records) {
    if (rec.kind !== 'issue' || rec.thread) continue;
    const refs = records.filter((p) => {
      if (p.kind !== 'pr' || p.repo !== rec.repo || !p.thread) return false;
      const info = prInfo.get(`${p.repo}#${p.id}`);
      return !!(info && info.refs && info.refs.has(rec.id));
    });
    if (!refs.length) continue;
    for (const p of refs) offerThread(rec, { ...p.thread, matchedBy: 'refs-pr', viaPr: `${p.repo}#${p.id}` });
    carried.set(`${rec.repo}#${rec.id}`, refs.map((p) => `${p.repo}#${p.id}`));
  }
  return carried;
}

/** Newest of the issue's own activity and its referencing PRs' activity. */
function carriedActivity(own, others) {
  const all = [own, ...(others || [])].filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  if (!all.length) return { at: own, carried: false };
  const at = all.reduce((m, v) => (Date.parse(v) > Date.parse(m) ? v : m));
  return { at, carried: typeof own === 'string' && Date.parse(at) > Date.parse(own) };
}

/** Aging for refs-pr issues, so active umbrella work does not read as stalled:
    lastActivityAt becomes max(own, referencing PRs). OPEN issues only (a closed
    issue's done-column retention is left alone). The own value is kept as
    lastActivityAtOwn, which is what the status cache keys on, so a moving PR
    does not re-trigger the issue's status-model call. Returns the count. */
function applyRefsAging(records, carried) {
  const byKey = new Map(records.map((r) => [`${r.repo}#${r.id}`, r]));
  let n = 0;
  for (const [key, prKeys] of carried) {
    const rec = byKey.get(key);
    if (!rec || rec.kind !== 'issue' || rec.stage === 11) continue;
    const out = carriedActivity(rec.lastActivityAt, prKeys.map((k) => byKey.get(k) && byKey.get(k).lastActivityAt));
    if (!out.carried) continue;
    rec.lastActivityAtOwn = rec.lastActivityAt;
    rec.lastActivityAt = out.at;
    rec.activityCarriedFrom = prKeys;
    n++;
  }
  return n;
}
/* ---- >8 end threadLinks ---------------------------------------------------- */

/* Thread listing (phase 7h, corrected 2026-09-25).

   `bb thread list` with NO limit returns only the most recent 20 threads per
   project; that once dropped three in-window links with nothing in the log.

   The bb SKILL clamps --limit to 200, silently: --limit 500/1000/2000 all
   return 200 rows. So 200 is the skill's ceiling, NOT a project's real size. Measured
   2026-09-25: the slicc project holds 891+ threads (a full export had 894) and
   still returns 200; skills has 16. The listing is ordered newest first.

   OPERATOR DECISION (2026-09-25): keep the TOP 200 threads per project and do
   not page. The audit found every real in-window association inside the top
   200; the older threads are history. A page of exactly 200 is therefore
   EXPECTED for a busy project, and is logged as information, not a warning.

   --include-hidden is passed. It does matter: the slicc project has 203 hidden
   threads in its full list. It is kept for CONSISTENCY with the
   archived-thread policy: an archived thread still links, because the work
   happened there, and "hidden" is a weaker signal than "archived" (it hides a
   thread from someone's bb sidebar). The hidden count in each page is
   recorded per project so the decision can be revisited against data. */
const THREAD_LIST_LIMIT = Number(argValue('--thread-limit')) > 0 ? Number(argValue('--thread-limit')) : 200;

function loadThreads() {
  const byRepo = {};
  const diag = [];
  const listing = { limitRequested: THREAD_LIST_LIMIT, policy: 'top 200 threads per project, newest first, no paging (operator decision 2026-09-25; the bb skill clamps --limit to 200)', perProject: {} };
  for (const [repo, project] of Object.entries(BB_PROJECT)) {
    let raw;
    try {
      raw = cp.execSync(`bb thread list --project ${project} --limit ${THREAD_LIST_LIMIT} --include-hidden --json`, { encoding: 'utf8', maxBuffer: 40e6 });
    } catch (err) {
      diag.push(`bb thread list failed for ${repo} (${project}): ${String(err.message).slice(0, 160)}`);
      byRepo[repo] = [];
      listing.perProject[repo] = { project, returned: 0, error: true };
      continue;
    }
    let list;
    try {
      list = JSON.parse(raw);
    } catch (err) {
      diag.push(`bb returned unparseable JSON for ${repo}: ${String(err.message).slice(0, 120)}`);
      byRepo[repo] = [];
      listing.perProject[repo] = { project, returned: 0, error: true };
      continue;
    }
    byRepo[repo] = Array.isArray(list) ? list : [];
    const returned = byRepo[repo].length;
    const hidden = byRepo[repo].filter((t) => t.visibility && t.visibility !== 'visible').length;
    const live = byRepo[repo].filter(threadIsLive).length;
    // A full page is the design, not a defect: the project simply has more
    // threads than the top-N kept. Recorded, and logged as information.
    const fullPage = returned >= THREAD_LIST_LIMIT;
    listing.perProject[repo] = { project, returned, hidden, live, fullPage };
    console.log(`bb threads     : ${repo} → ${returned} threads (limit ${THREAD_LIST_LIMIT}, ${live} live${hidden ? `, ${hidden} hidden` : ''})${fullPage ? ` — full page: the newest ${THREAD_LIST_LIMIT} are kept by design` : ''}`);
  }
  return { byRepo, diag, listing };
}

/**
 * STAGE MAPPING, thread-derived part (phase 3).
 * Applies to OPEN ISSUES only. A PR's own GitHub state (CI, review, merge) is
 * the better signal, so a thread never overrides a PR's stage — it is attached
 * for the jump-in target and nothing else.
 *
 *   open issue + live thread with hasPendingInteraction -> 3 needs guidance
 *   open issue + live thread that is busy/queued        -> 4 agent working
 *   open issue + live thread, idle (incl. status=error) -> 2 thread started
 *   open issue + only archived threads                  -> 1 (unchanged)
 *
 * Still out of reach: nothing distinguishes "thread finished successfully"
 * from "thread abandoned", and stage 8 (merge queue) remains REST-invisible.
 */
function stageFromThread(rec, t) {
  if (rec.kind !== 'issue' || rec.stage !== 1 || !t) return null;
  if (threadIsLive(t)) {
    if (t.hasPendingInteraction) return { stage: 3, why: 'bb thread is waiting for input (hasPendingInteraction)' };
    if (threadIsBusy(t)) return { stage: 4, why: `bb thread has work in flight (status=${t.status}, queuedWork=${t.queuedWork})` };
    return { stage: 2, why: `bb thread exists and is idle (status=${t.status})` };
  }
  // PHASE 5, requested: "an issue that's open with an archived thread is work".
  // Phase 3 left these at stage 1 (undispatched), which was wrong: work was
  // started and then abandoned. Stage 2 is a WORKING stage on the 6h default,
  // so such an item reads as stalled within hours — which is the point.
  return { stage: 2, why: `bb thread exists but is archived: work was started, then abandoned (status=${t.status})` };
}

/* ---- 8< lastComment -------------------------------------------------------
   lastCommentAt: the created_at of the newest issue-thread comment that is
   HUMAN FOLLOW-UP. The panel's snoozeState() reads it as
     !!item.lastCommentAt && !!since && new Date(item.lastCommentAt) > since
   (since = snoozedAt), so a string that Date parses, or null, is the contract.

   THE HAZARD THIS EXISTS TO PREVENT. mirror-comments.mjs posts ONE comment per
   marked item ("Snoozed until <date>"), as the authenticated user, carrying the
   invisible marker below. Counted naively, that comment postdates the snooze it
   announces, so the panel cancels the snooze, the mirror then deletes its
   comment, the next cycle reposts it: a post/delete flap on a PUBLIC card every
   30 minutes, notifying every watcher. So a comment does NOT count when:
     1. its body contains the marker AND its author is the authenticated user.
        BOTH, so nobody else can suppress a real signal by pasting the marker;
     2. its author is a bot (user.type === 'Bot': release notices, dispatchers).
   Everything else counts, including the user's own ordinary comments.

   created_at, not updated_at: "a comment after the snooze" means a comment
   WRITTEN after it. Editing an old comment is not new follow-up, and counting
   edits would let a typo fix cancel a snooze. The panel needs nothing else.

   SCOPE: issue-thread comments only (/issues/:n/comments, which also carries a
   PR's conversation tab). PR review comments (inline, on the diff) and review
   bodies are NOT included.

   Without the authenticated login the mirror's comment cannot be told apart,
   so every entry point REFUSES rather than guess. The caller then leaves the
   field absent, which is exactly the pre-existing (inert) behaviour.

   THE SAME PREDICATE (commentCounts) also filters every other comment-derived
   field: commentsCount (lastCommentPhase), counterResetAt and recentComments
   (counterFromTimeline, via commentFromGraphql), and the updated_at bump in
   lastActivityAt (activityWithoutExcluded). One rule, no copies.

   Pure (the phase driver takes its I/O as arguments), and fenced by these
   markers so the test evaluates THIS text rather than a copy that could drift. */
const GHD_MIRROR_MARKER = '<!-- ghd-mirror:v1 -->';
const COMMENTS_PER_PAGE = 100;
const MAX_COMMENT_PAGES_BACK = 10;

function requireLogin(selfLogin, where) {
  if (typeof selfLogin !== 'string' || !selfLogin.trim()) {
    throw new TypeError(`${where}: the authenticated login is required — without it the mirror's own comment would count and cancel the snooze it publishes`);
  }
  return selfLogin.trim().toLowerCase();
}

/** Does this one comment count as human follow-up? */
function commentCounts(c, selfLogin) {
  const self = requireLogin(selfLogin, 'commentCounts');
  if (!c || typeof c !== 'object') return false;
  const user = c.user && typeof c.user === 'object' ? c.user : null;
  if (user && user.type === 'Bot') return false;
  const login = user && typeof user.login === 'string' ? user.login.toLowerCase() : '';
  const body = typeof c.body === 'string' ? c.body : '';
  if (login === self && body.includes(GHD_MIRROR_MARKER)) return false;
  return true;
}

/** ISO UTC created_at of the newest counting comment, or null. Order-free. */
function newestQualifyingCommentAt(comments, selfLogin) {
  requireLogin(selfLogin, 'newestQualifyingCommentAt');
  let bestMs = -Infinity;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!commentCounts(c, selfLogin)) continue;
    const ms = Date.parse(c.created_at);
    if (Number.isFinite(ms) && ms > bestMs) bestMs = ms;
  }
  return bestMs === -Infinity ? null : new Date(bestMs).toISOString().replace('.000Z', 'Z');
}

/** A merged card (PR + absorbed issue): the newest KNOWN value wins; null only
    when both sides are known-empty; undefined (field absent) when unknown. */
function combineLastCommentAt(a, b) {
  const known = [a, b].filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)));
  if (known.length) return known.reduce((m, v) => (Date.parse(v) > Date.parse(m) ? v : m));
  if (a === null && b === null) return null;
  return undefined;
}

/** Page number of rel="last" in a GitHub Link header, or null. */
function lastPageFromLink(link) {
  if (!link) return null;
  for (const part of String(link).split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (!m || !m[2].split(/\s+/).includes('last')) continue;
    const p = m[1].match(/[?&]page=(\d+)/);
    if (p) return Number(p[1]);
  }
  return null;
}

/** Read a thread FROM THE END. The list is oldest-first, so the newest comment
    is on the last page, whose number the payload's comment count already gives
    (ceil(count / per_page)): normally ONE request, however long the thread. If
    the count was stale and Link names a different last page, jump there once.
    Walk back a page only while the page in hand holds nothing that counts (a
    tail of bot or mirror comments). getPage(page) -> { comments, link }. */
async function fetchLastCommentAt({ count, selfLogin, getPage, perPage = COMMENTS_PER_PAGE }) {
  requireLogin(selfLogin, 'fetchLastCommentAt');
  // Every comment on every page read, deduplicated, so the SAME predicate can
  // also say how many comments were excluded and when the newest excluded one
  // was written or edited (commentsCount and lastActivityAt need both).
  const seen = new Map();
  const note = (r, p) => {
    ((r && r.comments) || []).forEach((c, i) => seen.set(c && c.id != null ? `id:${c.id}` : `p${p}:${i}`, c));
  };
  let page = Math.max(1, Math.ceil((Number(count) || 0) / perPage));
  let res = await getPage(page);
  note(res, page);
  let requests = 1;
  const last = lastPageFromLink(res && res.link);
  if (last && last !== page) {
    page = last;
    res = await getPage(page);
    note(res, page);
    requests += 1;
  }
  // The page the walk starts from is the true last page iff Link names no
  // later one (GitHub omits rel="last" on the last page itself).
  const topIsLast = !lastPageFromLink(res && res.link) || lastPageFromLink(res && res.link) === page;
  const done = (out) => Object.assign(out, excludedSummary([...seen.values()], selfLogin), { complete: topIsLast && page <= 1 });
  // For the audit only: what a naive "newest comment" would have said.
  let newestAnyMs = -Infinity;
  for (const c of (res && res.comments) || []) {
    const ms = Date.parse(c && c.created_at);
    if (Number.isFinite(ms) && ms > newestAnyMs) newestAnyMs = ms;
  }
  const newestAnyAt = newestAnyMs === -Infinity ? null : new Date(newestAnyMs).toISOString().replace('.000Z', 'Z');
  for (let back = 0; ; back += 1) {
    const at = newestQualifyingCommentAt((res && res.comments) || [], selfLogin);
    if (at) return done({ at, requests, newestAnyAt });
    if (page <= 1) return done({ at: null, requests, newestAnyAt });
    // Unknown, not "none": a null here would claim a thread has no follow-up.
    if (back >= MAX_COMMENT_PAGES_BACK) return done({ at: undefined, requests, newestAnyAt, truncated: true });
    page -= 1;
    res = await getPage(page);
    note(res, page);
    requests += 1;
  }
}

/** What the shared predicate EXCLUDED from a set of REST comments: how many,
    and the newest instant any of them was created or edited (an edit to the
    mirror's comment bumps the issue's updated_at just as a post does). */
function excludedSummary(comments, selfLogin) {
  requireLogin(selfLogin, 'excludedSummary');
  let excludedCount = 0;
  let countedSeen = 0;
  let latestMs = -Infinity;
  for (const c of comments || []) {
    if (!c || typeof c !== 'object') continue;
    if (commentCounts(c, selfLogin)) {
      countedSeen += 1;
      continue;
    }
    excludedCount += 1;
    for (const t of [c.created_at, c.updated_at]) {
      const ms = Date.parse(t);
      if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;
    }
  }
  return { excludedCount, countedSeen, excludedLatestAt: latestMs === -Infinity ? null : new Date(latestMs).toISOString().replace('.000Z', 'Z') };
}

/** A GraphQL comment node in the REST shape commentCounts() reads, so the
    timeline-derived fields use the SAME predicate rather than a copy of it.
    GraphQL types an app author as __typename 'Bot' (REST: user.type 'Bot'). */
function commentFromGraphql(node) {
  const a = node && node.author;
  return {
    user: a ? { login: a.login, type: a.__typename === 'Bot' ? 'Bot' : 'User' } : null,
    body: node ? node.body : null,
    created_at: node ? node.createdAt : null,
  };
}

/** The five-working-day counter and the model's recent comments, from the
    GraphQL timeline, AS IF every excluded comment did not exist. With nothing
    excluded the result is exactly what the previous inline code produced.
    Undetermined (resetAt undefined, so the panel falls back to lastActivityAt)
    only when EVERY event in the window was excluded and older ones exist
    beyond it: the true reset event is then out of sight. */
function counterFromTimeline({ nodes, totalCount, createdAt, selfLogin, maxComments, commentChars }) {
  requireLogin(selfLogin, 'counterFromTimeline');
  const all = (nodes || []).filter((e) => e && e.createdAt);
  const evs = [];
  let excluded = 0;
  for (const e of all) {
    if (e.__typename === 'IssueComment' && !commentCounts(commentFromGraphql(e), selfLogin)) {
      excluded += 1;
      continue;
    }
    evs.push({ type: e.__typename, at: e.createdAt, body: e.body || null });
  }
  // The counter resets on the LATEST qualifying event; with none, the issue's
  // own creation is the start.
  const latest = evs.reduce((m, e) => (m && m.at >= e.at ? m : e), null);
  const undetermined = !latest && excluded > 0 && (Number(totalCount) || 0) > all.length;
  const recentComments = evs
    .slice(-5)
    .filter((e) => e.type === 'IssueComment' && e.body)
    .slice(-maxComments)
    .map((e) => ({ at: e.at, text: String(e.body).slice(0, commentChars) }));
  return {
    resetAt: undetermined ? undefined : latest ? latest.at : createdAt,
    resetBy: undetermined ? undefined : latest ? latest.type : 'IssueCreated',
    qualifyingCount: Math.max(0, (Number(totalCount) || 0) - excluded),
    excluded,
    latestCountedAt: latest ? latest.at : null,
    recentComments,
  };
}

/** lastActivityAt without the bump an EXCLUDED comment gave issue.updated_at.

    updated_at cannot be filtered per comment: it is one timestamp for the whole
    item. But when it coincides (within toleranceMs) with the newest instant an
    excluded comment was created or edited, that comment IS what moved it, and
    the honest activity is the newest of every OTHER signal already in hand:
    CI, reviews, merge, creation, closure, counted comments, counted timeline
    events. No extra request. If anything later moved updated_at, it no longer
    coincides and the raw value stands. Unknown excluded data -> raw value. */
function activityWithoutExcluded({ raw, updatedAt, excludedLatestAt, others, toleranceMs = 2000 }) {
  if (!updatedAt || !excludedLatestAt) return { at: raw, adjusted: false };
  const u = Date.parse(updatedAt);
  const x = Date.parse(excludedLatestAt);
  if (!Number.isFinite(u) || !Number.isFinite(x) || Math.abs(u - x) > toleranceMs) return { at: raw, adjusted: false };
  const ms = (others || []).map((t) => Date.parse(t)).filter(Number.isFinite);
  if (!ms.length) return { at: raw, adjusted: false };
  const at = new Date(Math.max(...ms)).toISOString().replace('.000Z', 'Z');
  if (Date.parse(at) >= Date.parse(raw)) return { at: raw, adjusted: false };
  return { at, adjusted: true };
}

/** The whole phase, I/O injected. Mutates each record's lastCommentAt and the
    cache (shape { login, entries }), and returns stats plus a per-record audit.
    Also sets commentsTotal (raw GitHub count) and lowers commentsCount by the
    comments the shared predicate excludes, and returns excludedAt[key] (the
    newest excluded create/edit, null if none, absent if unknown) for the
    lastActivityAt correction. Request budget:
      - commentsCount === 0  -> null, no request;
      - cache hit            -> cached value, no request. A hit needs the SAME
        lastActivityAt (the status cache's key) AND commentsCount (a deletion
        moves the count even if it did not move updated_at) AND login;
      - otherwise            -> GET /user once per run (only when something
        missed), then usually one page per missed record.
    A failed or truncated read leaves the field ABSENT and nothing cached. */
async function lastCommentPhase({ records, cache, getLogin, getPage }) {
  const excludedAt = {};
  const stats = { artifacts: records.length, zeroComments: 0, cacheHits: 0, fetched: 0, failed: 0, pageRequests: 0, loginRequests: 0, invalidatedByLogin: 0, pruned: 0, loginError: null };
  const audit = [];
  const failures = [];
  const entries = cache.entries || (cache.entries = {});
  const live = new Set();
  const hits = [];
  let misses = [];
  for (const rec of records) {
    const key = `${rec.repo}#${rec.id}`;
    const count = rec.commentsCount ?? 0;
    if (count === 0) {
      rec.lastCommentAt = null;
      rec.commentsTotal = 0;
      excludedAt[key] = null;
      stats.zeroComments += 1;
      audit.push({ key, commentsCount: 0, source: 'zero', lastCommentAt: null });
      continue;
    }
    live.add(key);
    const e = entries[key];
    rec.commentsTotal = count;
    // v2 entries also carry the exclusion counts; a v1 entry is re-read ONCE.
    const hit = e && e.v === 2 && e.lastActivityAt === rec.lastActivityAt && e.commentsCount === count && typeof e.login === 'string' && 'lastCommentAt' in e;
    (hit ? hits : misses).push({ rec, key, count, e });
  }
  let login = null;
  if (misses.length) {
    try {
      stats.loginRequests += 1;
      login = requireLogin(await getLogin(), 'lastCommentPhase');
    } catch (err) {
      stats.loginError = String((err && err.message) || err).slice(0, 200);
    }
  }
  // A value computed for a different identity is not a hit: under that login
  // this user's mirror comments would have counted.
  const applied = login ? hits.filter((h) => h.e.login === login) : hits;
  if (login) {
    const moved = hits.filter((h) => h.e.login !== login);
    stats.invalidatedByLogin = moved.length;
    misses = misses.concat(moved);
  }
  for (const h of applied) {
    h.rec.lastCommentAt = h.e.lastCommentAt;
    h.rec.commentsCount = h.e.commentsCounted;
    excludedAt[h.key] = h.e.excludedLatestAt;
    stats.cacheHits += 1;
    audit.push({ key: h.key, commentsCount: h.count, lastActivityAt: h.rec.lastActivityAt, source: 'cache', lastCommentAt: h.e.lastCommentAt });
  }
  for (const m of misses) {
    if (!login) {
      delete m.rec.lastCommentAt;
      stats.failed += 1;
      audit.push({ key: m.key, commentsCount: m.count, source: 'unknown-login', lastCommentAt: undefined });
      continue;
    }
    try {
      const r = await fetchLastCommentAt({ count: m.count, selfLogin: login, getPage: (p) => getPage(m.rec, p) });
      stats.pageRequests += r.requests;
      if (r.at === undefined) throw new Error(`walked back ${MAX_COMMENT_PAGES_BACK} pages without a counting comment`);
      m.rec.lastCommentAt = r.at;
      // Exact when every page was read (every thread today); otherwise the raw
      // count minus what the pages read excluded, an upper bound.
      const counted = r.complete ? r.countedSeen : Math.max(0, m.count - r.excludedCount);
      m.rec.commentsCount = counted;
      excludedAt[m.key] = r.excludedLatestAt;
      entries[m.key] = { v: 2, lastActivityAt: m.rec.lastActivityAt, commentsCount: m.count, login, lastCommentAt: r.at, commentsCounted: counted, excludedCount: r.excludedCount, excludedLatestAt: r.excludedLatestAt, complete: r.complete };
      stats.fetched += 1;
      audit.push({ key: m.key, commentsCount: m.count, commentsCounted: counted, excludedCount: r.excludedCount, excludedLatestAt: r.excludedLatestAt, lastActivityAt: m.rec.lastActivityAt, source: 'fetched', requests: r.requests, lastCommentAt: r.at, newestAnyAt: r.newestAnyAt });
    } catch (err) {
      delete m.rec.lastCommentAt;
      delete entries[m.key];
      stats.failed += 1;
      failures.push({ key: m.key, error: String((err && err.message) || err).slice(0, 200) });
      audit.push({ key: m.key, commentsCount: m.count, source: 'failed', lastCommentAt: undefined });
    }
  }
  // Only records in this window are worth remembering.
  for (const k of Object.keys(entries)) {
    if (!live.has(k)) {
      delete entries[k];
      stats.pruned += 1;
    }
  }
  if (login) cache.login = login;
  return { stats, audit, failures, login, excludedAt };
}
/* ---- >8 end lastComment ---------------------------------------------------- */

/* ---- 8< renovateFilter ----------------------------------------------------
   Renovate's Dependency Dashboard issue is never a card. Operator rule,
   2026-09-25: "the renovate dependency dashboard issue is a special case: we
   should always filter it out."

   All three terms, applied to the RAW issue from the issues list (the only
   place the author is available; records do not carry it):
     1. an issue, not a PR (no pull_request field). Renovate's update PRs
        ("chore(deps): update ...") are real work and stay;
     2. authored by Renovate (login matches /renovate/i, e.g. "renovate[bot]"),
        so a human issue that happens to be titled "Dependency Dashboard" stays;
     3. the title matches /dependency dashboard/i, OR the body carries
        Renovate's fixed opening sentence. The title is configurable
        (dependencyDashboardTitle); the sentence is not.

   Dropped BEFORE a record is built, so it costs no status-model call and is
   not counted anywhere. The count is published in meta.filtered, so the drop
   is visible rather than silent.

   Pure and fenced so tests/renovate-filter.test.js evaluates this exact text. */
const RENOVATE_DASHBOARD_SENTENCE = 'This issue lists Renovate updates and detected dependencies';

function isRenovateDependencyDashboard(it) {
  if (!it || typeof it !== 'object') return false;
  if (it.pull_request) return false;
  const login = it.user && typeof it.user.login === 'string' ? it.user.login : '';
  if (!/renovate/i.test(login)) return false;
  const title = typeof it.title === 'string' ? it.title : '';
  const body = typeof it.body === 'string' ? it.body : '';
  return /dependency dashboard/i.test(title) || body.includes(RENOVATE_DASHBOARD_SENTENCE);
}
/* ---- >8 end renovateFilter ------------------------------------------------- */

/* --------------------------------------------------------------------- main */

const records = [];
const notes = [];
const filteredOut = { renovateDependencyDashboard: [] };
// Per-PR inputs for thread linking, from the PR detail call already made (no
// extra request): head branch + head repo, creation time, and non-closing refs.
const prInfo = new Map();
const derivedInputs = new Map();
const perRepo = {};

for (const full of REPOS) {
  const [owner, name] = full.split('/');
  const repo = await api(`repos/${owner}/${name}`);
  must(repo.default_branch, `${full} default_branch`);

  // Release containment: needed to tell stage 9 from stage 10.
  const rel = await api(`repos/${owner}/${name}/releases/latest`, { allow404: true });
  const latestTag = rel.notFound ? null : must(rel.tag_name, `${full} latest release tag`);
  if (!latestTag) notes.push(`${full}: no published releases, so stage 10 (released) is not determinable; merged PRs stay at stage 9.`);

  // One page of the most recently updated items covers open work plus recent
  // closures. Issues endpoint returns issues AND pull requests.
  const listed = await api(
    `repos/${owner}/${name}/issues?state=all&sort=updated&direction=desc&per_page=100`,
  );
  // The earliest point: before the window, before any per-item request, before
  // a record exists. Nothing below ever sees the dashboard issue.
  const items = listed.filter((it) => {
    if (!isRenovateDependencyDashboard(it)) return true;
    filteredOut.renovateDependencyDashboard.push(`${full}#${it.number}`);
    return false;
  });
  perRepo[full] = { openIssuesCount: repo.open_issues_count, windowSize: items.length, latestTag };

  const cutoff = Date.now() - CLOSED_WINDOW_HOURS * 3600e3;
  const kept = items.filter((it) => it.state === 'open' || (it.closed_at && new Date(it.closed_at).getTime() >= cutoff));
  perRepo[full].itemsInWindow = kept.length;
  perRepo[full].itemsSeen = items.length;

  for (const it of kept) {
    const isPr = !!it.pull_request;
    const num = String(must(it.number, 'issue number'));
    let pr = null, ci = { state: 'none' }, review = { decision: null, reviewers: [], lastSubmitted: undefined };
    let released;

    if (isPr) {
      pr = await api(`repos/${owner}/${name}/pulls/${num}`);
      prInfo.set(`${full}#${num}`, {
        headRef: (pr.head && pr.head.ref) || null,
        headRepo: (pr.head && pr.head.repo && pr.head.repo.full_name) || null,
        createdAt: pr.created_at || null,
        refs: nonClosingRefs(pr.title || it.title, pr.body || ''),
      });
      const headSha = pr.head?.sha;
      // The empty-string trap: only build the check-runs path from a verified sha.
      if (pr.state === 'open') {
        must(headSha, `PR ${full}#${num} head.sha`);
        const checks = await api(`repos/${owner}/${name}/commits/${headSha}/check-runs?per_page=100`);
        ci = ciVerdict(checks);
        const reviews = await api(`repos/${owner}/${name}/pulls/${num}/reviews?per_page=100`);
        review = reviewState(reviews, pr.user?.login);
      }
      if (pr.merged && latestTag) {
        const sha = must(pr.merge_commit_sha, `PR ${full}#${num} merge_commit_sha`);
        // Only `status` is read, so compare's 100-commit page cap is irrelevant.
        const cmp = await api(
          `repos/${owner}/${name}/compare/${encodeURIComponent(latestTag)}...${sha}`,
          { allow404: true },
        );
        released = cmp.notFound ? undefined : ['behind', 'identical'].includes(cmp.status);
      }
    }

    const state = isPr ? pr.state : it.state;
    const merged = isPr ? !!pr.merged : false;
    const mergeableState = isPr ? pr.mergeable_state : undefined;
    const d = deriveStage({
      isPr, state, draft: isPr ? !!pr.draft : false, merged, mergeableState, ci, review, released,
    });

    const rec = {
      id: num,
      repo: full,
      kind: isPr ? 'pr' : 'issue',
      title: must(it.title, `title of ${full}#${num}`),
      url: must(it.html_url, `html_url of ${full}#${num}`),
      stage: d.stage,
      openedAt: iso(it.created_at),
      lastActivityAt: maxDate(it.updated_at, ci.lastCompleted, review.lastSubmitted, isPr ? pr.merged_at : null),
      labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      status: '',
      statusSource: 'derived',
    };
    if (d.substage) rec.substage = d.substage;
    if (isPr && pr.merged_at) rec.mergedAt = iso(pr.merged_at);
    if (ci.text) rec.ci = ci.text;
    if (review.reviewers.length) rec.reviewers = review.reviewers;

    // measured extras, outside the panel's consumed contract (panel ignores
    // unknown keys); kept because the next phase needs them.
    const stateReason = isPr ? (merged ? 'merged' : state === 'closed' ? 'closed_unmerged' : 'open') : it.state_reason || state;
    rec.stateReason = stateReason;
    rec.stageWhy = d.why;
    rec.commentsCount = it.comments ?? 0;
    // REST already returned this on the list/detail call, so it costs nothing.
    const bodyText = (isPr ? pr.body : it.body) || '';
    if (bodyText.trim()) rec.bodyExcerpt = bodyText.trim().slice(0, BODY_CHARS);

    const statusInput = {
      kind: rec.kind, stage: rec.stage, stateReason, merged, draft: isPr ? !!pr.draft : false,
      ci: ci.text, reviewers: review.reviewers, mergeableState, commentsCount: it.comments,
    };
    rec.status = derivedStatus(statusInput);
    // Kept OUT of the record: what the mirror-exclusion pass needs later.
    // updatedAt is the one input an excluded comment can move; the rest cannot.
    derivedInputs.set(rec, {
      statusInput,
      updatedAt: it.updated_at || null,
      others: [it.created_at, it.closed_at, ci.lastCompleted, review.lastSubmitted, isPr ? pr.merged_at : null].filter(Boolean),
    });
    records.push(rec);
  }
}

/* ---- lastCommentAt, per ARTIFACT (before the phase-4 merge absorbs issues) --
   The cache lives in the status cache file (same --cache path, same writer),
   under its own `comments` section, so a status-cache reader that predates it
   is unaffected. See lastCommentPhase() for the budget rules. */
function loadCommentCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATUS_CACHE_PATH, 'utf8'));
    const c = parsed && parsed.comments;
    if (c && c.entries && typeof c.entries === 'object') return { login: c.login || null, entries: c.entries };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[comments] WARNING: cache unreadable (${err.message}); comment reads start cold`);
  }
  return { login: null, entries: {} };
}
const commentCache = loadCommentCache();
const commentCacheLoaded = Object.keys(commentCache.entries).length;
let lastComment = { stats: null, failures: [], audit: [], login: null };
const lastCommentRequestsBefore = log.length;
try {
  lastComment = await lastCommentPhase({
    records,
    cache: commentCache,
    getLogin: async () => must((await api('user')).login, 'authenticated login (GET /user)'),
    getPage: async (rec, page) => {
      const [o, n] = rec.repo.split('/');
      const r = await api(`repos/${o}/${n}/issues/${rec.id}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`, { withLink: true });
      return { comments: r.body, link: r.link };
    },
  });
} catch (err) {
  // Never fatal: the field stays absent, which is the pre-existing behaviour.
  for (const r of records) if ((r.commentsCount ?? 0) > 0) delete r.lastCommentAt;
  notes.push(`lastCommentAt phase failed, field left absent: ${String(err.message).slice(0, 200)}`);
}
const lastCommentRequests = log.length - lastCommentRequestsBefore;
if (lastComment.stats && lastComment.stats.loginError) notes.push(`lastCommentAt: GET /user failed (${lastComment.stats.loginError}); records needing a read left without the field`);
for (const f of lastComment.failures) notes.push(`lastCommentAt: ${f.key} left absent: ${f.error}`);
for (const r of records) {
  const d = derivedInputs.get(r);
  if (d && r.commentsCount !== d.statusInput.commentsCount) r.status = derivedStatus({ ...d.statusInput, commentsCount: r.commentsCount });
}

/* lastActivityAt without our own comment's bump (see activityWithoutExcluded).
   Runs per ARTEFACT, before the merge, so a merged card takes the max of
   corrected values. counter may be null (GraphQL failed): the other signals
   still stand. The raw value is kept as lastActivityAtRaw when it differs. */
const activityAudit = [];
function applyActivityExclusion(rec, counter) {
  const d = derivedInputs.get(rec);
  const key = `${rec.repo}#${rec.id}`;
  const excludedLatestAt = lastComment.excludedAt ? lastComment.excludedAt[key] : undefined;
  if (!d || excludedLatestAt === undefined) return;
  const others = d.others.concat([rec.lastCommentAt, counter && counter.latestCountedAt].filter(Boolean));
  const out = activityWithoutExcluded({ raw: rec.lastActivityAt, updatedAt: d.updatedAt, excludedLatestAt, others });
  if (!out.adjusted) return;
  activityAudit.push({ key, raw: rec.lastActivityAt, adjusted: out.at, updatedAt: d.updatedAt, excludedLatestAt });
  rec.lastActivityAtRaw = rec.lastActivityAt;
  rec.lastActivityAt = out.at;
}
let activityExclusionApplied = false;
let refsAged = 0;
fs.writeFileSync(`${SCRATCH_DIR}/last-comment-audit.json`, JSON.stringify({ stats: lastComment.stats, requests: lastCommentRequests, cacheLoaded: commentCacheLoaded, audit: lastComment.audit }, null, 2));

/* ---- phase 3a: attach bb threads, and let them express stages 2/3/4 ---- */
const { byRepo: threadsByRepo, diag: bbDiag, listing: threadListing } = loadThreads();
for (const d of bbDiag) notes.push(d);

/* Signal A ('pr-env'): bb's pullForThread for LIVE threads. Feature-detected
   once per run, because `bb rpc` only exists from skills#435 on; when it is
   unknown the signal is skipped and said so, and the run carries on. Threads on
   an environment shared by several live threads are not asked at all: their
   answer would be ignored (see linkThreads). Cost is measured per cycle. */
const PR_ENV_CONCURRENCY = 4;
const prEnv = { status: 'not run', liveThreads: 0, skippedSharedEnv: 0, calls: 0, wallMs: 0, maxCallMs: 0, pulls: 0, nulls: 0, errors: 0, errorSamples: [] };
const pulls = new Map();
{
  const probe = await execAsync('bb rpc');
  const det = detectBbRpc(probe);
  if (!det.available) {
    prEnv.status = `skipped: ${det.why}`;
    console.log(`bb pr-env      : SKIPPED — ${det.why}`);
  } else {
    const shared = sharedEnvironmentIds(Object.values(threadsByRepo).flat());
    const live = Object.values(threadsByRepo).flat().filter((t) => threadIsLive(t) && /^thr_[A-Za-z0-9]+$/.test(String(t.id)));
    const targets = live.filter((t) => !(t.environmentId && (shared.get(t.environmentId) || 1) > 1));
    prEnv.liveThreads = live.length;
    prEnv.skippedSharedEnv = live.length - targets.length;
    const t0 = Date.now();
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const t = targets[next++];
        const c0 = Date.now();
        const r = await execAsync(`bb rpc github pullForThread ${shellArg(JSON.stringify({ threadId: t.id }))} --json`);
        const ms = Date.now() - c0;
        prEnv.calls++;
        prEnv.maxCallMs = Math.max(prEnv.maxCallMs, ms);
        try {
          if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${String(r.stderr || r.stdout).trim().slice(0, 120)}`);
          const pull = parsePullForThread(r.stdout);
          pulls.set(t.id, pull);
          if (pull) prEnv.pulls++;
          else prEnv.nulls++;
        } catch (err) {
          prEnv.errors++;
          if (prEnv.errorSamples.length < 5) prEnv.errorSamples.push({ thread: t.id, error: String(err.message).slice(0, 160) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PR_ENV_CONCURRENCY, targets.length) }, worker));
    prEnv.wallMs = Date.now() - t0;
    prEnv.status = 'ran';
    console.log(`bb pr-env      : ${prEnv.calls} pullForThread calls in ${(prEnv.wallMs / 1000).toFixed(1)} s (max ${(prEnv.maxCallMs / 1000).toFixed(1)} s), ${prEnv.pulls} PRs, ${prEnv.nulls} null, ${prEnv.errors} errors, ${prEnv.skippedSharedEnv} live threads not asked (shared environment)`);
  }
}

// The linker's inputs, for offline audit and replay (scratch only).
fs.writeFileSync(`${SCRATCH_DIR}/thread-link-inputs.json`, JSON.stringify({
  records: records.map((r) => ({ repo: r.repo, id: r.id, kind: r.kind, stage: r.stage, title: r.title })),
  prInfo: Object.fromEntries([...prInfo].map(([k, v]) => [k, { ...v, refs: [...v.refs] }])),
  threadsByRepo,
  pulls: Object.fromEntries(pulls),
  prEnv,
}, null, 1));

const linkAudit = [];
const { rejected, stats: linkStats } = linkThreads({ records, threadsByRepo, pulls, prInfo });
const refsCarried = carryRefsThreads({ records, prInfo });
for (const rec of records) {
  if (!rec.thread) continue;
  const promoted = stageFromThread(rec, rec.thread);
  if (promoted) {
    rec.stage = promoted.stage;
    rec.stageWhy = promoted.why;
  }
  linkAudit.push({
    record: `${rec.repo}#${rec.id}`,
    recordTitle: rec.title,
    threadId: rec.thread.id,
    threadTitle: rec.thread.title,
    matchedBy: rec.thread.matchedBy,
    viaPr: rec.thread.viaPr || undefined,
    branch: rec.thread.branch,
    live: rec.thread.live,
    candidates: rec.threadCandidates || 1,
    stage: rec.stage,
  });
}
fs.writeFileSync(`${SCRATCH_DIR}/thread-link-audit.json`, JSON.stringify({ linked: linkAudit, rejected }, null, 2));

/* ---- phase 4: one card per piece of work, PR > issue > thread ----------

   The identifier precedence is PR, then issue, then thread/scoop. So when a
   PR closes an issue, the PR leads the merged record: its number is the card's
   identifier and ITS stage is the card's stage, because CI and review state are
   the better signal. Nothing disappears — every artefact is listed in
   `artifacts` with how its link was established, and `secondary` is what the
   panel renders so the reader can see and reach each one.

   OUT-OF-WINDOW ISSUES: if a PR closes an issue that is not in the window, the
   issue is carried as SECONDARY CONTEXT ONLY (number, url, title, state from
   GraphQL). It does not become a card and it does not change the PR's stage.
   Reason: the work is already represented by its leading artefact, and pulling
   stale issues in would widen the window arbitrarily — only issues that happen
   to have a PR would appear, which is a biased sample.
   ---------------------------------------------------------------------- */
let closingCost = null;
const mergeAudit = { merged: [], rejected: [], secondaryOutOfWindow: [] };
try {
  const { closedBy, closes, counters, viewerLogin, cost } = await closingLinks(records);
  closingCost = cost;
  if (!viewerLogin) notes.push('GraphQL viewer login missing: stall counters and recent comments left undetermined rather than risk counting the mirror');
  // Five-working-day counter input, on every issue record. Excluded comments
  // (the mirror's, bots') neither reset it nor reach the model as text.
  for (const r of records) {
    const c = counters[`${r.repo}#${r.id}`];
    if (!c || c.undeterminedLogin) continue;
    if (c.resetAt !== undefined) {
      r.counterResetAt = c.resetAt;
      r.counterResetBy = c.resetBy;
    } else {
      notes.push(`${r.repo}#${r.id}: every timeline event in the window was excluded; stall counter left undetermined`);
    }
    r.counterQualifyingEvents = c.qualifyingCount;
    // Comment text for the status model — the substance a title cannot carry.
    if (c.recentComments.length) r.recentComments = c.recentComments;
  }
  for (const r of records) applyActivityExclusion(r, counters[`${r.repo}#${r.id}`] || null);
  activityExclusionApplied = true;
  refsAged = applyRefsAging(records, refsCarried);
  const byKey = new Map(records.map((r) => [`${r.repo}#${r.id}`, r]));
  const absorbed = new Set();

  // Issue -> closing PRs. Only a GraphQL closing relationship counts.
  for (const [issueKey, prRefs] of Object.entries(closedBy)) {
    const issue = byKey.get(issueKey);
    if (!issue || !prRefs.length) continue;
    const inWindow = prRefs.filter((p) => byKey.has(p.key));
    if (!inWindow.length) {
      for (const p of prRefs) {
        mergeAudit.rejected.push({ issue: issueKey, pr: p.key, reason: 'closing PR is outside the window, issue stays its own card' });
      }
      // It still HAS work: the five-working-day rule must not stall it.
      issue.hasClosingPr = true;
      issue.closingPrsOutOfWindow = prRefs.map((p) => p.key);
      continue;
    }
    // LEADER CHOICE among several closing PRs: prefer one that is open and not
    // a draft, then open draft, then the most recently updated; ties by number.
    const rank = (p) => (p.state === 'OPEN' && !p.isDraft ? 0 : p.state === 'OPEN' ? 1 : p.state === 'MERGED' ? 2 : 3);
    const sorted = inWindow.slice().sort((a, b) => rank(a) - rank(b) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || Number(b.number) - Number(a.number));
    const lead = byKey.get(sorted[0].key);
    if (!lead || absorbed.has(lead.repo + '#' + lead.id)) continue;

    lead.artifacts = lead.artifacts || [
      { role: 'lead', kind: 'pr', repo: lead.repo, number: lead.id, url: lead.url, state: lead.stateReason, linkedBy: 'self' },
    ];
    lead.artifacts.push({
      role: 'closes', kind: 'issue', repo: issue.repo, number: issue.id, url: issue.url,
      title: issue.title, state: issue.stateReason, labels: issue.labels,
      linkedBy: 'graphql:closedByPullRequestsReferences',
    });
    for (const other of sorted.slice(1)) {
      lead.artifacts.push({ role: 'alsoCloses', kind: 'pr', repo: other.repo, number: other.number, state: other.state, title: other.title, linkedBy: 'graphql:closedByPullRequestsReferences' });
    }
    if (issue.thread && !lead.thread) lead.thread = issue.thread;
    // The card's idleness must reflect the newest activity of either artefact.
    const rawActivity = maxDate(lead.lastActivityAtRaw || lead.lastActivityAt, issue.lastActivityAtRaw || issue.lastActivityAtOwn || issue.lastActivityAt);
    lead.lastActivityAt = maxDate(lead.lastActivityAt, issue.lastActivityAtOwn || issue.lastActivityAt);
    if (rawActivity !== lead.lastActivityAt) lead.lastActivityAtRaw = rawActivity;
    else delete lead.lastActivityAtRaw;
    const total = (lead.commentsTotal ?? lead.commentsCount ?? 0) + (issue.commentsTotal ?? issue.commentsCount ?? 0);
    lead.commentsCount = (lead.commentsCount || 0) + (issue.commentsCount || 0);
    lead.commentsTotal = total;
    // One card, one comment signal: a comment on EITHER artefact is follow-up
    // on this work. Mirror comments were already excluded per artefact.
    const lc = combineLastCommentAt(lead.lastCommentAt, issue.lastCommentAt);
    if (lc === undefined) delete lead.lastCommentAt;
    else lead.lastCommentAt = lc;
    absorbed.add(issueKey);
    mergeAudit.merged.push({
      card: `${lead.repo}#${lead.id}`, lead: 'pr', leadTitle: lead.title, leadStage: lead.substage || lead.stage,
      absorbedIssue: issueKey, issueTitle: issue.title, issueStageWas: issue.substage || issue.stage,
      alsoClosingPrs: sorted.slice(1).map((p) => p.key),
      linkedBy: 'graphql:closedByPullRequestsReferences',
    });
  }

  // PR -> closing issues that are NOT in the window: secondary context only.
  for (const [prKey, issueRefs] of Object.entries(closes)) {
    const pr = byKey.get(prKey);
    if (!pr) continue;
    for (const iss of issueRefs) {
      if (byKey.has(iss.key)) continue; // handled above
      pr.artifacts = pr.artifacts || [
        { role: 'lead', kind: 'pr', repo: pr.repo, number: pr.id, url: pr.url, state: pr.stateReason, linkedBy: 'self' },
      ];
      pr.artifacts.push({
        role: 'closes', kind: 'issue', repo: iss.repo, number: iss.number, url: iss.url,
        title: iss.title, state: iss.state, labels: iss.labels, outOfWindow: true,
        linkedBy: 'graphql:closingIssuesReferences',
      });
      mergeAudit.secondaryOutOfWindow.push({ card: prKey, issue: iss.key, issueState: iss.state, issueTitle: iss.title });
    }
  }

  // Drop absorbed issues, and give every record its display list.
  const kept = records.filter((r) => !absorbed.has(`${r.repo}#${r.id}`));
  records.length = 0;
  records.push(...kept);
  for (const r of records) {
    if (!r.artifacts && !r.thread) continue;
    const sec = [];
    for (const a of r.artifacts || []) {
      if (a.role === 'lead') continue;
      sec.push({
        kind: a.kind, label: `${a.repo.split('/')[1]}#${a.number}`, url: a.url || null,
        role: a.role, title: a.title || null, state: a.state || null, outOfWindow: !!a.outOfWindow,
      });
    }
    if (r.thread) {
      // Phase 7f: build the thread's URL here rather than emitting null. Both
      // halves are now available — the bb origin from the config and the
      // project id from the per-repo map — so the panel does not have to
      // reconstruct it. Falls back to the project-less form when this repo has
      // no bb project (a configured `bbProject: null`), which still resolves.
      sec.push({
        kind: 'thread',
        label: r.thread.id,
        url: urlForTarget(r, r.thread.id, 'thread'),
        role: 'thread',
        title: r.thread.title || null,
        state: r.thread.state || null,
      });
    }
    if (sec.length) r.secondary = sec;
  }
  mergeAudit.accounting = {
    recordsIn: kept.length + absorbed.size,
    cardsOut: records.length,
    absorbedAsSecondary: [...absorbed],
  };
} catch (err) {
  notes.push(`closing-link merge skipped: ${String(err.message).slice(0, 200)}`);
  mergeAudit.error = String(err.message).slice(0, 300);
  if (!activityExclusionApplied) {
    for (const r of records) applyActivityExclusion(r, null);
    refsAged = applyRefsAging(records, refsCarried);
  }
}
fs.writeFileSync(`${SCRATCH_DIR}/activity-exclusion-audit.json`, JSON.stringify(activityAudit, null, 2));
fs.writeFileSync(`${SCRATCH_DIR}/merge-audit.json`, JSON.stringify(mergeAudit, null, 2));

records.sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));

/* ---- phase 6b: ONE AGENT PER RECORD, bounded worker pool ---------------
   Each agent sees only that item's measured fields (now including its body and
   recent comments) and is told not to speculate. A per-item failure keeps that
   record's mechanical status; the panel never calls a model.
   ---------------------------------------------------------------------- */

function modelInputOne(r) {
  const [one] = modelInput([r]).records;
  return one;
}

function modelInput(recs) {
  return {
    records: recs.map((r) => {
      const st = { key: `${r.repo}#${r.id}`, kind: r.kind, state: STATE_LABEL[r.substage || r.stage] || String(r.stage), title: r.title, labels: r.labels, comments: r.commentsCount ?? null, idleHours: Math.round((Date.now() - new Date(r.lastActivityAt)) / 36e5) };
      if (r.ci) st.ci = r.ci;
      if (r.reviewers) st.reviewers = r.reviewers;
      if (r.mergedAt) st.mergedAt = r.mergedAt;
      if (r.stateReason) st.stateReason = r.stateReason;
      if (r.thread) st.thread = { title: r.thread.title, status: r.thread.state, archived: r.thread.archived, waitingForInput: r.thread.hasPendingInteraction };
      // The substance. Without this the model could only paraphrase the title,
      // which is exactly the defect reported against a real record.
      if (r.bodyExcerpt) st.body = r.bodyExcerpt;
      if (r.recentComments) st.recentComments = r.recentComments;
      // A merged card must be summarised as ONE piece of work.
      if (r.secondary && r.secondary.length) {
        st.alsoCovers = r.secondary
          .filter((x) => x.kind !== 'thread')
          .map((x) => ({ item: x.label, relation: x.role, title: x.title, state: x.state }));
      }
      return st;
    }),
  };
}

/* Phase 7b: the ACTION VOCABULARY for one record.

   The grounding trick lives here. This function tells the model exactly which
   identifiers it may target and exactly which evidence kinds this record
   actually has, so the model is never invited to invent a reviewer or a CI
   result. Anything it invents anyway is rejected by validateActions() and
   counted, which turns ungroundedness into a measurement instead of a leak. */
function actionVocabularyFor(rec) {
  // Identifiers the model may name — built from the record, never from output.
  const targets = [{ ref: `${rec.repo}#${rec.id}`, type: rec.kind, what: 'this item' }];
  for (const sec of rec.secondary || []) {
    if (sec.kind === 'thread') continue;
    targets.push({ ref: sec.label, type: sec.kind, what: `${sec.role} — ${sec.title || 'related item'}` });
  }
  if (rec.thread) targets.push({ ref: rec.thread.id, type: 'thread', what: 'the linked bb thread' });

  // Evidence kinds this record can actually support.
  const grounds = ['stage'];
  if (rec.bodyExcerpt) grounds.push('body');
  if (rec.recentComments && rec.recentComments.length) grounds.push('comment');
  if (rec.ci) grounds.push('ci');
  if (rec.reviewers) grounds.push('review');
  if (rec.thread) grounds.push('thread');

  // approve only means something on a pull request.
  const kinds = rec.kind === 'pr' ? ACTION_KINDS : ACTION_KINDS.filter((k) => k !== 'approve');
  return { targets, grounds, kinds };
}

/* The prompt for ONE record. Phase 6b's hard rule (the status must add what the
   title does not carry) stays; phase 7b lengthens the card text and makes the
   follow-ups structured and grounded. */
function buildStatusPrompt(rec, { stricterLength = false } = {}) {
  const item = modelInputOne(rec);
  const vocab = actionVocabularyFor(rec);
  return [
    'You are writing the dashboard entry for one GitHub work item.',
    'The item, as JSON:',
    JSON.stringify(item, null, 1),
    '',
    'Produce ONLY this JSON object, no markdown fence, no commentary:',
    '{"short":"...","long":"...","actions":[{"kind":"...","label":"...","targetRef":"...","grounds":"...","because":"...","question":"..."}]}',
    '',
    `"short": the CARD text. ${stricterLength ? 'YOUR PREVIOUS ANSWER WAS TOO SHORT, THIS IS A RETRY. ' : ''}` +
      `Write 2-3 full sentences, ${CARD_CHARS_MIN}-${CARD_CHARS_MAX} characters (aim for ${CARD_CHARS_TARGET}).`,
    '  It is rendered in four lines of card space, so one short clause wastes the card.',
    '  Say what the item is about, where it stands, and what is holding it — all from the',
    '  fields above. One paragraph, no bullets, no line breaks.',
    '"long": 3-5 sentences of extra context for a hover tooltip. It must ADD to "short",',
    '  not repeat it: detail from the body or the comments that did not fit on the card.',
    '',
    `"actions": AT MOST ${MAX_ACTIONS} structured follow-ups, fewer when fewer apply, [] when none.`,
    '  NEVER pad. Each action is an object:',
    `    "kind"      exactly one of: ${vocab.kinds.join(' | ')}`,
    '                nudge   = poke a human or an agent to move it along',
    '                approve = approve or merge a pull request that is ready',
    '                clarify = ask a specific question, because something is genuinely ambiguous',
    `    "label"     the button face, imperative, max ${ACTION_LABEL_MAX} characters`,
    `    "targetRef" exactly one of: ${vocab.targets.map((t) => `"${t.ref}" (${t.what})`).join(', ')}`,
    `    "grounds"   the evidence it rests on, exactly one of: ${vocab.grounds.join(' | ')}`,
    `    "because"   max ${ACTION_BECAUSE_MAX} characters naming or quoting that evidence`,
    `    "question"  REQUIRED for kind "clarify" and only then, max ${ACTION_QUESTION_MAX} characters`,
    '',
    'HARD RULES:',
    '1. DO NOT RESTATE THE TITLE. The reader can already see the title. If your',
    '   "short" would just paraphrase it, you have failed: say what the item is',
    '   ABOUT instead, using the body, the comments and the state.',
    '   Bad  (title "Dependency Dashboard"): "Dependency Dashboard skill issue."',
    '   Good (same item, body lists Renovate bumps): "Renovate bumps blocked by',
    '   rate limiting; 15 dependency PRs queued."',
    '2. Use ONLY the fields given above. Do not speculate about causes, do not',
    '   invent history, do not describe code you have not seen. The body may be',
    '   truncated; do not guess what followed.',
    '3. An action you cannot ground in the fields above must NOT be emitted: no',
    '   invented reviewers, no invented CI results, no guessed owners. If nothing',
    '   is grounded, return "actions": [].',
    '4. No issue/PR numbers unless they appear in the data, and never mention',
    '   internal stage numbers.',
  ].join('\n');
}

/* Validation is where the contract is actually enforced, and every rejection is
   counted by reason so that "the model behaved" is a measurement rather than a
   hope. The FETCHER builds the url for a validated target, so a hallucinated
   link cannot reach the panel. */
const actionStats = {
  emitted: 0,
  kept: 0,
  recordsWithActions: 0,
  dropped: {
    notAnObject: 0,
    offVocabularyKind: 0,
    approveOnNonPr: 0,
    missingLabel: 0,
    ungroundedTarget: 0,
    ungroundedEvidence: 0,
    clarifyWithoutQuestion: 0,
    duplicate: 0,
    overCap: 0,
  },
  droppedSamples: [],
  byKind: { nudge: 0, approve: 0, clarify: 0 },
};

function noteDrop(reason, rec, a) {
  actionStats.dropped[reason]++;
  if (actionStats.droppedSamples.length < 12) {
    actionStats.droppedSamples.push({ key: `${rec.repo}#${rec.id}`, reason, raw: JSON.stringify(a).slice(0, 200) });
  }
}

function urlForTarget(rec, ref, type) {
  if (type === 'thread') {
    const project = BB_PROJECT[rec.repo] || null;
    return project ? `${BB_ORIGIN}/projects/${project}/threads/${ref}` : `${BB_ORIGIN}/threads/${ref}`;
  }
  const m = String(ref).match(/^([^#]+)#(\d+)$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${type === 'pr' ? 'pull' : 'issues'}/${m[2]}`;
}

function validateActions(rec, raw) {
  const vocab = actionVocabularyFor(rec);
  const byRef = new Map(vocab.targets.map((t) => [t.ref, t]));
  const out = [];
  const seen = new Set();
  for (const a of Array.isArray(raw) ? raw : []) {
    actionStats.emitted++;
    if (!a || typeof a !== 'object' || Array.isArray(a)) { noteDrop('notAnObject', rec, a); continue; }
    const kind = typeof a.kind === 'string' ? a.kind.trim().toLowerCase() : '';
    if (!ACTION_KINDS.includes(kind)) { noteDrop('offVocabularyKind', rec, a); continue; }
    if (kind === 'approve' && rec.kind !== 'pr') { noteDrop('approveOnNonPr', rec, a); continue; }
    const label = typeof a.label === 'string' ? a.label.trim().slice(0, ACTION_LABEL_MAX) : '';
    if (!label) { noteDrop('missingLabel', rec, a); continue; }
    // The target must be one of the identifiers WE offered. Silence defaults to
    // this item, which is unambiguous; anything else unknown is a drop.
    const ref = typeof a.targetRef === 'string' && a.targetRef.trim() ? a.targetRef.trim() : `${rec.repo}#${rec.id}`;
    const t = byRef.get(ref);
    if (!t) { noteDrop('ungroundedTarget', rec, a); continue; }
    const grounds = typeof a.grounds === 'string' ? a.grounds.trim().toLowerCase() : '';
    if (!vocab.grounds.includes(grounds)) { noteDrop('ungroundedEvidence', rec, a); continue; }
    const question = typeof a.question === 'string' ? a.question.trim().slice(0, ACTION_QUESTION_MAX) : '';
    if (kind === 'clarify' && !question) { noteDrop('clarifyWithoutQuestion', rec, a); continue; }
    const dedupe = `${kind}|${label.toLowerCase()}|${ref}`;
    if (seen.has(dedupe)) { noteDrop('duplicate', rec, a); continue; }
    seen.add(dedupe);
    if (out.length >= MAX_ACTIONS) { noteDrop('overCap', rec, a); continue; }
    const act = { kind, label, target: { type: t.type, ref, url: urlForTarget(rec, ref, t.type) }, grounds };
    if (typeof a.because === 'string' && a.because.trim()) act.because = a.because.trim().slice(0, ACTION_BECAUSE_MAX);
    if (kind === 'clarify') act.question = question;
    out.push(act);
    actionStats.kept++;
    actionStats.byKind[kind]++;
  }
  return out;
}

function parseStatusJson(text) {
  let t = String(text).trim();
  const fence = t.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  if (fence) t = fence[1].trim();
  // An agent may wrap its object in prose: take the outermost braces.
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in output');
  return JSON.parse(t.slice(start, end + 1));
}

/* ---- 8< agentLedger ------------------------------------------------------
   AGENT-SPEND LEDGER. `cost --json` does not record `agent` one-shot spend at
   all (ai-ecoverse/slicc#3437; re-measured 2026-09-23: a haiku one-shot left
   the 19 cost entries unchanged), so this fetcher keeps its own account.

   WHAT IS MEASURABLE, established with a real call on 2026-09-23
   (`agent --model global.anthropic.claude-haiku-4-5-20251001-v1:0 --thinking
   off . '' 'Reply with exactly: OK'`): stdout "OK\n", stderr empty, exit 0,
   98.6 s wall. The command returns ONLY the final message. Its transcript
   (/tmp/agent-<name>-<ts>.md) records jid, exit code, turns, messages and the
   text, and no token counts, no cost and no model id. `agent --help` offers no
   usage flag. So the ledger records what the caller can see: call count, the
   model id WE passed, wall ms per call, prompt and response CHARACTERS, exit
   code, and why a call failed.

   NO COST ESTIMATE, on purpose. The only price source is the catalog in
   `models --json` ($/Mtok), but a spawned agent runs with its own system
   prompt and tool definitions that the caller never sees, so prompt
   characters x price would understate the real input by an unknown factor.
   A number that looks like a cost but is not one is worse than none.

   "calls" counts EVERY agent invocation, including the one-shot length retry,
   so it can exceed meta.statusGeneration.modelCalls, which counts records.

   Pure (exec, parse and the clock are injected) and fenced, so
   tests/agent-ledger.test.js evaluates this exact text. */
const AGENT_LEDGER_FILE = 'agent-ledger.jsonl';
// Newest lines kept. 2000 lines = ~41 days at one cycle per 30 minutes; the
// byte cap bounds the file even if lines grow (a cold run with many calls).
const AGENT_LEDGER_MAX_LINES = 2000;
const AGENT_LEDGER_MAX_BYTES = 1000000;
// Per-call detail carried into each jsonl line (all of it stays in the snapshot meta).
const AGENT_LEDGER_CALLS_PER_LINE = 40;

function newAgentLedger() {
  return { calls: [] };
}

/** Run ONE agent call through exec, time it, classify it, record it.
    Never throws. Returns { g, warning, entry }: g is the parsed answer, or
    null when the call failed (exit != 0, unparseable, or no usable short). */
async function runStatusAgent({ exec, cmd, key, attempt, model, promptChars, ledger, parse, minShortChars = 4, now = () => Date.now() }) {
  const t0 = now();
  let r;
  try {
    r = await exec(cmd);
  } catch (err) {
    r = { exitCode: -1, stdout: '', stderr: String((err && err.message) || err) };
  }
  const ms = Math.max(0, now() - t0);
  const stdout = String((r && r.stdout) || '');
  const stderr = String((r && r.stderr) || '');
  const entry = { key, attempt, model, ms, promptChars, outputChars: stdout.length, exitCode: r ? r.exitCode : null, outcome: 'ok' };
  let g = null;
  let warning = null;
  if (entry.exitCode !== 0) {
    entry.outcome = 'exit';
    warning = `agent failed for ${key} (exit ${entry.exitCode}): ${stderr.trim().slice(0, 160)}`;
  } else {
    try {
      g = parse(stdout);
    } catch (err) {
      entry.outcome = 'unparseable';
      warning = `unparseable output for ${key}: ${err.message}; got: ${stdout.trim().slice(0, 160)}`;
    }
    if (entry.outcome === 'ok' && (!g || typeof g.short !== 'string' || g.short.trim().length < minShortChars)) {
      entry.outcome = 'unusable';
      warning = `no usable "short" for ${key}`;
    }
  }
  ledger.calls.push(entry);
  return { g: entry.outcome === 'ok' ? g : null, warning, entry };
}

/** "global.anthropic.claude-haiku-4-5-20251001-v1:0" -> "haiku-4-5". */
function shortModelName(id) {
  const m = String(id || '').match(/claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(id || 'unknown');
}

/** One cycle's account. cacheStats is the fetcher's status-cache tally: every
    hit there is a model call that did NOT happen. */
function summariseAgentLedger(ledger, { cacheStats = {}, statusPhaseWallMs = null, records = null, at = null } = {}) {
  const calls = ledger.calls;
  const ms = calls.map((c) => c.ms);
  const failures = { exit: 0, unparseable: 0, unusable: 0 };
  for (const c of calls) if (c.outcome !== 'ok') failures[c.outcome] = (failures[c.outcome] || 0) + 1;
  const failed = calls.length - calls.filter((c) => c.outcome === 'ok').length;
  const hits = (cacheStats.hits || 0) + (cacheStats.doneServedFromCache || 0);
  const total = ms.reduce((a, b) => a + b, 0);
  return {
    at,
    calls: calls.length,
    firstAttempts: calls.filter((c) => c.attempt === 'first').length,
    retries: calls.filter((c) => c.attempt === 'retry').length,
    models: [...new Set(calls.map((c) => c.model))],
    ok: calls.length - failed,
    failed,
    failures,
    wallMs: { total, max: ms.length ? Math.max(...ms) : 0, mean: ms.length ? Math.round(total / ms.length) : 0 },
    statusPhaseWallMs,
    promptChars: calls.reduce((a, c) => a + (c.promptChars || 0), 0),
    outputChars: calls.reduce((a, c) => a + (c.outputChars || 0), 0),
    tokens: null,
    tokensWhy: 'agent reports no usage: stdout is the final message only, the transcript has no token counts, and cost --json does not record agent one-shots (slicc#3437)',
    costEstimate: null,
    costWhy: 'omitted: chars x catalog price would ignore the spawned agent\'s own system prompt and tools, so it would understate spend by an unknown factor',
    cache: {
      servedWithoutCall: hits,
      hits: cacheStats.hits || 0,
      doneServedFromCache: cacheStats.doneServedFromCache || 0,
      doneMechanical: cacheStats.doneMechanical || 0,
      misses: cacheStats.misses || 0,
    },
    records,
    perCall: calls.map((c) => ({ ...c })),
  };
}

/** The one line poll.jsh copies into its log. */
function formatLedgerLine(sum) {
  const models = sum.models.length ? sum.models.map(shortModelName).join(', ') : 'no model called';
  const retry = sum.retries ? ` incl. ${sum.retries} retr${sum.retries === 1 ? 'y' : 'ies'}` : '';
  return (
    `${sum.calls} call${sum.calls === 1 ? '' : 's'}${retry} (${models}), ${(sum.wallMs.total / 1000).toFixed(1)} s agent time` +
    (sum.calls ? ` (max ${(sum.wallMs.max / 1000).toFixed(1)} s)` : '') +
    `, ${sum.cache.servedWithoutCall} cached, ${sum.failed} failed`
  );
}

/** The jsonl record: the summary, with per-call detail truncated. */
function ledgerJsonLine(sum) {
  const { perCall, ...rest } = sum;
  const line = { ...rest, perCall: perCall.slice(0, AGENT_LEDGER_CALLS_PER_LINE).map((c) => [c.key, c.attempt, c.ms, c.promptChars, c.outputChars, c.outcome]) };
  if (perCall.length > AGENT_LEDGER_CALLS_PER_LINE) line.perCallTruncated = perCall.length - AGENT_LEDGER_CALLS_PER_LINE;
  return JSON.stringify(line);
}

/** Append one line and keep only the newest lines within BOTH caps. Blank
    lines are dropped; the newest line is always kept. Returns the file text. */
function capJsonl(existing, line, { maxLines = AGENT_LEDGER_MAX_LINES, maxBytes = AGENT_LEDGER_MAX_BYTES } = {}) {
  const enc = new TextEncoder();
  const lines = String(existing || '').split('\n').filter((l) => l.trim().length > 0);
  lines.push(String(line));
  let keep = lines.slice(-Math.max(1, maxLines));
  let bytes = keep.reduce((a, l) => a + enc.encode(l).length + 1, 0);
  while (keep.length > 1 && bytes > maxBytes) {
    bytes -= enc.encode(keep[0]).length + 1;
    keep = keep.slice(1);
  }
  return keep.join('\n') + '\n';
}
/* ---- >8 end agentLedger ---------------------------------------------------- */

/** One agent for one record. Never throws: a failure returns null and the
 *  caller keeps the mechanical status for that item.
 *  Phase 7b: ONE retry when the card text comes back too short. A retry costs
 *  one call; a card that cannot fill its reserved space costs every viewing. */
async function generateStatusFor(rec) {
  const key = `${rec.repo}#${rec.id}`;
  const attempt = async (stricterLength) => {
    /* Phase 7g, measured rather than assumed:

       • ZERO TOOL CALLS. All 619 agent transcripts under /tmp/agent-*.md are
         turns:1, messages:2 — prompt in, JSON out, nothing else. The premise
         that they were "going out to perform tool calls" does not hold, so
         inlining more context cannot buy wall time; there is nothing to inline
         away. The record already carries bodyExcerpt + up to 3 recentComments.
       • ALLOWED COMMANDS is now the empty string, not `true`. Measured: an
         agent with `''` runs and answers normally, so this is free insurance —
         a future prompt cannot tempt a status agent into a fetch.
       • THINKING OFF. Measured on the same prompt: inherited thinking billed
         materially more output tokens for the same answer quality and the
         same wall time (75.0s vs 73.9s). Thinking is ~21% of the per-call cost
         and ~0% of its duration, so it goes.
       • WALL TIME IS FIXED OVERHEAD, not generation: ~74s per call in isolation,
         inflating to ~174s each when six run at once. The only lever on the
         status phase is FEWER CALLS — which is what the done-column skip does. */
    const prompt = buildStatusPrompt(rec, { stricterLength });
    const cmd = `agent --model ${shellArg(STATUS_MODEL)} --thinking off . ${shellArg('')} ${shellArg(prompt)}`;
    const { g, warning } = await runStatusAgent({
      exec: execAsync, cmd, key, attempt: stricterLength ? 'retry' : 'first',
      model: STATUS_MODEL, promptChars: prompt.length, ledger: agentLedger, parse: parseStatusJson,
    });
    if (warning) console.error(`[status] WARNING: ${warning}`);
    return g;
  };
  let g = await attempt(false);
  if (g && g.short.trim().length < CARD_CHARS_MIN) {
    statusLengthStats.retried++;
    const again = await attempt(true);
    if (again && again.short.trim().length > g.short.trim().length) {
      statusLengthStats.retryHelped++;
      g = again;
    }
  }
  return g;
}

/* Bounded concurrency, monday-style: a plain Promise.all over every record
   would spawn 101 simultaneous agents. */
let modelCalls = 0;
const agentLedger = newAgentLedger();
let generated = 0;
const fellBack = [];
const statusWallClockStart = Date.now();
const statusLengthStats = { retried: 0, retryHelped: 0, belowMinAfterRetry: 0 };

/* ---- phase 7b: the status cache --------------------------------------- */

function loadStatusCache() {
  try {
    const raw = fs.readFileSync(STATUS_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries && typeof parsed.entries === 'object') {
      return { version: parsed.version ?? 1, entries: parsed.entries };
    }
    console.error('[cache] WARNING: cache file has the wrong shape; starting empty');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[cache] WARNING: cache unreadable (${err.message}); starting empty`);
    }
  }
  return { version: 1, entries: {} };
}

const statusCache = loadStatusCache();
const cacheStats = { loadedEntries: Object.keys(statusCache.entries).length, hits: 0, misses: 0, staleActivity: 0, staleContract: 0, skippedDoneColumn: 0, doneServedFromCache: 0, doneMechanical: 0, skippedAgedOut: 0, wrote: 0 };

/** A hit needs all three to match: same activity timestamp, same prompt
 *  contract, same model. Anything else would serve prose written under rules
 *  that no longer hold. */
function cacheLookup(rec) {
  const e = statusCache.entries[`${rec.repo}#${rec.id}`];
  if (!e) return null;
  // refs-pr aging moves lastActivityAt with a referencing PR; the cache keys on
  // the record's OWN activity so that does not re-trigger a status-model call.
  if (e.lastActivityAt !== (rec.lastActivityAtOwn || rec.lastActivityAt)) { cacheStats.staleActivity++; return null; }
  if (e.promptVersion !== PROMPT_VERSION || e.model !== STATUS_MODEL) { cacheStats.staleContract++; return null; }
  return e;
}

function cacheStore(rec, payload) {
  statusCache.entries[`${rec.repo}#${rec.id}`] = {
    lastActivityAt: rec.lastActivityAtOwn || rec.lastActivityAt,
    promptVersion: PROMPT_VERSION,
    model: STATUS_MODEL,
    generatedAt: new Date().toISOString(),
    status: payload.status,
    statusLong: payload.statusLong ?? null,
    actions: payload.actions ?? [],
  };
  cacheStats.wrote++;
  // Flush as we go. The first 7b attempt was killed at a 50-minute ceiling with
  // every generated line still in memory, so the next run had to pay for all of
  // them again. An interrupted run must leave its work behind, which also makes
  // the whole status phase RESUMABLE.
  if (cacheStats.wrote % 5 === 0) writeStatusCache();
}

function writeStatusCache() {
  try {
    fs.writeFileSync(
      STATUS_CACHE_PATH,
      JSON.stringify(
        {
          version: 1,
          note: 'Status cache for the github-dashboard fetcher. Written ONLY by fetch-snapshot.mjs, read by nobody else. Never mixed with user-state.json, which belongs to panel clicks. A hit requires the same lastActivityAt, promptVersion and model.',
          promptVersion: PROMPT_VERSION,
          model: STATUS_MODEL,
          updatedAt: new Date().toISOString(),
          entries: statusCache.entries,
          comments: {
            note: 'lastCommentAt per artefact. A hit needs the same lastActivityAt AND commentsCount AND login; mirror (marker + own login) and bot comments are excluded. Pruned to the current window each run.',
            login: commentCache.login,
            entries: commentCache.entries,
          },
        },
        null,
        1,
      ) + '\n',
    );
  } catch (err) {
    console.error(`[cache] WARNING: could not write the cache (${err.message}); the next run will regenerate everything`);
  }
}

/** Records the panel will HIDE get the mechanical status and no agent call.
 *  DONE_RETENTION_WORKING_DAYS = 2 in the panel: a terminal item older than that
 *  is categorised 'aged-out' and never rendered, so prose for it buys nothing.
 *  The working-day arithmetic is the panel's, required from workdays-shared.cjs
 *  rather than re-derived here (p7b-workdays-drift.mjs asserts they agree). */
/* Phase 7g, requested: "we don't need to update the status for the done column, as
   nobody will look at them."

   So the whole DONE COLUMN gets no agent call — not just the aged-out tail. The
   7b rule skipped only records older than the retention window, which on a
   Monday was 3 of 101 while 82 sat in the done column: the saving was a rounding
   error. Measured on this record set, the rule takes a cold run from 98 agent
   calls to 19.

   A done record may still have generated prose in the cache from when it was
   live. That prose is SERVED rather than thrown away:
     • it costs nothing — a hit is a map lookup, no agent;
     • it is not stale, because the cache key includes lastActivityAt: the entry
       only matches while the record has not moved;
     • forcing the mechanical line instead would visibly downgrade the text on a
       card the moment it merged, for no saving at all.
   And a REOPENED PR is safe by the same key: reopening moves lastActivityAt, so
   the old entry stops matching — the card reads mechanically while it is done,
   and earns a fresh agent call as soon as it leaves the column. Nothing is
   written to the cache for a done record, so the cache never grows prose that
   was never displayed. */
const DONE_STAGES_FOR_SKIP = [10, 11];
const DONE_RETENTION_WORKING_DAYS = 2;
function isDoneColumn(rec) {
  return DONE_STAGES_FOR_SKIP.includes(rec.stage);
}

STATUS_MODEL = await resolveStatusModel(STATUS_MODEL_HINT);
console.log(`status model   : ${STATUS_MODEL} (resolved from hint "${STATUS_MODEL_HINT}"), concurrency ${STATUS_CONCURRENCY}, prompt ${PROMPT_VERSION}`);
console.log(`status cache   : ${cacheStats.loadedEntries} entries loaded from ${STATUS_CACHE_PATH}`);

{
  const now = new Date();
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < records.length) {
      const i = next++;
      const rec = records[i];
      done++;

      // 1. Will the panel even show it? If not, the mechanical line is enough.
      // 1. Is it in the done column? Then no agent, ever — but a cache entry
      //    that still matches this exact lastActivityAt may supply prose.
      if (isDoneColumn(rec)) {
        cacheStats.skippedDoneColumn++;
        const cached = cacheLookup(rec);
        if (cached) {
          cacheStats.doneServedFromCache++;
          rec.statusMechanical = rec.status;
          rec.status = cached.status;
          rec.statusSource = 'agent';
          rec.statusCached = cached.generatedAt;
          if (cached.statusLong) rec.statusLong = cached.statusLong;
          if (Array.isArray(cached.actions) && cached.actions.length) rec.actions = cached.actions;
          rec.statusSkipped = 'in the done column: no agent call; prose served from the status cache';
        } else {
          cacheStats.doneMechanical++;
          rec.statusSkipped = 'in the done column: no agent call, mechanical line kept';
        }
        const agedOut = workingDaysSince(rec.lastActivityAt, now) > DONE_RETENTION_WORKING_DAYS;
        if (agedOut) cacheStats.skippedAgedOut++;
        continue;
      }

      // 2. Has anything changed since we last wrote about it?
      const hit = cacheLookup(rec);
      if (hit) {
        cacheStats.hits++;
        rec.statusMechanical = rec.status;
        rec.status = hit.status;
        rec.statusSource = 'agent';
        rec.statusCached = hit.generatedAt;
        if (hit.statusLong) rec.statusLong = hit.statusLong;
        if (Array.isArray(hit.actions) && hit.actions.length) rec.actions = hit.actions;
        continue;
      }
      cacheStats.misses++;

      modelCalls++;
      const g = await generateStatusFor(rec);
      if (done % 8 === 0 || done === records.length) {
        const line = `[status]   ${done}/${records.length} (hits ${cacheStats.hits}, calls ${modelCalls}, done-skipped ${cacheStats.skippedDoneColumn}) ${new Date().toISOString()}`;
        console.log(line);
        // Stdout is buffered until exit when this run is detached, so progress
        // also goes to a file that can be tailed while it works.
        try { fs.appendFileSync(`${SCRATCH_DIR}/p7b-progress.log`, line + "\n"); } catch {}
      }
      if (!g) {
        fellBack.push({ key: `${rec.repo}#${rec.id}`, reason: 'agent failed or returned unusable output' });
        continue;
      }
      rec.statusMechanical = rec.status;
      rec.status = g.short.trim();
      rec.statusSource = 'agent';
      if (rec.status.length < CARD_CHARS_MIN) statusLengthStats.belowMinAfterRetry++;
      if (typeof g.long === 'string' && g.long.trim()) rec.statusLong = g.long.trim();
      const acts = validateActions(rec, g.actions);
      if (acts.length) rec.actions = acts;
      else delete rec.actions;
      cacheStore(rec, { status: rec.status, statusLong: rec.statusLong, actions: rec.actions });
      generated++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, records.length) }, worker));
}
const statusWallClockMs = Date.now() - statusWallClockStart;

// "Records the panel sees carrying actions", which includes cache-served ones.
actionStats.recordsWithActions = records.filter((r) => Array.isArray(r.actions) && r.actions.length).length;

// The cache is written even when nothing was generated: a hits-only run still
// proves the file is current.
writeStatusCache();

const agentLedgerSummary = summariseAgentLedger(agentLedger, { cacheStats, statusPhaseWallMs: statusWallClockMs, records: records.length, at: new Date().toISOString() });
const AGENT_LEDGER_PATH = require('path').join(require('path').dirname(STATUS_CACHE_PATH), AGENT_LEDGER_FILE);
{
  // Written BEFORE the snapshot, so spend is on record even if a later write
  // fails. Never fatal. Atomic: temp file, then rename.
  try {
    let prev = '';
    try { prev = fs.readFileSync(AGENT_LEDGER_PATH, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const next = capJsonl(prev, ledgerJsonLine(agentLedgerSummary));
    fs.writeFileSync(AGENT_LEDGER_PATH + '.tmp', next);
    fs.renameSync(AGENT_LEDGER_PATH + '.tmp', AGENT_LEDGER_PATH);
  } catch (err) {
    console.error(`[ledger] WARNING: could not append ${AGENT_LEDGER_PATH} (${err.message}); the cycle's spend is still in meta.agentLedger`);
  }
}

const snapshot = {
  meta: {
    generatedAt: new Date().toISOString(),
    generator: 'fetch-snapshot.mjs (canonical: /shared/sprinkles/github-dashboard/fetch-snapshot.mjs)',
    repos: perRepo,
    // Phase 7e: where the monitored set came from, and the bb origin, so the
    // panel can stop hard-coding BB_ORIGIN and read it from here instead.
    bbOrigin: MONITOR.bbOrigin,
    config: {
      path: MONITOR.path,
      source: MONITOR.source,
      repos: MONITOR.repos,
      reposWithoutBbProject: MONITOR.reposWithoutBbProject,
      note: MONITOR.note,
      schema: 'v1: { version: 1, bbOrigin, repos: [{ slug, bbProject|null }] } — owned by the future `gh monitor add|list|rm`',
    },
    window: `all open issues/PRs, plus items closed or merged in the last ${CLOSED_WINDOW_HOURS}h; scanned from the 100 most recently updated items per repo (issues endpoint returns issues + PRs)`,
    requestCount: log.length,
    transportRetries: { count: transportRetries.length, detail: transportRetries.slice(0, 12), policy: 'transport failures and 5xx are retried up to 4 times with backoff; 403/429 are never retried' },
    rateLimit: { limit: rl.limit, remainingAfter: rl.remaining, resetAt: new Date(Number(rl.reset) * 1000).toISOString() },
    statusSourceValues: {
      placeholder: 'human-authored prose (fixture only, no longer produced)',
      derived: 'mechanically composed from measured fields by this script',
      agent: `written by the ${STATUS_MODEL} model from the measured fields in one batched call; the mechanical string is kept as statusMechanical`,
    },
    agentLedger: {
      ...agentLedgerSummary,
      file: AGENT_LEDGER_PATH,
      fileCap: `newest ${AGENT_LEDGER_MAX_LINES} lines AND at most ${AGENT_LEDGER_MAX_BYTES} bytes; ${AGENT_LEDGER_CALLS_PER_LINE} per-call entries per line`,
      measuredFrom: 'the caller side of each agent invocation: wall ms, prompt and response characters, exit code, parse outcome',
    },
    statusGeneration: {
      model: STATUS_MODEL,
      modelHint: STATUS_MODEL_HINT,
      concurrency: STATUS_CONCURRENCY,
      promptVersion: PROMPT_VERSION,
      pattern: 'one agent per record through a bounded worker pool, after ai-ecoverse/skills/monday',
      spawnFlags: '--thinking off, empty allowed-commands: measured — these agents make zero tool calls, thinking costs materially more output tokens for the same answer in the same wall time, and per-call time is fixed overhead rather than generation',
      exactIdRequired: 'a bare alias passes agent validation but can silently spawn the parent model, so the id is resolved from models --json first',
      modelCalls, generated,
      fellBack,
      wallClockMs: statusWallClockMs,
      inputCaps: { bodyChars: BODY_CHARS, commentChars: COMMENT_CHARS, maxComments: MAX_COMMENTS },
      antiRestatementRule: 'the prompt forbids paraphrasing the title and requires the body/comments/state to carry the line',
      cardTextTarget: {
        minChars: CARD_CHARS_MIN,
        aimChars: CARD_CHARS_TARGET,
        maxChars: CARD_CHARS_MAX,
        why: 'the card reserves four lines and the status column is ~48 characters wide, so a 65-character line would leave three lines blank (phase 7b)',
        retryUnderMin: 'one retry with a stricter instruction; the longer of the two answers wins',
        retried: statusLengthStats.retried,
        retryHelped: statusLengthStats.retryHelped,
        stillBelowMin: statusLengthStats.belowMinAfterRetry,
      },
      cache: {
        path: STATUS_CACHE_PATH,
        key: 'owner/repo#number (GitHub numbers are per repository, so a bare number would collide across repos)',
        hitRequires: 'identical lastActivityAt AND promptVersion AND model',
        writtenBy: 'this script only; never by the panel, and never inside user-state.json',
        ...cacheStats,
      },
      doneColumnPolicy: {
        rule: 'phase 7g: NO agent call for any record in the done column (stage 10/11). Cached prose from when the record was live is still served, because the cache key includes lastActivityAt and so cannot be stale; nothing is written to the cache for a done record. A reopened PR moves lastActivityAt, which retires the entry and earns a fresh call once the record leaves the column.',
        why: 'nobody reads the done column. The 7b rule skipped only the aged-out tail (3 of 101 on a Monday) while 82 records sat in done.',
        workingDayArithmetic: "the panel's own workingDaysSince, shipped beside the fetcher as workdays-shared.cjs (a copy of the panel's inline implementation)",
        skippedDoneColumn: cacheStats.skippedDoneColumn,
        servedFromCache: cacheStats.doneServedFromCache,
        keptMechanical: cacheStats.doneMechanical,
        ofWhichAlsoAgedOut: cacheStats.skippedAgedOut,
      },
    },
    actionContract: {
      shape: {
        kind: `closed set: ${ACTION_KINDS.join(' | ')} — anything else is dropped and counted, never passed through`,
        label: `imperative button face, max ${ACTION_LABEL_MAX} chars`,
        target: 'a { type, ref, url } the FETCHER built after validating ref against the identifiers of THIS record (itself, its merged secondary artefacts, its bb thread). The model never supplies a url, so it cannot invent a link.',
        grounds: 'which evidence the action rests on (stage | body | comment | ci | review | thread), and it must be evidence this record actually carries',
        because: `max ${ACTION_BECAUSE_MAX} chars naming that evidence`,
        question: `clarify only, and required for it: the question to ask, max ${ACTION_QUESTION_MAX} chars`,
      },
      rules: [
        `at most ${MAX_ACTIONS} per record, never padded — records with nothing grounded carry no actions field at all`,
        'approve is offered only on pull requests: there is nothing to approve on an issue',
        'an action whose target or evidence is not in the vocabulary this record supplies is dropped, not repaired',
        'the panel renders these in phase 7c; phase 7b only produces them',
      ],
      stats: actionStats,
    },
    workItemMerge: {
      precedence: 'PR > issue > thread/scoop. The PR leads: its number is the card identifier and its stage is the card stage.',
      source: 'GraphQL closedByPullRequestsReferences / closingIssuesReferences in ONE batched aliased request',
      whyNotTimeline: "REST timeline 'cross-referenced' fires on any mention. On this data set it would have claimed a record#3243 is closed by 7 PRs and skills#389 by 2; GraphQL says none of them close anything.",
      graphqlCost: closingCost,
      leaderRuleWhenSeveralPrsClose: 'open non-draft, then open draft, then merged, then closed; ties by most recently updated, then highest number. The others are recorded as role "alsoCloses".',
      outOfWindowIssuePolicy: 'carried as secondary context only (number, url, title, state from GraphQL); never becomes a card, never changes the PR stage',
      merged: mergeAudit.merged.length,
      rejected: mergeAudit.rejected.length,
      secondaryOutOfWindow: mergeAudit.secondaryOutOfWindow.length,
      accounting: mergeAudit.accounting || null,
      auditFile: 'written to /tmp/ghd/merge-audit.json by the fetcher run (not shipped under /shared)',
      labelPolicy: 'the card keeps the LEAD artefact labels; an absorbed issue keeps its own labels inside artifacts, so nothing is lost and no label is mis-attributed to the PR',
    },
    issueStallCounter: {
      rule: 'an OPEN issue with no work (no closing PR, no thread of any kind) and commentsCount === 0 becomes STALLED after 5 working days; any qualifying event resets it',
      source: 'GraphQL timelineItems with an itemTypes filter, in the same batched request as the closing links',
      whyNotUpdatedAt: 'measured: one PR has updated_at === created_at while a LabeledEvent exists 2s later; another tracked a label change exactly. updated_at is not a faithful instrument either way.',
      qualifyingTypes: COUNTER_EVENT_TYPES,
      excludedTypes: {
        CROSS_REFERENCED_EVENT: 'other items mentioning this one; would let any name-drop reset the counter',
        MENTIONED_EVENT: 'a @user mention, not a change to the issue',
        REFERENCED_EVENT: 'a commit mentioned it; real work appears as a closing PR instead',
        SUBSCRIBED_EVENT: 'notification preference, and GitHub returns no createdAt for it',
        LOCKED_UNLOCKED_EVENT: 'moderation, not work',
      },
      weekendRule: 'Saturday and Sunday excluded, UTC day boundaries; public holidays deliberately not modelled (country unknown from the data)',
      fields: 'counterResetAt, counterResetBy, counterQualifyingEvents on every issue record; hasClosingPr marks an issue whose closing PR is outside the window',
    },
    threadLinkage: {
      rule: 'within the repo a thread\'s bb project maps to. Issues: an explicit "#N" in the thread title or titleFallback (branch digits only corroborate, matchedBy "both"). PRs: pr-env (bb pullForThread, live threads, ignored on environments shared by several live threads), pr-branch (head branch = thread branch, same-repo head, thread updated >= PR created), pr-env+branch when both agree; a pr-env link outranks the rest, otherwise the most recently updated thread wins. refs-pr: an issue with no thread inherits the thread of a PR whose title/body says Refs/Ref/References #N (same repo), and while OPEN its lastActivityAt is max(own, those PRs) with the own value kept as lastActivityAtOwn (the status-cache key). Operator-approved 2026-09-25.',
      bySignal: linkAudit.reduce((a, l) => ((a[l.matchedBy] = (a[l.matchedBy] || 0) + 1), a), {}),
      bySignalScope: 'per artefact at link time, before the phase-4 merge folds issues into PR cards',
      prEnv,
      linkerStats: linkStats,
      refsPr: { linked: refsCarried.size, activityCarried: refsAged, issues: [...refsCarried.keys()] },
      projects: BB_PROJECT,
      // How the thread list was read: the top THREAD_LIST_LIMIT per project, by design.
      listing: threadListing,
      linked: records.filter((r) => r.thread).length,
      unlinked: records.filter((r) => !r.thread).length,
      rejectedCandidates: rejected.length,
      auditFile: 'not shipped in /shared; written to /tmp/ghd/thread-link-audit.json by the fetcher run',
    },
    unobservableStages: {
      8: 'in merge queue — not exposed by REST (auto_merge is a different thing); needs GraphQL mergeQueueEntry or merge_group webhooks',
    },
    stagesNowObservableViaBb: {
      2: 'thread started — a live bb thread exists and is idle',
      3: 'needs guidance — thread.hasPendingInteraction is true (a thread ready and waiting for input)',
      4: 'agent working — thread has active agents/goals/workflows or queued work, or status running/working',
      note: 'applied to OPEN ISSUES only; a PR keeps the stage its own GitHub state implies. A thread with status=error maps to 2, not 4: it is not working. Nothing distinguishes "thread finished" from "thread abandoned", so an issue whose only threads are archived stays at stage 1.',
    },
    omittedFields: {
      snoozedUntil: 'panel-local human state', snoozedAt: 'panel-local human state',
      snoozeCount: 'panel-local human state', snoozeReason: 'panel-local human state',
      bounceTo: 'human judgement (6b returns to stage 3 or 4)',
      blockedOn: 'human annotation',
      fixedBy: 'needs timeline/closing-reference crawl; not attempted in phase 1',
      fromThread: 'SLICC linkage, not on GitHub',
      producedPrs: 'SLICC linkage, not on GitHub',
      synthetic: 'fixture bookkeeping; these records are real',
    },
    lastComment: {
      field: 'lastCommentAt: ISO UTC created_at of the newest issue-thread comment that counts, null when none does, ABSENT when it could not be determined this run',
      consumer: "the panel's snoozeState(): new Date(lastCommentAt) > snoozedAt cancels a snooze",
      excluded: [
        'the dashboard comment mirror: body contains <!-- ghd-mirror:v1 --> AND the author is the authenticated user (both, so pasting the marker suppresses nothing). Counting it would make every published snooze cancel itself and the mirror flap post/delete on a public card each cycle',
        "bot authors (user.type === 'Bot')",
      ],
      timestamp: 'created_at, not updated_at: an edit to an old comment is not new follow-up',
      scope: 'issue-thread comments (/issues/:n/comments, which includes PR conversation comments). PR review comments and review bodies are NOT included',
      mergedCards: 'newest across the lead PR and any absorbed issue',
      budget: 'no request when commentsCount is 0 or the cached entry has the same lastActivityAt + commentsCount + login; otherwise GET /user once per run plus normally ONE page per record, read from the end (page = ceil(count/100), corrected by Link rel="last")',
      requests: lastCommentRequests,
      cacheEntriesLoaded: commentCacheLoaded,
      ...(lastComment.stats || { error: 'phase did not run' }),
      alsoAppliedTo: {
        commentsCount: 'issue-thread comments minus excluded ones (exact when every page was read, which is every thread today). commentsTotal keeps the raw GitHub count; a consumer that must find cards which CAN hold a mirror comment (the mirror orphan sweep) needs commentsTotal',
        counterResetAt: 'GraphQL timeline with excluded IssueComments dropped (authors + viewer login fetched in the same batched query, no extra request); undetermined only if every event in the last-20 window was excluded and older ones exist',
        recentComments: 'excluded comments never reach the status model or the quick view',
        lastActivityAt: 'issue.updated_at cannot be filtered per comment. When it coincides (<= 2 s) with the newest create/edit of an excluded comment, it is replaced by the newest of the other signals already fetched (CI, reviews, merge, created/closed, counted comments, counted timeline events); lastActivityAtRaw keeps the original. No extra request',
        notCovered: 'a DELETED mirror comment still bumps updated_at once (nothing left to attribute it to), and PR events that only updated_at records (a push without CI, a PR label change) are lost when the bump is attributed',
        activityAdjusted: activityAudit.length,
      },
      populated: records.filter((r) => typeof r.lastCommentAt === 'string').length,
      nulls: records.filter((r) => r.lastCommentAt === null).length,
      absent: records.filter((r) => !('lastCommentAt' in r)).length,
    },
    derivedWhenPresent: {
      ci: 'from check-runs on the PR head sha',
      mergedAt: 'PR merged_at',
      substage: '5a from failing check-runs, 5b from mergeable_state=dirty, 6a/6b from the latest review per non-author reviewer',
      reviewers: 'latest APPROVED/CHANGES_REQUESTED review per non-author reviewer; COMMENTED and PENDING are ignored, so a PR with only comment-reviews has no reviewers entry and no 6a/6b substage',
    },
    addedFields: {
      stateReason: 'measured: issue state_reason, or merged / closed_unmerged / open for PRs',
      stageWhy: 'audit trail for the stage decision (not consumed by the panel)',
    },
    filtered: {
      renovateDependencyDashboard: filteredOut.renovateDependencyDashboard.length,
      renovateDependencyDashboardKeys: filteredOut.renovateDependencyDashboard,
      rule: 'an ISSUE (not a PR) authored by /renovate/i whose title matches /dependency dashboard/i or whose body contains "' + RENOVATE_DASHBOARD_SENTENCE + '". Dropped from the issues list before any record is built: no status-model call, not in records, counts, thread linkage or merges. Operator rule, 2026-09-25',
    },
    threadRecordsOmitted: "kind:'thread' records model SLICC threads and have no GitHub source; emitting them would invent work",
    notes,
  },
  records,
};

fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
const snapshotBody = JSON.stringify(snapshot, null, 2);
// Write to a sibling temp file and rename. rename(2) is atomic within a
// filesystem, so a reader sees either the previous snapshot or the new one and
// never a half-written one. A killed run leaves the .tmp behind, harmlessly.
const OUT_TMP = OUT + '.tmp';
fs.writeFileSync(OUT_TMP, snapshotBody);
fs.renameSync(OUT_TMP, OUT);
// ... and only now the version file, so it can never point at a half-written
// snapshot. The hash is over the exact bytes just written.
const snapshotHash = crypto.createHash('sha256').update(snapshotBody).digest('hex');
const VERSION_TMP = VERSION_OUT + '.tmp';
fs.writeFileSync(
  VERSION_TMP,
  JSON.stringify(
    {
      generatedAt: snapshot.meta.generatedAt,
      snapshotHash,
      hashAlgorithm: 'sha256 over the snapshot file bytes',
      records: records.length,
      snapshotBytes: Buffer.byteLength(snapshotBody),
      writtenBy: 'fetch-snapshot.mjs, strictly after the snapshot itself',
      note: 'Change detection for an open panel: poll this file, read the snapshot only when snapshotHash changes. Never keyed on mtime.',
    },
    null,
    2,
  ) + '\n',
);
// Last write of the run, and the one the panel is watching: only now can an open
// panel see a new hash, and by now the snapshot it names is complete on disk.
fs.renameSync(VERSION_TMP, VERSION_OUT);

console.log(`records        : ${records.length}`);
console.log(`filtered       : ${filteredOut.renovateDependencyDashboard.length} Renovate Dependency Dashboard issue(s) dropped${filteredOut.renovateDependencyDashboard.length ? ' (' + filteredOut.renovateDependencyDashboard.join(', ') + ')' : ''}`);
console.log(`requests       : ${log.length}`);
console.log(`rate limit     : remaining ${rl.remaining}/${rl.limit} (started at ${rl.firstRemaining}), reset ${new Date(Number(rl.reset) * 1000).toISOString()}`);
console.log(`by stage       : ${JSON.stringify(records.reduce((a, r) => ((a[r.stage] = (a[r.stage] || 0) + 1), a), {}))}`);
console.log(`by kind        : ${JSON.stringify(records.reduce((a, r) => ((a[r.kind] = (a[r.kind] || 0) + 1), a), {}))}`);
console.log(`by repo        : ${JSON.stringify(records.reduce((a, r) => ((a[r.repo] = (a[r.repo] || 0) + 1), a), {}))}`);
console.log(`substages      : ${JSON.stringify(records.filter((r) => r.substage).map((r) => `${r.repo}#${r.id}:${r.substage}`))}`);
console.log(`threads linked : ${records.filter((r) => r.thread).length} of ${records.length} (rejected candidates: ${rejected.length}); by signal ${JSON.stringify(linkAudit.reduce((a, l) => ((a[l.matchedBy] = (a[l.matchedBy] || 0) + 1), a), {}))}; refs-pr aging on ${refsAged}`);
console.log(`merges         : ${mergeAudit.merged.length} (graphql cost ${closingCost}); out-of-window secondary: ${mergeAudit.secondaryOutOfWindow.length}; rejected: ${mergeAudit.rejected.length}`);
{
  const s = lastComment.stats;
  const withAt = records.filter((r) => typeof r.lastCommentAt === 'string').length;
  console.log(`mirror/bot excl: commentsCount lowered on ${records.filter((r) => r.commentsTotal !== undefined && r.commentsCount < r.commentsTotal).length} cards, lastActivityAt corrected on ${activityAudit.length} artefacts`);
  console.log(`last comment   : ${withAt} of ${records.length} cards carry lastCommentAt; ${lastCommentRequests} requests` + (s ? ` (${s.pageRequests} pages + ${s.loginRequests} /user) — ${s.zeroComments} zero-comment skipped, ${s.cacheHits} cache hits, ${s.fetched} fetched, ${s.failed} failed` : ' (phase failed)'));
}
console.log(`model          : ${STATUS_MODEL}`);
console.log(`agent ledger   : ${formatLedgerLine(agentLedgerSummary)}`);
console.log(`ledger file    : ${AGENT_LEDGER_PATH}`);
console.log(`status agents  : ${modelCalls} calls (concurrency ${STATUS_CONCURRENCY}), ${generated} generated, ${fellBack.length} fell back, ${(statusWallClockMs / 1000).toFixed(1)}s wall clock`);
console.log(`status cache   : ${cacheStats.hits} hits, ${cacheStats.misses} misses (${cacheStats.staleActivity} stale activity, ${cacheStats.staleContract} stale contract), ${Object.keys(statusCache.entries).length} entries stored`);
console.log(`done column    : ${cacheStats.skippedDoneColumn} records skipped entirely (no agent) — ${cacheStats.doneServedFromCache} served cached prose, ${cacheStats.doneMechanical} kept the mechanical line (${cacheStats.skippedAgedOut} of them also aged out)`);
console.log(`status length  : retried ${statusLengthStats.retried}, retry helped ${statusLengthStats.retryHelped}, still under ${CARD_CHARS_MIN} chars ${statusLengthStats.belowMinAfterRetry}`);
const lens = records.filter((r) => r.statusSource === 'agent').map((r) => r.status.length).sort((a, b) => a - b);
if (lens.length) {
  const mean = Math.round(lens.reduce((a, b) => a + b, 0) / lens.length);
  console.log(`status chars   : min ${lens[0]}, mean ${mean}, median ${lens[Math.floor(lens.length / 2)]}, max ${lens[lens.length - 1]} (n=${lens.length} agent-written)`);
}
console.log(`actions        : ${actionStats.recordsWithActions} records carry actions, ${actionStats.kept} kept of ${actionStats.emitted} emitted (nudge ${actionStats.byKind.nudge}, approve ${actionStats.byKind.approve}, clarify ${actionStats.byKind.clarify}); dropped ${JSON.stringify(actionStats.dropped)}`);
console.log(`wrote          : ${OUT} (${fs.statSync(OUT).size} bytes)`);
console.log(`version        : ${VERSION_OUT} — sha256 ${snapshotHash.slice(0, 16)}…, ${records.length} records (written after the snapshot)`);
fs.writeFileSync(`${SCRATCH_DIR}/request-log.json`, JSON.stringify(log, null, 2));
console.log(`request log    : ${SCRATCH_DIR}/request-log.json`);
