import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { detectTesslChanges } from './detect-tessl-changes.mjs';

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'detect-tessl-changes-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  return repoRoot;
}

async function writeSkill(repoRoot, name) {
  const directory = join(repoRoot, 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

test('detects a new unpublished canonical skill', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'new-skill');

  const result = await detectTesslChanges({
    changedFiles: ['skills/new-skill/SKILL.md', 'skills/new-skill/scripts/run.jsh'],
    repoRoot,
  });

  assert.deepEqual(result, { skills: ['skills/new-skill'], plugins: [] });
});

test('detects an existing published skill without consulting membership', async (t) => {
  const repoRoot = await fixture(t);
  await writeSkill(repoRoot, 'published');
  await mkdir(join(repoRoot, 'tiles', 'basic', '.tessl-plugin'), { recursive: true });
  await writeFile(
    join(repoRoot, 'tiles', 'basic', '.tessl-plugin', 'plugin.json'),
    JSON.stringify({ skills: ['skills/published'] })
  );

  const result = await detectTesslChanges({
    changedFiles: ['skills/published/references/api.md'],
    repoRoot,
  });

  assert.deepEqual(result, { skills: ['skills/published'], plugins: [] });
});

test('skips a deleted skill', async (t) => {
  const repoRoot = await fixture(t);
  const result = await detectTesslChanges({
    changedFiles: ['skills/deleted/SKILL.md'],
    repoRoot,
  });

  assert.deepEqual(result, { skills: [], plugins: [] });
});

test('ignores non-skill changes', async (t) => {
  const repoRoot = await fixture(t);
  const result = await detectTesslChanges({
    changedFiles: ['README.md', '.github/workflows/tessl-review.yml'],
    repoRoot,
  });

  assert.deepEqual(result, { skills: [], plugins: [] });
});

test('maps a manifest-only change to staged plugin validation', async (t) => {
  const repoRoot = await fixture(t);
  const result = await detectTesslChanges({
    changedFiles: ['tiles/advanced/.tessl-plugin/plugin.json'],
    repoRoot,
  });

  assert.deepEqual(result, { skills: [], plugins: ['advanced'] });
});
