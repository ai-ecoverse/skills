# Recording mechanics

The non-obvious constraints behind the panel. Each one cost a real defect.

## The recorder page must never navigate

Navigation destroys the JS context and kills `MediaRecorder` mid-take. So the panel drives a
**separate** window and never changes its own location. Screen capture is OS-level and
survives anything the recorded page does.

## One `getUserMedia` for camera + mic, then split

A second `getUserMedia` call is a second permission prompt. Request cam+mic together, then
split the tracks into separate `MediaStream`s — that is what produces independent
`cam0.webm` and `mic.webm` files an editor can re-cut against each other.

## Never detect permission state — make the request the entry point

`devices.every(d => !d.label)` is not a grant test: on macOS the built-in microphone reports
a real label *before* any grant. So the UI leads with an explicit "Allow camera & mic access"
button and reveals the pickers afterwards. A denial must still reveal them, because
"No camera" is a legal answer the user has to be able to give.

## The countdown is recorded, not awaited

Recorders start immediately; the countdown plays *inside* the recording. `countdownMs` in the
manifest is the trim-in point. This keeps the take's timeline origin identical to the
recorders' start, at the cost of a few seconds a consumer must cut away.

Countdown beeps are generated with WebAudio. An `AudioContext` created outside a user gesture
starts `suspended` and is silently mute — create or resume it inside the click handler and
check `ctx.state`. The beeps land inside the trimmed region on purpose.

## Infinity mode sets no timer

"No auto-stop" must not compute a timeout: `null * 1000` is `0`, which would stop the
recording instantly. Set no timer at all.

## Pick the mime type from the actual tracks

`MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')` returns **true even for a
video-only stream**, so a naive "first supported mime" walk records an audio codec that is
not in the file. Choose the candidate list from `stream.getAudioTracks().length`, and record
`videoTracks`/`audioTracks` counts per file so the manifest can be checked against `ffprobe`.

## WebM from MediaRecorder has no duration

MediaRecorder does not write an EBML Segment Duration (`0x4489`), so `<video>.duration` is
`Infinity`. Force a scan with `v.currentTime = 1e101`, then read the duration once
`seeked`/`durationchange` fires. (`remotion inspect` reports the same thing as
`durationSource: "slow"`.)

## Stream chunks to disk; verify before announcing success

Buffering a whole take in memory caps its length. Instead each recorder's
`ondataavailable` appends to a chunk flusher that writes numbered parts under `.parts/<name>/`
and assembles them at stop.

Two rules that protect the user's only copy:

- **Verify each assembled file's byte count with `stat` before reporting success.** A partial
  assembly must fail honestly rather than yield a silently short file.
- **On any unverified track, keep `.parts/` and name it in the manifest.** Those parts are the
  only copy of the take. Only delete them when every track verifies.

Assembly prefers a shell `cat`; a page-side fallback exists and self-reports
`degraded: true`. Both are byte-exact — verified by reassembling parts and comparing to the
original bytes.

## Trimming: never with `-c copy`

Stream copy snaps to the nearest keyframe. Measured on a real take, trimming a 5 s countdown
with `-ss 5 -c copy` produced **23.845 s** of video against **25.000 s** of audio — a 1.15 s
desync. Re-encode, or use an accurate seek (`-ss` after `-i`).

## An exit code is not evidence of effect

Three separate defects in this skill's history shared one shape: a surface reporting success
without checking it happened.

- a driver script exiting 0 having produced zero frames
- `playwright-cli resize` exiting 0 having changed nothing that matters
- a truthy session object yielding `NaN` timestamps

Read the effect back and report the truth.
