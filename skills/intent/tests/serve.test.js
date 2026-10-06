// intent serve's loop and the kev runtime's messages, against an in-memory VFS.
import test, { is, ok } from 'tst';
import * as coreMod from '../scripts/intent-core.js';
import * as kevMod from '../scripts/kev/kev-runtime.js';

const core = coreMod.default || coreMod;
const kev = kevMod.default || kevMod;

function memFs() {
  const files = new Map();
  const written = [];
  return {
    files,
    written,
    async exists(p) {
      return files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`));
    },
    async readFile(p) {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p);
    },
    async writeFile(p, v) {
      files.set(p, String(v));
      written.push([p, String(v)]);
    },
    async mkdir() {},
    async rm(p) {
      files.delete(p);
    },
    async readDir(d) {
      return [...files.keys()]
        .filter((k) => k.startsWith(`${d}/`))
        .map((k) => k.slice(d.length + 1))
        .filter((n) => !n.includes('/'));
    },
  };
}

const exitError = () => Object.assign(new Error('exit 3'), { name: 'NodeExitError' });

function serveOnce(fs, exec, flags = {}) {
  const { serve } = core.createIntent({
    exec,
    fs,
    browser: { eval: async () => null },
    skill: { config: async () => null },
    requireBundle: () => ({}),
  });
  let rounds = 0;
  return serve(flags, { stop: () => rounds++ > 0 });
}

test('serve: the heartbeat names the model it serves, the local default without --model', async () => {
  const fs = memFs();
  await serveOnce(fs, { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const beats = fs.written.filter(([p]) => p === core.BEAT).map(([, v]) => JSON.parse(v));
  ok(beats.length, 'a heartbeat was written');
  is(beats[0].model, '4b-vision');
  ok(!fs.files.has(core.BEAT), 'the heartbeat goes when the server stops');
});

test('serve: an exit (NodeExitError) ends the server instead of becoming an answer', async () => {
  const fs = memFs();
  fs.files.set(
    `${core.DIR}/q/r1.json`,
    JSON.stringify({ intent: 'see the page', argv: ['snapshot', '--tab=AB12'] })
  );
  const exec = {
    spawn: async () => {
      throw exitError();
    },
  };
  const err = await serveOnce(fs, exec).then(
    () => null,
    (e) => e
  );
  is(err && err.name, 'NodeExitError');
  ok(!fs.files.has(`${core.DIR}/a/r1.json`), 'no answer file for an exit');
  ok(!fs.files.has(core.BEAT), 'the heartbeat goes with it');
});

test('kev runtime: a missing model names the intent command that gets it', () => {
  const msg = kev.missingWeightsMessage({
    model: '4b-vision',
    base: '/x',
    manifest: false,
    files: 0,
    missing: ['manifest.json'],
  });
  ok(msg.includes('intent pull --model 4b-vision'), msg);
  ok(!/\bkev (pull|prepare)\b/.test(msg), msg);
});
