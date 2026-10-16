import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// Runs the real printful.jsh with a stored config (sliccy:skill.config) and
// the runtime's output surface. No network: `auth token` must not need one,
// and any fetch here fails the test.
const source = fs.readFileSync(path.join(process.cwd(), 'scripts/printful.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const TOKEN = 'pf_live_abcdefghijklmnopqrstuvwxyz0123456789';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = args[++i];
    else positional.push(a);
  }
  return { flags, positional, subcommand: positional[0] || '' };
}

async function printful(args, config) {
  const out = [];
  const err = [];
  const cli = {
    die(msg, o = {}) {
      err.push(`${o.prefix ?? 'Error'}: ${msg}`);
      throw new NodeExitError(o.exitCode ?? 1);
    },
    help(t) {
      out.push(t);
      throw new NodeExitError(0);
    },
    out: (v) => out.push(typeof v === 'string' ? v : JSON.stringify(v)),
    warn: (m) => err.push(String(m)),
  };
  const modules = {
    'sliccy:cli': cli,
    'sliccy:skill': { config: async () => config },
    'sliccy:browser': {},
    'sliccy:exec': async () => ({ exitCode: 1 }),
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    fs: {},
  };
  const argv = ['node', 'printful.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const proc = {
    argv,
    env: {},
    stdout: { write: (s) => out.push(String(s).replace(/\n$/, '')) },
    stderr: { write: (s) => err.push(String(s)) },
    exit: (code) => {
      throw new NodeExitError(code);
    },
  };
  const cons = { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) };
  const noFetch = async (u) => {
    throw new Error(`unexpected fetch ${u}`);
  };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', 'fetch', source)(
      (n) => modules[n],
      proc,
      cons,
      noFetch
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const stored = { token: TOKEN, token_source: 'private-token', token_expires_at: null };

test('auth token prints the stored token, and only it, on one line', async () => {
  const r = await printful(['auth', 'token'], stored);
  is(r.code, 0, r.stderr);
  is(r.stdout, TOKEN);
});

test('auth token --json carries the token with its source and expiry', async () => {
  const exp = new Date(Date.now() + 86400000).toISOString();
  const r = await printful(['auth', 'token', '--json'], {
    ...stored,
    token_source: 'graphql-mint',
    token_expires_at: exp,
  });
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout), { token: TOKEN, source: 'graphql-mint', expires_at: exp });
});

test('auth token ignores --token: it never echoes an unchecked override', async () => {
  const r = await printful(['auth', 'token', '--token', 'pf_someone_else'], stored);
  is(r.stdout, TOKEN);
});

test('an expired or missing token is exit 3 with what to run, never printed', async () => {
  const expired = await printful(['auth', 'token'], {
    ...stored,
    token_expires_at: '2020-01-01T00:00:00Z',
  });
  is(expired.code, 3);
  ok(expired.stderr.includes('expired at 2020-01-01T00:00:00Z'), expired.stderr);
  ok(expired.stderr.includes('printful auth login'));
  ok(!`${expired.stdout}${expired.stderr}`.includes(TOKEN), 'expired token not printed');
  const none = await printful(['auth', 'token'], {});
  is(none.code, 3);
  ok(none.stderr.includes('Not authenticated'));
});

test('auth status (the agent-facing command) never prints the token', async () => {
  const r = await printful(['auth', 'status'], {
    ...stored,
    token_expires_at: '2020-01-01T00:00:00Z',
  });
  ok(!`${r.stdout}${r.stderr}`.includes(TOKEN), r.stdout);
});
