# Rendering: in the browser, with `@remotion/web-renderer`

**This document previously said rendering was impossible here. That was wrong.** It is
kept as a correction rather than silently rewritten, because the reasoning that produced
the wrong answer is instructive.

## What the wrong answer was, and why it was reached

Two claims were made, both true in isolation, neither sufficient:

1. *"`@remotion/webcodecs`'s `convertMedia` is whole-file only — no time range, no
   compositor, so an in-browser render cannot cut to an EDL."* Accurate about that
   function, and still accurate today. But irrelevant: trimming and compositing are not
   `convertMedia`'s job. In Remotion they are expressed **in the composition** —
   `trimBefore`/`trimAfter` on a video layer, and ordinary CSS layout for split shots.
2. *"Rendering pixels needs `@remotion/renderer`, i.e. a headless-Chromium binary plus
   native ffmpeg, neither of which exists in SLICC."* Accurate about `@remotion/renderer`.
   But SLICC **is** a browser. Requiring a browser is a requirement SLICC already meets.

The mistake was evaluating two packages, finding both unsuitable, and concluding the
capability was absent — without checking whether a third existed. It does:

    @remotion/web-renderer   "Render videos in the browser"

It depends on `remotion` and **mediabunny** for muxing/encoding, not on ffmpeg.

## The mechanism

    renderMediaOnWeb({ composition, videoCodec, container, ... }) -> { getBlob() }
    renderStillOnWeb(...)
    canRenderMediaOnWeb(...) -> { canRender, issues[], outputTarget }
    getEncodableVideoCodecs() / getEncodableAudioCodecs()

It renders React into a canvas, so it needs a real DOM. That means it runs **in a page**,
not in a `.jsh` realm — `require('@remotion/web-renderer')` from a script fails. In SLICC:
`serve` a directory containing an `index.html`, open the http URL in a tab, and drive it.

Module resolution: the package's own `dist/esm/index.mjs` imports bare `react` /
`react-dom`, so it cannot be loaded directly from `node_modules` in a browser. Use an
importmap of pinned, `external`-ised esm.sh builds so exactly one copy of `react`,
`react-dom`, `remotion` and `mediabunny` is shared. Compositions are written with
`React.createElement` — no JSX, no bundler, no build step.

## Measured, not assumed

A 1080x1920 h264 mp4, 4.567s of output:

| | wall clock | vs realtime |
|---|---|---|
| in-browser, tab **visible** | **410 ms** | ~11x faster |
| native ffmpeg on a Mac (reference) | ~5 s | ~1x |

`canRenderMediaOnWeb` reported `canRender: true, issues: []` and resolved to
`outputTarget: "web-fs"` — output streams to OPFS, so long renders are not RAM-bound.

## Three traps

- **Tab visibility dominates everything.** The same render measured 146 ms with the tab
  visible and 17,097 ms hidden — a ~117x penalty for byte-identical output. `serve` opens
  tabs hidden, so foreground the tab before rendering or you will conclude it hung.
- **Pin codec profile AND level to the resolution.** `avc1.42E01E` is baseline *level
  3.0*; it reports `false` at 1080x1920 and `true` at 640x480. That is a level limit, not
  a missing codec — `avc1.42E034` (baseline L5.2) and `avc1.640028` (high) both encode
  1080x1920 fine, as do HEVC and AV1. A bare `isConfigSupported` failure is not evidence
  that a codec is unavailable.
- **Text can ONLY be burned in this way.** ffmpeg is not an alternative here: `drawtext`
  fails with `No font filename provided` because the wasm core ships no font, and
  supplying one from the VFS fails with `cannot open resource` since only `-i` inputs are
  staged into WORKERFS. If a clip needs captions or titles, the web renderer is the route.

## Verifying output

`remotion inspect` cannot parse VP9-in-WebM (`cannot handle the private data for VP9` — a
`@remotion/media-parser` gap, not a corrupt file). Render h264/mp4 or vp8 for anything you
intend to inspect. `remotion filmstrip <file> --frames=N` renders a contact sheet so the
output can actually be looked at rather than trusted.
