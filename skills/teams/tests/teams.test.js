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
