// Shared loader for the bluebubbles .jsh script under `node:test`.
//
// Same technique as tests/redaction.test.js (and skills/github/tests): compile
// the script as an AsyncFunction with stub `sliccy:*` modules, drop the trailing
// `await main()`, and hand back the command functions plus a setter for `api()`
// so HTTP can be faked. Function declarations are assignable bindings inside the
// wrapper scope, which is what makes `setApi()` work without touching the script.

const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../scripts/bluebubbles.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/**
 * @param {object} opts
 * @param {(method: string, apiPath: string, opts?: object) => Promise<any>} opts.api
 * @param {(cmd: string) => Promise<{exitCode:number,stdout:string,stderr:string}>} [opts.exec]
 * @param {object} [opts.files] in-memory file map for the fs stub
 * @param {(file: string, data: string) => void} [opts.onWriteFile] throw to simulate a failure
 */
async function load(opts = {}) {
  const log = [];
  const out = [];
  const stdout = [];
  const files = new Map(Object.entries(opts.files || {}));

  let source = fs.readFileSync(SCRIPT, 'utf8');
  source = source.replace(/\nawait main\(\);\s*$/, '\n');
  source += `
return {
  cmdMessages,
  cmdSend,
  cmdWatch,
  cmdWatches,
  cmdUnwatch,
  safeErrorText,
  findRecentOutbound,
  setApi: (fn) => {
    api = fn;
    // Send goes through curl in prod; in tests route it via the stubbed api
    // so we still exercise cmdSend's soft/verify/dupe logic without a network.
    _sendTransport = async (body) => api('POST', '/api/v1/message/text', { body });
  },
  setSendTransport: (fn) => {
    _sendTransport = fn;
  },
};
`;

  const execStub = async (cmd) => {
    log.push({ kind: 'exec', cmd });
    const res = opts.exec ? await opts.exec(cmd) : { exitCode: 0, stdout: '', stderr: '' };
    return res;
  };

  const stubs = {
    fs: {
      readFile: async (file) => {
        if (!files.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
        return files.get(file);
      },
      writeFile: async (file, data) => {
        log.push({ kind: 'writeFile', file });
        if (opts.onWriteFile) opts.onWriteFile(file, data);
        files.set(file, data);
      },
      rm: async (file) => {
        log.push({ kind: 'rm', file });
        files.delete(file);
      },
      mkdir: async () => {},
      readDir: async () => [...files.keys()].map((f) => path.basename(f)),
      exists: (file) => files.has(file),
    },
    os: { homedir: () => '/home/test' },
    path: require('node:path'),
    'sliccy:cli': {
      die: (message) => {
        const err = new Error(String(message));
        err.name = 'NodeExitError';
        throw err;
      },
      help: () => {},
      out: (payload) => {
        out.push(payload);
      },
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': {
      trunc: (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s)),
      date: () => '',
    },
    'sliccy:http': { client: () => ({}) },
    'sliccy:exec': { exec: execStub },
  };

  const requireStub = (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`unexpected require(${id})`);
  };

  const argv = ['node', SCRIPT, 'status'];
  argv.parseFlags = () => ({ subcommand: 'status', positional: ['status'], flags: {} });
  const proc = {
    argv,
    env: { BLUEBUBBLES_WATCH_DIR: '/home/test/.bluebubbles-watches' },
    exit: () => {},
    cwd: () => '/workspace',
  };
  const consoleStub = {
    log: (...args) => {
      stdout.push(args.join(' '));
    },
    error: (...args) => {
      stdout.push(args.join(' '));
    },
  };

  const factory = new AsyncFunction('require', 'process', 'console', 'URL', source);
  const mod = await factory(requireStub, proc, consoleStub, URL);

  const api = async (method, apiPath, o) => {
    log.push({ kind: 'api', method, apiPath, body: o && o.body });
    return opts.api(method, apiPath, o);
  };
  mod.setApi(api);

  return {
    ...mod,
    log,
    out,
    stdout,
    files,
    text: () => stdout.join('\n'),
    execCommands: () => log.filter((e) => e.kind === 'exec').map((e) => e.cmd),
    apiCalls: () => log.filter((e) => e.kind === 'api').map((e) => `${e.method} ${e.apiPath}`),
  };
}

module.exports = { load, SCRIPT };
