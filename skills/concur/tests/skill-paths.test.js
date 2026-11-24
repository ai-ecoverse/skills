import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { readScript } from './script.js';

const SOURCE = readScript(path.join(process.cwd(), 'scripts/concur.jsh'));
const { stateDir, tempDir } = load(SOURCE, ['stateDir', 'tempDir'], {
  require: () => ({ homedir: () => '/home/fallback' }),
});

test('SLICC 6 keeps the session file in the skill folder', () => {
  is(stateDir({ CONCUR_STATE_DIR: '/x', HOME: '/home/u' }, false, '/opt/skills/concur'), '/opt/skills/concur');
});

test('jsh keeps state in a per-user directory', () => {
  const root = '/opt/skills/concur';
  is(stateDir({ CONCUR_STATE_DIR: '/s', XDG_STATE_HOME: '/x', HOME: '/home/u' }, true, root), '/s');
  is(stateDir({ XDG_STATE_HOME: '/x', HOME: '/home/u' }, true, root), '/x/concur');
  is(stateDir({ HOME: '/home/u' }, true, root), '/home/u/.local/state/concur');
  is(stateDir({}, true, root), '/home/fallback/.local/state/concur');
});

test('receipt temp files go to /shared on SLICC 6 and the temp dir under jsh', () => {
  is(tempDir({ TMPDIR: '/t' }, false), '/shared');
  is(tempDir({ TMPDIR: '/t' }, true), '/t');
  is(tempDir({}, true), '/tmp');
});

test('the script is a jsh command and does not guess its folder from argv', () => {
  ok(readFileSync(path.join(process.cwd(), 'scripts/concur.jsh'), 'utf8').startsWith('#!/usr/bin/env jsh\n'));
  ok(!SOURCE.includes('process.argv[1]'));
});
