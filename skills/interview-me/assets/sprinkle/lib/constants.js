// interview-me / constants.js
//
// Timing constants, the wrap-up message/directive/tool-result payloads, the
// voice fallback list, and the handful of pure helpers that go with them
// (`firstSentenceOf`, `clampSessionMinutes`, `wrapupOffsetMs`,
// `appendWrapupDirective`, `withTimeout`, the `$` element lookup). Extracted
// verbatim from interview-me.shtml; behaviour unchanged. Every explanatory
// comment came along with its constant -- the reasoning behind these
// particular numbers is the valuable part and was measured against real
// sessions, not guessed.
//
// NOT here on purpose: `let sessionLengthMs`. It is mutable runtime state
// (a CLI config push moves it) rather than a constant, and several modules
// read it through a getter that has to observe the host's single live copy;
// exporting a module-level `let` would hand each importer a binding this
// file could no longer see being changed from outside.
//
// Loaded through `window.__imLoadModule` -- native ESM import of a VFS path
// cannot work in this `about:srcdoc` iframe (see the loader in the .shtml).

// The install location, single source of truth for every VFS path derived
// below. The .shtml's classic script sets `window.__IM_BASE_DIR__` BEFORE the
// module loader runs, so it is always available by the time this module
// evaluates; the literal fallback matches `install` (scripts/interview-me.jsh
// copies everything under /shared/sprinkles/interview-me). Other modules
// import BASE_DIR from here rather than repeating the literal.
export const BASE_DIR = (typeof window !== "undefined" && window.__IM_BASE_DIR__) || "/shared/sprinkles/interview-me";

export const FALLBACK_VOICES = ["eve", "altair", "ara", "atlas", "aurora", "carina", "castor", "celeste", "cosmo", "helios"];

// Used by the Advanced tab's voice-audition feature whenever there's no
// briefing to derive an opening line from yet (a brand-new install, or the
// briefing field genuinely empty). Deliberately phrased as a real opening
// question, not a generic demo line ("the quick brown fox...") -- the whole
// point of auditioning is to hear how a voice actually sounds asking the
// kind of thing this app asks.
export const DEFAULT_VOICE_PREVIEW_LINE = "Hey there. Quick one to start — what first drew you to building something like SLICC?";

/** First sentence of `text` (up to and including a ./!/? boundary), or the whole (trimmed) string if none is found. Empty input -> "". */
export function firstSentenceOf(text) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).trim();
}

// Session length is now configurable via config.json's `sessionMinutes`
// (read/applied through applyConfig(), same as every other field -- a CLI
// push picks it up live). DEFAULT_SESSION_MINUTES is only the fallback for
// when the field is absent (matches the previous hardcoded behavior);
// MIN/MAX are sane bounds: below 1 minute there is not enough time for
// even a single real question-and-answer exchange to complete, and above
// 10 minutes this stops being the "short spoken interview" format the rest
// of the UI copy/instructions assume (and produces a proportionally huge
// recording -- see recorder.js's bitrate comment). `sessionLengthMs` is
// the CURRENT live value (mutated by applyStaticConfigFields); each
// session snapshots it into `state.sessionLengthMs` at start (see
// beginSession()) so a config push mid-interview can never change the
// deadline of an interview already underway.
export const DEFAULT_SESSION_MINUTES = 5;
export const MIN_SESSION_MINUTES = 1;
export const MAX_SESSION_MINUTES = 10;

/** Returns a clamped integer-or-fractional minute count, or null if the input isn't a usable positive number. */
export function clampSessionMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_SESSION_MINUTES, Math.max(MIN_SESSION_MINUTES, n));
}

// The wrap-up nudge used to be a flat 30s before the end regardless of
// total length -- fine at 10% of a 5-minute session, but 50% of a
// 1-minute one. Proportional-with-a-cap.
//
// ROUND 2 REVISION: widened from 20%/30s-cap to 25%/45s-cap. Round 1's
// budget was sized around the OLD (buggy) design, where the directive
// send was deferred until the user stopped speaking and so could consume
// a real, unpredictable chunk of the reserved window before even
// landing. Now that the directive is sent immediately and unconditionally
// at the threshold (see WrapupController -- it's silent, it cannot
// interrupt anyone, so there's no reason to wait), that source of
// unpredictability is gone, and the real evidence
// (a recorded session) showed the OTHER problem instead:
// even with a same-instant send, the model's very next response can
// already be in flight (a genuine race against the server's own turn
// detection) and miss the directive, needing a further exchange to
// close. More total runway gives that further exchange room to actually
// happen instead of running into the fallback. At 5 minutes this now
// resolves to 45s (up from 30s); at 3 minutes to 45s as well (25% of
// 180s); at 1 minute it's 15s (25%, still well short of eating the whole
// session).
export function wrapupOffsetMs(lengthMs) {
  return Math.min(45000, lengthMs * 0.25);
}

// The canned line sent via sendForceMessage() -- a LAST-RESORT FALLBACK
// only (see WrapupController in lib/wrapup-controller.js), not the
// primary wrap-up action. Real evidence
// (a recorded session) showed why this can never be the
// primary action: it fired mid-sentence, cutting the user off, and a
// force_message is a canned TTS line -- it does not prompt the model to
// actually close, so it just ended the exchange rather than winding it
// down, producing ~29s of dead air. Pulled out to a shared constant so
// the fallback callback (which sends it) and claimForceMessageItem()
// (which records it verbatim once the server tells us which item id it
// landed under -- see that function's own comment) can never drift apart
// from each other.
export const WRAP_UP_MESSAGE = "We're almost out of time -- let's wrap up with one last thought.";

// ROUND 3: the user tested three delivery channels for the wrap-up notice
// against the live API before picking one. Role-"system"
// conversation.item.create items are silently ignored by the model (it
// asked a brand-new question anyway). Both a session.update instructions
// append AND an unsolicited function_call_output worked -- zero errors,
// clean close, no new question either way. His preference: frame the
// notice as information the agent RECEIVED (a tool result), not words
// put in its mouth -- that's WRAP_UP_TIME_CHECK_PAYLOAD below, sent as a
// real conversation.item.create/function_call_output via
// RealtimeSession#sendFunctionCallOutput with a synthetic call_id (no
// preceding function call -- undocumented behavior; it works today, but
// could change). WRAP_UP_DIRECTIVE (a session.update, documented,
// persists for the rest of the session) is kept as a DURABLE BACKSTOP
// sent at the exact same moment, so later turns stay in wind-down mode
// even if the tool-result channel ever stops working. Both are sent
// IMMEDIATELY at the wrap-up threshold, regardless of user speech state
// -- see WrapupController#poll()'s "Stage 1" comment for why that is
// safe (neither emits audio; neither can interrupt anyone) and why
// sending them as early as possible, rather than deferring the way
// ROUND 1 of this fix mistakenly did, matters: deferring until the user
// stops speaking put the directive in a race against the server's own
// turn-detection-triggered next response, and in a real session
// (a recorded session) it lost that race, arriving just after the
// next response had already started generating. The model then closes
// naturally, in context, on whichever of its own turns first reflects
// either signal -- possibly its very next one now, possibly one turn
// later if that race still doesn't go our way -- never by us injecting a
// turn on its behalf.
export const WRAP_UP_TIME_CHECK_CALL_ID = "call-timecheck-1"; // sent at most once per session, so a fixed literal is fine -- no need for a counter
export const WRAP_UP_TIME_CHECK_PAYLOAD = { time_check: "Interview time is up. Thank the guest and close warmly now. Ask no further questions." };
export const WRAP_UP_DIRECTIVE = "You are almost out of time. After the user's next answer, thank them and close warmly. Ask no new questions.";

// How long the "everything has gone quiet" condition -- user not
// speaking, no response in flight, agent playback drained (see
// WrapupController#poll()) -- must hold CONTINUOUSLY, once past the
// wrap-up threshold, before the session ends on its own with
// endReason:"wrapped-up". This is now the PRIMARY way a session ends
// once wind-down begins (see onSustainedSilence in beginSession()),
// independent of whether the model ever produces a turn recognisable as
// a deliberate "close". Chosen at 5s: the API's own turn_detection
// (silence_duration_ms:900) has already gated `userSpeaking` becoming
// false on a real ~900ms pause before this module ever sees it, so 5s of
// FURTHER continuous quiet on top of that is comfortably longer than any
// natural mid-thought breath; it is also safely under the session's own
// configured turn_detection.idle_timeout_ms (8000 -- the server's own
// threshold for proactively re-engaging a silent user), so this app acts
// to wrap up BEFORE the server would otherwise try to re-engage,
// avoiding an awkward collision between the two; and it is short enough
// that ending still feels prompt rather than making the user sit through
// a long, silent tail once the conversation has genuinely finished.
export const SILENCE_SUSTAIN_MS = 5000;

// The ultimate backstop, entirely separate from WrapupController (see
// startCountdown()'s tick(), which checks `elapsed >= sessionLengthMs +
// HARD_BACKSTOP_GRACE_MS`) -- guarantees a session can never run forever
// even if the user simply never stops talking (in which case NEITHER the
// fallback NOR stop-on-silence can ever fire, both deliberately deferring
// indefinitely during speech). Deliberately WELL BEYOND the nominal
// session length now that ending is silence-driven rather than
// clock-driven -- the nominal length only decides when wind-down BEGINS,
// not when the session must end, so this needs real headroom past it:
// a flat 60s addition, chosen over a percentage-based one so a very
// short session (e.g. sessionMinutes:1) still gets a full, useful grace
// window (a 20%-style scaling would only add ~12s to a 1-minute session,
// not enough room for a deferred fallback + its own playback + drain),
// while for longer sessions a flat 60s is still a small, bounded addition
// rather than a runaway one. Still recorded as endReason:"timeout" so
// the artifact distinguishes "the backstop actually had to fire" (a
// session that, unusually, never went quiet) from a normal
// endReason:"wrapped-up" ending.
export const HARD_BACKSTOP_GRACE_MS = 60000;

// How long to wait after the directive lands before giving up on a
// natural close and falling back to the canned WRAP_UP_MESSAGE. Chosen
// against the widened ~45s budget wrapupOffsetMs() now reserves before
// the hard cap (see that function). Raised from round 1's 15s to 20s:
// the directive now lands with its full lead time intact (no deferral
// latency eating into the wait), and the wider 45s window (up from 30s)
// leaves room to actually use a longer wait productively -- real
// transcript evidence across this app's own sessions shows exchanges can
// run 10-30s+ each, so 20s gives a real shot at one full additional
// exchange (the user's next answer, then the model's close) even with
// generation latency, while still leaving a comfortable ~25s of the 45s
// budget for the fallback's OWN force_message to play out and for the
// wait-for-audio-drain-then-stop sequence (see onClosingTurnComplete in
// beginSession()) if it does come to that. Unlike the directive, the
// fallback DOES still defer indefinitely while the user is speaking (see
// WrapupController#poll()'s "Stage 2" -- this is the one thing that can
// actually interrupt someone) -- if they are still talking when this
// delay elapses, the fallback simply waits, and this budget can end up
// mostly or entirely consumed by that deferral. That remains intentional:
// the hard cap stays the ultimate backstop, this fallback is a
// best-effort improvement on top of it, never a replacement for it.
export const WRAP_UP_FALLBACK_DELAY_MS = 20000;

// The ONE place the wrap-up directive gets combined with the real
// interview instructions -- pulled out as a small pure function (used by
// the real sendDirective callback in beginSession()) specifically so
// "append, never replace" is directly unit-testable without needing a
// real session/beginSession() call. Never mutates its input (strings are
// immutable anyway; named this way for clarity about intent).
export function appendWrapupDirective(currentInstructions, directive) {
  const current = currentInstructions || "";
  return `${current}\n\n${directive}`;
}

export const MODEL = "grok-voice-latest";
// Declared here (not down near loadConfig(), where it reads more naturally)
// on purpose: init() is called near the top of this script and runs
// synchronously up to its first `await`, which reaches into loadConfig()'s
// own body before yielding -- a `const` declared textually AFTER that
// init() call site is still in the temporal dead zone at that point and
// throws "Cannot access before initialization". Confirmed by hitting this
// exact error when CONFIG_PATH was declared next to loadConfig() instead:
// every top-level `const` this module needs before init() runs must be
// declared before the `init().catch(...)` call below, full stop.
export const CONFIG_PATH = `${BASE_DIR}/config.json`;

// Scratch root for lib/chunk-flusher.js's part files. Deliberately under /tmp
// and NOT inside a session directory: sessions/ holds finished, irreplaceable
// recordings, and the only thing that should ever land there is the assembled
// final file. A crash mid-session therefore leaves recoverable parts here
// rather than a half-populated session directory.
export const PARTS_ROOT = "/tmp/interview-me-parts";

// Where a finished session's artifacts are written. The ONE place this path
// literal lives -- writeSessionArtifacts() and the interrupted-session marker
// in session-start.js both derive their directory from it, so they can never
// disagree. Overridable at runtime (see getSessionsRoot in the .shtml) purely
// so the dry-run/self-test path can prove the real save path end to end into
// /tmp instead of writing into the real sessions directory. There is no UI and
// no config key for the override, deliberately.
export const SESSIONS_ROOT = `${BASE_DIR}/sessions`;

export const $ = (id) => document.getElementById(id);

// Bridge calls that touch the network (slicc.exec running curl, slicc.fetch)
// can in principle hang rather than reject -- a stalled shell, a dead
// network path, anything. A promise that never settles must not be allowed
// to leave a dropdown empty or a button spinning forever with no
// explanation. Every exec-dependent call below is wrapped in this.
export function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
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
