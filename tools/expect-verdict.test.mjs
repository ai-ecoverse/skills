import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SILENT_EXIT_0 = 'process.exit(0);\n';

const ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

function runStep(script, cwd) {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd, env: ENV, encoding: 'utf8' });
}

async function layoutCommand() {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
  const match = pkg.scripts.lint.match(/git ls-files \| bash tools\/expect-verdict\.sh [^&]+/);
  assert.ok(match, 'npm run lint runs the tessl layout check through expect-verdict');
  return match[0].trim();
}

// A scratch git repo holding the gate wrapper and the given check-tessl-layout.
async function checkout(t, tool) {
  const root = await mkdtemp(join(tmpdir(), 'expect-verdict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tools'));
  await cp(join(REPO_ROOT, 'tools/expect-verdict.sh'), join(root, 'tools/expect-verdict.sh'));
  await cp(join(REPO_ROOT, 'tools/is-main.mjs'), join(root, 'tools/is-main.mjs'));
  await writeFile(join(root, 'tools/check-tessl-layout.mjs'), tool);
  const files = ['expect-verdict.sh', 'is-main.mjs', 'check-tessl-layout.mjs'].map(
    (f) => `tools/${f}`
  );
  for (const args of [
    ['init', '-q'],
    ['add', ...files],
  ]) {
    assert.equal(spawnSync('git', args, { cwd: root, env: ENV }).status, 0);
  }
  return root;
}

test('lint layout step fails when the tool exits 0 without a verdict', async (t) => {
  const script = await layoutCommand();
  const root = await checkout(t, SILENT_EXIT_0);

  const result = runStep(script, root);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /check-tessl-layout exited 0 without a 'check-tessl-layout: PASS' verdict/
  );
});

test('lint layout step passes when the real tool prints its verdict', async (t) => {
  const script = await layoutCommand();
  const tool = await readFile(join(REPO_ROOT, 'tools/check-tessl-layout.mjs'), 'utf8');
  const root = await checkout(t, tool);

  const result = runStep(script, root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^check-tessl-layout: PASS 3 tracked files$/m);
});

test('passes stdout through for $(...) capture and keeps a failing exit status', () => {
  const wrapper = join(REPO_ROOT, 'tools/expect-verdict.sh');
  const ok = spawnSync(
    'bash',
    [wrapper, 'demo', 'node', '-e', 'console.log("{}"); console.error("demo: PASS 0 things")'],
    { encoding: 'utf8' }
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '{}\n');

  const failed = spawnSync('bash', [wrapper, 'demo', 'node', '-e', 'process.exit(3)'], {
    encoding: 'utf8',
  });
  assert.equal(failed.status, 3);
});
