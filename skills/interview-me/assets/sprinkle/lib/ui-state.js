// ui-state.js
// Persists small, JSON-serialisable UI state (active tab, active screen,
// briefing textarea content) across a sprinkle re-render, plus a durable
// "a recording was in flight when we died" marker -- see UiState.markSessionStarted
// below and ui-state-INTEGRATION.md for why that marker exists and how to wire it.
//
// Deliberately NEVER touches: MediaStream, MediaRecorder, AudioContext,
// WebSocket, Blob, or anything else that cannot be JSON-serialised or that
// would not survive the JS context being torn down. If you find yourself
// wanting to put one of those (or a reference/handle to one) into the
// object passed to update()/markSessionStarted(), stop -- persist a plain
// descriptor instead (e.g. the session directory path and a timestamp,
// not the recorder).
//
// The host's persistence bridge (`slicc.setState`/`slicc.getState`) is a
// bridge call like any other in this app: it CAN hang instead of
// rejecting. Every call through this module is timeout-bounded, and a
// failed/timed-out SAVE is swallowed (logged, not thrown) -- losing a few
// hundred ms of UI state is an acceptable degradation, wedging the app is
// not. A failed/timed-out RESTORE degrades to defaults for the same reason.

export const SCHEMA_VERSION = 1;

export const DEFAULT_UI_STATE = Object.freeze({
  tab: "interview", // "interview" | "advanced"
  screen: "setup", // "setup" | "live" | "review"
  brief: "",
});

function cloneDefaultUiState() {
  return { ...DEFAULT_UI_STATE };
}

/**
 * Tolerant validation of a restored `uiState` sub-object. Never throws --
 * anything it can't make sense of falls back to the matching default field.
 */
function sanitizeUiState(raw) {
  const out = cloneDefaultUiState();
  if (!raw || typeof raw !== "object") return out;
  if (raw.tab === "interview" || raw.tab === "advanced") out.tab = raw.tab;
  if (raw.screen === "setup" || raw.screen === "live" || raw.screen === "review") out.screen = raw.screen;
  if (typeof raw.brief === "string") out.brief = raw.brief;
  return out;
}

/**
 * Tolerant validation of a restored `session` (interrupted-session marker)
 * sub-object. Returns null when there is nothing to report -- absence of a
 * marker, not merely a falsy field, is what "no interrupted session" means.
 */
function sanitizeSession(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.active !== true) return null;
  if (typeof raw.sessionDir !== "string" || !raw.sessionDir) return null;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt)) return null;
  return { active: true, sessionDir: raw.sessionDir, startedAt: raw.startedAt };
}

/** Runs `promise`, resolving to `fallback` (never throwing) if it rejects or exceeds `ms`. */
function withTimeoutOrFallback(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/**
 * UiState -- small persistence helper for one sprinkle instance.
 *
 * @param {{setState:(v:unknown)=>any, getState:()=>any}} bridge
 *   Passed in rather than read off a global so this module is testable
 *   with a fake bridge. Both methods may return a plain value or a
 *   Promise; both are treated as possibly-hanging.
 * @param {object} [options]
 * @param {number} [options.debounceMs=400] debounce window for update()-triggered saves
 * @param {number} [options.timeoutMs=2000] bound on every individual bridge call
 * @param {(context:string, err:Error)=>void} [options.onError] called (never thrown) on a save/restore failure, for diagnostics
 */
export class UiState {
  constructor(bridge, options = {}) {
    if (!bridge || typeof bridge.setState !== "function" || typeof bridge.getState !== "function") {
      throw new Error("UiState requires a bridge with setState(v) and getState() functions");
    }
    this._bridge = bridge;
    this._debounceMs = typeof options.debounceMs === "number" ? options.debounceMs : 400;
    this._timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 2000;
    this._onError = typeof options.onError === "function" ? options.onError : () => {};

    this._uiState = cloneDefaultUiState();
    this._session = null; // interrupted-session marker, or null
    this._timer = null;
    this._pendingSave = null; // Promise for the in-flight/most-recent debounced save, for flush() to await
  }

  /** Current in-memory persisted object snapshot (for debugging/tests). Does not touch the bridge. */
  getSnapshot() {
    return {
      v: SCHEMA_VERSION,
      uiState: { ...this._uiState },
      session: this._session ? { ...this._session } : null,
    };
  }

  /**
   * Merge `partial` (any subset of {tab, screen, brief}) into the in-memory
   * ui state and schedule a debounced save. Safe to call on every
   * keystroke -- rapid calls coalesce into one save `debounceMs` after the
   * last call.
   */
  update(partial) {
    if (partial && typeof partial === "object") {
      if (partial.tab === "interview" || partial.tab === "advanced") this._uiState.tab = partial.tab;
      if (partial.screen === "setup" || partial.screen === "live" || partial.screen === "review") this._uiState.screen = partial.screen;
      if (typeof partial.brief === "string") this._uiState.brief = partial.brief;
    }
    this._scheduleSave();
  }

  /**
   * Mark a recording session as in progress and flush immediately (this is
   * an important moment -- do not let it sit in the debounce window). Call
   * this once the recording has actually started, with the SAME session
   * directory the app will write artifacts to when it ends normally.
   */
  markSessionStarted({ sessionDir, startedAt }) {
    if (typeof sessionDir !== "string" || !sessionDir) throw new Error("markSessionStarted requires a sessionDir string");
    const ts = typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : Date.now();
    this._session = { active: true, sessionDir, startedAt: ts };
    return this.flush();
  }

  /**
   * Clear the interrupted-session marker (call on normal session end --
   * stop button, natural completion, or a start attempt that failed before
   * any recording began) and flush immediately.
   */
  clearSession() {
    this._session = null;
    return this.flush();
  }

  _scheduleSave() {
    if (this._timer) clearTimeout(this._timer);
    this._pendingSave = new Promise((resolve) => {
      this._timer = setTimeout(() => {
        this._timer = null;
        this._save().then(resolve, resolve);
      }, this._debounceMs);
    });
  }

  /** Cancel any pending debounced save and write the current state immediately. Resolves once done (never throws). */
  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._pendingSave = this._save();
    return this._pendingSave;
  }

  async _save() {
    const payload = this.getSnapshot();
    const result = await withTimeoutOrFallback(
      (async () => {
        await this._bridge.setState(payload);
        return { ok: true };
      })(),
      this._timeoutMs,
      { ok: false, timedOut: true }
    );
    if (!result.ok) {
      this._onError("save", new Error(result.timedOut ? "setState timed out" : "setState failed"));
    }
    return result.ok;
  }

  /**
   * Reads persisted state back from the bridge and tolerantly reconstructs
   * in-memory state from it. Never throws: a hung bridge, malformed JSON,
   * a null/missing/wrong-shaped payload, or a schema version mismatch all
   * degrade to defaults (and no interrupted session) rather than blocking
   * or crashing startup.
   *
   * @returns {Promise<{uiState: {tab:string,screen:string,brief:string}, interruptedSession: {sessionDir:string,startedAt:number}|null}>}
   */
  async restore() {
    const raw = await withTimeoutOrFallback(Promise.resolve(this._bridge.getState()), this._timeoutMs, undefined);

    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this._onError("restore-parse", err);
        parsed = null;
      }
    }

    if (parsed == null || typeof parsed !== "object" || parsed.v !== SCHEMA_VERSION) {
      // Missing save, malformed payload, or a schema version we don't
      // recognise (an older/newer sprinkle build) -- fall back cleanly.
      // NOTE: a version bump here loses any in-flight interrupted-session
      // marker written under the old schema. Acceptable: it is a UI-state
      // convenience feature, not the recording artifacts themselves (those
      // live under sessions/ independent of this module).
      this._uiState = cloneDefaultUiState();
      this._session = null;
      return { uiState: { ...this._uiState }, interruptedSession: null };
    }

    this._uiState = sanitizeUiState(parsed.uiState);
    this._session = sanitizeSession(parsed.session);

    return {
      uiState: { ...this._uiState },
      interruptedSession: this._session ? { sessionDir: this._session.sessionDir, startedAt: this._session.startedAt } : null,
    };
  }
}
