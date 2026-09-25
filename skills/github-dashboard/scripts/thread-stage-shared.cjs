/**
 * thread-stage-shared.cjs: the thread-derived stage rule, as ONE text used by
 * three programs:
 *   - the panel (github-dashboard.shtml) embeds the fenced block below
 *     VERBATIM, indented six spaces, inside its GHD-CLASSIFY region;
 *   - the thread poller (thread-poll.jsh) require()s it from its own directory
 *     (jsh resolves a relative require against the script), so the file it
 *     writes carries the fields threadStateOf() builds;
 *   - the fetcher can require() it (CommonJS, like workdays-shared.cjs) in
 *     place of its own threadIsLive / threadIsBusy / stageFromThread.
 * tests/thread-stage-drift.test.js fails on any byte of difference between
 * this block and the panel's copy, and compares the rule against
 * the fetcher's current stageFromThread case by case.
 *
 * Dependency-free on purpose: no require(), no clock, no I/O.
 */
/* ---- 8< THREAD-STAGE ------------------------------------------------------
   Two thread shapes, kept apart on purpose:
     RAW      a bb thread as `bb thread list --json` returns it (archivedAt,
              deletedAt, status, activity, queuedWork, hasPendingInteraction).
              Read ONLY by threadIsLive, threadIsBusy and threadStateOf.
     SUMMARY  what a snapshot record carries as `record.thread` and what
              data/threads.json holds: { state, live, archived, busy,
              hasPendingInteraction, queuedWork, updatedAt, ... }. live and
              busy are computed ONCE, from RAW, where RAW is read (the
              fetcher's link builder; thread-poll.jsh via threadStateOf).
   Everything else here takes a SUMMARY and reads only live, archived, busy
   and hasPendingInteraction (state and queuedWork only for the `why` text).

   WHY THE SPLIT MATTERS. The fetcher's own stageFromThread reads RAW fields,
   but its call site passes the SUMMARY (stageFromThread(rec, rec.thread)).
   On a summary those RAW fields are absent, so every archived thread counts
   as live, a busy thread is seen only through queuedWork, and stageWhy says
   "status=undefined" (live, 2026-09-25: slicc#3482, archived and state=error,
   "bb thread exists and is idle (status=undefined)"). */

/** RAW bb statuses that mean an agent is running. "running"/"working" are the
    fetcher's (and the bb CLI status icon's). "active" is ADDED: it is what the
    bb API reports for a running thread (measured 2026-09-25:
    status "active", runtime.displayStatus "active", no active counts, then
    "idle" with a new updatedAt once it finished). Without it such a thread
    would read settled while its agent works. The one deliberate difference
    from the fetcher's threadIsBusy; tests/thread-stage-drift.test.js D2. */
const THREAD_BUSY_STATUSES = ['active', 'running', 'working'];

/** RAW. Live = exists, not archived/deleted. */
function threadIsLive(t) {
  return !t.archivedAt && !t.deletedAt;
}

/** RAW. Anything in flight: active agents, commands, goals, plan mode or
    workflows; queued work; or a running status. */
function threadIsBusy(t) {
  const a = t.activity || {};
  const counts =
    (a.activeBackgroundAgentCount || 0) +
    (a.activeBackgroundCommandCount || 0) +
    (a.activeGoalCount || 0) +
    (a.activePlanModeCount || 0) +
    (a.activeWorkflowCount || 0);
  const queued = t.queuedWork && t.queuedWork !== 'none';
  const running = THREAD_BUSY_STATUSES.includes(t.status);
  return counts > 0 || !!queued || running;
}

/** RAW -> the SUMMARY fields categorisation needs, with the names and
    encodings of the fetcher's link summary (state = bb status, updatedAt ISO).
    live and busy are decided HERE, once. */
function threadStateOf(t) {
  return {
    state: t.status || null,
    archived: !!t.archivedAt,
    live: threadIsLive(t),
    busy: threadIsBusy(t),
    hasPendingInteraction: !!t.hasPendingInteraction,
    queuedWork: t.queuedWork || null,
    updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : null,
  };
}

/** The fields an overlay may refresh. Everything else on record.thread (id,
    title, branch, matchedBy, provider) is the LINK, and belongs to the
    snapshot. */
const THREAD_STATE_FIELDS = ['state', 'archived', 'live', 'busy', 'hasPendingInteraction', 'queuedWork', 'updatedAt'];

/** SUMMARY. What the thread is doing, one word: 'pending' (waits for input),
    'busy' (busy: in flight or queued, as decided from RAW), 'settled' (live,
    not busy, nothing pending; status=error included), 'archived' (not live:
    archived or deleted), or null (no thread). */
function threadPhase(th) {
  if (!th) return null;
  if (!th.live || th.archived) return 'archived';
  if (th.hasPendingInteraction) return 'pending';
  if (th.busy) return 'busy';
  return 'settled';
}

/**
 * SUMMARY. STAGE MAPPING, thread-derived part: the fetcher's intended
 * mapping (its stageFromThread doc comment, with phase 5's archived -> 2). OPEN ISSUES only (rec.stage 1,
 * i.e. before any thread spoke): a PR's own GitHub state is the better signal,
 * so a thread never sets a PR's stage.
 *   pending interaction -> 3 needs guidance
 *   busy / queued       -> 4 agent working
 *   settled             -> 2 thread started, settled: true (the panel files it
 *                          under needs-attention, see threadSettledIssue)
 *   archived / deleted  -> 2 (work started, then abandoned; unchanged)
 */
function stageFromThread(rec, th) {
  if (!rec || rec.kind !== 'issue' || rec.stage !== 1 || !th) return null;
  const phase = threadPhase(th);
  if (phase === 'pending') return { stage: 3, why: 'bb thread is waiting for input (hasPendingInteraction)' };
  if (phase === 'busy') return { stage: 4, why: `bb thread has work in flight (status=${th.state}, queuedWork=${th.queuedWork})` };
  if (phase === 'settled') {
    return { stage: 2, settled: true, why: `bb thread settled: live, nothing in flight, nothing pending (status=${th.state})` };
  }
  return { stage: 2, why: `bb thread exists but is archived: work was started, then abandoned (status=${th.state})` };
}

/** The stage a record had before its thread spoke, when the thread drives
    it: 1 for an open issue (stages 1-4), null for anything else (PRs, closed
    issues), which an overlay must leave alone. */
function threadDrivenBaseStage(rec) {
  if (!rec || rec.kind !== 'issue') return null;
  return [1, 2, 3, 4].includes(rec.stage) ? 1 : null;
}

/** The open issue whose linked thread has settled: the card that belongs in
    needs-attention. Stage 2 with a settled thread, nothing else. */
function threadSettledIssue(item) {
  return !!item && item.kind === 'issue' && item.stage === 2 && threadPhase(item.thread) === 'settled';
}

/** Where a settled issue's stall clock starts: the thread's updatedAt, or the
    record's lastActivityAt if that is later. Either may be absent. */
function threadSettledSince(item) {
  const a = item && item.thread && item.thread.updatedAt ? Date.parse(item.thread.updatedAt) : NaN;
  const b = item && item.lastActivityAt ? Date.parse(item.lastActivityAt) : NaN;
  const m = Math.max(Number.isFinite(a) ? a : -Infinity, Number.isFinite(b) ? b : -Infinity);
  return Number.isFinite(m) ? new Date(m).toISOString() : null;
}

/**
 * Overlay fresh thread state (the parsed data/threads.json) onto records, in
 * place, and recompute the thread-derived stage. IDEMPOTENT: every pass first
 * undoes the previous one from record.__threadOverlay, so it can run again on
 * the same records whenever either file changes.
 *   - LINKS stay the snapshot's: a record without thread.id is skipped, no
 *     thread is added or removed, and only THREAD_STATE_FIELDS are copied.
 *   - A thread MISSING from the file keeps its snapshot state.
 *   - An entry OLDER than the snapshot's (updatedAt earlier) is ignored, so a
 *     poller that has died cannot roll a newer snapshot back.
 * Returns counts, for the debug handle.
 */
function overlayThreadState(records, file) {
  const stats = { linked: 0, refreshed: 0, missing: 0, older: 0, stageChanged: 0, phaseChanged: 0 };
  const map = file && file.threads && typeof file.threads === 'object' ? file.threads : null;
  for (const r of records || []) {
    const prev = r.__threadOverlay;
    if (prev) {
      r.thread = prev.thread;
      r.stage = prev.stage;
      if (prev.hadStageWhy) r.stageWhy = prev.stageWhy;
      else delete r.stageWhy;
      delete r.__threadOverlay;
    }
    const th = r.thread;
    if (!th || typeof th !== 'object' || !th.id) continue;
    stats.linked++;
    const e = map && Object.prototype.hasOwnProperty.call(map, th.id) ? map[th.id] : null;
    if (!e || typeof e !== 'object') {
      stats.missing++;
      continue;
    }
    const fresh = e.updatedAt ? Date.parse(e.updatedAt) : NaN;
    const snap = th.updatedAt ? Date.parse(th.updatedAt) : NaN;
    if (Number.isFinite(fresh) && Number.isFinite(snap) && fresh < snap) {
      stats.older++;
      continue;
    }
    const saved = { thread: th, stage: r.stage, stageWhy: r.stageWhy, hadStageWhy: Object.prototype.hasOwnProperty.call(r, 'stageWhy') };
    const next = Object.assign({}, th);
    for (const f of THREAD_STATE_FIELDS) if (Object.prototype.hasOwnProperty.call(e, f)) next[f] = e[f];
    r.thread = next;
    const base = threadDrivenBaseStage(r);
    if (base !== null) {
      const p = stageFromThread({ kind: r.kind, stage: base }, next);
      if (p) {
        r.stage = p.stage;
        r.stageWhy = p.why;
      }
    }
    const from = threadPhase(th);
    const to = threadPhase(next);
    saved.phaseFrom = from;
    saved.phaseTo = to;
    r.__threadOverlay = saved;
    stats.refreshed++;
    if (r.stage !== saved.stage) stats.stageChanged++;
    if (from !== to) stats.phaseChanged++;
  }
  return stats;
}
/* ---- >8 end THREAD-STAGE -------------------------------------------------- */

module.exports = {
  THREAD_BUSY_STATUSES,
  THREAD_STATE_FIELDS,
  threadIsLive,
  threadIsBusy,
  threadStateOf,
  threadPhase,
  stageFromThread,
  threadDrivenBaseStage,
  threadSettledIssue,
  threadSettledSince,
  overlayThreadState,
};
