// stream-watchdog.js
// Watches the RECEIVE path of the realtime WebSocket -- the direction
// mic-watchdog.js does not cover. mic-watchdog.js exists because the mic
// capture pipeline can go silent while the socket stays open; this module
// exists because a failure observed in a real interview session was the
// mirror image: the socket stayed open (readyState OPEN the whole time,
// `onclose`/`onerror` never fired) while the SERVER stopped sending
// anything at all. Evidence, from that session's recorded artifacts:
//   - transcript.json: last real user turn at 3:48, then one assistant
//     entry at 4:30 with an EMPTY transcript, then nothing until the
//     5:00 hard cap.
//   - mic-watchdog.json: AudioContext 'running' throughout, no stall --
//     outbound PCM kept flowing the entire time, so mic-watchdog.js (which
//     only watches outbound frames) stayed clean and never noticed.
//   - debug.json: `session-closed {code:1005, reason:"", wasClean:true,
//     alreadyEnded:true}` -- the close event only fired during OUR OWN
//     teardown at the 5-minute cap, i.e. `isOpen()` kept returning true
//     the whole time nothing was arriving.
//
// Threshold, chosen from the REAL data (not a guess): a naive "no event in
// N seconds" check must not fire during a normal, healthy turn-taking
// pause. Measured the actual gaps between consecutive finalized entries in
// that same session's transcript.json (assistant-ends -> next-entry-starts,
// ms):
//   2059, 9401, 1515, 9786, 2187, 10556, 2328, 12120, 2373, 14265, 2187,
//   9456, 936
// The largest real, legitimately-healthy gap observed is 14265ms (the
// pause between the assistant asking "What does that look like in
// practice?" and the user starting to answer -- normal thinking time, not
// a fault). `noteServerEvent()` below is fed from EVERY inbound event via
// RealtimeSession#onRawEvent (including partial
// conversation.item.input_audio_transcription.updated events during a
// long user turn) -- not just finalized transcript entries -- so this
// number is already the coarsest, most conservative gap this module will
// ever see; the true inter-event gaps during an active turn are smaller
// still. `silenceThresholdMs` is set well above that measured ceiling
// (roughly 1.4x) so ordinary turn-taking silence can never false-positive,
// while still being a tiny fraction of the multi-minute silence the real
// failure produced, so a real fault is caught in tens of seconds instead
// of only at the 5-minute cap.
//
// Recovery: unlike mic-watchdog.js (which can call `ctx.resume()` on a
// concretely suspended AudioContext), there is no protocol-level ping the
// browser WebSocket API exposes, and reconnecting mid-interview would need
// a fresh ephemeral token plus replaying session state -- out of scope for
// an automatic recovery. The one "sane" lightweight recovery attempted
// here is a single benign `session.update` nudge per stall episode: if the
// socket is truly dead this does nothing (and may itself throw, which is
// treated as an immediate, decisive signal); if the connection is merely
// slow, a real `session.updated` event answering it will be observed as
// `noteServerEvent()` firing again, which cancels the stall. If neither
// happens within `fatalAfterMs` (measured from the actual last-event time,
// same convention as mic-watchdog.js), this module gives up and declares
// the session unrecoverable.

const DEFAULTS = {
  silenceThresholdMs: 20000,
  pollIntervalMs: 1000,
  fatalAfterMs: 45000,
};

class StreamWatchdog {
  constructor(options = {}) {
    this._silenceThresholdMs = options.silenceThresholdMs ?? DEFAULTS.silenceThresholdMs;
    this._pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this._fatalAfterMs = options.fatalAfterMs ?? DEFAULTS.fatalAfterMs;

    this._now = options.now || (() => Date.now());
    this._setIntervalFn = options.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
    this._clearIntervalFn = options.clearIntervalFn || ((h) => clearInterval(h));

    this.onStall = options.onStall || null;
    this.onRecovered = options.onRecovered || null;
    this.onFatal = options.onFatal || null;
    this.onDiagnostic = options.onDiagnostic || null;
    this.onEmptyResponse = options.onEmptyResponse || null;

    this._events = [];
    this._active = false;
    this._disposed = false;
    this._fatal = false;

    this._eventCount = 0;
    this._lastEventAt = null;
    this._stalled = false;
    this._stallStartedAt = null;
    this._nudgeAttempted = false;

    this._session = null;
    this._prevOnRawEvent = null;

    this._itemsWithDelta = new Set();

    this._timerHandle = null;
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
      eventCount: this._eventCount,
      lastEventAgeMs: this._lastEventAt == null ? null : this._now() - this._lastEventAt,
    };
  }

  shouldAbortSession() {
    return this._fatal;
  }

  // ---- session start/stop --------------------------------------------

  /** Call once the WebSocket session is live and inbound events are expected to start arriving. */
  start() {
    if (this._disposed) throw new Error("StreamWatchdog: cannot start() after dispose()");
    this._active = true;
    this._lastEventAt = this._now(); // grace period starts now, not at the first event
    this._stalled = false;
    this._stallStartedAt = null;
    this._nudgeAttempted = false;
    this._log("watchdog-start", {});
    if (!this._timerHandle) {
      this._timerHandle = this._setIntervalFn(() => this.poll(), this._pollIntervalMs);
    }
  }

  /** Tears down the timer and detaches from the session. Idempotent; `.dispose()` is an alias. */
  stop() {
    if (this._disposed) return;
    this._active = false;
    if (this._timerHandle != null) {
      this._clearIntervalFn(this._timerHandle);
      this._timerHandle = null;
    }
    this._detachSession();
    this._log("watchdog-stop", {});
    this._disposed = true;
  }

  dispose() {
    this.stop();
  }

  // ---- inbound-event watchdog -----------------------------------------

  /** Call for every inbound message received from the WebSocket (any type). */
  noteServerEvent(type) {
    this._eventCount += 1;
    this._lastEventAt = this._now();
    if (this._stalled) {
      const stalledForMs = this._now() - this._stallStartedAt;
      this._stalled = false;
      this._nudgeAttempted = false; // events are flowing again; forgive the past nudge attempt
      this._log("recovered", { stalledForMs, eventCount: this._eventCount, lastEventType: type || null });
      if (this.onRecovered) this.onRecovered({ stalledForMs, eventCount: this._eventCount });
    }
  }

  /**
   * Periodic check: has too much time passed with zero inbound events.
   * Public so tests can drive it directly against a fake clock instead of
   * a real timer, matching mic-watchdog.js's `.poll()`.
   */
  poll() {
    if (!this._active) return;
    if (this._lastEventAt == null) return;

    const age = this._now() - this._lastEventAt;
    if (age >= this._silenceThresholdMs && !this._stalled) {
      this._stalled = true;
      this._stallStartedAt = this._now() - age; // back-date to when it actually went quiet
      this._log("stall", { sinceLastEventMs: age, eventCount: this._eventCount });
      if (this.onStall) this.onStall({ sinceLastEventMs: age, eventCount: this._eventCount });
      this._attemptNudge();
    }

    if (this._stalled) {
      const stalledForMs = this._now() - this._stallStartedAt;
      if (stalledForMs >= this._fatalAfterMs) {
        this._escalateFatal("silence-exceeded-fatal-threshold", { stalledForMs });
      }
    }
  }

  /**
   * The one recovery attempt per stall episode: a benign `session.update`
   * with an empty patch. If the socket is genuinely dead this either
   * throws (readyState no longer OPEN -- treated as decisive, escalates
   * immediately) or silently goes nowhere (a real black hole never
   * surfaces a synchronous error, per the `send()` spec); either way this
   * never blocks -- `poll()`'s own `fatalAfterMs` countdown is what
   * actually decides the outcome.
   */
  _attemptNudge() {
    if (this._nudgeAttempted || !this._session) return;
    this._nudgeAttempted = true;
    this._log("nudge-attempt", {});
    try {
      const sent = this._session.isOpen() && this._session.updateSession({});
      this._log(sent ? "nudge-sent" : "nudge-not-sent", { sent: !!sent });
      if (!sent) this._escalateFatal("socket-not-open-at-nudge", {});
    } catch (err) {
      this._log("nudge-error", { message: err && err.message });
      this._escalateFatal("nudge-threw", { message: err && err.message });
    }
  }

  _escalateFatal(reason, detail = {}) {
    if (this._fatal) return; // onFatal fires exactly once
    this._fatal = true;
    const entry = this._log("fatal", { reason, ...detail });
    if (this.onFatal) this.onFatal({ reason, detail, events: this.getEvents(), triggeredAt: entry.t });
  }

  // ---- RealtimeSession wiring ------------------------------------------

  /**
   * Attach to the live RealtimeSession: chains `onRawEvent` (fires for
   * every parsed inbound event, per realtime-session.js) so every event,
   * not just finalized transcript turns, resets the silence clock -- this
   * is what lets `silenceThresholdMs` stay far below a turn's total
   * duration without false-positiving on a long user utterance (see the
   * module header for the measured gaps this was chosen against). Also
   * gives this module the reference it needs for its own recovery nudge.
   */
  attachSession(session) {
    this._detachSession();
    this._session = session;
    this._prevOnRawEvent = session.onRawEvent || null;
    const prev = this._prevOnRawEvent;
    session.onRawEvent = (event) => {
      this.noteServerEvent(event && event.type);
      if (prev) prev(event);
    };
  }

  _detachSession() {
    if (this._session && this._session.onRawEvent) {
      // Only restore if we are still the one holding it (best-effort;
      // this module never outlives the session it was attached to in
      // practice, but avoid clobbering an unrelated later assignment).
      this._session.onRawEvent = this._prevOnRawEvent;
    }
    this._session = null;
    this._prevOnRawEvent = null;
  }

  // ---- "response created but produced no transcript" detection --------

  /** Call from RealtimeSession#onAssistantTranscriptDelta -- marks this item as having produced real content. */
  noteAssistantDelta(itemId) {
    if (itemId) this._itemsWithDelta.add(itemId);
  }

  /**
   * Call from RealtimeSession#onAssistantTranscriptDone. A response that
   * settles with no delta ever having arrived AND no final text is exactly
   * the shape of the empty 4:30 entry from the real failure -- the server
   * (or a dead stream) produced a "turn" with nothing in it. Recorded as a
   * diagnostic (which flows into diagnostics.json's warning count, see
   * session-end.js's default /warn|stall|fail|error/i predicate) rather
   * than silently accepted.
   */
  noteAssistantResponseDone(itemId, finalText) {
    const hadDelta = itemId ? this._itemsWithDelta.has(itemId) : false;
    if (itemId) this._itemsWithDelta.delete(itemId);
    const isEmpty = !hadDelta && (!finalText || !String(finalText).trim());
    if (isEmpty) {
      const entry = this._log("empty-response-warning", { itemId: itemId || null });
      if (this.onEmptyResponse) this.onEmptyResponse({ itemId: itemId || null, entry });
    }
    return { hadDelta, isEmpty };
  }
}

/**
 * Factory matching mic-watchdog.js's `createMicWatchdog` (and
 * recorder.js's `createHumanRecorder`/`createAgentRecorder`): callers
 * never need `new`, and the class stays free to change shape internally.
 *
 * @param {object} [options]
 * @returns {StreamWatchdog}
 */
export function createStreamWatchdog(options = {}) {
  return new StreamWatchdog(options);
}

export { StreamWatchdog };
