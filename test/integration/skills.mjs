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

export const PACKAGES = [
  ['typescript', '6.0.3'],
  ['minimatch', '9.0.5'],
];
const GLOBAL_MODULES = '/shared/lib/node_modules';

export function brokenManifests(listing) {
  const broken = [];
  for (const block of String(listing ?? '')
    .split('\n==> ')
    .filter(Boolean)) {
    const [header, ...body] = block.replace(/^==> /, '').split('\n');
    const path = header.replace(/ <==$/, '');
    try {
      const doc = JSON.parse(body.join('\n'));
      if (!doc || typeof doc.name !== 'string') broken.push(path);
    } catch {
      broken.push(path);
    }
  }
  return broken;
}

async function installPackages(leader, artifacts) {
  const log = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const add = await leader.run(
      `ipk add -g ${PACKAGES.map(([name, version]) => `${name}@${version}`).join(' ')}`,
      { timeoutMs: 600_000 }
    );
    log.push(`attempt ${attempt}: ipk add exited ${add.status}\n${add.stdout}\n${add.stderr}`);
    const listing = await leader.run(
      `for f in ${GLOBAL_MODULES}/*/package.json ${GLOBAL_MODULES}/@*/*/package.json; do [ -f "$f" ] && { echo "==> $f <=="; cat "$f"; echo; }; done; true`
    );
    const broken = brokenManifests(listing.stdout);
    const missing = PACKAGES.filter(
      ([name]) => !listing.stdout.includes(`==> ${GLOBAL_MODULES}/${name}/package.json <==`)
    ).map(([name]) => name);
    log.push(`broken: ${broken.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`);
    if (add.status === 0 && listing.status === 0 && !broken.length && !missing.length) {
      writeFileSync(join(artifacts, 'setup.txt'), log.join('\n'));
      return;
    }
    const dirs = broken
      .map((path) => path.replace(/\/package\.json$/, ''))
      .filter((dir) => dir.startsWith(`${GLOBAL_MODULES}/`) && /^[A-Za-z0-9@._/-]+$/.test(dir));
    if (dirs.length) await leader.run(`rm -rf ${dirs.join(' ')}`);
  }
  writeFileSync(join(artifacts, 'setup.txt'), log.join('\n'));
  throw new Error(`the leader's global packages did not install cleanly:\n${log.join('\n')}`);
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
    await installPackages(leader, artifacts);
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
