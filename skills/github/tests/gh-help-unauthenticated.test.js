const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const test = require('node:test');

const target = path.resolve(__dirname, '../scripts/gh.jsh');
const source = fs.readFileSync(target, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

async function runGh(args, scenario = {}) {
  const calls = [];
  const tokenCalls = [];
  const stdout = [];
  const stderr = [];
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (requestPath === '/user') return { login: 'viewer' };
      if (/\/repos\/[^/]+\/[^/]+\/pulls$/.test(requestPath)) return scenario.pulls || [];
      return {};
    },
    patch: async () => assert.fail('unexpected PATCH'),
    post: async () => assert.fail('unexpected POST'),
    delete: async () => assert.fail('unexpected DELETE'),
    put: async () => assert.fail('unexpected PUT'),
  };
  const cli = {
    die: (message, options) => {
      throw new NodeExitError(String(message), options?.exitCode ?? 1);
    },
    help: (message) => {
      stdout.push(String(message));
      throw new NodeExitError('help', 0);
    },
    out: (value) => stdout.push(JSON.stringify(value)),
    warn: (message) => stderr.push(String(message)),
  };
  const color = new Proxy({}, { get: () => (value) => String(value) });
  const fmt = new Proxy(
    { date: (value) => String(value) },
    { get: (object, key) => object[key] || ((value) => String(value)) }
  );
  const exec = async () => ({ stdout: '', stderr: '', exitCode: 1 });
  exec.spawn = exec;
  exec.start = exec;
  const mocks = {
    'sliccy:skill': {
      token: async (provider) => {
        tokenCalls.push(provider);
        if (scenario.tokenError) throw scenario.tokenError;
        if (Object.hasOwn(scenario, 'token')) return scenario.token;
        return 'fake';
      },
    },
    'sliccy:cli': cli,
    'sliccy:fmt': fmt,
    'sliccy:color': color,
    'sliccy:http': { client: () => api },
    'sliccy:exec': exec,
    'sliccy:time': {},
    fs: { readFile: async () => '', writeFile: async () => {} },
  };
  const realRequire = createRequire(target);
  const mockRequire = (id) => (Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id));
  const mockProcess = {
    argv: ['node', target, ...args],
    env: scenario.env || {},
    stdin: { read: async () => '' },
    exit: (code) => {
      throw new NodeExitError('exit', code);
    },
  };
  const mockConsole = {
    log: (message) => stdout.push(String(message)),
    info: (message) => stdout.push(String(message)),
    warn: (message) => stderr.push(String(message)),
    error: (message) => stderr.push(String(message)),
  };

  try {
    await new AsyncFunction('require', 'process', 'console', 'fetch', source)(
      mockRequire,
      mockProcess,
      mockConsole,
      async () => assert.fail('unexpected fetch')
    );
    return { calls, tokenCalls, stdout, stderr };
  } catch (error) {
    return { error, calls, tokenCalls, stdout, stderr };
  }
}

const NO_TOKEN = { tokenError: new Error('no usable token for github') };

test('help flags print usage without calling skill.token', async () => {
  const cases = [
    [],
    ['--help'],
    ['-h'],
    ['-?'],
    ['help'],
    ['help', 'pr'],
    ['pr', '--help'],
    ['pr', '-h'],
    ['pr', 'view', '--help'],
    ['pr', 'view', '-h'],
    ['issue', 'create', '--help'],
    ['pr', 'merge', '42', '--squash', '--help'],
  ];

  for (const args of cases) {
    const result = await runGh(args, NO_TOKEN);
    assert.equal(result.error?.exitCode, 0, `expected exit 0 for ${JSON.stringify(args)}`);
    assert.equal(result.tokenCalls.length, 0, `skill.token must not run for ${JSON.stringify(args)}`);
    assert.match(result.stdout.join('\n'), /USAGE|SUBCOMMANDS|gh\.jsh/);
    assert.doesNotMatch(result.error?.message || '', /No GitHub token/);
  }
});

test('gh version and --version work without a token', async () => {
  for (const args of [['version'], ['--version']]) {
    const result = await runGh(args, NO_TOKEN);
    assert.equal(result.error?.exitCode, 0, `expected exit 0 for ${JSON.stringify(args)}`);
    assert.equal(result.tokenCalls.length, 0, `skill.token must not run for ${JSON.stringify(args)}`);
    assert.match(result.stdout.join('\n'), /gh\.jsh \(SLICC GitHub CLI\)/);
  }
});

test('a missing token still fails a real gh pr list', async () => {
  const result = await runGh(['pr', 'list', '-R', 'octo/repo'], NO_TOKEN);
  assert.equal(result.error?.exitCode, 1);
  assert.ok(result.tokenCalls.length >= 1);
  assert.equal(result.tokenCalls[0], 'github');
  assert.match(result.error.message, /No GitHub token available/);
  assert.equal(result.calls.length, 0);
});

test('does not swallow --help as a flag value', async () => {
  const asValue = await runGh(['issue', 'create', '--body', '-h', '-R', 'octo/repo'], NO_TOKEN);
  assert.equal(asValue.error?.exitCode, 1);
  assert.ok(asValue.tokenCalls.length >= 1);
  assert.match(asValue.error.message, /No GitHub token available/);
  assert.doesNotMatch(asValue.stdout.join('\n'), /USAGE/);

  const withToken = await runGh(['issue', 'create', '--body', '-h', '-R', 'octo/repo']);
  assert.equal(withToken.error?.exitCode, 1);
  assert.ok(withToken.tokenCalls.length >= 1);
  assert.match(withToken.error.message, /title required|usage: gh issue create/i);
  assert.doesNotMatch(withToken.stdout.join('\n'), /USAGE/);
});
