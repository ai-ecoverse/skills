# Realtime connection: ephemeral tokens and session config

## Ephemeral tokens for browser clients

Never put a long-lived API key in browser-reachable code. The pattern:

1. A trusted, non-browser context (a server, or in SLICC's case the
   worker shell reached via `slicc.exec`, which never returns the raw
   credential to page JS) mints a short-lived token:
   `POST https://api.x.ai/v1/realtime/client_secrets` with
   `{"expires_after":{"seconds":N}}`, authenticated with the real API key.
   That endpoint does **not** support a `"session"` or
   `"expires_after.anchor"` field — keep the request body to just
   `expires_after.seconds`.
2. Only the resulting ephemeral value (used once, short TTL) reaches
   client-side JS.
3. **The ephemeral token is passed as a WebSocket subprotocol, not a
   header**: `new WebSocket(url, ["xai-client-secret." + token])`. This is
   easy to get wrong if you're used to bearer-token-in-header patterns —
   there is no header-based path for this connection.

## Session config gotchas

- `audio.input.transcription.model` must be `"grok-transcribe"` — see
  `transcription-semantics.md`. Silent failure (no events, no error) if
  wrong/omitted.
- `turn_detection.silence_duration_ms` around 900ms avoids cutting a user
  off mid-thought during a natural pause; too low and the server treats a
  breath as end-of-turn.
- `turn_detection.idle_timeout_ms` (e.g. 8000) makes the server proactively
  re-engage a silent user — useful for an interviewer persona, but be
  aware of it if you're also building your own silence-based logic (e.g.
  a wind-down/end-of-session timer): pick your own thresholds with enough
  margin that your logic and the server's own idle re-engagement don't
  collide (see `steering-mid-session.md`'s wrap-up discussion for a
  concrete number chosen against this exact constraint).
- Barge-in: `input_audio_buffer.speech_started` should stop and flush any
  currently-scheduled audio playback (reset the playhead) — otherwise the
  agent keeps talking over the user who just started speaking.
- Output audio arrives as `response.audio.delta` (base64 PCM). Queue each
  chunk into a single scheduled playback graph with a running
  `playheadTime`, scheduling each buffer at
  `max(ctx.currentTime, playheadTime)` so chunks butt up seamlessly
  instead of producing audible clicks/gaps.
- Input audio: capture in an `AudioWorkletProcessor` (not the main
  thread — audio-rate processing on the main thread will glitch under any
  UI work), convert Float32 to PCM16 there, base64-encode, and send as
  `{"type":"input_audio_buffer.append","audio":"<b64>"}`.

## Things that look like they should exist but don't

`conversation.item.done` and `rate_limits.updated` are documented/implied
elsewhere but never actually emitted by this API in practice — don't
build any code path that blocks waiting for either.
