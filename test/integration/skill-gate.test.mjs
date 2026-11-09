import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  binEntries,
  checkSkills,
  parseLsFiles,
  readFrom,
  shippedChanges,
} from '../../tools/check-skill-packages.mjs';
import { detectSkillIntegration } from '../../tools/detect-skill-integration.mjs';
import { closure, REPO_ROOT } from './kernel.mjs';
import {
  allSkills,
  PARTITIONS,
  packagedSkills,
  partition,
  suiteCommand,
  tapVerdict,
} from './skills.mjs';

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

const files = changedFiles();
const changed = await detectSkillIntegration({ changedFiles: files });

test('every changed skill has a tst suite', () => {
  assert.deepEqual(
    changed.missing_tst,
    [],
    `add a *.test.js that imports tst (CLAUDE.md §16) to: ${changed.missing_tst.join(', ')}`
  );
});

test('every skill whose shipped files changed, if it has commands, is a package whose bin lists them', () => {
  const tracked = parseLsFiles(git('ls-files', '-s'));
  const names = shippedChanges(files).filter((name) => tracked.has(`skills/${name}/SKILL.md`));
  const problems = checkSkills({ tracked, read: readFrom(REPO_ROOT), names, requirePackage: true });
  assert.deepEqual(
    problems,
    [],
    `SLICC 7 installs a skill's commands from its package.json (CLAUDE.md §16):\n${problems.join('\n')}`
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
  assert.equal(pass('ok 1 - a\n1..1\n', 124), false);
});

test('a suite runs under a timeout, on the kernel node', () => {
  const argv = suiteCommand('tests/x.test.js');
  assert.equal(argv[0], 'timeout');
  assert.deepEqual(argv.slice(2), ['node', 'tests/x.test.js']);
});

test('the kernel gets each module with its whole dependency tree from the lockfile', () => {
  const tree = closure(['minimatch']);
  assert.ok(tree.includes('node_modules/minimatch'));
  assert.ok(tree.includes('node_modules/brace-expansion'));
  assert.ok(tree.includes('node_modules/balanced-match'));
  assert.throws(() => closure(['no-such-package-here']), /not in package-lock\.json/);
});

test('bin entries: a string bin is named after the unscoped package', () => {
  assert.deepEqual(binEntries({ name: '@ai-ecoverse/x', bin: 'scripts/x' }), [['x', 'scripts/x']]);
  assert.deepEqual(binEntries({ bin: { a: 'scripts/a.jsh' } }), [['a', 'scripts/a.jsh']]);
  assert.deepEqual(binEntries({}), []);
  assert.ok(packagedSkills().some(({ skill }) => skill === 'slack'));
});
