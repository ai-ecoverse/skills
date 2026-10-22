import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { classifySkillTests, isSafeRelPath } from '../../tools/detect-skill-integration.mjs';
import { REPO_ROOT, startLeader } from './leader.mjs';

export const PARTITIONS = 4;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;
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

export function tapVerdict({ status, stdout }) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  const ok = lines.filter((line) => /^ok \d+/.test(line));
  const failed = lines.filter((line) => /^not ok \d+/.test(line));
  const skipped = ok.filter((line) => /#\s*(skip|todo)\b/i.test(line));
  const ran = ok.length - skipped.length;
  if (status !== 0) return { pass: false, why: `tst exited ${status}` };
  if (failed.length) return { pass: false, why: failed.join('\n') };
  if (ran === 0) {
    return { pass: false, why: ok.length ? 'every test was skipped' : 'no test ran' };
  }
  return { pass: true, why: `${ran} passed, ${skipped.length} skipped` };
}

export function runPartition(index) {
  const skills = partition(index);
  const artifacts = join(REPO_ROOT, 'artifacts', `skills-${index}`);
  const work = mkdtempSync(join(tmpdir(), `skills-${index}-`));
  mkdirSync(join(work, 'canary'), { recursive: true });
  writeFileSync(join(work, 'canary', 'canary.test.js'), CANARY);
  let leader;
  let ran = 0;

  before(async () => {
    leader = await startLeader({
      name: `skills-${index}`,
      port: 5710 + index * 10,
      mounts: [
        [join(REPO_ROOT, 'skills'), '/mnt/skills'],
        [work, '/mnt/work'],
      ],
      artifacts,
    });
  });

  after(async () => {
    try {
      await leader?.stop();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test(`skills-${index}: tst runs on the leader`, async () => {
    const setup = await leader.run(
      'ipk add -g typescript@6.0.3 && (ipk add -g minimatch@9.0.5 || true)',
      { timeoutMs: 600_000 }
    );
    writeFileSync(join(artifacts, 'setup.txt'), `${setup.stdout}\n${setup.stderr}`);
    if (setup.status !== 0) throw new Error(`ipk add exited ${setup.status}: ${setup.stderr}`);
    const canary = await leader.run(
      'rm -rf /tmp/tst-canary && mkdir -p /tmp/tst-canary && cp /mnt/work/canary/canary.test.js /tmp/tst-canary/ && cd /tmp/tst-canary && tst --reporter=tap'
    );
    writeFileSync(join(artifacts, 'canary.tap'), canary.stdout);
    const verdict = tapVerdict(canary);
    if (!verdict.pass) throw new Error(`canary: ${verdict.why}\n${canary.stderr}`);
  });

  for (const name of skills) {
    if (!SAFE_NAME.test(name)) throw new Error(`unsafe skill name ${JSON.stringify(name)}`);
    test(`skills-${index}: ${name}`, async (t) => {
      const target = await classifySkillTests(`skills/${name}`, { repoRoot: REPO_ROOT });
      if (target.action !== 'tst') {
        t.skip(`no tst suite (${target.reason || 'none'})`);
        return;
      }
      for (const rel of target.tstTests) {
        if (!isSafeRelPath(rel)) throw new Error(`unsafe test path ${rel}`);
      }
      const dst = `/workspace/skills/${name}`;
      const result = await leader.run(
        [
          `rm -rf ${dst}`,
          'mkdir -p /workspace/skills',
          `cp -R /mnt/skills/${name} ${dst}`,
          `cd ${dst}`,
          `tst --reporter=tap ${target.tstTests.join(' ')}`,
        ].join(' && '),
        { timeoutMs: 600_000 }
      );
      writeFileSync(join(artifacts, `${name}.tap`), `${result.stdout}\n${result.stderr}`);
      const verdict = tapVerdict(result);
      if (!verdict.pass) throw new Error(`${name}: ${verdict.why}\n${result.stderr.slice(-2000)}`);
      ran += 1;
    });
  }

  test(`skills-${index}: at least one tst suite ran`, () => {
    if (ran === 0) throw new Error(`no tst suite ran in partition ${index} (${skills.join(', ')})`);
  });
}
