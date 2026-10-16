import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as pageMod from '../scripts/render-page.js';

// Runs the real mermaid.jsh with the runtime's I/O surface supplied: an
// in-memory fs with Node semantics (as slicc-jsh and current SLICC 6 have
// them), sliccy:cli, an exec for esbuild/open/tab-close, and a sliccy:browser
// whose evalAsync runs the real in-page awaitRender against the page the
// command wrote. The skill root is the cwd when tst runs from the skill dir.
const page = pageMod.default || pageMod;
const SCRIPT_DIR = path.join(process.cwd(), 'scripts');
const source = fs.readFileSync(path.join(SCRIPT_DIR, 'mermaid.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const LOCAL_PKG = '/workspace/node_modules/mermaid/package.json';
const GLOBAL_PKG = '/shared/lib/node_modules/mermaid/package.json';
const BUNDLE = 'globalThis.__sliccMermaid = {};';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

// The diagram text the page was given, from the JSON island pageHtml writes.
function pageSource(html) {
  const m = /<script type="application\/json" id="src">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m[1]);
}

// A leader browser. `render(src)` is what Mermaid makes of the diagram:
// { status, text }, or null for a page that never finishes.
function leader({
  render = (src) => ({ status: 'ok', text: `<svg><text>${src}</text></svg>` }),
  esbuild,
} = {}) {
  const calls = [];
  const opened = new Map();
  const spawn = async (argv, vfs) => {
    calls.push(argv);
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
    if (argv[0] === 'esbuild') {
      if (esbuild) return esbuild(argv, vfs);
      vfs[argv[argv.indexOf('--outfile') + 1]] = BUNDLE;
      return ok();
    }
    if (argv[0] === 'open') {
      opened.set('T1', vfs[argv[1]]);
      return ok(`opened ${argv[1]} (targetId: T1)\n`);
    }
    if (argv[0] === 'playwright-cli' && argv[1] === 'tab-close') return ok();
    throw new Error(`unexpected spawn ${argv.join(' ')}`);
  };
  const browser = {
    evalAsync: async (tab, fn) => {
      calls.push(['evalAsync', tab.targetId]);
      const rendered = render(pageSource(opened.get(tab.targetId)));
      const saved = globalThis.document;
      const realNow = Date.now;
      // A page that never finishes: let the clock run past the timeout after one wait.
      if (!rendered) {
        let reads = 0;
        Date.now = () => realNow() + (reads++ ? page.RENDER_TIMEOUT_MS + 1000 : 0);
      }
      globalThis.document = {
        body: { dataset: rendered ? { ready: rendered.status } : {} },
        getElementById: () => ({ textContent: rendered ? rendered.text : '' }),
      };
      try {
        return await fn();
      } finally {
        globalThis.document = saved;
        Date.now = realNow;
      }
    },
  };
  return { calls, spawn, browser };
}

async function mermaid(argv, { files = {}, stdin = '', browser = leader() } = {}) {
  const vfs = { ...files };
  const stdout = [];
  const stderr = [];
  const enoent = (f) => Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });
  const fsStub = {
    existsSync: (f) => Object.hasOwn(vfs, f),
    promises: {
      readFile: async (f, enc) => {
        if (!Object.hasOwn(vfs, f)) throw enoent(f);
        const bytes = new TextEncoder().encode(vfs[f]);
        return enc === 'utf8' ? new TextDecoder().decode(bytes) : bytes;
      },
      writeFile: async (f, data) => {
        vfs[f] = String(data);
      },
      mkdir: async () => {},
      rm: async (f) => {
        delete vfs[f];
      },
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
    'sliccy:exec': { spawn: (a) => browser.spawn(a, vfs) },
    'sliccy:browser': browser.browser,
    'sliccy:cli': cli,
    './render-page.js': page,
  };
  const req = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`unsupported require(${name})`);
  };
  const proc = {
    argv: ['node', path.join(SCRIPT_DIR, 'mermaid.jsh'), ...argv],
    env: {},
    cwd: () => '/workspace',
    exit(code = 0) {
      throw new NodeExitError(code);
    },
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

const installed = { [LOCAL_PKG]: '{"version":"11.17.2"}' };
const DIAGRAM = 'flowchart LR\n  A[Start] --> B[End]\n';
const pages = (vfs) => Object.keys(vfs).filter((k) => k.endsWith('.html'));

test('--help, `help`, and --help after a usage error all print help', async () => {
  for (const argv of [['--help'], ['help'], ['a.mmd', 'b.mmd', '--help']]) {
    const r = await mermaid(argv);
    is(r.exitCode, 0, argv.join(' '));
    ok(r.stdout.includes('ipk add -g mermaid esbuild-wasm'));
  }
});

test('bare mermaid with nothing piped prints help; with -o it is an error, not success', async () => {
  const bare = await mermaid([]);
  is(bare.exitCode, 0);
  ok(bare.stdout.includes('USAGE'));
  const withOut = await mermaid(['-o', '/shared/out.svg']);
  is(withOut.exitCode, 1);
  ok(withOut.stderr.includes('no diagram'));
});

test('a diagram piped with no subcommand is rendered (cat d.mmd | mermaid -o out.svg)', async () => {
  const b = leader();
  const r = await mermaid(['-o', '/shared/out.svg'], {
    files: installed,
    stdin: DIAGRAM,
    browser: b,
  });
  is(r.exitCode, 0, r.stderr);
  is(r.vfs['/shared/out.svg'], `<svg><text>${DIAGRAM}</text></svg>`);
  is(r.stdout, '/shared/out.svg');
  ok(
    b.calls.some((a) => a[0] === 'playwright-cli' && a[1] === 'tab-close'),
    'tab closed'
  );
  is(pages(r.vfs), [], 'page file removed');
});

test('a UTF-8 diagram file reaches the page as text, labels intact', async () => {
  const text = 'flowchart LR\n  A[Café — ✓] --> B[日本]\n';
  const r = await mermaid(['/shared/d.mmd'], { files: { ...installed, '/shared/d.mmd': text } });
  is(r.exitCode, 0, r.stderr);
  is(r.stdout, `<svg><text>${text}</text></svg>`);
});

test("a diagram Mermaid rejects exits 1 with Mermaid's message and closes the tab", async () => {
  const b = leader({ render: () => ({ status: 'err', text: 'Parse error on line 2' }) });
  const r = await mermaid(['render', '-'], {
    files: installed,
    stdin: 'flowchart LR\n  ][\n',
    browser: b,
  });
  is(r.exitCode, 1);
  ok(r.stderr.includes('Parse error on line 2'), r.stderr);
  ok(b.calls.some((a) => a[1] === 'tab-close'));
});

test('a page that never finishes is a timeout error, and anything but a whole SVG is refused', async () => {
  const hung = await mermaid(['render', '-'], {
    files: installed,
    stdin: DIAGRAM,
    browser: leader({ render: () => null }),
  });
  is(hung.exitCode, 1);
  ok(hung.stderr.includes('did not finish rendering'), hung.stderr);
  const cut = await mermaid(['render', '-', '-o', '/shared/x.svg'], {
    files: installed,
    stdin: DIAGRAM,
    browser: leader({ render: () => ({ status: 'ok', text: '<svg><g>' }) }),
  });
  is(cut.exitCode, 1);
  ok(cut.stderr.includes('no complete SVG'));
  ok(!Object.hasOwn(cut.vfs, '/shared/x.svg'), 'no output file');
});

test('a global ipk install is bundled from its own directory', async () => {
  let entry = '';
  const b = leader({
    esbuild: (argv, vfs) => {
      entry = vfs[argv[1]];
      vfs[argv[argv.indexOf('--outfile') + 1]] = BUNDLE;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const r = await mermaid(['render', '-'], {
    files: { [GLOBAL_PKG]: '{"version":"12.2.0","module":"./dist/mermaid.core.mjs"}' },
    stdin: DIAGRAM,
    browser: b,
  });
  is(r.exitCode, 0, r.stderr);
  ok(entry.includes('from "/shared/lib/node_modules/mermaid/dist/mermaid.core.mjs"'), entry);
  is(r.vfs['/shared/cache/mermaid-12.2.0.iife.js'], BUNDLE);
});

test('a failed build leaves no cache; a broken cache is rebuilt; a good one is reused', async () => {
  const failing = leader({
    esbuild: () => ({ exitCode: 1, stdout: '', stderr: 'Could not resolve "mermaid"' }),
  });
  const failed = await mermaid(['render', '-'], {
    files: installed,
    stdin: DIAGRAM,
    browser: failing,
  });
  is(failed.exitCode, 1);
  ok(failed.stderr.includes('Could not resolve'));
  is(
    Object.keys(failed.vfs).filter((k) => k.startsWith('/shared/cache/')),
    []
  );

  const cache = '/shared/cache/mermaid-11.17.2.iife.js';
  const rebuilt = leader();
  const r1 = await mermaid(['render', '-'], {
    files: { ...installed, [cache]: 'var half = ' },
    stdin: DIAGRAM,
    browser: rebuilt,
  });
  is(r1.exitCode, 0, r1.stderr);
  ok(
    rebuilt.calls.some((a) => a[0] === 'esbuild'),
    'rebuilt'
  );
  is(r1.vfs[cache], BUNDLE);

  const reused = leader();
  const r2 = await mermaid(['render', '-'], {
    files: { ...installed, [cache]: BUNDLE },
    stdin: DIAGRAM,
    browser: reused,
  });
  is(r2.exitCode, 0, r2.stderr);
  ok(!reused.calls.some((a) => a[0] === 'esbuild'), 'reused');
});

test('usage errors: unknown or empty theme exits 2; missing file and missing install exit 1', async () => {
  const d = { '/w/d.mmd': DIAGRAM };
  const theme = await mermaid(['/w/d.mmd', '--theme', 'neon'], { files: d });
  is(theme.exitCode, 2);
  ok(theme.stderr.includes('unknown theme: neon'));
  is((await mermaid(['/w/d.mmd', '--theme='], { files: d })).exitCode, 2);
  is((await mermaid(['/w/d.mmd', '--output='], { files: d })).exitCode, 2);
  const missing = await mermaid(['missing.mmd']);
  is(missing.exitCode, 1);
  ok(missing.stderr.includes('no such file: missing.mmd'));
  const notInstalled = await mermaid(['/w/d.mmd'], { files: d });
  is(notInstalled.exitCode, 1);
  ok(notInstalled.stderr.includes('ipk add -g mermaid esbuild-wasm'));
});
