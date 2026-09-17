---
name: screen-recorder
description: Record the screen, a window, or a browser tab to WebM with synchronised microphone and webcam tracks, driven from a sprinkle panel — then hand the result to an editor. Use when the user wants a screencast, a screen recording, a demo video, a product walkthrough, a bug reproduction video, a talking-head clip, a picture-in-picture recording, or a timed screenshot. Also use for "record my screen", "capture this window", "make a screencast", "record a demo", "film this bug", "record me talking over the browser", "start recording", "take a screenshot in N seconds". Produces a timestamped capture folder with one WebM per track plus a manifest.json carrying true frame geometry, per-track durations, start skew and a trim-in point, so a downstream editor (remotion-clipper, ffmpeg) can cut without guessing. Not for editing or transcoding existing video (use ffmpeg or remotion-clipper), not for interviewing a user (use interview-me), and not for single static page screenshots (use `playwright-cli screenshot`).
allowed-tools: bash
---

# screen-recorder

Screen, window and tab recording with synchronised mic and webcam, from a sprinkle panel.

`getDisplayMedia` needs a real user gesture and a human pick in Chrome's share dialog, so **an agent cannot start a recording on its own**. This skill supplies the panel the human clicks, then hands the agent a machine-readable manifest.

## Setup (first time)

```sh
screen-recorder install     # copies the panel + built bundle into /shared/sprinkles/recording-setup/
sprinkle open recording-setup
```

`install` preserves existing captures and user configuration.

## What you get

Every take writes `/workspace/captures/<ISO-timestamp>/`:

```
screen.webm      vp9, the shared surface
cam0.webm        one file per selected camera (optional)
mic.webm         opus 48 kHz (optional)
manifest.json    geometry, durations, trim-in point, per-track stats
```

Separate files per track is deliberate — it is what lets an editor re-cut voice against picture.

## The flow

1. **Video sources** — cameras, or `No camera`. One `getUserMedia` for cam+mic, so one permission prompt.
2. **Microphone** — optional.
3. **Starting URL** — opens a target window at a chosen size, or record a tab already open.
4. **Force tab size** — the popup's `window.open` dimensions.
5. **Driver script** — an optional `sh` script that drives the page while recording.
6. **Countdown** — recorded, then trimmed via `countdownMs`.
7. **Max duration** — a ladder from 1 s to 1 h, or ∞ (no auto-stop).

Then **Open Target Window** → **Start recording** / **Take screenshot**.

On completion the panel sends a `recording-complete` lick carrying the folder and manifest; on a failed assembly it sends `recording-failed` and keeps the raw parts.

## Reading the manifest

```sh
jq '{dur:.durationMs, trim:.countdownMs, skew:.maxStartSkewMs,
     frame:"\(.capture.width)x\(.capture.height)",
     tracks:[.tracks[]|{name,file,containerDurationSec,verified}]}' \
  /workspace/captures/<stamp>/manifest.json
```

- **`capture.width/height` is the authoritative frame size** — read from the decoded stream, not from `track.getSettings()`, which reports the *display* for a window capture. `settingsWidth/Height` keeps the other value so the discrepancy stays visible.
- **`countdownMs` is a trim-in point, not a delay** — the countdown IS recorded. Cut it away.
- **Trim with an accurate seek, never `-c copy`** — stream-copy snaps to keyframes and desynchronises audio from video by over a second.
- `maxStartSkewMs` is the recorder start spread; `startOffsetMs` is each track's timeline origin.

## Handing off to an editor

```sh
ffmpeg -ss 5 -i screen.webm -i mic.webm -c:v libvpx-vp9 -c:a copy cut.webm
```

`remotion-clipper` consumes the same folder for captioned, composed output.

## Reference

- `references/recording-mechanics.md` — why the page must not navigate, one-call-then-split, streamed chunk flushing and verified assembly.
- `references/window-sizing.md` — measured behaviour of every window-sizing route, and which one preserves `devicePixelRatio`.
- `references/driver-scripts.md` — the driver contract (`REC_TAB`, `REC_DIR`, `REC_W`, `REC_H`) and why an exit code is not proof of a recording.
- `references/manifest.md` — every field, and the traps behind each.
