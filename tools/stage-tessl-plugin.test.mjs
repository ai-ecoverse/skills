import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { stagePlugin } from './stage-tessl-plugin.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tessl-stage-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeManifest(repoRoot, pluginName, skills) {
  const directory = join(repoRoot, 'tiles', pluginName, '.tessl-plugin');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'plugin.json'),
    `${JSON.stringify({ name: pluginName, skills }, null, 2)}\n`
  );
}

async function writeSkill(repoRoot, skillName) {
  const directory = join(repoRoot, 'skills', skillName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `# ${skillName}\n`);
}

async function fixture(t, manifests, skillNames = []) {
  const repoRoot = await temporaryDirectory(t);
  await mkdir(join(repoRoot, 'tiles'));
  for (const skillName of skillNames) await writeSkill(repoRoot, skillName);
  for (const [pluginName, skills] of Object.entries(manifests)) {
    await writeManifest(repoRoot, pluginName, skills);
  }
  return repoRoot;
}

async function assertNoSymlinks(path) {
  const stat = await lstat(path);
  assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symlink`);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await assertNoSymlinks(join(path, entry));
}

test('stages both repository plugins with unchanged manifests and concrete skills', async (t) => {
  const repoRoot = join(import.meta.dirname, '..');
  const temporary = await temporaryDirectory(t);

  for (const pluginName of ['basic', 'advanced']) {
    const destination = join(temporary, pluginName);
    await stagePlugin({ pluginName, destination, repoRoot });
    const sourceManifest = join(repoRoot, 'tiles', pluginName, '.tessl-plugin', 'plugin.json');
    const stagedManifest = join(destination, '.tessl-plugin', 'plugin.json');
    assert.equal(await readFile(stagedManifest, 'utf8'), await readFile(sourceManifest, 'utf8'));

    const manifest = JSON.parse(await readFile(stagedManifest, 'utf8'));
    for (const skillPath of manifest.skills) {
      assert.match(await readFile(join(destination, skillPath, 'SKILL.md'), 'utf8'), /^---|^#/);
    }
    await assertNoSymlinks(destination);
  }
});

test('rejects unknown and unsafe plugin names', async (t) => {
  const repoRoot = await fixture(t, { basic: ['skills/alpha'] }, ['alpha']);
  await assert.rejects(
    stagePlugin({ pluginName: 'missing', destination: join(repoRoot, 'stage'), repoRoot }),
    /unknown plugin/
  );
  await assert.rejects(
    stagePlugin({ pluginName: '../basic', destination: join(repoRoot, 'stage'), repoRoot }),
    /unsafe plugin name/
  );
});

test('rejects unsafe manifest skill paths', async (t) => {
  for (const unsafePath of ['../alpha', 'skills/../alpha', '/skills/alpha', 'skills\\alpha']) {
    await t.test(unsafePath, async (t) => {
      const repoRoot = await fixture(t, { basic: [unsafePath] });
      await assert.rejects(
        stagePlugin({ pluginName: 'basic', destination: join(repoRoot, 'stage'), repoRoot }),
        /unsafe skill path/
      );
    });
  }
});

test('rejects missing canonical skills and SKILL.md files', async (t) => {
  const missingSkill = await fixture(t, { basic: ['skills/alpha'] });
  await assert.rejects(
    stagePlugin({
      pluginName: 'basic',
      destination: join(missingSkill, 'stage'),
      repoRoot: missingSkill,
    }),
    /declared skill is missing/
  );

  const missingManifest = await fixture(t, { basic: ['skills/alpha'] }, ['alpha']);
  await rm(join(missingManifest, 'skills', 'alpha', 'SKILL.md'));
  await assert.rejects(
    stagePlugin({
      pluginName: 'basic',
      destination: join(missingManifest, 'stage'),
      repoRoot: missingManifest,
    }),
    /no regular SKILL.md/
  );
});

test('rejects duplicate membership within or across plugins', async (t) => {
  const localDuplicate = await fixture(t, { basic: ['skills/alpha', 'skills/alpha'] }, ['alpha']);
  await assert.rejects(
    stagePlugin({
      pluginName: 'basic',
      destination: join(localDuplicate, 'stage'),
      repoRoot: localDuplicate,
    }),
    /duplicate skill in plugin/
  );

  const crossDuplicate = await fixture(t, { advanced: ['skills/alpha'], basic: ['skills/alpha'] }, [
    'alpha',
  ]);
  await assert.rejects(
    stagePlugin({
      pluginName: 'basic',
      destination: join(crossDuplicate, 'stage'),
      repoRoot: crossDuplicate,
    }),
    /skill belongs to multiple plugins/
  );
});

test('rejects symlinks before creating a staged tree', async (t) => {
  const repoRoot = await fixture(t, { basic: ['skills/alpha'] }, ['alpha']);
  await symlink('SKILL.md', join(repoRoot, 'skills', 'alpha', 'linked.md'));
  const destination = join(repoRoot, 'stage');
  await assert.rejects(
    stagePlugin({ pluginName: 'basic', destination, repoRoot }),
    /symbolic links are not allowed/
  );
  await assert.rejects(readdir(destination), { code: 'ENOENT' });
});

test('rejects a non-empty destination', async (t) => {
  const repoRoot = await fixture(t, { basic: ['skills/alpha'] }, ['alpha']);
  const destination = join(repoRoot, 'stage');
  await mkdir(destination);
  await writeFile(join(destination, 'keep'), 'do not overwrite');
  await assert.rejects(
    stagePlugin({ pluginName: 'basic', destination, repoRoot }),
    /must be empty/
  );
});

test('rejects destinations overlapping canonical skills before writing', async (t) => {
  const repoRoot = await fixture(t, { basic: ['skills/alpha'] }, ['alpha']);
  const skillRoot = join(repoRoot, 'skills', 'alpha');
  const nestedDestination = join(skillRoot, 'stage');
  await assert.rejects(
    stagePlugin({ pluginName: 'basic', destination: nestedDestination, repoRoot }),
    /destination overlaps canonical skill/
  );
  await assert.rejects(readdir(nestedDestination), { code: 'ENOENT' });

  await assert.rejects(
    stagePlugin({ pluginName: 'basic', destination: join(repoRoot, 'skills'), repoRoot }),
    /destination overlaps canonical skill/
  );

  const alias = join(repoRoot, 'skill-alias');
  await symlink(skillRoot, alias, 'dir');
  await assert.rejects(
    stagePlugin({ pluginName: 'basic', destination: join(alias, 'stage'), repoRoot }),
    /destination overlaps canonical skill/
  );
  await assert.deepEqual(await readdir(skillRoot), ['SKILL.md']);
});

test('rejects a destination inside an unpublished canonical skill before writing', async (t) => {
  const repoRoot = await fixture(t, { basic: ['skills/alpha'] }, ['alpha', 'unpublished']);
  const unpublishedRoot = join(repoRoot, 'skills', 'unpublished');
  const destination = join(unpublishedRoot, 'stage');

  await assert.rejects(
    stagePlugin({ pluginName: 'basic', destination, repoRoot }),
    /destination overlaps canonical skill skills\/unpublished/
  );
  assert.deepEqual(await readdir(unpublishedRoot), ['SKILL.md']);
});
