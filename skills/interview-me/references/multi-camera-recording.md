# Multi-camera recording

The interview records **every connected camera at once**, not just the
selected one. This is automatic — there is no toggle. What you get in a
session directory:

- `human.webm` — the hero angle (the camera chosen in Setup, or the first
  available one), at up to 1080p.
- `video/angleN.webm` — one file per additional camera (`angle1`,
  `angle2`, …), at 720p.
- `agent.webm` — the interviewer's synthesized voice, audio only.
- `sync.json` — the alignment manifest (see below).

## The shared-audio model

There is exactly **one** microphone track for the whole session. It is
tapped by three consumers simultaneously without any of them starving the
others:

1. the xAI realtime voice session (the interviewer hears you),
2. the mic health watchdog, and
3. every camera recorder — the same Opus track is muxed **identically**
   into `human.webm` and each `video/angleN.webm`.

Because the muxed audio is bit-for-bit the same track in every file, the
angles are sample-accurately aligned through their audio, and the decoded
PCM is identical across files (verified at 5-minute scale). Do not try to
open a second `getUserMedia` for audio per camera — reuse the one track.

## sync.json

```jsonc
{
  "version": 1,
  "recorderStartWallMs": 0,        // wall clock when the recorders started
  "recorderStartSpreadMs": 0.08,   // spread between recorder starts (sub-ms)
  "timebase": "VideoFrame.timestamp (us), monotonic, shared across devices",
  "audio": { "shared": true, "deviceLabel": "...", "sampleRate": 48000, "channels": 1 },
  "cameras": [
    {
      "role": "main",              // "main" for the hero, "angleN" otherwise
      "file": "human.webm",
      "label": "...", "deviceId": "...",
      "requested": "1920x1080@30", "settings": "1920x1080@30",
      "firstFrameTsUs": 0,         // first decoded frame timestamp (us)
      "frames": 3501, "measuredAvgFps": 30.01,
      "openAttempts": 1,           // >1 means a zero-frame open was retried
      "bytes": 0,
      "offsetMs": 24.89            // this stream's offset vs the group start
    }
  ]
}
```

Re-cutting from multiple angles: align each `video/angleN.webm` to
`human.webm` using `offsetMs` (or the shared audio), and use
`measuredAvgFps` rather than the requested 30 — some cameras deliver
slightly under 30.

## Camera-open reliability (why every open is watchdogged)

Roughly **4% of `getUserMedia` opens return a silent zero-frame stream**:
`readyState` is `"live"`, `getSettings()` reports a plausible
`1920x1080@30`, the track looks healthy — and no frame ever arrives. No
track property distinguishes it. The only detection is to actually read a
frame (via `MediaStreamTrackProcessor`) within a short timeout. Every open
therefore goes through `openCameraWithWatchdog` (`lib/camera-open.js`),
which reads a first frame and, on timeout, closes and retries. In
practice a single retry recovers it (~2.7 s). `openAttempts` in `sync.json`
records how many tries a camera needed.

Two hard rules the recorder path depends on:

- **Never `await videoElement.play()`** in the open loop — a zero-frame
  stream makes it hang for 90 s+. Use `play().catch(() => {})`.
- **Start all recorders in one synchronous loop and arm each fps meter
  inside that loop.** Deriving a stream's offset from the frame read during
  its sequential open measures open latency instead of drift and produces
  a bogus multi-second spread.

## Budgets and fallbacks

- ~28 MB per angle-minute at 720p/900 kbps; the hero adds more at
  1080p/1.5 Mbps. A 5-minute session with five cameras is ~238 MB.
- If no camera opens, the session falls back to **audio-only** (a mic-only
  `human.webm`, no `sync.json`).
- With a single camera it writes just `human.webm` — no `video/` angles
  and no `sync.json`.

`beginSession()` never throws out of the recording path on a failed
angle: a bad camera is dropped and logged, and the interview proceeds with
whatever opened.
