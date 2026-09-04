# Steering a live session mid-conversation

Ending an interview gracefully (or otherwise nudging the model's behavior
mid-session) is harder than it looks with a realtime voice API, because
almost every intervention risks talking over the human. Three delivery
channels were tested empirically against the live API; here's what
actually works.

## Three channels, tested live

1. **A synthetic user/system message (`role: "system"` item via
   `conversation.item.create`) — does not work.** The model silently
   ignores it. Do not rely on this channel for anything.
2. **`session.update` appending to `instructions` — works, and is
   documented behavior.** Silent (emits no audio), so it can never
   interrupt anyone. This is the durable, safe channel: append to the
   existing instructions (don't replace them outright — the model still
   needs the original interview brief/persona) and let the model close
   naturally on its own next turn.
3. **An unsolicited `function_call_output` (a synthetic tool result the
   client sends without a preceding tool call) — works, but is
   undocumented behavior.** It reads to the model as information it
   *received* (e.g. "the current time is up") rather than an instruction
   injected into its own instructions. This produced a clean close with
   no further questions in live testing, but since it's not documented,
   treat it as a nice-to-have delivered *alongside* the documented
   `session.update` approach, never as the only mechanism — xAI could
   change undocumented behavior without notice.

## Silent actions should never be deferred for user speech; audible ones must be

This is the single most important lesson from three rounds of getting a
wrap-up feature wrong in production:

- A `session.update` (silent) or a synthetic `function_call_output`
  (silent) **cannot interrupt anyone** — there's no reason to ever defer
  sending either while the user is speaking. Deferring a silent action
  "to be polite" only delays it, and delaying it until the exact moment
  the user *stops* speaking puts it in a race against the server's own
  turn-detection-triggered next response — a race the deferred send will
  frequently lose, because that's the exact same moment the server
  decides to start generating.
- A `force_message` (a scripted, canned TTS line) is **audible** and
  genuinely can interrupt someone mid-sentence. This is the one channel
  that must defer while the user is speaking.

Getting this distinction backwards (deferring the silent directive "for
consistency" with the audible fallback) was an actual production bug: the
directive arrived a fraction of a second after the user stopped talking,
which was already too late — the model's next (unwanted) turn had already
started generating.

## A two-stage design that works

1. **Primary, immediate, unconditional**: the moment a wrap-up threshold
   is crossed, send both the `session.update` directive and (optionally)
   the synthetic tool-result time-check, together, regardless of whether
   the user is currently speaking. Neither can interrupt anyone.
2. **Fallback (audible, last resort)**: if no natural closing turn
   happens within some bounded delay after the directive lands (and the
   user isn't speaking, and no response that might still *be* the
   closing turn is in flight), send a scripted `force_message` to wrap
   up explicitly. This one **does** defer indefinitely while the user is
   speaking.

Pick the fallback delay with real transcript evidence: measure how
quickly your model actually tends to reply after a user turn ends in
practice, and give it enough margin for one full additional exchange
(the user's next answer, plus the model's closing reply) before falling
back to the canned line.

## Ending on sustained silence, not just a recognized "closing turn"

A session can still fail to end cleanly even with the above if the model
never produces a turn that's recognizably "the close" (no reliable
signal exists for this in the raw protocol). A robust design tracks:
not-speaking AND no-response-in-flight AND playback-fully-drained,
**continuously**, for a sustained window (any interruption resets the
window to zero, it does not merely pause) — and only then ends the
session. Pick the sustain window against the session's own
`turn_detection` values: it should be comfortably longer than
`silence_duration_ms` (a natural mid-thought pause) but end well before
`idle_timeout_ms` (the server's own point of proactively re-engaging a
silent user) — you don't want your own "wrap up now" logic and the
server's own "are you still there?" logic colliding.

Keep a hard backstop (a flat, generous time budget past the nominal
session length, not a percentage of it) regardless of all of the above —
if a user simply never stops talking, silence-driven ending alone can
defer forever, correctly, and something still has to end the session
eventually.
