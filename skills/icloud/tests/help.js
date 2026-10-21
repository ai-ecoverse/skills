import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const WRITES = /write|mkdir|rm|unlink|rename|chmod|append|copy|symlink|truncate|open/i;

class NodeExitError extends Error {
  constructor(code) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  const passthrough = [];
  const set = (key, value) => {
    if (!(key in flags)) flags[key] = value;
    else if (Array.isArray(flags[key])) flags[key].push(String(value));
    else flags[key] = [String(flags[key]), String(value)];
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const next = argv[i + 1];
      if (eq !== -1) set(body.slice(0, eq), body.slice(eq + 1));
      else if (next !== undefined && !next.startsWith('-')) {
        set(body, next);
        i++;
      } else set(body, true);
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) set(ch, true);
    } else positional.push(arg);
  }
  const subcommand =
    positional.length > 0 && /^[a-z][\w-]*$/i.test(positional[0]) ? positional[0] : null;
  return { positional, flags, subcommand, passthrough };
}

function trap(name) {
  const fail = () => {
    throw new Error(`help path used ${name}`);
  };
  return new Proxy(fail, {
    get: (_t, key) => (key === 'then' ? undefined : trap(`${name}.${String(key)}`)),
    apply: fail,
    construct: fail,
  });
}

function guarded(target, name, denyReads) {
  return new Proxy(target, {
    get(t, key) {
      if (key === 'promises' && t.promises)
        return guarded(t.promises, `${name}.promises`, denyReads);
      if (
        typeof key === 'string' &&
        (denyReads || WRITES.test(key)) &&
        typeof t[key] === 'function'
      ) {
        return trap(`${name}.${key}`);
      }
      return t[key];
    },
  });
}

const identity = new Proxy((s) => String(s ?? ''), {
  get: (_t, key) => (key === 'then' ? undefined : identity),
});

export async function runHelp(script, words, { denyFs = false, timeoutMs = 5000 } = {}) {
  const file = fileURLToPath(new URL(`../${script}`, import.meta.url));
  const source = fs.readFileSync(file, 'utf8');
  const out = [];
  const err = [];
  const argv = ['node', file, ...words];
  Object.defineProperty(argv, 'parseFlags', { value: () => parseFlags(argv), enumerable: false });
  const exit = (code = 0) => {
    throw new NodeExitError(Number(code) || 0);
  };
  const line = (args) =>
    `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  const proc = {
    argv,
    env: {},
    cwd: () => path.dirname(file),
    exit,
    stdin: { isTTY: true },
    stdout: { isTTY: false, write: (s) => out.push(String(s)) },
    stderr: { isTTY: false, write: (s) => err.push(String(s)) },
  };
  const cons = {
    log: (...a) => out.push(line(a)),
    info: (...a) => out.push(line(a)),
    warn: (...a) => err.push(line(a)),
    error: (...a) => err.push(line(a)),
  };
  const cli = {
    help: (text) => {
      out.push(text.endsWith('\n') ? text : `${text}\n`);
      exit(0);
    },
    die: (msg, opts) => {
      err.push(`${msg instanceof Error ? msg.message : msg}\n`);
      exit(typeof opts === 'number' ? opts : (opts?.exitCode ?? 1));
    },
    out: (v) => out.push(typeof v === 'string' ? `${v}\n` : `${JSON.stringify(v, null, 2)}\n`),
    warn: (msg) => err.push(`${msg}\n`),
  };
  const nodeFs = guarded(fs, 'fs', denyFs);
  const modules = {
    'sliccy:cli': cli,
    'sliccy:color': identity,
    'sliccy:http': { client: () => trap('sliccy:http client') },
    'sliccy:skill': {
      dir: path.dirname(file),
      refs: path.join(path.dirname(file), 'references'),
      assets: path.join(path.dirname(file), 'assets'),
      config: async () => null,
      token: trap('sliccy:skill.token'),
    },
    fs: nodeFs,
    'node:fs': nodeFs,
    'fs/promises': nodeFs.promises,
    path,
    'node:path': path,
    process: proc,
  };
  const req = (name) => (name in modules ? modules[name] : trap(name));
  const run = new AsyncFunction(
    'require',
    'module',
    'exports',
    'process',
    'console',
    '__dirname',
    '__filename',
    'fetch',
    source
  );
  let exitCode = 0;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const done = run(
    req,
    { exports: {} },
    {},
    proc,
    cons,
    path.dirname(file),
    file,
    trap('fetch')
  ).then(
    () => 'done',
    (e) => {
      if (e?.name === 'NodeExitError') exitCode = e.code;
      else {
        exitCode = 1;
        err.push(`${e?.message}\n`);
      }
      return 'done';
    }
  );
  if ((await Promise.race([done, timeout])) === 'timeout') exitCode = 'timeout';
  clearTimeout(timer);
  return { exitCode, stdout: out.join(''), stderr: err.join('') };
}
