import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const toolsRoot = import.meta.dirname;

async function fixture(t) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'tessl-publish-test-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(join(repoRoot, 'tools'));
  await cp(
    join(toolsRoot, 'stage-tessl-plugin.mjs'),
    join(repoRoot, 'tools/stage-tessl-plugin.mjs')
  );
  await cp(join(toolsRoot, 'is-main.mjs'), join(repoRoot, 'tools/is-main.mjs'));
  await cp(join(toolsRoot, 'expect-verdict.sh'), join(repoRoot, 'tools/expect-verdict.sh'));
  await cp(
    join(toolsRoot, 'publish-tessl-plugin.sh'),
    join(repoRoot, 'tools/publish-tessl-plugin.sh')
  );
  await mkdir(join(repoRoot, 'skills/slack'), { recursive: true });
  await writeFile(join(repoRoot, 'skills/slack/SKILL.md'), '# slack\n');
  const manifestDirectory = join(repoRoot, 'tiles/advanced/.tessl-plugin');
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(
    join(manifestDirectory, 'plugin.json'),
    `${JSON.stringify({ name: 'ai-ecoverse/advanced-skills', skills: ['skills/slack'], version: '0.2.13' }, null, 2)}\n`
  );
  return repoRoot;
}

async function fakeTessl(repoRoot, body) {
  const bin = join(repoRoot, 'bin');
  await mkdir(bin);
  const executable = join(bin, 'tessl');
  await writeFile(executable, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  await chmod(executable, 0o755);
  return bin;
}

function environment(bin, extra = {}) {
  return { ...process.env, ...extra, PATH: `${bin}:${process.env.PATH}` };
}

const REGISTRY = [
  'printf "%s\\n" "$*" >> "$CALL_LOG"',
  'if [ "$1 $2" = "plugin info" ]; then',
  '  case "$4" in',
  '    *@*)',
  '      wanted=${4#*@}',
  '      for v in $EXISTING; do [ "$v" = "$wanted" ] && { printf \'{"version":{"version":"%s"}}\\n\' "$v"; exit 0; }; done',
  '      echo "no version $wanted" >&2',
  '      exit 1 ;;',
  '    *) printf \'{"tile":{"latestVersion":"%s"}}\\n\' "$LATEST"; exit 0 ;;',
  '  esac',
  'fi',
  'test "$1 $2 $#" = "plugin publish 3"',
  'test -f "$3/skills/slack/SKILL.md"',
  'version=$(jq -r .version "$3/.tessl-plugin/plugin.json")',
  'for v in $EXISTING; do [ "$v" = "$version" ] && { echo "version $version already exists" >&2; exit 1; }; done',
  'echo "$3" > "$PUBLISHED"',
].join('\n');

async function publish(
  t,
  { bump = 'patch', floor, manifest = '0.2.13', existing = '', latest = '' }
) {
  const repoRoot = await fixture(t);
  const source = join(repoRoot, 'tiles/advanced/.tessl-plugin/plugin.json');
  const doc = JSON.parse(await readFile(source, 'utf8'));
  await writeFile(source, `${JSON.stringify({ ...doc, version: manifest }, null, 2)}\n`);
  const bin = await fakeTessl(repoRoot, REGISTRY);
  const callLog = join(repoRoot, 'tessl-calls');
  const published = join(repoRoot, 'published');
  const args = ['tools/publish-tessl-plugin.sh', 'advanced', bump];
  if (floor !== undefined) args.push(floor);
  await execFileAsync('bash', args, {
    cwd: repoRoot,
    env: environment(bin, {
      CALL_LOG: callLog,
      PUBLISHED: published,
      EXISTING: existing,
      LATEST: latest,
    }),
  });
  const written = JSON.parse(await readFile(source, 'utf8'));
  return {
    repoRoot,
    version: written.version,
    skills: written.skills,
    calls: (await readFile(callLog, 'utf8')).trimEnd().split('\n'),
    stagedPath: (await readFile(published, 'utf8')).trim(),
  };
}

test('publishes above every published version the registry reports, not one bump above the manifest', async (t) => {
  const result = await publish(t, {
    manifest: '0.4.12',
    existing: '0.4.12 0.4.13 0.5.0',
    latest: '0.3.1',
  });
  assert.equal(result.version, '0.5.1');
  assert.deepEqual(result.skills, ['skills/slack']);
  assert.match(result.stagedPath, /\/advanced$/);
  assert.notEqual(result.stagedPath, join(result.repoRoot, 'tiles/advanced'));
  assert.ok(result.calls.includes(`plugin publish ${result.stagedPath}`));
  assert.ok(!result.calls.some((call) => call.includes('--bump')));
});

test('a minor bump climbs past occupied patches first', async (t) => {
  const result = await publish(t, { bump: 'minor', existing: '0.2.13 0.2.14 0.2.15' });
  assert.equal(result.version, '0.3.0');
});

test('starts from the registry latest version when it is above the manifest', async (t) => {
  const result = await publish(t, { existing: '0.9.0', latest: '0.9.0' });
  assert.equal(result.version, '0.9.1');
});

test('workflow cannot restore public lookup or bounded manual retries', async () => {
  const workflow = await readFile(join(toolsRoot, '../.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /bash tools\/publish-tessl-plugin\.sh "\$PLUGIN" "\$BUMP"/);
  assert.doesNotMatch(workflow, /api\.tessl\.io|latestVersion|seq 1 25|plugin publish --version/);
});

test('leaves the source manifest unchanged when publish fails', async (t) => {
  const repoRoot = await fixture(t);
  const source = join(repoRoot, 'tiles/advanced/.tessl-plugin/plugin.json');
  const before = await readFile(source, 'utf8');
  const bin = await fakeTessl(repoRoot, 'exit 17');
  await assert.rejects(
    execFileAsync('bash', ['tools/publish-tessl-plugin.sh', 'advanced', 'patch'], {
      cwd: repoRoot,
      env: environment(bin),
    }),
    (error) => error.code === 17
  );
  assert.equal(await readFile(source, 'utf8'), before);
});

test('bumps from the last published tag when it is above the manifest', async (t) => {
  assert.equal((await publish(t, { floor: '0.11.0' })).version, '0.11.1');
});

test('bumps from the manifest when the last published tag is below it', async (t) => {
  assert.equal((await publish(t, { floor: '0.2.9' })).version, '0.2.14');
});

test('refuses a floor that is not a release version', async (t) => {
  await assert.rejects(publish(t, { floor: '1.0.0; rm -rf /' }), (error) => error.code === 2);
});

test('workflow diffs from the last publish tag and checks that the new tag reached origin', async () => {
  const workflow = await readFile(join(toolsRoot, '../.github/workflows/ci.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('  tessl-publish:'));
  assert.match(job, /LAST="tessl-\$PLUGIN-v\$FLOOR"/);
  assert.match(job, /git diff --quiet "\$LAST" HEAD/);
  assert.doesNotMatch(workflow, /outputs\.previous/);
  assert.match(job, /git push origin "\$GITHUB_SHA:refs\/tags\/\$TAG"/);
  assert.match(job, /git ls-remote --tags origin "refs\/tags\/\$TAG"/);
});
