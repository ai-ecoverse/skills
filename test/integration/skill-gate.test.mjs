import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { detectSkillIntegration } from '../../tools/detect-skill-integration.mjs';
import { CONNECT_FAILURE, REPO_ROOT } from './leader.mjs';
import { allSkills, brokenManifests, PARTITIONS, partition, tapVerdict } from './skills.mjs';

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function changedFiles() {
  let base;
  if (process.env.GITHUB_ACTIONS === 'true') {
    git('fetch', '--quiet', '--no-tags', '--depth=2', 'origin', git('rev-parse', 'HEAD'));
    base = git('rev-parse', 'HEAD^1');
  } else {
    base = git('merge-base', 'origin/main', 'HEAD');
  }
  return git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
}

test('every changed skill has an in-SLICC tst suite', async () => {
  const files = changedFiles();
  const result = await detectSkillIntegration({ changedFiles: files });
  assert.deepEqual(
    result.missing_tst,
    [],
    `add a *.test.js that imports tst (CLAUDE.md §16) to: ${result.missing_tst.join(', ')}`
  );
});

test('the partitions cover every skill exactly once', () => {
  const skills = allSkills();
  const seen = [];
  for (let i = 0; i < PARTITIONS; i += 1) seen.push(...partition(i, skills));
  assert.ok(skills.length > PARTITIONS);
  assert.deepEqual([...seen].sort(), skills);
  assert.equal(new Set(seen).size, skills.length);
});

test('a tst run passes only when a test ran and none failed', () => {
  const pass = (stdout, status = 0) => tapVerdict({ status, stdout }).pass;
  assert.equal(pass('ok 1 - a\nok 2 - b # SKIP skip\n1..2\n'), true);
  assert.equal(pass('ok 1 - a\n', 1), false);
  assert.equal(pass(''), false);
  assert.equal(pass('1..0\n# tests 0\n'), false);
  assert.equal(pass('ok 1 - a # SKIP skip\nok 2 - b # SKIP todo\n'), false);
  assert.equal(pass('ok 1 - a\nnot ok 2 - b\n'), false);
});

test('a leader exec that lost its connection is retried', () => {
  assert.equal(CONNECT_FAILURE.test('slicc exec: connection closed\n'), true);
  assert.equal(CONNECT_FAILURE.test('tray connect timed out'), true);
  assert.equal(CONNECT_FAILURE.test('slicc exec: terminal-open timed out after 10000ms'), true);
  assert.equal(CONNECT_FAILURE.test('Error: fastly: tst exited 1'), false);
});

test('a global package whose package.json is not JSON counts as broken', () => {
  const listing = [
    '==> /shared/lib/node_modules/minimatch/package.json <==',
    '{"name":"minimatch","version":"9.0.5"}',
    '==> /shared/lib/node_modules/brace-expansion/package.json <==',
    '\u0000\u0000\u0000\u0000',
    '==> /shared/lib/node_modules/@scope/pkg/package.json <==',
    '{"version":"1.0.0"}',
    '',
  ].join('\n');
  assert.deepEqual(brokenManifests(listing), [
    '/shared/lib/node_modules/brace-expansion/package.json',
    '/shared/lib/node_modules/@scope/pkg/package.json',
  ]);
  assert.deepEqual(brokenManifests(''), []);
});
