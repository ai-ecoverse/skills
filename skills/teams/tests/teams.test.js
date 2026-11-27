// teams.test.js — tst suite for the SLICC 7 parts of teams.jsh: packaging,
// where state lives, the ntfy URL check and the per-phrase environment.
// Run from skills/teams/:  tst tests/teams.test.js

import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { readScript } from './script.js';

const ROOT = process.cwd();
const RAW = readFileSync(path.join(ROOT, 'scripts/teams.jsh'), 'utf8');
const SOURCE = readScript(path.join(ROOT, 'scripts/teams.jsh'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('package maps teams to its script; the script has the jsh hashbang', () => {
  is(pkg.bin, { teams: 'scripts/teams.jsh' });
  ok(pkg.files.includes('scripts') && pkg.files.includes('SKILL.md'));
  ok(/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@ai-ecoverse/sliccy-browser'] ?? ''));
  ok(RAW.startsWith('#!/usr/bin/env jsh\n'));
});

test('nothing left from SLICC 6: no /shared paths, no webhook command, no CDP buffer seed', () => {
  ok(!/['"`]\/shared\//.test(SOURCE), 'no /shared path literals');
  ok(!/webhook (create|delete)/.test(SOURCE));
  ok(!/playwright-cli requests|request-body/.test(SOURCE));
});

test('teams.cloud.microsoft is a Teams host, and the first one tried', () => {
  ok(/const TEAMS_HOSTS = \['teams\.cloud\.microsoft'/.test(SOURCE));
  const { isTeamsHost } = load(SOURCE, ['isTeamsHost'], { TEAMS_HOSTS: ['teams.cloud.microsoft', 'teams.microsoft.com', 'teams.live.com'] });
  ok(isTeamsHost('teams.cloud.microsoft'));
  ok(!isTeamsHost('login.microsoftonline.com'));
});

test('stateDir: TEAMS_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state/teams', () => {
  const { stateDir } = load(SOURCE, ['stateDir'], {});
  is(stateDir({ TEAMS_STATE_DIR: '/s', XDG_STATE_HOME: '/x', HOME: '/h' }), '/s');
  is(stateDir({ XDG_STATE_HOME: '/x', HOME: '/h' }), '/x/teams');
  is(stateDir({ HOME: '/h' }), '/h/.local/state/teams');
});

test('ntfyUrl accepts https only, without credentials', () => {
  const { ntfyUrl } = load(SOURCE, ['ntfyUrl'], {});
  is(ntfyUrl('https://ntfy.sliccy.ai/hook/abc'), 'https://ntfy.sliccy.ai/hook/abc');
  is(ntfyUrl('http://ntfy.sliccy.ai/hook/abc'), null);
  is(ntfyUrl('https://u:p@ntfy.sh/t'), null);
  is(ntfyUrl('not a url'), null);
  is(ntfyUrl(true), null, 'a bare --ntfy is refused');
});

test('phraseEnv passes the phrase as data in TEAMS_* variables', () => {
  const { phraseEnv } = load(SOURCE, ['phraseEnv'], {});
  const e = phraseEnv({ author: 'A', text: '$(rm -rf /)', ts: Date.UTC(2026, 10, 27, 9, 0, 0) });
  is(e.TEAMS_TEXT, '$(rm -rf /)');
  is(e.TEAMS_AUTHOR, 'A');
  is(e.TEAMS_TS, '2026-11-27T09:00:00.000Z');
  is(JSON.parse(e.TEAMS_RAW).text, '$(rm -rf /)');
});

test('findTeamsTab reuses its own saved tab and never picks one of the user\'s', async () => {
  const opened = [];
  const scope = {
    flags: {},
    TEAMS_URL: 'https://teams.cloud.microsoft/',
    _readState: () => ({ targetId: 'OWN' }),
    _writeState: () => {},
    isTeamsHost: (h) => h === 'teams.cloud.microsoft',
    _targetId: (t) => t.targetId,
    sleep: async () => {},
    die: (m) => { throw new Error(m); },
    browser: {
      eval: async (t) => (t.targetId === 'OWN' ? 'teams.cloud.microsoft' : ''),
      ensureTab: async (u, o) => { opened.push([u, o]); return { targetId: 'NEW' }; },
      findTab: async () => { throw new Error('must not look for the user\'s tabs'); },
    },
  };
  const { findTeamsTab } = load(SOURCE, ['findTeamsTab'], scope);
  is(await findTeamsTab(), { targetId: 'OWN' });
  is(opened.length, 0);
  scope._readState = () => ({});
  scope.browser.eval = async (t) => (t.targetId === 'NEW' ? 'teams.cloud.microsoft' : '');
  is(await findTeamsTab(), { targetId: 'NEW' });
  is(opened.length, 1, 'opened a new background tab');
});

// ── meeting tab ───────────────────────────────────────────────────────────────

const TAB_LIST = `8: [AAA111AA] https://teams.cloud.microsoft/ "(3) Chat | Someone | Microsoft Teams"
9: [0FF999AA] https://teams.cloud.microsoft/ "(3) Chat | Someone | Microsoft Teams" (active)
12: [ABC222AA] https://teams.cloud.microsoft/ "Meeting with Ops | Microsoft Teams"
13: [DEF333AA] https://example.com/ "Other"`;

test('parseTabList reads playwright-cli tab-list lines', () => {
  const { parseTabList } = load(SOURCE, ['parseTabList'], {});
  const tabs = parseTabList(TAB_LIST);
  is(tabs.length, 4);
  is(tabs[2], { targetId: 'ABC222AA', url: 'https://teams.cloud.microsoft/', title: 'Meeting with Ops | Microsoft Teams' });
});

test("pickMeetingTab skips teams' own tab, even listed first, and prefers a meeting", () => {
  const { pickMeetingTab } = load(SOURCE, ['pickMeetingTab'], {});
  const own = { targetId: 'OWN', title: 'Chat' };
  is(pickMeetingTab([own, { targetId: 'U1', title: 'Chat' }, { targetId: 'M', title: 'Meeting with Ops' }], 'OWN').targetId, 'M');
  is(pickMeetingTab([own, { targetId: 'U1', title: 'Chat' }], 'OWN').targetId, 'U1', 'the user tab behind our own one');
  is(pickMeetingTab([own], 'OWN'), null);
});

test('findMeetingTab lists every Teams tab, not just the first per host', async () => {
  const scope = {
    flags: {},
    TEAMS_URL: 'https://teams.cloud.microsoft/',
    TEAMS_HOSTS: ['teams.cloud.microsoft'],
    _readState: () => ({ targetId: '0FF999AA' }),
    exec: { spawn: async (argv) => (argv[1] === 'tab-list' ? { exitCode: 0, stdout: TAB_LIST.replace('[AAA111AA]', '[0FF999AA]').replace('9: [0FF999AA]', '9: [AAA111AA]') } : { exitCode: 1 }) },
    browser: { findTab: async () => { throw new Error('findTab must not be used when tab-list works'); } },
    die: (m) => { throw new Error(m); },
  };
  const api = load(SOURCE, ['parseTabList', 'hostOf', 'isTeamsHost', 'listTeamsTabs', 'pickMeetingTab', 'findMeetingTab', '_targetId'], scope);
  is(await api.findMeetingTab(), { targetId: 'ABC222AA' });
});

// ── sign-in bootstrap ─────────────────────────────────────────────────────────

test('reloadAndHook reloads, installs the hook in the new document, then waits for the web client', async () => {
  const evals = [];
  let doc = 'old';
  let polls = 0;
  const browser = {
    eval: async (_tab, js) => {
      evals.push(js);
      if (js.includes('location.reload()')) { doc = 'loading'; return 'ok'; }
      if (js.includes("window.__sliccTeamsOld) return 'old'")) {
        if (doc === 'loading') { doc = 'new'; throw new Error('navigating'); }
        return 'hooked';
      }
      if (js.includes('__sliccTeamsAuthAll')) { polls++; return polls >= 3; }
      return null;
    },
  };
  const { reloadAndHook } = load(SOURCE, ['reloadAndHook'], { browser, sleep: async () => {}, AUTH_PREAMBLE: '/*preamble*/' });
  is(await reloadAndHook({ targetId: 'OWN' }), true);
  ok(evals[0].includes('location.reload()'), 'reloads first');
  ok(evals.some((js) => js.includes('/*preamble*/')), 'installs the auth preamble');
  is(polls, 3, 'waited until the Teams web client sign-in arrived');
});

test('reloadAndHook gives up when no sign-in arrives', async () => {
  const browser = { eval: async (_t, js) => (js.includes("return 'old'") ? 'hooked' : js.includes('__sliccTeamsAuthAll') ? false : 'ok') };
  const { reloadAndHook } = load(SOURCE, ['reloadAndHook'], { browser, sleep: async () => {}, AUTH_PREAMBLE: '' });
  is(await reloadAndHook({ targetId: 'OWN' }), false);
});

// ── the in-page token code, run against a fake page ──────────────────────────

const PREAMBLE = /const AUTH_PREAMBLE = `([\s\S]*?)\n`;/.exec(SOURCE)[1];
const WEB = '5e3ce6c0-2b1f-4285-8d4b-75ee78787346';

function fakePage(tokenAnswer) {
  const posts = [];
  const win = {};
  win.fetch = async (url, init) => {
    posts.push({ url: String(url), body: String((init && init.body) || '') });
    return { json: async () => tokenAnswer(new URLSearchParams(String(init.body))) };
  };
  class XHR {}
  XHR.prototype.open = function () {};
  XHR.prototype.send = function () {};
  win.XMLHttpRequest = XHR;
  const run = new Function('window', 'XMLHttpRequest', 'URLSearchParams', 'atob', `
    const fetch = (...a) => window.fetch(...a);
    ${PREAMBLE}
    return { getToken: __getToken };`);
  const api = run(win, XHR, URLSearchParams, (s) => Buffer.from(s, 'base64').toString('binary'));
  return { win, posts, api };
}

test('the hook keeps one sign-in per client and prefers the Teams web client', async () => {
  const { win, api } = fakePage((p) => (p.get('client_id') === WEB ? { access_token: 'aaa.e30.zzz', refresh_token: 'rt-web-2', expires_in: 3600 } : { error: 'invalid_grant' }));
  const auth = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token';
  // Teams posts token requests: the web client first, another client last.
  await win.fetch(auth, { body: new URLSearchParams({ client_id: WEB, refresh_token: 'rt-web', scope: 'x' }).toString() });
  await win.fetch(auth, { body: new URLSearchParams({ client_id: 'other-client', refresh_token: 'rt-other', scope: 'y' }).toString() });
  is(Object.keys(win.__sliccTeamsAuthAll).sort(), [WEB, 'other-client'].sort());
  is(win.__sliccTeamsAuth.clientId, WEB, 'the web client wins over the last-seen one');
  is(await api.getToken('graph.microsoft.com'), 'aaa.e30.zzz');
  is(win.__sliccTeamsAuthAll[WEB].rt, 'rt-web-2', 'the rotated refresh token is kept');
});

test('__getToken falls through to another client when one is refused', async () => {
  const { win, posts, api } = fakePage((p) => (p.get('client_id') === 'second' ? { access_token: 'bbb.e30.zzz', expires_in: 3600 } : { error: 'invalid_grant' }));
  win.__sliccTeamsAuthAll = { first: { rt: 'r1', clientId: 'first', authority: 'https://a' }, second: { rt: 'r2', clientId: 'second', authority: 'https://a' } };
  is(await api.getToken('substrate.office.com'), 'bbb.e30.zzz');
  ok(posts.every((x) => new URLSearchParams(x.body).get('scope') === 'https://substrate.office.com/.default'));
});

// ── copilot delivery ──────────────────────────────────────────────────────────

test('runPhraseCommand runs sh -c with the phrase only in the environment', async () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    const handlers = {};
    setTimeout(() => handlers.close && handlers.close(0), 0);
    return { on: (ev, f) => { handlers[ev] = f; } };
  };
  const { runPhraseCommand } = load(SOURCE, ['runPhraseCommand', 'phraseEnv'], {
    require: (m) => (m === 'child_process' ? { spawn } : null),
    process: { env: { PATH: '/bin' } },
  });
  is(await runPhraseCommand('handle "$TEAMS_TEXT"', { author: 'A', text: "it's; rm -rf /", ts: 1 }), 0);
  is(calls[0].cmd, 'sh');
  is(calls[0].args, ['-c', 'handle "$TEAMS_TEXT"'], 'the phrase is never spliced into the command');
  is(calls[0].env.TEAMS_TEXT, "it's; rm -rf /");
  is(calls[0].env.PATH, '/bin');
});

test('setCollectorWebhook points the in-page collector at the ntfy URL, and the collector posts to it', async () => {
  const page = {};
  const browser = { evalAsync: async (_t, js) => new Function('window', `return ${js};`)(page) };
  const { setCollectorWebhook } = load(SOURCE, ['setCollectorWebhook'], { browser });
  await setCollectorWebhook({}, 'https://ntfy.sliccy.ai/hook/abc');
  is(page.__sliccCapWebhook, 'https://ntfy.sliccy.ai/hook/abc');
  await setCollectorWebhook({}, '');
  is(page.__sliccCapWebhook, '');
  ok(/fetch\(window\.__sliccCapWebhook, \{ method: 'POST'/.test(SOURCE), 'the collector POSTs each phrase to that URL');
});
