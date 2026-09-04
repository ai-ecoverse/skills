# Findings from building and testing this skill

Written as findings, not narrative. Everything here was verified live against real
footage during development, not assumed.

Note on scope: the first four sections below describe what `inspect`/`validate`/
`stage`/`transcode` actually do and don't do -- read those first. The last three
sections (`--help` on the Remotion CLI, `ssh` stdin, the `serve` retry trap) were
learned while building, and then removing, an early version of this skill that shelled
out over `ssh` to render on one specific machine. That path is gone for two separate
reasons: it baked one person's tray-follower id and home directory into a portable
skill, AND it turned out to be unnecessary -- rendering works in-browser via
`@remotion/web-renderer` (see `SKILL.md`'s "Rendering" section and
`render-target.md`). The three `ssh`-adjacent findings are kept because they are
true, general platform facts, but none of them describe code that ships today.

## `@remotion/media-parser` fully replaces ffprobe for inspection

No native dependency, works entirely in-browser (a `.jsh`'s DedicatedWorker). Pattern:

```js
const bytes = await fs.readFileBinary(path);       // VFS read, Uint8Array
const blob = new Blob([bytes]);                     // pass a Blob, not the bare path
const result = await parseMedia({
  src: blob,
  fields: { dimensions: true, durationInSeconds: true, /* ... */ },
  acknowledgeRemotionLicense: true,
});
```

Passing a `Blob` makes it use the pure-Web `webReader` internally (no
`fs.createReadStream`, which this runtime's `require('fs')` VFS bridge does not
provide -- the package's `/node` reader export would throw here; don't use it).

**Verified against a real 1920x1080, 93.9s, vp9/opus webcam recording** (a live
browser recording with no seekable duration in its header -- a common shape for
webcam capture, not an edge case): the fast fields (`durationInSeconds`, `fps`) came
back `null`, exactly matching what `ffprobe -show_entries format=duration` also
reports for this file (`N/A`). The `slow*` fields (`slowDurationInSeconds`, `slowFps`,
`slowNumberOfFrames`) did a full scan and returned **93.879s, fps 50.0005, 4695
frames** -- an EXACT match to what `ffmpeg -f null -`'s full decode reports on a
native host, in about 150ms for the 19MB file. `remotion inspect` surfaces this as
`durationSource: "fast"` or `"slow"` so you know which path answered.

**Source fps matters for EDL math.** The sample interview footage referenced above
is 50fps; a Remotion composition's `fps` (used for `trimBefore`/`trimAfter` frame
math) is independent and commonly 30. `inSec` is always in seconds in this EDL
precisely to avoid mixing the two frame rates -- never assume the EDL's `fps` field
equals any source's native frame rate.

## WebCodecs works fully inside a `.jsh`'s DedicatedWorker -- not just in a page

This was the open question going in: would `VideoEncoder`/`VideoDecoder`/
`AudioEncoder`/`AudioDecoder`/`VideoFrame`/`OffscreenCanvas` need a real browser tab,
or work in the worker a `.jsh` runs in? They work in the worker. Verified with a
from-scratch round-trip using nothing but browser primitives (no Remotion packages):
filled an `OffscreenCanvas` red, VP8-encoded a real `VideoFrame` (the output starts
with VP8's genuine `9d 01 2a` bitstream start-code -- not a mock/stub), VP8-decoded it
back, read the pixel off a canvas: `(200,30,30)` in -> `(201,30,30)` out (lossy, as
expected of a real codec, not an identity no-op).

`isConfigSupported` inside the worker reports vp8/vp9/opus encode+decode as
supported, and (noted for anyone reconciling against an earlier page-context probe
that found H.264 encode unsupported there) **`avc1.42E01E` reports supported here for
both encode and decode**. Not reconciled further -- if H.264-in-SLICC ever matters,
re-verify live rather than trusting either probe blind.

## `@remotion/webcodecs`'s `convertMedia` does real whole-file transcodes -- but no trim, no composite

Verified round-trip on real footage: an h264/aac mp4 (612817 bytes) -> vp8/opus webm
(372726 bytes) in about 400ms, and the OUTPUT was re-parsed with `media-parser` to
confirm it decodes to the right dimensions/duration/frame count (not just "a file got
written").

**But it has no trim/range parameter and no compositor.** `onVideoFrame`/
`onAudioData` hooks exist, but the package hard-validates that whatever you return has
identical `displayWidth`/`displayHeight`/`timestamp`/`duration` to the input frame --
they're for pixel filters (color grading, watermarks), not frame selection. So:

- **"cut" (pick a sub-range of frames)** is not available for free.
- **"composite" (lay source A into the top half, source B into the bottom half)** is
  not available for free either -- there's no equivalent of Remotion's
  `<Composition>` layout inside this package.

Both are buildable directly on the (proven-working) primitives above -- decode with
sample-range filtering, draw into an `OffscreenCanvas`, re-encode, mux.

**CORRECTION: none of that needs writing, and the conclusion originally drawn here was
wrong.** This section used to end by saying that nothing in-browser does frame-range
selection or multi-source layout, and that rendering therefore needs
`@remotion/renderer` (headless Chromium + native ffmpeg) on a real host. Both halves
were mistaken:

- Frame-range selection and multi-source layout are the **composition's** job
  (`trimBefore`/`trimAfter` plus CSS), not `convertMedia`'s. `convertMedia`
  being whole-file only is true and irrelevant.
- `@remotion/renderer` is not the only renderer. **`@remotion/web-renderer`** renders
  a composition in the browser and encodes via mediabunny. Verified end to end: a real
  7-segment 1080x1920 h264+aac cut with two video sources, a split shot and word-level
  captions, rendered entirely in-browser.

The reasoning error is worth naming because it is easy to repeat: two packages were
evaluated, both were correctly ruled out, and absence of the capability was inferred
without checking whether a third package provided it. `references/render-target.md`
has the mechanism and the measured numbers.

## A confirmed upstream packaging bug in `@remotion/webcodecs@4.0.520`

`dist/log.js`'s CJS build does:

```js
exports.Log = void 0;
const { Log } = MediaParserInternals;
// (never assigns exports.Log = Log)
```

So any internal `Log.verbose(...)` call throws `Cannot read properties of undefined
(reading 'verbose')` -- which is most of the package (`autoSelectWriter`,
`reencode-video-track.js`, etc). Confirmed this is in the real published npm tarball
for that exact version (fetched and diffed directly, not an install-tool artifact).

**Workaround** (already in `scripts/remotion.jsh`'s `transcode` subcommand, no file
edits needed):

```js
const logMod = require('@remotion/webcodecs/dist/log.js');
if (!logMod.Log) logMod.Log = require('@remotion/media-parser').MediaParserInternals.Log;
```

Works because CJS caches modules by resolved path -- every internal file's own
`require('./log')` sees the SAME object we just mutated. If a future
`@remotion/webcodecs` release fixes this upstream, the `if (!logMod.Log)` guard makes
the workaround a no-op rather than something that needs removing.

**Related gotcha**: editing an installed package's files on disk directly does NOT
change what a later `require()` executes in this runtime -- confirmed by editing
`dist/log.js` with the real fix AND a visible `console.log` marker, neither of which
had any effect on a subsequent run. Packages appear to be resolved/bundled by
identity (name + version), not by re-reading the literal files each require. The
in-memory monkeypatch above is the only workaround that actually works here.

## `--help` is not a safe probe on the Remotion CLI

Relevant to whatever host you render on, not to this skill directly (see the scope
note above). On a native render host: `npx remotion studio --help` is not recognized as a real
flag by that CLI's parser -- it silently starts Studio for real (default port 3000)
and, worse, calls the OS `open` to launch an actual GUI browser window on whoever's
desktop is running that host. `npx remotion render --help` similarly isn't
recognized -- it downloads `chrome-headless-shell` (~90MB) and then, with no
composition id given, drops into an **interactive arrow-key composition picker on the
TTY**, which just hangs forever over a non-interactive `ssh` call. Always pass real
arguments (a real composition id for `render`); never use `--help` as a probe on this
CLI.

## `ssh` to a tray follower does not forward stdin

From the removed render path (see scope note above) -- kept as a general SLICC fact,
not something `scripts/remotion.jsh` does. Piping into `ssh <target> "cmd"`
(heredocs, `< file`) is silently swallowed -- the
remote command sees EOF immediately, not your input. To push file content, either
base64-encode it and embed the payload directly in the command string (small files),
or use `serve --entry <file> <dir>` to mint a public preview URL and have the far
side `curl` it directly (larger files) -- see the next finding for the trap in that
second approach.

## The `serve` first-visit-latency trap

From the removed render path (see scope note above) -- kept as a general SLICC fact
for anyone scripting `serve` + a remote `curl` to move files to another host, which
`scripts/remotion.jsh` does not do. A naive retry loop that re-mints a NEW
`serve --entry` preview token on every attempt will retry the SAME failure forever
and can silently corrupt a push. A brand-new `serve` token has a real first-visit
warm-up delay: a freshly-minted URL for a multi-megabyte file returned a truncated
error body (a handful of bytes) on the first `curl`, then served the complete file
correctly on a later hit of the exact same URL. Re-minting a new token on every retry
re-triggers that same delay every time, so it never converges -- and because
`curl -o` exits 0 even when it "successfully" downloaded an error page, this failure
is silent unless you verify the downloaded byte count. This cost a real file
corruption during development to discover: mint the URL ONCE and retry the curl
against that one URL with a size check, never re-mint per retry.

## Symlinks in a Remotion project's `public/` silently break `remotion render`

Studio preview follows a symlinked asset in `public/` fine. `remotion render` does
not: the bundler copies `public/` into a temp directory without dereferencing
symlinks, so the render fails partway through with 404s for files that clearly exist
in the source tree. `remotion stage` always makes real byte copies for exactly this
reason -- don't "optimize" it into a symlink to save space.
