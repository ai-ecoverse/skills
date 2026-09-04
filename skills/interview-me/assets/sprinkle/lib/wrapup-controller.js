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
// ROUND 4 (review follow-up, reasoned from the code and reproduced with a
// unit harness driving poll() -- no live session): both remaining guards
// were too narrow.
//   a. STOP-ON-SILENCE armed the moment the threshold passed, with no
//      requirement that anything had closed. Ordinary between-turn silence
//      is indistinguishable from "the interview is over": threshold
//      arrives right after the agent's question, the user is still
//      thinking, and silenceSustainMs later the recording stops -- with
//      the last answer never given, and sooner than the server's own
//      idle_timeout_ms would have re-engaged them. It also starved the
//      fallback: at threshold+5s the host ended the session, ~15s before
//      the +20s fallback could ever run, so a "forced" close was
//      effectively unreachable in any quiet session. Now gated on a close
//      having actually been delivered.
//   b. THE FALLBACK only deferred for the response created AFTER the
//      directive, so a response created just BEFORE it -- still
//      generating, still audible, and measured by the host at up to 59s
//      -- did not defer anything, and the canned line could start over
//      it. Now it defers for ANY in-flight response and for undrained
//      playback too. A barge-in over the agent is still a barge-in.
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
//   2. STOP ON SILENCE: once a close has actually been DELIVERED (a
//      recognised closing turn, or the fallback line below), if the user
//      is not speaking, no response is in flight, and agent playback has
//      drained, for a SUSTAINED period, tell the host to end the session
//      -- the expected ending once wind-down begins, independent of
//      whether the closing turn itself ever completed cleanly.
//
//      ROUND 4: this stage used to arm the instant the threshold passed,
//      with no requirement that anything had closed. That made ordinary
//      between-turn silence indistinguishable from "the interview is
//      over": if the threshold arrived just after the agent finished a
//      question, while the user was still thinking about their answer,
//      all three conditions were already true and the session ended
//      silenceSustainMs later -- before the user could answer at all,
//      and before the server's own idle_timeout_ms (8000, see
//      buildSessionConfig()) would have re-engaged them. It also made
//      stage 3 nearly unreachable: in a quiet session this fired at
//      threshold+5s, long before the +20s fallback it is supposed to
//      complement.
//   3. FALLBACK (genuine last resort, and the ONLY stage that defers for
//      anything that is merely IN PROGRESS -- this is the one thing that
//      can actually talk over someone): if neither (2) nor a recognised
//      closing turn (see noteResponseDone()) has happened
//      `fallbackDelayMs` after the directive landed, AND nothing audible
//      is happening right now -- the user is not speaking, NO response of
//      any kind is generating, and agent playback has drained -- send the
//      canned force_message so the interview has SOME graceful ending.
//      ROUND 4: the in-flight check used to cover only the response
//      created AFTER the directive (`_closingResponseInFlight`), so a
//      response created just BEFORE it -- the exact race the round-2 note
//      above describes, and one the host has measured taking as long as
//      59s -- left the guard open and let the canned line start over an
//      answer the agent was still speaking. Deferring on ANY in-flight
//      response (and on undrained playback) closes that hole; the
//      barge-in this module exists to prevent is no less of a barge-in
//      for happening over the agent instead of the user. Reuses the same "closing turn observed"
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
 *   agent playback drained) must hold CONTINUOUSLY, once a close has been
 *   delivered (see poll()), before onSustainedSilence() fires. See the host's own
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
 *   within fallbackDelayMs of the directive landing, and nothing audible
 *   is in progress at that moment (no user speech, no response of any
 *   kind generating, playback drained). The host is responsible for actually
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
 *   silenceSustainMs since a close was DELIVERED (a recognised closing
 *   turn, or the fallback). An ADDITIONAL route to a clean end alongside
 *   onClosingTurnComplete, for the case where the closing turn never
 *   settles into a clean response.done of its own.
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
    this._fallbackDeferralsLogged = {}; // reason -> true; keeps the once-per-reason deferral log out of every 250ms tick
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
    // onClosingTurnComplete above -- for the case where the closing turn
    // never settles into a clean response.done of its own, but the
    // conversation has nonetheless gone quiet (nobody speaking, nothing
    // generating, nothing still playing) for a sustained period. Tracks
    // how long the quiet condition has held CONTINUOUSLY -- any break
    // resets the clock.
    //
    // GATED on a close having actually been DELIVERED first
    // (`closeDelivered` below). Silence alone does not mean the interview
    // finished: crossing the threshold moments after the agent asked a
    // question leaves the user THINKING, which looks exactly like this
    // condition -- not speaking, nothing generating, nothing playing --
    // and ending there cuts the interview off before its last answer,
    // even before the server's own idle_timeout_ms would re-engage them.
    // Waiting for a close first also restores stage 3's reachability: an
    // ungated silence stop fired at threshold+silenceSustainMs, so the
    // host ended the session long before the +fallbackDelayMs fallback
    // this stage is meant to complement could ever run.
    if (!this._silenceStopSent) {
      const closeDelivered = this._closingTurnSeen || this._fallbackSent;
      const silentNow = closeDelivered && !this._userSpeaking && !this._responseInFlight && playbackDrained;
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

    // Stage 3 (last resort): the fallback. Only reachable once the
    // directive has landed, only fires once, only while neither a
    // recognised closing turn NOR sustained silence has already ended
    // things, and never while ANYTHING audible is in progress. THIS is
    // the one stage that defers, deliberately -- the force_message it
    // sends is the one thing in this module that can actually interrupt
    // someone, so every in-progress condition below is a reason to wait
    // rather than to speak.
    if (this._closingTurnSeen || this._fallbackSent) return;
    if (this._userSpeaking) return this._deferFallback("user-speaking"); // deferred indefinitely -- this is the audible one
    // ANY response in flight, not just the one created after the
    // directive: a response created just BEFORE the directive is still
    // real speech being generated, and `_closingResponseInFlight` (a
    // strict subset of this flag) is false for it, which is exactly how
    // the canned line could previously start over an answer already
    // underway. Waiting also gives that response the chance to become
    // the natural close.
    if (this._responseInFlight) return this._deferFallback("response-in-flight");
    // Generation finishing is not the same as the audio being heard:
    // response.done fires while the host's AudioPlayer may still have
    // seconds of queued PCM (see AudioPlayer#waitForDrain, which
    // onClosingTurnComplete's host callback also waits on). Speaking
    // over that tail is the same barge-in, one buffer later.
    if (!playbackDrained) return this._deferFallback("playback-draining");
    const sinceDirectiveMs = elapsedMs - this._directiveSentAtElapsedMs;
    if (sinceDirectiveMs >= this._fallbackDelayMs) {
      this._fallbackSent = true;
      this._log("fallback-sent", { elapsedMs, sinceDirectiveMs });
      if (this._sendFallbackMessage) this._sendFallbackMessage();
    }
  }

  // poll() runs every 250ms, so a deferral cannot log per tick without
  // burying diagnostics.json -- log the FIRST tick each distinct reason
  // defers the fallback and stay quiet after that. Round 4's two findings
  // were both diagnosed from this event log (see the module header), so
  // the new guards are worth the same one-line record.
  _deferFallback(reason) {
    if (this._fallbackDeferralsLogged[reason]) return;
    this._fallbackDeferralsLogged[reason] = true;
    this._log("fallback-deferred", { reason });
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
