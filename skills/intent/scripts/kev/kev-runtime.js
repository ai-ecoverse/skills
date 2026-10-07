// Load a kev model once and keep it: `intent` opens one per call, `intent
// serve` and intent-arm one per run. Loading kev-9b reads 325 weight files
// (about 4 s from OPFS on WebGPU with kev.js 0.4, measured 2026-09-23); a
// warm ask is the forward pass alone.
// fs is passed in, like host.js, so tests can load this without the realm.

const host = require('./host.js');

const pkg = require('../../package.json');

// kev.js and onnxruntime-web are the skill's npm dependencies (package.json):
// `intent pull` installs them into the skill's node_modules.
const KEV_NAME = '@ai-ecoverse/kev.js';
const KEV_SPEC = `${KEV_NAME}@${pkg.dependencies[KEV_NAME]}`;
const DEST = '/workspace/models/ai-ecoverse/kev.js';
// The named model: kev-4b-vision, the decoder behind Qwen3.5's stock vision
// tower, so a request may carry a screenshot. Other kev bundles load with
// --from.
const MODELS = { '4b-vision': 'kev-4b-vision' };

const ortDirOf = (root) => `${String(root).replace(/\/+$/, '')}/node_modules/${host.ORT_NAME}`;

/**
 * Whether the skill's dependencies are installed in <root>/node_modules at
 * the versions package.json pins. → { ok, missing: ['name@want (have …)'] }
 */
async function depsStatus(fs, root) {
  const nm = `${String(root).replace(/\/+$/, '')}/node_modules`;
  const missing = [];
  for (const [name, want] of Object.entries(pkg.dependencies)) {
    let have = null;
    try {
      have = await host.readPackageVersion(fs, `${nm}/${name}`);
    } catch {
      have = null;
    }
    let complete = have === want;
    if (complete && name === host.ORT_NAME) {
      for (const rel of host.ORT_BUNDLES)
        if (!(await fs.exists(`${nm}/${name}/${rel}`))) complete = false;
    }
    if (!complete) missing.push(`${name}@${want}${have ? ` (have ${have})` : ''}`);
  }
  return { ok: missing.length === 0, missing };
}

async function loadOrt(fs, kind, ortDir) {
  const fileName = kind === 'webgpu' ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs';
  if (!ortDir) throw new Error(`${host.ORT_SPEC} is not installed. Run intent pull.`);
  const dist = `${ortDir}/dist`;
  const file = `${dist}/${fileName}`;
  if (!(await fs.exists(file)))
    throw new Error(`onnxruntime-web: ${file} is missing. Run intent pull.`);
  const loaded = await host.nativeImport(host.previewUrl(file));
  const ort = loaded.InferenceSession ? loaded : loaded.default;
  if (!ort || !ort.InferenceSession) throw new Error('ort bundle has no InferenceSession');
  host.checkOrtVersion(ort, ortDir);
  host.configureOrt(ort, dist);
  return ort;
}

// kev.js from the skill's node_modules. The realm resolves this require when
// the script starts and transpiles kev.js's ES modules; before `intent pull`
// it fails only here, when a model opens.
function loadKev() {
  let mod;
  try {
    mod = require('@ai-ecoverse/kev.js');
  } catch (err) {
    throw new Error(
      `${KEV_SPEC} is not installed in the skill: run intent pull (${err?.message || err})`
    );
  }
  const fn = mod.loadKev || (mod.default && mod.default.loadKev);
  if (typeof fn !== 'function') throw new Error(`${KEV_SPEC} has no loadKev export`);
  return fn;
}

const REPO = 'ai-ecoverse/kev.js';
const SIZES = { '4b-vision': '5.4 GB' };
// hf prints one line per file and the shell shows output only at exit, so
// intent pull asks for a batch at a time and logs each batch here.
const PULL_LOG = '/tmp/kev/pull.log';
const PULL_BATCH = 12;

function variantFiles(manifest) {
  const variant = manifest.variants && manifest.variants.q8f32;
  if (!variant) throw new Error('the manifest has no q8f32 variant');
  const tower = manifest.vision;
  const rels = [
    manifest.files.tokenizer,
    manifest.files.tokenizer_config,
    manifest.files.head,
    variant.model,
    ...(variant.data || []),
    ...(tower ? [tower.model, ...(tower.data || [])] : []),
  ];
  // A bundle given by URL is fetched into its cache directory by these
  // names: each must stay inside it (no absolute path, no ..).
  for (const rel of rels) {
    const ok =
      typeof rel === 'string' &&
      rel !== '' &&
      !rel.startsWith('/') &&
      !rel.includes('\\') &&
      !rel.split('/').some((part) => part === '..' || part === '');
    if (!ok)
      throw new Error(`the manifest names a file outside its bundle: ${JSON.stringify(rel)}`);
  }
  return { rels, sizes: { ...(variant.sizes || {}), ...((tower && tower.sizes) || {}) } };
}

/**
 * Which weight files of one model are missing or short on disk.
 * → { model, base, manifest: bool, files, missing: [rel] }
 */
async function weightsStatus(fs, model) {
  const prefix = MODELS[model];
  if (!prefix) throw new Error(`--model must be one of ${Object.keys(MODELS).join(', ')}`);
  const base = `${DEST}/${prefix}`;
  const status = { model, base, manifest: false, files: 0, missing: ['manifest.json'] };
  if (!(await fs.exists(`${base}/manifest.json`))) return status;
  const { rels, sizes } = variantFiles(JSON.parse(await fs.readFile(`${base}/manifest.json`)));
  const missing = [];
  for (const rel of rels) {
    let size = -1;
    try {
      size = (await fs.stat(`${base}/${rel}`)).size;
    } catch {
      missing.push(rel);
      continue;
    }
    const want = sizes[rel];
    if (typeof want === 'number' && want > 0 && size !== want) missing.push(rel);
  }
  return { model, base, manifest: true, files: rels.length, missing };
}

function missingWeightsMessage(status) {
  const what = status.manifest
    ? `${status.missing.length} of ${status.files} kev-${status.model} weight files are missing`
    : `the kev-${status.model} weights are not downloaded`;
  return [
    `${what} (${status.base}, ${SIZES[status.model]} in all).`,
    `Download them: intent pull --model ${status.model}`,
    'It resumes where it stopped: files already at full size are skipped.',
    'Or pass --from <dir> to use weights you already have.',
  ].join('\n');
}

async function appendPullLog(fs, line) {
  try {
    await fs.mkdir('/tmp/kev', { recursive: true });
    const old = (await fs.exists(PULL_LOG)) ? await fs.readFile(PULL_LOG) : '';
    await fs.writeFile(PULL_LOG, `${old}${new Date().toISOString().slice(11, 19)} ${line}\n`);
  } catch {
    // The log only helps someone watching a long download.
  }
}

/** Download the missing files of one model with the shell `hf` command. */
async function pullWeights(fs, exec, model, log = () => {}) {
  const prefix = MODELS[model];
  if (!prefix) throw new Error(`--model must be one of ${Object.keys(MODELS).join(', ')}`);
  const note = async (line) => {
    log(line);
    await appendPullLog(fs, line);
  };
  let status = await weightsStatus(fs, model);
  if (!status.manifest) {
    await note(`hf download ${REPO} ${prefix}/manifest.json`);
    await host.hfDownload(exec, REPO, [`${prefix}/manifest.json`], DEST);
    status = await weightsStatus(fs, model);
  }
  await note(`kev-${model}: ${status.files} files, ${status.missing.length} to download`);
  for (let i = 0; i < status.missing.length; i += PULL_BATCH) {
    const batch = status.missing.slice(i, i + PULL_BATCH);
    await note(`hf ${i + 1}-${i + batch.length} of ${status.missing.length}`);
    await host.hfDownload(
      exec,
      REPO,
      batch.map((rel) => `${prefix}/${rel}`),
      DEST
    );
  }
  const after = await weightsStatus(fs, model);
  await note(
    after.missing.length
      ? `kev-${model}: ${after.missing.length} files still missing`
      : `kev-${model}: complete`
  );
  return after;
}

async function openOn(fs, base, dateFacts, providers, log, ortDir) {
  const kind = providers[0] === 'webgpu' ? 'webgpu' : 'wasm';
  log(`kev: runtime ${kind}${host.hasWebGpu() ? '' : ' (navigator.gpu absent in this worker)'}`);
  const ort = await loadOrt(fs, kind, ortDir);
  const root = base.replace(/\/$/, '');
  let finished = 0;
  // kev.js 0.4+ reads a bundle in place through this function: no preview
  // URL, no fetch, no Cache Storage. A shard shorter than the manifest says
  // fails by name; weightsStatus still runs first so the message names intent pull.
  return loadKev()((rel) => fs.readFileBinary(`${root}/${rel}`), {
    ort,
    variant: 'q8f32',
    executionProviders: providers,
    dateFacts,
    onPhase: (phase) => log(`kev: phase ${phase}`),
    onProgress: (progress) => {
      if (progress.total && progress.loaded === progress.total) {
        finished += 1;
        if (finished === 1 || finished % 25 === 0)
          log(`kev: ${finished} files, last ${progress.file}`);
      }
    },
  });
}

/**
 * The worker's WebGPU adapter, logged by name, or null (also logged): a
 * navigator.gpu without an adapter cannot run a session.
 */
async function webGpuAdapter(log, requireGpu) {
  if (!host.hasWebGpu()) return null;
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (err) {
    log(`kev: webgpu requestAdapter failed (${err.message || err})`);
    return null;
  }
  if (!adapter) {
    log('kev: webgpu has no adapter in this worker');
    return null;
  }
  const info = adapter.info || {};
  const name = [info.vendor, info.architecture, info.device, info.description]
    .filter(Boolean)
    .join(' ');
  log(`kev: webgpu adapter ${name || '(no info)'}`);
  if (isSoftwareAdapter(adapter)) {
    const what = `WebGPU in this worker is a software adapter (${name || 'fallback'}), not a GPU: every ask runs on the CPU, about 10x slower`;
    if (requireGpu) throw new Error(`${what}. Give the worker the GPU, or drop --require-gpu.`);
    log(`kev: WARNING ${what}`);
  }
  return adapter;
}

/**
 * Chrome's SwiftShader, or any adapter flagged as a fallback. A hosted L4
 * leader's jsh worker got "google swiftshader" while its Vulkan init
 * failed, and a 0.8b ask took 80 s (diag round 2, 2026-10-02).
 */
function isSoftwareAdapter(adapter) {
  const info = adapter.info || {};
  if (info.isFallbackAdapter === true || adapter.isFallbackAdapter === true) return true;
  return /swiftshader/i.test(
    `${info.vendor} ${info.architecture} ${info.device} ${info.description}`
  );
}

/**
 * Open a model on WebGPU when the worker has it, falling back to wasm.
 * Weights are never downloaded here: a missing file is an error that names
 * `intent pull`. opts: { model, from, root (the skill directory), dateFacts, log,
 * requireGpu (refuse a software WebGPU adapter) }
 */
async function openModel(fs, _exec, opts = {}) {
  const log = opts.log || (() => {});
  let base = opts.from ? host.resolvePath(opts.from) : null;
  if (!base) {
    const status = await weightsStatus(fs, opts.model || '4b-vision');
    if (status.missing.length) throw new Error(missingWeightsMessage(status));
    base = status.base;
  }
  const dateFacts = opts.dateFacts === true;
  // WebGPU alone, as the kev.js page asks for it: given ['webgpu', 'wasm'],
  // onnxruntime-web drops a WebGPU it cannot start and quietly runs the
  // whole session on single-threaded wasm, while this log still said
  // "runtime webgpu". A hosted L4 leader took 78-80 s per 0.8b ask where
  // the page took 10 s cold (2026-10-02). Now a WebGPU failure throws, and
  // the wasm retry below says so in the log.
  const adapter = await webGpuAdapter(log, opts.requireGpu === true);
  const providers = adapter ? ['webgpu'] : ['wasm'];
  try {
    return await openOn(fs, base, dateFacts, providers, log, ortDirOf(opts.root));
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    if (providers[0] !== 'webgpu') throw err;
    log(`kev: webgpu failed (${err.message}); retrying on wasm`);
    return openOn(fs, base, dateFacts, ['wasm'], log, ortDirOf(opts.root));
  }
}

module.exports = {
  variantFiles,
  ORT_SPEC: host.ORT_SPEC,
  KEV_NAME,
  KEV_SPEC,
  DEST,
  MODELS,
  SIZES,
  PULL_LOG,
  openModel,
  isSoftwareAdapter,
  weightsStatus,
  missingWeightsMessage,
  pullWeights,
  depsStatus,
};
