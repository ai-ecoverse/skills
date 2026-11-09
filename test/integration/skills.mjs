import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { binEntries } from '../../tools/check-skill-packages.mjs';
import { classifySkillTests, isSafeRelPath } from '../../tools/detect-skill-integration.mjs';
import { BASE, bootKernel, launchKernel, REPO_ROOT, SUITE_MODULES } from './kernel.mjs';

export const PARTITIONS = 4;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SUITE_ENV = { TST_FORMAT: 'tap', TST_MUTE: '0', NO_COLOR: '1' };
const SUITE_TIMEOUT = '300';
const CANARY =
  "import test, { is } from 'tst';\ntest('tst runner is alive', () => {\n  is(1 + 1, 2);\n});\n";

export function allSkills(repoRoot = REPO_ROOT) {
  return readdirSync(join(repoRoot, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(repoRoot, 'skills', name, 'SKILL.md')))
    .sort();
}

export function partition(index, skills = allSkills()) {
  return skills.filter((_, i) => i % PARTITIONS === index);
}

export function packagedSkills(repoRoot = REPO_ROOT) {
  return allSkills(repoRoot)
    .map((name) => {
      const file = join(repoRoot, 'skills', name, 'package.json');
      if (!existsSync(file)) return null;
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      const bins = binEntries(manifest);
      return bins.length ? { skill: name, package: manifest.name, bins } : null;
    })
    .filter(Boolean);
}

export function tapVerdict({ status, stdout }) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const ok = lines.filter((line) => /^ok \d+/.test(line));
  const failed = lines.filter((line) => /^not ok \d+/.test(line));
  const skipped = ok.filter((line) => /#\s*(skip|todo)\b/i.test(line));
  const ran = ok.length - skipped.length;
  if (status !== 0) return { pass: false, ran, why: `exited ${status}` };
  if (failed.length) return { pass: false, ran, why: failed.join('\n') };
  if (ran === 0) {
    return { pass: false, ran, why: ok.length ? 'every test was skipped' : 'no test ran' };
  }
  return { pass: true, ran, why: `${ran} passed, ${skipped.length} skipped` };
}

const artifactDir = (k) => {
  const dir = typeof k.page.dir === 'string' ? k.page.dir : fileURLToPath(k.page.dir);
  mkdirSync(dir, { recursive: true });
  return dir;
};

export const suiteCommand = (rel) => ['timeout', SUITE_TIMEOUT, 'node', rel];

export function runPartition(index) {
  const skills = partition(index);
  for (const name of skills) {
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe skill name ${JSON.stringify(name)}`);
  }
  let chrome;

  before(async () => {
    chrome = await launchKernel();
  });

  after(async () => {
    await chrome?.close();
  });

  test(`skills-${index}: every tst suite passes on slicc-kernel's node`, async (t) => {
    const k = await bootKernel(chrome, t, { modules: [...BASE, ...SUITE_MODULES], skills });
    let ran = 0;

    await t.test('tst runs on the kernel', async () => {
      const wrote = await k.bash('mkdir -p /tmp/canary && cat > /tmp/canary/canary.test.js', {
        stdin: CANARY,
      });
      if (wrote.status !== 0) throw new Error(`writing the canary: ${wrote.stderr}`);
      const canary = await k.run(suiteCommand('canary.test.js'), {
        cwd: '/tmp/canary',
        env: SUITE_ENV,
      });
      writeFileSync(join(artifactDir(k), 'canary.tap'), `${canary.stdout}\n${canary.stderr}`);
      const verdict = tapVerdict(canary);
      if (!verdict.pass) throw new Error(`canary: ${verdict.why}\n${canary.stderr}`);
    });

    for (const name of skills) {
      await t.test(name, async (s) => {
        const target = await classifySkillTests(`skills/${name}`, { repoRoot: REPO_ROOT });
        if (target.action !== 'tst') {
          s.skip(`no tst suite (${target.reason || 'none'})`);
          return;
        }
        const failures = [];
        const tap = [];
        for (const rel of target.tstTests) {
          if (!isSafeRelPath(rel)) throw new Error(`unsafe test path ${rel}`);
          const result = await k.run(suiteCommand(rel), {
            cwd: `/home/skills/${name}`,
            env: SUITE_ENV,
          });
          tap.push(`# ${rel}\n${result.stdout}\n${result.stderr}`);
          const verdict = tapVerdict(result);
          if (!verdict.pass) failures.push(`${rel}: ${verdict.why}\n${result.stderr.slice(-2000)}`);
        }
        writeFileSync(join(artifactDir(k), `${name}.tap`), tap.join('\n'));
        if (failures.length) throw new Error(`${name}:\n${failures.join('\n')}`);
        ran += 1;
      });
    }

    await t.test('at least one tst suite ran', () => {
      if (ran === 0)
        throw new Error(`no tst suite ran in partition ${index} (${skills.join(', ')})`);
    });
  });
}
