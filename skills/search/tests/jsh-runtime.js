// Minimal emulation of the SLICC `.jsh` runtime, enough to exercise
// scripts/search.jsh under `node --test`:
//
//   • the script body is compiled as an AsyncFunction (top-level await is legal)
//   • require('sliccy:cli' | 'sliccy:color') resolve to stubs
//   • cli.die / cli.help throw NodeExitError, which maps to the exit code
//   • fetch is scriptable, and every request is recorded for assertions
//
// It is a stand-in for the real runtime, not a replica: it proves argument
// handling, provider payloads, normalization and exit codes, and it does NOT
// prove anything about the live Brave/Exa/Tavily responses.

const { readFileSync } = require('node:fs');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

/**
 * Run a .jsh file. Returns { exitCode, stdout, stderr }.
 * stdout/stderr are captured as strings, exactly as the runtime buffers them.
 */
async function runJsh(scriptPath, argv, env, fetchImpl) {
  const src = readFileSync(scriptPath, 'utf8');
  const stdout = [];
  const stderr = [];
  const fmtArg = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

  const proc = {
    argv: ['node', scriptPath, ...argv],
    env: { ...env },
    cwd: () => '/workspace',
    exit(code = 0) {
      throw new NodeExitError(code);
    },
    stdout: { isTTY: false },
    stderr: { isTTY: false },
  };

  const cons = {
    log: (...a) => stdout.push(a.map(fmtArg).join(' ')),
    info: (...a) => stdout.push(a.map(fmtArg).join(' ')),
    warn: (...a) => stderr.push(a.map(fmtArg).join(' ')),
    error: (...a) => stderr.push(a.map(fmtArg).join(' ')),
  };

  // Non-TTY: sliccy:color is a set of identity functions.
  const color = new Proxy({}, { get: () => (s) => String(s) });

  const cli = {
    die(msg, opts = {}) {
      const prefix = opts.prefix === undefined ? 'Error' : opts.prefix;
      stderr.push(prefix === '' ? String(msg) : `${prefix}: ${msg}`);
      throw new NodeExitError(opts.exitCode === undefined ? 1 : opts.exitCode);
    },
    out(value) {
      stdout.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
    warn(msg) {
      stderr.push(`Warning: ${msg}`);
    },
    help(text) {
      stdout.push(text);
      throw new NodeExitError(0);
    },
  };

  const req = (name) => {
    if (name === 'sliccy:cli') return cli;
    if (name === 'sliccy:color') return color;
    throw new Error(`jsh-runtime: unsupported require(${name})`);
  };

  const body = new AsyncFunction('require', 'process', 'console', 'fetch', '__dirname', src);

  let exitCode = 0;
  try {
    await body(req, proc, cons, fetchImpl, '/workspace/skills/search/scripts');
  } catch (err) {
    if (err && err.name === 'NodeExitError') {
      exitCode = err.code;
    } else {
      // Any uncaught throw is exit 1 with the stack on stderr.
      exitCode = 1;
      stderr.push(String(err && err.stack ? err.stack : err));
    }
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Scriptable fetch. `handler(url, init, callNumber)` may return:
 *   • a plain JSON payload            → 200 with that body
 *   • { status, headers, body }       → full control (body may be a string)
 *   • { __hang: true }                → never resolves until aborted
 *   • an Error instance               → thrown as a network error
 * The returned function exposes `.calls` — every { url, init } seen.
 */
function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    if (init.signal && init.signal.aborted) throw abortError();
    calls.push({ url: String(url), init });
    const raw = await handler(String(url), init, calls.length);

    if (raw && raw.__hang) {
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()));
      });
    }
    if (raw instanceof Error) throw raw;

    const res = raw && ('body' in raw || 'status' in raw || 'headers' in raw) ? raw : { body: raw };
    const status = res.status === undefined ? 200 : res.status;
    const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: res.statusText || '',
      headers: { get: (k) => (res.headers || {})[k.toLowerCase()] ?? null },
      text: async () => text,
    };
  };
  impl.calls = calls;
  return impl;
}

module.exports = { runJsh, mockFetch };
