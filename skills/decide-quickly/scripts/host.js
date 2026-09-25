// Install, bundle, and weight helpers shared by kev.jsh and cua-s1.jsh.
// Kept free of a top-level require() of the model: the realm's module graph
// is fixed when the script starts, so a bundle written during this process
// is required only by the re-exec'd child.

const PACKAGE_ROOTS = ['/shared/lib/node_modules', '/workspace/node_modules'];
const ESBUILD_FALLBACK = 'esbuild-wasm@0.28.2';
// kev and cua-s1 load the same global copy, so they share one pin.
const ORT_SPEC = 'onnxruntime-web@1.30.0';
const ORT_NAME = 'onnxruntime-web';
// The file the loaders probe for. The first root that has it is the copy loaded.
const ORT_PROBE = 'dist/ort.wasm.bundle.min.mjs';

function parentDir(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

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

function packageSatisfies(installedVersion, spec) {
  const want = versionOfSpec(spec);
  if (!want) return true;
  return installedVersion === want;
}

async function packageDir(fs, name) {
  for (const root of PACKAGE_ROOTS) {
    const dir = `${root}/${name}`;
    if (await fs.exists(`${dir}/package.json`)) return dir;
  }
  return null;
}

async function readPackageVersion(fs, dir) {
  const pkg = JSON.parse(await fs.readFile(`${dir}/package.json`));
  return typeof pkg.version === 'string' ? pkg.version : '';
}

async function ensurePackage(exec, fs, spec, name) {
  const want = versionOfSpec(spec);
  const existing = await packageDir(fs, name);
  if (existing) {
    const got = await readPackageVersion(fs, existing);
    if (packageSatisfies(got, spec)) return existing;
    console.error(`${name}: have ${got || 'unknown'}, need ${want}`);
  } else {
    console.error(`${name}: ipk add -g ${spec}`);
  }
  await run(exec, ['ipk', 'add', '-g', spec]);
  const installed = await packageDir(fs, name);
  if (!installed) {
    throw new Error(
      `ipk add -g ${spec} finished, but ${name} is not under ${PACKAGE_ROOTS.join(' or ')}`
    );
  }
  const got = await readPackageVersion(fs, installed);
  if (!packageSatisfies(got, spec)) {
    throw new Error(`${name} is ${got || 'unknown'} after ipk add -g ${spec}`);
  }
  return installed;
}

/**
 * Decide whether a pinned copy has to be installed.
 * copies: [{ dir, hasProbe, version }] in PACKAGE_ROOTS order. version is null
 * when package.json is missing or unreadable.
 * The loader takes the first copy that has the probe file, so only that copy is
 * judged: a pinned copy later in the order does not rescue a stale earlier one.
 * The pin is exact, so a newer copy is replaced too.
 */
function planPinnedCopy(copies, want) {
  const loaded = copies.find((copy) => copy.hasProbe);
  if (!loaded) return { install: true, dir: null, version: null };
  return { install: loaded.version !== want, dir: loaded.dir, version: loaded.version };
}

function describeCopy(plan, name, probe) {
  if (!plan.dir) return `no ${name}/${probe} under ${PACKAGE_ROOTS.join(' or ')}`;
  return `${plan.dir} is ${plan.version || 'unknown (no readable package.json)'}`;
}

async function listCopies(fs, name, probe) {
  const copies = [];
  for (const root of PACKAGE_ROOTS) {
    const dir = `${root}/${name}`;
    const hasProbe = await fs.exists(`${dir}/${probe}`);
    let version = null;
    if (hasProbe) {
      try {
        version = (await readPackageVersion(fs, dir)) || null;
      } catch {
        version = null;
      }
    }
    copies.push({ dir, hasProbe, version });
  }
  return copies;
}

/**
 * Make the copy the loader will pick match spec exactly, installing with
 * ipk add -g when it does not. Returns { dir, installed }. Throws, naming both
 * versions and the path, when the install does not fix the loaded copy.
 */
async function ensurePinnedCopy(exec, fs, spec, name, probe) {
  const want = versionOfSpec(spec);
  const before = planPinnedCopy(await listCopies(fs, name, probe), want);
  if (!before.install) return { dir: before.dir, installed: false };
  console.error(`${name}: ${describeCopy(before, name, probe)}, need ${want}; ipk add -g ${spec}`);
  await run(exec, ['ipk', 'add', '-g', spec]);
  const after = planPinnedCopy(await listCopies(fs, name, probe), want);
  if (after.install) {
    throw new Error(
      `${name}: need ${want}, but after ipk add -g ${spec} ${describeCopy(after, name, probe)}`
    );
  }
  return { dir: after.dir, installed: true };
}

function ensureOrt(exec, fs) {
  return ensurePinnedCopy(exec, fs, ORT_SPEC, ORT_NAME, ORT_PROBE);
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

async function ensureEsbuild(exec, fs) {
  const probe = await exec.spawn(['esbuild', '--version']);
  const text = `${probe.stderr || ''}\n${probe.stdout || ''}`;
  const hinted = text.match(/esbuild-wasm@(\d+\.\d+\.\d+)/);
  const printed = text.match(/\b(\d+\.\d+\.\d+)\b/);
  const version =
    (hinted && hinted[1]) ||
    (probe.exitCode === 0 && printed && printed[1]) ||
    versionOfSpec(ESBUILD_FALLBACK);
  await ensurePackage(exec, fs, `esbuild-wasm@${version}`, 'esbuild-wasm');
}

// parseFlags is greedy: `--json billing:noul:…` stores the question as the
// flag's string value. These names are booleans, so put that word back.
function normalizeFlags(parsed, boolNames) {
  for (const name of boolNames) {
    const value = parsed.flags[name];
    if (typeof value !== 'string') continue;
    if (value === 'false' || value === '0') {
      parsed.flags[name] = false;
      continue;
    }
    parsed.flags[name] = true;
    if (value !== 'true' && value !== '1' && value !== '') parsed.positional.push(value);
  }
  return parsed;
}

async function readStamp(fs, stampPath) {
  try {
    return String(await fs.readFile(stampPath)).trim();
  } catch {
    return '';
  }
}

/**
 * Bundle entry.mjs when the stamp does not match the installed package version.
 * Returns true when this process wrote a new bundle (the caller must re-exec
 * before require()ing it).
 */
async function ensureBundle(exec, fs, opts) {
  const dirs = [];
  for (const pkg of opts.packages) {
    dirs.push(await ensurePackage(exec, fs, pkg.spec, pkg.name));
  }
  await ensureEsbuild(exec, fs);
  const versions = [];
  for (let i = 0; i < opts.packages.length; i++) {
    const pkg = JSON.parse(await fs.readFile(`${dirs[i]}/package.json`));
    versions.push(`${opts.packages[i].name}@${pkg.version}`);
  }
  const stamp = versions.join(' ');
  const stampPath = `${opts.outfile}.stamp`;
  if ((await fs.exists(opts.outfile)) && (await readStamp(fs, stampPath)) === stamp) return false;
  await fs.mkdir(parentDir(opts.outfile), { recursive: true });
  console.error(`esbuild: bundling ${opts.entry}`);
  await run(exec, [
    'esbuild',
    '--bundle',
    opts.entry,
    '--outfile',
    opts.outfile,
    '--format=cjs',
    '--platform=browser',
  ]);
  await fs.writeFile(stampPath, `${stamp}\n`);
  return true;
}

async function hfDownload(exec, repo, files, dest) {
  console.error(`hf download ${repo} (${files.length} files) -> ${dest}`);
  await run(exec, ['hf', 'download', repo, ...files, '--to', dest]);
}

function childEnv(extra) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

async function reexec(exec, envName) {
  const stdin = process.stdin.read();
  const handle = exec.start(['node', process.argv[1], ...process.argv.slice(2)], {
    stdin: stdin == null ? '' : stdin,
    env: childEnv({ [envName]: '1' }),
  });
  handle.stdin.end();
  const result = await handle.done;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode || 0);
}

function nativeImport(url) {
  // A direct import() in this file would be lowered to require(). The ort
  // bundles then look up their wasm siblings through the realm and miss.
  // A function built from a string keeps the worker's own import().
  const importer = new Function('specifier', 'return import(specifier)');
  return importer(url);
}

function configureOrt(ort, distDir) {
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
  ORT_PROBE,
  resolvePath,
  previewUrl,
  hasWebGpu,
  run,
  packageDir,
  versionOfSpec,
  packageSatisfies,
  ensurePackage,
  planPinnedCopy,
  ensurePinnedCopy,
  ensureOrt,
  checkOrtVersion,
  ensureEsbuild,
  normalizeFlags,
  ensureBundle,
  hfDownload,
  reexec,
  nativeImport,
  configureOrt,
};
