// cli.test.js — run the shipped workday.jsh against a fake Workday site.
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ok } from 'tst';
import * as F from './fixtures.js';

const require = createRequire(import.meta.url);
const wd = require('../scripts/lib/workday.js');
const SOURCE = fs
  .readFileSync(path.join(process.cwd(), 'scripts', 'workday.jsh'), 'utf8')
  .replace(/^#!.*\n/, '');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
export const ORIGIN = 'https://wd3.myworkday.com';

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
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    flags[key] = next !== undefined && !next.startsWith('--') ? args[++i] : true;
  }
  return { flags, positional, subcommand: positional[0] || null, passthrough: [] };
}

// Ada Lovelace is on Charles Babbage's team; Charles leads it and reports to Grace Hopper.
export const ROUTES = {
  'GET /acme/home.htmld': F.HOME,
  'GET /acme/search.htmld?q=Ada+Lovelace&autocomplete=true': { listItems: [F.SEARCH.listItems[0]] },
  'GET /acme/search.htmld?q=Ada&autocomplete=true': F.SEARCH,
  'GET /acme/search.htmld?q=Nobody&autocomplete=true': { listItems: [] },
  'GET /acme/inst/autocompletesearch/247$1001.htmld': F.PROFILE_ADA,
  'GET /acme/inst/autocompletesearch/247$7.htmld': F.PROFILE_CHARLES,
  'GET /acme/inst/4547$1/rel-task/2998$90.htmld': F.teamPage('2500$2001', 'Analytical Engines  (Charles Babbage)', [F.ORG_TOP]),
  'GET /acme/inst/4547$2/rel-task/2998$90.htmld': F.teamPage('2500$2001', 'Analytical Engines  (Charles Babbage)', [F.ORG_TOP]),
  'POST /acme/navigable/2500$2001.htmld': F.navigator(F.ORG_TOP, F.ORG_TEAM, [F.ADA, F.ALAN], {
    count: 3,
    chunk: '/acme/navigablechunk/c1-x/9',
  }),
  'GET /acme/navigablechunk/c1-x/9.htmld?startRow=2&maxRows=50': {
    widget: 'navigatorDetailsChunk',
    totalCount: 3,
    navigatorDetails: [F.SUB],
  },
  'POST /acme/navigable/2500$3000.htmld': F.navigator(null, F.ORG_TOP, [F.ORG_TEAM]),
};

// Runs workday.jsh against a fake site. Each run gets its own cache dir unless
// one is passed, so runs share a cache only when a test says so. `sleeps`
// records every wait the CLI asked for (nothing really waits). A route value
// can be an array: the answers are used in order, the last one repeats.
export async function run(
  args,
  { routes = ROUTES, tab = { targetId: 'T1', url: `${ORIGIN}/acme/d/home.htmld` }, cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdcache-')), stdin = '' } = {}
) {
  const sleeps = [];
  const seq = {};
  const calls = [];
  const out = [];
  const err = [];
  const browser = {
    findTab: async () => tab,
    fetch: async (_tab, url, opts = {}) => {
      ok(url.startsWith(`${ORIGIN}/`), `same-origin request: ${url}`);
      const key = `${opts.method || 'GET'} ${url.slice(ORIGIN.length)}`;
      calls.push({ key, body: opts.body, headers: opts.headers });
      if (!(key in routes)) return { ok: false, status: 404, headers: {}, body: F.SIGN_IN_PAGE };
      let v = routes[key];
      if (Array.isArray(v)) {
        seq[key] = (seq[key] ?? -1) + 1;
        v = v[Math.min(seq[key], v.length - 1)];
      }
      if (v && v.status) return { ok: v.status < 400, headers: {}, ...v };
      return { ok: true, status: 200, headers: {}, body: typeof v === 'string' ? v : JSON.stringify(v) };
    },
  };
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
    'sliccy:browser': browser,
    'sliccy:cli': cli,
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': {
      table: (rows) => rows.map((r) => r.join(' | ')).join('\n'),
      trunc: (s) => String(s),
    },
    './lib/workday.js': { ...wd, sleep: async (ms) => void sleeps.push(ms) },
    fs: { ...fs, readFileSync: (f, ...r) => (f === 0 ? stdin : fs.readFileSync(f, ...r)) },
    os,
    path,
  };
  const argv = ['node', 'workday.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const proc = {
    argv,
    env: { WORKDAY_CACHE_DIR: cacheDir },
    exit: (code) => {
      throw new NodeExitError(code);
    },
  };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', SOURCE)(
      (n) => {
        if (!(n in modules)) throw new Error(`unexpected require(${n})`);
        return modules[n];
      },
      proc,
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) }
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls, sleeps, cacheDir };
}

