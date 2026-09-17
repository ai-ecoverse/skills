# `manifest.json`

Written once per take, alongside the media. The `recording-complete` lick carries the same
object. Every field below exists because guessing it went wrong at least once.

## Top level

| field | meaning |
| --- | --- |
| `version` | schema version (`1`) |
| `mode` | `video` or `screenshot` |
| `startedAtWallMs` / `startedAtISO` | wall-clock start |
| `stopReason` | `max-duration`, `user`, `error`, `track-ended` |
| `durationMs` | measured from the recorders' monotonic origin |
| `countdownMs` | **trim-in point** — the countdown was recorded; cut it away |
| `maxStartSkewMs` | spread between recorder starts (0.13–0.31 ms observed) |
| `displaySurface` | what the user actually shared, read back from the track |
| `capture` | true frame geometry — see below |
| `resize` | what a viewport resize actually did, if attempted |
| `targetWindow` | the window that was opened, if any |
| `tracks[]` | one entry per media file |
| `flusher` | per-recorder streaming stats |
| `beeps` | countdown-beep self-report |
| `unverifiedTracks` | non-null ⇒ at least one file is not provably complete |
| `partsRetained` | path to kept raw parts when assembly did not verify |
| `foregroundedTab` | whether the target window was brought to the front |

## `capture` — the only authoritative frame geometry

```json
{ "width": 2848, "height": 750, "frameRate": 30,
  "settingsWidth": 2940, "settingsHeight": 1912,
  "geometrySource": "video-metadata", "changes": [] }
```

`width`/`height` come from the decoded stream (`videoWidth`/`videoHeight`).
`settingsWidth/Height` are what `track.getSettings()` claimed — kept deliberately, because for
a window capture it reports the **display** (measured: settings said 2940×1912 while the
frames were 2848×750). `geometrySource` is `video-metadata` or, if metadata never arrived,
`track-settings` with the reason in `geometryError`. `changes[]` records mid-take resizes.

**Size a composition from `capture.width/height`.** Trusting the settings values puts a 3.8:1
video into a 1.54:1 canvas.

## `tracks[]`

```json
{ "name": "screen", "file": "screen.webm", "mime": "video/webm;codecs=vp9",
  "videoTracks": 1, "audioTracks": 0, "bytes": 2874354, "chunks": 26,
  "writtenVia": "stream-assembled", "verified": true,
  "startOffsetMs": 0, "containerDurationSec": 29.846, "kind": "video" }
```

`videoTracks`/`audioTracks` are counted from the live stream, so `mime` can be checked against
`ffprobe` — a mislabelled codec was a real bug. `verified: true` means the assembled byte
count was confirmed on disk with `stat`. `startOffsetMs` is the track's timeline origin, never
the first chunk flush. `containerDurationSec` is recovered by forcing a duration scan, since
MediaRecorder writes no EBML duration.

## `resize` and `targetWindow`

`resize.effectiveForCapture` is true **only** for a `displaySurface: "browser"` capture, where
the tab is the frame. Otherwise it records that the viewport changed while the OS window did
not, and whether `devicePixelRatio` dropped.

`targetWindow.sized` is true only when a real `window.open` handle allowed size features to
apply; the anchor fallback reports `sized: false` and `openedVia: "anchor"`.
`predictedFrame` is `outerWidth × dpr` — cross-check it against `capture.width/height`.

## Failure honesty

A take whose assembly did not verify sends **`recording-failed`**, not
`recording-complete`, names the bad tracks in `unverifiedTracks`, and keeps the raw parts at
`partsRetained`. Treat a missing `recording-complete` as "the files may be short", and never
delete a retained `.parts/` directory before recovering from it.
