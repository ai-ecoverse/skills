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

test('records the staged version after CLI bumping clears many occupied versions', async (t) => {
  const repoRoot = await fixture(t);
  const callLog = join(repoRoot, 'tessl-call');
  const bin = await fakeTessl(
    repoRoot,
    'printf "%s\\n" "$@" > "$CALL_LOG"\n' +
      'test "$1 $2 $3" = "plugin publish --bump"\n' +
      'test "$4" = "patch"\n' +
      'test -f "$5/skills/slack/SKILL.md"\n' +
      'test "$OCCUPIED_COUNT" -ge 100\n' +
      'IFS=. read -r major minor patch <<< "$(jq -r .version "$5/.tessl-plugin/plugin.json")"\n' +
      'published_version="$major.$minor.$((patch + OCCUPIED_COUNT + 1))"\n' +
      'tmp=$(mktemp)\n' +
      'jq --arg version "$published_version" ".version = \\$version" "$5/.tessl-plugin/plugin.json" > "$tmp"\n' +
      'mv "$tmp" "$5/.tessl-plugin/plugin.json"'
  );

  await execFileAsync('bash', ['tools/publish-tessl-plugin.sh', 'advanced', 'patch'], {
    cwd: repoRoot,
    env: environment(bin, { CALL_LOG: callLog, OCCUPIED_COUNT: '100' }),
  });

  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'tiles/advanced/.tessl-plugin/plugin.json'), 'utf8')
  );
  assert.equal(manifest.version, '0.2.114');
  assert.deepEqual(manifest.skills, ['skills/slack']);
  const call = (await readFile(callLog, 'utf8')).trimEnd().split('\n');
  assert.deepEqual(call.slice(0, 4), ['plugin', 'publish', '--bump', 'patch']);
  assert.match(call[4], /\/advanced$/);
  assert.notEqual(call[4], join(repoRoot, 'tiles/advanced'));
});

test('workflow cannot restore public lookup or bounded manual retries', async () => {
  const workflow = await readFile(
    join(toolsRoot, '../.github/workflows/tessl-publish.yml'),
    'utf8'
  );
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
