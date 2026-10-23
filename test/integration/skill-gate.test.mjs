import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectSkillIntegration } from '../../tools/detect-skill-integration.mjs';
import * as leader from './leader.mjs';
import { allSkills, brokenManifests, PARTITIONS, partition, tapVerdict } from './skills.mjs';

const { CONNECT_FAILURE, REPO_ROOT, withRetries } = leader;

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

test('leader setup retries a failing step and rethrows the last error', async () => {
  let calls = 0;
  const wait = async () => {};
  const value = await withRetries(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error(`no published release (${calls})`);
      return 'ok';
    },
    { wait }
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  await assert.rejects(
    withRetries(
      async (attempt) => {
        throw new Error(`failed ${attempt}`);
      },
      { attempts: 2, wait }
    ),
    /failed 2/
  );
});

test('a leader that fails to boot is booted again in a fresh home and its log is kept', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boot-leader-'));
  try {
    const artifacts = join(root, 'artifacts');
    mkdirSync(artifacts);
    const homes = [];
    const home = await leader.bootLeader(
      async (dir) => {
        homes.push(dir);
        if (homes.length === 1) {
          writeFileSync(join(dir, 'leader.log'), 'POST https://www.sliccy.ai/join/s3cret ← 503\n');
        }
        if (homes.length < 3) throw new Error(`no join URL (${homes.length})`);
        return dir;
      },
      { root, artifacts, wait: async () => {} }
    );
    assert.equal(home, join(root, 'leader-3'));
    assert.deepEqual(
      homes,
      [1, 2, 3].map((n) => join(root, `leader-${n}`))
    );
    assert.deepEqual(readdirSync(artifacts), ['leader-failed-1.log']);
    assert.equal(
      readFileSync(join(artifacts, 'leader-failed-1.log'), 'utf8'),
      'POST https://www.sliccy.ai/join/<token> ← 503\n'
    );
    await assert.rejects(
      leader.bootLeader(
        async () => {
          throw new Error('tray 503');
        },
        { root: join(root, 'again'), artifacts, attempts: 2, wait: async () => {} }
      ),
      /tray 503/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
