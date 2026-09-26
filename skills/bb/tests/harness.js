// Shared harness for the bb.jsh tst suites.
//
// Compiles the REAL scripts/bb.jsh as an AsyncFunction body, exactly as jsh
// runs it, trailing `await main()` included, so each case drives the command
// line a user types. The `sliccy:*` bridges are stubbed: `browser.fetch` is the
// only transport, so every request lands in `calls` and is answered by a fake
// bb server. Nothing touches the network or a real credential.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/bb.jsh', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export const SERVER = 'https://handle.example.invalid';
export const CREDENTIAL = 'fake-machine-credential-for-tests';

class NodeExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

// Same shape as the jsh runtime's argv.parseFlags(): `--k v` takes the next
// word unless it is another `--flag`, `--k=v` splits, a bare `-` is positional.
function parseFlags(words) {
  const positional = [];
  const flags = {};
  let passthrough = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') {
      passthrough = words.slice(i + 1);
      break;
    }
    if (word.startsWith('--')) {
      const body = word.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = words[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    positional.push(word);
  }
  return { positional, flags, subcommand: positional[0], passthrough };
}

/**
 * A fake GET /threads that honours limit and offset over `count` rows.
 * `insertAfterFirstRead` prepends that many new rows once the first page has
 * been served, which shifts every later row down: the live-reorder case.
 */
export function threadServer(count, { insertAfterFirstRead = 0 } = {}) {
  let rows = Array.from({ length: count }, (_, i) => ({
    id: `t-${String(i).padStart(4, '0')}`,
    title: `thread ${i}`,
    status: 'idle',
    projectId: 'p-fake',
  }));
  let reads = 0;
  return (req) => {
    if (req.method !== 'GET' || req.path !== '/threads') return { status: 404, body: {} };
    const offset = Number(req.params.offset ?? 0);
    const limit = req.params.limit === undefined ? rows.length : Number(req.params.limit);
    const page = rows.slice(offset, offset + limit);
    reads += 1;
    if (reads === 1 && insertAfterFirstRead > 0) {
      const fresh = Array.from({ length: insertAfterFirstRead }, (_, i) => ({
        id: `t-new-${i}`,
        title: `new ${i}`,
        status: 'idle',
        projectId: 'p-fake',
      }));
      rows = [...fresh, ...rows];
    }
    return { status: 200, body: page };
  };
}

/**
 * Run `bb <words...>` against a fake server.
 * @param {string[]} words argv after the script name
 * @param {object} [opts]
 * @param {(req) => {status:number, body:any}} [opts.server] fake bb server
 * @param {string|null} [opts.stdin] what process.stdin.read() yields
 */
export async function runBb(words, opts = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const out = [];
  const server = opts.server || (() => ({ status: 200, body: { ok: true, result: null } }));

  const browser = {
    findTab: async () => ({ id: 'tab-1', url: `${SERVER}/` }),
    ensureTab: async () => ({ id: 'tab-1', url: `${SERVER}/` }),
    fetch: async (_tab, url, init) => {
      const parsed = new URL(url);
      const req = {
        url,
        origin: parsed.origin,
        method: init.method,
        path: parsed.pathname.replace(/^\/api\/v1/u, ''),
        search: parsed.search,
        params: Object.fromEntries(parsed.searchParams.entries()),
        headers: init.headers,
        body: init.body,
      };
      calls.push(req);
      const res = server(req);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body: res.body };
    },
  };

  const cli = {
    die: (message, options) => {
      stderr.push(`Error: ${message}`);
      throw new NodeExitError(String(message), options?.exitCode ?? 1);
    },
    help: (text) => {
      stdout.push(String(text));
      throw new NodeExitError('help', 0);
    },
    out: (value) => {
      out.push(value);
      stdout.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
    warn: (message) => stderr.push(`Warning: ${message}`),
  };

  const mocks = {
    'sliccy:browser': browser,
    'sliccy:skill': {
      config: async (patch) => (patch ? undefined : { serverUrl: SERVER, credential: CREDENTIAL }),
    },
    'sliccy:cli': cli,
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': {
      trunc: (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s)),
      date: (v) => String(v),
    },
  };
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    throw new Error(`unexpected require(${id})`);
  };

  const argv = ['node', SCRIPT, ...words];
  Object.defineProperty(argv, 'parseFlags', { value: () => parseFlags(words) });
  let stdinReads = 0;
  const proc = {
    argv,
    env: {},
    exit: (code) => {
      throw new NodeExitError('exit', code);
    },
    stdin: {
      read: async () => {
        stdinReads += 1;
        return opts.stdin === undefined ? null : opts.stdin;
      },
    },
  };
  const consoleStub = {
    log: (...args) => stdout.push(args.join(' ')),
    info: (...args) => stdout.push(args.join(' ')),
    warn: (...args) => stderr.push(args.join(' ')),
    error: (...args) => stderr.push(args.join(' ')),
  };

  const source = readFileSync(SCRIPT, 'utf8');
  const factory = new AsyncFunction('require', 'process', 'console', source);
  let error = null;
  try {
    await factory(mockRequire, proc, consoleStub);
  } catch (err) {
    if (err?.name !== 'NodeExitError') throw err;
    error = err;
  }
  return {
    error,
    exitCode: error ? error.exitCode : 0,
    calls,
    out,
    stdinReads: () => stdinReads,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}
