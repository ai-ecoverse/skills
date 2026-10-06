// Install and download helpers for the kev runtime (`intent pull`): the
// pinned onnxruntime-web copy, the hf weight download, and loading ort's
// browser bundle in the worker.

const PACKAGE_ROOTS = ['/shared/lib/node_modules', '/workspace/node_modules'];
// One global copy, pinned exactly: the version a session runs on is known.
const ORT_SPEC = 'onnxruntime-web@1.30.0';
const ORT_NAME = 'onnxruntime-web';
// Every bundle kev may import: webgpu when navigator.gpu exists, wasm as
// the retry. A root counts as a copy only with both, so the copy judged is
// the copy that serves whichever loads.
const ORT_BUNDLES = ['dist/ort.wasm.bundle.min.mjs', 'dist/ort.webgpu.bundle.min.mjs'];

function resolvePath(path) {
  if (!path || path.startsWith('/')) return path;
  const cwd = String(process.cwd() || '/').replace(/\/$/, '');
  return `${cwd}/${path}`;
}

function previewUrl(vfsPath) {
  const path = vfsPath.startsWith('/') ? vfsPath : `/${vfsPath}`;
  const previewPath = `/preview${path}`;
  const chrome = globalThis.chrome;
  const getURL = chrome && chrome.runtime && chrome.runtime.getURL;
  if (typeof getURL === 'function') return getURL(previewPath);
  const origin =
    typeof location !== 'undefined' && location.origin ? location.origin : 'http://localhost:5710';
  return origin + previewPath;
}

function hasWebGpu() {
  try {
    return typeof navigator !== 'undefined' && navigator.gpu != null;
  } catch {
    return false;
  }
}

function tail(text) {
  const value = String(text || '').trim();
  return value.length > 2000 ? value.slice(-2000) : value;
}

async function run(exec, argv) {
  const result = await exec.spawn(argv);
  if (result.exitCode !== 0) {
    const detail = tail(result.stderr || result.stdout);
    throw new Error(`${argv[0]} failed (${result.exitCode})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function versionOfSpec(spec) {
  const at = String(spec).lastIndexOf('@');
  if (at <= 0) return null;
  return spec.slice(at + 1);
}

async function readPackageVersion(fs, dir) {
  const pkg = JSON.parse(await fs.readFile(`${dir}/package.json`));
  return typeof pkg.version === 'string' ? pkg.version : '';
}

/**
 * Decide whether a pinned copy has to be installed.
 * copies: [{ dir, hasProbe, version }] in PACKAGE_ROOTS order. hasProbe is true
 * only when the root has every probed file; version is null when package.json
 * is missing or unreadable.
 * The first complete copy is the one loaded, so only that copy is judged: a
 * pinned copy later in the order does not rescue a stale earlier one, and a
 * partial root earlier in the order is skipped.
 * The pin is exact, so a newer copy is replaced too.
 */
function planPinnedCopy(copies, want) {
  const loaded = copies.find((copy) => copy.hasProbe);
  if (!loaded) return { install: true, dir: null, version: null };
  return { install: loaded.version !== want, dir: loaded.dir, version: loaded.version };
}

function describeCopy(plan, copies, probes) {
  if (plan.dir) return `${plan.dir} is ${plan.version || 'unknown (no readable package.json)'}`;
  const roots = copies.map((copy) =>
    copy.missing.length === probes.length
      ? `${copy.dir} is absent`
      : `${copy.dir} lacks ${copy.missing.join(', ')}`
  );
  return `no copy has ${probes.join(' and ')}: ${roots.join('; ')}`;
}

async function listCopies(fs, name, probes) {
  const copies = [];
  for (const root of PACKAGE_ROOTS) {
    const dir = `${root}/${name}`;
    const missing = [];
    for (const probe of probes) {
      if (!(await fs.exists(`${dir}/${probe}`))) missing.push(probe);
    }
    const hasProbe = missing.length === 0;
    let version = null;
    if (hasProbe) {
      try {
        version = (await readPackageVersion(fs, dir)) || null;
      } catch {
        version = null;
      }
    }
    copies.push({ dir, hasProbe, version, missing });
  }
  return copies;
}

/**
 * Make the copy the loader will pick match spec exactly, installing with
 * ipk add -g when it does not. Returns { dir, installed }. Throws, naming both
 * versions and the path, when the install does not fix the loaded copy.
 */
async function ensurePinnedCopy(exec, fs, spec, name, probes) {
  const want = versionOfSpec(spec);
  const copiesBefore = await listCopies(fs, name, probes);
  const before = planPinnedCopy(copiesBefore, want);
  if (!before.install) return { dir: before.dir, installed: false };
  const why = describeCopy(before, copiesBefore, probes);
  console.error(`${name}: ${why}, need ${want}; ipk add -g ${spec}`);
  await run(exec, ['ipk', 'add', '-g', spec]);
  const copiesAfter = await listCopies(fs, name, probes);
  const after = planPinnedCopy(copiesAfter, want);
  if (after.install) {
    const still = describeCopy(after, copiesAfter, probes);
    throw new Error(`${name}: need ${want}, but after ipk add -g ${spec} ${still}`);
  }
  return { dir: after.dir, installed: true };
}

function ensureOrt(exec, fs) {
  return ensurePinnedCopy(exec, fs, ORT_SPEC, ORT_NAME, ORT_BUNDLES);
}

// ort.env.versions.web is set by onnxruntime-web's own entry point. Absent
// means an unusual build: the package.json check already ran, so let it pass.
function checkOrtVersion(ort, dir) {
  const want = versionOfSpec(ORT_SPEC);
  const versions = ort && ort.env && ort.env.versions;
  const got = versions && versions.web;
  if (typeof got === 'string' && got !== want) {
    throw new Error(`${ORT_NAME}: loaded ${got} from ${dir}, need ${want}`);
  }
  return ort;
}

async function hfDownload(exec, repo, files, dest) {
  console.error(`hf download ${repo} (${files.length} files) -> ${dest}`);
  await run(exec, ['hf', 'download', repo, ...files, '--to', dest]);
}

function nativeImport(url) {
  // A direct import() in this file would be lowered to require(). The ort
  // bundles then look up their wasm siblings through the realm and miss.
  // A function built from a string keeps the worker's own import().
  const importer = new Function('specifier', 'return import(specifier)');
  return importer(url);
}

// slicc 98912fb (2026-09-23) puts the realm's process on globalThis with
// versions.node set, so emscripten's own tools detect Node. onnxruntime-web
// is emscripten output too: it then takes the Node path and fails with
// "Failed to resolve module specifier 'worker_threads'". Emscripten treats
// an Electron renderer (process.type === 'renderer') as a browser, which
// this worker is. Set before the first session; the factory reads it then.
function browserForEmscripten() {
  const proc = globalThis.process;
  if (proc && typeof proc === 'object' && proc.versions && proc.versions.node && !proc.type) {
    proc.type = 'renderer';
  }
}

function configureOrt(ort, distDir) {
  browserForEmscripten();
  const wasm = ort && ort.env && ort.env.wasm;
  if (!wasm) return ort;
  if (!wasm.wasmPaths) {
    const dir = distDir.endsWith('/') ? distDir : `${distDir}/`;
    wasm.wasmPaths = previewUrl(dir);
  }
  if (typeof crossOriginIsolated === 'boolean' && !crossOriginIsolated) wasm.numThreads = 1;
  return ort;
}

module.exports = {
  PACKAGE_ROOTS,
  ORT_SPEC,
  ORT_NAME,
  ORT_BUNDLES,
  resolvePath,
  previewUrl,
  hasWebGpu,
  run,
  versionOfSpec,
  planPinnedCopy,
  listCopies,
  ensurePinnedCopy,
  ensureOrt,
  checkOrtVersion,
  hfDownload,
  nativeImport,
  configureOrt,
  browserForEmscripten,
};
