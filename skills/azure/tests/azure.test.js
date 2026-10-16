import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as commonMod from '../scripts/arm-common.js';

// Runs the real az.jsh / az-ext.jsh. Their own test seams (AZ_NO_MAIN /
// AZ_EXT_NO_MAIN) expose the helpers; a command run goes through main() with
// the runtime's surface supplied: skill.config, a portal tab, fetch.
const common = commonMod.default || commonMod;
const read = (f) => fs.readFileSync(path.join(process.cwd(), 'scripts', f), 'utf8');
const AZ = read('az.jsh');
const AZ_EXT = read('az-ext.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const now = () => Math.floor(Date.now() / 1000);

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
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) flags[a.slice(2)] = args[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional, subcommand: positional[0] || null };
}

async function load(source, { args = [], env = {}, config = {}, fetchImpl, evalAsync } = {}) {
  const out = [];
  const err = [];
  const fetches = [];
  let cfg = { ...config };
  const cli = {
    die(msg, o = {}) {
      err.push(String(msg));
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
    'sliccy:skill': {
      config: async (patch) => {
        if (patch) cfg = { ...cfg, ...patch };
        return cfg;
      },
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:browser': {
      findTab: async () => ({ targetId: 'PORTAL' }),
      evalAsync: evalAsync || (async () => ({ found: false })),
    },
    'sliccy:exec': { exec: { spawn: async () => ({ exitCode: 1, stdout: '', stderr: 'no az' }) } },
    './arm-common.js': common,
    crypto,
    fs: {
      readFile: async () => Promise.reject(new Error('ENOENT')),
      writeFile: async () => {},
      mkdir: async () => {},
    },
  };
  const argv = ['node', 'x.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const module = { exports: {} };
  const proc = {
    argv,
    env: { HOME: '/home/t', ...env },
    exit: (code) => {
      throw new NodeExitError(code);
    },
  };
  const doFetch = async (url, init) => {
    fetches.push({ url, init });
    if (!fetchImpl) throw new Error(`unexpected fetch ${url}`);
    return fetchImpl(url, init);
  };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', 'module', 'fetch', 'Buffer', source)(
      (n) => {
        if (!(n in modules)) throw new Error(`unexpected require(${n})`);
        return modules[n];
      },
      proc,
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) },
      module,
      doFetch,
      globalThis.Buffer
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return {
    code,
    exports: module.exports,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    fetches,
    config: () => cfg,
  };
}

const ext = (opts = {}) =>
  load(AZ_EXT, { ...opts, env: { AZ_EXT_NO_MAIN: '1', ...(opts.env || {}) } });
const DAY = 86400000;
const day = (iso) => Date.parse(iso);

test('chunkRange: inclusive windows that never share a day, each within the 364-day cap', async () => {
  const { chunkRange, MAX_QUERY_DAYS } = (await ext()).exports;
  is(chunkRange('2025-01-01', '2025-12-31').length, 1, '364-day span is one query');
  const w = chunkRange('2025-01-01', '2026-01-16');
  is(w.length, 2);
  for (const x of w) ok((day(x.to) - day(x.from)) / DAY <= MAX_QUERY_DAYS, JSON.stringify(x));
  is(day(w[1].from) - day(w[0].to), DAY, 'the next window starts the day after');
  is(w[0].from.slice(0, 10), '2025-01-01');
  is(w[1].to.slice(0, 10), '2026-01-16');
  const covered = w.reduce((n, x) => n + (day(x.to) - day(x.from)) / DAY + 1, 0);
  is(covered, (day('2026-01-16') - day('2025-01-01')) / DAY + 1, 'every day exactly once');
});

const THROTTLED = async () => ({
  status: 429,
  ok: false,
  headers: { get: () => null, forEach() {} },
  text: async () => '{"error":{"code":"429","message":"Too many requests. Please retry."}}',
});

test('costQuery: a soft caller gets a catchable ThrottledError; a normal one exits', async () => {
  const { costQuery } = (await ext()).exports;
  const deps = {
    fetch: THROTTLED,
    token: async () => 'tok',
    sleep: async () => {},
    notify: () => {},
  };
  const body = { type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: 'a', to: 'b' } };
  let soft = null;
  try {
    await costQuery('sub', body, { refresh: true, maxWaitSeconds: 30, soft: true }, deps);
  } catch (e) {
    soft = e;
  }
  is(soft?.name, 'ThrottledError');
  let hard = null;
  try {
    await costQuery('sub', body, { refresh: true, maxWaitSeconds: 30 }, deps);
  } catch (e) {
    hard = e;
  }
  is(hard?.name, 'NodeExitError');
});

test('costQuery asks for the token on every attempt, so a long backoff cannot outlive it', async () => {
  const { costQuery } = (await ext()).exports;
  const tokens = ['old', 'fresh'];
  const seen = [];
  let n = 0;
  const deps = {
    token: async () => tokens[Math.min(n, 1)],
    sleep: async () => {},
    notify: () => {},
    fetch: async (_url, init) => {
      seen.push(init.headers.Authorization);
      n++;
      if (n === 1) return THROTTLED();
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => '{"properties":{"rows":[]}}',
      };
    },
  };
  await costQuery(
    'sub',
    { timeframe: 'MonthToDate' },
    { refresh: true, maxWaitSeconds: 900 },
    deps
  );
  is(seen, ['Bearer old', 'Bearer fresh']);
});

test('az-ext resolves a subscription exactly as az does (GUID prefix, ambiguous names)', async () => {
  const subs = [
    { id: '1a2b3c4d-0000-0000-0000-000000000001', name: 'Helix PRD' },
    { id: '9f9f9f9f-0000-0000-0000-000000000002', name: 'Twin' },
    { id: '8e8e8e8e-0000-0000-0000-000000000003', name: 'Twin' },
  ];
  const { resolveSubscriptionId } = (await ext({ config: { subscriptions: subs } })).exports;
  is(await resolveSubscriptionId({ subscription: '1a2b' }), { id: subs[0].id, name: 'Helix PRD' });
  let err = null;
  try {
    await resolveSubscriptionId({ subscription: 'twin' });
  } catch (e) {
    err = e;
  }
  is(err?.name, 'NodeExitError');
});

test('the ARM token only ever goes to https://management.azure.com', async () => {
  for (const bad of [
    'https://attacker.example/x',
    'http://management.azure.com/subscriptions',
    'https://management.azure.com.evil.example/x',
    'https://user@management.azure.com/x',
    'https://management.azure.com:8443/x',
  ])
    is(common.armUrl(bad), null, bad);
  is(
    common.armUrl('/subscriptions?api-version=1'),
    'https://management.azure.com/subscriptions?api-version=1'
  );
  const config = { armToken: 'secret-token', armTokenExpiresOn: now() + 3600 };
  const r = await load(AZ, { args: ['rest', '--url', 'https://attacker.example/x'], config });
  is(r.code, 1);
  ok(r.stderr.includes('refusing to send the ARM token'), r.stderr);
  is(r.fetches, [], 'nothing was sent');
});

function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ ...claims, pad: 'x'.repeat(500) })}.${'s'.repeat(80)}`;
}

test('login refuses a token inside the expiry skew instead of storing one that reads as absent', async () => {
  const exp = now() + 90;
  const token = fakeJwt({ aud: 'https://management.core.windows.net/', exp, tid: 't1' });
  const r = await load(AZ, {
    args: ['login', '--from-tab'],
    evalAsync: async () => ({
      found: true,
      token,
      tokenLength: token.length,
      expiresOn: exp,
      tenantId: 't1',
    }),
  });
  is(r.code, 1);
  ok(r.stderr.includes('not stored'), r.stderr);
  is(r.config().armToken, undefined);
});

test('az login without --from-tab says how to log in, instead of quietly doing the same thing', async () => {
  const r = await load(AZ, { args: ['login'] });
  is(r.code, 2);
  ok(r.stderr.includes('az login needs --from-tab'), r.stderr);
});

test('attributeVendors reports vendors per ResourceId and no unmatchable per-label map', async () => {
  const { attributeVendors } = (await ext()).exports;
  const v = attributeVendors([
    {
      PublisherType: 'Marketplace',
      ResourceId: '/subscriptions/x/resourceGroups/rg/providers/ClickHouse.Cloud/organizations/o',
      Cost: 10,
    },
    {
      PublisherType: 'Azure',
      ResourceId: '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Compute/vm/a',
      Cost: 99,
    },
  ]);
  is(Object.keys(v), ['top']);
});
