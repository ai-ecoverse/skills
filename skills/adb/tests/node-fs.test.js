import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { exitStub, load } from './extract.js';
import { nodeFs } from './node-fs.js';

// adb reads its key and writes screencaps / pulled files with Node's fs
// (existsSync, fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve;
// SLICC 6's fs.exists / writeFileBinary do not exist on 7 (#487). The commands
// run are the shipped ones, with the USB session stubbed.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/adb.jsh'), 'utf8');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

function deviceScope(vfs, result, extra = {}) {
  const exit = exitStub();
  const out = [];
  return {
    exit,
    out,
    scope: {
      fs: vfs,
      dec: new TextDecoder(),
      withDevice: async (_flags, fn) => fn({}, { features: new Set(['shell_v2']) }),
      runCommand: async () => result,
      shellQuote: (v) => `'${v}'`,
      cli: { die: exit.die, out: (v) => out.push(v) },
      color: new Proxy({}, { get: () => (s) => String(s) }),
      console: { log: (...a) => out.push(a.join(' ')) },
      ...extra,
    },
  };
}

test('screencap writes the PNG the device returned', async () => {
  const vfs = nodeFs();
  const { scope, exit, out } = deviceScope(vfs, {
    exitCode: 0,
    stdout: PNG,
    stderr: new Uint8Array(),
  });
  await load(SOURCE, ['cmdScreencap'], scope).cmdScreencap({ json: true }, ['/shared/s.png']);
  is(exit.dies, []);
  is(Array.from(vfs.files['/shared/s.png']), Array.from(PNG));
  is(out, [{ path: '/shared/s.png', bytes: 10 }]);
});

test('pull writes the remote file locally', async () => {
  const vfs = nodeFs();
  const data = new TextEncoder().encode('hello from the phone');
  const { scope, exit } = deviceScope(vfs, { exitCode: 0, stdout: data, stderr: new Uint8Array() });
  await load(SOURCE, ['cmdPull'], scope).cmdPull({ json: true }, [
    '/sdcard/a.txt',
    '/shared/a.txt',
  ]);
  is(exit.dies, []);
  is(vfs.text('/shared/a.txt'), 'hello from the phone');
});

test('a missing key dies with where to put one', async () => {
  const exit = exitStub();
  const { loadKey } = load(SOURCE, ['loadKey'], {
    fs: nodeFs(),
    skill: { config: async () => ({}) },
    cli: { die: exit.die },
  });
  let err = null;
  try {
    await loadKey({});
  } catch (e) {
    err = e;
  }
  ok(err && /no private key at \/workspace\/\.adb\/adbkey/.test(err.message), String(err));
});
