import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// eleven, say-11 and hear-11 write and check audio files with Node's fs
// (fs.promises, existsSync), which slicc-jsh (SLICC 7) and SLICC 6 both
// serve; the SLICC 6 promise dialect fails under Node semantics (#487).
// Each runs the shipped script with elevenlib (the API client) stubbed.
const read = (f) => fs.readFileSync(path.join(process.cwd(), 'scripts', f), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const AUDIO = new Uint8Array([73, 68, 51, 4, 0, 0]);

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { flags, positional };
}

async function run(script, args, vfs, lib = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const L = new Proxy(lib, {
    get: (t, k) =>
      k in t
        ? t[k]
        : async (...a) => {
            calls.push([k, ...a]);
            return k === 'loadConfig' ? {} : k === 'tts' ? AUDIO : 'v1';
          },
  });
  const cli = {
    die: (m) => {
      err.push(String(m));
      throw new NodeExitError(1);
    },
    help: (t) => {
      out.push(t);
      throw new NodeExitError(0);
    },
    out: (v) => out.push(typeof v === 'string' ? v : JSON.stringify(v)),
  };
  const modules = {
    fs: vfs,
    'sliccy:cli': cli,
    'sliccy:fmt': { trunc: (s) => s, table: () => '' },
    './elevenlib.jsh': L,
  };
  const argv = ['node', script, ...args];
  argv.parseFlags = () => parseFlags(args);
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', read(script))(
      (id) => {
        if (id in modules) return modules[id];
        throw new Error(`unexpected require(${id})`);
      },
      { argv, env: {} },
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) }
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls };
}

test('eleven tts --out writes the audio bytes', async () => {
  const vfs = nodeFs();
  const r = await run('eleven.jsh', ['tts', 'Hallo', '--out', '/shared/hallo.mp3'], vfs);
  is(r.code, 0, r.stderr);
  is(Array.from(vfs.files['/shared/hallo.mp3']), Array.from(AUDIO));
  ok(r.stdout.includes('Wrote 6 bytes to /shared/hallo.mp3'));
});

test('say-11 --out writes the audio bytes', async () => {
  const vfs = nodeFs();
  const r = await run('say-11.jsh', ['Hallo', '--out', '/shared/say.mp3'], vfs);
  is(r.code, 0, r.stderr);
  is(Array.from(vfs.files['/shared/say.mp3']), Array.from(AUDIO));
});

test('hear-11 checks that the input file exists before transcribing', async () => {
  const missing = await run('hear-11.jsh', ['/shared/none.wav'], nodeFs());
  is(missing.code, 1);
  ok(missing.stderr.includes('file not found: /shared/none.wav'));
  const there = await run('hear-11.jsh', ['/shared/in.wav'], nodeFs({ '/shared/in.wav': 'RIFF' }), {
    stt: async () => ({ text: 'hallo welt' }),
  });
  is(there.code, 0, there.stderr);
  ok(there.stdout.includes('hallo welt'), there.stdout);
});
