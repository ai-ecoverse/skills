// Install and download helpers for the kev runtime (`intent pull`): the
// skill's npm dependencies (package.json, installed with ipk into the
// skill's node_modules), the transpiler the realm needs for kev.js's ES
// modules, the hf weight download, and loading ort's browser bundle in the
// worker.

const pkg = require('../../package.json');

const ORT_NAME = 'onnxruntime-web';
const ORT_SPEC = `${ORT_NAME}@${pkg.dependencies[ORT_NAME]}`;
// Every bundle kev may import: webgpu when navigator.gpu exists, wasm as
// the retry.
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
 * Install the skill's dependencies (package.json) into <root>/node_modules:
 * `ipk install` reads the package.json of the directory it runs in, and
 * exec.spawn has no cwd, so this goes through a shell. The root is quoted,
 * and anything but a plain path is refused before a shell sees it.
 */
async function installDeps(exec, root) {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(String(root)) || String(root).split('/').includes('..')) {
    throw new Error(`not a skill directory: ${JSON.stringify(String(root).slice(0, 80))}`);
  }
  const result = await exec(`cd '${root}' && ipk install`);
  if (result.exitCode !== 0) {
    const detail = tail(result.stderr || result.stdout);
    throw new Error(
      `ipk install in ${root} failed (${result.exitCode})${detail ? `: ${detail}` : ''}`
    );
  }
  return result;
}

/**
 * The realm transpiles kev.js (ES modules) to CommonJS with esbuild-wasm (or
 * TypeScript) from the VFS. Without either, install the esbuild-wasm the
 * shell's own `esbuild` names. → 'ready' | 'installed'
 */
async function ensureEsbuild(exec) {
  const probe = await exec.spawn(['esbuild', '--version']);
  if (probe.exitCode === 0) return 'ready';
  const text = `${probe.stderr || ''}\n${probe.stdout || ''}`;
  const hinted = /esbuild-wasm@(\d+\.\d+\.\d+)/.exec(text);
  if (!hinted) {
    throw new Error(
      `no esbuild-wasm to load kev.js with, and the shell names no version to install: ${tail(text)}`
    );
  }
  await run(exec, ['ipk', 'add', '-g', `esbuild-wasm@${hinted[1]}`]);
  return 'installed';
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
  installDeps,
  ensureEsbuild,
  readPackageVersion,
  ORT_SPEC,
  ORT_NAME,
  ORT_BUNDLES,
  resolvePath,
  previewUrl,
  hasWebGpu,
  run,
  versionOfSpec,
  checkOrtVersion,
  hfDownload,
  nativeImport,
  configureOrt,
  browserForEmscripten,
};
