import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { stageSkill } from './stage-tessl-skill.mjs';

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'stage-tessl-skill-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const source = join(repoRoot, 'skills', 'unpublished');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'SKILL.md'), '---\nname: unpublished\ndescription: Test.\n---\n');
  return repoRoot;
}

test('stages an unpublished canonical skill as an isolated lint package', async (t) => {
  const repoRoot = await fixture(t);
  const destination = join(repoRoot, 'stage');
  await stageSkill({ skillPath: 'skills/unpublished', destination, repoRoot });

  const manifest = JSON.parse(
    await readFile(join(destination, '.tessl-plugin', 'plugin.json'), 'utf8')
  );
  assert.deepEqual(manifest.skills, ['skills/unpublished']);
  assert.equal(
    await readFile(join(destination, 'skills/unpublished/SKILL.md'), 'utf8'),
    '---\nname: unpublished\ndescription: Test.\n---\n'
  );
  assert.equal((await lstat(join(destination, 'skills/unpublished'))).isSymbolicLink(), false);
});

test('rejects unsafe paths and overlapping destinations before writing', async (t) => {
  const repoRoot = await fixture(t);
  await assert.rejects(
    stageSkill({ skillPath: '../unpublished', destination: join(repoRoot, 'stage'), repoRoot }),
    /unsafe skill path/
  );
  await assert.rejects(
    stageSkill({
      skillPath: 'skills/unpublished',
      destination: join(repoRoot, 'skills/unpublished/stage'),
      repoRoot,
    }),
    /destination overlaps canonical skill/
  );
});

test('rejects a destination reached through a symlinked source ancestor without writing', async (t) => {
  const repoRoot = await fixture(t);
  const source = join(repoRoot, 'skills/unpublished');
  const alias = join(repoRoot, 'skill-alias');
  await symlink(source, alias, 'dir');

  await assert.rejects(
    stageSkill({
      skillPath: 'skills/unpublished',
      destination: join(alias, 'stage'),
      repoRoot,
    }),
    /destination overlaps canonical skill/
  );
  assert.deepEqual(await readdir(source), ['SKILL.md']);
});

test('rejects source symlinks before creating output', async (t) => {
  const repoRoot = await fixture(t);
  const destination = join(repoRoot, 'stage');
  await symlink('SKILL.md', join(repoRoot, 'skills/unpublished/linked.md'));
  await assert.rejects(
    stageSkill({ skillPath: 'skills/unpublished', destination, repoRoot }),
    /symbolic links are not allowed/
  );
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
});
