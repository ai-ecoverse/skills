// cdp-discovery.test.js — how slack and slack-ext reach Chrome on a host.
//
// Finding Chrome's DevTools endpoint belongs to @ai-ecoverse/sliccy-browser
// (0.1.44: SLICC_CDP_URL, then `slicc browsers --json`, then DevToolsActivePort
// under SLICC's profile dirs, then 127.0.0.1:9222). It does that only while
// SLICC_CDP_URL is unset, so the scripts must leave it unset; they used to
// default it to 127.0.0.1:9222, which failed against SLICC's Chrome on its
// random --remote-debugging-port=0 port (2026-11-23).
//
// When nothing answers, sliccy-browser throws a multi-line error; the scripts
// must print one line with what was tried and how to set SLICC_CDP_URL, exit 1,
// and show no stack trace. The error texts below are sliccy-browser 0.1.44's
// (src/discover.js resolveCdpEndpoint, src/connect.js discoveryFailure).
//
// Both scripts run unmodified from disk as an AsyncFunction body under jsh
// (process.versions.jsh set), with stub modules. Offline and deterministic.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';
import * as argvMod from '../scripts/argv.js';
import * as manifestDiffMod from '../scripts/manifest-diff.js';
import * as gridMod from '../scripts/slack-ext-grid.js';
import { nodeFs } from './node-fs.js';
import { readScript } from './script.js';

const SLACK = fileURLToPath(new URL('../scripts/slack.jsh', import.meta.url));
const SLACK_EXT = fileURLToPath(new URL('../scripts/slack-ext.jsh', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WS = 'E06V3987PMY';

const DISCOVERY_FAILED =
  'no debugger is connected\n' +
  '- SLICC_CDP_URL: not set\n' +
  '- slicc browsers --json: slicc not on PATH\n' +
  '- DevToolsActivePort: no DevToolsActivePort files under slicc profile dirs\n' +
  '- 127.0.0.1:9222: no answer on /json/version\n';
const EXPLICIT_FAILED =
  'fetch failed\nThis CLI does not launch Chrome. Pass --cdp or set SLICC_CDP_URL.\n';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.exitCode = code;
  }
}

// A sliccy:browser whose first call either throws `fail` or finds a Slack tab
// with a token; it records SLICC_CDP_URL as the script left it at that call.
function browserStub(env, fail) {
  const seen = [];
  const tab = { targetId: 'tab1', url: `https://app.slack.com/client/${WS}/C0000000001` };
  return {
    seen,
    async findTab() {
      seen.push(env.SLICC_CDP_URL);
      if (fail) throw fail;
      return tab;
    },
    async localStorage() {
      return JSON.stringify({ teams: { [WS]: { token: 'xoxc-test' } } });
    },
    async fetch() {
      return { ok: true, status: 200, body: { ok: true, messages: [], has_more: false } };
    },
  };
}

async function run(script, argv, { env = {}, fail, modules = {} } = {}) {
  const procEnv = { HOME: '/home/tester', ...env };
  const browser = browserStub(procEnv, fail);
  const stdout = [];
  const stderr = [];
  const all = { 'sliccy:browser': browser, ...modules };
  const req = (id) => {
    if (Object.hasOwn(all, id)) return all[id];
    throw new Error(`unexpected require(${id})`);
  };
  const proc = {
    argv: ['node', script, ...argv],
    env: procEnv,
    versions: { node: '24.0.0', jsh: '0.64.0' },
    pid: 4242,
    exit: (code = 0) => {
      throw new NodeExitError(code);
    },
    on: () => {},
    off: () => {},
  };
  const cons = {
    log: (...a) => stdout.push(a.map(String).join(' ')),
    info: (...a) => stdout.push(a.map(String).join(' ')),
    error: (...a) => stderr.push(a.map(String).join(' ')),
    warn: (...a) => stderr.push(a.map(String).join(' ')),
  };
  const body = new AsyncFunction(
    'require',
    'process',
    'console',
    '__dirname',
    '__filename',
    readScript(script)
  );
  let exitCode = 0;
  let thrown = null;
  try {
    await body(req, proc, cons, path.dirname(script), script);
  } catch (e) {
    if (e && e.name === 'NodeExitError') {
      exitCode = e.exitCode;
      if (e.dieMessage) stderr.push(e.dieMessage); // cli.die's line on stderr
    } else thrown = e;
  }
  return { exitCode, thrown, seen: browser.seen, out: stdout.join('\n'), err: stderr.join('\n') };
}

const slackModules = () => ({
  'sliccy:exec': {
    exec: async () => {
      throw new Error('not expected');
    },
  },
  fs: nodeFs({}),
  os,
  path,
});

const slack = (argv, o = {}) => run(SLACK, argv, { ...o, modules: slackModules() });

const slackExt = (argv, o = {}) =>
  run(SLACK_EXT, argv, {
    ...o,
    modules: {
      'sliccy:cli': {
        die(message, opts = {}) {
          throw Object.assign(new NodeExitError(opts.exitCode ?? 1), {
            dieMessage: `${opts.prefix ?? 'Error'}: ${message}`,
          });
        },
        help: () => {
          throw new NodeExitError(0);
        },
        out: () => {},
        warn: () => {},
      },
      'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
      'sliccy:http': { client: () => ({}) },
      'sliccy:skill': { config: async () => null },
      fs: nodeFs({}),
      './argv.js': argvMod.default || argvMod,
      './manifest-diff.js': manifestDiffMod.default || manifestDiffMod,
      './slack-ext-grid.js': gridMod.default || gridMod,
    },
  });

// ─── slack ───────────────────────────────────────────────────────────────────

test('slack leaves SLICC_CDP_URL unset so sliccy-browser can find Chrome', async () => {
  const r = await slack([`--ws=${WS}`, 'history', 'C0000000001', '--limit=1']);
  is(r.thrown, null);
  is(r.exitCode, 0);
  ok(r.seen.length > 0, 'the command reached the browser');
  is(r.seen[0], undefined, 'SLICC_CDP_URL was not defaulted to 9222');
});

test('slack keeps a SLICC_CDP_URL the user set', async () => {
  const r = await slack([`--ws=${WS}`, 'history', 'C0000000001'], {
    env: { SLICC_CDP_URL: 'http://127.0.0.1:9333' },
  });
  is(r.exitCode, 0);
  is(r.seen[0], 'http://127.0.0.1:9333');
});

test('slack prints one line naming what discovery tried when no Chrome answers', async () => {
  const r = await slack([`--ws=${WS}`, 'history', 'C0000000001'], {
    fail: new Error(DISCOVERY_FAILED),
  });
  is(r.thrown, null, 'no uncaught error (no stack trace)');
  is(r.exitCode, 1);
  is(r.out, '');
  is(r.err.split('\n').length, 1, `one line: ${r.err}`);
  ok(r.err.startsWith('Error: cannot find Chrome DevTools (tried slicc browsers --json: '), r.err);
  ok(r.err.includes('DevToolsActivePort: no DevToolsActivePort files'), r.err);
  ok(r.err.includes('127.0.0.1:9222: no answer on /json/version'), r.err);
  ok(r.err.includes('set SLICC_CDP_URL=http://127.0.0.1:<port>'), r.err);
  ok(!r.err.includes('--cdp'), 'no advice about a flag slack does not have');
});

test('slack names the SLICC_CDP_URL it could not reach, on one line', async () => {
  const r = await slack([`--ws=${WS}`, 'history', 'C0000000001'], {
    env: { SLICC_CDP_URL: 'http://127.0.0.1:9333' },
    fail: new Error(EXPLICIT_FAILED),
  });
  is(r.thrown, null);
  is(r.exitCode, 1);
  is(
    r.err,
    'Error: cannot reach Chrome DevTools at SLICC_CDP_URL=http://127.0.0.1:9333 (fetch failed); ' +
      'check that Chrome is listening there, or unset SLICC_CDP_URL to find it automatically'
  );
});

test('slack leaves other errors alone', async () => {
  const boom = new Error('something else broke');
  const r = await slack([`--ws=${WS}`, 'history', 'C0000000001'], { fail: boom });
  is(r.thrown, boom);
});

// ─── slack-ext ───────────────────────────────────────────────────────────────

test('slack-ext leaves SLICC_CDP_URL unset and reports a failed discovery on one line', async () => {
  const r = await slackExt([`--ws=${WS}`, 'status', 'U0000000001'], {
    fail: new Error(DISCOVERY_FAILED),
  });
  ok(r.seen.length > 0, 'the command reached the browser');
  is(r.seen[0], undefined, 'SLICC_CDP_URL was not defaulted to 9222');
  is(r.thrown, null);
  is(r.exitCode, 1);
  is(r.err.split('\n').length, 1, `one line: ${r.err}`);
  ok(
    r.err.startsWith('slack-ext: cannot find Chrome DevTools (tried slicc browsers --json: '),
    r.err
  );
  ok(r.err.includes('set SLICC_CDP_URL=http://127.0.0.1:<port>'), r.err);
  ok(!r.err.includes('--cdp'), r.err);
});
