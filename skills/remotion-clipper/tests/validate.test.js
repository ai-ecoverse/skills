import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

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
async function remotion(args, files = {}) {
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
  const vfs = {
    exists: async (p) => Object.hasOwn(files, p),
    readFile: async (p) => {
      if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
  };
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

const EDL = '/shared/clip/edl.json';
const goodEdl = {
  fps: 30,
  width: 1080,
  height: 1920,
  segments: [
    {
      shot: 'split',
      durationSec: 4,
      top: { src: 'host.webm', inSec: 0 },
      bottom: { src: 'guest.webm', inSec: 1.5 },
      audioFrom: 'both',
    },
    { shot: 'portrait-interviewee', durationSec: 2.5, source: { src: 'guest.webm', inSec: 10 } },
  ],
};

test('validate accepts a well-formed EDL and exits 0', async () => {
  const r = await remotion(['validate', EDL, '--no-check-media'], {
    [EDL]: JSON.stringify(goodEdl),
  });
  is(r.exitCode, 0);
  ok(r.stdout.includes(`✓ ${EDL} is valid (2 segments)`), 'stdout');
  ok(!r.stdout.includes('errors'), 'stdout');
});

test('validate reports every structural error and exits 1', async () => {
  const bad = {
    fps: 0,
    width: 1080,
    height: 1920,
    segments: [
      { shot: 'wide', durationSec: 3, source: { src: 'a.webm', inSec: 0 } },
      {
        shot: 'split',
        durationSec: -1,
        top: { src: '', inSec: 0 },
        bottom: { src: 'b.webm', inSec: -2 },
        audioFrom: 'left',
      },
      {
        shot: 'portrait-interviewer',
        durationSec: 1,
        top: { src: 'x', inSec: 0 },
        source: { src: 'c.webm', inSec: 0 },
      },
    ],
  };
  const r = await remotion(['validate', EDL, '--no-check-media'], { [EDL]: JSON.stringify(bad) });
  is(r.exitCode, 1);
  for (const expected of [
    'root.fps must be a positive number (got 0)',
    'segments[0]: unknown shot "wide"',
    'segments[1]: "durationSec" must be a positive number (got -1)',
    'segments[1].top: missing or empty "src"',
    'segments[1].bottom: "inSec" must be a number >= 0 (got -2)',
    'segments[1]: "audioFrom" must be "top", "bottom", or "both" (got "left")',
  ])
    ok(r.stdout.includes(expected), expected);
  ok(r.stdout.includes('errors (6):'), 'stdout');
  ok(r.stdout.includes('segments[2]: has stray "top"/"bottom" fields'), 'stdout');
});

test('validate rejects an EDL with no segments', async () => {
  const r = await remotion(['validate', EDL, '--no-check-media'], {
    [EDL]: JSON.stringify({ fps: 30, width: 1, height: 1, segments: [] }),
  });
  is(r.exitCode, 1);
  ok(r.stdout.includes('root.segments must be a non-empty array'), 'stdout');
});

test('validate dies with an actionable message for missing or malformed files', async () => {
  const missing = await remotion(['validate', EDL, '--no-check-media']);
  is(missing.exitCode, 1);
  ok(missing.stderr.includes(`no such file: ${EDL}`), 'stderr');

  const malformed = await remotion(['validate', EDL, '--no-check-media'], { [EDL]: '{"fps": 30,' });
  is(malformed.exitCode, 1);
  ok(malformed.stderr.includes(`${EDL} is not valid JSON`), 'stderr');

  const usage = await remotion(['validate']);
  is(usage.exitCode, 1);
  ok(usage.stderr.includes('usage: remotion validate'), 'stderr');
});
