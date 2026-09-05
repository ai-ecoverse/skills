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
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (scenario.get) {
        const result = await scenario.get(requestPath, options);
        if (result !== undefined) return result;
      }
      if (requestPath === '/user') return { login: 'viewer' };
      if (requestPath === '/search/issues') {
        if (scenario.searchError) throw scenario.searchError;
        return scenario.search || { items: [] };
      }
      if (/\/pulls\/\d+\/files$/.test(requestPath)) {
        if (scenario.filesError) throw scenario.filesError;
        const page = Number(options?.params?.page) || 1;
        if (scenario.filesByPage) return scenario.filesByPage[page] || [];
        return scenario.files || [];
      }
      if (/\/repos\/[^/]+\/[^/]+\/issues$/.test(requestPath) && !requestPath.includes('/search/')) {
        return scenario.issues || [];
      }
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
  const mocks = {
    'sliccy:skill': { token: async () => 'fake' },
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
    return { calls, stdout, stderr };
  } catch (error) {
    return { error, calls, stdout, stderr };
  }
}

function searchCall(result) {
  return result.calls.find((call) => call.path === '/search/issues');
}

test('exposes pr diff, search issues, and issue list --search in help', async () => {
  const top = await runGh(['--help']);
  assert.equal(top.error.exitCode, 0);
  const topHelp = top.stdout.join('\n');
  assert.match(topHelp, /pr diff/);
  assert.match(topHelp, /search issues/);
  assert.match(topHelp, /--search/);

  const prHelp = await runGh(['pr', 'diff', '--help']);
  assert.equal(prHelp.error.exitCode, 0);
  assert.match(prHelp.stdout.join('\n'), /--repo/);
  assert.match(prHelp.stdout.join('\n'), /unified diff/);

  const searchHelp = await runGh(['search', 'issues', '--help']);
  assert.equal(searchHelp.error.exitCode, 0);
  assert.match(searchHelp.stdout.join('\n'), /--repo/);
  assert.match(searchHelp.stdout.join('\n'), /<query>/);

  const issueHelp = await runGh(['issue', 'list', '--help']);
  assert.equal(issueHelp.error.exitCode, 0);
  assert.match(issueHelp.stdout.join('\n'), /--search/);
});

test('pr diff prints a reconstructed unified diff and honours --repo', async () => {
  const result = await runGh(['pr', 'diff', '42', '-R', 'octo/repo'], {
    files: [
      {
        filename: 'src/app.js',
        status: 'modified',
        patch: '@@ -1,2 +1,3 @@\n keep\n+added\n',
      },
      {
        filename: 'new.txt',
        status: 'added',
        patch: '@@ -0,0 +1 @@\n+hello\n',
      },
    ],
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.calls.filter((c) => c.path.includes('/files')),
    [
      {
        method: 'get',
        path: '/repos/octo/repo/pulls/42/files',
        options: { params: { per_page: 100, page: 1 } },
      },
    ]
  );
  const out = result.stdout.join('\n');
  assert.match(out, /diff --git a\/src\/app\.js b\/src\/app\.js/);
  assert.match(out, /--- a\/src\/app\.js/);
  assert.match(out, /\+\+\+ b\/src\/app\.js/);
  assert.match(out, /\+added/);
  assert.match(out, /diff --git a\/new\.txt b\/new\.txt/);
  assert.match(out, /new file mode 100644/);
  assert.match(out, /--- \/dev\/null/);
});

test('pr diff paginates the files endpoint', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    filename: `f${i}.txt`,
    status: 'modified',
    patch: `@@ -1 +1 @@\n-old${i}\n+new${i}`,
  }));
  const result = await runGh(['pr', 'diff', '7', '--repo', 'octo/repo'], {
    filesByPage: {
      1: page1,
      2: [{ filename: 'last.txt', status: 'added', patch: '@@ -0,0 +1 @@\n+tail' }],
    },
  });
  const fileCalls = result.calls.filter((c) => c.path.includes('/files'));
  assert.equal(fileCalls.length, 2);
  assert.equal(fileCalls[1].options.params.page, 2);
  assert.match(result.stdout.join('\n'), /diff --git a\/last\.txt b\/last\.txt/);
});

test('pr diff exits 1 with a clear error and empty stdout when the PR is missing', async () => {
  const result = await runGh(['pr', 'diff', '999', '-R', 'octo/repo'], {
    filesError: { status: 404, body: { message: 'Not Found', status: '404' } },
  });
  assert.equal(result.error.name, 'NodeExitError');
  assert.equal(result.error.exitCode, 1);
  assert.match(result.error.message, /pull request #999 not found in octo\/repo/);
  assert.equal(result.stdout.join(''), '');
});

test('pr diff requires a PR number', async () => {
  const result = await runGh(['pr', 'diff', '-R', 'octo/repo']);
  assert.equal(result.error.name, 'NodeExitError');
  assert.match(result.error.message, /PR number required/);
  assert.equal(result.calls.filter((c) => c.path.includes('/files')).length, 0);
});

test('search issues queries GitHub issue search with --repo', async () => {
  const result = await runGh(
    ['search', 'issues', '--repo', 'ai-ecoverse/slicc', 'playwright upload binary'],
    {
      search: {
        items: [
          {
            number: 2880,
            title: 'gh shim: pr diff and search issues',
            body: 'gaps',
            state: 'open',
            user: { login: 'trieloff', id: 1, html_url: 'https://github.com/trieloff' },
            repository_url: 'https://api.github.com/repos/ai-ecoverse/slicc',
            html_url: 'https://github.com/ai-ecoverse/slicc/issues/2880',
            created_at: '2026-09-04T00:00:00Z',
            updated_at: '2026-09-04T00:00:00Z',
            closed_at: null,
            labels: [{ name: 'skill issue', color: 'ededed' }],
            comments: 1,
            node_id: 'I_1',
          },
        ],
      },
    }
  );
  assert.equal(result.error, undefined);
  const call = searchCall(result);
  assert.ok(call);
  assert.match(call.options.params.q, /playwright upload binary/);
  assert.match(call.options.params.q, /type:issue/);
  assert.match(call.options.params.q, /repo:ai-ecoverse\/slicc/);
  assert.doesNotMatch(call.options.params.q, /type:pr/);
  assert.match(result.stdout.join('\n'), /#2880/);
  assert.match(result.stdout.join('\n'), /gh shim: pr diff and search issues/);
});

test('search issues supports --json and requires a query', async () => {
  const json = await runGh(
    ['search', 'issues', 'login', '--json', 'number,title', '-R', 'octo/repo'],
    {
      search: {
        items: [
          {
            number: 7,
            title: 'fix login',
            body: '',
            state: 'open',
            user: { login: 'octocat' },
            repository_url: 'https://api.github.com/repos/octo/repo',
            html_url: 'https://github.com/octo/repo/issues/7',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            closed_at: null,
            labels: [],
            comments: 0,
            node_id: 'I_7',
          },
        ],
      },
    }
  );
  assert.deepEqual(JSON.parse(json.stdout.join('\n')), [{ number: 7, title: 'fix login' }]);

  const missing = await runGh(['search', 'issues', '-R', 'octo/repo']);
  assert.equal(missing.error.name, 'NodeExitError');
  assert.match(missing.error.message, /query required/);
  assert.equal(searchCall(missing), undefined);
});

test('issue list --search hits search/issues instead of the unfiltered list', async () => {
  const result = await runGh(
    [
      'issue',
      'list',
      '--repo',
      'ai-ecoverse/slicc',
      '--search',
      'playwright upload binary corrupt',
      '--limit',
      '5',
    ],
    {
      search: {
        items: [
          {
            number: 2879,
            title: 'playwright upload binary corrupt',
            body: '',
            state: 'open',
            user: { login: 'octocat' },
            labels: [{ name: 'bug' }],
            html_url: 'https://github.com/ai-ecoverse/slicc/issues/2879',
            created_at: '2026-09-01T00:00:00Z',
            updated_at: '2026-09-01T00:00:00Z',
            closed_at: null,
            comments: 0,
            node_id: 'I_2879',
          },
        ],
      },
      issues: [{ number: 1, title: 'unrelated recent issue', labels: [], pull_request: undefined }],
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(
    result.calls.filter((c) => /\/repos\/.+\/issues$/.test(c.path)).length,
    0,
    'must not fall back to the unfiltered issues list'
  );
  const call = searchCall(result);
  assert.ok(call);
  assert.equal(call.options.params.per_page, 5);
  assert.match(call.options.params.q, /playwright upload binary corrupt/);
  assert.match(call.options.params.q, /repo:ai-ecoverse\/slicc/);
  assert.match(call.options.params.q, /type:issue/);
  assert.match(call.options.params.q, /state:open/);
  assert.doesNotMatch(result.stderr.join('\n'), /unrecognised flag --search/);
  assert.doesNotMatch(result.stderr.join('\n'), /ignoring unexpected extra argument/);
  assert.match(result.stdout.join('\n'), /#2879/);
  assert.match(result.stdout.join('\n'), /playwright upload binary corrupt/);
  assert.doesNotMatch(result.stdout.join('\n'), /unrelated recent issue/);
});

test('issue list without --search still uses the issues list endpoint', async () => {
  const result = await runGh(['issue', 'list', '-R', 'octo/repo', '--limit', '2'], {
    issues: [
      { number: 10, title: 'open bug', labels: [{ name: 'bug' }] },
      {
        number: 11,
        title: 'a pr',
        labels: [],
        pull_request: { url: 'https://api.github.com/repos/octo/repo/pulls/11' },
      },
    ],
  });
  assert.equal(result.error, undefined);
  assert.equal(searchCall(result), undefined);
  assert.equal(result.calls[0].path, '/repos/octo/repo/issues');
  assert.match(result.stdout.join('\n'), /#10/);
  assert.doesNotMatch(result.stdout.join('\n'), /#11/);
});
