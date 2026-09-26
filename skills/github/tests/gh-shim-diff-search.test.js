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
    patch: async () => fail('unexpected PATCH'),
    post: async () => fail('unexpected POST'),
    delete: async () => fail('unexpected DELETE'),
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
  is(top.error.exitCode, 0);
  const topHelp = top.stdout.join('\n');
  ok((/pr diff/).test(topHelp));
  ok((/search issues/).test(topHelp));
  ok((/--search/).test(topHelp));

  const prHelp = await runGh(['pr', 'diff', '--help']);
  is(prHelp.error.exitCode, 0);
  ok((/--repo/).test(prHelp.stdout.join('\n')));
  ok((/unified diff/).test(prHelp.stdout.join('\n')));

  const searchHelp = await runGh(['search', 'issues', '--help']);
  is(searchHelp.error.exitCode, 0);
  ok((/--repo/).test(searchHelp.stdout.join('\n')));
  ok((/<query>/).test(searchHelp.stdout.join('\n')));

  const issueHelp = await runGh(['issue', 'list', '--help']);
  is(issueHelp.error.exitCode, 0);
  ok((/--search/).test(issueHelp.stdout.join('\n')));
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
  is(result.error, undefined);
  is(
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
  ok((/diff --git a\/src\/app\.js b\/src\/app\.js/).test(out));
  ok((/--- a\/src\/app\.js/).test(out));
  ok((/\+\+\+ b\/src\/app\.js/).test(out));
  ok((/\+added/).test(out));
  ok((/diff --git a\/new\.txt b\/new\.txt/).test(out));
  ok((/new file mode 100644/).test(out));
  ok((/--- \/dev\/null/).test(out));
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
  is(fileCalls.length, 2);
  is(fileCalls[1].options.params.page, 2);
  ok((/diff --git a\/last\.txt b\/last\.txt/).test(result.stdout.join('\n')));
});

test('pr diff exits 1 with a clear error and empty stdout when the PR is missing', async () => {
  const result = await runGh(['pr', 'diff', '999', '-R', 'octo/repo'], {
    filesError: { status: 404, body: { message: 'Not Found', status: '404' } },
  });
  is(result.error.name, 'NodeExitError');
  is(result.error.exitCode, 1);
  ok((/pull request #999 not found in octo\/repo/).test(result.error.message));
  is(result.stdout.join(''), '');
});

test('pr diff requires a PR number', async () => {
  const result = await runGh(['pr', 'diff', '-R', 'octo/repo']);
  is(result.error.name, 'NodeExitError');
  ok((/PR number required/).test(result.error.message));
  is(result.calls.filter((c) => c.path.includes('/files')).length, 0);
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
  is(result.error, undefined);
  const call = searchCall(result);
  ok(call);
  ok((/playwright upload binary/).test(call.options.params.q));
  ok((/type:issue/).test(call.options.params.q));
  ok((/repo:ai-ecoverse\/slicc/).test(call.options.params.q));
  ok(!(/type:pr/).test(call.options.params.q));
  ok((/#2880/).test(result.stdout.join('\n')));
  ok((/gh shim: pr diff and search issues/).test(result.stdout.join('\n')));
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
  is(JSON.parse(json.stdout.join('\n')), [{ number: 7, title: 'fix login' }]);

  const missing = await runGh(['search', 'issues', '-R', 'octo/repo']);
  is(missing.error.name, 'NodeExitError');
  ok((/query required/).test(missing.error.message));
  is(searchCall(missing), undefined);
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
  is(result.error, undefined);
  is(
    result.calls.filter((c) => /\/repos\/.+\/issues$/.test(c.path)).length,
    0,
    'must not fall back to the unfiltered issues list'
  );
  const call = searchCall(result);
  ok(call);
  is(call.options.params.per_page, 5);
  ok((/playwright upload binary corrupt/).test(call.options.params.q));
  ok((/repo:ai-ecoverse\/slicc/).test(call.options.params.q));
  ok((/type:issue/).test(call.options.params.q));
  ok((/state:open/).test(call.options.params.q));
  ok(!(/unrecognised flag --search/).test(result.stderr.join('\n')));
  ok(!(/ignoring unexpected extra argument/).test(result.stderr.join('\n')));
  ok((/#2879/).test(result.stdout.join('\n')));
  ok((/playwright upload binary corrupt/).test(result.stdout.join('\n')));
  ok(!(/unrelated recent issue/).test(result.stdout.join('\n')));
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
  is(result.error, undefined);
  is(searchCall(result), undefined);
  is(result.calls[0].path, '/repos/octo/repo/issues');
  ok((/#10/).test(result.stdout.join('\n')));
  ok(!(/#11/).test(result.stdout.join('\n')));
});
