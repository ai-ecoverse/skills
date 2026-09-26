import test, { fail, is, ok } from 'tst';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as _prWatchFilterMod from '../scripts/pr-watch-filter.js';
import * as _assignFieldMod from '../scripts/assign-field.js';
import * as _prEditMod from '../scripts/pr-edit.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  // Relative script siblings are pre-loaded via static ESM imports (tst's
  // createRequire shim resolves node: builtins but not relative VFS paths).
  const relativeModules = {
    './pr-watch-filter.js': () => (_prWatchFilterMod.default || _prWatchFilterMod),
    './assign-field.js': () => (_assignFieldMod.default || _assignFieldMod),
    './pr-edit.js': () => (_prEditMod.default || _prEditMod),
  };
  const realRequire = createRequire(target);
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (Object.hasOwn(relativeModules, id)) return relativeModules[id]();
    return realRequire(id);
  };
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
      async () => fail('unexpected fetch')
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
  is(result.error.exitCode, 0);
  is(writes(result), [
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
  is(result.error.exitCode, 0);
  is(writes(result), [
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
  is(result.error.exitCode, 0);
  is(result.stdinReadCount, 1);
  is(writes(result), [
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
  is(result.error.exitCode, 0);
  is(writes(result)[0].options.body, { text: 'equals form' });
});

test('gh api --input errors on invalid JSON', async () => {
  const result = await runGh(
    ['api', '/markdown', '-X', 'POST', '--input', '/bad.json'],
    { bodyFiles: { '/bad.json': 'not valid json{' } }
  );
  is(result.error.name, 'NodeExitError');
  is(result.error.exitCode, 1);
  ok((/not valid JSON/).test(result.error.message));
  is(writes(result), []);
});

test('gh api --input errors when file cannot be read', async () => {
  const result = await runGh(
    ['api', '/markdown', '-X', 'POST', '--input', '/nonexistent.json']
  );
  is(result.error.name, 'NodeExitError');
  ok((/could not read --input \/nonexistent\.json/).test(result.error.message));
});

test('gh api --input is mutually exclusive with -F', async () => {
  const result = await runGh(
    ['api', '/markdown', '--input', '/body.json', '-F', 'text=hello'],
    { bodyFiles: { '/body.json': '{"text":"hi"}' } }
  );
  is(result.error.name, 'NodeExitError');
  ok((/mutually exclusive/).test(result.error.message));
  is(writes(result), []);
});

test('gh api --input is mutually exclusive with -f', async () => {
  const result = await runGh(
    ['api', '/markdown', '--input', '/body.json', '-f', 'text=hello'],
    { bodyFiles: { '/body.json': '{"text":"hi"}' } }
  );
  is(result.error.name, 'NodeExitError');
  ok((/mutually exclusive/).test(result.error.message));
});

// ── unknown flag rejection ───────────────────────────────────────────────────

test('gh api rejects unknown flags', async () => {
  const result = await runGh(['api', '/user', '--totally-bogus']);
  is(result.error.name, 'NodeExitError');
  is(result.error.exitCode, 1);
  ok((/unknown flag '--totally-bogus'/).test(result.error.message));
  ok((/--help/).test(result.error.message));
});

test('gh api rejects unknown flags with =value form', async () => {
  const result = await runGh(['api', '/markdown', '--bogus=1']);
  is(result.error.name, 'NodeExitError');
  ok((/unknown flag '--bogus'/).test(result.error.message));
});

test('gh api rejects unknown short flags', async () => {
  const result = await runGh(['api', '/user', '-Z']);
  is(result.error.name, 'NodeExitError');
  ok((/unknown flag '-Z'/).test(result.error.message));
});

// ── existing behaviour preservation ──────────────────────────────────────────

test('gh api -F still works after --input addition', async () => {
  const result = await runGh([
    'api', '/repos/octo/repo/issues', '-F', 'title=test', '-F', 'draft=true',
  ]);
  is(result.error.exitCode, 0);
  is(writes(result), [
    {
      method: 'post',
      path: '/repos/octo/repo/issues',
      options: { body: { title: 'test', draft: true } },
    },
  ]);
});

test('gh api plain GET still works', async () => {
  const result = await runGh(['api', '/user']);
  is(result.error.exitCode, 0);
  is(result.calls, [
    { method: 'get', path: '/user', options: {} },
  ]);
});

test('gh api -X GET with fields sends params', async () => {
  const result = await runGh(['api', '/search/issues', '-X', 'GET', '-f', 'q=test']);
  is(result.calls, [
    { method: 'get', path: '/search/issues', options: { params: { q: 'test' } } },
  ]);
});

test('gh api --jq still works', async () => {
  const result = await runGh(['api', '/user', '--jq', '.login']);
  // jq handling runs after the API call; just verify the call was made
  is(result.calls[0].method, 'get');
  is(result.calls[0].path, '/user');
});

test('gh api help documents --input', async () => {
  const result = await runGh(['api', '--help']);
  is(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  ok((/--input/).test(help));
  ok((/mutually exclusive/).test(help));
  ok((/Unknown flags are rejected/).test(help));
});

test('gh api --input with GET converts body to query params', async () => {
  const result = await runGh(
    ['api', '/search/issues', '-X', 'GET', '--input', '/query.json'],
    { bodyFiles: { '/query.json': '{"q":"repo:octo/repo","per_page":5}' } }
  );
  is(result.error.exitCode, 0);
  is(result.calls, [
    {
      method: 'get',
      path: '/search/issues',
      options: { params: { q: 'repo:octo/repo', per_page: 5 } },
    },
  ]);
});
