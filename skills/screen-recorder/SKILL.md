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
3. **Starting URL** — opened as its own window at the size below.
4. **Target Window Size** — the capture window's **frame** size in DIP pixels, chrome included.
   Chrome enforces a **500 px minimum width** and clamps height to `screen.availHeight`, both
   silently; the panel greys out presets it cannot deliver and reports what was actually achieved.
5. **Driver script** — an optional `sh` script that drives the page while recording.
6. **Countdown** — recorded, then trimmed via `countdownMs`.
7. **Max duration** — a ladder from 1 s to 1 h, or ∞ (no auto-stop).

Then **Open Target Window** → **Start recording** / **Take screenshot**.

## Opening the capture window from an agent

On **SLICC 6.169.0+** use the `sliccy:browser` window verbs — no click needed, and this is the
only route that yields a **decorated** window (title bar and URL bar) at an exact size:

```js
const browser = require('sliccy:browser');
const tab = await browser.openWindow('https://example.com',
  { width: 900, height: 600, left: 50, top: 50, decorated: true });

const b = await browser.windowBounds(tab);       // {left,top,width,height,state,dpr}
const frame = { w: b.width * b.dpr, h: b.height * b.dpr };   // capture resolution
```

Three rules, each measured rather than assumed:

- **`width`/`height` are FRAME pixels, chrome included** — requesting height 600 gave
  `outerHeight` 600 and `innerHeight` 513 (87px of chrome). `window.open` sizes the **content
  area** instead, so the two are not interchangeable at the same numbers.
- **Read bounds back; requests are clamped silently.** `setWindowBounds(tab, {height:1080})`
  returned an achieved height of **841** with `top` moved to 33, and nothing threw. The return
  value is authoritative.
- **The usable ceiling is `screen.availHeight` (841 here), not `screen.height` (956)** —
  discover it at runtime; those are one machine's numbers.

The returned `TabHandle` works with every other verb (`eval`, `fetch`, `cookie`, …), so it is a
drop-in for `findTab`/`ensureTab`.

**Before 6.169.0** there was no window API, so the panel's `window.open` popup is the fallback —
popup chrome only, and it cannot produce a decorated window. See `references/window-sizing.md`.

On completion the panel sends a `recording-complete` lick carrying the folder and manifest; on a failed assembly it sends `recording-failed` and keeps the raw parts.

## Driving it from the command line

`screen-recorder` (a `.jsh` companion) prefills the panel and reads takes back, so the only
human steps are the two buttons — `getDisplayMedia` needs a real user gesture, so starting a
recording cannot be automated.

```bash
screen-recorder config set startUrl=https://example.com/ width=1280 height=800 maxDurationSec=30
screen-recorder config get                 # what the panel will prefill with
screen-recorder open                       # open the panel
# → human clicks Open Target Window, then Start recording
screen-recorder manifest                   # summarise the newest take
screen-recorder manifest <folder> --json   # the raw manifest
screen-recorder captures                   # every take, newest last
```

Config lands in `/shared/sprinkles/recording-setup/config.json` and an already-open panel picks
it up live (`sprinkle send … reloadconfig`). Values are validated before they reach the UI: a
width below 500 warns, a non-integer or non-http URL is refused. `manifest` leads with
`capture.width/height` — the only authoritative frame size — and flags a `predictedFrame` that
disagrees with it, plus any failed part or dropped chunk.

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
- `references/window-sizing.md` — the `sliccy:browser` window API (frame units, silent clamping, `availHeight`), plus the pre-6.169.0 fallback routes and why most of them fail.
- `references/driver-scripts.md` — the driver contract (`REC_TAB`, `REC_DIR`, `REC_W`, `REC_H`) and why an exit code is not proof of a recording.
- `references/manifest.md` — every field, and the traps behind each.
- `scripts/screen-recorder.jsh` — the companion CLI (`config get/set/clear/keys`, `open`,
  `captures`, `manifest`).
