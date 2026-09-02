---
name: remotion-clipper
description: |
  Use this when the user wants to turn long-form interview, podcast, or talking-head
  recordings into short vertical (1080x1920) clips for TikTok/Reels/Shorts — cutting to
  word-exact boundaries, removing filler words and dead air, and laying out interviewer
  + interviewee footage as split-screen or full-frame portrait shots with Remotion.
  Covers three shot types (`split` — interviewer top / interviewee bottom;
  `portrait-interviewer`; `portrait-interviewee`), an EDL (edit decision list) JSON
  schema that hands cut points from a transcription/analysis step to the render step,
  and the `remotion` CLI (`.jsh`, this skill's `scripts/remotion.jsh`):
  `inspect` / `validate` / `stage` / `transcode`. Triggers on "clip this interview",
  "cut this into TikToks", "vertical video edit", "split-screen interview", "EDL",
  "crop to 9:16", "talking-head video export", "center-crop this video". Also load
  this when the user asks to inspect a video/audio file's dimensions, duration, or
  codec WITHOUT ffmpeg (`@remotion/media-parser` does this natively in SLICC) — see
  below before reaching for wasm ffmpeg. IMPORTANT: this skill does NOT render a
  composition to pixels — read "Rendering" before implying it can produce a finished
  video by itself; for the actual render step, use the official `remotion-render`
  skill on whatever machine you normally render on.
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

## Rendering — deliberately out of scope, and why

This skill does not shell out to another machine to render a composition, and does
not attempt an in-browser render pipeline either. Two reasons, both real constraints,
not policy:

1. **In-browser render genuinely can't cut to an EDL yet.** `@remotion/webcodecs`'s
   `convertMedia` (used by `transcode`) is whole-file only — no time-range parameter,
   no compositor. It cannot select a sub-range of frames or lay two sources into
   split top/bottom halves. That's buildable directly on `VideoDecoder`/
   `VideoEncoder`/`OffscreenCanvas` (all proven functional inside a `.jsh`'s worker —
   see `references/findings.md`), but it's a real feature to write, not something
   this skill should paper over with a partial implementation.
2. **Actually rendering pixels needs `@remotion/renderer`** — a real headless-Chromium
   binary plus native ffmpeg, neither of which exists in SLICC. Any render has to
   happen on a real host. An earlier version of this skill shelled out over `ssh` to
   a specific machine to do that; it was removed on review, because it baked one
   person's tray-follower id and home directory into a "skill" that was really just
   "ssh to my other computer," and because it papered over gap (1) with a workaround
   that becomes dead weight the moment either gap closes. A skill that clearly does
   not render is more useful than one that half-renders.

**For the render step**, use the official `remotion-render` skill (already installed
alongside this one under `/workspace/skills/`) on whatever machine you normally
render on, pointed at `assets/remotion-template/` (below) and a `remotion stage`d
asset folder.

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
