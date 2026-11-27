// state.test.js — where gmail keeps its persisted config (tst).
// Under jsh it is a per-user file, never the skill folder, which is often
// root's: writing scripts/.config there failed with EACCES (2026-11-27).

import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { readScript } from './script.js';

const SOURCE = readScript(path.join(process.cwd(), 'scripts/gmail.jsh'));

test('stateDir: SLICC 6 (no jsh) keeps skill.config()', () => {
  const { stateDir } = load(SOURCE, ['stateDir'], {});
  is(stateDir({ HOME: '/home/u', GMAIL_STATE_DIR: '/s' }, false), null);
});

test('stateDir: GMAIL_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state', () => {
  const { stateDir } = load(SOURCE, ['stateDir'], {});
  is(stateDir({ GMAIL_STATE_DIR: '/s', XDG_STATE_HOME: '/x', HOME: '/home/u' }, true), '/s');
  is(stateDir({ XDG_STATE_HOME: '/x', HOME: '/home/u' }, true), '/x/gmail');
  is(stateDir({ HOME: '/home/u' }, true), '/home/u/.local/state/gmail');
});

function memfs(files = {}) {
  const ops = [];
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    files,
    ops,
    promises: {
      readFile: async (p) => { if (!(p in files)) throw err('ENOENT'); return files[p].data; },
      writeFile: async (p, data, o) => { ops.push(['write', p, o && o.mode]); files[p] = { data, mode: o && o.mode }; },
      mkdir: async (p, o) => { ops.push(['mkdir', p, o && o.mode]); },
      chmod: async (p, m) => { files[p].mode = m; },
      rename: async (a, b) => { ops.push(['rename', a, b]); files[b] = files[a]; delete files[a]; },
    },
  };
}

function setup(fs, legacy) {
  const writes = [];
  const scope = {
    STATE_DIR: '/home/u/.local/state/gmail',
    fs,
    process: { pid: 7 },
    skill: { config: async (v) => { if (v === undefined) return legacy ?? null; writes.push(v); return null; } },
  };
  return { ...load(SOURCE, ['loadConfig', 'writeConfig', 'saveConfig'], scope), writes };
}

test('save writes a 0600 file in a 0700 dir and never the skill folder', async () => {
  const fs = memfs();
  const t = setup(fs, { refresh_token: 'old' });
  await t.saveConfig({ access_token: 'a' });
  is(t.writes, [], 'skill.config() not written');
  const f = fs.files['/home/u/.local/state/gmail/config.json'];
  ok(f, 'config.json written');
  is(f.mode, 0o600);
  is(JSON.parse(f.data), { refresh_token: 'old', access_token: 'a' }, 'legacy sign-in carried over');
  ok(fs.ops.some((o) => o[0] === 'mkdir' && o[2] === 0o700));
  ok(fs.ops.some((o) => o[0] === 'rename'), 'written through a rename');
});

test('load prefers the state file over the legacy config', async () => {
  const fs = memfs({ '/home/u/.local/state/gmail/config.json': { data: '{"account":"new"}' } });
  is(await setup(fs, { account: 'legacy' }).loadConfig(), { account: 'new' });
});

test('load falls back to the legacy config, and to {} without one', async () => {
  is(await setup(memfs(), { account: 'legacy' }).loadConfig(), { account: 'legacy' });
  is(await setup(memfs(), null).loadConfig(), {});
});
