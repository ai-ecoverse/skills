import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Each CI gate, with an input that must print something or exit non-zero.
// A main-module guard that misses the symlinked path exits 0 with no output.
const CASES = [
  {
    tool: 'check-tessl-layout.mjs',
    input: 'tiles/basic/skills/search/SKILL.md\n',
    expect: { status: 1, stderr: /tiles\/basic\/skills\/search\/SKILL\.md/ },
  },
  {
    tool: 'detect-skill-integration.mjs',
    args: ['--skills', 'search'],
    expect: {
      status: 0,
      stdout: /"skills\/search"/,
      stderr: /^detect-skill-integration: PASS 1 targets$/m,
    },
  },
  {
    tool: 'detect-tessl-changes.mjs',
    input: 'skills/search/SKILL.md\n',
    expect: { status: 0, stdout: /^\{/, stderr: /^detect-tessl-changes: PASS /m },
  },
  {
    tool: 'stage-tessl-plugin.mjs',
    expect: { status: 1, stderr: /usage: node tools\/stage-tessl-plugin\.mjs/ },
  },
  {
    tool: 'stage-tessl-skill.mjs',
    expect: { status: 1, stderr: /usage: node tools\/stage-tessl-skill\.mjs/ },
  },
];

test('CI tools run when invoked through a symlinked checkout', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'is-main-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const linkedRepo = join(scratch, 'repo');
  await symlink(REPO_ROOT, linkedRepo, 'dir');

  for (const { tool, args = [], input = '', expect } of CASES) {
    await t.test(tool, () => {
      const result = spawnSync(process.execPath, [join(linkedRepo, 'tools', tool), ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        input,
      });
      assert.equal(result.status, expect.status, `${tool} stderr: ${result.stderr}`);
      if (expect.stdout) assert.match(result.stdout, expect.stdout);
      if (expect.stderr) assert.match(result.stderr, expect.stderr);
    });
  }
});
