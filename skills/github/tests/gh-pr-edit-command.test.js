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
      if (requestPath === '/user') {
        if (scenario.failUserLookup) throw { body: { message: 'viewer unavailable' } };
        return scenario.authenticatedUser || { login: 'viewer' };
      }
      if (requestPath.endsWith('/milestones')) return scenario.milestones || [];
      if (requestPath.includes('/issues/')) {
        return scenario.issue || { labels: [], assignees: [] };
      }
      return {};
    },
    patch: record('patch'),
    post: record('post'),
    delete: record('delete'),
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
  const exec = async (command) => {
    if (scenario.inferredRepo && command.includes('rev-parse --show-toplevel')) {
      return { stdout: '/workspace/repo\n', stderr: '', exitCode: 0 };
    }
    if (scenario.inferredRepo && command.includes('config --get remote.origin.url')) {
      return { stdout: `git@github.com:${scenario.inferredRepo}.git\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  };
  exec.spawn = exec;
  exec.start = exec;
  const fileSystem = {
    readFile: async (filePath) => {
      if (filePath === '/body.md') return 'from file';
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
  return result.calls.filter((call) => call.method !== 'get');
}

test('exposes pr edit in top-level, group, and scoped help', async () => {
  for (const args of [['--help'], ['pr', '--help']]) {
    const result = await runGh(args);
    assert.equal(result.error.exitCode, 0);
    assert.match(result.stdout.join('\n'), /pr edit/);
  }

  const result = await runGh(['pr', 'edit', '--help']);
  assert.equal(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  for (const flag of [
    '--repo',
    '--title',
    '--body',
    '--body-file',
    '--base',
    '--milestone',
    '--remove-milestone',
    '--add-label',
    '--remove-label',
    '--add-assignee',
    '--remove-assignee',
    '--add-reviewer',
    '--remove-reviewer',
  ])
    assert.match(help, new RegExp(flag));
  assert.match(help, /use "-" for stdin/);
  assert.match(help, /use @me for yourself/);
  assert.doesNotMatch(help, /--(?:add|remove)-project/);

  const terseHelp = await runGh(['pr', 'edit', '42', '--title', 'T', '-h', '-R', 'octo/repo']);
  assert.equal(terseHelp.error.exitCode, 0);
  assert.deepEqual(writes(terseHelp), []);
});

test('rejects parser and validation errors before any write', async () => {
  const cases = [
    [['pr', 'edit', '--title', 'x', '-R', 'octo/repo'], /PR number required/],
    [['pr', 'edit', 'nope', '--title', 'x', '-R', 'octo/repo'], /positive integer/],
    [['pr', 'edit', '42', '-R', 'octo/repo'], /nothing to update/],
    [
      ['pr', 'edit', '42', '--body', 'x', '--body-file', '/body.md', '-R', 'octo/repo'],
      /body specified twice/,
    ],
    [
      ['pr', 'edit', '42', '--body', 'x', '--body-file=', '-R', 'octo/repo'],
      /body specified twice/,
    ],
    [
      ['pr', 'edit', '42', '--body-file', '/missing.md', '-R', 'octo/repo'],
      /could not read --body-file/,
    ],
    [
      ['pr', 'edit', '42', '--milestone', '7', '--remove-milestone', '-R', 'octo/repo'],
      /cannot be used together/,
    ],
    [['pr', 'edit', '42', '--milestone=', '-R', 'octo/repo'], /non-empty value/],
    [
      ['pr', 'edit', '42', '--title', 'T', '-R', 'invalid'],
      /Invalid repo format/,
      { inferredRepo: 'inferred/repo' },
    ],
    [
      ['pr', 'edit', '42', '--title', 'T', '--repo='],
      /Invalid repo format/,
      { inferredRepo: 'inferred/repo' },
    ],
    [
      ['pr', 'edit', '42', 'invalid', '--title', 'T'],
      /Invalid repo format/,
      { inferredRepo: 'inferred/repo' },
    ],
  ];
  for (const [args, message, scenario] of cases) {
    const result = await runGh(args, scenario);
    assert.equal(result.error.name, 'NodeExitError');
    assert.notEqual(result.error.exitCode, 0);
    assert.match(result.error.message, message);
    assert.deepEqual(writes(result), []);
  }
});

test('dispatches pull fields and body files to the pull endpoint', async () => {
  let result = await runGh([
    'pr',
    'edit',
    '42',
    '-t',
    'T',
    '-b',
    'B',
    '-B',
    'stable',
    '-R',
    'octo/repo',
  ]);
  assert.deepEqual(writes(result), [
    {
      method: 'patch',
      path: '/repos/octo/repo/pulls/42',
      options: { body: { title: 'T', body: 'B', base: 'stable' } },
    },
  ]);

  result = await runGh(['pr', 'edit', '42', '-F', '/body.md', '-R', 'octo/repo']);
  assert.deepEqual(writes(result)[0].options.body, { body: 'from file' });

  result = await runGh(['pr', 'edit', '42', '--body', '', '-R', 'octo/repo']);
  assert.deepEqual(writes(result)[0].options.body, { body: '' });

  result = await runGh(['pr', 'edit', '42', '--title', 'T'], {
    inferredRepo: 'inferred/repo',
  });
  assert.equal(writes(result)[0].path, '/repos/inferred/repo/pulls/42');
});

test('reads --body-file - from one-shot stdin without changing file behavior', async () => {
  let result = await runGh(['pr', 'edit', '42', '--body-file', '-', '-R', 'octo/repo'], {
    stdin: 'from stdin\n',
  });
  assert.equal(result.stdinReadCount, 1);
  assert.deepEqual(writes(result)[0].options.body, { body: 'from stdin\n' });

  result = await runGh(['pr', 'edit', '42', '--body-file', '/body.md', '-R', 'octo/repo'], {
    stdin: 'must not be read',
  });
  assert.equal(result.stdinReadCount, 0);
  assert.deepEqual(writes(result)[0].options.body, { body: 'from file' });
});

test('rejects stdin conflicts and read failures before any write', async () => {
  let result = await runGh(
    ['pr', 'edit', '42', '--body', 'inline', '--body-file', '-', '-R', 'octo/repo'],
    { stdin: 'must not be read' }
  );
  assert.match(result.error.message, /body specified twice/);
  assert.equal(result.stdinReadCount, 0);
  assert.deepEqual(writes(result), []);

  result = await runGh(['pr', 'edit', '42', '--body-file', '-', '-R', 'octo/repo'], {
    stdinError: new Error('stdin unavailable'),
  });
  assert.match(result.error.message, /could not read stdin.*stdin unavailable/);
  assert.equal(result.stdinReadCount, 1);
  assert.deepEqual(writes(result), []);
});

test('preserves and de-duplicates labels and assignees at the issues endpoint', async () => {
  const result = await runGh(
    [
      'pr',
      'edit',
      '42',
      '--add-label',
      'new,new',
      '--remove-label',
      'old',
      '--add-assignee',
      'bob,bob',
      '--remove-assignee',
      'alice',
      '-R',
      'octo/repo',
    ],
    {
      issue: {
        labels: [{ name: 'keep' }, { name: 'old' }],
        assignees: [{ login: 'keep-user' }, { login: 'alice' }],
      },
    }
  );
  assert.deepEqual(writes(result), [
    {
      method: 'patch',
      path: '/repos/octo/repo/issues/42',
      options: { body: { labels: ['keep', 'new'], assignees: ['keep-user', 'bob'] } },
    },
  ]);
});

test('resolves @me for assignee additions and removals', async () => {
  let result = await runGh(['pr', 'edit', '42', '--add-assignee', '@me,bob', '-R', 'octo/repo'], {
    authenticatedUser: { login: 'octocat' },
    issue: { labels: [], assignees: [{ login: 'keep-user' }] },
  });
  assert.deepEqual(writes(result)[0].options.body, {
    assignees: ['keep-user', 'octocat', 'bob'],
  });

  result = await runGh(['pr', 'edit', '42', '--remove-assignee', '@me', '-R', 'octo/repo'], {
    authenticatedUser: { login: 'octocat' },
    issue: { labels: [], assignees: [{ login: 'keep-user' }, { login: 'octocat' }] },
  });
  assert.deepEqual(writes(result)[0].options.body, { assignees: ['keep-user'] });
});

test('fails authenticated-user lookup before any assignee write', async () => {
  const result = await runGh(['pr', 'edit', '42', '--add-assignee', '@me', '-R', 'octo/repo'], {
    failUserLookup: true,
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /could not resolve @me.*viewer unavailable/);
  assert.deepEqual(writes(result), []);
  assert.deepEqual(result.calls, [{ method: 'get', path: '/user', options: undefined }]);
});

test('dispatches user and team reviewer additions and removals', async () => {
  const result = await runGh([
    'pr',
    'edit',
    '42',
    '--add-reviewer',
    'alice,alice,acme/platform',
    '--remove-reviewer',
    'bob,bob,acme/legacy',
    '-R',
    'octo/repo',
  ]);
  assert.deepEqual(writes(result), [
    {
      method: 'post',
      path: '/repos/octo/repo/pulls/42/requested_reviewers',
      options: { body: { reviewers: ['alice'], team_reviewers: ['platform'] } },
    },
    {
      method: 'delete',
      path: '/repos/octo/repo/pulls/42/requested_reviewers',
      options: { body: { reviewers: ['bob'], team_reviewers: ['legacy'] } },
    },
  ]);
});

test('resolves named milestones and clears milestones', async () => {
  let result = await runGh(['pr', 'edit', '42', '--milestone', 'Sprint', '-R', 'octo/repo'], {
    milestones: [{ title: 'Sprint', number: 7 }],
  });
  assert.deepEqual(writes(result)[0].options.body, { milestone: 7 });

  result = await runGh(['pr', 'edit', '42', '--remove-milestone', '-R', 'octo/repo']);
  assert.deepEqual(writes(result)[0].options.body, { milestone: null });
});

test('propagates API failures as command errors', async () => {
  const result = await runGh(['pr', 'edit', '42', '--title', 'T', '-R', 'octo/repo'], {
    failWrite: true,
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.equal(result.error.message, 'pr edit failed: boom');
});
