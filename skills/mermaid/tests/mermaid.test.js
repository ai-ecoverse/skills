const assert = require('node:assert/strict');
const test = require('node:test');
const { runMermaid } = require('./jsh-runtime.js');

test('--help prints the install line and does not render', async () => {
  const result = await runMermaid(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ipk add -g mermaid esbuild-wasm/);
  assert.match(result.stdout, /--theme/);
});

test('empty stdin exits 1 and does not open a browser', async () => {
  const result = await runMermaid(['render', '-'], {
    spawn: async () => {
      throw new Error('browser was called');
    },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no diagram/);
});

test('an unknown theme is a usage error', async () => {
  const result = await runMermaid(['diagram.mmd', '--theme', 'neon'], {
    files: { 'diagram.mmd': 'flowchart LR\n  A-->B\n' },
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /unknown theme: neon/);
});

test('a missing diagram file exits 1', async () => {
  const result = await runMermaid(['missing.mmd']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no such file: missing\.mmd/);
});

test('a missing mermaid install names the ipk command', async () => {
  const result = await runMermaid(['diagram.mmd'], {
    files: { 'diagram.mmd': 'flowchart LR\n  A-->B\n' },
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /ipk add -g mermaid esbuild-wasm/);
});
