// remotion.jsh -- EDL tooling for clipping interview footage into vertical
// (1080x1920) shots, running INSIDE SLICC. Subcommands: inspect, validate,
// stage, transcode.
//
// This is SLICC-native only -- there is deliberately no "render" here.
// `@remotion/webcodecs`'s `convertMedia` (used by `transcode`) is whole-file
// only, with no trim/range parameter and no compositor, so cutting to an
// EDL's segments cannot happen in-browser today (see references/findings.md
// for exactly what was tested). Actually rendering a composition to pixels
// needs `@remotion/renderer` (a real headless Chromium + native ffmpeg) --
// use the official `remotion-render` skill for that step, on whatever
// machine you normally render on. This skill's job stops at producing a
// validated EDL and a staged, render-ready asset folder.
//
// Schema this validates against (full write-up + worked example:
// references/edl-schema.md):
//
//   { fps, width, height, segments: [
//     { shot: "split", durationSec,
//       top: {src, inSec}, bottom: {src, inSec}, audioFrom?: "top"|"bottom"|"both" },
//     { shot: "portrait-interviewer"|"portrait-interviewee", durationSec,
//       source: {src, inSec} },
//     ...
//   ]}
//
// Design note: duration lives ONCE per segment, never per-track -- this is
// what keeps a split shot's top/bottom in sync (see the project template's
// SplitShot.tsx under assets/remotion-template/, same rule).
//
// Capabilities used: `require('fs')` (VFS), `@remotion/media-parser` (real
// media inspection, no ffmpeg), `@remotion/webcodecs` (whole-file transcode,
// no ffmpeg), `sliccy:cli` / `sliccy:color`.

const fs = require('fs');
const cli = require('sliccy:cli');
const color = require('sliccy:color');

const SHOT_TYPES = ['split', 'portrait-interviewer', 'portrait-interviewee'];

// ---------------------------------------------------------------------------
// media-parser helpers -- this is the part that fully replaces ffprobe.
// Verified against real footage: dimensions/codec/container come back
// instantly from the header; a headerless-duration webm (recorded live, no
// seekable index -- common for browser-recorded webcam capture) needs the
// "slow" fields, which scan the whole file and are still fast (~150ms for
// a 19MB/94s clip in testing).
// ---------------------------------------------------------------------------

let mediaParserModule = null;
function getMediaParser() {
  if (!mediaParserModule) {
    try {
      mediaParserModule = require('@remotion/media-parser');
    } catch (e) {
      throw new Error(
        `@remotion/media-parser is not installed. Run: ipk add @remotion/media-parser (${e.message})`,
      );
    }
  }
  return mediaParserModule;
}

async function inspectMedia(path) {
  const mp = getMediaParser();
  if (!(await fs.exists(path))) {
    throw new Error(`file does not exist: ${path}`);
  }
  const bytes = await fs.readFileBinary(path);
  const blob = new Blob([bytes]);
  const fast = await mp.parseMedia({
    src: blob,
    fields: {
      dimensions: true,
      durationInSeconds: true,
      fps: true,
      videoCodec: true,
      audioCodec: true,
      container: true,
      numberOfAudioChannels: true,
      sampleRate: true,
    },
    acknowledgeRemotionLicense: true,
  });

  let durationInSeconds = fast.durationInSeconds;
  let fps = fast.fps;
  let durationSource = 'fast';
  // Streamed/live-recorded webm (no duration in the header) comes back
  // null here -- fall back to the slow full-file scan, matching what a
  // native `ffmpeg -i ... -f null -` full decode would have to do anyway.
  if (durationInSeconds == null || fps == null) {
    const slow = await mp.parseMedia({
      src: new Blob([bytes]),
      fields: { slowDurationInSeconds: true, slowFps: true, slowNumberOfFrames: true },
      acknowledgeRemotionLicense: true,
    });
    if (durationInSeconds == null) {
      durationInSeconds = slow.slowDurationInSeconds;
      durationSource = 'slow';
    }
    if (fps == null) fps = slow.slowFps;
    fast.slowNumberOfFrames = slow.slowNumberOfFrames;
  }

  return {
    path,
    sizeBytes: bytes.length,
    container: fast.container,
    dimensions: fast.dimensions,
    durationInSeconds,
    durationSource,
    fps,
    videoCodec: fast.videoCodec,
    audioCodec: fast.audioCodec,
    numberOfAudioChannels: fast.numberOfAudioChannels,
    sampleRate: fast.sampleRate,
    numberOfFrames: fast.slowNumberOfFrames ?? null,
  };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

function isPlainString(v) {
  return typeof v === 'string' && v.length > 0;
}
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateSource(src, label, errors) {
  if (src == null || typeof src !== 'object') {
    errors.push(`${label}: missing source object`);
    return;
  }
  if (!isPlainString(src.src)) {
    errors.push(`${label}: missing or empty "src"`);
  }
  if (!isFiniteNumber(src.inSec) || src.inSec < 0) {
    errors.push(`${label}: "inSec" must be a number >= 0 (got ${JSON.stringify(src.inSec)})`);
  }
}

async function validateEdl(edl, opts) {
  const errors = [];
  const warnings = [];

  if (typeof edl !== 'object' || edl === null) {
    return { ok: false, errors: ['EDL root must be an object'], warnings };
  }
  for (const key of ['fps', 'width', 'height']) {
    if (!isFiniteNumber(edl[key]) || edl[key] <= 0) {
      errors.push(`root.${key} must be a positive number (got ${JSON.stringify(edl[key])})`);
    }
  }
  if (!Array.isArray(edl.segments) || edl.segments.length === 0) {
    errors.push('root.segments must be a non-empty array');
    return { ok: errors.length === 0, errors, warnings };
  }

  // Track which segments came through structural validation clean, so the
  // (optional) media pass below only touches segments it can safely read
  // fields from -- one bad segment shouldn't hide range errors in the rest.
  const structurallyOk = new Set();

  edl.segments.forEach((seg, i) => {
    const label = `segments[${i}]`;
    const before = errors.length;
    if (typeof seg !== 'object' || seg === null) {
      errors.push(`${label}: not an object`);
      return;
    }
    if (!SHOT_TYPES.includes(seg.shot)) {
      errors.push(`${label}: unknown shot "${seg.shot}" (expected one of ${SHOT_TYPES.join(', ')})`);
    }
    if (!isFiniteNumber(seg.durationSec) || seg.durationSec <= 0) {
      errors.push(`${label}: "durationSec" must be a positive number (got ${JSON.stringify(seg.durationSec)})`);
    }
    if (seg.shot === 'split') {
      if (seg.source) warnings.push(`${label}: has a stray "source" field, split shots use "top"/"bottom"`);
      validateSource(seg.top, `${label}.top`, errors);
      validateSource(seg.bottom, `${label}.bottom`, errors);
      if (seg.audioFrom && !['top', 'bottom', 'both'].includes(seg.audioFrom)) {
        errors.push(`${label}: "audioFrom" must be "top", "bottom", or "both" (got ${JSON.stringify(seg.audioFrom)})`);
      }
    } else if (SHOT_TYPES.includes(seg.shot)) {
      if (seg.top || seg.bottom) warnings.push(`${label}: has stray "top"/"bottom" fields, ${seg.shot} shots use "source"`);
      validateSource(seg.source, `${label}.source`, errors);
    }
    if (errors.length === before) structurallyOk.add(i);
  });

  // Optional pass 2: cross-check against real media, catching "in-point past
  // the end of the source" and "source file doesn't exist" -- the mistakes
  // that actually bite. Skippable (large batches / no VFS access to the
  // referenced paths) via --no-check-media. Runs on every structurally-sound
  // segment even if OTHER segments have errors.
  if (opts.checkMedia) {
    const durationCache = new Map();
    const getDuration = async (src) => {
      if (!durationCache.has(src)) {
        try {
          if (!(await fs.exists(src))) {
            durationCache.set(src, { error: 'file does not exist' });
          } else {
            const info = await inspectMedia(src);
            durationCache.set(src, { durationInSeconds: info.durationInSeconds });
          }
        } catch (e) {
          durationCache.set(src, { error: e.message });
        }
      }
      return durationCache.get(src);
    };

    for (let i = 0; i < edl.segments.length; i++) {
      if (!structurallyOk.has(i)) continue;
      const seg = edl.segments[i];
      const label = `segments[${i}]`;
      const checks =
        seg.shot === 'split'
          ? [['top', seg.top], ['bottom', seg.bottom]]
          : [['source', seg.source]];
      for (const [trackLabel, src] of checks) {
        if (!src || !isPlainString(src.src)) continue;
        const info = await getDuration(src.src);
        if (info.error) {
          errors.push(`${label}.${trackLabel}: ${info.error} (${src.src})`);
          continue;
        }
        if (info.durationInSeconds == null) {
          warnings.push(`${label}.${trackLabel}: could not determine duration of ${src.src}, skipping range check`);
          continue;
        }
        const neededEnd = src.inSec + seg.durationSec;
        // small epsilon: frame rounding, container duration fuzz
        if (neededEnd > info.durationInSeconds + 0.05) {
          errors.push(
            `${label}.${trackLabel}: inSec ${src.inSec}s + durationSec ${seg.durationSec}s = ${neededEnd.toFixed(2)}s, ` +
              `but ${src.src} is only ${info.durationInSeconds.toFixed(2)}s long`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// stage -- real copies only. Symlinks into a Remotion `public/` folder are
// silently ignored by `remotion render` (the bundler copies `public/` into
// a temp dir without dereferencing them) -- confirmed the hard way. So:
// always a real byte copy here. This is as far as this skill goes: the
// output of `stage` is exactly what a `remotion render` invocation (the
// official `remotion-render` skill, on whatever machine you render on)
// needs in its `public/assets/` -- see references/render-target.md.
// ---------------------------------------------------------------------------

function basenameOf(p) {
  const parts = p.split('/');
  return parts[parts.length - 1];
}

async function stageEdl(edl, stagingDir) {
  const assetsDir = `${stagingDir}/assets`;
  await fs.mkdir(assetsDir, { recursive: true }).catch(() => fs.mkdir(assetsDir));

  const uniqueSrcs = new Set();
  for (const seg of edl.segments) {
    if (seg.shot === 'split') {
      if (seg.top?.src) uniqueSrcs.add(seg.top.src);
      if (seg.bottom?.src) uniqueSrcs.add(seg.bottom.src);
    } else if (seg.source?.src) {
      uniqueSrcs.add(seg.source.src);
    }
  }

  const rewriteMap = new Map(); // original src -> staged relative path
  const copied = [];
  const skipped = [];
  for (const src of uniqueSrcs) {
    const base = basenameOf(src);
    const dest = `${assetsDir}/${base}`;
    if (!(await fs.exists(src))) {
      skipped.push({ src, reason: 'does not exist' });
      continue;
    }
    const bytes = await fs.readFileBinary(src);
    await fs.writeFileBinary(dest, bytes);
    rewriteMap.set(src, `assets/${base}`);
    copied.push({ src, dest, bytes: bytes.length });
  }

  const rewriteSrc = (source) =>
    source && rewriteMap.has(source.src) ? { ...source, src: rewriteMap.get(source.src) } : source;

  const stagedEdl = {
    ...edl,
    segments: edl.segments.map((seg) => {
      if (seg.shot === 'split') {
        return { ...seg, top: rewriteSrc(seg.top), bottom: rewriteSrc(seg.bottom) };
      }
      return { ...seg, source: rewriteSrc(seg.source) };
    }),
  };
  const edlOutPath = `${stagingDir}/edl.staged.json`;
  await fs.writeFile(edlOutPath, JSON.stringify(stagedEdl, null, 2));

  return { assetsDir, edlOutPath, stagedEdl, copied, skipped };
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

async function readEdl(path) {
  if (!(await fs.exists(path))) cli.die(`no such file: ${path}`);
  const text = await fs.readFile(path);
  try {
    return JSON.parse(text);
  } catch (e) {
    cli.die(`${path} is not valid JSON: ${e.message}`);
  }
}

function printIssues(label, list, colorFn) {
  if (list.length === 0) return;
  console.log(colorFn(`${label} (${list.length}):`));
  for (const item of list) console.log('  -', item);
}

async function main() {
  const { positional, flags } = process.argv.parseFlags();
  const [cmd, ...rest] = positional;

  if (!cmd || cmd === 'help' || flags.help) {
    cli.help(`remotion -- EDL tooling for clipping interview footage (runs in SLICC)

This skill is SLICC-native only: it analyses sources, validates an EDL, stages
assets, and transcodes whole files -- no external host, no ffmpeg. It does NOT
render a composition to pixels (that needs a real headless Chromium + native
ffmpeg, which this runtime does not have). For the render step itself, use the
official "remotion-render" skill on whatever machine you normally render on,
pointed at the project template in assets/remotion-template/.

Usage:
  remotion validate <edl.json> [--no-check-media]
  remotion inspect <media-file> [--json]
  remotion stage <edl.json> <staging-dir>
  remotion transcode <src> <out> [--container webm|mp4] [--video-codec ...] [--audio-codec ...]

validate  -- schema + (by default) real-media range checks (media-parser, no ffmpeg).
inspect   -- dimensions/duration/codec of one file, via @remotion/media-parser.
stage     -- copy real files (not symlinks) referenced by an EDL into <staging-dir>/assets.
transcode -- whole-file container/codec transcode via @remotion/webcodecs, fully
             inside SLICC (no external host, no ffmpeg). No trim support (see references/).
`);
    return;
  }

  if (cmd === 'validate') {
    const [edlPath] = rest;
    if (!edlPath) cli.die('usage: remotion validate <edl.json> [--no-check-media]');
    const edl = await readEdl(edlPath);
    const checkMedia = flags['check-media'] !== false && flags['no-check-media'] !== true;
    const result = await validateEdl(edl, { checkMedia });
    printIssues('errors', result.errors, color.red);
    printIssues('warnings', result.warnings, color.yellow);
    if (result.ok) {
      console.log(color.green(`✓ ${edlPath} is valid (${edl.segments.length} segments${checkMedia ? ', media checked' : ''})`));
    } else {
      process.exit(1);
    }
    return;
  }

  if (cmd === 'inspect') {
    const [mediaPath] = rest;
    if (!mediaPath) cli.die('usage: remotion inspect <media-file> [--json]');
    const info = await inspectMedia(mediaPath);
    if (flags.json) {
      cli.out(info);
    } else {
      console.log(`${mediaPath}`);
      console.log(`  container:  ${info.container}`);
      console.log(`  dimensions: ${info.dimensions ? `${info.dimensions.width}x${info.dimensions.height}` : 'unknown'}`);
      console.log(`  duration:   ${info.durationInSeconds?.toFixed(3)}s (${info.durationSource} scan)`);
      console.log(`  fps:        ${info.fps ?? 'unknown'}`);
      console.log(`  video:      ${info.videoCodec ?? 'none'}`);
      console.log(`  audio:      ${info.audioCodec ?? 'none'}${info.numberOfAudioChannels ? ` (${info.numberOfAudioChannels}ch @ ${info.sampleRate}Hz)` : ''}`);
      console.log(`  size:       ${info.sizeBytes} bytes`);
      if (info.numberOfFrames != null) console.log(`  frames:     ${info.numberOfFrames}`);
    }
    return;
  }

  if (cmd === 'stage') {
    const [edlPath, stagingDir] = rest;
    if (!edlPath || !stagingDir) cli.die('usage: remotion stage <edl.json> <staging-dir>');
    const edl = await readEdl(edlPath);
    const result = await stageEdl(edl, stagingDir);
    for (const c of result.copied) console.log(color.green('✓'), c.src, '->', c.dest, `(${c.bytes} bytes)`);
    for (const s of result.skipped) console.log(color.red('✗'), s.src, '-', s.reason);
    console.log(`staged EDL written to ${result.edlOutPath}`);
    if (result.skipped.length > 0) process.exit(1);
    return;
  }

  if (cmd === 'transcode') {
    const [src, out] = rest;
    if (!src || !out) cli.die('usage: remotion transcode <src> <out> [--container webm] [--video-codec vp8] [--audio-codec opus]');
    const wc = require('@remotion/webcodecs');
    const { bufferWriter } = require('@remotion/webcodecs/buffer');
    const mp = require('@remotion/media-parser');

    // Workaround for a confirmed upstream packaging bug in
    // @remotion/webcodecs@4.0.520: dist/log.js destructures `Log` from
    // MediaParserInternals but never assigns it to `exports.Log`, so any
    // internal `Log.verbose(...)` call throws `Cannot read properties of
    // undefined (reading 'verbose')`. Deep-requiring the submodule gives us
    // a handle to the SAME cached module object every internal file shares
    // (CJS caches by resolved path), so backfilling it here fixes every
    // call site, not just the one that happens to run first. Not a file
    // edit -- edits to ipk-installed package files are not picked up by
    // this runtime's require() (confirmed empirically; see references/).
    const logMod = require('@remotion/webcodecs/dist/log.js');
    if (!logMod.Log) logMod.Log = mp.MediaParserInternals.Log;

    const container = flags.container || 'webm';
    const videoCodec = flags['video-codec'] || (container === 'webm' ? 'vp8' : 'h264');
    const audioCodec = flags['audio-codec'] || (container === 'webm' ? 'opus' : 'aac');

    if (!(await fs.exists(src))) cli.die(`no such file: ${src}`);
    const bytes = await fs.readFileBinary(src);
    const t0 = Date.now();
    const result = await wc.convertMedia({
      src: new Blob([bytes]),
      container,
      videoCodec,
      audioCodec,
      writer: bufferWriter,
    });
    const outBlob = await result.save();
    const outBytes = new Uint8Array(await outBlob.arrayBuffer());
    await fs.writeFileBinary(out, outBytes);
    await result.remove();
    console.log(
      color.green(`✓ transcoded ${src} (${bytes.length}b) -> ${out} (${outBytes.length}b) in ${Date.now() - t0}ms`),
    );
    console.log(color.dim('(whole-file only -- no trim/range support in convertMedia, see references/)'));
    return;
  }

  cli.die(`unknown subcommand: ${cmd} (try "remotion help")`);
}

await main();
