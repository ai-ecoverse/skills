// Load a Kev model once and keep it. kev.jsh opens one per ask; webrunner
// opens one per run and asks it every step. Loading kev-9b reads 325 weight
// files (about 55 s on WebGPU); a warm ask is the forward pass alone.
// fs is passed in, like host.js, so tests can load this without the realm.

const host = require('./host.js');

const BUNDLE = '/shared/cache/kev/bundle.cjs';
const DEST = '/workspace/models/ai-ecoverse/kev.js';
const MODELS = { '0.8b': 'kev-0.8b', '4b': 'kev-4b', '9b': 'kev-9b' };
const ORT_DIRS = [
  '/shared/lib/node_modules/onnxruntime-web/dist',
  '/workspace/node_modules/onnxruntime-web/dist',
];

async function loadOrt(fs, kind) {
  const fileName = kind === 'webgpu' ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs';
  let last;
  for (const dir of ORT_DIRS) {
    const file = `${dir}/${fileName}`;
    if (!(await fs.exists(file))) continue;
    try {
      const loaded = await host.nativeImport(host.previewUrl(file));
      const ort = loaded.InferenceSession ? loaded : loaded.default;
      if (!ort || !ort.InferenceSession) throw new Error('ort bundle has no InferenceSession');
      host.configureOrt(ort, dir);
      return ort;
    } catch (err) {
      if (err && err.name === 'NodeExitError') throw err;
      last = err;
    }
  }
  throw (
    last || new Error(`onnxruntime-web ${fileName} is missing. Run kev ask once to install it.`)
  );
}

// The realm resolves every literal require() in a nested module when it
// loads, and a missing file there is fatal. The bundle may not exist yet, so
// only the entry script names it: callers pass `requireBundle`, a function
// around their own require('/shared/cache/kev/bundle.cjs').
function loadKev(requireBundle) {
  if (typeof requireBundle !== 'function') throw new Error('openModel needs requireBundle');
  const bundled = requireBundle();
  const fn = bundled.loadKev || (bundled.default && bundled.default.loadKev);
  if (typeof fn !== 'function') throw new Error('kev bundle has no loadKev export');
  return fn;
}

async function ensureWeights(fs, exec, model, from) {
  if (from) return host.resolvePath(from);
  const prefix = MODELS[model];
  if (!prefix) throw new Error('--model must be 0.8b, 4b, or 9b');
  const base = `${DEST}/${prefix}`;
  const manifestPath = `${base}/manifest.json`;
  if (!(await fs.exists(manifestPath))) {
    await host.hfDownload(exec, 'ai-ecoverse/kev.js', [`${prefix}/manifest.json`], DEST);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  const variant = manifest.variants && manifest.variants.q8f32;
  if (!variant) throw new Error(`${prefix} manifest has no q8f32 variant`);
  const rels = [
    manifest.files.tokenizer,
    manifest.files.tokenizer_config,
    manifest.files.head,
    variant.model,
    ...(variant.data || []),
  ];
  await host.hfDownload(
    exec,
    'ai-ecoverse/kev.js',
    rels.map((rel) => `${prefix}/${rel}`),
    DEST
  );
  return base;
}

function previewPath(input) {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
  if (typeof url !== 'string') return null;
  const at = url.indexOf('/preview/');
  if (at < 0) return null;
  return decodeURIComponent(url.slice(at + '/preview'.length).split('?')[0]);
}

// Weight shards are read from the VFS in this worker. The preview service
// worker's copy of a 32–50 MB OPFS file comes back EINVAL once hundreds of
// them are in flight.
function installVfsFetch(fs) {
  if (globalThis.fetch.__kevVfs) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const vfsFetch = async (input, init) => {
    const path = previewPath(input);
    if (!path || !path.startsWith('/')) return nativeFetch(input, init);
    const bytes = await fs.readFileBinary(path);
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(body.byteLength),
      },
    });
  };
  vfsFetch.__kevVfs = true;
  globalThis.fetch = vfsFetch;
}

async function openOn(fs, base, dateFacts, providers, log, requireBundle) {
  const kind = providers[0] === 'webgpu' ? 'webgpu' : 'wasm';
  log(`kev: runtime ${kind}${host.hasWebGpu() ? '' : ' (navigator.gpu absent in this worker)'}`);
  const ort = await loadOrt(fs, kind);
  const url = host.previewUrl(base.endsWith('/') ? base : `${base}/`);
  installVfsFetch(fs);
  let finished = 0;
  return loadKev(requireBundle)(url, {
    ort,
    variant: 'q8f32',
    executionProviders: providers,
    dateFacts,
    // One shard at a time. A parallel pair of 50 MB preview reads was the HTTP 500.
    concurrency: 1,
    // The bytes already live in the VFS. Cache Storage quota is smaller than the 9b graph.
    cacheName: null,
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
 * Open a model on WebGPU when the worker has it, falling back to wasm.
 * opts: { model, from, dateFacts, log, requireBundle }
 */
async function openModel(fs, exec, opts = {}) {
  const log = opts.log || (() => {});
  const base = await ensureWeights(fs, exec, opts.model || '0.8b', opts.from || null);
  const dateFacts = opts.dateFacts === true;
  const providers = host.hasWebGpu() ? ['webgpu', 'wasm'] : ['wasm'];
  try {
    return await openOn(fs, base, dateFacts, providers, log, opts.requireBundle);
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    if (providers[0] !== 'webgpu') throw err;
    log(`kev: webgpu failed (${err.message}); retrying on wasm`);
    return openOn(fs, base, dateFacts, ['wasm'], log, opts.requireBundle);
  }
}

async function ready(fs) {
  if (!(await fs.exists(BUNDLE))) return false;
  for (const dir of ORT_DIRS) {
    if (await fs.exists(`${dir}/ort.wasm.bundle.min.mjs`)) return true;
  }
  return false;
}

module.exports = { BUNDLE, DEST, MODELS, ORT_DIRS, openModel, ensureWeights, ready };
