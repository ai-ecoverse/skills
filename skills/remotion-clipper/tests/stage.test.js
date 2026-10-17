import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// Skill root: tst runs from the installed skill dir (CI + local harness).
const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/remotion.jsh');
const source = fs.readFileSync(SCRIPT, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

// Runs the real remotion.jsh against an in-memory VFS. Only the runtime's I/O
// surface is supplied (fs, cli, color, argv); validateEdl itself is untouched.
async function remotion(args, vfs) {
  const stdout = [];
  const stderr = [];
  const argv = ['node', '/workspace/skills/remotion-clipper/scripts/remotion.jsh', ...args];
  argv.parseFlags = () => {
    const positional = [];
    const flags = {};
    for (const a of args) {
      if (a.startsWith('--')) flags[a.slice(2)] = true;
      else positional.push(a);
    }
    return { positional, flags, subcommand: positional[0] || '' };
  };
  // Node's fs shape (existsSync, fs.promises), as slicc-jsh and SLICC 6 both
  // serve it (ai-ecoverse/skills#487).
  const exit = (code) => {
    throw new NodeExitError('exit', code);
  };
  const modules = {
    fs: vfs,
    'sliccy:cli': {
      die: (msg, opts) => {
        stderr.push(`Error: ${msg}`);
        exit(opts?.exitCode ?? 1);
      },
      help: (text) => {
        stdout.push(String(text));
        exit(0);
      },
      out: (v) => stdout.push(typeof v === 'string' ? v : JSON.stringify(v)),
      warn: (msg) => stderr.push(String(msg)),
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
  };
  const require = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id];
    throw new Error(`unexpected require(${id}) during validate`);
  };
  const proc = { argv, env: {}, cwd: () => '/shared', exit };
  const cons = {
    log: (...a) => stdout.push(a.join(' ')),
    info: (...a) => stdout.push(a.join(' ')),
    warn: (...a) => stderr.push(a.join(' ')),
    error: (...a) => stderr.push(a.join(' ')),
  };
  let exitCode = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', source)(require, proc, cons);
  } catch (err) {
    if (err?.name !== 'NodeExitError') throw err;
    exitCode = err.exitCode;
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

// stage copies each referenced source next to the EDL with Node's fs
// (stat/readFile/writeFile/mkdir), which slicc-jsh and SLICC 6 both serve;
// the SLICC 6 promise dialect fails under Node semantics (#487).
test('stage copies the sources and writes the staged EDL', async () => {
  const edl = {
    fps: 30,
    width: 1080,
    height: 1920,
    segments: [
      { shot: 'portrait-interviewee', durationSec: 2, source: { src: 'guest.webm', inSec: 0 } },
    ],
  };
  const vfs = nodeFs({
    '/shared/clip/edl.json': JSON.stringify(edl),
    '/shared/clip/guest.webm': new Uint8Array([26, 69, 223, 163, 1, 2, 3]),
  });
  const r = await remotion(['stage', '/shared/clip/edl.json', '/shared/out'], vfs);
  is(r.exitCode, 0, r.stderr);
  is(Array.from(vfs.files['/shared/out/assets/guest.webm']), [26, 69, 223, 163, 1, 2, 3]);
  const staged = JSON.parse(vfs.text('/shared/out/edl.staged.json'));
  is(staged.segments[0].source.src, 'assets/guest.webm');
  ok(r.stdout.length > 0);
});

test('stage reports a source it cannot find and exits 1', async () => {
  const edl = {
    fps: 30,
    width: 1,
    height: 1,
    segments: [
      { shot: 'portrait-interviewee', durationSec: 1, source: { src: 'gone.webm', inSec: 0 } },
    ],
  };
  const vfs = nodeFs({ '/shared/clip/edl.json': JSON.stringify(edl) });
  const r = await remotion(['stage', '/shared/clip/edl.json', '/shared/out'], vfs);
  is(r.exitCode, 1);
});
