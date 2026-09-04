// mic-watchdog.js
// Watches the mic-capture path (AudioContext + AudioWorklet + PCM append to
// the realtime WebSocket) for the specific failure mode that killed the
// first real interview: the browser suspends the mic AudioContext on a
// visibility/occlusion/focus change, the AudioWorklet stops running, and
// `input_audio_buffer.append` messages silently stop -- no exception, no
// close event, nothing. xAI's `turn_detection.idle_timeout_ms` (8000ms)
// eventually re-engages on the *server* side and starts producing agent
// turns with no user input, which is the only symptom that showed up in the
// transcript. This module exists so that failure is (a) caught within a few
// seconds instead of minutes, (b) self-healed via `ctx.resume()` where
// possible, and (c) escalated to a clean session abort where it is not.
//
// Dependency-free by design (see BRIEF.md / project constraints): no
// imports, no assumptions about a specific UI. The host supplies callbacks
// and feeds this module two pieces of live state (frame-sent notifications,
// the AudioContext, the MediaStream) -- this module never reaches into the
// DOM to change anything, it only *observes* `document`/`window` for the
// lifecycle events that correlate with the bug, and reports everything
// through callbacks + an event log.

/**
 * @typedef {Object} MicWatchdogOptions
 * @property {number} [stallThresholdMs=3000] How long with zero frames
 *   appended before a stall is declared (while active).
 * @property {number} [pollIntervalMs=500] How often the internal timer
 *   checks frame age / re-samples AudioContext state.
 * @property {number} [fatalAfterMs=15000] Total continuous stall duration
 *   after which the watchdog gives up on recovery and declares the session
 *   unrecoverable, regardless of resume-attempt outcomes.
 * @property {number} [maxResumeFailures=3] Consecutive `ctx.resume()`
 *   attempts that either reject or leave the context non-'running' before
 *   the watchdog declares the session unrecoverable.
 * @property {() => number} [now] Injectable clock, `Date.now` by default.
 *   Overridden in tests to drive the watchdog with a fake clock.
 * @property {(fn: () => void, ms: number) => any} [setIntervalFn]
 *   Injectable timer scheduler, `setInterval` by default. Tests can pass a
 *   no-op here and drive time via repeated calls to `.poll()` instead.
 * @property {(handle: any) => void} [clearIntervalFn] Paired with
 *   `setIntervalFn`.
 * @property {(info: {sinceLastFrameMs: number, frameCount: number}) => void} [onStall]
 *   Fired once per stall episode, on the transition into "stalled".
 * @property {(info: {stalledForMs: number, frameCount: number}) => void} [onRecovered]
 *   Fired once per stall episode, when frames resume.
 * @property {(info: {reason: string, detail?: any, events: MicWatchdogEvent[]}) => void} [onFatal]
 *   Fired once, ever, when recovery has genuinely failed and the host should
 *   stop the interview cleanly rather than keep recording silence.
 * @property {(entry: MicWatchdogEvent) => void} [onDiagnostic]
 *   Fired for *every* entry appended to the event log (including the ones
 *   that also trigger onStall/onRecovered/onFatal) -- convenient for a host
 *   that wants a live console/UI feed without polling getEvents().
 */

/**
 * @typedef {Object} MicWatchdogEvent
 * @property {number} t Wall-clock ms (from the injectable clock) when the
 *   observation was made.
 * @property {string} type Self-describing event type, e.g.
 *   "ctx-statechange", "stall", "recovered", "resume-success",
 *   "resume-error", "visibilitychange", "track-muted", "fatal". Kept as a
 *   flat, JSON-serialisable string (not an enum/class) because another
 *   module persists these verbatim to disk.
 * @property {Object} detail Type-specific, JSON-serialisable payload.
 */

const DEFAULTS = {
  stallThresholdMs: 3000,
  pollIntervalMs: 500,
  fatalAfterMs: 15000,
  maxResumeFailures: 3,
};

class MicWatchdog {
  constructor(options = {}) {
    this._stallThresholdMs = options.stallThresholdMs ?? DEFAULTS.stallThresholdMs;
    this._pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this._fatalAfterMs = options.fatalAfterMs ?? DEFAULTS.fatalAfterMs;
    this._maxResumeFailures = options.maxResumeFailures ?? DEFAULTS.maxResumeFailures;

    this._now = options.now || (() => Date.now());
    this._setIntervalFn = options.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
    this._clearIntervalFn = options.clearIntervalFn || ((h) => clearInterval(h));

    this.onStall = options.onStall || null;
    this.onRecovered = options.onRecovered || null;
    this.onFatal = options.onFatal || null;
    this.onDiagnostic = options.onDiagnostic || null;

    this._events = [];
    this._active = false;
    this._disposed = false;
    this._fatal = false;

    this._frameCount = 0;
    this._lastFrameAt = null;
    this._stalled = false;
    this._stallStartedAt = null;
    this._resumeFailureCount = 0;

    this._ctx = null;
    this._ctxStateChangeHandler = null;
    this._trackHandlers = []; // [{track, type, fn}] for precise removeEventListener on dispose

    this._timerHandle = null;

    // Bound once so add/removeEventListener refer to the identical function.
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onWindowBlur = this._onWindowBlur.bind(this);
    this._onWindowFocus = this._onWindowFocus.bind(this);
    this._lifecycleAttached = false;
  }

  // ---- event log -----------------------------------------------------

  _log(type, detail = {}) {
    const entry = { t: this._now(), type, detail };
    this._events.push(entry);
    if (this.onDiagnostic) this.onDiagnostic(entry);
    return entry;
  }

  getEvents() {
    return this._events.slice();
  }

  getStatus() {
    return {
      active: this._active,
      fatal: this._fatal,
      stalled: this._stalled,
      frameCount: this._frameCount,
      lastFrameAgeMs: this._lastFrameAt == null ? null : this._now() - this._lastFrameAt,
      ctxState: this._ctx ? this._ctx.state : null,
    };
  }

  shouldAbortSession() {
    return this._fatal;
  }

  // ---- session start/stop --------------------------------------------

  /** Call once the mic pipeline is live and frames are expected to start flowing. */
  start() {
    if (this._disposed) throw new Error("MicWatchdog: cannot start() after dispose()");
    this._active = true;
    this._lastFrameAt = this._now(); // grace period starts now, not at the first frame
    this._stalled = false;
    this._stallStartedAt = null;
    this._log("watchdog-start", {});
    this._attachLifecycleListeners();
    if (!this._timerHandle) {
      this._timerHandle = this._setIntervalFn(() => this.poll(), this._pollIntervalMs);
    }
  }

  /**
   * Tears down every timer and listener this instance added. Idempotent.
   * Also usable as `.stop()`; both names are exposed because different
   * callers reach for different verbs (a running session "stops" a
   * watchdog, a one-off consumer "disposes" of it) and there is no
   * behavioral difference.
   */
  stop() {
    if (this._disposed) return;
    this._active = false;
    if (this._timerHandle != null) {
      this._clearIntervalFn(this._timerHandle);
      this._timerHandle = null;
    }
    this._detachLifecycleListeners();
    this._detachAudioContext();
    this._detachStream();
    this._log("watchdog-stop", {});
    this._disposed = true;
  }

  dispose() {
    this.stop();
  }

  // ---- frame-flow watchdog --------------------------------------------

  /** Call every time a PCM frame is actually sent to the WebSocket. */
  noteFrameAppended() {
    this._frameCount += 1;
    this._lastFrameAt = this._now();
    if (this._stalled) {
      const stalledForMs = this._now() - this._stallStartedAt;
      this._stalled = false;
      this._resumeFailureCount = 0; // frames are flowing again; forgive past resume failures
      this._log("recovered", { stalledForMs, frameCount: this._frameCount });
      if (this.onRecovered) this.onRecovered({ stalledForMs, frameCount: this._frameCount });
    }
  }

  /**
   * Runs the periodic checks: is the frame stream stalled, and (belt and
   * suspenders alongside the onstatechange listener) has the AudioContext
   * drifted into 'suspended' without an event we caught. Public so tests
   * can drive it directly against a fake clock instead of depending on a
   * real timer.
   */
  poll() {
    if (!this._active) return;

    if (this._lastFrameAt != null) {
      const age = this._now() - this._lastFrameAt;
      if (age >= this._stallThresholdMs && !this._stalled) {
        this._stalled = true;
        this._stallStartedAt = this._now() - age; // back-date to when it actually went quiet
        this._log("stall", { sinceLastFrameMs: age, frameCount: this._frameCount });
        if (this.onStall) this.onStall({ sinceLastFrameMs: age, frameCount: this._frameCount });
      }
      if (this._stalled) {
        const stalledForMs = this._now() - this._stallStartedAt;
        if (stalledForMs >= this._fatalAfterMs) {
          this._escalateFatal("stall-exceeded-fatal-threshold", { stalledForMs });
        }
      }
    }

    // Defensive re-sample: onstatechange should have already caught this,
    // but nothing guarantees the browser fires it reliably in every case,
    // and missing a suspended context silently is exactly the bug we are
    // hunting.
    if (this._ctx && this._ctx.state === "suspended" && this._active) {
      this._attemptResume("poll");
    }
  }

  // ---- AudioContext monitoring / auto-resume --------------------------

  /**
   * Attach to the mic AudioContext. Safe to call once, right after the
   * context is created -- monitoring itself is not gated on `start()`
   * (so a suspend during setup is still logged), but auto-resume attempts
   * only fire while a session is active (see `_attemptResume`).
   */
  attachAudioContext(ctx) {
    this._detachAudioContext();
    this._ctx = ctx;
    this._log("ctx-attached", { state: ctx.state });
    this._ctxStateChangeHandler = () => {
      const state = ctx.state;
      this._log("ctx-statechange", { state });
      if (state === "suspended" && this._active) this._attemptResume("statechange");
    };
    // AudioContext exposes this as an on* property, not a real event
    // target in every implementation used here -- matches how the rest of
    // this codebase (AudioPlayer, TrackRecorder) already assigns on*
    // handlers directly rather than addEventListener.
    ctx.onstatechange = this._ctxStateChangeHandler;
  }

  _detachAudioContext() {
    if (this._ctx && this._ctx.onstatechange === this._ctxStateChangeHandler) {
      this._ctx.onstatechange = null;
    }
    this._ctx = null;
    this._ctxStateChangeHandler = null;
  }

  /**
   * `ctx.resume()` can reject (rare) or resolve while the context is still
   * not 'running' (browsers may refuse without a user-activation gesture,
   * e.g. resuming from a fully occluded/backgrounded tab). Both are
   * reported as failures -- this deliberately never treats "the promise
   * settled" as "it worked".
   */
  async _attemptResume(trigger) {
    if (!this._ctx || this._disposed) return;
    const before = this._ctx.state;
    this._log("resume-attempt", { trigger, before });
    try {
      await this._ctx.resume();
      const after = this._ctx.state;
      if (after === "running") {
        this._resumeFailureCount = 0;
        this._log("resume-success", { trigger, before, after });
      } else {
        this._resumeFailureCount += 1;
        this._log("resume-ineffective", { trigger, before, after, resumeFailureCount: this._resumeFailureCount });
        this._maybeEscalateFatalFromResume("resume-ineffective");
      }
    } catch (err) {
      this._resumeFailureCount += 1;
      this._log("resume-error", {
        trigger,
        before,
        message: err && err.message,
        resumeFailureCount: this._resumeFailureCount,
      });
      this._maybeEscalateFatalFromResume("resume-rejected");
    }
  }

  _maybeEscalateFatalFromResume(reason) {
    if (this._resumeFailureCount >= this._maxResumeFailures) {
      this._escalateFatal(reason, { resumeFailureCount: this._resumeFailureCount });
    }
  }

  _escalateFatal(reason, detail = {}) {
    if (this._fatal) return; // onFatal fires exactly once
    this._fatal = true;
    const entry = this._log("fatal", { reason, ...detail });
    if (this.onFatal) this.onFatal({ reason, detail, events: this.getEvents(), triggeredAt: entry.t });
  }

  // ---- page lifecycle listeners ---------------------------------------

  _attachLifecycleListeners() {
    if (this._lifecycleAttached) return;
    // Guarded rather than assumed: keeps this module loadable/testable
    // under Node (see the throwaway test harness) without a DOM shim.
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("blur", this._onWindowBlur);
      window.addEventListener("focus", this._onWindowFocus);
    }
    this._lifecycleAttached = true;
  }

  _detachLifecycleListeners() {
    if (!this._lifecycleAttached) return;
    if (typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
    if (typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("blur", this._onWindowBlur);
      window.removeEventListener("focus", this._onWindowFocus);
    }
    this._lifecycleAttached = false;
  }

  _onVisibilityChange() {
    const hidden = typeof document !== "undefined" && document.hidden;
    this._log("visibilitychange", { hidden: !!hidden });
    if (!hidden) this._recheckAndResume("visibilitychange");
  }

  _onWindowBlur() {
    this._log("blur", {});
  }

  _onWindowFocus() {
    this._log("focus", {});
    this._recheckAndResume("focus");
  }

  _recheckAndResume(trigger) {
    if (this._ctx && this._ctx.state === "suspended" && this._active) {
      this._attemptResume(trigger);
    }
  }

  // ---- audio track health ---------------------------------------------

  /** Attach onended/onmute/onunmute listeners to every audio track in the stream. */
  attachStream(stream) {
    this._detachStream();
    if (!stream || typeof stream.getAudioTracks !== "function") return;
    for (const track of stream.getAudioTracks()) {
      const makeHandler = (type) => () => {
        this._log(`track-${type}`, { trackId: track.id, label: track.label, readyState: track.readyState });
        // A track that ended is not something `ctx.resume()` can fix --
        // the source is gone. Muted is common (OS-level privacy toggle,
        // device switch) and often self-resolves via onunmute, so it is
        // reported but not treated as fatal on its own.
        if (type === "ended" && this._active) {
          this._escalateFatal("audio-track-ended", { trackId: track.id });
        }
      };
      for (const type of ["ended", "mute", "unmute"]) {
        const fn = makeHandler(type);
        track.addEventListener(type, fn);
        this._trackHandlers.push({ track, type, fn });
      }
    }
  }

  _detachStream() {
    for (const { track, type, fn } of this._trackHandlers) {
      try {
        track.removeEventListener(type, fn);
      } catch (err) {
        /* track may already be stopped/gone */
      }
    }
    this._trackHandlers = [];
  }
}

/**
 * Factory matching the rest of this codebase's style (see
 * createHumanRecorder/createAgentRecorder in recorder.js): a thin wrapper
 * so callers do not need `new`, and so the class itself stays free to
 * change shape internally.
 *
 * @param {MicWatchdogOptions} [options]
 * @returns {MicWatchdog}
 */
export function createMicWatchdog(options = {}) {
  return new MicWatchdog(options);
}

export { MicWatchdog };
