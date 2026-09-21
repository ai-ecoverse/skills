import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyTestSource,
  detectSkillIntegration,
  isSafeRelPath,
  toTsv,
} from './detect-skill-integration.mjs';

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'detect-skill-integration-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(join(repoRoot, 'skills'), { recursive: true });
  return repoRoot;
}

async function writeSkill(repoRoot, name, files = { 'SKILL.md': `---\nname: ${name}\n---\n` }) {
  const directory = join(repoRoot, 'skills', name);
  await mkdir(directory, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(directory, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, contents);
  }
}

test('classifyTestSource recognises tst, node:test, and neither', () => {
  assert.equal(classifyTestSource("import test, { is } from 'tst';\n"), 'tst');
  assert.equal(classifyTestSource('import test from "tst";\n'), 'tst');
  assert.equal(classifyTestSource("const test = require('tst');\n"), 'tst');
  assert.equal(classifyTestSource("const test = require('node:test');\n"), 'node:test');
  assert.equal(classifyTestSource("import test from 'node:test';\n"), 'node:test');
  assert.equal(classifyTestSource('export function median() {}\n'), 'unknown');
});

test('a file that imports both is classified as tst', () => {
  assert.equal(
    classifyTestSource("import test from 'tst';\nconst nodeTest = require('node:test');\n"),
    'tst'
  );
});

test('isSafeRelPath rejects traversal and odd characters', () => {
  assert.equal(isSafeRelPath('tests/foo.test.js'), true);
  assert.equal(isSafeRelPath('nested/dir/foo.test.ts'), true);
  assert.equal(isSafeRelPath('../escape.test.js'), false);
  assert.equal(isSafeRelPath('tests/../foo.test.js'), false);
  assert.equal(isSafeRelPath('/abs.test.js'), false);
  assert.equal(isSafeRelPath('tests/foo test.js'), false);
});

test('detects a skill with a tst suite', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'median', {
    'SKILL.md': '---\nname: median\n---\n',
    'tests/median.test.js': "import test, { is } from 'tst';\n",
  });

  const result = await detectSkillIntegration({
    changedFiles: ['skills/median/tests/median.test.js'],
    repoRoot,
  });

  assert.deepEqual(result, {
    skills: ['skills/median'],
    has_skills: true,
    has_tst: true,
    targets: [
      {
        name: 'median',
        path: 'skills/median',
        action: 'tst',
        reason: '',
        tstTests: ['tests/median.test.js'],
        skippedTests: [],
      },
    ],
  });
});

test('skips node:test files instead of sending them to tst', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'search', {
    'SKILL.md': '---\nname: search\n---\n',
    'tests/search.test.js': "const test = require('node:test');\n",
    'tests/harness.js': 'module.exports = {};\n',
  });

  const result = await detectSkillIntegration({
    changedFiles: ['skills/search/scripts/search.jsh'],
    repoRoot,
  });

  assert.equal(result.has_tst, false);
  assert.deepEqual(result.targets[0], {
    name: 'search',
    path: 'skills/search',
    action: 'skip',
    reason: 'node:test',
    tstTests: [],
    skippedTests: [{ path: 'tests/search.test.js', runner: 'node:test' }],
  });
});

test('runs only the tst files when a skill mixes runners', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'mixed', {
    'SKILL.md': '---\nname: mixed\n---\n',
    'tests/new.test.ts': 'import test from "tst";\n',
    'tests/legacy.test.js': "const test = require('node:test');\n",
  });

  const result = await detectSkillIntegration({
    changedFiles: ['skills/mixed/SKILL.md'],
    repoRoot,
  });

  assert.equal(result.has_tst, true);
  assert.deepEqual(result.targets[0].action, 'tst');
  assert.deepEqual(result.targets[0].reason, 'partial');
  assert.deepEqual(result.targets[0].tstTests, ['tests/new.test.ts']);
  assert.deepEqual(result.targets[0].skippedTests, [
    { path: 'tests/legacy.test.js', runner: 'node:test' },
  ]);
});

test('a skill with no tests is an install-only skip', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'docs-only');

  const result = await detectSkillIntegration({
    changedFiles: ['skills/docs-only/SKILL.md', 'README.md'],
    repoRoot,
  });

  assert.deepEqual(result.targets[0].action, 'skip');
  assert.deepEqual(result.targets[0].reason, 'none');
  assert.equal(result.has_tst, false);
});

test('ignores deleted skills and non-skill paths', async (t) => {
  const repoRoot = await fixture(t);
  const result = await detectSkillIntegration({
    changedFiles: ['skills/deleted/SKILL.md', '.github/workflows/skill-integration.yml'],
    repoRoot,
  });
  assert.deepEqual(result, { skills: [], has_skills: false, has_tst: false, targets: [] });
});

test('does not walk node_modules for test files', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'pkg', {
    'SKILL.md': '---\nname: pkg\n---\n',
    'tests/ok.test.js': "import test from 'tst';\n",
    'node_modules/other/x.test.js': "import test from 'tst';\n",
  });

  const result = await detectSkillIntegration({
    changedFiles: ['skills/pkg/SKILL.md'],
    repoRoot,
  });
  assert.deepEqual(result.targets[0].tstTests, ['tests/ok.test.js']);
});

test('--all lists every canonical skill', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'alpha');
  await writeSkill(repoRoot, 'beta');
  await mkdir(join(repoRoot, 'skills', 'not-a-skill'));

  const result = await detectSkillIntegration({ repoRoot, all: true });
  assert.deepEqual(result.skills, ['skills/alpha', 'skills/beta']);
  assert.equal(result.targets.length, 2);
});

test('the github skill on this checkout is still node:test, not tst', async () => {
  const result = await detectSkillIntegration({
    changedFiles: ['skills/github/SKILL.md'],
  });
  assert.equal(result.targets[0].action, 'skip');
  assert.equal(result.targets[0].reason, 'node:test');
  assert.ok(result.targets[0].skippedTests.length > 0);
});

test('toTsv is one row per target and is bash-read friendly', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'median', {
    'SKILL.md': '---\nname: median\n---\n',
    'a.test.js': "import test from 'tst';\n",
    'b.test.js': "import test from 'tst';\n",
  });

  const result = await detectSkillIntegration({
    changedFiles: ['skills/median/SKILL.md'],
    repoRoot,
  });
  assert.equal(toTsv(result), 'median|tst||a.test.js,b.test.js|0\n');
  const skipOnly = {
    targets: [
      {
        name: 'search',
        action: 'skip',
        reason: 'node:test',
        tstTests: [],
        skippedTests: [{ path: 'tests/search.test.js', runner: 'node:test' }],
      },
    ],
  };
  assert.equal(toTsv(skipOnly), 'search|skip|node:test||1\n');
});
