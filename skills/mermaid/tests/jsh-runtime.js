// Enough of the .jsh runtime to run mermaid.jsh up to the point it would
// touch the browser. exec.spawn throws if a test reaches it unexpectedly.

const { readFileSync } = require('node:fs');
const path = require('node:path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

async function runMermaid(argv, { files = {}, spawn } = {}) {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'mermaid.jsh');
  const src = readFileSync(scriptPath, 'utf8');
  const stdout = [];
  const stderr = [];
  const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

  const proc = {
    argv: ['node', scriptPath, ...argv],
    env: { TMPDIR: '/tmp' },
    cwd: () => '/workspace',
    exit(code = 0) {
      throw new NodeExitError(code);
    },
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    stdin: { read: async () => '' },
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

  const fsStub = {
    async exists(file) {
      return Object.hasOwn(files, file);
    },
    async readFile(file) {
      if (!Object.hasOwn(files, file)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
    async writeFile() {},
    async mkdir() {},
    async rm() {},
    async stat(file) {
      if (!Object.hasOwn(files, file)) throw new Error('ENOENT');
      return {};
    },
  };

  const req = (name) => {
    if (name === 'sliccy:cli') return cli;
    if (name === 'sliccy:exec') {
      return {
        spawn:
          spawn ||
          (async () => {
            throw new Error('exec.spawn should not run');
          }),
      };
    }
    if (name === 'fs') return fsStub;
    if (name === 'path') return path;
    if (name.startsWith('./') || name.startsWith('../')) {
      return require(path.join(path.dirname(scriptPath), name));
    }
    throw new Error(`unsupported require(${name})`);
  };

  const body = new AsyncFunction('require', 'process', 'console', '__dirname', src);
  let exitCode = 0;
  try {
    await body(
      req,
      proc,
      {
        log: (...a) => stdout.push(a.map(fmt).join(' ')),
        info: (...a) => stdout.push(a.map(fmt).join(' ')),
        warn: (...a) => stderr.push(a.map(fmt).join(' ')),
        error: (...a) => stderr.push(a.map(fmt).join(' ')),
      },
      path.join(__dirname, '..', 'scripts')
    );
  } catch (err) {
    if (err && err.name === 'NodeExitError') exitCode = err.code;
    else {
      exitCode = 1;
      stderr.push(String(err && err.stack ? err.stack : err));
    }
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

module.exports = { runMermaid };
