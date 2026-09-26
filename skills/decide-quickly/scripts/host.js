// Install, bundle, and weight helpers shared by kev.jsh and cua-s1.jsh.
// Kept free of a top-level require() of the model: the realm's module graph
// is fixed when the script starts, so a bundle written during this process
// is required only by the re-exec'd child.

const PACKAGE_ROOTS = ['/shared/lib/node_modules', '/workspace/node_modules'];
const ESBUILD_FALLBACK = 'esbuild-wasm@0.28.2';

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
  resolvePath,
  previewUrl,
  hasWebGpu,
  run,
  packageDir,
  versionOfSpec,
  packageSatisfies,
  ensurePackage,
  ensureEsbuild,
  normalizeFlags,
  ensureBundle,
  hfDownload,
  reexec,
  nativeImport,
  configureOrt,
};
