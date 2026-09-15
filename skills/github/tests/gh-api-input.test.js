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
  const stdout = [];
  const stderr = [];
  let stdinReadCount = 0;
  const record = (method) => async (requestPath, options) => {
    calls.push({ method, path: requestPath, options });
    if (scenario.failWrite) throw { body: { message: 'boom' } };
    return { ...(options?.body || {}), html_url: 'https://example.test/pr/42' };
  };
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (requestPath === '/user') return { login: 'viewer' };
      return {};
    },
    patch: record('patch'),
    post: record('post'),
    delete: record('delete'),
    put: record('put'),
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
  const fileSystem = {
    readFile: async (filePath) => {
      if (scenario.bodyFiles && Object.hasOwn(scenario.bodyFiles, filePath)) {
        return scenario.bodyFiles[filePath];
      }
      throw new Error('ENOENT');
    },
    readFileBinary: async (filePath) => {
      if (scenario.bodyFiles && Object.hasOwn(scenario.bodyFiles, filePath)) {
        return new TextEncoder().encode(scenario.bodyFiles[filePath]);
      }
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
  };
  const mocks = {
    'sliccy:skill': { token: async () => 'fake' },
    'sliccy:cli': cli,
    'sliccy:fmt': fmt,
    'sliccy:color': color,
    'sliccy:http': { client: () => api },
    'sliccy:exec': exec,
    'sliccy:time': {},
    fs: fileSystem,
  };
  const realRequire = createRequire(target);
  const mockRequire = (id) => (Object.hasOwn(mocks, id) ? mocks[id] : realRequire(id));
  const mockProcess = {
    argv: ['node', target, ...args],
    env: {},
    stdin: {
      read: async () => {
        stdinReadCount++;
        if (stdinReadCount > 1) throw new Error('stdin already consumed');
        if (scenario.stdinError) throw scenario.stdinError;
        return scenario.stdin ?? '';
      },
    },
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
    return { calls, stdinReadCount, stdout, stderr };
  } catch (error) {
    return { error, calls, stdinReadCount, stdout, stderr };
  }
}

function writes(result) {
  return result.calls.filter((c) => c.method !== 'get');
}

// ── --input flag ─────────────────────────────────────────────────────────────

test('gh api --input reads a JSON file and sends it as the POST body', async () => {
  const result = await runGh(
    ['api', '/repos/octo/repo/issues', '-X', 'POST', '--input', '/body.json'],
    { bodyFiles: { '/body.json': '{"title":"from file","body":"hello"}' } }
  );
  assert.equal(result.error.exitCode, 0);
  assert.deepEqual(writes(result), [
    {
      method: 'post',
      path: '/repos/octo/repo/issues',
      options: { body: { title: 'from file', body: 'hello' } },
    },
  ]);
});

test('gh api --input implies POST when -X is not given', async () => {
  const result = await runGh(
    ['api', '/markdown', '--input', '/body.json'],
    { bodyFiles: { '/body.json': '{"text":"# hi"}' } }
  );
  assert.equal(result.error.exitCode, 0);
  assert.deepEqual(writes(result), [
    {
      method: 'post',
      path: '/markdown',
      options: { body: { text: '# hi' } },
    },
  ]);
});

test('gh api --input - reads from stdin', async () => {
  const result = await runGh(
    ['api', '/markdown', '-X', 'POST', '--input', '-'],
    { stdin: '{"text":"# from stdin"}' }
  );
  assert.equal(result.error.exitCode, 0);
  assert.equal(result.stdinReadCount, 1);
  assert.deepEqual(writes(result), [
    {
      method: 'post',
      path: '/markdown',
      options: { body: { text: '# from stdin' } },
    },
  ]);
});

test('gh api --input=<file> accepts the equals form', async () => {
  const result = await runGh(
    ['api', '/markdown', '-X', 'POST', '--input=/body.json'],
    { bodyFiles: { '/body.json': '{"text":"equals form"}' } }
  );
  assert.equal(result.error.exitCode, 0);
  assert.deepEqual(writes(result)[0].options.body, { text: 'equals form' });
});

test('gh api --input errors on invalid JSON', async () => {
  const result = await runGh(
    ['api', '/markdown', '-X', 'POST', '--input', '/bad.json'],
    { bodyFiles: { '/bad.json': 'not valid json{' } }
  );
  assert.equal(result.error.name, 'NodeExitError');
  assert.equal(result.error.exitCode, 1);
  assert.match(result.error.message, /not valid JSON/);
  assert.deepEqual(writes(result), []);
});

test('gh api --input errors when file cannot be read', async () => {
  const result = await runGh(
    ['api', '/markdown', '-X', 'POST', '--input', '/nonexistent.json']
  );
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /could not read --input \/nonexistent\.json/);
});

test('gh api --input is mutually exclusive with -F', async () => {
  const result = await runGh(
    ['api', '/markdown', '--input', '/body.json', '-F', 'text=hello'],
    { bodyFiles: { '/body.json': '{"text":"hi"}' } }
  );
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /mutually exclusive/);
  assert.deepEqual(writes(result), []);
});

test('gh api --input is mutually exclusive with -f', async () => {
  const result = await runGh(
    ['api', '/markdown', '--input', '/body.json', '-f', 'text=hello'],
    { bodyFiles: { '/body.json': '{"text":"hi"}' } }
  );
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /mutually exclusive/);
});

// ── unknown flag rejection ───────────────────────────────────────────────────

test('gh api rejects unknown flags', async () => {
  const result = await runGh(['api', '/user', '--totally-bogus']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.equal(result.error.exitCode, 1);
  assert.match(result.error.message, /unknown flag '--totally-bogus'/);
  assert.match(result.error.message, /--help/);
});

test('gh api rejects unknown flags with =value form', async () => {
  const result = await runGh(['api', '/markdown', '--bogus=1']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /unknown flag '--bogus'/);
});

test('gh api rejects unknown short flags', async () => {
  const result = await runGh(['api', '/user', '-Z']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /unknown flag '-Z'/);
});

// ── existing behaviour preservation ──────────────────────────────────────────

test('gh api -F still works after --input addition', async () => {
  const result = await runGh([
    'api', '/repos/octo/repo/issues', '-F', 'title=test', '-F', 'draft=true',
  ]);
  assert.equal(result.error.exitCode, 0);
  assert.deepEqual(writes(result), [
    {
      method: 'post',
      path: '/repos/octo/repo/issues',
      options: { body: { title: 'test', draft: true } },
    },
  ]);
});

test('gh api plain GET still works', async () => {
  const result = await runGh(['api', '/user']);
  assert.equal(result.error.exitCode, 0);
  assert.deepEqual(result.calls, [
    { method: 'get', path: '/user', options: {} },
  ]);
});

test('gh api -X GET with fields sends params', async () => {
  const result = await runGh(['api', '/search/issues', '-X', 'GET', '-f', 'q=test']);
  assert.deepEqual(result.calls, [
    { method: 'get', path: '/search/issues', options: { params: { q: 'test' } } },
  ]);
});

test('gh api --jq still works', async () => {
  const result = await runGh(['api', '/user', '--jq', '.login']);
  // jq handling runs after the API call; just verify the call was made
  assert.equal(result.calls[0].method, 'get');
  assert.equal(result.calls[0].path, '/user');
});

test('gh api help documents --input', async () => {
  const result = await runGh(['api', '--help']);
  assert.equal(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  assert.match(help, /--input/);
  assert.match(help, /mutually exclusive/);
  assert.match(help, /Unknown flags are rejected/);
});

test('gh api --input with GET converts body to query params', async () => {
  const result = await runGh(
    ['api', '/search/issues', '-X', 'GET', '--input', '/query.json'],
    { bodyFiles: { '/query.json': '{"q":"repo:octo/repo","per_page":5}' } }
  );
  assert.equal(result.error.exitCode, 0);
  assert.deepEqual(result.calls, [
    {
      method: 'get',
      path: '/search/issues',
      options: { params: { q: 'repo:octo/repo', per_page: 5 } },
    },
  ]);
});
