---
name: remotion-clipper
description: |
  Use this when the user wants to turn long-form interview, podcast, or talking-head
  recordings into short vertical (1080x1920) clips for TikTok/Reels/Shorts: cutting to
  word-exact boundaries, removing filler words and dead air, and laying out interviewer
  + interviewee footage as split-screen or full-frame portrait shots with Remotion.
  Covers three shot types (`split`, `portrait-interviewer`, `portrait-interviewee`),
  an EDL (edit decision list) JSON schema handing cut points from transcription to
  render, and the `remotion` CLI: `inspect` / `validate` / `stage` / `transcode` /
  `render` (in-browser, via `@remotion/web-renderer`). Triggers on "clip this
  interview", "cut this into TikToks", "vertical video edit", "split-screen interview",
  "EDL", "crop to 9:16", "talking-head video export". Also load this to inspect a
  video/audio file's dimensions, duration, or codec WITHOUT ffmpeg
  (`@remotion/media-parser` does it natively in SLICC).
allowed-tools: bash
---

# remotion-clipper

Cuts long interview footage into short vertical clips using three fixed shot layouts,
driven by a small JSON EDL (edit decision list). This skill is **SLICC-native only**:
every subcommand runs entirely in-browser, no external host, no ffmpeg.

- `remotion inspect` — dimensions/duration/codec of a file, via `@remotion/media-parser`.
- `remotion validate` — EDL schema checks + real in-point/duration cross-checks against
  the actual media.
- `remotion stage` — real byte copies (never symlinks) of every source an EDL
  references, laid out the way a Remotion project's `public/assets/` expects.
- `remotion transcode` — whole-file container/codec transcode via `@remotion/webcodecs`.

## Setup (one time)

```bash
cd /workspace/skills/remotion-clipper   # wherever this skill landed
ipk install                              # reads package.json, installs @remotion/media-parser + @remotion/webcodecs
```

Module resolution for `.jsh` scripts walks up from the script's own directory, not the
shell's cwd — install from inside this skill's directory (or run `ipk install` with no
args from here), not from wherever you happen to be when you first use it.

## Quick start

```bash
remotion inspect footage.webm --json          # dimensions/duration/codec, no ffmpeg
remotion validate edl.json                     # schema + real in-point/duration checks
remotion stage edl.json /tmp/staged            # real copies (not symlinks) of every source
remotion transcode footage.mp4 out.webm        # whole-file transcode, no external host
```

## Rendering — in the browser

Render with **`@remotion/web-renderer`**. It renders a Remotion composition to canvas
and encodes with mediabunny, so it needs a browser but NOT a headless-Chromium binary and
NOT native ffmpeg. Measured here: a 1080x1920 h264 mp4 in **410ms** for 4.6s of synthetic
output, and a real 7-segment cut with two video sources in **50s** for 29.9s of output
(decode-bound, so real footage runs slower than realtime; do not quote the synthetic
figure for real work).

It needs a real DOM, so it runs in a served page rather than in a `.jsh` realm —
`require('@remotion/web-renderer')` from a script fails. Load the package through an
importmap of pinned, `external`-ised esm.sh builds so exactly one copy of `react`,
`react-dom`, `remotion` and `mediabunny` is shared; the package's own
`dist/esm/index.mjs` imports bare `react` and cannot be loaded from `node_modules`
in a browser. Compositions use `React.createElement` — no JSX, no build step.

Trimming and compositing live in the **composition** (`trimBefore`/`trimAfter` and
ordinary CSS layout), not in `@remotion/webcodecs`. `convertMedia` is whole-file only
with no time range, which is why it cannot serve as a renderer — but that was never the
right layer for a cut.

Three traps worth knowing before you spend an hour on them:

- **A hidden tab is ~117x slower and will not load media at all.** The same render
  measured 146ms visible and 17097ms hidden, with byte-identical output, and a
  `<video>` in a background tab sits at `readyState 0` forever. Foreground the tab
  before rendering.
- **Pin codec profile AND level to the resolution.** `avc1.42E01E` is baseline level
  3.0: `true` at 640x480, `false` at 1080x1920. That is a level limit, not a missing
  codec — `avc1.42E034` and `avc1.640028` both encode 1080x1920. A bare
  `isConfigSupported` failure is not evidence a codec is unavailable.
- **Text can only be burned in this way.** ffmpeg is not an alternative: `drawtext`
  fails with `No font filename provided` because the wasm core ships no font, and
  supplying one from the VFS fails with `cannot open resource`.

`references/render-target.md` documents the reasoning, including the earlier wrong
conclusion that rendering was impossible here and why it was reached.

## The EDL schema

Full write-up + worked example: `references/edl-schema.md`. In short:

```json
{
  "fps": 30, "width": 1080, "height": 1920,
  "segments": [
    { "shot": "portrait-interviewer", "durationSec": 4.6,
      "source": { "src": "/path/to/interviewer-clip.mp4", "inSec": 0 } },
    { "shot": "portrait-interviewee", "durationSec": 2.35,
      "source": { "src": "/path/to/interviewee-footage.webm", "inSec": 12.25 } },
    { "shot": "split", "durationSec": 3.85,
      "top":    { "src": "/path/to/interviewer-clip.mp4", "inSec": 0 },
      "bottom": { "src": "/path/to/interviewee-footage.webm", "inSec": 76.15 },
      "audioFrom": "bottom" }
  ]
}
```

Duration lives ONCE per segment, never per-track — this is what keeps a `split`
shot's two tracks in sync by construction. `audioFrom` (split only) documents intent
but is not yet wired into the template's render logic (see `references/findings.md`).

## Subcommands

| Command | What it does |
|---|---|
| `remotion inspect <file> [--json]` | dimensions/duration/codec via `@remotion/media-parser` — no ffmpeg |
| `remotion validate <edl.json> [--no-check-media]` | schema checks + (default) real in-point/duration cross-checks |
| `remotion stage <edl.json> <dir>` | real byte copies of every referenced source into `<dir>/assets`, plus a rewritten EDL |
| `remotion transcode <src> <out> [--container webm\|mp4]` | whole-file container/codec transcode via `@remotion/webcodecs`, fully in-browser |

## The project template

`assets/remotion-template/` is a complete, tested `src/` for the three shot types
(`Root.tsx`, `SplitShot.tsx`, `PortraitShot.tsx`, `CenterCropVideo.tsx`, `types.ts`,
`index.ts`, `index.css`) plus a `package.json` pinned to the versions this was built
and rendered against (Remotion 4.0.520), a minimal `remotion.config.ts`, and
`tsconfig.json`. To use it (with the official `remotion-render` skill, on a machine
that has it):

```bash
npx create-video@latest --yes --blank my-clipper
cd my-clipper
# copy assets/remotion-template/src/* over the scaffolded src/, and merge the
# package.json dependency versions if you want the exact tested pins
npm i
npx remotion studio    # preview split / portrait-interviewer / portrait-interviewee
```

Cropping is `object-fit: cover` on an `OffthreadVideo` inside a fixed-size box —
mathematically identical to "center-crop to target aspect, then scale" — no manual
crop math anywhere. `stage`'s output (`<dir>/assets/*` plus a rewritten EDL) is
exactly what that project's `public/assets/` needs, and each staged source's rewritten
`src` plus the segment's `inSec`/`durationSec` map directly onto the template's props
shape (`{durationInSeconds, source: {src, inSec}}` or `{..., top, bottom}` for split).

## Known limitations (read before promising more than this does)

- **No render, on purpose** — see "Rendering" above.
- **No trim/composite without a full render host.** `@remotion/webcodecs`'s
  `convertMedia` (used by `remotion transcode`) is whole-file only.
- **Symlinked assets in a Remotion project's `public/` break `remotion render`**
  silently (Studio preview works fine). `stage` always makes real copies for this
  reason.
- Full findings, including exact verified numbers from testing
  `@remotion/media-parser` and `@remotion/webcodecs` live: `references/findings.md`.
