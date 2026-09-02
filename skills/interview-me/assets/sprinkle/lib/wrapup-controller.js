// wrapup-controller.js
// State machine for winding an interview down gracefully as the deadline
// approaches, instead of blindly injecting a canned line on a fixed timer
// with no awareness of what's actually happening in the conversation.
//
// Real failure this fixes, ROUND 1: in a real session, a force_message
// fired mid-sentence while the user was mid-thought describing an
// unrelated project -- the scripted wrap-up line barged in and cut them
// off -- and then produced 29 seconds of dead air until the hard cap,
// because a force_message is a canned TTS utterance: it does not prompt
// the model to actually close the conversation, it just speaks over
// whoever/whatever was happening and ends the exchange rather than
// winding it down.
//
// Real failure this fixes, ROUND 2: the FIRST fix deferred the (silent)
// directive send while the user was speaking, on the same reasoning as
// the (audible, interrupting) fallback. That was wrong: `session.update`
// emits no audio and cannot interrupt anyone, so deferring it only
// delayed it -- in the real trace, until the exact moment the user
// stopped talking, which is also the exact moment the server's own turn
// detection triggers the model's next response. The directive arrived
// just after that response had already started generating (a real race
// this deferral made near-guaranteed, not just possible), so it missed
// influencing it.
//
// ROUND 3: probed three delivery channels against the live API
// (role-"system" items are silently ignored; a `session.update`
// instructions append and an unsolicited `function_call_output` both
// work, zero errors, and both produce a clean close with no new
// question). The preferred framing: deliver the time check as
// information the agent RECEIVED (a tool result), not words put in its
// mouth. Since the tool-result channel is undocumented behavior (it
// works today; xAI could change it), the durable `session.update`
// directive is kept as a documented backstop -- both are sent, together,
// at the threshold. Also: sessions were still ending on either a
// recognisable "closing turn" or the fixed-length hard cap; ending on
// SUSTAINED SILENCE instead means a session where the model never
// produces a clean closing turn still ends naturally rather than running
// to the deadline.
//
// Three-part design:
//   1. PRIMARY: at the wrap-up threshold, IMMEDIATELY and
//      UNCONDITIONALLY (never deferred for user speech -- neither of
//      these emits audio, so neither can interrupt anyone):
//        a. a time-check tool result (sendTimeCheck) -- the preferred
//           framing above, but undocumented behavior;
//        b. the closing directive (sendDirective, a session.update
//           appending to the real `instructions`) -- documented, and a
//           backstop in case (a) ever stops working.
//   2. STOP ON SILENCE: once past the threshold, if the user is not
//      speaking, no response is in flight, and agent playback has
//      drained, for a SUSTAINED period, tell the host to end the session
//      -- this is the primary, expected ending once wind-down begins,
//      independent of whether any particular "closing turn" was ever
//      recognised.
//   3. FALLBACK (genuine last resort, and the ONLY stage that still
//      defers during user speech -- this is the one thing that can
//      actually talk over someone): if neither (2) nor a recognised
//      closing turn (see noteResponseDone()) has happened
//      `fallbackDelayMs` after the directive landed, AND the user is not
//      speaking, send the canned force_message anyway so the interview
//      has SOME graceful ending. Reuses the same "closing turn observed"
//      detection -- the force_message's own response lifecycle naturally
//      satisfies it once it completes, so no special-casing is needed
//      for "what happens after the fallback plays" (silence detection
//      picks it up from there like any other response).
//
// Only the fallback defers, and only indefinitely while the user is
// mid-utterance -- this module never tells the host to interrupt anyone
// with the one thing that actually could. The host's own hard-cap
// timeout (well beyond the nominal session length -- see
// interview-me.shtml's HARD_BACKSTOP_GRACE_MS) remains the ultimate
// backstop for the case where the user simply never stops talking; that
// guarantee is the host's responsibility, not this module's, and is
// deliberately NOT reachable from anything in this file.
//
// Dependency-free, no DOM, no assumptions about a specific UI -- the host
// supplies action/notification callbacks and feeds this two pieces of
// live state (user speech start/stop, response-lifecycle notifications),
// matching mic-watchdog.js/stream-watchdog.js's established pattern in
// this codebase. Time is host-driven too: `poll(elapsedMs, playbackDrained)`
// takes the SAME session-relative elapsed-ms value the host's own
// countdown tick already computes (`Date.now() - state.t0`), plus a
// cheap synchronous "is agent audio done playing right now" boolean the
// host computes from its own AudioPlayer (this module has no DOM/audio
// access of its own) -- this module never reads a real clock or touches
// audio itself, which is what makes it fully deterministic to drive from
// a test with synthetic values, no fake timers needed.

/**
 * @typedef {Object} WrapupControllerOptions
 * @property {number} wrapAtMs Session-relative elapsed ms at which the
 *   time-check and closing directive are sent -- immediately, regardless
 *   of user speech state (see module header for why that is safe).
 * @property {number} [fallbackDelayMs=20000] How long after the directive
 *   lands to wait for a closing turn (or sustained silence) before
 *   falling back to sendFallbackMessage(). See the host's own comment
 *   (interview-me.shtml, near WRAP_UP_FALLBACK_DELAY_MS) for the
 *   reasoning behind the chosen value -- this module takes it as a
 *   parameter rather than opinion-having about it.
 * @property {number} [silenceSustainMs=5000] How long the "everything
 *   has gone quiet" condition (user not speaking, no response in flight,
 *   agent playback drained) must hold CONTINUOUSLY, once past the
 *   threshold, before onSustainedSilence() fires. See the host's own
 *   comment (interview-me.shtml, near SILENCE_SUSTAIN_MS) for the chosen
 *   value and reasoning.
 * @property {() => void} [sendTimeCheck] Called exactly once, at
 *   wrapAtMs, unconditionally, alongside sendDirective. The host is
 *   responsible for actually sending the time-check tool result.
 * @property {() => void} [sendDirective] Called exactly once, at
 *   wrapAtMs, unconditionally, alongside sendTimeCheck. The host is
 *   responsible for actually performing the session.update.
 * @property {() => void} [sendFallbackMessage] Called at most once, only
 *   if neither a closing turn nor sustained silence has been observed
 *   within fallbackDelayMs of the directive landing, and the user is not
 *   speaking at that moment. The host is responsible for actually
 *   calling sendForceMessage().
 * @property {() => void} [onClosingTurnComplete] Called once the
 *   "closing turn" (the first response created after the directive was
 *   sent -- see noteResponseCreated()) has fully completed. Fired for
 *   EITHER stage: a natural model-driven close, or the fallback
 *   force_message's own response lifecycle completing. The host decides
 *   what to do with that (e.g. wait for audio playback to drain, re-check
 *   user speech state, then stop).
 * @property {() => void} [onSustainedSilence] Called once, at most, when
 *   the "everything has gone quiet" condition has held continuously for
 *   silenceSustainMs since the threshold was crossed. An ADDITIONAL route
 *   to a clean end alongside onClosingTurnComplete, for the case where no
 *   recognisable closing turn ever happens.
 * @property {(entry: object) => void} [onDiagnostic] Fired for every
 *   entry appended to the internal event log -- same convenience hook
 *   mic-watchdog.js/stream-watchdog.js already expose, and specifically
 *   what let the round-2 bug get diagnosed from a real session's
 *   diagnostics.json (directive-sent / fallback-sent /
 *   closing-turn-complete with elapsed times) -- kept unchanged in shape,
 *   with time-check-sent / silence-stop added alongside.
 */

class WrapupController {
  constructor(options = {}) {
    this._wrapAtMs = options.wrapAtMs;
    if (typeof this._wrapAtMs !== "number") throw new Error("WrapupController requires a numeric wrapAtMs");
    this._fallbackDelayMs = typeof options.fallbackDelayMs === "number" ? options.fallbackDelayMs : 20000;
    this._silenceSustainMs = typeof options.silenceSustainMs === "number" ? options.silenceSustainMs : 5000;

    this._sendTimeCheck = options.sendTimeCheck || null;
    this._sendDirective = options.sendDirective || null;
    this._sendFallbackMessage = options.sendFallbackMessage || null;
    this._onClosingTurnComplete = options.onClosingTurnComplete || null;
    this._onSustainedSilence = options.onSustainedSilence || null;
    this._onDiagnostic = options.onDiagnostic || null;

    this._events = [];

    this._userSpeaking = false;
    this._directiveSent = false; // umbrella flag: true once BOTH the time-check and the directive have been sent (they fire together)
    this._directiveSentAtElapsedMs = null;
    this._responseInFlight = false; // true for ANY response, from created to done -- used for silence detection
    this._closingResponseInFlight = false; // the first NEW response created after the directive landed specifically
    this._closingTurnSeen = false; // that specific response has since completed
    this._fallbackSent = false;
    this._silenceStartedAtElapsedMs = null; // when the quiet condition most recently became true, or null if not currently quiet
    this._silenceStopSent = false;
  }

  // `t` here is a real wall-clock timestamp (Date.now()), purely for
  // human-readability once this log is merged into diagnostics.json
  // alongside mic-watchdog.js/stream-watchdog.js's own event logs (see
  // interview-me.shtml's collectDiagnosticsEntries(), which sorts by
  // `t`) -- it plays NO role in this module's own decision logic, which
  // is driven entirely by the host-supplied `elapsedMs` in poll() (see
  // the module header for why that split matters for testability).
  _log(type, detail = {}) {
    const entry = { t: Date.now(), type, detail };
    this._events.push(entry);
    if (this._onDiagnostic) this._onDiagnostic(entry);
    return entry;
  }

  getEvents() {
    return this._events.slice();
  }

  getStatus() {
    return {
      userSpeaking: this._userSpeaking,
      directiveSent: this._directiveSent,
      responseInFlight: this._responseInFlight,
      closingResponseInFlight: this._closingResponseInFlight,
      closingTurnSeen: this._closingTurnSeen,
      fallbackSent: this._fallbackSent,
      silenceStopSent: this._silenceStopSent,
    };
  }

  // ---- user speech state -----------------------------------------------

  /** Call from RealtimeSession#onSpeechStarted (input_audio_buffer.speech_started). */
  noteUserSpeechStarted() {
    this._userSpeaking = true;
    this._log("user-speech-started", {});
  }

  /** Call from RealtimeSession#onSpeechStopped (input_audio_buffer.speech_stopped). */
  noteUserSpeechStopped() {
    this._userSpeaking = false;
    this._log("user-speech-stopped", {});
  }

  // ---- response lifecycle (for closing-turn detection AND silence) -----

  /**
   * Call from RealtimeSession#onResponseCreated for EVERY response.
   * Always updates the general "is anything in flight" tracker (used by
   * silence detection); additionally marks the FIRST response created
   * after the directive was sent as the specific one being watched for
   * a recognised close (every later call is a no-op for that part, by
   * design).
   */
  noteResponseCreated() {
    this._responseInFlight = true;
    if (this._directiveSent && !this._closingResponseInFlight && !this._closingTurnSeen) {
      this._closingResponseInFlight = true;
      this._log("closing-response-created", {});
    }
  }

  /**
   * Call from RealtimeSession#onResponseDone for EVERY response. Always
   * clears the general in-flight tracker; additionally, if this was the
   * specific response noteResponseCreated() flagged above, fires the
   * closing-turn-complete notification.
   */
  noteResponseDone() {
    this._responseInFlight = false;
    if (this._closingResponseInFlight) {
      this._closingResponseInFlight = false;
      this._closingTurnSeen = true;
      this._log("closing-turn-complete", {});
      if (this._onClosingTurnComplete) this._onClosingTurnComplete();
    }
  }

  // ---- the decision loop ------------------------------------------------

  /**
   * Call on every countdown tick with the SAME session-relative elapsed
   * ms the host's own countdown already computes, plus a cheap
   * synchronous "is agent audio done playing right now" boolean (e.g.
   * `!state.player.isDraining()`). Pure decision logic, no real clock or
   * audio access here -- see the module header for why that makes this
   * deterministically testable.
   *
   * @param {number} elapsedMs
   * @param {boolean} [playbackDrained=true]
   */
  poll(elapsedMs, playbackDrained = true) {
    // Stage 1: send the time-check tool result AND the closing directive,
    // together, once, as soon as we are past the threshold --
    // UNCONDITIONALLY, never deferred for user speech. This is the
    // round-2 fix, still true in round 3: neither of these emits audio,
    // so neither can interrupt anyone, and deferring either only delays
    // it -- which is exactly what let the directive lose the race
    // against the model's next response in a real session (see module
    // header). Sending both the instant they're due maximizes the chance
    // they are already in effect before whatever the model generates
    // next.
    if (!this._directiveSent) {
      if (elapsedMs < this._wrapAtMs) return;
      this._directiveSent = true;
      this._directiveSentAtElapsedMs = elapsedMs;
      this._log("time-check-sent", { elapsedMs });
      if (this._sendTimeCheck) this._sendTimeCheck();
      this._log("directive-sent", { elapsedMs });
      if (this._sendDirective) this._sendDirective();
      return;
    }

    // Stop on silence: an ADDITIONAL route to a clean end, alongside
    // onClosingTurnComplete above -- for the case where the model never
    // produces a recognisable closing turn at all, but the conversation
    // has nonetheless gone quiet (nobody speaking, nothing generating,
    // nothing still playing) for a sustained period. Tracks how long the
    // quiet condition has held CONTINUOUSLY -- any break resets the
    // clock, so a natural pause mid-thought (which shows up as, at most,
    // a brief gap before the user resumes or the model responds) cannot
    // by itself end the interview.
    if (!this._silenceStopSent) {
      const silentNow = !this._userSpeaking && !this._responseInFlight && playbackDrained;
      if (silentNow) {
        if (this._silenceStartedAtElapsedMs === null) this._silenceStartedAtElapsedMs = elapsedMs;
        const silentForMs = elapsedMs - this._silenceStartedAtElapsedMs;
        if (silentForMs >= this._silenceSustainMs) {
          this._silenceStopSent = true;
          this._log("silence-stop", { elapsedMs, silentForMs });
          if (this._onSustainedSilence) this._onSustainedSilence();
          return;
        }
      } else {
        this._silenceStartedAtElapsedMs = null;
      }
    }

    // Stage 2 (last resort): the fallback. Only reachable once the
    // directive has landed, only fires once, only while neither a
    // recognised closing turn NOR sustained silence has already ended
    // things, never while the user is speaking, and never while a
    // response that MIGHT still be the natural closing turn is actively
    // in flight -- give it the chance to finish rather than talking
    // over/alongside it with the fallback line. THIS is the one stage
    // that still defers for user speech, deliberately unchanged from
    // before -- the force_message it sends is the one thing that can
    // actually interrupt someone.
    if (this._closingTurnSeen || this._fallbackSent || this._closingResponseInFlight) return;
    if (this._userSpeaking) return; // deferred indefinitely here -- this is the audible one
    const sinceDirectiveMs = elapsedMs - this._directiveSentAtElapsedMs;
    if (sinceDirectiveMs >= this._fallbackDelayMs) {
      this._fallbackSent = true;
      this._log("fallback-sent", { elapsedMs, sinceDirectiveMs });
      if (this._sendFallbackMessage) this._sendFallbackMessage();
    }
  }
}

/**
 * Factory matching this codebase's established style (see
 * createMicWatchdog/createStreamWatchdog): callers never need `new`.
 *
 * @param {WrapupControllerOptions} [options]
 * @returns {WrapupController}
 */
export function createWrapupController(options = {}) {
  return new WrapupController(options);
}

export { WrapupController };
