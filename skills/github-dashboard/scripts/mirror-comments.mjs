#!/usr/bin/env node
/**
 * mirror-comments.mjs — mirror LOCAL DASHBOARD MARKS onto the GitHub card they
 * belong to, as one comment per item, kept converged.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PUBLISHES, AND THE ONE RULE THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * `data/user-state.json` holds the operator's own marks. Some of those marks
 * carry FREE PROSE: `snoozeReason` is a sentence the operator wrote to himself
 * about why an item can wait. That file was deliberately kept out of the public
 * PR for exactly this reason.
 *
 *   PUBLISH THE FACT, NEVER THE PROSE.
 *
 * "Snoozed until 2026-09-26" is a fact and may be published. The reason text
 * must never leave this machine — not in full, not truncated, not paraphrased,
 * not folded into a <details>. Every byte posted here is permanent and
 * world-readable, and a GitHub comment edit does not erase history: the
 * previous body stays visible for ever through the comment's edit history and
 * in the notification e-mails already delivered. There is no taking it back,
 * so the guard has to hold BEFORE the first write.
 *
 * Two mechanisms enforce it, and they are independent on purpose:
 *
 *   1. A FIELD ALLOWLIST (`PUBLISHABLE`). Only the four fields listed there are
 *      ever read out of a mark, and each has a renderer that emits a fixed
 *      sentence plus a DATE. There is no code path that interpolates an
 *      arbitrary stored string into a body. A new mark field added later is
 *      invisible here by default — it must be added deliberately, which is the
 *      safe direction for a mistake to fall.
 *
 *   2. A RUNTIME PROSE GATE (`assertNoProse`). Before any write, the composed
 *      body is compared against every WITHHELD string in the state file; if any
 *      16-character window of a withheld value appears in the body, the run
 *      aborts with exit 3 and writes nothing. The allowlist alone would already
 *      be sufficient — this catches the case where it is refactored wrongly.
 *      Belt and braces, because the failure is irreversible.
 *
 * AN EXPIRED SNOOZE IS NOT A FACT. This is the one mark that points at the
 * FUTURE, and a forward-looking claim stops being true on a schedule: the day
 * after "Snoozed until 2026-09-22", that comment asserts a filing state that has
 * lapsed, on a public card, maintained by a bot. It is the same defect class as
 * a generated action telling someone to check CI on a PR that has already
 * merged. The mirror's whole safety argument is that a mark cannot rot — so the
 * exception has to be closed rather than tolerated: once `snoozedUntil` is in
 * the past the fact is DROPPED, and if that empties the fact list the comment is
 * DELETED like any other last-mark-cleared case. That path needs no `--sweep`,
 * because the mark itself is still in user-state: the key is right there to
 * reconcile by.
 *
 * The other three marks are HISTORICAL and do not expire. "Marked done on
 * 2026-09-21", "handed to an agent on 2026-09-21", "1 follow-up dispatched on
 * 2026-09-22" are statements about something that happened, and they are as true
 * next month as they were that day. Only a claim about the present can go stale.
 *
 * THE BOUNDARY IS THE EXACT INSTANT, NOT END OF DAY, and it is the panel's own
 * test (`snoozeState`: `expired: until <= now`) reused verbatim. Three reasons,
 * in order of weight:
 *
 *   1. The mirror must never contradict the panel. The comment is the public
 *      shadow of the operator's own view; if the panel has already surfaced the
 *      card as due while the comment still says "parked", the comment is lying,
 *      which is precisely the thing being fixed.
 *   2. There is no day-boundary semantic to honour. `snoozedUntil` is computed
 *      as CLICK TIME + N days (`until = new Date(at.getTime() + days * 864e5)`),
 *      so it already lands at an arbitrary time of day — 20:09:27.913Z for one
 *      real mark. An end-of-day rule would invent a boundary the operator never
 *      chose and silently extend his filing by up to a day.
 *   3. An end-of-day rule needs a timezone, and no user timezone is recorded
 *      anywhere in this data. Picking UTC, or the host's offset, would be a
 *      guess that moves the boundary by hours.
 *
 * A deliberate asymmetry follows, and it is the right way round: the body prints
 * the DATE only (minimal disclosure — the exact time of a snooze click is a
 * behavioural detail worth withholding) while the boundary is the instant. So on
 * the final day the comment disappears part-way through a day it still names.
 * That is honest — the filing really has lapsed — and the panel remains the
 * precise view, showing `2026-09-22 20:09Z`.
 *
 * THIS PROGRAM'S OWN COMMENT AND `lastCommentAt`. The panel treats a snooze as
 * cancelled when a comment postdates it (`cancelledByComment`, from
 * `lastCommentAt`, which the fetcher populates since 2026-09-23). The fetcher
 * therefore EXCLUDES comments that carry this marker AND were written by the
 * authenticated user, plus Bot-authored comments, so this program's post does
 * not cancel the snooze it publishes. Had it counted, the damage would be local,
 * not a public flap: this program decides a snooze from its expiry alone
 * (`snoozeLapsed(snoozedUntil)`), never from comments, so it would neither
 * delete nor re-post. The panel would show the snooze as cancelled, and
 * re-snoozing would restart its backoff. Keep the exclusion in the fetcher.
 *
 * `actionsDispatched` deserves a specific note. Its keys are `kind:label` and
 * the LABEL IS MODEL-GENERATED text ("Ask the author whether the flaky test is
 * related"). That is not the operator's prose, but it is not a durable fact
 * either: it was generated from a snapshot of the item and it rots exactly the
 * way a stage or a CI summary rots. Only the KIND and the DATE are published.
 *
 * ---------------------------------------------------------------------------
 * WHY A RECONCILER AND NOT A CLICK HANDLER
 * ---------------------------------------------------------------------------
 * The obvious design is to post from the panel's snooze button. It is wrong
 * here: this runtime delivers a lick more than once, so a write in the button
 * path double-posts, and it fails whenever the panel is closed. This program is
 * instead a CONVERGING reconciler — it compares desired state (the marks) with
 * observed state (the card) and issues only the difference. Running it twice is
 * indistinguishable from running it once; running it after a crash mid-write
 * finishes the job; a replayed lick is harmless. Idempotence is a property of
 * the shape, not of care taken at the call site.
 *
 * NO NEW LOCAL STATE. Nothing records where a comment was posted. The mirror is
 * found by an invisible marker in the body (`<!-- ghd-mirror:v1 -->`, which
 * renders as nothing) plus the author login, read back from the API. The REMOTE
 * IS THE IDEMPOTENCY CHECK, so there is no second store to drift, to migrate,
 * or to lose. The cost of that choice is one comment-list GET per candidate
 * item; see the sweep note below.
 *
 * THE BODY IS A PURE FUNCTION OF THE MARKS. Deliberately there is no "last
 * synced" timestamp, no snapshot hash, no counter — nothing that changes when
 * the marks have not. Under a 30-minute poller a body containing the sync time
 * would PATCH itself for ever, and every edit is a notification and an entry in
 * the card's history. Freshness is instead carried by the facts themselves
 * ("Snoozed until 2026-09-26"), and the convergence test in the lifecycle proof
 * ("no needless PATCH") only means anything because of this.
 *
 * MARK-DRIVEN ONLY. Stage, CI state, review state and generated actions are all
 * DERIVED and are never mirrored. A derived mirror under an unattended poller
 * would publish rotting claims to public cards every 30 minutes — the failure
 * already observed once, where a panel asserted "2 of 45 checks running" on a
 * PR that had merged. A mark cannot rot that way: it is a statement about the
 * operator's intent, and it is true until he changes it. Attachments
 * (thread linkage) are also excluded: that store belongs to the `github` skill.
 *
 * ---------------------------------------------------------------------------
 * HOW EACH ITEM IS RECONCILED
 * ---------------------------------------------------------------------------
 *   marks, no mirror      -> CREATE  (gh issue comment; works for PRs too)
 *   marks, mirror differs -> PATCH   (gh api -X PATCH .../issues/comments/:id)
 *   marks, mirror equal   -> NOOP    (no request; this is the steady state)
 *   no marks, mirror      -> DELETE  (gh api -X DELETE .../issues/comments/:id)
 *
 * The skill's `gh` has no edit verb — only `gh issue comment` and
 * `gh pr comment` exist — so the update is done through the raw REST endpoint.
 * `gh issue comment` is used for the create because the issues endpoint serves
 * pull requests as well (a PR is an issue with a diff), which keeps one code
 * path for both kinds of card.
 *
 * Every write is VERIFIED BY READING THE CARD BACK through the API, never from
 * this program's own logs: `gh` here exits 0 on some error paths, so a zero exit
 * is not evidence that a comment exists, matches, or is gone.
 *
 * ORPHANS AND THE SWEEP. When the operator clears the last mark, the panel
 * DELETES the whole entry from user-state (`mutateStore` drops an entry once it
 * is empty, so the file states only what is still true). That is right for the
 * store, and it means this program cannot learn the key of an item whose marks
 * just vanished — there is nothing left locally to read. In normal operation
 * that is the COMMON case, not a rare one: a mark cleared at 10:05 is already
 * gone when the poller reconciles at 10:30. So deletion of an orphan cannot use
 * local knowledge at all; it needs a remote sweep over items that could hold a
 * mirror, bounded to snapshot records with `commentsCount > 0` (a card with no
 * comments cannot hold one) minus the marked keys.
 *
 * THE SWEEP IS OPT-IN (`--sweep`) BECAUSE IT WAS MEASURED, and the measurement
 * says it is poor value on every cycle:
 *
 *   marks only   6 requests,  27 s    (the 5 real marks)
 *   with sweep  93 requests, 367 s    (87 candidate cards of 108)
 *
 * 13.6x the cost and six minutes of a thirty-minute interval, to catch an event
 * that fires only when a mark was cleared since the last run — and whose cost
 * when missed is one public comment saying "snoozed until X" a while longer than
 * it should. So the poller reconciles marks every cycle and sweeps on a slow
 * cadence (see poll.jsh). The numbers above are worth re-measuring if the
 * monitored repo set grows: the sweep is linear in commented cards, and at ~4 s
 * per GET through this CLI it is latency-bound, not rate-limit-bound.
 *
 * ---------------------------------------------------------------------------
 * SAFETY RAILS
 * ---------------------------------------------------------------------------
 *   - DRY RUN IS THE DEFAULT. Writing requires an explicit `--live`. A dry run
 *     performs every read and every comparison, and prints the exact body it
 *     would post, so the plan is reviewable before anything is permanent.
 *   - REPO ALLOWLIST. Only repos in the monitor config are ever written to; a
 *     mark for any other repo is refused and reported. The allowlist is checked
 *     again immediately before each write, not only while planning.
 *   - THIS PROGRAM NEVER WRITES `user-state.json`. It opens it read-only. The
 *     operator clicks in the panel while this runs, and the file is his.
 *
 * Exit codes: 0 reconciled (or nothing to do); 2 usage/config error;
 *             3 PROSE GATE TRIPPED (nothing was written); 1 anything else.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = new URL('.', import.meta.url).pathname;
const MARKER = '<!-- ghd-mirror:v1 -->';

/* Fields that may leave this machine, with the sentence each renders. Anything
   not listed here is withheld by construction. Each renderer receives the raw
   value and must emit a fixed sentence plus a date — never the value itself. */
const PUBLISHABLE = {
  snoozedUntil: (v) => (snoozeLapsed(v) ? null : `Snoozed until ${day(v)}`),
  doneAt: (v) => `Marked done on my dashboard on ${day(v)} — that does not close this item here`,
  scoopRequestedAt: (v) => `Handed to an agent from my dashboard on ${day(v)}`,
  actionsDispatched: (v) => renderDispatched(v),
};

/* Mark fields that are known prose or known-derived text. Listed explicitly so
   the prose gate has something to test even if a field is renamed; any field
   absent from PUBLISHABLE is withheld regardless of whether it appears here. */
const KNOWN_PROSE = ['snoozeReason'];

const day = (iso) => String(iso).slice(0, 10);

/** Is this snooze no longer a live filing? Mirrors the panel's snoozeState
    exactly (`expired: until <= now`), including the boundary being <=.
    An unparseable instant counts as lapsed: a filing state that cannot be
    read cannot be asserted in public. */
function snoozeLapsed(iso, now = Date.now()) {
  const until = new Date(iso).getTime();
  return !Number.isFinite(until) || until <= now;
}

/** Dispatched follow-ups, as kinds and dates only — never the generated label. */
function renderDispatched(map) {
  const entries = Object.entries(map || {});
  if (!entries.length) return null;
  const kinds = {};
  let latest = '';
  for (const [key, at] of entries) {
    const kind = String(key).split(':')[0] || 'follow-up';
    kinds[kind] = (kinds[kind] || 0) + 1;
    if (String(at) > latest) latest = String(at);
  }
  const names = { nudge: 'nudge', clarify: 'clarification' };
  const parts = Object.entries(kinds).map(([k, n]) => `${n} ${names[k] || k}`);
  const total = entries.length;
  return `${total} follow-up${total === 1 ? '' : 's'} dispatched from my dashboard, most recently ${day(latest)} (${parts.join(', ')})`;
}

/** The facts for one item, in a stable order so the body is diff-stable. */
function publishableFacts(entry) {
  const facts = [];
  for (const field of Object.keys(PUBLISHABLE)) {
    if (entry[field] === undefined || entry[field] === null) continue;
    const line = PUBLISHABLE[field](entry[field]);
    if (line) facts.push(line);
  }
  return facts;
}

/** Everything in this entry that must NOT appear in a body. */
function withheldStrings(entry) {
  const out = [];
  const walk = (val, field) => {
    if (typeof val === 'string') {
      if (!(field in PUBLISHABLE)) out.push(val);
      return;
    }
    if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        // Keys matter too: actionsDispatched keys carry generated labels.
        if (!(field in PUBLISHABLE) || field === 'actionsDispatched') out.push(k);
        walk(v, field);
      }
    }
  };
  for (const [field, val] of Object.entries(entry)) {
    if (field in PUBLISHABLE && typeof val !== 'object') continue;
    walk(val, field);
  }
  for (const f of KNOWN_PROSE) if (typeof entry[f] === 'string') out.push(entry[f]);
  return out.filter((s) => typeof s === 'string' && s.length >= 16);
}

/** Hard gate: refuse to write a body that contains any withheld text. */
function assertNoProse(body, entry, key) {
  for (const secret of withheldStrings(entry)) {
    for (let i = 0; i + 16 <= secret.length; i += 1) {
      const window = secret.slice(i, i + 16);
      if (body.includes(window)) {
        throw Object.assign(
          new Error(
            `PROSE GATE: the body for ${key} contains withheld text (a 16-character window of a non-publishable field). Nothing was written.`,
          ),
          { proseGate: true },
        );
      }
    }
  }
}

/** The comment body. Pure function of the facts — no timestamps, no hashes. */
function renderBody(facts) {
  return [
    MARKER,
    '**Filed on my dashboard**',
    '',
    ...facts.map((f) => `- ${f}`),
    '',
    '<sub>Posted and kept up to date automatically by my own GitHub dashboard. It mirrors how I have filed this item for myself; it is not a change to the item, and nobody is being asked to act on it. It is rewritten when my marks change and deleted when they clear. Reasons and private notes are never published here.</sub>',
  ].join('\n');
}

/** Print a body for review, framed so trailing whitespace is visible. */
function showBody(body) {
  console.log('           ┌─ body ' + '─'.repeat(52));
  for (const line of body.split('\n')) console.log('           │ ' + line);
  console.log('           └' + '─'.repeat(60));
}

/* ---------------------------------- gh ----------------------------------- */

/* ---- 8< gh -----------------------------------------------------------------
   Every GitHub request this program makes goes through gh() below.

   ONE BOUNDED RETRY, FOR READS ONLY. On 2026-09-23 (13:26Z and 17:36Z) the
   first request of a run, GET /user, failed with
     HTTP 502 Bad Gateway https://api.github.com/user:
     {"error":"Proxy fetch failed: ... (AsyncHTTPClient.HTTPClientError error 1.)"}
   The 502 came from the local proxy's HTTP client, not from GitHub, and the
   whole cycle's reconcile was lost to it. So a request is retried exactly once,
   after GH_RETRY_DELAY_MS, when BOTH hold:
     - it is a plain `gh api <path> [--jq <expr>]` read (isRetryableGet), and
     - the failure is transient (isTransientGhFailure): HTTP 502/503/504, or a
       network-level failure with no 4xx status ("Proxy fetch failed", ...).
   Writes are NEVER retried: a POST, PATCH or DELETE whose response was lost
   may already have taken effect, and a retried create would post a DUPLICATE
   comment on a public card. `gh issue comment` (the create) is not `gh api`
   and is therefore never retried. 4xx failures (401/403/404/422) are not
   transient and are never retried. The check is an allowlist: any argv this
   code does not recognise as a plain read is treated as a write.

   A retry prints ONE stdout line ("  retry    ...") and is counted into the
   final "done —" line, which is the line poll.jsh keeps on success. When the
   retry also fails, the thrown message has the SAME format as before (poll.jsh
   summariseFailure parses it) and carries the final attempt's stderr.

   Fenced by these markers so tests/mirror-retry.test.js evaluates THIS text.
   The mirror itself must never be imported: loading it runs a reconcile. */

let requests = 0;
let retries = 0;

const GH_RETRY_DELAY_MS = 2000;

/** True only for `gh api <path>` with nothing but --jq/-q and an optional
    explicit GET. Field flags (-f/-F/--input) make `gh api` default to POST,
    so their presence alone disqualifies a request. */
function isRetryableGet(args) {
  if (!Array.isArray(args) || args[0] !== 'api') return false;
  let path = 0;
  for (let i = 1; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--jq' || a === '-q') {
      if (i + 1 >= args.length) return false;
      i += 1;
    } else if (a.startsWith('--jq=')) {
      /* filter only */
    } else if (a === '-X' || a === '--method') {
      if (i + 1 >= args.length || String(args[i + 1]).toUpperCase() !== 'GET') return false;
      i += 1;
    } else if (a.startsWith('--method=')) {
      if (a.slice(9).toUpperCase() !== 'GET') return false;
    } else if (a.startsWith('-')) {
      return false;
    } else {
      path += 1;
    }
  }
  return path === 1;
}

/** Transient = the request probably never got a GitHub answer. An explicit
    4xx status is always final, whatever the body says. */
function isTransientGhFailure(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/\bHTTP (\d{3})\b/);
  if (m) {
    const code = Number(m[1]);
    if (code === 502 || code === 503 || code === 504) return true;
    if (code >= 400 && code < 500) return false;
  }
  return /Proxy fetch failed|Failed to fetch|fetch failed|NetworkError|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out/i.test(s);
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  } catch {
    /* no blocking wait in this realm: fall back to a bounded spin */
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function ghOnce(args) {
  requests += 1;
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stdout = r.stdout || '';
  const stderr = (r.stderr || '').trim();
  // `gh` here can exit 0 while reporting an error, so treat a stderr error
  // marker as failure too rather than trusting the status alone.
  const failed = r.status !== 0 || /^(error|fatal)\b/i.test(stderr);
  return { ok: !failed, status: r.status, stdout, stderr };
}

function gh(args, { allowFail = false } = {}) {
  let r = ghOnce(args);
  if (!r.ok && isRetryableGet(args) && isTransientGhFailure(r.stderr)) {
    retries += 1;
    const why = (r.stderr.split('\n')[0] || `status ${r.status}`).slice(0, 160);
    console.log(
      `  retry    gh ${args.slice(0, 3).join(' ')} — transient failure, retrying once in ${GH_RETRY_DELAY_MS / 1000} s: ${why}`,
    );
    sleepSync(GH_RETRY_DELAY_MS);
    r = ghOnce(args);
  }
  if (!r.ok && !allowFail) {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} failed (status ${r.status}): ${r.stderr.slice(0, 300)}`);
  }
  return r;
}
/* ---- >8 end gh ------------------------------------------------------------ */

function ghJson(args) {
  const { stdout } = gh(args);
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gh ${args.slice(0, 3).join(' ')} did not return JSON: ${text.slice(0, 200)}`);
  }
}

const parseKey = (key) => {
  const m = String(key).match(/^([^/]+)\/([^#]+)#(\d+)$/);
  return m ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
};

/** The mirror comment on this card, or null. Exact: our marker AND our login. */
function findMirror(ref, login) {
  const list = ghJson([
    'api',
    `/repos/${ref.slug}/issues/${ref.number}/comments?per_page=100`,
    '--jq',
    '[.[] | {id, login: .user.login, body}]',
  ]);
  const mine = (list || []).filter((c) => c.login === login && String(c.body || '').includes(MARKER));
  return mine.length ? { ...mine[0], duplicates: mine.slice(1) } : null;
}

/* -------------------------------- main ----------------------------------- */

function usage() {
  console.log(`mirror-comments.mjs — reconcile local dashboard marks onto GitHub cards

  --live              perform writes (default is a dry run that writes nothing)
  --config <path>     monitor config (default /shared/github-monitor/config.json)
  --state <path>      user-state file (default ./data/user-state.json, read-only)
  --snapshot <path>   snapshot for the orphan sweep (default ./data/snapshot.json)
  --only <owner/repo#N>   reconcile just this item (repeatable); skips the sweep
  --sweep             also hunt stale mirrors on unmarked cards (measured:
                      93 requests / 367 s vs 6 / 27 s without) — off by default
  --no-sweep          explicit opposite of --sweep (already the default)
  --json              machine-readable summary on stdout
  --help`);
}

function main(argv) {
  const opt = {
    live: false,
    config: '/shared/github-monitor/config.json',
    state: join(HERE, 'data', 'user-state.json'),
    snapshot: join(HERE, 'data', 'snapshot.json'),
    only: [],
    sweep: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') opt.live = true;
    else if (a === '--dry-run') opt.live = false;
    else if (a === '--sweep') opt.sweep = true;
    else if (a === '--no-sweep') opt.sweep = false;
    else if (a === '--json') opt.json = true;
    else if (a === '--help' || a === '-h') return usage(), 0;
    else if (a === '--config') opt.config = argv[++i];
    else if (a === '--state') opt.state = argv[++i];
    else if (a === '--snapshot') opt.snapshot = argv[++i];
    else if (a === '--only') opt.only.push(argv[++i]);
    else {
      console.error(`unknown argument: ${a}`);
      return 2;
    }
  }

  let config;
  try {
    config = JSON.parse(readFileSync(opt.config, 'utf8'));
  } catch (err) {
    console.error(`cannot read config ${opt.config}: ${err.message}`);
    return 2;
  }
  const allowed = new Set((config.repos || []).map((r) => r.slug).filter(Boolean));
  if (!allowed.size) {
    console.error(`config ${opt.config} lists no repos — refusing to run with an empty allowlist`);
    return 2;
  }

  let state;
  try {
    state = JSON.parse(readFileSync(opt.state, 'utf8'));
  } catch (err) {
    console.error(`cannot read state ${opt.state}: ${err.message}`);
    return 2;
  }

  const login = gh(['api', '/user', '--jq', '.login']).stdout.trim();
  if (!login) {
    console.error('could not determine the authenticated login');
    return 1;
  }

  const mode = opt.live ? 'LIVE' : 'DRY RUN';
  console.log(`${mode} — mirroring marks as @${login}; allowlist: ${[...allowed].join(', ')}`);

  const summary = { mode, created: [], patched: [], noop: [], deleted: [], refused: [], failed: [], sweepChecked: 0 };
  const items = state.items || {};
  const keys = opt.only.length ? opt.only : Object.keys(items);

  for (const key of keys) {
    const ref = parseKey(key);
    if (!ref) {
      summary.refused.push({ key, why: 'unparsable key' });
      console.log(`  refused  ${key} — not an owner/repo#number reference`);
      continue;
    }
    const entry = items[key] || {};
    const facts = publishableFacts(entry);
    if (!allowed.has(ref.slug)) {
      summary.refused.push({ key, why: 'repo not in config allowlist' });
      console.log(`  REFUSED  ${key} — ${ref.slug} is not in the configured allowlist, no request made`);
      continue;
    }

    try {
      const existing = findMirror(ref, login);

      if (!facts.length) {
        const lapsed = entry.snoozedUntil && snoozeLapsed(entry.snoozedUntil);
        const why = lapsed
          ? 'the snooze has lapsed, so no mark is currently true'
          : 'no publishable marks remain';
        if (!existing) {
          summary.noop.push({ key, why: lapsed ? 'snooze lapsed, no mirror' : 'no marks, no mirror' });
          console.log(`  noop     ${key} — ${why}, no mirror present`);
          continue;
        }
        console.log(`  DELETE   ${key} — ${why}, removing comment ${existing.id}`);
        if (opt.live) {
          gh(['api', '--method', 'DELETE', `/repos/${ref.slug}/issues/comments/${existing.id}`]);
          const after = findMirror(ref, login);
          if (after) throw new Error(`delete not effective: comment ${after.id} still present`);
          console.log('           verified by re-read: mirror is gone');
        }
        summary.deleted.push({ key, id: existing.id });
        continue;
      }

      const body = renderBody(facts);
      assertNoProse(body, entry, key);

      if (!existing) {
        console.log(`  CREATE   ${key} — ${facts.length} fact(s)`);
        if (!opt.live) showBody(body);
        if (opt.live) {
          const tmp = join(tmpdir(), `ghd-mirror-${ref.repo}-${ref.number}.md`);
          writeFileSync(tmp, body);
          gh(['issue', 'comment', String(ref.number), '--body-file', tmp, '-R', ref.slug]);
          unlinkSync(tmp);
          const after = findMirror(ref, login);
          if (!after) throw new Error('create not effective: no mirror found on re-read');
          if (after.body.trim() !== body.trim()) throw new Error('create landed with an unexpected body');
          console.log(`           verified by re-read: comment ${after.id}, body matches`);
          summary.created.push({ key, id: after.id });
        } else {
          summary.created.push({ key, id: null });
        }
        continue;
      }

      if (existing.body.trim() === body.trim()) {
        summary.noop.push({ key, why: 'mirror already matches' });
        console.log(`  noop     ${key} — comment ${existing.id} already matches, no PATCH`);
        continue;
      }

      console.log(`  PATCH    ${key} — comment ${existing.id} differs`);
      if (!opt.live) showBody(body);
      if (opt.live) {
        gh(['api', '--method', 'PATCH', `/repos/${ref.slug}/issues/comments/${existing.id}`, '-f', `body=${body}`]);
        const after = findMirror(ref, login);
        if (!after || after.id !== existing.id) throw new Error('patch not effective: mirror id changed');
        if (after.body.trim() !== body.trim()) throw new Error('patch not effective: body still differs');
        console.log(`           verified by re-read: comment ${after.id} updated in place, body matches`);
      }
      summary.patched.push({ key, id: existing.id });
    } catch (err) {
      if (err.proseGate) throw err;
      summary.failed.push({ key, error: err.message });
      console.log(`  FAILED   ${key} — ${err.message}`);
    }
  }

  /* Orphan sweep: mirrors on items that no longer carry any mark. */
  if (opt.sweep && opt.only.length) console.log('  sweep skipped — --only names explicit items');
  if (opt.sweep && !opt.only.length) {
    let snapshot = null;
    try {
      snapshot = JSON.parse(readFileSync(opt.snapshot, 'utf8'));
    } catch (err) {
      console.log(`  sweep skipped — cannot read snapshot: ${err.message}`);
    }
    if (snapshot) {
      const marked = new Set(Object.keys(items));
      const candidates = (snapshot.records || []).filter(
        // commentsTotal is the RAW count: since the fetcher stopped counting our own
        // comment in commentsCount, a card whose only comment IS the mirror reads 0
        // there, and it is exactly the card that can hold an orphan.
        (r) => ((r.commentsTotal ?? r.commentsCount) || 0) > 0 && allowed.has(r.repo) && !marked.has(`${r.repo}#${r.id}`),
      );
      console.log(`  sweep    ${candidates.length} unmarked card(s) with comments, looking for stale mirrors`);
      for (const rec of candidates) {
        const key = `${rec.repo}#${rec.id}`;
        const ref = parseKey(key);
        summary.sweepChecked += 1;
        try {
          const existing = findMirror(ref, login);
          if (!existing) continue;
          console.log(`  DELETE   ${key} — stale mirror ${existing.id} (item carries no marks)`);
          if (opt.live) {
            gh(['api', '--method', 'DELETE', `/repos/${ref.slug}/issues/comments/${existing.id}`]);
            const after = findMirror(ref, login);
            if (after) throw new Error(`delete not effective: comment ${after.id} still present`);
            console.log('           verified by re-read: mirror is gone');
          }
          summary.deleted.push({ key, id: existing.id, orphan: true });
        } catch (err) {
          summary.failed.push({ key, error: err.message });
          console.log(`  FAILED   ${key} — ${err.message}`);
        }
      }
    }
  }

  summary.requests = requests;
  summary.retries = retries;
  console.log(
    `${mode} done — created ${summary.created.length}, patched ${summary.patched.length}, deleted ${summary.deleted.length}, noop ${summary.noop.length}, refused ${summary.refused.length}, failed ${summary.failed.length}; ${requests} API requests${retries ? `, ${retries} GET(s) retried after a transient failure` : ''}`,
  );
  if (!opt.live) console.log('nothing was written (dry run); pass --live to apply');
  if (opt.json) console.log(JSON.stringify(summary, null, 2));
  return summary.failed.length ? 1 : 0;
}

/* NOTE: process.exit() throws inside this runtime's realm, so a call to it
   from within a try block unwinds into the catch and reports a spurious
   failure. Set the status and fall off the end instead. */
try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err && err.proseGate) {
    console.error(String(err.message));
    process.exitCode = 3;
  } else {
    console.error(`unexpected failure: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
}
