// cli.test.js — run the shipped workday.jsh against a fake Workday site.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as F from './fixtures.js';

const require = createRequire(import.meta.url);
const wd = require('../scripts/lib/workday.js');
const SOURCE = fs
  .readFileSync(path.join(process.cwd(), 'scripts', 'workday.jsh'), 'utf8')
  .replace(/^#!.*\n/, '');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const ORIGIN = 'https://wd3.myworkday.com';

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
const ROUTES = {
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

async function run(args, { routes = ROUTES, tab = { targetId: 'T1', url: `${ORIGIN}/acme/d/home.htmld` } } = {}) {
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
      const v = routes[key];
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
    './lib/workday.js': wd,
  };
  const argv = ['node', 'workday.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const proc = {
    argv,
    env: {},
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
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), calls };
}

test('--help prints usage, exits 0 and calls nothing', async () => {
  const r = await run(['--help']);
  is(r.code, 0);
  ok(r.stdout.includes('workday orgchart'), r.stdout);
  is(r.calls, []);
});

test('whoami reads the signed-in user, not a fixed id', async () => {
  const r = await run(['whoami', '--json']);
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout).id, '247$1001');
  is(r.calls.map((c) => c.key), ['GET /acme/home.htmld', 'GET /acme/inst/autocompletesearch/247$1001.htmld']);
});

test('the tenant comes from the tab, so another tenant gets its own paths', async () => {
  const routes = Object.fromEntries(
    Object.entries(ROUTES).map(([k, v]) => [k.replace(' /acme/', ' /other/'), v])
  );
  const r = await run(['whoami', '--json'], { routes, tab: { targetId: 'T', url: `${ORIGIN}/other/d/home.htmld` } });
  is(r.code, 0, r.stderr);
  is(r.calls[0].key, 'GET /other/home.htmld');
});

test('find lists people only, with ids', async () => {
  const r = await run(['find', 'Ada']);
  is(r.code, 0, r.stderr);
  ok(r.stdout.includes('Ada Lovelace') && r.stdout.includes('id:247$1001'), r.stdout);
  ok(!r.stdout.includes('Request Absence') && !r.stdout.includes('LOVELACE_123'), r.stdout);
});

test('a name with several matches stops with the candidates', async () => {
  const r = await run(['person', 'Ada']);
  is(r.code, 1);
  ok(r.stderr.includes('matches 2 people') && r.stderr.includes('id:247$1004'), r.stderr);
});

test('a name with no match exits 1', async () => {
  const r = await run(['person', 'Nobody']);
  is(r.code, 1);
  ok(r.stderr.includes('no one'), r.stderr);
});

test('orgchart sends the task id from the team page, and pages the chunk at once', async () => {
  const r = await run(['orgchart', 'Ada Lovelace', '--json']);
  is(r.code, 0, r.stderr);
  const nav = r.calls.find((c) => c.key === 'POST /acme/navigable/2500$2001.htmld');
  is(nav.body, 'initial-step=2998%2455');
  is(nav.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const i = r.calls.indexOf(nav);
  is(r.calls[i + 1].key, 'GET /acme/navigablechunk/c1-x/9.htmld?startRow=2&maxRows=50');
  const d = JSON.parse(r.stdout);
  is(d.chain.map((m) => m.name), ['Charles Babbage', 'Grace Hopper']);
  is(d.team.members.map((m) => m.name), ['Ada Lovelace', 'Alan Turing', 'Compilers (Kathleen Booth)']);
  is(d.reports, null);
});

test("orgchart for a manager shows the team they lead as reports and the parent as their team", async () => {
  const r = await run(['orgchart', '247$7', '--json']);
  is(r.code, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  is(d.reports.id, '2500$2001');
  is(d.reports.members.length, 3);
  is(d.team.id, '2500$3000');
  is(d.chain.map((m) => m.name), ['Grace Hopper']);
});

test('--chain caps the management chain', async () => {
  const r = await run(['orgchart', '--chain', '1', '--json']);
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout).chain.map((m) => m.name), ['Charles Babbage']);
});

test('org rejects anything but a 2500$ id before calling Workday', async () => {
  const r = await run(['org', '247$1001']);
  is(r.code, 1);
  is(r.calls, []);
  const bad = await run(['org', '2500$1/../../x']);
  is(bad.code, 1);
  is(bad.calls, []);
});

test('an XML error with HTTP 200 is reported, not parsed as data', async () => {
  const routes = { ...ROUTES, 'POST /acme/navigable/2500$2001.htmld': F.MISSING_PARM };
  const r = await run(['org', '2500$2001'], { routes });
  is(r.code, 1);
  ok(r.stderr.includes('Missing Required Parm'), r.stderr);
});

test('a sign-in page or 401 says to sign in again', async () => {
  const page = await run(['whoami'], { routes: { 'GET /acme/home.htmld': F.SIGN_IN_PAGE } });
  is(page.code, 1);
  ok(page.stderr.includes('sign in to Workday'), page.stderr);
  const denied = await run(['whoami'], { routes: { 'GET /acme/home.htmld': { status: 401, body: '' } } });
  is(denied.code, 1);
  ok(denied.stderr.includes('session expired'), denied.stderr);
});

test('no Workday tab exits 1 with what to open', async () => {
  const r = await run(['whoami'], { tab: null });
  is(r.code, 1);
  ok(r.stderr.includes('myworkday.com'), r.stderr);
});

test('every request is a read: GET, or the org chart POST', async () => {
  for (const args of [['whoami'], ['find', 'Ada'], ['person'], ['orgchart'], ['org', '2500$2001']]) {
    const r = await run(args);
    is(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    for (const c of r.calls) {
      ok(c.key.startsWith('GET ') || /^POST \/acme\/navigable\/2500\$\d+\.htmld$/.test(c.key), c.key);
    }
  }
});
