// kev.js and onnxruntime-web are npm dependencies declared in the skill's
// package.json (Renovate keeps them current); `intent pull` installs them
// into the skill's node_modules with ipk, and the runtime requires them.
import { existsSync, readFileSync } from 'fs';
import test, { is, ok } from 'tst';
import * as hostMod from '../scripts/kev/host.js';
import * as kevMod from '../scripts/kev/kev-runtime.js';

const kev = kevMod.default || kevMod;
const host = hostMod.default || hostMod;

// From the skill directory (tst) or the repo root.
const at = (rel) => (existsSync(rel) ? rel : `skills/intent/${rel}`);
const read = (rel) => readFileSync(at(rel), 'utf8');
const pkg = () => JSON.parse(read('package.json'));

function vfs(files) {
  return {
    async exists(p) {
      return p in files;
    },
    async readFile(p) {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
  };
}

test('package.json declares kev.js and onnxruntime-web, pinned, and nothing to build', () => {
  const p = pkg();
  ok(/^\d+\.\d+\.\d+$/.test(p.dependencies['@ai-ecoverse/kev.js']), 'kev.js pinned exactly');
  ok(/^\d+\.\d+\.\d+$/.test(p.dependencies['onnxruntime-web']), 'onnxruntime-web pinned exactly');
  // ipk install also installs devDependencies: none.
  is(p.devDependencies, undefined);
});

test('the runtime versions are the package.json ones, nowhere else', async () => {
  const deps = pkg().dependencies;
  // Read through the VFS at run time: tst cannot load a required .json.
  is(await kev.declaredDeps(vfs({ '/s/package.json': read('package.json') }), '/s'), deps);
  for (const rel of [
    'scripts/kev/host.js',
    'scripts/kev/kev-runtime.js',
    'scripts/intent-core.js',
    'scripts/intent.jsh',
    'scripts/intent-arm.jsh',
  ]) {
    const src = read(rel);
    for (const v of Object.values(deps)) ok(!src.includes(v), `${rel} names ${v}`);
    ok(!/require\([^)]*package\.json/.test(src), `${rel} requires a package.json`);
  }
});

test('the runtime requires kev.js by its package name: no committed bundle, no build', () => {
  ok(read('scripts/kev/kev-runtime.js').includes("require('@ai-ecoverse/kev.js')"));
  for (const gone of [
    'scripts/kev/kev-bundle.cjs',
    'scripts/kev/build.mjs',
    'scripts/kev/package.json',
    'scripts/kev/kev-entry.mjs',
  ]) {
    ok(!existsSync(at(gone)), `${gone} is gone`);
  }
});

test('ready: both packages installed in the skill at their declared versions', async () => {
  const deps = pkg().dependencies;
  const root = '/workspace/skills/intent';
  const nm = `${root}/node_modules`;
  const files = {
    [`${root}/package.json`]: read('package.json'),
    [`${nm}/@ai-ecoverse/kev.js/package.json`]: JSON.stringify({
      version: deps['@ai-ecoverse/kev.js'],
    }),
    [`${nm}/onnxruntime-web/package.json`]: JSON.stringify({ version: deps['onnxruntime-web'] }),
    [`${nm}/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs`]: '',
    [`${nm}/onnxruntime-web/dist/ort.wasm.bundle.min.mjs`]: '',
  };
  is(await kev.depsStatus(vfs(files), root), { ok: true, missing: [] });
  const stale = {
    ...files,
    [`${nm}/@ai-ecoverse/kev.js/package.json`]: JSON.stringify({ version: '0.0.1' }),
  };
  const s = await kev.depsStatus(vfs(stale), root);
  ok(!s.ok && s.missing[0].includes('@ai-ecoverse/kev.js'), JSON.stringify(s));
  is(
    (await kev.depsStatus(vfs({ [`${root}/package.json`]: read('package.json') }), root)).missing
      .length,
    2
  );
});

test('installDeps: ipk install in the skill root, a path no shell can misread', async () => {
  const ran = [];
  const exec = async (cmd) => {
    ran.push(cmd);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await host.installDeps(exec, '/workspace/skills/intent');
  is(ran, ["cd '/workspace/skills/intent' && ipk install"]);
  const err = await host.installDeps(exec, "/x'; rm -rf /; '").then(
    () => null,
    (e) => e
  );
  ok(err && /skill directory/.test(err.message), String(err));
  is(ran.length, 1);
});
