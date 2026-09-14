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
  "EDL", ".mp4", ".webm", "crop to 9:16", "talking-head video export". Also load
  this to inspect a video/audio file's dimensions, duration, or codec WITHOUT
  ffmpeg (`@remotion/media-parser` does it natively in SLICC).
allowed-tools: bash
---

# remotion-clipper

Cuts long interview footage into short vertical clips using three fixed shot layouts,
driven by a small JSON EDL (edit decision list). This skill is **SLICC-native only**:
every subcommand runs entirely in-browser, no external host, no ffmpeg.

- `remotion inspect` — dimensions/duration/codec of a file, via `@remotion/media-parser`.
- `remotion validate` — EDL schema checks + real in-point/duration cross-checks against
  the actual media.
- `remotion stage` — copies every source an EDL references into the layout a
  Remotion project's `public/assets/` expects.
- `remotion transcode` — whole-file container/codec transcode via `@remotion/webcodecs`.
- `remotion render` — in-browser encode via `@remotion/web-renderer`.
- `remotion filmstrip` — contact sheet of sampled frames, so output can be looked at.

## Setup (one time)

```bash
cd /workspace/skills/remotion-clipper   # wherever this skill landed
ipk install                              # reads package.json, installs @remotion/media-parser + @remotion/webcodecs
```

Module resolution for `.jsh` scripts walks up from the script's own directory, not the
shell's cwd — install from inside this skill's directory (or run `ipk install` with no
args from here), not from wherever you happen to be when you first use it.

## End-to-end workflow

1. **Inspect** the source: `remotion inspect footage.webm --json` — dimensions,
   duration, codec.
2. **Author** the EDL JSON (schema below).
3. **Validate**: `remotion validate edl.json`. If validate fails, fix the EDL and
   re-run validate until it passes. Do not stage or render a failing EDL.
4. **Stage**: `remotion stage edl.json /tmp/staged` — copies every referenced
   source, plus a rewritten EDL at `/tmp/staged/edl.staged.json`.
5. **Render**: `remotion render edl.json /tmp/out` — writes `/tmp/out/edl.mp4` by
   default. See **Known limitations**.
6. **Filmstrip**: `remotion filmstrip /tmp/out/edl.mp4 --frames=6 --width=160` —
   look at the result rather than trusting it.

Optional, if inspect shows a container/codec you need to convert:
`remotion transcode footage.mp4 out.webm` (see **Known limitations**).

## Rendering — in the browser

Render with **`@remotion/web-renderer`**. It renders a Remotion composition to canvas
and encodes with mediabunny, so it needs a browser but NOT a headless-Chromium binary and
NOT native ffmpeg.

It needs a real DOM, so it runs in a served page rather than in a `.jsh` realm —
`require('@remotion/web-renderer')` from a script fails. Load the package through
an importmap of pinned, `external`-ised esm.sh builds so exactly one copy of
`react`, `react-dom`, `remotion` and `mediabunny` is shared — `render` copies
`assets/remotion-harness/` (working importmap included); do not load
`dist/esm/index.mjs` from `node_modules` in a browser (it imports bare `react`).
Compositions use `React.createElement` — no JSX, no build step.

Trimming and compositing live in the **composition** (`trimBefore`/`trimAfter` and
ordinary CSS layout), not in `@remotion/webcodecs`. See **Known limitations** for
background-tab slowdown, `convertMedia` whole-file-only, and the synthetic 410ms figure.

Two traps worth knowing before you spend an hour on them:

- **Pin codec profile AND level to the resolution.** `avc1.42E01E` is baseline level
  3.0: `true` at 640x480, `false` at 1080x1920. That is a level limit, not a missing
  codec — `avc1.42E034` and `avc1.640028` both encode 1080x1920. A bare
  `isConfigSupported` failure is not evidence a codec is unavailable.
- **Text can only be burned in this way.** ffmpeg is not an alternative: `drawtext`
  fails with `No font filename provided` because the wasm core ships no font, and
  supplying one from the VFS fails with `cannot open resource`.

`references/render-target.md` documents the mechanism and measured numbers.

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
| `remotion stage <edl.json> <dir>` | copies every referenced source into `<dir>/assets`, plus a rewritten EDL |
| `remotion transcode <src> <out> [--container webm\|mp4]` | whole-file container/codec transcode via `@remotion/webcodecs`, fully in-browser |
| `remotion render <edl.json> <dir> [--index N] [--out <path>]` | renders the EDL to an mp4 in the browser via `@remotion/web-renderer`. Whole EDL by default; `--index N` for one segment |
| `remotion filmstrip <file> [--frames=N] [--width=N]` | contact sheet of evenly-sampled frames, so output can be LOOKED at rather than trusted |

## The project template

`assets/remotion-template/` is a complete, tested `src/` for the three shot types
(`Root.tsx`, `SplitShot.tsx`, `PortraitShot.tsx`, `CenterCropVideo.tsx`, `types.ts`,
`index.ts`, `index.css`) plus a `package.json` pinned to the versions this was built
and rendered against (Remotion 4.0.520), a minimal `remotion.config.ts`, and
`tsconfig.json`. `render` does not need this template — it generates its own harness. The template is
for when you want a Remotion Studio preview, or to render with the official
`remotion-render` skill on a machine that has the Remotion CLI:

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

- **A background tab is ~117x slower and will not load media at all.** The same render
  measured 146ms visible and 17097ms hidden, with byte-identical output, and a
  `<video>` in a background tab sits at `readyState 0` forever. Foreground the tab
  before rendering. `render` foregrounds its tab; if something else steals focus
  mid-render, the render still completes but takes far longer.
- **`convertMedia` cannot trim / is whole-file only.** It has no time range, so it
  cannot serve as a renderer. `remotion transcode` is whole-file only. Cutting belongs
  to the composition (`trimBefore`/`trimAfter`), which is what `render` uses.
- **The synthetic 410ms figure is not representative of real work.** A 1080x1920 h264
  mp4 of 4.6s synthetic output (text on a background) rendered in 410ms (~11x faster
  than realtime). Real footage is decode-bound and slower than realtime: 50s for a
  29.9s output of a 7-segment cut with two video sources. Do not quote 410ms for real
  footage.
- **Sources over ~25 MiB cannot be served directly**, so `render` splits them into
  ~8 MiB parts and reassembles them in-page. Upstream: `ai-ecoverse/slicc#2852`.
- **Symlinked assets in a Remotion project's `public/` break `remotion render`**
  silently (Studio preview works fine). `stage` always makes real copies for this
  reason.
- Full findings, including exact verified numbers from testing
  `@remotion/media-parser` and `@remotion/webcodecs` live: `references/findings.md`.
