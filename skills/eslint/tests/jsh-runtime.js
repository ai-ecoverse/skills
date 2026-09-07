// Minimal emulation of the SLICC `.jsh` runtime, enough to exercise
// scripts/eslint.jsh under `node --test`:
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

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const SCRIPT = resolve(__dirname, '../scripts/eslint.jsh');
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

  const fs = {
    async readFile(p) {
      if (!store.has(p)) throw enoent(p);
      return store.get(p);
    },
    async writeFile(p, data) {
      store.set(p, String(data));
    },
    async unlink(p) {
      store.delete(p);
    },
    async mkdir(p) {
      extraDirs.add(p);
    },
    async stat(p) {
      // The SLICC shell fs exposes isFile/isDirectory as booleans, not as the
      // predicate methods node:fs uses. Getting this wrong makes every path look
      // like a directory, since a function is truthy.
      if (store.has(p)) return { isFile: true, isDirectory: false, size: store.get(p).length };
      if (isDir(p)) return { isFile: false, isDirectory: true, size: 0 };
      throw enoent(p);
    },
    async lstat(p) {
      return fs.stat(p);
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
    async realpath(p) {
      return p;
    },
  };
  return { fs, store };
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
async function runGeneratedHelper(helperSrc, request, verify, config) {
  const { minimatch } = require('minimatch');
  class FakeLinter {
    verify(source, _config, path) {
      return verify(source, path);
    }
    verifyAndFix(source, _config, path) {
      return { output: source, fixed: false, messages: verify(source, path) };
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

module.exports = { runEslint, compileHelper, runGeneratedHelper, NodeExitError };
