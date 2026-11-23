import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { is, ok } from 'tst';

const require = createRequire(import.meta.url);
const portal = require('../scripts/lib/portal.js');
const SOURCE = fs
  .readFileSync(path.join(process.cwd(), 'scripts', 'apple-developer.jsh'), 'utf8')
  .replace(/^#!.*\n/, '');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const TEAM = 'S8LB56P782';
const CMS = Buffer.concat([Buffer.from([0x30, 0x82, 0x32, 0x00]), Buffer.alloc(80, 1)]);

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
    const value = next !== undefined && !next.startsWith('--') ? args[++i] : true;
    if (key in flags) flags[key] = [].concat(flags[key], value);
    else flags[key] = value;
  }
  return { flags, positional, subcommand: positional[0] || null, passthrough: [] };
}

function portalSite(pages) {
  const reads = [];
  const writes = [];
  const answer = (status, json, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    url: 'https://developer.apple.com/services-account/v1/x',
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(json),
  });
  const fetch = async (url, init) => {
    if (url.endsWith('listTeams.action')) {
      return answer(200, { teams: [{ teamId: TEAM, name: 'Team', status: 'active' }] });
    }
    const resource = url.replace('/services-account/v1/', '');
    if (init.headers['x-http-method-override'] === 'GET') {
      const body = JSON.parse(init.body);
      reads.push({ resource, query: body.urlEncodedQueryParams, teamId: body.teamId });
      const page = (pages[resource] || (() => ({ data: [] })))(body.urlEncodedQueryParams);
      return answer(200, page, { csrf: 'tok', csrf_ts: '1' });
    }
    writes.push({ resource, method: init.method, body: JSON.parse(init.body) });
    return answer(201, { data: { id: 'NEW1234567', type: resource, attributes: { name: 'n' } } });
  };
  return { reads, writes, fetch };
}

async function run(args, { pages = {}, fsImpl, findTab, env = {} } = {}) {
  const site = portalSite(pages);
  const out = [];
  const err = [];
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
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': {
      table: (rows) => rows.map((r) => r.join(' ')).join('\n'),
      date: (v) => String(v),
    },
    'sliccy:browser': {
      findTab: findTab || (async () => ({ targetId: 'DEV' })),
      evalAsync: async (_tab, code) => new AsyncFunction('fetch', `return ${code}`)(site.fetch),
    },
    fs: fsImpl || fs,
    os,
    path,
    './lib/portal.js': portal,
  };
  const argv = ['node', 'apple-developer.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const proc = {
    argv,
    env,
    versions: { jsh: '0.64.0' },
    pid: 4242,
    stdout: { write: (s) => out.push(String(s)) },
    exit: (code) => {
      throw new NodeExitError(code);
    },
  };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', 'Buffer', SOURCE)(
      (n) => {
        if (!(n in modules)) throw new Error(`unexpected require(${n})`);
        return modules[n];
      },
      proc,
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) },
      Buffer
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n'), ...site };
}

const bundlePages = {
  bundleIds: () => ({
    data: [{ id: '98864CBM97', type: 'bundleIds', attributes: { identifier: 'ai.example.mac' } }],
  }),
  certificates: () => ({
    data: [
      { id: 'FAYZ34Y65G', type: 'certificates', attributes: { serialNumber: '714FB0EAF0BEA248' } },
    ],
  }),
};

const appIdArgs = [
  'bundle-id',
  'create',
  'ai.example.mac',
  '--name',
  'Example',
  '--capability',
  'ICLOUD',
];
const profileArgs = [
  'profile',
  'create',
  '--name',
  'Example DevID',
  '--type',
  'MAC_APP_DIRECT',
  '--bundle-id',
  'ai.example.mac',
  '--cert',
  '714FB0EAF0BEA248',
];
const appIdBody = portal.bundleIdCreateBody({
  teamId: TEAM,
  identifier: 'ai.example.mac',
  name: 'Example',
  capabilities: ['ICLOUD'],
});
const profileBody = portal.profileCreateBody({
  teamId: TEAM,
  name: 'Example DevID',
  profileType: 'MAC_APP_DIRECT',
  bundleIdId: '98864CBM97',
  certificateIds: ['FAYZ34Y65G'],
});

test('bundle-id create without --confirm prints the body and sends nothing', async () => {
  const r = await run(appIdArgs, { pages: bundlePages });
  is(r.code, 0);
  is(r.writes.length, 0);
  ok(r.stdout.includes('Re-run with --confirm'), r.stdout);
  ok(r.stdout.includes(JSON.stringify(appIdBody, null, 2)), r.stdout);
});

test('bundle-id create with --confirm sends the App ID', async () => {
  const r = await run([...appIdArgs, '--confirm'], { pages: bundlePages });
  is(r.code, 0, r.stderr);
  is(r.writes, [{ resource: 'bundleIds', method: 'POST', body: appIdBody }]);
  ok(r.stdout.includes('created'), r.stdout);
});

test('profile create without --confirm prints the body and sends nothing', async () => {
  const r = await run(profileArgs, { pages: bundlePages });
  is(r.code, 0, r.stderr);
  is(r.writes.length, 0);
  ok(r.stdout.includes('Re-run with --confirm'), r.stdout);
  ok(r.stdout.includes(JSON.stringify(profileBody, null, 2)), r.stdout);
});

test('profile create with --confirm sends the profile', async () => {
  const r = await run([...profileArgs, '--confirm'], { pages: bundlePages });
  is(r.code, 0, r.stderr);
  is(r.writes, [{ resource: 'profiles', method: 'POST', body: profileBody }]);
});

const profilePages = {
  profiles: (query) => {
    if (query.includes('cursor=Mg')) {
      return {
        data: [
          {
            id: 'K2Q8T6ZQTP',
            type: 'profiles',
            attributes: { name: 'Late', uuid: 'u-late', profileContent: CMS.toString('base64') },
          },
        ],
        links: {},
      };
    }
    return {
      data: [
        { id: 'A8F6P4PJTK', type: 'profiles', attributes: { name: 'Early', uuid: 'u-early' } },
      ],
      links: {
        next: 'https://developer.apple.com/services-account/v1/profiles?cursor=Mg&limit=200&include=bundleId,certificates',
      },
    };
  },
};

test('profile follows links.next to find a profile past the first page', async () => {
  const r = await run(['profile', 'Late', '--json'], { pages: profilePages });
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout).id, 'K2Q8T6ZQTP');
  is(
    r.reads.filter((q) => q.resource === 'profiles').map((q) => q.query),
    ['limit=200&include=bundleId,certificates', 'cursor=Mg&limit=200&include=bundleId,certificates']
  );
});

test('profiles lists every page', async () => {
  const r = await run(['profiles', '--json'], { pages: profilePages });
  is(r.code, 0, r.stderr);
  is(
    JSON.parse(r.stdout).map((p) => p.id),
    ['A8F6P4PJTK', 'K2Q8T6ZQTP']
  );
});

function fakeFs({ renameError } = {}) {
  const calls = [];
  const promises = {
    mkdtemp: async (p) => `${p}X`,
    writeFile: async (p, data, opts) => {
      calls.push(['writeFile', p, data.length, opts]);
    },
    rename: async (from, to) => {
      calls.push(['rename', from, to]);
      if (renameError) throw renameError;
    },
    unlink: async (p) => {
      calls.push(['unlink', p]);
    },
  };
  return { calls, fsImpl: { promises } };
}

test('profile download writes a new 0600 file and renames it into place', async () => {
  const { calls, fsImpl } = fakeFs();
  const r = await run(['profile', 'download', 'Late', '--out', '/w/p.provisionprofile'], {
    pages: profilePages,
    fsImpl,
  });
  is(r.code, 0, r.stderr);
  is(calls, [
    ['writeFile', '/w/p.provisionprofile.4242.tmp', CMS.length, { mode: 0o600, flag: 'wx' }],
    ['rename', '/w/p.provisionprofile.4242.tmp', '/w/p.provisionprofile'],
  ]);
  is(r.stdout, '/w/p.provisionprofile');
});

test('profile download removes its temp file when the rename fails', async () => {
  const failure = Object.assign(new Error('EISDIR: illegal operation on a directory'), {
    code: 'EISDIR',
  });
  const { calls, fsImpl } = fakeFs({ renameError: failure });
  const r = await run(['profile', 'download', 'Late', '--out', '/w/dir'], {
    pages: profilePages,
    fsImpl,
  });
  is(r.code, 1);
  ok(/EISDIR/.test(r.stderr), r.stderr);
  is(calls, [
    ['writeFile', '/w/dir.4242.tmp', CMS.length, { mode: 0o600, flag: 'wx' }],
    ['rename', '/w/dir.4242.tmp', '/w/dir'],
    ['unlink', '/w/dir.4242.tmp'],
  ]);
});

// On a host, sliccy-browser finds Chrome (SLICC's on a random port, or 9222)
// only while SLICC_CDP_URL is unset, so the script must not default it; and a
// failed discovery is one line, not sliccy-browser's multi-line "Pass --cdp".
// The error text is sliccy-browser 0.1.44's (src/discover.js).
test('a host run leaves SLICC_CDP_URL unset and reports a failed discovery on one line', async () => {
  const env = {};
  const seen = [];
  const r = await run(['teams'], {
    env,
    findTab: async () => {
      seen.push(env.SLICC_CDP_URL);
      throw new Error(
        'no debugger is connected\n- SLICC_CDP_URL: not set\n- slicc browsers --json: slicc not on PATH\n' +
          '- DevToolsActivePort: no DevToolsActivePort files under slicc profile dirs\n' +
          '- 127.0.0.1:9222: no answer on /json/version\n'
      );
    },
  });
  is(seen.length, 1);
  is(seen[0], undefined, 'SLICC_CDP_URL was not defaulted to 9222');
  is(r.code, 1);
  is(r.stderr.split('\n').length, 1, r.stderr);
  ok(r.stderr.startsWith('cannot find Chrome DevTools (tried slicc browsers --json: '), r.stderr);
  ok(r.stderr.includes('127.0.0.1:9222: no answer on /json/version'), r.stderr);
  ok(r.stderr.includes('set SLICC_CDP_URL=http://127.0.0.1:<port>'), r.stderr);
  ok(!r.stderr.includes('--cdp'), r.stderr);
});
