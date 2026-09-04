// remotion.jsh -- EDL tooling for the interview-clipping pipeline, running
// INSIDE SLICC. Subcommands: validate, inspect, stage, render, transcode.
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
// what keeps a split shot's top/bottom in sync (SplitShot in
// remotion-harness/composition.mjs follows the same rule).
//
// HISTORY (2026-09-04): `render` used to shell out over ssh to a Mac tray
// follower running a checked-out Remotion project, because in-browser
// rendering was believed impossible. It is not: @remotion/web-renderer
// renders a composition in a Chrome tab and muxes with mediabunny. That ssh
// machinery (runtime id, project path, asset push, base64 pull-back) is
// DELETED -- nothing in this file talks to another machine any more.
//
// Capabilities used: `require('fs')` (VFS), `@remotion/media-parser`
// (real media inspection, no ffmpeg), `sliccy:exec` (serve / playwright-cli /
// ffmpeg), `sliccy:skill` (harness dir), `sliccy:cli` / `sliccy:color`.

const fs = require('fs');
const cli = require('sliccy:cli');
const color = require('sliccy:color');

const SHOT_TYPES = ['split', 'portrait-interviewer', 'portrait-interviewee'];

// ---------------------------------------------------------------------------
// media-parser helpers -- this is the part that fully replaces ffprobe.
// Proven live against real assets (see report): dimensions/codec/container
// come back instantly from the header; a headerless-duration webm (recorded
// live, no seekable index) needs the "slow" fields, which scan the whole
// file and are still fast (~150ms for a 19MB/94s clip).
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

// Paths in an EDL may be absolute (/shared/...) or relative. Relative ones are
// resolved against the DIRECTORY OF THE EDL, not the cwd -- that is what makes
// an EDL plus a sibling assets/ folder portable, and it means a staged EDL
// (whose srcs are rewritten to "assets/<file>") can be re-staged or rendered
// straight out of its own staging dir.
function isAbsolute(p) {
  return typeof p === 'string' && p.startsWith('/');
}
function dirnameOf(p) {
  const abs = isAbsolute(p) ? p : `${process.cwd()}/${p}`;
  const i = abs.lastIndexOf('/');
  return i <= 0 ? '/' : abs.slice(0, i);
}
function resolveFrom(baseDir, p) {
  if (!isPlainString(p)) return p;
  return isAbsolute(p) ? p : `${baseDir}/${p}`;
}

// Where a relative "src" is looked for, in order: next to the EDL, then in the
// EDL's assets/ folder. The second candidate is not a guess -- `stage` writes
// assets/<file> and rewrites the EDL to match, so an EDL that ships bare
// filenames alongside a staged assets/ dir (the shape of
// a staged EDL) resolves without editing it.
function searchDirsFor(baseDir, extra) {
  const dirs = [];
  if (isPlainString(extra)) dirs.push(resolveFrom(process.cwd(), extra).replace(/\/+$/, ''));
  dirs.push(baseDir, `${baseDir}/assets`);
  return dirs;
}
async function locateSrc(src, searchDirs) {
  if (!isPlainString(src)) return null;
  if (isAbsolute(src)) return (await fs.exists(src)) ? src : null;
  for (const d of searchDirs) {
    const cand = `${d}/${src}`;
    if (await fs.exists(cand)) return cand;
  }
  return null;
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
  // that actually bite, per the brief. Skippable (large batches / no VFS
  // access to the referenced paths) via --no-check-media. Runs on every
  // structurally-sound segment even if OTHER segments have errors.
  if (opts.checkMedia) {
    const durationCache = new Map();
    const searchDirs = opts.searchDirs || searchDirsFor(opts.baseDir || process.cwd());
    const getDuration = async (src) => {
      if (!durationCache.has(src)) {
        try {
          const abs = await locateSrc(src, searchDirs);
          if (!abs) {
            durationCache.set(src, { error: 'file does not exist' });
          } else {
            const info = await inspectMedia(abs);
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
// stage -- real copies only. Historical reason (from the deleted ssh path): a
// symlink into a Remotion `public/` folder is silently ignored by the bundler.
// Current reason: the browser harness fetches these bytes over `serve`, which
// has no notion of a symlink either. So: always a real byte copy here.
// ---------------------------------------------------------------------------

function basenameOf(p) {
  const parts = p.split('/');
  return parts[parts.length - 1];
}

async function stageEdl(edl, stagingDir, searchDirs = [process.cwd()]) {
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
    const abs = await locateSrc(src, searchDirs);
    const dest = `${assetsDir}/${base}`;
    if (!abs) {
      skipped.push({ src, reason: `does not exist (looked in ${searchDirs.join(', ')})` });
      continue;
    }
    const srcSize = (await fs.stat(abs)).size;
    // Idempotent: a same-size copy is left alone. Re-copying a 66 MB webcam
    // file on every render retry is minutes of pointless byte shuffling.
    if (abs !== dest && (await fs.exists(dest)) && (await fs.stat(dest)).size === srcSize) {
      rewriteMap.set(src, `assets/${base}`);
      copied.push({ src, dest, bytes: srcSize, reused: true });
      continue;
    }
    const bytes = await fs.readFileBinary(abs);
    if (abs !== dest) await fs.writeFileBinary(dest, bytes);
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

// ===========================================================================
// render -- 100% inside SLICC, in a real browser tab.
//
// There used to be a SEAM here: `render` pushed assets to a Mac tray follower
// over ssh, ran `npx remotion render` there, and pulled the mp4 back as
// base64. All of that is gone. @remotion/web-renderer@4.0.520 renders a
// composition in a Chrome tab (software DOM compose -> OffscreenCanvas ->
// WebCodecs VideoEncoder -> mediabunny muxer -> OPFS) and hands back a Blob.
// Proof + measurements: references/render-target.md.
//
// Why a tab and not this script: `require('@remotion/web-renderer')` inside a
// .jsh THROWS -- the package needs a real DOM (and bare react/react-dom, which
// are not installed as browser modules). So the flow is:
//
//   1. stage real asset copies                       (stageEdl, unchanged)
//   2. split each asset into ~8 MiB parts + manifest (serve 500s over ~25 MiB)
//   3. write cfg.json + copy remotion-harness/{index.html,composition.mjs}
//   4. `serve` the staging dir -> http URL + tab targetId
//   5. FOREGROUND the tab (a hidden tab is throttled ~100x and never gets
//      video.readyState past 0), wait for assets, then drive window.__go()
//   6. pull the output Blob back as base64 slices via `playwright-cli eval`
//      and write the bytes into the VFS
//
// Everything the page needs is generated per render; nothing is machine- or
// person-specific any more.
// ===========================================================================

const PART_SIZE = 8 * 1024 * 1024; // asset delivery slice: serve dies over ~25 MiB
const CHUNK_SIZE = 3 * 1024 * 1024; // blob -> VFS slice (arrives base64 in an eval result)

let execMod = null;
function getExec() {
  if (!execMod) execMod = require('sliccy:exec');
  return execMod;
}
// ALWAYS spawn(argv): exec('a b "c d"') splits on whitespace without honouring
// quotes, which mangles every JS expression we hand to playwright-cli.
async function run(argv) {
  return getExec().spawn(argv);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeName(s) {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}
function mimeFor(container) {
  return container === 'mp4'
    ? 'video/mp4'
    : container === 'webm'
      ? 'video/webm'
      : container === 'matroska' || container === 'mkv'
        ? 'video/x-matroska'
        : 'application/octet-stream';
}

// --- asset delivery -------------------------------------------------------
// One source file -> N part files + the metadata the page needs to reassemble
// it into a single Blob. Reassembly preserves the original container bytes, so
// every inSec in the EDL stays exact (no keyframe-snapped trim, no re-encode).
async function splitIntoParts(absPath, stagingDir, key) {
  const size = (await fs.stat(absPath)).size;
  const n = Math.max(1, Math.ceil(size / PART_SIZE));
  const names = [];
  for (let i = 0; i < n; i++) names.push(`parts/${safeName(key)}.${String(i).padStart(2, '0')}.bin`);

  // Idempotent by SIZE (fs.stat here has no mtime): if every part is already
  // there at the expected length, the split is reused. Retrying a render should
  // not re-shred 66 MB. Swap a source for a different file of exactly the same
  // length and you would need to delete <staging>/parts by hand.
  let reusable = true;
  for (let i = 0; i < n && reusable; i++) {
    const partPath = `${stagingDir}/${names[i]}`;
    const want = i === n - 1 ? size - PART_SIZE * i : PART_SIZE;
    if (!(await fs.exists(partPath)) || (await fs.stat(partPath)).size !== want) reusable = false;
  }
  if (reusable) return { parts: names, size, reused: true };

  const bytes = await fs.readFileBinary(absPath);
  for (let i = 0; i < n; i++) {
    const slice = bytes.subarray(i * PART_SIZE, Math.min(size, (i + 1) * PART_SIZE));
    await fs.writeFileBinary(`${stagingDir}/${names[i]}`, slice);
  }
  return { parts: names, size, reused: false };
}

// --- harness generation ---------------------------------------------------
async function buildHarness(opts) {
  const { stagedEdl, stagingDir, focusMap, captionsAbs, captionOffsetSec, render, id } = opts;
  const partsDir = `${stagingDir}/parts`;
  await fs.mkdir(partsDir, { recursive: true }).catch(() => fs.mkdir(partsDir));

  const uniqueSrcs = new Set();
  for (const seg of stagedEdl.segments) {
    if (seg.shot === 'split') {
      if (seg.top?.src) uniqueSrcs.add(seg.top.src);
      if (seg.bottom?.src) uniqueSrcs.add(seg.bottom.src);
    } else if (seg.source?.src) uniqueSrcs.add(seg.source.src);
  }

  const sources = {};
  const assetReport = [];
  for (const src of uniqueSrcs) {
    const base = basenameOf(src);
    const abs = resolveFrom(stagingDir, src);
    const info = await inspectMedia(abs);
    if (!info.dimensions) throw new Error(`could not read dimensions of ${abs}`);
    const split = await splitIntoParts(abs, stagingDir, base);
    sources[base] = {
      width: info.dimensions.width,
      height: info.dimensions.height,
      mime: mimeFor(info.container),
      size: split.size,
      parts: split.parts,
      focus: focusMap[base] || focusMap[src] || undefined,
    };
    assetReport.push({ base, ...split, width: info.dimensions.width, height: info.dimensions.height });
  }

  const rebase = (s) => (s ? { ...s, src: basenameOf(s.src) } : s);
  const cfg = {
    id,
    fps: stagedEdl.fps,
    width: stagedEdl.width,
    height: stagedEdl.height,
    segments: stagedEdl.segments.map((seg) =>
      seg.shot === 'split'
        ? { ...seg, top: rebase(seg.top), bottom: rebase(seg.bottom) }
        : { ...seg, source: rebase(seg.source) },
    ),
    sources,
    captions: null,
    captionOffsetSec: captionOffsetSec || 0,
    render,
  };

  if (captionsAbs) {
    const capBytes = await fs.readFile(captionsAbs);
    await fs.writeFile(`${stagingDir}/captions.json`, capBytes);
    cfg.captions = 'captions.json';
  }

  await fs.writeFile(`${stagingDir}/cfg.json`, JSON.stringify(cfg, null, 2));
  // Harness lookup must work in BOTH layouts: installed as a skill the files sit
  // under assets/, but a bare checkout keeps
  // them beside the script. Try each and report every path tried on failure --
  // a silent miss here surfaces much later as a blank render.
  const skillDir = (() => {
    try { return require('sliccy:skill').dir; } catch { return null; }
  })();
  // `sliccy:skill`.dir is the directory of the RUNNING SCRIPT (documented in
  // skill-authoring/jsh-runtime-extensions.md), so skill.assets is
  // `<skill>/scripts/assets`. This repo ships assets at the skill ROOT instead
  // (`<skill>/assets`, same as oryx), so the root must be derived by stripping a
  // trailing `/scripts`. Both layouts are tried; a bare checkout is covered too.
  const skillRoot = skillDir ? skillDir.replace(/\/scripts\/?$/, '') : null;
  const harnessCandidates = [
    skillRoot && `${skillRoot}/assets/remotion-harness`,
    skillDir && `${skillDir}/assets/remotion-harness`,
    skillDir && `${skillDir}/remotion-harness`,
    `${dirnameOf(process.argv[1] || '')}/remotion-harness`,
  ].filter(Boolean);
  let harnessDir = null;
  for (const cand of harnessCandidates) {
    if (await fs.exists(`${cand}/index.html`)) { harnessDir = cand; break; }
  }
  if (!harnessDir) {
    throw new Error(
      `could not locate the render harness. Tried:\n  ${harnessCandidates.join('\n  ')}`,
    );
  }
  for (const f of ['index.html', 'composition.mjs']) {
    const from = `${harnessDir}/${f}`;
    if (!(await fs.exists(from))) throw new Error(`harness file missing: ${from}`);
    await fs.writeFile(`${stagingDir}/${f}`, await fs.readFile(from));
  }
  return { cfg, assetReport };
}

// --- serve + tab plumbing -------------------------------------------------
// Returns {url, tab} for a live preview of `dir`, plus a foregrounded tab on it.
//
// Preview tokens are a CAPPED, tray-wide resource shared with every other agent
// ("Preview mint failed: Preview limit reached"), so this reuses an existing
// live preview of the same directory instead of minting a fresh one per render.
// A live preview (never --ttl, which snapshots) always serves current bytes, so
// reuse is safe across re-renders with a different cfg.json.
async function serveDir(dir) {
  const root = dir.replace(/\/+$/, '');

  const existing = await livePreviewsFor(root);
  if (existing.length) {
    // keep the newest, drop the rest so repeated renders do not leak slots
    for (const p of existing.slice(0, -1)) await run(['serve', '--stop', p.token]);
    const url = existing[existing.length - 1].url;
    console.log(color.dim('  reusing existing preview for this dir'));
    return { url, tab: await openTab(url) };
  }

  let lastErr = 'unknown';
  const attempts = 10;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // NEVER --ttl here: that publishes an immutable snapshot, so a re-render
    // would keep serving the previous cfg.json forever.
    const r = await run(['serve', '--quiet', root]);
    const m = (r.stdout || '').match(/Preview URL:\s+(\S+)\s+\(targetId:\s*([0-9A-Fa-f]+)\)/);
    if (m) {
      // serve's live path rides the leader socket and drops intermittently
      // ("Bad gateway: leader disconnected"). If the preview is not in the list
      // right after minting it, reset the host and mint again.
      const list = await run(['serve', '--list']);
      if ((list.stdout || '').includes(root)) return { url: m[1], tab: m[2] };
      console.error(color.yellow('  serve minted a preview that vanished; running host reset...'));
      await run(['host', 'reset']);
      await sleep(3000);
      continue;
    }
    lastErr = (r.stderr || r.stdout || '').trim().slice(-300);
    if (attempt < attempts) {
      const limit = /Preview limit reached/i.test(lastErr);
      console.error(
        color.yellow(
          limit
            ? `  every preview slot on this tray is taken (attempt ${attempt}/${attempts}); waiting 20s...`
            : `  serve failed (attempt ${attempt}/${attempts}): ${lastErr}; retrying...`,
        ),
      );
      await sleep(limit ? 20000 : 4000);
      continue;
    }
    throw new Error(
      `serve could not mint a preview URL for ${root}: ${lastErr}\n` +
        '  Previews are capped tray-wide. List them with "serve --list" and free a slot\n' +
        '  with "serve --stop <token>" (previews for THIS dir are reused automatically).',
    );
  }
  throw new Error(`serve failed for ${root}: ${lastErr}`);
}

// Every open tab currently on this URL (tab-list lines are "[targetId] url title").
async function tabsForUrl(url) {
  const list = await run(['playwright-cli', 'tab-list']);
  return (list.stdout || '')
    .split('\n')
    .filter((l) => /^\[[0-9A-Fa-f]+\]/.test(l) && l.includes(url))
    .map((l) => l.slice(1, l.indexOf(']')));
}

// True when this tab has already loaded the byte-identical cfg.json and is idle
// (ready/done, not mid-render): its sources are reassembled, so a render can
// start immediately.
async function isWarmTab(tab, cfgText) {
  try {
    const raw = await evalTab(tab, 'window.__status()');
    if (!raw || raw === 'undefined') return false;
    const st = JSON.parse(raw);
    if (st.stage !== 'ready' && st.stage !== 'done') return false;
    const text = await evalTabToFile(tab, 'window.__cfgText', '/tmp/.remotion-cfgcheck.txt');
    return String(text).trim() === cfgText.trim();
  } catch {
    return false;
  }
}

async function openTab(url) {
  const r = await run(['playwright-cli', 'open', url, '--foreground']);
  const m = (r.stdout || '').match(/targetId:\s*([0-9A-Fa-f]+)/);
  if (!m) throw new Error(`could not open ${url}: ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
  return m[1];
}

// Live previews currently serving `dir`, oldest first. There can be several:
// every `serve` call mints a new token.
// `serve --list` rows are: TOKEN MODE EXPIRES URL ROOT CREATED.
async function livePreviewsFor(dir) {
  const root = dir.replace(/\/+$/, '');
  const list = await run(['serve', '--list']);
  const out = [];
  for (const line of (list.stdout || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 6 && cols[4] === root && cols[1] === 'live') out.push({ token: cols[0], url: cols[3] });
  }
  return out;
}

async function evalTab(tab, expr) {
  const r = await run(['playwright-cli', 'eval', expr, `--tab=${tab}`]);
  if (r.exitCode !== 0) throw new Error(`eval failed (${expr}): ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
  return (r.stdout || '').trim();
}

async function evalTabToFile(tab, expr, outPath) {
  const r = await run(['playwright-cli', 'eval', expr, `--tab=${tab}`, `--output=${outPath}`]);
  if (r.exitCode !== 0) throw new Error(`eval failed (${expr}): ${(r.stderr || r.stdout || '').trim().slice(-300)}`);
  let s = (await fs.readFile(outPath)).trim();
  // eval --output writes the result JSON-encoded (a quoted string for a string)
  if (s.startsWith('"')) {
    try {
      s = JSON.parse(s);
    } catch {
      /* not JSON after all */
    }
  }
  return s;
}

// Chrome throttles hidden tabs ~100x and never advances a <video> past
// readyState 0, so foregrounding is not cosmetic -- it is the difference
// between 146 ms and 17 s. tab-select does not reliably stick if something
// else is driving the browser, hence the re-check right before rendering.
async function foregroundTab(tab) {
  const list = await run(['playwright-cli', 'tab-list']);
  const lines = (list.stdout || '').split('\n').filter((l) => /^\[[0-9A-Fa-f]+\]/.test(l));
  const idx = lines.findIndex((l) => l.startsWith(`[${tab}]`));
  if (idx < 0) return false;
  const sel = await run(['playwright-cli', 'tab-select', String(idx + 1)]);
  if (sel.exitCode !== 0) return false;
  await sleep(500);
  try {
    return (await evalTab(tab, 'document.visibilityState')) === 'visible';
  } catch {
    return false;
  }
}

async function ensureVisible(tab) {
  for (let i = 0; i < 4; i++) {
    let vis = 'unknown';
    try {
      vis = await evalTab(tab, 'document.visibilityState');
    } catch {
      /* retry */
    }
    if (vis === 'visible') return true;
    await foregroundTab(tab);
  }
  return false;
}

async function pollStatus(tab, done, opts) {
  const { timeoutMs, label, intervalMs = 1500, onTick } = opts;
  const t0 = Date.now();
  let consecutiveFailures = 0;
  while (Date.now() - t0 < timeoutMs) {
    let st = null;
    try {
      const raw = await evalTab(tab, 'window.__status()');
      st = raw && raw !== 'undefined' ? JSON.parse(raw) : null;
      consecutiveFailures = 0;
    } catch (e) {
      if (++consecutiveFailures > 20) throw new Error(`lost the render tab while waiting for ${label}: ${e.message}`);
    }
    if (st) {
      if (st.stage === 'error') throw new Error(`harness error while ${label}:\n${st.err}`);
      if (done(st)) return st;
      if (onTick) onTick(st, Date.now() - t0);
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
}

// Get a tab that has actually EXECUTED the harness, using EXACTLY ONE tab per
// preview URL. Opening a fresh tab per render buried the owner's browser in
// ...sliccy.now/index.html tabs, so: find any tab already on this URL, keep one,
// close the duplicates, and re-navigate it instead of opening another. A tab
// whose loaded cfg.json is byte-identical is kept as-is (a warm tab skips the
// ~2 min in-page reassembly of the sources).
//
// `serve`'s live path also rides the leader socket, and its first hit often
// lands on "Bad gateway: leader disconnected" -- re-navigation clears it.
// Escalation ladder: re-navigate, re-mint the preview, host reset.
async function bootHarness(stagingDir, cfgText) {
  let served = await serveDir(stagingDir);
  console.log(color.dim(`  served ${served.url}`));

  // One tab per preview URL: prefer a warm one, else re-use whatever is already
  // there, else open exactly one. Duplicates are closed either way.
  let tab = null;
  let needsReload = false;
  {
    const tabs = await tabsForUrl(served.url);
    // `serve` opens a tab itself when it mints a token; that one is already on
    // the current bytes and needs no reload.
    if (served.tab && !tabs.includes(served.tab)) tabs.unshift(served.tab);

    let warmTab = null;
    for (const t of tabs) {
      if (await isWarmTab(t, cfgText)) {
        warmTab = t;
        break;
      }
    }
    tab = warmTab || tabs[0] || (await openTab(served.url));
    needsReload = !warmTab && tabs.length > 0 && tab !== served.tab;
    for (const t of tabs) if (t !== tab) await run(['playwright-cli', 'tab-close', `--tab=${t}`]);
    if (warmTab) {
      console.log(color.dim(`  reusing warm tab ${tab} (assets already loaded)`));
      return { url: served.url, tab, warm: true };
    }
    console.log(color.dim(needsReload ? `  reusing tab ${tab} (re-navigating it)` : `  tab ${tab}`));
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    // A reused tab may still be showing an older cfg.json, so reload it before
    // trusting anything on it. A tab we just opened is already current.
    if (needsReload) await run(['playwright-cli', 'goto', served.url, `--tab=${tab}`]);
    needsReload = true; // every later attempt is a retry, i.e. a reload

    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (await isWarmTab(tab, cfgText)) {
        console.log(color.dim(`  tab ${tab} already holds this exact render (warm)`));
        return { url: served.url, tab, warm: true };
      }
      let probe = null;
      try {
        probe = await evalTab(tab, 'typeof(window.__status)');
      } catch {
        /* tab not ready */
      }
      if (probe === 'function') {
        console.log(color.dim(`  tab ${tab} running the harness`));
        return { url: served.url, tab, warm: false };
      }
      await sleep(2000);
    }

    let body = '';
    try {
      body = await evalTab(tab, 'document.body.innerText.slice(0,200)');
    } catch {
      /* ignore */
    }
    console.error(color.yellow(`  harness did not start (attempt ${attempt}/5): ${body.slice(0, 120) || 'blank page'}`));
    if (attempt === 3) {
      // Re-mint, but keep driving the SAME tab -- do not accumulate tabs.
      for (const prev of await livePreviewsFor(stagingDir)) await run(['serve', '--stop', prev.token]);
      served = await serveDir(stagingDir);
      const extra = (await tabsForUrl(served.url)).filter((t) => t !== tab);
      for (const t of extra) await run(['playwright-cli', 'tab-close', `--tab=${t}`]);
    } else if (attempt === 4) {
      console.error(color.yellow('  running host reset...'));
      await run(['host', 'reset']);
      await sleep(5000);
      served = await serveDir(stagingDir);
      const extra = (await tabsForUrl(served.url)).filter((t) => t !== tab);
      for (const t of extra) await run(['playwright-cli', 'tab-close', `--tab=${t}`]);
    }
  }
  throw new Error(`the harness page never started at ${served.url}`);
}

// --- the driver -----------------------------------------------------------
async function renderInBrowser(stagingDir, opts) {
  const { tab, warm } = await bootHarness(stagingDir, opts.cfgText);

  try {
    if (!(await foregroundTab(tab))) {
      console.error(color.yellow('  warning: could not confirm the tab is foregrounded -- render may crawl'));
    }

    let lastLoad = '';
    const ready = await pollStatus(tab, (st) => st.stage === 'ready' || (warm && st.stage === 'done'), {
      timeoutMs: opts.loadTimeoutMs,
      intervalMs: 2500,
      label: 'the harness to load assets',
      onTick: (st) => {
        const line = `  ...${st.stage}${st.assets?.detail ? ` ${st.assets.detail} (${st.assets.bytes} bytes)` : ''}`;
        if (line !== lastLoad) console.log(color.dim(line));
        lastLoad = line;
      },
    });
    console.log(color.dim(`  harness ready (${ready.tail?.slice(-1)[0] || ''})`));

    if (!(await ensureVisible(tab))) {
      console.error(color.yellow('  warning: tab is still hidden; expect a ~100x slower render'));
    }

    const started = await evalTab(tab, 'window.__go()');
    if (started !== 'started' && started !== 'already-running') throw new Error(`could not start render: ${started}`);

    let lastLine = '';
    const finished = await pollStatus(tab, (st) => st.stage === 'done' && st.done, {
      timeoutMs: opts.renderTimeoutMs,
      label: 'the render',
      intervalMs: 2500,
      onTick: (st, elapsed) => {
        const p = st.prog ? JSON.stringify(st.prog) : '(no progress yet)';
        const line = `  ${(elapsed / 1000).toFixed(0)}s ${p.slice(0, 140)}`;
        if (line !== lastLine) console.log(color.dim(line));
        lastLine = line;
      },
    });
    const meta = finished.done;
    console.log(color.dim(`  encoded ${meta.size} bytes (${meta.magic}) in ${meta.msTotal}ms`));

    // Pull the blob back in independently-decodable byte slices.
    const nChunks = Number(await evalTab(tab, `window.__nchunks(${CHUNK_SIZE})`));
    if (!Number.isFinite(nChunks) || nChunks < 1) throw new Error(`bad chunk count: ${nChunks}`);
    const slices = [];
    for (let i = 0; i < nChunks; i++) {
      const tmp = `/tmp/.remotion-chunk-${i}.b64`;
      const b64 = await evalTabToFile(tab, `window.__chunk(${i},${CHUNK_SIZE})`, tmp);
      slices.push(new Uint8Array(Buffer.from(b64, 'base64')));
      await fs.unlink(tmp).catch(() => {});
      console.log(color.dim(`  pulled chunk ${i + 1}/${nChunks} (${b64.length} b64 chars)`));
    }
    const total = slices.reduce((a, s) => a + s.length, 0);
    if (total !== meta.size) throw new Error(`readback size mismatch: got ${total}, page reported ${meta.size}`);
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const s of slices) {
      bytes.set(s, o);
      o += s.length;
    }
    return { bytes, meta, tab };
  } finally {
    if (!opts.keep) {
      // Leave the preview minted: it is reused by the next render of this dir,
      // and re-minting is what exhausts the tray-wide preview cap. Only the tab
      // is disposable.
      await run(['playwright-cli', 'tab-close', `--tab=${tab}`]);
    } else {
      console.log(color.dim(`  --keep: tab ${tab} left open -- the next render of this EDL reuses it`));
    }
  }
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
    cli.help(`remotion -- EDL tooling for the interview-clipping pipeline (runs in SLICC)

Usage:
  remotion validate <edl.json> [--no-check-media]
  remotion inspect <media-file> [--json]
  remotion filmstrip <file> [--frames=N] [--width=N] [--out=path]
  remotion stage <edl.json> <staging-dir> [--assets <dir>]
  remotion render <edl.json> <staging-dir> [--index N] [--out <path|dir>]
                  [--container mp4|webm] [--video-codec h264] [--audio-codec aac]
                  [--captions <file>] [--no-captions] [--muted]
                  [--assets <dir>] [--timeout <sec>] [--keep]
  remotion transcode <src> <out> [--container webm|mp4] [--video-codec ...] [--audio-codec ...]

validate  -- schema + (by default) real-media range checks (media-parser, no ffmpeg).
inspect   -- dimensions/duration/codec of one file, via @remotion/media-parser.
filmstrip -- labelled contact sheet of N frames, so you can SEE a render.
stage     -- copy real files (not symlinks) referenced by an EDL into <staging-dir>/assets.
render    -- render the WHOLE EDL (or one segment with --index N) with
             @remotion/web-renderer, in a served browser tab. No remote machine,
             no ffmpeg. Output goes to --out (default <staging-dir>/<edl>.mp4).
transcode -- whole-file container/codec transcode via @remotion/webcodecs, fully
             inside SLICC (no ffmpeg). No trim support (see report).

render notes:
  * relative "src" values resolve against the EDL's directory, then its assets/
    subdir; --assets <dir> adds a first place to look. (validate/stage too.)
  * captions: taken from --captions, else the EDL's "captions" field if present;
    word-level [{t,end,text,speaker}] JSON, karaoke-styled per speaker. With
    --index the caption timeline is shifted to that segment automatically.
  * framing: optional "focus":{x,y} (0..1 of the source frame) on any source, or
    a top-level "focus": {"<file>": {x,y}} map. Default is a centred cover crop.
  * the render tab is brought to the FRONT on purpose -- Chrome throttles hidden
    tabs ~100x and stalls <video> decode. Expect your active tab to change.
  * --keep leaves the render tab open; a following render of the same EDL reuses
    it and skips reassembling the sources in the page (minutes for big files).
`);
    return;
  }

  if (cmd === 'validate') {
    const [edlPath] = rest;
    if (!edlPath) cli.die('usage: remotion validate <edl.json> [--no-check-media]');
    const edl = await readEdl(edlPath);
    const checkMedia = flags['check-media'] !== false && flags['no-check-media'] !== true;
    const result = await validateEdl(edl, {
      checkMedia,
      searchDirs: searchDirsFor(dirnameOf(edlPath), flags.assets),
    });
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

  // ─── filmstrip ────────────────────────────────────────────────────────────
  // Render a labelled contact sheet from a LOCAL video file so an agent can
  // actually look at a render instead of trusting its duration.
  //
  // Modelled on `tiktok filmstrip`, which grabs frames from an in-page <video>
  // via canvas. That approach needs a tab and a player; a local file needs
  // neither, so we decode with ffmpeg and tile with the same tool. Frame
  // extraction is cheap (single-frame decode + seek), unlike re-encoding.
  if (cmd === 'filmstrip') {
    const src = positional[1];
    if (!src) cli.die('usage: remotion filmstrip <file> [--frames=N] [--width=N] [--out=path]');
    if (!(await fs.exists(src))) cli.die(`no such file: ${src}`);

    const nFrames = Math.max(1, Math.min(24, parseInt(flags.frames || flags.n || '8', 10) || 8));
    const thumbW = Math.max(64, Math.min(480, parseInt(flags.width || flags.w || '170', 10) || 170));
    const out = flags.out || `/tmp/filmstrip-${src.split('/').pop().replace(/\.[^.]+$/, '')}.jpg`;

    // Probe with media-parser (the existing helper) rather than the ffmpeg
    // banner: it reports real dimensions/duration and, for a headerless webm,
    // falls back to a full scan.
    const { exec } = require('sliccy:exec');
    const info = await inspectMedia(src);
    const duration = info.durationInSeconds || 0;
    const dims = info.dimensions || { width: 1080, height: 1920 };
    if (!(duration > 0)) cli.die(`could not determine duration of ${src}`);

    const thumbH = Math.max(2, Math.round((thumbW * dims.height) / dims.width) & ~1);
    const tmpDir = `/tmp/.strip-${Date.now().toString(36)}`;
    await fs.mkdir(tmpDir, { recursive: true });

    // Sample at the MIDPOINT of each Nth of the clip, not at the boundaries:
    // a frame taken exactly on a cut lands on whichever side rounding picks and
    // makes a correct edit look wrong.
    const times = [];
    for (let i = 0; i < nFrames; i++) times.push(Math.round(((duration * (i + 0.5)) / nFrames) * 100) / 100);

    const stamp = (t) => {
      const m = Math.floor(t / 60);
      const s = t - m * 60;
      return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
    };

    const frames = [];
    for (let i = 0; i < times.length; i++) {
      const framePath = `${tmpDir}/f${String(i).padStart(2, '0')}.jpg`;
      // -ss BEFORE -i seeks by keyframe and is far faster; accuracy within a
      // frame or two is irrelevant for a contact sheet.
      //
      // Deliberately NO drawtext: this ffmpeg core ships no font, so drawtext
      // fails with "No font filename provided" and takes the whole filter
      // graph down ("Failed to inject frame into filter network"). There is no
      // .ttf anywhere in the VFS to point it at either. The frame times are
      // printed to stdout in left-to-right order instead, which is enough to
      // map any frame back to a timestamp.
      // Retry once on failure. The wasm ffmpeg core faults under repeated use
      // and, since 6.124.0, reports "the wasm core faulted and was recycled;
      // retry the command" -- so the very next invocation runs on a fresh core
      // and usually succeeds. Without the retry a long sheet loses a frame or
      // two at random, which looks like a bad render rather than a flaky tool.
      const grab = () => exec(
        `ffmpeg -hide_banner -y -ss ${times[i]} -i ${src} -frames:v 1 -vf "scale=${thumbW}:${thumbH}" ${framePath}`,
      );
      let r = await grab();
      if (!(await fs.exists(framePath))) r = await grab();
      if (await fs.exists(framePath)) frames.push(framePath);
      else console.error(color.yellow(`  (frame at ${times[i]}s failed: ${String(r.stderr || '').slice(-120)})`));
    }
    if (!frames.length) cli.die('no frames could be extracted');

    const inputs = frames.map((f) => `-i ${f}`).join(' ');
    const tile = await exec(
      `ffmpeg -hide_banner -y ${inputs} -filter_complex "hstack=inputs=${frames.length}" ${out}`,
    );
    if (!(await fs.exists(out))) cli.die(`tiling failed: ${String(tile.stderr || '').slice(-200)}`);

    for (const f of frames) { try { await fs.unlink(f); } catch { /* best effort */ } }
    try { await fs.rmdir(tmpDir); } catch { /* best effort */ }

    if (flags.json) {
      return cli.out({
        src, out, frames: frames.length, times,
        duration, width: dims.width, height: dims.height,
        sheet: { width: thumbW * frames.length, height: thumbH },
      });
    }
    console.log(color.green(`✓ ${out}`));
    console.log(color.dim(`  ${frames.length} frames from ${duration.toFixed(2)}s at ${times.map(stamp).join(', ')}`));
    console.log(color.dim(`  sheet ${thumbW * frames.length}x${thumbH} (source ${dims.width}x${dims.height})`));
    console.log(color.dim(`  view it: open --view ${out} --size 1200x400`));
    return;
  }

  if (cmd === 'stage') {
    const [edlPath, stagingDir] = rest;
    if (!edlPath || !stagingDir) cli.die('usage: remotion stage <edl.json> <staging-dir>');
    const edl = await readEdl(edlPath);
    const result = await stageEdl(edl, stagingDir, searchDirsFor(dirnameOf(edlPath), flags.assets));
    for (const c of result.copied) console.log(color.green('✓'), c.src, '->', c.dest, `(${c.bytes} bytes)`);
    for (const s of result.skipped) console.log(color.red('✗'), s.src, '-', s.reason);
    console.log(`staged EDL written to ${result.edlOutPath}`);
    if (result.skipped.length > 0) process.exit(1);
    return;
  }

  if (cmd === 'render') {
    const [edlPath, stagingDir] = rest;
    if (!edlPath || !stagingDir) {
      cli.die('usage: remotion render <edl.json> <staging-dir> [--index N] [--out <path|dir>] [--container mp4|webm]');
    }
    const edl = await readEdl(edlPath);
    const baseDir = dirnameOf(edlPath);

    // --index still means "just this one segment" (handy for iterating on a
    // single shot); WITHOUT it the whole EDL is rendered, which the ssh path
    // could never do -- it only ever pushed one segment at a time.
    const hasIndex = flags.index != null && flags.index !== true;
    const index = hasIndex ? Number(flags.index) : null;
    let segments = edl.segments;
    let captionOffsetSec = 0;
    if (hasIndex) {
      const seg = edl.segments?.[index];
      if (!seg) cli.die(`no segment at index ${index} (edl has ${edl.segments?.length ?? 0})`);
      captionOffsetSec = edl.segments.slice(0, index).reduce((a, x) => a + (x.durationSec || 0), 0);
      segments = [seg];
    }
    const workEdl = { ...edl, segments };

    const searchDirs = searchDirsFor(baseDir, flags.assets);
    const pre = await validateEdl(workEdl, { checkMedia: false, searchDirs });
    if (!pre.ok) {
      printIssues('errors', pre.errors, color.red);
      cli.die('EDL is not renderable (run "remotion validate" for details)');
    }
    printIssues('warnings', pre.warnings, color.yellow);

    const container = flags.container || 'mp4';
    const render = {
      container,
      videoCodec: flags['video-codec'] || (container === 'webm' ? 'vp8' : 'h264'),
      audioCodec: flags['audio-codec'] || (container === 'webm' ? 'opus' : 'aac'),
      muted: flags.muted === true,
      videoBitrate: flags['video-bitrate'] || 'high',
      audioBitrate: flags['audio-bitrate'] || 'high',
    };

    let captionsAbs = null;
    if (flags['no-captions'] !== true) {
      const cand = typeof flags.captions === 'string' ? flags.captions : edl.captions;
      if (cand) {
        const abs = resolveFrom(baseDir, cand);
        if (await fs.exists(abs)) captionsAbs = abs;
        else cli.warn(`captions file not found: ${abs} (rendering without captions)`);
      }
    }

    const stem = basenameOf(edlPath).replace(/\.json$/i, '') + (hasIndex ? `-seg${index}` : '');
    const ext = container === 'webm' ? 'webm' : container === 'mp4' ? 'mp4' : 'mkv';
    let outPath;
    if (typeof flags.out === 'string') {
      outPath = /\.(mp4|webm|mkv)$/i.test(flags.out) ? flags.out : `${flags.out.replace(/\/+$/, '')}/${stem}.${ext}`;
    } else {
      outPath = `${stagingDir}/${stem}.${ext}`;
    }

    const totalSec = segments.reduce((a, x) => a + (x.durationSec || 0), 0);
    console.log(
      `${edlPath}: ${segments.length} segment${segments.length === 1 ? '' : 's'}, ` +
        `${totalSec.toFixed(2)}s @ ${edl.fps}fps ${edl.width}x${edl.height} -> ${render.videoCodec}/${render.container}`,
    );

    const t0 = Date.now();
    console.log(color.dim('staging assets...'));
    const staged = await stageEdl(workEdl, stagingDir, searchDirs);
    for (const c of staged.copied) {
      console.log(color.dim(`  ${c.reused ? 'reused' : 'copied'} ${c.dest} (${c.bytes} bytes)`));
    }
    if (staged.skipped.length) {
      for (const sk of staged.skipped) console.log(color.red('✗'), sk.src, '-', sk.reason);
      cli.die('missing source media');
    }

    console.log(color.dim('building harness...'));
    const { cfg, assetReport } = await buildHarness({
      stagedEdl: staged.stagedEdl,
      stagingDir,
      focusMap: edl.focus || {},
      captionsAbs,
      captionOffsetSec,
      render,
      id: stem,
    });
    for (const a of assetReport) {
      console.log(color.dim(`  ${a.base} ${a.width}x${a.height} -> ${a.parts.length} part(s)${a.reused ? ' (reused)' : ''}`));
    }
    if (cfg.captions) console.log(color.dim(`  captions: ${captionsAbs} (offset ${captionOffsetSec}s)`));

    console.log(color.dim('rendering in a browser tab (@remotion/web-renderer)...'));
    const timeoutSec = Number(flags.timeout) > 0 ? Number(flags.timeout) : 1800;
    const { bytes, meta } = await renderInBrowser(stagingDir, {
      loadTimeoutMs: 15 * 60 * 1000,
      renderTimeoutMs: timeoutSec * 1000,
      keep: flags.keep === true,
      cfgText: await fs.readFile(`${stagingDir}/cfg.json`),
    });

    await fs.writeFileBinary(outPath, bytes);
    const wall = (Date.now() - t0) / 1000;
    console.log(
      color.green(
        `✓ ${outPath} (${bytes.length} bytes, ${meta.frames} frames, ${meta.clipSec}s) -- ` +
          `render ${(meta.msTotal / 1000).toFixed(1)}s, ${wall.toFixed(1)}s wall`,
      ),
    );
    console.log(color.dim(`  inspect it: remotion inspect ${outPath}`));
    console.log(color.dim(`  look at it: remotion filmstrip ${outPath} --frames=6 --width=160`));
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
    // this runtime's require() anyway (confirmed empirically).
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
    console.log(color.dim('(whole-file only -- no trim/range support in convertMedia, see report)'));
    return;
  }

  cli.die(`unknown subcommand: ${cmd} (try "remotion help")`);
}

await main();
