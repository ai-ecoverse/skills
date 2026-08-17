import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import { assertNoTrackedTileSkillPaths } from './check-tessl-layout.mjs';

const execFileAsync = promisify(execFile);

test('allows canonical skills and tile source manifests', () => {
  assert.doesNotThrow(() =>
    assertNoTrackedTileSkillPaths([
      'skills/search/SKILL.md',
      'tiles/basic/.tessl-plugin/plugin.json',
      'tiles/advanced/.tessl-plugin/plugin.json',
    ])
  );
});

test('rejects every tracked path beneath a tile skills directory', () => {
  assert.throws(
    () =>
      assertNoTrackedTileSkillPaths([
        'tiles/basic/skills/search',
        'tiles/advanced/skills/slack/SKILL.md',
      ]),
    /tiles\/basic\/skills\/search[\s\S]*tiles\/advanced\/skills\/slack\/SKILL\.md/
  );
});

test('repository has no tracked tile skill paths', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files']);
  assert.doesNotThrow(() => assertNoTrackedTileSkillPaths(stdout.split(/\r?\n/).filter(Boolean)));
});
