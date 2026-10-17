// Minimal emulation of the SLICC `.jsh` runtime, enough to exercise
// scripts/eslint.jsh under `tst`:
//
//   • the script body is compiled as an AsyncFunction (top-level await is legal)
//   • require('sliccy:cli' | 'sliccy:color' | 'sliccy:exec' | 'fs') → stubs
//   • cli.die / cli.help throw NodeExitError, which maps to the exit code
//   • `fs` is an in-memory tree; `exec.spawn` is recorded and scripted
//
// Same technique as skills/search/tests/jsh-runtime.js, with two additions this
// script needs: a filesystem (it walks targets and writes fixes back) and an
// exec bridge (it runs the linting in a generated helper).
//
// It is a stand-in for the real runtime, not a replica. It proves argument
// handling, config discovery, target expansion, reporting, exit codes, and the
// shape of the helper request — it does NOT prove anything about real ESLint's
// findings, which is what the live-harness verification in the PR body covers.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/eslint.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

function enoent(path) {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), {
    code: 'ENOENT',
  });
}

/**
 * In-memory VFS over a flat `path -> contents` map. Directories are implied by
 * the file paths, plus any listed in `dirs` (so an empty directory can exist).
 */
function makeFs(files, dirs) {
  const store = new Map(Object.entries(files));
  const extraDirs = new Set(dirs || []);

  const isDir = (p) => {
    const prefix = p.endsWith('/') ? p : `${p}/`;
    if (extraDirs.has(p)) return true;
    for (const key of store.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };

  const promises = {
    async readFile(p, encoding) {
      if (!store.has(p)) throw enoent(p);
      const text = store.get(p);
      return encoding ? text : Buffer.from(text);
    },
    async writeFile(p, data) {
      store.set(p, String(data));
    },
    async rm(p) {
      if (!store.has(p) && !isDir(p)) throw enoent(p);
      store.delete(p);
    },
    async mkdir(p) {
      extraDirs.add(p);
    },
    async stat(p) {
      // Node's fs.Stats: isFile/isDirectory are METHODS. Reading them as
      // properties makes every path look like a directory (a function is truthy).
      if (store.has(p))
        return { isFile: () => true, isDirectory: () => false, size: store.get(p).length };
      if (isDir(p)) return { isFile: () => false, isDirectory: () => true, size: 0 };
      throw enoent(p);
    },
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const names = new Set();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        names.add(key.slice(prefix.length).split('/')[0]);
      }
      for (const dir of extraDirs) {
        if (dir.startsWith(prefix)) names.add(dir.slice(prefix.length).split('/')[0]);
      }
      if (names.size === 0 && !isDir(p)) throw enoent(p);
      return [...names];
    },
  };
  const fs = {
    existsSync: (p) => store.has(p) || isDir(p),
    promises,
  };

  // Only Node's fs surface that both slicc-jsh (SLICC 7) and SLICC 6 serve is
  // exposed: existsSync and fs.promises (ai-ecoverse/skills#487). The SLICC 6
  // promise dialect (fs.readFile without a callback, readDir, exists, ...) must
  // fail here, as it fails on slicc-jsh, rather than pass in tests.
  const guard = (target, where) =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop === 'string' && !(prop in t)) {
          throw new Error(`jsh-runtime: ${where}${prop} is not part of Node's fs as used here`);
        }
        return t[prop];
      },
    });
  fs.promises = guard(promises, 'fs.promises.');
  return {
    fs: guard(fs, 'fs.'),
    store,
  };
}

/**
 * Run scripts/eslint.jsh. Returns { exitCode, stdout, stderr } plus the recorded
 * helper invocations and the resulting file store.
 *
 * @param {object} opts
 * @param {string[]} opts.argv           script arguments (no `node <script>`)
 * @param {Record<string,string>} [opts.files]
 * @param {string[]} [opts.dirs]         directories with no files in them
 * @param {string} [opts.cwd]
 * @param {string} [opts.stdin]
 * @param {(request: object) => {stdout?:string,stderr?:string,exitCode?:number}} [opts.helper]
 *   Stands in for the generated helper. Defaults to "no findings".
 */
async function runEslint(opts = {}) {
  const { fs, store } = makeFs(opts.files || {}, opts.dirs);
  if (opts.breakReadDir) {
    fs.promises.readdir = async () => {
      throw new Error(opts.breakReadDir);
    };
  }
  const cwd = opts.cwd || '/workspace/proj';
  const stdout = [];
  const stderr = [];
  /** Every `exec.spawn` argv, in order. A command STRING would show up here as null. */
  const argvCalls = [];
  const stringCalls = [];
  /** Every parsed helper request, in order. */
  const requests = [];
  /** The helper's source at the moment it ran — it is deleted afterwards. */
  const helperSources = [];

  const fmtArg = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const proc = {
    argv: ['node', SCRIPT, ...(opts.argv || [])],
    env: { TMPDIR: '/tmp', ...(opts.env || {}) },
    cwd: () => cwd,
    exit(code = 0) {
      throw new NodeExitError(code);
    },
    stdout: { isTTY: false, write: (s) => stdout.push(String(s)) },
    stderr: { isTTY: false, write: (s) => stderr.push(String(s)) },
    stdin: {
      on(event, handler) {
        if (event === 'data' && opts.stdin) handler(opts.stdin);
        if (event === 'end') handler();
        return proc.stdin;
      },
    },
  };

  const cons = {
    log: (...a) => stdout.push(`${a.map(fmtArg).join(' ')}\n`),
    info: (...a) => stdout.push(`${a.map(fmtArg).join(' ')}\n`),
    warn: (...a) => stderr.push(`${a.map(fmtArg).join(' ')}\n`),
    error: (...a) => stderr.push(`${a.map(fmtArg).join(' ')}\n`),
  };

  // Non-TTY: sliccy:color is a set of identity functions.
  const color = new Proxy({}, { get: () => (s) => String(s) });

  const cli = {
    die(msg, options = {}) {
      const prefix = options.prefix === undefined ? 'Error' : options.prefix;
      stderr.push(prefix === '' ? `${msg}\n` : `${prefix}: ${msg}\n`);
      throw new NodeExitError(options.exitCode === undefined ? 1 : options.exitCode);
    },
    out(value) {
      stdout.push(typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    },
    warn(msg) {
      stderr.push(`${msg}\n`);
    },
    help(text) {
      stdout.push(`${text}\n`);
      throw new NodeExitError(0);
    },
  };

  const runHelper = (argv) => {
    const [bin, helperPath, payload] = argv;
    if (bin !== 'node' || helperPath === undefined || payload === undefined) {
      return { stdout: '', stderr: '', exitCode: 127 };
    }
    // The helper exists only for the duration of the call.
    helperSources.push(store.get(helperPath));
    const request = JSON.parse(payload);
    requests.push(request);
    const reply = opts.helper
      ? opts.helper(request)
      : {
          stdout: JSON.stringify(
            (request.files || []).map((f) => ({
              path: f.path,
              messages: [],
              output: null,
              wrapUnfixable: false,
            }))
          ),
        };
    return {
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      exitCode: reply.exitCode ?? 0,
    };
  };

  const exec = async (command) => {
    // Recorded, never honored: the script must not build command strings out of
    // linted content. Tests assert `stringCalls` stays empty.
    stringCalls.push(command);
    return { stdout: '', stderr: '', exitCode: 127 };
  };
  exec.spawn = async (argv) => {
    argvCalls.push(argv);
    return runHelper(argv);
  };
  exec.exec = exec;

  const req = (name) => {
    if (name === 'sliccy:cli') return cli;
    if (name === 'sliccy:color') return color;
    if (name === 'sliccy:exec') return { exec };
    if (name === 'fs') return fs;
    throw new Error(`jsh-runtime: unsupported require(${name})`);
  };

  const src = readFileSync(SCRIPT, 'utf8');
  const body = new AsyncFunction('require', 'process', 'console', '__dirname', src);

  let exitCode = 0;
  try {
    await body(req, proc, cons, '/workspace/skills/eslint/scripts');
  } catch (err) {
    if (err && err.name === 'NodeExitError') {
      exitCode = err.code;
    } else {
      exitCode = 1;
      stderr.push(String(err && err.stack ? err.stack : err));
    }
  }

  return {
    exitCode,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    argvCalls,
    stringCalls,
    requests,
    helperSources,
    lastRequest: () => requests[requests.length - 1],
    read: (p) => store.get(p),
  };
}

/**
 * Compile a generated helper the way the realm does — as an async function body,
 * since it ends in a top-level `await`. Used both to prove the generated source
 * parses and to run its own ignore/wrapper logic against a stub Linter.
 */
function compileHelper(src) {
  return new AsyncFunction('require', 'process', 'console', src);
}

/**
 * Execute a generated helper with a stub `Linter` and the REAL `minimatch`, so
 * the helper's own global-ignore evaluation and wrapper-message filtering are
 * exercised rather than reimplemented in the test.
 */
async function runGeneratedHelper(helperSrc, request, verify, config, opts = {}) {
  // Prefer an injected minimatch (ESM test file's bare require sees ipk).
  // Fallback: package name, then the absolute ipk install path — createRequire
  // from this file cannot resolve ipk package names in the SLICC realm.
  let minimatch = opts.minimatch;
  if (typeof minimatch !== 'function') {
    try {
      minimatch = require('minimatch').minimatch;
    } catch {
      const { createRequire } = require('node:module');
      const abs = '/shared/lib/node_modules/minimatch/dist/commonjs/index.js';
      minimatch = createRequire(abs)(abs).minimatch;
    }
  }
  class FakeLinter {
    verify(source, _config, path) {
      return verify(source, path);
    }
    verifyAndFix(source, _config, path) {
      const messages = verify(source, path);
      // `fixesWrapper` reproduces a fixer that also rewrote the injected
      // scaffold (as `semi` does to the generated `})`), so `unwrap` rejects the
      // output and the fix has to be discarded.
      if (opts.fixesWrapper) {
        return { output: `${source.replace(/\}\)$/, '});')}`, fixed: true, messages };
      }
      return { output: source, fixed: false, messages };
    }
  }
  let out = '';
  const stubRequire = (id) => {
    if (id === 'eslint/universal') return { Linter: FakeLinter };
    if (id === 'minimatch') return { minimatch };
    if (id === 'eslint/package.json') return { version: '9.9.9' };
    if (id === 'fs') return { readFile: async () => '' };
    return config === undefined ? [{ files: ['**/*'], rules: {} }] : config;
  };
  const stubProcess = {
    argv: ['node', 'helper.js', JSON.stringify(request)],
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: { write: () => {} },
    exit: (code) => {
      throw new NodeExitError(code);
    },
  };
  await compileHelper(helperSrc)(stubRequire, stubProcess, console);
  return JSON.parse(out);
}

export { compileHelper, NodeExitError, runEslint, runGeneratedHelper };
export default { runEslint, compileHelper, runGeneratedHelper, NodeExitError };
