import test, { fail, is, ok } from 'tst';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as _prWatchFilterMod from '../scripts/pr-watch-filter.js';
import * as _assignFieldMod from '../scripts/assign-field.js';
import * as _prEditMod from '../scripts/pr-edit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `gh pr merge` through the async merge API (PUT .../merge-async, then polling
// GET .../merge-async/{uuid}), the narrow GraphQL paths that REST cannot
// replace (--auto without a queue, --disable-auto), the opt-in --sync path,
// and the shim-only `gh pr merge-status` / `gh pr queue`. The GitHub API is
// mocked; response bodies follow the examples in GitHub's OpenAPI description
// (github/rest-api-description, operations pulls/merge-async and
// pulls/get-merge-async-result).

const target = path.resolve(__dirname, '../scripts/gh.jsh');
const source = fs.readFileSync(target, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const HEAD = '1111111111111111111111111111111111111111';
const MOVED = '2222222222222222222222222222222222222222';
const MERGED_SHA = '3333333333333333333333333333333333333333';
const UUID = '630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42';
const OTHER_UUID = '7a1c0f3e-9b2d-4c6e-8f10-0123456789ab';

class NodeExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

const pending = (uuid = UUID, extra = {}) => ({
  status: 'pending',
  details: {
    message: 'Merge request enqueued.',
    uuid,
    merge_method: 'default',
    merge_action: 'default',
    expected_head_sha: HEAD,
    ...extra,
  },
});
const merged = {
  status: 'merged',
  details: { message: 'Pull request was merged.', sha: MERGED_SHA },
};
const enqueued = {
  status: 'enqueued',
  details: { message: 'Pull request is in the merge queue.' },
};
const failed = {
  status: 'failed',
  details: { message: 'Merge conflict: the pull request could not be merged.' },
};

function gqlPr(overrides = {}) {
  return {
    id: 'PR_node42',
    number: 42,
    headRefOid: HEAD,
    baseRefName: 'main',
    mergeStateStatus: 'BLOCKED',
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    mergeQueueEntry: null,
    autoMergeRequest: null,
    ...overrides,
  };
}

function graphqlReply(scenario, query) {
  if (/dequeuePullRequest/.test(query)) {
    return { data: { dequeuePullRequest: { mergeQueueEntry: { id: 'MQE_1' } } } };
  }
  if (/enablePullRequestAutoMerge/.test(query)) {
    return scenario.enableAuto || { data: { enablePullRequestAutoMerge: { pullRequest: {} } } };
  }
  if (/disablePullRequestAutoMerge/.test(query)) {
    return { data: { disablePullRequestAutoMerge: { clientMutationId: null } } };
  }
  if (/mergeQueue\(branch/.test(query)) {
    const mq = scenario.queue === undefined ? null : scenario.queue;
    return { data: { repository: { mergeQueue: mq } } };
  }
  if (/pullRequest\(number/.test(query)) {
    return { data: { repository: { pullRequest: scenario.gqlPr || gqlPr() } } };
  }
  return fail('unexpected GraphQL operation: ' + query);
}

async function runGh(args, scenario = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const polls = [...(scenario.polls || [merged])];
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (/\/merge-async\/[^/]+$/.test(requestPath)) {
        if (scenario.pollError) throw scenario.pollError;
        return polls.length > 1 ? polls.shift() : polls[0];
      }
      if (/\/pulls\/\d+$/.test(requestPath)) {
        if (scenario.pullError) throw scenario.pullError;
        return (
          scenario.pull || { number: 42, state: 'open', head: { sha: HEAD }, base: { ref: 'main' } }
        );
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(requestPath)) return { default_branch: 'trunk' };
      return {};
    },
    post: async (requestPath, options) => {
      calls.push({ method: 'post', path: requestPath, options });
      if (requestPath !== '/graphql') return fail('unexpected POST ' + requestPath);
      return graphqlReply(scenario, options.body.query);
    },
    put: async (requestPath, options) => {
      calls.push({ method: 'put', path: requestPath, options });
      if (/\/merge-async$/.test(requestPath)) {
        if (scenario.putError) throw scenario.putError;
        return scenario.putResult || pending();
      }
      if (/\/merge$/.test(requestPath)) {
        return { merged: true, sha: MERGED_SHA, message: 'Pull Request successfully merged' };
      }
      return fail('unexpected PUT ' + requestPath);
    },
    patch: async () => fail('unexpected PATCH'),
    delete: async (requestPath) => {
      calls.push({ method: 'delete', path: requestPath });
      return {};
    },
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
  exec.spawn = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  exec.start = exec;
  const fileSystem = {
    readFile: async () => {
      throw new Error('ENOENT');
    },
    readFileBinary: async () => {
      throw new Error('ENOENT');
    },
    writeFile: async () => {},
    stat: async () => {
      throw new Error('ENOENT');
    },
    readDir: async () => {
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
  const relativeModules = {
    './pr-watch-filter.js': () => _prWatchFilterMod.default || _prWatchFilterMod,
    './assign-field.js': () => _assignFieldMod.default || _assignFieldMod,
    './pr-edit.js': () => _prEditMod.default || _prEditMod,
  };
  const realRequire = createRequire(target);
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (Object.hasOwn(relativeModules, id)) return relativeModules[id]();
    return realRequire(id);
  };
  const mockProcess = {
    argv: ['node', target, ...args],
    // Zero poll delays unless a test sets its own schedule.
    env: { GH_MERGE_POLL_DELAYS_MS: '0', ...(scenario.env || {}) },
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

const R = ['-R', 'octo/repo'];
const ASYNC_PUT = '/repos/octo/repo/pulls/42/merge-async';

function asyncPuts(result) {
  return result.calls.filter((c) => c.method === 'put' && c.path === ASYNC_PUT);
}
function syncPuts(result) {
  return result.calls.filter(
    (c) => c.method === 'put' && c.path === '/repos/octo/repo/pulls/42/merge'
  );
}
function pollCalls(result) {
  return result.calls.filter((c) => c.method === 'get' && /\/merge-async\//.test(c.path));
}
function gql(result, op) {
  return result.calls.filter(
    (c) => c.path === '/graphql' && new RegExp(op).test(c.options.body.query)
  );
}
function out(result) {
  return result.stdout.join('\n');
}
function err(result) {
  return result.stderr.join('\n');
}

// ─── merge-async request body ────────────────────────────────────────────────

test('plain pr merge sends merge-async with the resolved head sha and merge_action default', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R]);
  is(result.error, undefined);
  const pull = result.calls.find((c) => c.path === '/repos/octo/repo/pulls/42');
  ok(pull, 'the head is resolved before the request');
  const put = asyncPuts(result);
  is(put.length, 1);
  is(put[0].options.body, { sha: HEAD, merge_action: 'default' });
  is(syncPuts(result), [], 'the synchronous merge is not used');
  is(gql(result, '.'), [], 'no GraphQL on the plain path');
});

test('pr merge maps --squash, --subject and --body onto the request', async () => {
  const result = await runGh(
    ['pr', 'merge', '42', '--squash', '--subject', 'T', '--body', 'B', ...R],
    {}
  );
  is(asyncPuts(result)[0].options.body, {
    sha: HEAD,
    merge_action: 'default',
    merge_method: 'squash',
    commit_title: 'T',
    commit_message: 'B',
  });
});

test('pr merge --merge-action passes direct_merge and merge_queue through', async () => {
  for (const action of ['direct_merge', 'merge_queue']) {
    const result = await runGh(['pr', 'merge', '42', '--merge-action', action, ...R]);
    is(asyncPuts(result)[0].options.body, { sha: HEAD, merge_action: action });
  }
});

test('pr merge --merge-action rejects an unknown value before any API call', async () => {
  const result = await runGh(['pr', 'merge', '42', '--merge-action', 'yolo', ...R]);
  is(result.error.name, 'NodeExitError');
  ok(/--merge-action must be one of default, direct_merge, merge_queue/.test(result.error.message));
  is(result.calls, []);
});

test('pr merge --admin sets bypass_rules and merges directly, as upstream --admin does', async () => {
  const result = await runGh(['pr', 'merge', '42', '--admin', ...R]);
  is(asyncPuts(result)[0].options.body, {
    sha: HEAD,
    merge_action: 'direct_merge',
    bypass_rules: true,
  });
  const queued = await runGh([
    'pr',
    'merge',
    '42',
    '--admin',
    '--merge-action',
    'merge_queue',
    ...R,
  ]);
  is(asyncPuts(queued)[0].options.body, {
    sha: HEAD,
    merge_action: 'merge_queue',
    bypass_rules: true,
  });
});

test('pr merge --match-head-commit refuses a moved head before the request', async () => {
  const result = await runGh(['pr', 'merge', '42', '--match-head-commit', MOVED, ...R]);
  is(result.error.name, 'NodeExitError');
  ok(/refusing — PR #42 head is 1111111/.test(result.error.message), result.error.message);
  is(asyncPuts(result), []);
});

test('pr merge --match-head-commit with a matching prefix sends the full head sha', async () => {
  const result = await runGh(['pr', 'merge', '42', '--match-head-commit', HEAD.slice(0, 7), ...R]);
  is(result.error, undefined);
  is(asyncPuts(result)[0].options.body.sha, HEAD);
});

// ─── responses and polling ───────────────────────────────────────────────────

test('202 pending: polls the uuid and prints merged with the merge commit', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], {
    polls: [pending(), pending(), merged],
  });
  is(result.error, undefined);
  const polled = pollCalls(result);
  is(polled.length, 3);
  is(polled[0].path, `/repos/octo/repo/pulls/42/merge-async/${UUID}`);
  ok(new RegExp(`Merged PR #42 — merge commit ${MERGED_SHA}`).test(out(result)), out(result));
});

test('202 then enqueued: reports the queue, not a merge, and exits 0', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], { polls: [enqueued] });
  is(result.error, undefined);
  ok(/PR #42 is in the merge queue — not merged yet/.test(out(result)), out(result));
  ok(!/Merged PR/.test(out(result)));
});

test('202 then failed: prints the failure message and exits 1', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], { polls: [failed] });
  is(result.error.exitCode, 1);
  ok(
    /Merge failed for PR #42: Merge conflict: the pull request could not be merged\./.test(
      out(result)
    )
  );
});

test('200 already merged: reports the merge commit without polling', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], {
    putResult: {
      status: 'merged',
      details: { message: 'Pull request is already merged.', sha: MERGED_SHA },
    },
  });
  is(result.error, undefined);
  is(pollCalls(result), []);
  ok(/Merged PR #42 — merge commit 3333333/.test(out(result)));
  ok(/already merged/.test(out(result)));
});

test('200 already in the queue: reports enqueued without polling', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], {
    putResult: {
      status: 'enqueued',
      details: { message: 'Pull request is already in the merge queue.' },
    },
  });
  is(result.error, undefined);
  is(pollCalls(result), []);
  ok(/in the merge queue — not merged yet/.test(out(result)));
});

test('409: adopts the pending request uuid and polls it instead of duplicating', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], {
    putError: {
      status: 409,
      body: pending(OTHER_UUID, {
        message: 'A merge request already exists for this pull request.',
        merge_method: 'squash',
        expected_head_sha: MOVED,
      }),
    },
    polls: [merged],
  });
  is(result.error, undefined);
  is(asyncPuts(result).length, 1, 'no second request');
  is(pollCalls(result)[0].path, `/repos/octo/repo/pulls/42/merge-async/${OTHER_UUID}`);
  ok(new RegExp(`already pending for PR #42: ${OTHER_UUID}`).test(out(result)), out(result));
  ok(/pending request expects head 2222222, the PR head is now 1111111/.test(err(result)));
});

test('400: not mergeable is reported with the API message and nothing is polled', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], {
    putError: {
      status: 400,
      body: { status: 'failed', details: { message: 'Pull request is closed.' } },
    },
  });
  is(result.error.name, 'NodeExitError');
  ok(/PR #42 cannot be merged: Pull request is closed\./.test(result.error.message));
  is(pollCalls(result), []);
});

test('404 on merge-async for an existing PR names the --sync fallback', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], {
    putError: { status: 404, body: { message: 'Not Found' } },
  });
  is(result.error.name, 'NodeExitError');
  ok(/async merge API is not available on this host/.test(result.error.message));
  ok(/--sync/.test(result.error.message));
  is(syncPuts(result), [], 'no automatic fallback');
});

test('timeout: a request still pending prints the uuid and how to check it, exit 8', async () => {
  const result = await runGh(['pr', 'merge', '42', '--timeout', '0.03', ...R], {
    polls: [pending()],
    env: { GH_MERGE_POLL_DELAYS_MS: '5' },
  });
  is(result.error.exitCode, 8);
  const n = pollCalls(result).length;
  ok(n >= 1 && n <= 6, 'bounded number of polls, got ' + n);
  ok(
    new RegExp(`Merge request ${UUID} for PR #42 is still pending`).test(out(result)),
    out(result)
  );
  ok(new RegExp(`gh pr merge-status 42 ${UUID} --wait -R octo/repo`).test(out(result)));
});

test('--timeout 0 does not poll and prints the uuid', async () => {
  const result = await runGh(['pr', 'merge', '42', '--timeout', '0', ...R]);
  is(result.error.exitCode, 8);
  is(pollCalls(result), []);
  ok(new RegExp(`gh pr merge-status 42 ${UUID}`).test(out(result)));
});

test('--delete-branch runs after a merge and is skipped while only enqueued', async () => {
  const done = await runGh(['pr', 'merge', '42', '-d', ...R], { polls: [merged] });
  ok(
    done.calls.some((c) => c.method === 'delete'),
    'branch deleted after merge'
  );
  const queued = await runGh(['pr', 'merge', '42', '-d', ...R], { polls: [enqueued] });
  is(
    queued.calls.filter((c) => c.method === 'delete'),
    []
  );
  ok(/--delete-branch skipped/.test(err(queued)));
});

// ─── --auto ──────────────────────────────────────────────────────────────────

test('--auto on a merge-queue branch sends merge-async default with the GraphQL head', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    gqlPr: gqlPr({ isMergeQueueEnabled: true }),
    polls: [enqueued],
  });
  is(result.error, undefined);
  is(asyncPuts(result)[0].options.body, { sha: HEAD, merge_action: 'default' });
  is(gql(result, 'enablePullRequestAutoMerge'), []);
});

test('--auto without a queue on a mergeable PR merges now (upstream semantics)', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    gqlPr: gqlPr({ mergeStateStatus: 'CLEAN' }),
  });
  is(result.error, undefined);
  is(asyncPuts(result)[0].options.body, { sha: HEAD, merge_action: 'direct_merge' });
  is(gql(result, 'enablePullRequestAutoMerge'), []);
});

test('--auto without a queue on a blocked PR enables auto-merge via GraphQL', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', '--squash', ...R]);
  is(result.error, undefined);
  const en = gql(result, 'enablePullRequestAutoMerge');
  is(en.length, 1);
  is(en[0].options.body.variables, {
    input: { pullRequestId: 'PR_node42', expectedHeadOid: HEAD, mergeMethod: 'SQUASH' },
  });
  is(asyncPuts(result), []);
  ok(/automatically merged via squash when all requirements are met/.test(out(result)));
});

test('--auto surfaces a repository that disallows auto-merge verbatim', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    enableAuto: { errors: [{ message: 'Auto merge is not allowed for this repository' }] },
  });
  is(result.error.name, 'NodeExitError');
  ok(/GraphQL error: Auto merge is not allowed for this repository/.test(result.error.message));
});

// Upstream gh (cli/cli pkg/cmd/pr/merge/merge.go, v2.96.0) rejects any two of
// these with exactly this message; review comment 4166720388 on #464.
const ONLY_ONE = 'pr merge: specify only one of `--auto`, `--disable-auto`, or `--admin`';

for (const pair of [
  ['--admin', '--auto'],
  ['--admin', '--disable-auto'],
  ['--auto', '--disable-auto'],
]) {
  test(`pr merge rejects ${pair.join(' ')} with the upstream message, before any API call`, async () => {
    const result = await runGh(['pr', 'merge', '42', ...pair, ...R], {
      gqlPr: gqlPr({
        isInMergeQueue: true,
        autoMergeRequest: { enabledAt: '2026-10-02T12:00:00Z', mergeMethod: 'MERGE' },
      }),
    });
    is(result.error && result.error.name, 'NodeExitError');
    is(result.error.message, ONLY_ONE);
    is(result.error.exitCode, 1);
    is(result.calls, [], 'no read and no mutation');
  });
}

test('other conflicting flags are rejected before any API call', async () => {
  const cases = [
    [['--auto', '--merge-action', 'direct_merge'], /--auto chooses the merge action itself/],
    [['--sync', '--admin'], /--sync .* cannot be combined with --admin/],
  ];
  for (const [flags, re] of cases) {
    const result = await runGh(['pr', 'merge', '42', ...flags, ...R]);
    is(result.error.name, 'NodeExitError');
    ok(re.test(result.error.message), result.error.message);
    is(result.calls, []);
  }
});

// ─── --disable-auto (GraphQL; no REST equivalent) ────────────────────────────

test('--disable-auto dequeues a queued PR by its node id', async () => {
  const result = await runGh(['pr', 'merge', '42', '--disable-auto', ...R], {
    gqlPr: gqlPr({ isInMergeQueue: true, mergeQueueEntry: { position: 3, state: 'QUEUED' } }),
  });
  is(result.error, undefined);
  is(gql(result, 'dequeuePullRequest')[0].options.body.variables, { id: 'PR_node42' });
  is(asyncPuts(result), []);
  ok(/Removed PR #42 from the merge queue for main/.test(out(result)));
});

test('--disable-auto disables auto-merge, or does nothing when neither is on', async () => {
  const on = await runGh(['pr', 'merge', '42', '--disable-auto', ...R], {
    gqlPr: gqlPr({ autoMergeRequest: { enabledAt: '2026-10-02T12:00:00Z', mergeMethod: 'MERGE' } }),
  });
  is(gql(on, 'disablePullRequestAutoMerge')[0].options.body.variables, { id: 'PR_node42' });
  const off = await runGh(['pr', 'merge', '42', '--disable-auto', ...R]);
  is(gql(off, 'Pull(Request)?(AutoMerge)?\\(input'), []);
  ok(/nothing to disable/.test(out(off)));
});

// ─── --sync (explicit opt-in only) ───────────────────────────────────────────

test('--sync uses the synchronous REST merge, still pinned to the head sha', async () => {
  const result = await runGh(['pr', 'merge', '42', '--sync', '--rebase', ...R]);
  is(result.error, undefined);
  is(asyncPuts(result), []);
  is(syncPuts(result)[0].options.body, { sha: HEAD, merge_method: 'rebase' });
  ok(/Merged PR #42 \(synchronous\)/.test(out(result)));
});

// ─── pr merge-status (shim-only) ─────────────────────────────────────────────

test('pr merge-status reads a request by uuid', async () => {
  const result = await runGh(['pr', 'merge-status', '42', UUID, ...R], { polls: [merged] });
  is(result.error, undefined);
  is(pollCalls(result).length, 1);
  is(pollCalls(result)[0].path, `/repos/octo/repo/pulls/42/merge-async/${UUID}`);
  ok(/Merged PR #42 — merge commit 3333333/.test(out(result)));
});

test('pr merge-status --json prints the API result and keeps the exit code', async () => {
  const result = await runGh(['pr', 'merge-status', '42', UUID, '--json', ...R], {
    polls: [pending()],
  });
  is(result.error.exitCode, 8);
  is(JSON.parse(out(result)), pending());
  const st = await runGh(['pr', 'merge-status', '42', UUID, '--json', 'status', ...R], {
    polls: [enqueued],
  });
  is(st.error, undefined);
  is(JSON.parse(out(st)), { status: 'enqueued' });
});

test('pr merge-status --wait polls until the request leaves pending', async () => {
  const result = await runGh(['pr', 'merge-status', '42', UUID, '--wait', ...R], {
    polls: [pending(), pending(), enqueued],
  });
  is(result.error, undefined);
  is(pollCalls(result).length, 3);
  ok(/in the merge queue — not merged yet/.test(out(result)));
});

test('pr merge-status explains an unknown or expired uuid (404)', async () => {
  const result = await runGh(['pr', 'merge-status', '42', UUID, ...R], {
    pollError: { status: 404, body: { message: 'Not Found' } },
  });
  is(result.error.exitCode, 1);
  ok(/the uuid is wrong, or the result expired \(results are kept 24 h/.test(result.error.message));
});

test('pr merge-status requires a uuid', async () => {
  const result = await runGh(['pr', 'merge-status', '42', ...R]);
  is(result.error.name, 'NodeExitError');
  ok(/merge request uuid required/.test(result.error.message));
  is(result.calls, []);
});

// ─── pr queue (shim-only, GraphQL read) ──────────────────────────────────────

const QUEUE = {
  url: 'https://github.com/octo/repo/queue/main',
  entries: {
    totalCount: 2,
    nodes: [
      {
        position: 2,
        state: 'QUEUED',
        enqueuedAt: '2026-10-02T12:05:00Z',
        estimatedTimeToMerge: 600,
        pullRequest: { number: 43, title: 'Second', url: 'https://github.com/octo/repo/pull/43' },
        headCommit: { oid: MOVED },
      },
      {
        position: 1,
        state: 'AWAITING_CHECKS',
        enqueuedAt: '2026-10-02T12:00:00Z',
        estimatedTimeToMerge: null,
        pullRequest: { number: 42, title: 'First', url: 'https://github.com/octo/repo/pull/42' },
        headCommit: { oid: HEAD },
      },
    ],
  },
};

test('pr queue --json lists entries in position order with head commit', async () => {
  const result = await runGh(['pr', 'queue', 'main', '--json', ...R], { queue: QUEUE });
  is(result.error, undefined);
  is(gql(result, 'mergeQueue\\(branch')[0].options.body.variables, {
    owner: 'octo',
    name: 'repo',
    branch: 'main',
  });
  is(JSON.parse(out(result)), [
    {
      position: 1,
      state: 'AWAITING_CHECKS',
      number: 42,
      title: 'First',
      url: 'https://github.com/octo/repo/pull/42',
      headCommit: { oid: HEAD },
      enqueuedAt: '2026-10-02T12:00:00Z',
      estimatedTimeToMerge: null,
    },
    {
      position: 2,
      state: 'QUEUED',
      number: 43,
      title: 'Second',
      url: 'https://github.com/octo/repo/pull/43',
      headCommit: { oid: MOVED },
      enqueuedAt: '2026-10-02T12:05:00Z',
      estimatedTimeToMerge: 600,
    },
  ]);
});

test('pr queue --json fields restricts the output', async () => {
  const result = await runGh(['pr', 'queue', 'main', '--json', 'number,state,position', ...R], {
    queue: QUEUE,
  });
  is(JSON.parse(out(result)), [
    { number: 42, state: 'AWAITING_CHECKS', position: 1 },
    { number: 43, state: 'QUEUED', position: 2 },
  ]);
});

test('pr queue defaults to the repository default branch', async () => {
  const result = await runGh(['pr', 'queue', '--json', ...R], { queue: QUEUE });
  is(gql(result, 'mergeQueue\\(branch')[0].options.body.variables.branch, 'trunk');
});

test('pr queue exits 1 when the branch has no merge queue', async () => {
  const result = await runGh(['pr', 'queue', 'main', ...R], { queue: null });
  is(result.error.exitCode, 1);
  ok(/octo\/repo has no merge queue on main/.test(result.error.message));
});

test('pr queue human output shows position, state and PR', async () => {
  const result = await runGh(['pr', 'queue', 'main', ...R], { queue: QUEUE });
  ok(/1 {2}AWAITING_CHECKS +#42 {2}First/.test(out(result)), out(result));
  ok(/2 {2}QUEUED +#43 {2}Second/.test(out(result)), out(result));
});

// ─── help ────────────────────────────────────────────────────────────────────

test('pr merge --help documents the async merge flags', async () => {
  const result = await runGh(['pr', 'merge', '--help']);
  is(result.error.exitCode, 0);
  const help = out(result);
  for (const flag of [
    '--merge-action',
    '--auto',
    '--disable-auto',
    '--admin',
    '--timeout',
    '--sync',
  ]) {
    ok(help.includes(flag), 'help mentions ' + flag);
  }
  ok(/merge-async/.test(help));
});

test('pr merge-status and pr queue --help mark the commands as shim-only', async () => {
  for (const sub of ['merge-status', 'queue']) {
    const result = await runGh(['pr', sub, '--help']);
    is(result.error.exitCode, 0);
    ok(/Not in the real GitHub CLI/.test(out(result)), sub);
  }
});
