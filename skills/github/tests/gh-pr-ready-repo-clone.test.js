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
    put: async () => fail('unexpected PUT'),
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
      async () => fail('unexpected fetch')
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
  ok(graphqlCall, 'should call /graphql');
  ok((/markPullRequestReadyForReview/).test(graphqlCall.options.body.query));
  is(graphqlCall.options.body.variables.id, 'PR_test123');
  ok((/ready for review/).test(result.stdout.join('\n')));
});

test('pr ready --undo: converts a non-draft PR to draft via GraphQL', async () => {
  const result = await runGh(['pr', 'ready', '42', '--undo', '-R', 'octo/repo'], {
    pull: { number: 42, draft: false, node_id: 'PR_test123', head: { sha: 'abc' } },
    graphqlResponse: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } },
  });
  const graphqlCall = result.calls.find((c) => c.path === '/graphql');
  ok(graphqlCall, 'should call /graphql');
  ok((/convertPullRequestToDraft/).test(graphqlCall.options.body.query));
  is(graphqlCall.options.body.variables.id, 'PR_test123');
  ok((/back to draft/).test(result.stdout.join('\n')));
});

test('pr ready: skips when PR is already ready', async () => {
  const result = await runGh(['pr', 'ready', '42', '-R', 'octo/repo'], {
    pull: { number: 42, draft: false, node_id: 'PR_test123', head: { sha: 'abc' } },
  });
  const graphqlCalls = result.calls.filter((c) => c.path === '/graphql');
  is(graphqlCalls.length, 0, 'should not call GraphQL when already ready');
  ok((/already marked ready/).test(result.stdout.join('\n')));
});

test('pr ready --undo: skips when PR is already a draft', async () => {
  const result = await runGh(['pr', 'ready', '42', '--undo', '-R', 'octo/repo'], {
    pull: { number: 42, draft: true, node_id: 'PR_test123', head: { sha: 'abc' } },
  });
  const graphqlCalls = result.calls.filter((c) => c.path === '/graphql');
  is(graphqlCalls.length, 0, 'should not call GraphQL when already draft');
  ok((/already a draft/).test(result.stdout.join('\n')));
});

test('pr ready: requires a PR number', async () => {
  const result = await runGh(['pr', 'ready', '-R', 'octo/repo']);
  is(result.error.name, 'NodeExitError');
  ok((/PR number required/).test(result.error.message));
  is(writes(result), []);
});

test('pr ready: rejects invalid PR numbers', async () => {
  const result = await runGh(['pr', 'ready', 'nope', '-R', 'octo/repo']);
  is(result.error.name, 'NodeExitError');
  ok((/positive integer/).test(result.error.message));
  is(writes(result), []);
});

test('pr ready: reports GraphQL errors', async () => {
  const result = await runGh(['pr', 'ready', '42', '-R', 'octo/repo'], {
    pull: { number: 42, draft: true, node_id: 'PR_test123', head: { sha: 'abc' } },
    graphqlResponse: { errors: [{ message: 'Token lacks scope' }] },
  });
  is(result.error.name, 'NodeExitError');
  ok((/GraphQL error.*Token lacks scope/).test(result.error.message));
});

test('pr ready: reports not found errors', async () => {
  const result = await runGh(['pr', 'ready', '999', '-R', 'octo/repo'], {
    failPrGet: { status: 404, body: { message: 'Not Found' } },
  });
  is(result.error.name, 'NodeExitError');
  ok((/not found/).test(result.error.message));
});

test('pr ready: exposes help with --help', async () => {
  const result = await runGh(['pr', 'ready', '--help']);
  is(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  ok((/--undo/).test(help));
  ok((/--repo/).test(help));
  ok((/GraphQL/).test(help));
});

test('pr ready: appears in pr group help', async () => {
  const result = await runGh(['pr', '--help']);
  is(result.error.exitCode, 0);
  ok((/ready/).test(result.stdout.join('\n')));
});

test('pr ready: appears in top-level help', async () => {
  const result = await runGh(['--help']);
  is(result.error.exitCode, 0);
  ok((/pr ready/).test(result.stdout.join('\n')));
});

// ─── repo clone ──────────────────────────────────────────────────────────────

test('repo clone: clones a repository via exec.spawn', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  ok(result.execResults.length >= 1, 'should call exec.spawn');
  const cloneCall = result.execResults[0];
  is(cloneCall[0], 'git');
  is(cloneCall[1], 'clone');
  ok(cloneCall.includes('https://github.com/octo/repo.git'), 'should use HTTPS URL');
  ok((/Cloned.*octo\/repo/).test(result.stdout.join('\n')));
});

test('repo clone: supports --depth flag', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '--depth', '1'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  const depthIdx = cloneCall.indexOf('--depth');
  ok(depthIdx >= 0, 'should include --depth');
  is(cloneCall[depthIdx + 1], '1');
});

test('repo clone: supports -b/--branch flag', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '-b', 'dev'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  const branchIdx = cloneCall.indexOf('--branch');
  ok(branchIdx >= 0, 'should include --branch');
  is(cloneCall[branchIdx + 1], 'dev');
});

test('repo clone: supports custom directory', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '/tmp/mydir'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  ok(cloneCall.includes('/tmp/mydir'), 'should include the target directory');
});

test('repo clone: passes flags after -- to git', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '--', '--single-branch', '--no-tags'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  ok(cloneCall.includes('--single-branch'), 'should forward --single-branch');
  ok(cloneCall.includes('--no-tags'), 'should forward --no-tags');
});

test('repo clone: rejects missing owner/repo', async () => {
  const result = await runGh(['repo', 'clone']);
  is(result.error.name, 'NodeExitError');
  ok((/owner\/repo required/).test(result.error.message));
});

test('repo clone: rejects non-empty destination', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo', '/existing'], {
    repo: { full_name: 'octo/repo', fork: false },
    existingDirs: { '/existing': ['file1.txt', 'file2.txt'] },
  });
  is(result.error.name, 'NodeExitError');
  ok((/already exists and is not empty/).test(result.error.message));
  is(result.execResults.length, 0, 'should not spawn git');
});

test('repo clone: reports nonexistent repo', async () => {
  const result = await runGh(['repo', 'clone', 'octo/nonexistent'], {
    failRepoGet: { status: 404, body: { message: 'Not Found' } },
  });
  is(result.error.name, 'NodeExitError');
  ok((/not found/).test(result.error.message));
});

test('repo clone: reports git clone failure', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo'], {
    repo: { full_name: 'octo/repo', fork: false },
    spawnResult: { stdout: '', stderr: 'fatal: something went wrong', exitCode: 128 },
  });
  is(result.error.name, 'NodeExitError');
  ok((/git clone failed/).test(result.error.message));
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
  ok(result.execResults.length >= 2, 'should call exec.spawn at least twice');
  const upstreamCall = result.execResults[1];
  ok(upstreamCall.includes('remote'), 'second call should be git remote');
  ok(upstreamCall.includes('upstream'), 'should add upstream remote');
  ok((/upstream.*upstream\/repo/).test(result.stdout.join('\n')));
});

test('repo clone: does not embed token in URL', async () => {
  const result = await runGh(['repo', 'clone', 'octo/repo'], {
    repo: { full_name: 'octo/repo', fork: false },
  });
  const cloneCall = result.execResults[0];
  const urlArg = cloneCall.find((a) => a.includes('github.com'));
  ok(urlArg, 'should have a GitHub URL argument');
  ok(!(/fake|token|Bearer/).test(urlArg), 'should not embed token in URL');
});

test('repo clone: exposes help with --help', async () => {
  const result = await runGh(['repo', 'clone', '--help']);
  is(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  ok((/--depth/).test(help));
  ok((/--branch/).test(help));
  ok((/upstream/).test(help));
});

test('repo clone: appears in repo group help', async () => {
  const result = await runGh(['repo', '--help']);
  is(result.error.exitCode, 0);
  ok((/clone/).test(result.stdout.join('\n')));
});

test('repo clone: appears in top-level help', async () => {
  const result = await runGh(['--help']);
  is(result.error.exitCode, 0);
  ok((/repo clone/).test(result.stdout.join('\n')));
});
