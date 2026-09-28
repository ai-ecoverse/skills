import * as fsMod from 'fs';
import test, { is } from 'tst';
import * as hostMod from '../scripts/host.js';

const host = hostMod.default || hostMod;
const realFs = fsMod.default || fsMod;

const GLOBAL = '/shared/lib/node_modules/onnxruntime-web';
const LOCAL = '/workspace/node_modules/onnxruntime-web';
const PIN = host.versionOfSpec(host.ORT_SPEC);

// The bundles an onnxruntime-web install ships, spelled out rather than read
// from host.js, so this file also runs against an older host.js.
const WASM = 'dist/ort.wasm.bundle.min.mjs';
const WEBGPU = 'dist/ort.webgpu.bundle.min.mjs';

// kev.jsh: webgpu when navigator.gpu exists, and wasm for the retry. cua-s1: wasm.
function bundleFor(kind) {
  return kind === 'webgpu' ? WEBGPU : WASM;
}

// A copy is what an install leaves: package.json plus its bundles.
function copy(dir, version, bundles = [WASM, WEBGPU]) {
  const files = {};
  for (const bundle of bundles) files[`${dir}/${bundle}`] = '// bundle';
  if (version != null) files[`${dir}/package.json`] = JSON.stringify({ version });
  return files;
}

function fakeFs(files) {
  return {
    files,
    exists: async (path) => Object.hasOwn(files, path),
    readFile: async (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
  };
}

// ipk add -g writes the global root. installs is the version it leaves there,
// bundles the files it leaves.
function fakeExec(fs, installs, bundles) {
  const calls = [];
  return {
    calls,
    spawn: async (argv) => {
      calls.push(argv.join(' '));
      Object.assign(fs.files, copy(GLOBAL, installs, bundles));
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

async function gate(files, installs = PIN, bundles = undefined) {
  const fs = fakeFs({ ...files });
  const exec = fakeExec(fs, installs, bundles);
  let result = null;
  let error = '';
  try {
    result = await host.ensureOrt(exec, fs);
  } catch (err) {
    error = err.message;
  }
  return { result, error, calls: exec.calls, fs };
}

test('the pin is one exact version', () => {
  is(host.ORT_SPEC, 'onnxruntime-web@1.30.0');
  is(PIN, '1.30.0');
});

test('an older copy at the first root is replaced', async () => {
  const { result, calls } = await gate(copy(GLOBAL, '1.29.0'));
  is(calls, [`ipk add -g ${host.ORT_SPEC}`]);
  is(result, { dir: GLOBAL, installed: true });
});

test('an exact match installs nothing', async () => {
  const { result, calls } = await gate(copy(GLOBAL, PIN));
  is(calls, []);
  is(result, { dir: GLOBAL, installed: false });
});

test('a bundle without package.json is replaced', async () => {
  const { result, calls } = await gate(copy(GLOBAL, null));
  is(calls.length, 1);
  is(result, { dir: GLOBAL, installed: true });
});

test('no copy at all is installed', async () => {
  const { result, calls } = await gate({});
  is(calls.length, 1);
  is(result, { dir: GLOBAL, installed: true });
});

test('a newer copy is replaced: the pin is exact', async () => {
  const { result, calls } = await gate(copy(GLOBAL, '1.31.0'));
  is(calls.length, 1);
  is(result, { dir: GLOBAL, installed: true });
});

test('a stale first root is replaced even when a later root has the pin', async () => {
  const plan = host.planPinnedCopy(
    [
      { dir: GLOBAL, hasProbe: true, version: '1.29.0' },
      { dir: LOCAL, hasProbe: true, version: PIN },
    ],
    PIN
  );
  is(plan, { install: true, dir: GLOBAL, version: '1.29.0' });
  const { result, calls } = await gate({ ...copy(GLOBAL, '1.29.0'), ...copy(LOCAL, PIN) });
  is(calls.length, 1);
  is(result, { dir: GLOBAL, installed: true });
});

test('a pinned copy under the second root is used when the first root has none', async () => {
  const { result, calls } = await gate(copy(LOCAL, PIN));
  is(calls, []);
  is(result, { dir: LOCAL, installed: false });
});

test('a stale second root is replaced by a global install that loads first', async () => {
  const { result, calls } = await gate(copy(LOCAL, '1.29.0'));
  is(calls.length, 1);
  is(result, { dir: GLOBAL, installed: true });
});

test('an install that leaves the loaded copy stale names both versions and the path', async () => {
  const { result, error } = await gate(copy(GLOBAL, '1.29.0'), '1.29.0');
  is(result, null);
  is(error.includes('1.29.0'), true);
  is(error.includes(PIN), true);
  is(error.includes(GLOBAL), true);
});

test('the loaded module is checked against the pin', () => {
  const ok = { env: { versions: { common: PIN, web: PIN } } };
  is(host.checkOrtVersion(ok, GLOBAL), ok);
  const bare = { env: {} };
  is(host.checkOrtVersion(bare, GLOBAL), bare);
  let message = '';
  try {
    host.checkOrtVersion({ env: { versions: { web: '1.29.0' } } }, GLOBAL);
  } catch (err) {
    message = err.message;
  }
  is(message, `onnxruntime-web: loaded 1.29.0 from ${GLOBAL}, need ${PIN}`);
});

// tst runs with the skill folder as the working directory.
test('both scripts gate onnxruntime-web through host.ensureOrt only', async () => {
  for (const script of ['scripts/kev.jsh', 'scripts/cua-s1.jsh']) {
    const source = String(await realFs.readFile(script));
    is([script, source.includes('host.ensureOrt(exec, fs)')], [script, true]);
    is([script, source.includes('onnxruntime-web@')], [script, false]);
    is([script, source.includes('node_modules/onnxruntime-web')], [script, false]);
  }
});

// Codex review on #432: the gate probed only the wasm bundle, so an exact-version
// root without the webgpu bundle passed, kev's webgpu load failed, and it fell
// back to wasm although the next root had a complete copy.
test('webgpu: a first root without the webgpu bundle yields to a complete later copy', async () => {
  const { result, calls, fs } = await gate({
    ...copy(GLOBAL, PIN, [WASM]),
    ...copy(LOCAL, PIN),
  });
  is(calls, []);
  is(result, { dir: LOCAL, installed: false });
  // What kev loads with navigator.gpu present, then on its wasm retry.
  is(await fs.exists(`${result.dir}/${bundleFor('webgpu')}`), true);
  is(await fs.exists(`${result.dir}/${bundleFor('wasm')}`), true);
});

test('no webgpu: a complete exact copy is used as is', async () => {
  const { result, calls, fs } = await gate(copy(GLOBAL, PIN));
  is(calls, []);
  is(result, { dir: GLOBAL, installed: false });
  is(await fs.exists(`${result.dir}/${bundleFor('wasm')}`), true);
});

test('no webgpu: a wasm-only copy is still reinstalled, so every worker gets one copy', async () => {
  const { result, calls, fs } = await gate(copy(GLOBAL, PIN, [WASM]));
  is(calls, [`ipk add -g ${host.ORT_SPEC}`]);
  is(result, { dir: GLOBAL, installed: true });
  is(await fs.exists(`${GLOBAL}/${WEBGPU}`), true);
});

test('an install that leaves out the webgpu bundle names the file and the path', async () => {
  const { result, error } = await gate(copy(GLOBAL, PIN, [WASM]), PIN, [WASM]);
  is(result, null);
  is(error.includes(`${GLOBAL} lacks ${WEBGPU}`), true);
  is(error.includes(`${LOCAL} is absent`), true);
});

test('the gate probes every bundle the scripts import', async () => {
  const probed = host.ORT_BUNDLES || [];
  for (const script of ['scripts/kev.jsh', 'scripts/cua-s1.jsh']) {
    const source = String(await realFs.readFile(script));
    const imported = source.match(/ort\.[a-z]+\.bundle\.min\.mjs/g) || [];
    is([script, imported.length > 0], [script, true]);
    for (const name of imported) {
      is([script, name, probed.includes(`dist/${name}`)], [script, name, true]);
    }
  }
});
