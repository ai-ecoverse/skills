// session-end.js
// End-of-session finalisation: persisting per-session diagnostics and
// notifying the orchestrator that a recording is done. Dependency-free ESM,
// intended to be loaded through the same Blob-URL module loader as every
// other file in lib/ (see session-end-INTEGRATION.md).
//
// Design goals (see BRIEF for this task):
//   1. Diagnostics must survive a page reload once a session has ended --
//      they get written into the session's own directory as
//      diagnostics.json, not into the single global debug.json that gets
//      clobbered on every load.
//   2. The orchestrator must be told exactly once per session that a
//      recording finished, via slicc.lick({action:"recording-complete",...}).
//   3. Ordering is a hard guarantee: artifacts (human/agent media,
//      transcript, session.json -- written elsewhere, by the caller,
//      BEFORE calling into this module) -> diagnostics.json -> lick.
//      A failure at step 2 or 3 must never undo or block step 1, and must
//      never prevent the later step from running.
//   4. Every bridge call is bounded by a timeout, because bridge calls
//      (slicc.writeFile et al) have been observed to hang rather than
//      reject in this environment.
//   5. `warningCount`/the lick's `warnings` field must reflect ONLY things
//      that happened DURING the interview and that a human might actually
//      act on -- see buildDiagnosticsDocument()'s own doc comment. A real
//      session reported warningCount:3 with ZERO real faults: all three
//      were startup-diagnostic leftovers from earlier in the same page
//      load, still sitting in
//      window.__IM_DIAG__ (which interview-me.shtml's
//      collectDiagnosticsEntries() folds in wholesale, across the whole
//      page's lifetime, not just this session). A monitor that cries wolf
//      gets ignored -- this is a correctness fix, not cosmetic.
//
// The module takes its `slicc`-like bridge as a parameter everywhere
// instead of reading a global, so it can be exercised with a fake bridge
// in a plain Node script (no browser, no VFS).

/**
 * Race a promise against a timeout so a hanging bridge call can never wedge
 * finalisation forever. Mirrors the withTimeout(promise, ms, label) helper
 * already used throughout interview-me.shtml -- reimplemented here (rather
 * than imported) because the .shtml file cannot be imported from, and this
 * module must stay self-contained.
 *
 * @param {Promise<any>} promise
 * @param {number} ms
 * @param {string} label - used only in the rejection message, for logs.
 * @returns {Promise<any>}
 */
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Stage names that match the default /warn|stall|fail|error/i pattern but
// are known, cataloged, non-actionable -- never a warning, regardless of
// window. Each one documented with WHY, so this set can't silently grow
// into a dumping ground for "things we got tired of seeing":
//
//   - "slicc-screenshot-probe-failed": an early startup diagnostic
//     (unrelated to the app's own functionality -- it's a smoke test of
//     the slicc.screenshot() bridge call itself) that has been observed to
//     fail intermittently with "Element has zero dimensions", a timing
//     flake against the very first paint. Confirmed non-reproducible on
//     retry and never correlated with any other symptom across many real
//     sessions -- there is nothing here a human could act on, so it is
//     informational, not a warning. If it ever starts correlating with a
//     REAL problem (e.g. the sprinkle failing to render at all), that
//     would show up as other, genuinely actionable diagnostics anyway
//     (dom-check missing elements, init-error, etc.) -- this specific
//     probe failing on its own has never been that signal.
const KNOWN_BENIGN_STAGES = new Set(["slicc-screenshot-probe-failed"]);

/**
 * Build the diagnostics.json document for a session: a short summary
 * (so a reader sees the important thing first, without scrolling a
 * potentially long array) followed by the raw ordered entries.
 *
 * WARNING SCOPING (the actual fix this function exists to make correct):
 * `window.__IM_DIAG__` (interview-me.shtml's load-time diagnostic sink) is
 * NOT reset per session -- it accumulates for the whole page's lifetime,
 * which can span many self-test runs and even multiple real interviews
 * without a reload in between. Counting warnings from the ENTIRE entries
 * array therefore double-counts stale noise into a NEW session's report.
 * Pass `sessionStartMs`/`sessionEndMs` (the real session's own t0/endedAt)
 * to scope the warning COUNT to entries that actually happened during
 * this interview -- entries outside that window are still kept in the
 * output `entries` array (pre-session load-time diagnostics genuinely
 * help a post-mortem) but are excluded from warningCount/warningStages,
 * and tagged with an explicit `phase` ("pre-session" / "post-session") so
 * a reader can tell at a glance why an entry that LOOKS like a warning
 * didn't count as one.
 *
 * @param {Array<{t:number, stage:string, detail?:any}>} entries - the
 *   diagnostic log accumulated during the session (AudioContext state
 *   transitions, visibility/focus events, appended-audio-frame counts,
 *   watchdog stall/recovery warnings, etc). Each entry is expected to be
 *   JSON-serialisable and to at least carry a numeric timestamp `t`
 *   (epoch ms) and a string `stage`; anything else is passed through.
 * @param {object|(entry:object)=>boolean} [options] - either the isWarning
 *   predicate directly (legacy call shape, still supported), or an options
 *   object:
 * @param {(entry:object) => boolean} [options.isWarning] - predicate
 *   deciding whether an IN-WINDOW entry counts as a warning. Defaults to:
 *   not an explicit self-test simulation (`entry.detail.simulated ===
 *   true` -- see safeAttachCameraPreview()'s diagExtra parameter for where
 *   that gets set; deliberately an explicit marker the self-test itself
 *   sets, NOT pattern-matching on a stage name like "...-sim", so a
 *   future check can't accidentally get counted just by sharing a naming
 *   convention), not a KNOWN_BENIGN_STAGES entry (see above), and matching
 *   /warn|stall|fail|error/i against `entry.stage` otherwise.
 * @param {number} [options.sessionStartMs] - entries with `t` before this
 *   are tagged `phase:"pre-session"` and excluded from warning counting.
 *   Omit (or pass a non-number) to disable window scoping entirely --
 *   every entry is then eligible, matching the pre-fix behavior; only used
 *   for backward-compatible test isolation, real callers always pass it.
 * @param {number} [options.sessionEndMs] - entries with `t` after this are
 *   tagged `phase:"post-session"` and likewise excluded.
 * @returns {{summary: object, entries: Array<object>}}
 */
export function buildDiagnosticsDocument(entries, options) {
  const opts = typeof options === "function" ? { isWarning: options } : options || {};
  const warnPredicate = typeof opts.isWarning === "function" ? opts.isWarning : defaultIsWarning;
  const sessionStartMs = typeof opts.sessionStartMs === "number" ? opts.sessionStartMs : null;
  const sessionEndMs = typeof opts.sessionEndMs === "number" ? opts.sessionEndMs : null;

  const rawList = Array.isArray(entries) ? entries : [];
  const list = rawList.map((entry) => {
    if (!entry || typeof entry.t !== "number" || sessionStartMs === null) return entry;
    if (entry.t < sessionStartMs) return { ...entry, phase: "pre-session" };
    if (sessionEndMs !== null && entry.t > sessionEndMs) return { ...entry, phase: "post-session" };
    return entry;
  });

  let firstT = null;
  let lastT = null;
  let warningCount = 0;
  const warningStages = new Set();

  for (const entry of list) {
    const t = entry && typeof entry.t === "number" ? entry.t : null;
    if (t !== null) {
      if (firstT === null || t < firstT) firstT = t;
      if (lastT === null || t > lastT) lastT = t;
    }
    const inWindow = !entry || (entry.phase !== "pre-session" && entry.phase !== "post-session");
    if (entry && inWindow && warnPredicate(entry)) {
      warningCount++;
      if (entry.stage) warningStages.add(String(entry.stage));
    }
  }

  const summary = {
    entryCount: list.length,
    firstTimestamp: firstT,
    lastTimestamp: lastT,
    hasWarnings: warningCount > 0,
    warningCount,
    warningStages: Array.from(warningStages),
    generatedAt: new Date().toISOString(),
  };

  return { summary, entries: list };
}

function defaultIsWarning(entry) {
  if (entry && entry.detail && entry.detail.simulated === true) return false;
  const stage = entry && entry.stage ? String(entry.stage) : "";
  if (KNOWN_BENIGN_STAGES.has(stage)) return false;
  return /warn|stall|fail|error/i.test(stage);
}

/**
 * Persist the diagnostics accumulated during a session into that session's
 * own directory, as diagnostics.json, alongside human.webm / agent.webm /
 * transcript.json / transcript.md / session.json. This is what survives a
 * page reload that would otherwise wipe the single shared debug.json.
 *
 * @param {object} slicc - bridge object with writeFile(path,string):Promise
 *   and mkdir(path):Promise (mkdir is best-effort/idempotent, matching the
 *   existing app's usage of slicc.mkdir before writing session artifacts).
 * @param {string} sessionDir - the per-session directory the caller writes
 *   session artifacts into, e.g. "<sprinkleDir>/sessions/<iso-timestamp>"
 * @param {Array<object>} entries - diagnostic log, see buildDiagnosticsDocument.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=4000] - bound on each bridge call.
 * @param {(entry:object)=>boolean} [opts.isWarning]
 * @param {number} [opts.sessionStartMs] - see buildDiagnosticsDocument.
 * @param {number} [opts.sessionEndMs] - see buildDiagnosticsDocument.
 * @returns {Promise<{path:string, summary:object}>}
 */
export async function writeDiagnostics(slicc, sessionDir, entries, opts) {
  const { timeoutMs = 4000, isWarning, sessionStartMs, sessionEndMs } = opts || {};
  if (!slicc || typeof slicc.writeFile !== "function") {
    throw new Error("writeDiagnostics: slicc.writeFile is not available");
  }
  if (!sessionDir) {
    throw new Error("writeDiagnostics: sessionDir is required");
  }

  const doc = buildDiagnosticsDocument(entries, { isWarning, sessionStartMs, sessionEndMs });
  const path = `${sessionDir}/diagnostics.json`;
  const payload = JSON.stringify(doc, null, 2);

  await withTimeout(slicc.writeFile(path, payload), timeoutMs, "writeDiagnostics:writeFile");

  return { path, summary: doc.summary };
}

/**
 * Derive user/assistant turn counts from a transcript entries array shaped
 * like TranscriptStore#toJSON() output: {role:"user"|"assistant"|"tool", ...}.
 *
 * @param {Array<object>} transcriptEntries
 * @returns {{userTurns:number, assistantTurns:number, toolCalls:number}}
 */
export function countTurns(transcriptEntries) {
  const list = Array.isArray(transcriptEntries) ? transcriptEntries : [];
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  for (const e of list) {
    if (!e || typeof e.role !== "string") continue;
    if (e.role === "user") userTurns++;
    else if (e.role === "assistant") assistantTurns++;
    else if (e.role === "tool") toolCalls++;
  }
  return { userTurns, assistantTurns, toolCalls };
}

/**
 * Emit the single "recording-complete" lick that tells the orchestrator a
 * session finished. Must fire exactly once per session; callers that might
 * retry finalisation should pass the same `state` object across calls, or
 * otherwise ensure this is invoked once, since this function does not
 * itself deduplicate across separate calls (see `finalizeSession` for the
 * per-call guard used in this module's own orchestration path).
 *
 * @param {object} slicc - bridge object with lick(payload):Promise|void.
 * @param {object} params
 * @param {string} params.sessionDir
 * @param {string} params.endReason - "manual" | "cap" | "dryrun" | "error:*" etc.
 * @param {number} params.durationMs
 * @param {Array<object>} params.transcriptEntries
 * @param {number} [params.humanBytes]
 * @param {number} [params.agentBytes]
 * @param {number} [params.warnings] - count of diagnostic warnings, if known
 *   (e.g. from writeDiagnostics()'s returned summary.warningCount). Defaults
 *   to 0 when not supplied -- callers that ran writeDiagnostics should pass
 *   its summary.warningCount through here so the lick payload reflects it.
 * @param {number} [opts.timeoutMs=4000]
 * @returns {Promise<object>} the payload that was (attempted to be) sent.
 */
export async function emitRecordingCompleteLick(slicc, params, opts) {
  const { timeoutMs = 4000 } = opts || {};
  if (!slicc || typeof slicc.lick !== "function") {
    throw new Error("emitRecordingCompleteLick: slicc.lick is not available");
  }

  const { sessionDir, endReason, durationMs, transcriptEntries, humanBytes, agentBytes, warnings } = params || {};

  const { userTurns, assistantTurns } = countTurns(transcriptEntries);

  const payload = {
    action: "recording-complete",
    data: {
      sessionDir: sessionDir || null,
      endReason: endReason || "unknown",
      durationMs: typeof durationMs === "number" ? durationMs : null,
      transcriptEntries: Array.isArray(transcriptEntries) ? transcriptEntries.length : 0,
      userTurns,
      assistantTurns,
      humanBytes: typeof humanBytes === "number" ? humanBytes : null,
      agentBytes: typeof agentBytes === "number" ? agentBytes : null,
      warnings: typeof warnings === "number" ? warnings : 0,
    },
  };

  await withTimeout(Promise.resolve(slicc.lick(payload)), timeoutMs, "emitRecordingCompleteLick:lick");

  return payload;
}

/**
 * Run the full end-of-session sequence in the guaranteed order:
 *   1. (artifacts -- already written by the caller before calling this;
 *      not repeated here, see session-end-INTEGRATION.md)
 *   2. writeDiagnostics()
 *   3. emitRecordingCompleteLick()
 *
 * Each step is isolated: a failure writing diagnostics does NOT prevent the
 * lick from firing (and never touches/undoes artifacts already on disk,
 * since this function never writes artifacts itself). A failure emitting
 * the lick does not retroactively affect diagnostics or artifacts either.
 * The lick is only ever attempted once per call to finalizeSession.
 *
 * @param {object} slicc - bridge with writeFile/mkdir/lick.
 * @param {object} params
 * @param {string} params.sessionDir
 * @param {string} params.endReason
 * @param {number} params.durationMs
 * @param {Array<object>} params.transcriptEntries
 * @param {Array<object>} params.diagnosticsEntries
 * @param {number} [params.humanBytes]
 * @param {number} [params.agentBytes]
 * @param {number} [params.sessionStartMs] - the real session's own t0
 *   (epoch ms) -- see buildDiagnosticsDocument's warning-scoping doc.
 *   Real callers should always pass this; omitting it disables window
 *   scoping entirely (every entry becomes eligible for warningCount),
 *   which exists only for backward-compatible/isolated testing.
 * @param {number} [params.sessionEndMs] - the real session's own endedAt.
 * @param {object} [opts]
 * @param {number} [opts.diagnosticsTimeoutMs=4000]
 * @param {number} [opts.lickTimeoutMs=4000]
 * @param {(entry:object)=>boolean} [opts.isWarning]
 * @returns {Promise<{
 *   diagnostics: {ok:boolean, path?:string, summary?:object, error?:string},
 *   lick: {ok:boolean, payload?:object, error?:string},
 * }>}
 */
export async function finalizeSession(slicc, params, opts) {
  const { diagnosticsTimeoutMs = 4000, lickTimeoutMs = 4000, isWarning } = opts || {};
  const { sessionDir, endReason, durationMs, transcriptEntries, diagnosticsEntries, humanBytes, agentBytes, sessionStartMs, sessionEndMs } = params || {};

  const result = {
    diagnostics: { ok: false },
    lick: { ok: false },
  };

  // Step 2: diagnostics. Isolated in its own try/catch so a failure here
  // (e.g. a hanging or rejecting writeFile) can never propagate and abort
  // step 3, and can never be interpreted as undoing the artifacts written
  // before finalizeSession was ever called.
  let warningCount = 0;
  try {
    const { path, summary } = await writeDiagnostics(slicc, sessionDir, diagnosticsEntries, {
      timeoutMs: diagnosticsTimeoutMs,
      isWarning,
      sessionStartMs,
      sessionEndMs,
    });
    warningCount = summary.warningCount;
    result.diagnostics = { ok: true, path, summary };
  } catch (err) {
    result.diagnostics = { ok: false, error: err && err.message ? err.message : String(err) };
  }

  // Step 3: lick. Runs regardless of whether step 2 succeeded, and is
  // attempted exactly once. Its own failure is captured, not thrown, so
  // finalizeSession always resolves with a full picture rather than
  // rejecting and leaving the caller unsure what happened.
  try {
    const payload = await emitRecordingCompleteLick(
      slicc,
      {
        sessionDir,
        endReason,
        durationMs,
        transcriptEntries,
        humanBytes,
        agentBytes,
        warnings: warningCount,
      },
      { timeoutMs: lickTimeoutMs }
    );
    result.lick = { ok: true, payload };
  } catch (err) {
    result.lick = { ok: false, error: err && err.message ? err.message : String(err) };
  }

  return result;
}
