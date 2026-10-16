import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as pageMod from '../scripts/render-page.js';

// Runs the real mermaid.jsh with the runtime's I/O surface supplied: an
// in-memory VFS, sliccy:cli, and an exec that plays the browser. The skill
// root is the cwd when tst runs from the installed skill dir.
const page = pageMod.default || pageMod;
const SCRIPT_DIR = path.join(process.cwd(), 'scripts');
const source = fs.readFileSync(path.join(SCRIPT_DIR, 'mermaid.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PKG = '/workspace/node_modules/mermaid/package.json';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

// A browser whose page rendered `svg`. evalLimit cuts every eval result to
// that many characters, the way an oversized playwright-cli result is cut.
function browser(svg, { evalLimit = Infinity } = {}) {
  const calls = [];
  const spawn = async (argv) => {
    calls.push(argv);
    const [cmd, sub] = argv;
    const reply = (stdout) => ({ exitCode: 0, stdout, stderr: '' });
    if (cmd === 'esbuild') return reply('');
    if (cmd === 'open') return reply(`opened ${argv[1]} (targetId: T1)\n`);
    if (cmd === 'playwright-cli' && sub === 'tab-close') return reply('');
    if (cmd === 'playwright-cli' && sub === 'eval') {
      const expr = argv[argv.length - 1];
      const slice = /textContent\.slice\((\d+), (\d+)\)/.exec(expr);
      const out = slice ? svg.slice(Number(slice[1]), Number(slice[2])) : `ok\n${svg.length}`;
      return reply(`${out.slice(0, evalLimit)}\n`);
    }
    throw new Error(`unexpected spawn ${argv.join(' ')}`);
  };
  return { calls, spawn };
}

async function mermaid(argv, { files = {}, stdin = '', spawn } = {}) {
  const vfs = { ...files };
  const stdout = [];
  const stderr = [];
  const toBytes = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
  const fsStub = {
    exists: async (f) => Object.hasOwn(vfs, f),
    // SLICC 6: one character per byte, not decoded.
    readFile: async (f) => {
      if (!Object.hasOwn(vfs, f)) throw new Error(`ENOENT ${f}`);
      return String.fromCharCode(...toBytes(vfs[f]));
    },
    readFileBinary: async (f) => {
      if (!Object.hasOwn(vfs, f)) throw new Error(`ENOENT ${f}`);
      return toBytes(vfs[f]);
    },
    writeFile: async (f, data) => {
      vfs[f] = data;
    },
    mkdir: async () => {},
    rm: async (f) => {
      delete vfs[f];
    },
    stat: async (f) => {
      if (!Object.hasOwn(vfs, f)) throw new Error('ENOENT');
      return {};
    },
  };
  const exec = {
    spawn: async (argv) => {
      if (!spawn) throw new Error('exec.spawn should not run');
      return spawn(argv, vfs);
    },
  };
  const cli = {
    die(msg, opts = {}) {
      const prefix = opts.prefix === undefined ? 'Error' : opts.prefix;
      stderr.push(prefix === '' ? String(msg) : `${prefix}: ${msg}`);
      throw new NodeExitError(opts.exitCode === undefined ? 1 : opts.exitCode);
    },
    help(text) {
      stdout.push(text);
      throw new NodeExitError(0);
    },
  };
  const modules = {
    fs: fsStub,
    path,
    'sliccy:exec': exec,
    'sliccy:cli': cli,
    './render-page.js': page,
  };
  const req = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`unsupported require(${name})`);
  };
  const proc = {
    argv: ['node', path.join(SCRIPT_DIR, 'mermaid.jsh'), ...argv],
    env: { TMPDIR: '/tmp' },
    cwd: () => '/workspace',
    exit(code = 0) {
      throw new NodeExitError(code);
    },
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    stdin: { read: async () => stdin },
  };
  const cons = {
    log: (...a) => stdout.push(a.join(' ')),
    info: (...a) => stdout.push(a.join(' ')),
    warn: (...a) => stderr.push(a.join(' ')),
    error: (...a) => stderr.push(a.join(' ')),
  };
  let exitCode = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', '__dirname', source)(
      req,
      proc,
      cons,
      SCRIPT_DIR
    );
  } catch (err) {
    if (err?.name !== 'NodeExitError') throw err;
    exitCode = err.code;
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), vfs };
}

const installed = {
  [PKG]: '{"version":"11.17.2"}',
  '/shared/cache/mermaid-11.17.2.iife.js': 'var x;',
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>Start</text></svg>';

test('--help prints the install line and does not render', async () => {
  const r = await mermaid(['--help']);
  is(r.exitCode, 0);
  ok(r.stdout.includes('ipk add -g mermaid esbuild-wasm'));
});

test('bare mermaid with empty stdin prints help without opening a browser', async () => {
  const r = await mermaid([]);
  is(r.exitCode, 0);
  ok(r.stdout.includes('USAGE'));
});

test('a diagram piped with no subcommand is rendered (cat x.mmd | mermaid -o out.svg)', async () => {
  const b = browser(SVG);
  const r = await mermaid(['-o', '/shared/out.svg'], {
    files: installed,
    stdin: 'flowchart LR\n  A[Start] --> B[End]\n',
    spawn: b.spawn,
  });
  is(r.exitCode, 0, r.stderr);
  is(r.vfs['/shared/out.svg'], SVG);
  ok(b.calls.some((a) => a[0] === 'open'));
});

test('a UTF-8 diagram file reaches the page decoded, not as mojibake', async () => {
  const b = browser(SVG);
  let html = '';
  const spawn = (argv, vfs) => {
    // the page file is deleted when the command ends: read it when it opens
    if (argv[0] === 'open') html = vfs[argv[1]];
    return b.spawn(argv);
  };
  const files = { ...installed, '/shared/d.mmd': 'flowchart LR\n  A[Café — ✓] --> B[日本]\n' };
  const r = await mermaid(['/shared/d.mmd'], { files, spawn });
  is(r.exitCode, 0, r.stderr);
  ok(html.includes('A[Café — ✓] --> B[日本]'), 'labels decoded as UTF-8');
  is(r.stdout, SVG);
});

test('a large SVG is read back whole, in slices', async () => {
  const big = `<svg>${'<g/>'.repeat(60000)}</svg>`;
  const b = browser(big);
  const r = await mermaid(['render', '-', '-o', '/shared/big.svg'], {
    files: installed,
    stdin: 'flowchart LR\n  A --> B\n',
    spawn: b.spawn,
  });
  is(r.exitCode, 0, r.stderr);
  is(r.vfs['/shared/big.svg'], big);
  const slices = b.calls.filter((a) => a[1] === 'eval' && a[a.length - 1].includes('.slice('));
  is(slices.length, Math.ceil(big.length / page.SLICE));
});

test('a cut-off eval result fails loudly instead of writing a broken SVG', async () => {
  const big = `<svg>${'<g/>'.repeat(60000)}</svg>`;
  const b = browser(big, { evalLimit: 1000 });
  const r = await mermaid(['render', '-', '-o', '/shared/big.svg'], {
    files: installed,
    stdin: 'flowchart LR\n  A --> B\n',
    spawn: b.spawn,
  });
  is(r.exitCode, 1);
  ok(r.stderr.includes(`of ${big.length} SVG characters`), r.stderr);
  ok(!Object.hasOwn(r.vfs, '/shared/big.svg'), 'no output file');
  ok(
    b.calls.some((a) => a[1] === 'tab-close'),
    'the tab is closed'
  );
});

test('usage errors: unknown theme exits 2, missing file and missing install exit 1', async () => {
  const d = { '/w/d.mmd': 'flowchart LR\n  A-->B\n' };
  const theme = await mermaid(['/w/d.mmd', '--theme', 'neon'], { files: d });
  is(theme.exitCode, 2);
  ok(theme.stderr.includes('unknown theme: neon'));
  const missing = await mermaid(['missing.mmd']);
  is(missing.exitCode, 1);
  ok(missing.stderr.includes('no such file: missing.mmd'));
  const notInstalled = await mermaid(['/w/d.mmd'], { files: d });
  is(notInstalled.exitCode, 1);
  ok(notInstalled.stderr.includes('ipk add -g mermaid esbuild-wasm'));
});
