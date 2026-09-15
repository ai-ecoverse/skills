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
  const record = (method) => async (requestPath, options) => {
    calls.push({ method, path: requestPath, options });
    if (scenario.failWrite) throw { body: { message: 'boom' } };
    if (scenario.graphqlResponse && requestPath === '/graphql') return scenario.graphqlResponse;
    return { ...(options?.body || {}), html_url: 'https://example.test/pr/42' };
  };
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (requestPath === '/user') return scenario.authenticatedUser || { login: 'viewer' };
      if (/\/pulls\/\d+$/.test(requestPath)) {
        if (scenario.failPrGet) throw scenario.failPrGet;
        return (
          scenario.pull || { number: 42, draft: true, node_id: 'PR_test123', head: { sha: 'abc' } }
        );
      }
      if (/\/repos\/[^/]+\/[^/]+$/.test(requestPath) && !requestPath.includes('/pulls/')) {
        if (scenario.failRepoGet) throw scenario.failRepoGet;
        return scenario.repo || { full_name: 'octo/repo', fork: false };
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
  const execResults = [];
  const exec = async (command) => {
    if (scenario.inferredRepo && command.includes('rev-parse --show-toplevel')) {
      return { stdout: '/workspace/repo\n', stderr: '', exitCode: 0 };
    }
    if (scenario.inferredRepo && command.includes('config --get remote.origin.url')) {
      return { stdout: `git@github.com:${scenario.inferredRepo}.git\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  };
  exec.spawn = async (argv) => {
    execResults.push(argv);
    if (scenario.spawnResult) return scenario.spawnResult;
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  exec.start = exec;
  const fileSystem = {
    readFile: async () => {
      throw new Error('ENOENT');
    },
    readFileBinary: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    stat: async (filePath) => {
      if (scenario.existingDirs && scenario.existingDirs[filePath]) return { isDirectory: true };
      throw new Error('ENOENT');
    },
    readDir: async (filePath) => {
      if (scenario.existingDirs && scenario.existingDirs[filePath])
        return scenario.existingDirs[filePath];
      throw new Error('ENOENT');
    },
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
    return { calls, stdout, stderr, execResults };
  } catch (error) {
    return { error, calls, stdout, stderr, execResults };
  }
}

function writes(result) {
  return result.calls.filter((call) => call.method !== 'get');
}

// ─── pr ready ────────────────────────────────────────────────────────────────

test('pr ready: marks a draft PR ready for review via GraphQL', async () => {
  const result = await runGh(['pr', 'ready', '42', '-R', 'octo/repo'], {
    pull: { number: 42, draft: true, node_id: 'PR_test123', head: { sha: 'abc' } },
    graphqlResponse: {
      data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
    },
  });
  const graphqlCall = result.calls.find((c) => c.path === '/graphql');
  assert.ok(graphqlCall, 'should call /graphql');
  assert.match(graphqlCall.options.body.query, /markPullRequestReadyForReview/);
  assert.equal(graphqlCall.options.body.variables.id, 'PR_test123');
  assert.match(result.stdout.join('\n'), /ready for review/);
});

test('pr ready --undo: converts a non-draft PR to draft via GraphQL', async () => {
  const result = await runGh(['pr', 'ready', '42', '--undo', '-R', 'octo/repo'], {
    pull: { number: 42, draft: false, node_id: 'PR_test123', head: { sha: 'abc' } },
    graphqlResponse: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } },
  });
  const graphqlCall = result.calls.find((c) => c.path === '/graphql');
  assert.ok(graphqlCall, 'should call /graphql');
  assert.match(graphqlCall.options.body.query, /convertPullRequestToDraft/);
  assert.equal(graphqlCall.options.body.variables.id, 'PR_test123');
  assert.match(result.stdout.join('\n'), /back to draft/);
});

test('pr ready: skips when PR is already ready', async () => {
  const result = await runGh(['pr', 'ready', '42', '-R', 'octo/repo'], {
    pull: { number: 42, draft: false, node_id: 'PR_test123', head: { sha: 'abc' } },
  });
  const graphqlCalls = result.calls.filter((c) => c.path === '/graphql');
  assert.equal(graphqlCalls.length, 0, 'should not call GraphQL when already ready');
  assert.match(result.stdout.join('\n'), /already marked ready/);
});

test('pr ready --undo: skips when PR is already a draft', async () => {
  const result = await runGh(['pr', 'ready', '42', '--undo', '-R', 'octo/repo'], {
    pull: { number: 42, draft: true, node_id: 'PR_test123', head: { sha: 'abc' } },
  });
  const graphqlCalls = result.calls.filter((c) => c.path === '/graphql');
  assert.equal(graphqlCalls.length, 0, 'should not call GraphQL when already draft');
  assert.match(result.stdout.join('\n'), /already a draft/);
});

test('pr ready: requires a PR number', async () => {
  const result = await runGh(['pr', 'ready', '-R', 'octo/repo']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /PR number required/);
  assert.deepEqual(writes(result), []);
});

test('pr ready: rejects invalid PR numbers', async () => {
  const result = await runGh(['pr', 'ready', 'nope', '-R', 'octo/repo']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /positive integer/);
  assert.deepEqual(writes(result), []);
});

test('pr ready: reports GraphQL errors', async () => {
  const result = await runGh(['pr', 'ready', '42', '-R', 'octo/repo'], {
    pull: { number: 42, draft: true, node_id: 'PR_test123', head: { sha: 'abc' } },
    graphqlResponse: { errors: [{ message: 'Token lacks scope' }] },
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /GraphQL error.*Token lacks scope/);
});

test('pr ready: reports not found errors', async () => {
  const result = await runGh(['pr', 'ready', '999', '-R', 'octo/repo'], {
    failPrGet: { status: 404, body: { message: 'Not Found' } },
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /not found/);
});

test('pr ready: exposes help with --help', async () => {
  const result = await runGh(['pr', 'ready', '--help']);
  assert.equal(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  assert.match(help, /--undo/);
  assert.match(help, /--repo/);
  assert.match(help, /GraphQL/);
});

test('pr ready: appears in pr group help', async () => {
  const result = await runGh(['pr', '--help']);
  assert.equal(result.error.exitCode, 0);
  assert.match(result.stdout.join('\n'), /ready/);
});

test('pr ready: appears in top-level help', async () => {
  const result = await runGh(['--help']);
  assert.equal(result.error.exitCode, 0);
  assert.match(result.stdout.join('\n'), /pr ready/);
});

// ─── repo clone ──────────────────────────────────────────────────────────────

test('repo clone: clones a repository via exec.spawn', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  assert.ok(result.execResults.length >= 1, 'should call exec.spawn');
  const cloneCall = result.execResults[0];
  assert.deepEqual(cloneCall[0], 'git');
  assert.deepEqual(cloneCall[1], 'clone');
  assert.ok(cloneCall.includes('https://github.com/octo/repo.git'), 'should use HTTPS URL');
  assert.match(result.stdout.join('\n'), /Cloned.*octo\/repo/);
});

test('repo clone: supports --depth flag', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '--depth', '1'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  const depthIdx = cloneCall.indexOf('--depth');
  assert.ok(depthIdx >= 0, 'should include --depth');
  assert.equal(cloneCall[depthIdx + 1], '1');
});

test('repo clone: supports -b/--branch flag', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '-b', 'dev'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  const branchIdx = cloneCall.indexOf('--branch');
  assert.ok(branchIdx >= 0, 'should include --branch');
  assert.equal(cloneCall[branchIdx + 1], 'dev');
});

test('repo clone: supports custom directory', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '/tmp/mydir'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  assert.ok(cloneCall.includes('/tmp/mydir'), 'should include the target directory');
});

test('repo clone: passes flags after -- to git', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '--', '--single-branch', '--no-tags'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  assert.ok(cloneCall.includes('--single-branch'), 'should forward --single-branch');
  assert.ok(cloneCall.includes('--no-tags'), 'should forward --no-tags');
});

test('repo clone: rejects missing owner/repo', async () => {
  const result = await runGh(['repo', 'clone']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /owner\/repo required/);
});

test('repo clone: rejects non-empty destination', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '/existing'], {
    repo: { full_name: 'octo/repo', fork: false },
    existingDirs: { '/existing': ['file1.txt', 'file2.txt'] },
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /already exists and is not empty/);
  assert.equal(result.execResults.length, 0, 'should not spawn git');
});

test('repo clone: reports nonexistent repo', async () => {
  const result = await runGh(['repo', 'clone', 'octo/nonexistent'], {
    failRepoGet: { status: 404, body: { message: 'Not Found' } },
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /not found/);
});

test('repo clone: reports git clone failure', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo'], {
    repo: { full_name: 'octo/repo', fork: false },
    spawnResult: { stdout: '', stderr: 'fatal: something went wrong', exitCode: 128 },
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /git clone failed/);
});

test('repo clone: adds upstream remote for forks', async () => {
  const result = await runGh(['repo', 'clone', 'user/fork-repo'], {
    repo: {
      full_name: 'user/fork-repo',
      fork: true,
      parent: { full_name: 'upstream/repo', clone_url: 'https://github.com/upstream/repo.git' },
    },
  });
  // First exec.spawn is git clone, second is git remote add upstream
  assert.ok(result.execResults.length >= 2, 'should call exec.spawn at least twice');
  const upstreamCall = result.execResults[1];
  assert.ok(upstreamCall.includes('remote'), 'second call should be git remote');
  assert.ok(upstreamCall.includes('upstream'), 'should add upstream remote');
  assert.match(result.stdout.join('\n'), /upstream.*upstream\/repo/);
});

test('repo clone: does not embed token in URL', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  const urlArg = cloneCall.find((a) => a.includes('github.com'));
  assert.ok(urlArg, 'should have a GitHub URL argument');
  assert.doesNotMatch(urlArg, /fake|token|Bearer/, 'should not embed token in URL');
});

test('repo clone: exposes help with --help', async () => {
  const result = await runGh(['repo', 'clone', '--help']);
  assert.equal(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  assert.match(help, /--depth/);
  assert.match(help, /--branch/);
  assert.match(help, /upstream/);
});

test('repo clone: appears in repo group help', async () => {
  const result = await runGh(['repo', '--help']);
  assert.equal(result.error.exitCode, 0);
  assert.match(result.stdout.join('\n'), /clone/);
});

test('repo clone: appears in top-level help', async () => {
  const result = await runGh(['--help']);
  assert.equal(result.error.exitCode, 0);
  assert.match(result.stdout.join('\n'), /repo clone/);
});
