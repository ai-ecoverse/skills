import test, { fail, is, not, ok } from 'tst';
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
  const fetchCalls = [];
  const stdout = [];
  const stderr = [];
  let stdinReadCount = 0;
  let pullReadCount = 0;
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
      if (/\/pulls\/\d+$/.test(requestPath)) {
        pullReadCount++;
        if (pullReadCount > 1 && scenario.updatedPull) return scenario.updatedPull;
        return scenario.pull || {};
      }
      if (requestPath.includes('/issues/')) {
        return scenario.issue || { labels: [], assignees: [] };
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
      if (scenario.bodyFiles && Object.hasOwn(scenario.bodyFiles, filePath)) {
        return scenario.bodyFiles[filePath];
      }
      if (filePath === '/body.md') return 'from file';
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
  const mockFetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const response = scenario.fetchResponse;
    if (!response) fail('unexpected fetch');
    const headerEntries = Object.entries(response.headers || {});
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText || '',
      headers: {
        entries: () => headerEntries[Symbol.iterator](),
        get: (name) =>
          headerEntries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null,
      },
      text: async () =>
        response.body === undefined
          ? ''
          : typeof response.body === 'string'
            ? response.body
            : JSON.stringify(response.body),
    };
  };

  try {
    await new AsyncFunction('require', 'process', 'console', 'fetch', source)(
      mockRequire,
      mockProcess,
      mockConsole,
      mockFetch
    );
    return { calls, fetchCalls, stdinReadCount, stdout, stderr };
  } catch (error) {
    return { error, calls, fetchCalls, stdinReadCount, stdout, stderr };
  }
}

function writes(result) {
  return result.calls.filter((call) => call.method !== 'get');
}

test('exposes pr edit in top-level, group, and scoped help', async () => {
  for (const args of [['--help'], ['pr', '--help']]) {
    const result = await runGh(args);
    is(result.error.exitCode, 0);
    ok((/pr edit/).test(result.stdout.join('\n')));
  }

  const result = await runGh(['pr', 'edit', '--help']);
  is(result.error.exitCode, 0);
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
    '--json',
    '--jq',
  ])
    ok((new RegExp(flag)).test(help));
  ok((/use "-" for stdin/).test(help));
  ok((/use @me for yourself/).test(help));
  ok(!(/--(?:add|remove)-project/).test(help));

  const terseHelp = await runGh(['pr', 'edit', '42', '--title', 'T', '-h', '-R', 'octo/repo']);
  is(terseHelp.error.exitCode, 0);
  is(writes(terseHelp), []);
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
    [['pr', 'edit', '42', '--bogus', 'X', '-R', 'octo/repo'], /unknown flag --bogus/],
    [
      ['pr', 'edit', '42', '--add-project', 'Roadmap', '-R', 'octo/repo'],
      /unknown flag --add-project/,
    ],
    [
      ['pr', 'edit', '42', '--title', 'T', '--json', 'notAField', '-R', 'octo/repo'],
      /unknown JSON field "notAField"/,
    ],
    [
      ['pr', 'edit', '42', 'invalid', '--title', 'T'],
      /Invalid repo format/,
      { inferredRepo: 'inferred/repo' },
    ],
  ];
  for (const [args, message, scenario] of cases) {
    const result = await runGh(args, scenario);
    is(result.error.name, 'NodeExitError');
    not(result.error.exitCode, 0);
    ok((message).test(result.error.message));
    is(writes(result), []);
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
  is(writes(result), [
    {
      method: 'patch',
      path: '/repos/octo/repo/pulls/42',
      options: { body: { title: 'T', body: 'B', base: 'stable' } },
    },
  ]);

  result = await runGh(['pr', 'edit', '42', '-F', '/body.md', '-R', 'octo/repo']);
  is(writes(result)[0].options.body, { body: 'from file' });

  result = await runGh(['pr', 'edit', '42', '--body', '', '-R', 'octo/repo'], {
    pull: { body: 'existing body' },
  });
  is(writes(result)[0].options.body, { body: '' });

  result = await runGh(['pr', 'edit', '42', '-F', '/newline.md', '-R', 'octo/repo'], {
    bodyFiles: { '/newline.md': 'from file\n' },
  });
  is(writes(result)[0].options.body, { body: 'from file\n' });

  result = await runGh(['pr', 'edit', '42', '--title', 'T'], {
    inferredRepo: 'inferred/repo',
  });
  is(writes(result)[0].path, '/repos/inferred/repo/pulls/42');
});

test('reads --body-file - from one-shot stdin without changing file behavior', async () => {
  let result = await runGh(['pr', 'edit', '42', '--body-file', '-', '-R', 'octo/repo'], {
    stdin: 'from stdin\n',
  });
  is(result.stdinReadCount, 1);
  is(writes(result)[0].options.body, { body: 'from stdin\n' });

  result = await runGh(['pr', 'edit', '42', '--body-file', '/body.md', '-R', 'octo/repo'], {
    stdin: 'must not be read',
  });
  is(result.stdinReadCount, 0);
  is(writes(result)[0].options.body, { body: 'from file' });
});

test('rejects stdin conflicts and read failures before any write', async () => {
  let result = await runGh(
    ['pr', 'edit', '42', '--body', 'inline', '--body-file', '-', '-R', 'octo/repo'],
    { stdin: 'must not be read' }
  );
  ok((/body specified twice/).test(result.error.message));
  is(result.stdinReadCount, 0);
  is(writes(result), []);

  result = await runGh(['pr', 'edit', '42', '--body-file', '-', '-R', 'octo/repo'], {
    stdinError: new Error('stdin unavailable'),
  });
  ok((/could not read stdin.*stdin unavailable/).test(result.error.message));
  is(result.stdinReadCount, 1);
  is(writes(result), []);
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
  is(writes(result), [
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
  is(writes(result)[0].options.body, {
    assignees: ['keep-user', 'octocat', 'bob'],
  });

  result = await runGh(['pr', 'edit', '42', '--remove-assignee', '@me', '-R', 'octo/repo'], {
    authenticatedUser: { login: 'octocat' },
    issue: { labels: [], assignees: [{ login: 'keep-user' }, { login: 'octocat' }] },
  });
  is(writes(result)[0].options.body, { assignees: ['keep-user'] });
});

test('fails authenticated-user lookup before any assignee write', async () => {
  const result = await runGh(['pr', 'edit', '42', '--add-assignee', '@me', '-R', 'octo/repo'], {
    failUserLookup: true,
  });
  is(result.error.name, 'NodeExitError');
  ok((/could not resolve @me.*viewer unavailable/).test(result.error.message));
  is(writes(result), []);
  is(result.calls, [{ method: 'get', path: '/user', options: undefined }]);
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
  is(writes(result), [
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

test('emits selected fields from the updated PR with --json', async () => {
  const scenario = {
    pull: { number: 42, title: 'Before', body: '', base: { ref: 'main' } },
    updatedPull: {
      number: 42,
      title: 'After',
      body: '',
      base: { ref: 'main' },
      html_url: 'https://example.test/pr/42',
    },
  };
  let result = await runGh(
    ['pr', 'edit', '42', '--title', 'After', '--json', 'number,title,url', '-R', 'octo/repo'],
    scenario
  );
  is(writes(result), [
    {
      method: 'patch',
      path: '/repos/octo/repo/pulls/42',
      options: { body: { title: 'After' } },
    },
  ]);
  is(JSON.parse(result.stdout.join('\n')), {
    number: 42,
    title: 'After',
    url: 'https://example.test/pr/42',
  });

  result = await runGh(
    ['pr', 'edit', '42', '--title', 'After', '--json', '-R', 'octo/repo'],
    scenario
  );
  is(JSON.parse(result.stdout.join('\n')).title, 'After');

  result = await runGh(
    [
      'pr',
      'edit',
      '42',
      '--title',
      'After',
      '--json',
      'title',
      '--jq',
      '.title',
      '-R',
      'octo/repo',
    ],
    scenario
  );
  is(result.stdout.join('\n'), 'After');
});

test('reports semantic no-ops without a PATCH', async () => {
  let result = await runGh(['pr', 'edit', '42', '--title', 'Same', '-R', 'octo/repo'], {
    pull: { title: 'Same', body: '', base: { ref: 'main' } },
  });
  is(writes(result), []);
  ok((/No changes/).test(result.stdout.join('\n')));
  ok(!(/Edited PR/).test(result.stdout.join('\n')));

  result = await runGh(['pr', 'edit', '42', '--add-label', 'ready', '-R', 'octo/repo'], {
    pull: { title: 'Same', body: '', base: { ref: 'main' } },
    issue: { labels: [{ name: 'ready' }], assignees: [] },
  });
  is(writes(result), []);
  ok((/No changes/).test(result.stdout.join('\n')));
});

test('repo inference failure recommends the explicit -R form', async () => {
  const result = await runGh(['pr', 'edit', '42', '--title', 'T']);
  ok((/-R owner\/repo/).test(result.error.message));
  is(writes(result), []);
});

test('resolves named milestones and clears milestones', async () => {
  let result = await runGh(['pr', 'edit', '42', '--milestone', 'Sprint', '-R', 'octo/repo'], {
    milestones: [{ title: 'Sprint', number: 7 }],
  });
  is(writes(result)[0].options.body, { milestone: 7 });

  result = await runGh(['pr', 'edit', '42', '--remove-milestone', '-R', 'octo/repo'], {
    issue: { labels: [], assignees: [], milestone: { number: 7 } },
  });
  is(writes(result)[0].options.body, { milestone: null });
});

test('gh api fields imply POST and preserve typed versus raw semantics', async () => {
  const result = await runGh([
    'api',
    '/repos/octo/repo/issues',
    '-F',
    'count=2',
    '--field',
    'draft=false',
    '-f',
    'raw=2',
    '--raw-field',
    'version=1.0',
  ]);

  is(result.error.exitCode, 0);
  is(writes(result), [
    {
      method: 'post',
      path: '/repos/octo/repo/issues',
      options: { body: { count: 2, draft: false, raw: '2', version: '1.0' } },
    },
  ]);
});

test('gh api preserves an explicit GET by sending fields as query parameters', async () => {
  const result = await runGh(['api', '/search/issues', '-X', 'GET', '-f', 'q=repo:octo/repo']);

  is(result.calls, [
    {
      method: 'get',
      path: '/search/issues',
      options: { params: { q: 'repo:octo/repo' } },
    },
  ]);
  is(writes(result), []);
});

test('gh api -i includes response status and headers before the body', async () => {
  const result = await runGh(['api', '/repos/octo/repo', '-i'], {
    fetchResponse: {
      status: 200,
      headers: {
        'x-ratelimit-remaining': '42',
        date: 'Mon, 21 Sep 2026 08:00:00 GMT',
      },
      body: { full_name: 'octo/repo' },
    },
  });

  is(result.calls, []);
  const [
    {
      init: { signal, ...init },
      url,
    },
  ] = result.fetchCalls;
  ok(signal instanceof AbortSignal);
  is(
    { url, init },
    {
      url: 'https://api.github.com/repos/octo/repo',
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer fake',
          'User-Agent': 'gh.jsh/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    }
  );
  is(result.stdout, [
    'HTTP/2.0 200 OK',
    'Date: Mon, 21 Sep 2026 08:00:00 GMT',
    'X-Ratelimit-Remaining: 42',
    '',
    '{"full_name":"octo/repo"}',
  ]);
});

test('gh api --include applies --jq to the response body', async () => {
  const result = await runGh(
    ['api', '/rate_limit', '--include', '--jq', '.resources.core.remaining'],
    {
      fetchResponse: {
        status: 200,
        headers: { 'x-ratelimit-remaining': '41' },
        body: { resources: { core: { remaining: 41 } } },
      },
    }
  );

  is(result.calls, []);
  is(result.stdout, ['HTTP/2.0 200 OK', 'X-Ratelimit-Remaining: 41', '', '41']);
});

test('gh api -i preserves status, headers, and body for an error response', async () => {
  const result = await runGh(['api', '/rate_limit', '-i'], {
    fetchResponse: {
      status: 403,
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1789977600',
      },
      body: { message: 'API rate limit exceeded' },
    },
  });

  is(result.error.name, 'NodeExitError');
  is(result.error.exitCode, 1);
  is(result.calls, []);
  is(result.stdout, [
    'HTTP/2.0 403 Forbidden',
    'X-Ratelimit-Limit: 5000',
    'X-Ratelimit-Remaining: 0',
    'X-Ratelimit-Reset: 1789977600',
    '',
    '{"message":"API rate limit exceeded"}',
  ]);
});

test('gh api -F reads a multi-line UTF-8 file', async () => {
  const body = 'First line\nEmoji: 🐙\nCafé\n';
  const result = await runGh(['api', '/repos/octo/repo/issues', '-F', 'body=@/issue.md'], {
    bodyFiles: { '/issue.md': body },
  });

  is(writes(result)[0].options.body, { body });
  is(result.stdinReadCount, 0);
});

test('gh api -F reads @- from stdin', async () => {
  const result = await runGh(['api', '/repos/octo/repo/issues', '-F', 'body=@-'], {
    stdin: 'Line one\nLine two\n',
  });

  is(writes(result)[0].options.body, { body: 'Line one\nLine two\n' });
  is(result.stdinReadCount, 1);
});

test('gh api reports -F file errors with the literal-mention alternative', async () => {
  const result = await runGh(['api', '/repos/octo/repo/issues', '-F', 'body=@octocat']);

  is(result.error.name, 'NodeExitError');
  ok((/could not read -F value from octocat/).test(result.error.message));
  ok((/Use -f key=@mention/).test(result.error.message));
  is(writes(result), []);
});

test('gh api accepts a legitimate value beginning with @ via -f', async () => {
  const result = await runGh(['api', '/repos/octo/repo/issues', '-f', 'body=@octocat']);

  is(writes(result)[0].options.body, { body: '@octocat' });
});

test('gh api help documents field behavior and the -F collision', async () => {
  const result = await runGh(['api', '--help']);
  is(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  ok((/fields imply POST/).test(help));
  ok((/@file reads UTF-8 and @- reads stdin/).test(help));
  ok((/-f, --raw-field/).test(help));
  ok((/-F, --field/).test(help));
  ok((/-i, --include/).test(help));
  ok((/--body-file for gh issue\/pr/).test(help));
  ok((/-f key=@mention/).test(help));
});

test('propagates API failures as command errors', async () => {
  const result = await runGh(['pr', 'edit', '42', '--title', 'T', '-R', 'octo/repo'], {
    failWrite: true,
  });
  is(result.error.name, 'NodeExitError');
  is(result.error.message, 'pr edit failed: boom');
});
