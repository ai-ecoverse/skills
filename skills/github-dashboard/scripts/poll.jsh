// poll.jsh — run fetch-snapshot.mjs on a durable schedule.
//
// USAGE (see SKILL.md for the stop path):
//   jshd start -n github-dashboard-poll --enable --restart on-failure \
//     /shared/sprinkles/github-dashboard/poll.jsh
//   jshd status github-dashboard-poll
//   jshd logs   github-dashboard-poll -n 40
//   jshd stop   github-dashboard-poll      # stop, keep the unit record
//   jshd rm     github-dashboard-poll      # stop and delete the unit + log
//
// WHY 30 MINUTES, from measurement rather than a default (numbers in references/poller.md):
//   • The status cache is keyed on each record's lastActivityAt, so a record
//     costs an agent call only when it has NEW activity. Agent spend therefore
//     tracks repository activity, NOT poll frequency — polling more often splits
//     the same work into smaller runs instead of multiplying it.
//   • What frequency does multiply is the fixed per-run cost: ~185-190 GitHub
//     REST/GraphQL requests and the non-agent wall time. At 30 minutes that is
//     ~380 requests/hour against a 5,000/hour limit (~8%), measured remaining
//     4,366/5,000 after a run.
//   • A warm run took 388 s, so the unit is idle ~78% of each interval. A
//     shorter interval would start eating its own tail for no freshness the
//     panel can use: the panel already notices a new snapshot within 5 s.
//
// FAILURE POLICY. A failing FETCH must not spin: the fetch runs inside a
// try/catch and a non-zero exit is logged, counted, and waited out. This script
// itself never exits on a fetch failure, so `--restart on-failure` applies only
// to the script dying (which happened once in testing: a transient realm asset
// load failure killed a run after 9 s and left the data untouched). After three
// consecutive failures the interval backs off to 2 hours until one succeeds, so
// a persistently broken config or credential cannot burn requests all night.
const exec = require('sliccy:exec');
const fs = require('fs');

const FETCHER = '/shared/sprinkles/github-dashboard/fetch-snapshot.mjs';
const MIRROR = '/shared/sprinkles/github-dashboard/mirror-comments.mjs';
const VERSION = '/shared/sprinkles/github-dashboard/data/version.json';
// 30 minutes by default, overridable for a short proving run:
//   jshd start ... --env GHD_POLL_INTERVAL_MS=60000 ...
// The override exists so the schedule can be demonstrated in minutes instead of
// hours WITHOUT testing a different code path than the one that ships.
const NORMAL_MS = Number(process.env.GHD_POLL_INTERVAL_MS) > 0 ? Number(process.env.GHD_POLL_INTERVAL_MS) : 30 * 60 * 1000;
const BACKOFF_MS = 2 * 60 * 60 * 1000;
const FAILURES_BEFORE_BACKOFF = 3;

/* THE COMMENT MIRROR IS DORMANT UNLESS ASKED FOR.
   GHD_MIRROR=off (default) | dry | live

   Off by default on purpose: this unit already runs unattended, and enabling
   the mirror means it writes to PUBLIC cards every cycle with nobody watching.
   That should be a deliberate act by whoever starts the unit, not a
   consequence of deploying a new file. `dry` is the honest middle setting —
   it reconciles and logs the plan without writing, which is how to see what
   the mirror WOULD do to real cards before letting it.

   The orphan sweep runs on a slow cadence rather than every cycle, because it
   was measured at 93 requests / 367 s against 6 / 27 s for marks alone: six
   minutes of a thirty-minute interval to catch a mirror whose marks were
   cleared since the last run. GHD_MIRROR_SWEEP_EVERY counts SUCCESSFUL cycles
   (default 48 = daily at a 30-minute interval). The counter lives in memory
   and resets when the unit restarts, which is acceptable: a restart costs at
   most one extra sweep, never a missed one.

   A mirror failure NEVER fails the cycle. The fetch is this unit's job; the
   mirror is a side effect of it, and a GitHub hiccup in the mirror must not
   trip the fetch backoff and stop the snapshot from being refreshed. */
const MIRROR_MODE = (process.env.GHD_MIRROR || 'off').toLowerCase();
const SWEEP_EVERY = Number(process.env.GHD_MIRROR_SWEEP_EVERY) > 0 ? Number(process.env.GHD_MIRROR_SWEEP_EVERY) : 48;

let running = false;
let okCycles = 0;
let failures = 0;
let cycles = 0;
let timer = null;

function log(line) {
  // jshd captures stdout into its unit log, so a plain write is the log.
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function readVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(VERSION, 'utf8'));
    return { generatedAt: v.generatedAt, records: v.records, hash: String(v.snapshotHash || '').slice(0, 12) };
  } catch (err) {
    return null;
  }
}

/* ---- 8< summariseFailure ---------------------------------------------------
   Turn a failed child's stderr into ONE log line, MESSAGE FIRST.

   The first version took the TAIL of stderr (`.split('\n').slice(-2)`), and on
   a node-style stack the tail is two stack FRAMES — the message is the HEAD.
   Three real failures (2026-09-23 at 05:07Z, 05:37Z and 06:07Z) therefore
   logged nothing but `at async tl (...)` and could not be diagnosed from the
   log at all. A reader needs WHAT failed before WHERE, so frames are demoted:
   every non-frame line is kept first, then up to two frames if they still fit.

   Frames-only input keeps its frames: they are then the only evidence there is,
   and a blank summary would be worse than a bare location.

   Pure, and fenced by these markers so the test can evaluate THIS text rather
   than a copy of it that would quietly drift. */
const FAILURE_SUMMARY_CAP = 300;

function summariseFailure(text, cap) {
  const limit = typeof cap === 'number' && cap > 0 ? cap : FAILURE_SUMMARY_CAP;
  const lines = String(text == null ? '' : text)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '(child wrote nothing to stderr or stdout)';
  const isFrame = (l) => /^at\s/.test(l);
  const messages = lines.filter((l) => !isFrame(l));
  const frames = lines.filter(isFrame);
  let out = (messages.length > 0 ? messages : frames).join(' | ');
  if (messages.length > 0) {
    for (const f of frames.slice(0, 2)) {
      const next = out + ' | ' + f;
      if (next.length > limit) break;
      out = next;
    }
  }
  return out.length > limit ? out.slice(0, limit - 1) + '\u2026' : out;
}
/* ---- >8 end summariseFailure ---------------------------------------------- */

/* ---- 8< ledgerLogLine ------------------------------------------------------
   The fetcher's agent-spend summary, as ONE poll-log line.

   The success path logs nothing the fetcher printed: the cycle line is built
   from version.json alone, and stdout is otherwise dropped. So the ledger has
   to be lifted out of stdout explicitly, from the fetcher's own
   "agent ledger   : ..." line. A fetcher that predates the ledger prints no
   such line, and that is said rather than silently omitted.

   Pure and fenced so tests/poll-ledger.test.js evaluates this exact text. */
function ledgerLogLine(stdout) {
  const m = String(stdout == null ? '' : stdout).match(/^agent ledger\s*:\s*(.+)$/m);
  return m ? `  agents: ${m[1].trim().slice(0, 200)}` : '  agents: (no "agent ledger" line in the fetcher output)';
}
/* ---- >8 end ledgerLogLine -------------------------------------------------- */

function schedule() {
  if (timer) clearTimeout(timer);
  const wait = failures >= FAILURES_BEFORE_BACKOFF ? BACKOFF_MS : NORMAL_MS;
  if (failures >= FAILURES_BEFORE_BACKOFF) {
    log(`backing off: ${failures} consecutive failures, next attempt in ${Math.round(wait / 60000)} min`);
  }
  timer = setTimeout(cycle, wait);
}

/** Reconcile marks to GitHub comments after a successful fetch. Never throws:
    a mirror problem is reported and dropped, so the fetch loop is unaffected. */
async function mirror() {
  if (MIRROR_MODE !== 'dry' && MIRROR_MODE !== 'live') return;
  const sweep = okCycles % SWEEP_EVERY === 0;
  const args = [MIRROR, MIRROR_MODE === 'live' ? '--live' : '--dry-run'];
  if (sweep) args.push('--sweep');
  const t0 = Date.now();
  try {
    const r = await exec(`node ${args.join(' ')}`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const code = r && r.exitCode !== undefined && r.exitCode !== null ? r.exitCode : 0;
    // The reconciler's own one-line summary is the useful part of its output.
    const tail = String((r && r.stdout) || '')
      .trim()
      .split('\n')
      .filter((l) => /done —|PROSE GATE|REFUSED|FAILED/.test(l))
      .slice(-4)
      .join(' :: ');
    // A non-zero exit usually prints no summary at all, and the reason is on
    // stderr — which this used to discard, logging only 'no summary line'. A
    // transient mirror failure at 11:32Z on 2026-09-23 was undiagnosable for
    // exactly that reason. Success path unchanged; failures reuse the fetch
    // path's message-first summary.
    const detail =
      code === 0
        ? tail || 'no summary line'
        : summariseFailure(`${tail}\n${(r && r.stderr) || ''}\n${(r && r.stdout) || ''}`);
    log(`  mirror (${MIRROR_MODE}${sweep ? ', swept' : ''}): exit ${code} in ${secs}s :: ${detail}`);
    if (code === 3) log('  mirror: PROSE GATE tripped — nothing was written, and this needs a human');
  } catch (err) {
    log(`  mirror: threw after ${((Date.now() - t0) / 1000).toFixed(1)}s (cycle unaffected): ${String((err && err.message) || err).slice(0, 200)}`);
  }
}

async function cycle() {
  if (running) {
    // Cannot happen at a 30-minute interval against a 6-minute run, but a
    // slow GitHub or a long agent queue must never start a second fetch on
    // top of the first: they share the status cache and the output files.
    log('skipped: the previous cycle is still running');
    schedule();
    return;
  }
  running = true;
  cycles += 1;
  const before = readVersion();
  const t0 = Date.now();
  try {
    const r = await exec(`node ${FETCHER}`);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const code = r && r.exitCode !== undefined && r.exitCode !== null ? r.exitCode : 0;
    if (code !== 0) {
      failures += 1;
      const why = summariseFailure((r && r.stderr) || (r && r.stdout) || '');
      log(`cycle ${cycles}: FETCH FAILED exit=${code} after ${secs}s (consecutive failures: ${failures}) :: ${why}`);
    } else {
      failures = 0;
      const after = readVersion();
      const moved = before && after && before.hash !== after.hash;
      log(
        `cycle ${cycles}: ok in ${secs}s — ` +
          (after ? `generatedAt ${after.generatedAt}, ${after.records} records, hash ${after.hash}` : 'no version file') +
          (before ? ` (was ${before.generatedAt}, hash ${before.hash}${moved ? ', ADVANCED' : ', unchanged'})` : ''),
      );
      log(ledgerLogLine(r && r.stdout));
      okCycles += 1;
      await mirror();
    }
  } catch (err) {
    failures += 1;
    log(`cycle ${cycles}: threw after ${((Date.now() - t0) / 1000).toFixed(1)}s (consecutive failures: ${failures}): ${String((err && err.message) || err).slice(0, 200)}`);
  } finally {
    running = false;
    schedule();
  }
}

log(`github-dashboard-poll starting: interval ${NORMAL_MS / 60000} min, fetcher ${FETCHER}`);
log(
  MIRROR_MODE === 'off'
    ? 'comment mirror: OFF (set GHD_MIRROR=dry or =live on the unit to enable)'
    : `comment mirror: ${MIRROR_MODE.toUpperCase()}, orphan sweep every ${SWEEP_EVERY} successful cycles`,
);
const boot = readVersion();
log(`current snapshot: ${boot ? boot.generatedAt + ', ' + boot.records + ' records, hash ' + boot.hash : 'none yet'}`);
cycle();
