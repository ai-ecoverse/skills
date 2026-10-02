import test, { fail, is, ok } from 'tst';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as _prWatchFilterMod from '../scripts/pr-watch-filter.js';
import * as _assignFieldMod from '../scripts/assign-field.js';
import * as _prEditMod from '../scripts/pr-edit.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `gh pr merge` merge-queue routing (--auto, --disable-auto, --admin,
// --match-head-commit) and the shim-only `gh pr queue`. The GitHub API is
// mocked: GraphQL calls are routed by the operation they contain, so each test
// can assert exactly which mutation ran and with which variables.

const target = path.resolve(__dirname, '../scripts/gh.jsh');
const source = fs.readFileSync(target, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const HEAD = '1111111111111111111111111111111111111111';
const MOVED = '2222222222222222222222222222222222222222';

class NodeExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = exitCode;
  }
}

function prState(overrides = {}) {
  return {
    id: 'PR_node42',
    number: 42,
    state: 'OPEN',
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

const QUEUE_RULES = [
  { type: 'deletion', ruleset_id: 14315416 },
  { type: 'merge_queue', parameters: { merge_method: 'MERGE' }, ruleset_id: 14315416 },
  { type: 'required_status_checks', ruleset_id: 14315416 },
];

function graphqlReply(scenario, query) {
  if (/enqueuePullRequest/.test(query)) {
    return (
      scenario.enqueue || {
        data: {
          enqueuePullRequest: {
            mergeQueueEntry: {
              id: 'MQE_1',
              position: 2,
              state: 'AWAITING_CHECKS',
              enqueuedAt: '2026-10-02T12:00:00Z',
              headCommit: { oid: HEAD },
            },
          },
        },
      }
    );
  }
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
    return {
      data: { repository: { mergeQueue: scenario.queue === undefined ? null : scenario.queue } },
    };
  }
  if (/pullRequest\(number/.test(query)) {
    if (scenario.prErrors)
      return { data: { repository: { pullRequest: null } }, errors: scenario.prErrors };
    return { data: { repository: { pullRequest: scenario.pr || prState() } } };
  }
  return fail('unexpected GraphQL operation: ' + query);
}

async function runGh(args, scenario = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const api = {
    get: async (requestPath, options) => {
      calls.push({ method: 'get', path: requestPath, options });
      if (/\/rules\/branches\//.test(requestPath)) {
        if (scenario.rulesError) throw scenario.rulesError;
        return scenario.rules || [];
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
      return { merged: true, message: 'Pull Request successfully merged' };
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

// GraphQL calls whose query contains `op`.
function gql(result, op) {
  return result.calls.filter(
    (c) => c.path === '/graphql' && new RegExp(op).test(c.options.body.query)
  );
}

const MUTATIONS =
  'enqueuePullRequest|dequeuePullRequest|enablePullRequestAutoMerge|disablePullRequestAutoMerge';

function mutations(result) {
  return gql(result, MUTATIONS);
}

function puts(result) {
  return result.calls.filter((c) => c.method === 'put');
}

const R = ['-R', 'octo/repo'];

// ─── merge-queue branch ──────────────────────────────────────────────────────

test('pr merge --auto on a merge-queue branch enqueues with node id and expectedHeadOid', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], { rules: QUEUE_RULES });
  is(result.error, undefined);
  const rulesCall = result.calls.find((c) => /\/rules\/branches\//.test(c.path));
  is(rulesCall.path, '/repos/octo/repo/rules/branches/main');
  const enq = gql(result, 'enqueuePullRequest');
  is(enq.length, 1);
  is(enq[0].options.body.variables, { id: 'PR_node42', oid: HEAD });
  ok(/expectedHeadOid: \$oid/.test(enq[0].options.body.query), 'mutation passes expectedHeadOid');
  is(mutations(result).length, 1, 'no auto-merge mutation');
  is(puts(result), []);
});

test('pr merge on a merge-queue branch prints the entry position and state', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], { rules: QUEUE_RULES });
  const out = result.stdout.join('\n');
  ok(/Added PR #42 to the merge queue for main — position 2, state AWAITING_CHECKS/.test(out), out);
  ok(/https:\/\/github\.com\/octo\/repo\/queue\/main/.test(out), out);
});

test('plain pr merge on a merge-queue branch enqueues instead of the REST merge', async () => {
  const result = await runGh(['pr', 'merge', '42', ...R], { rules: QUEUE_RULES });
  is(result.error, undefined);
  is(gql(result, 'enqueuePullRequest').length, 1);
  is(puts(result), [], 'the queue rejects the REST merge, so it must not be issued');
});

test('pr merge on a merge-queue branch warns that the strategy flag is ignored', async () => {
  const result = await runGh(['pr', 'merge', '42', '--squash', ...R], { rules: QUEUE_RULES });
  is(gql(result, 'enqueuePullRequest').length, 1);
  ok(/merge strategy for main is set by the merge queue/.test(result.stderr.join('\n')));
});

test('pr merge --delete-branch on a merge-queue branch is refused before any mutation', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', '-d', ...R], { rules: QUEUE_RULES });
  is(result.error.name, 'NodeExitError');
  ok(/cannot use -d\/--delete-branch when the merge queue is enabled/.test(result.error.message));
  is(mutations(result), []);
  is(
    result.calls.filter((c) => c.method === 'delete'),
    []
  );
});

test('pr merge on a PR already in the queue reports its entry and does not re-enqueue', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    rules: QUEUE_RULES,
    pr: prState({ isInMergeQueue: true, mergeQueueEntry: { position: 1, state: 'MERGEABLE' } }),
  });
  is(result.error, undefined);
  is(mutations(result), []);
  ok(
    /already queued to merge into main — position 1, state MERGEABLE/.test(result.stdout.join('\n'))
  );
});

test('pr merge surfaces the enqueue error verbatim when the head moved after the read', async () => {
  // Mocked error text: the live message was not observed (no real PR was enqueued).
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    rules: QUEUE_RULES,
    enqueue: { errors: [{ message: 'Expected head OID does not match the pull request head' }] },
  });
  is(result.error.name, 'NodeExitError');
  ok(
    /GraphQL error: Expected head OID does not match the pull request head/.test(
      result.error.message
    )
  );
  is(gql(result, 'enqueuePullRequest')[0].options.body.variables.oid, HEAD);
  is(puts(result), []);
});

test('pr merge --match-head-commit refuses a moved head before any mutation', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', '--match-head-commit', MOVED, ...R], {
    rules: QUEUE_RULES,
  });
  is(result.error.name, 'NodeExitError');
  ok(/refusing — PR #42 head is 1111111/.test(result.error.message), result.error.message);
  is(mutations(result), []);
  is(puts(result), []);
});

test('pr merge --admin bypasses queue routing and issues the REST merge', async () => {
  const result = await runGh(['pr', 'merge', '42', '--admin', ...R], { rules: QUEUE_RULES });
  is(result.error, undefined);
  is(mutations(result), []);
  is(puts(result).length, 1);
  is(
    result.calls.filter((c) => /\/rules\/branches\//.test(c.path)),
    [],
    'rules are not read under --admin'
  );
});

test('pr merge falls back to isMergeQueueEnabled when the rules read fails', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    rulesError: { status: 403, body: { message: 'Resource not accessible' } },
    pr: prState({ isMergeQueueEnabled: true }),
  });
  is(result.error, undefined);
  is(gql(result, 'enqueuePullRequest').length, 1);
  ok(
    /could not read branch rules for main \(Resource not accessible\)/.test(
      result.stderr.join('\n')
    )
  );
});

// ─── no merge queue ──────────────────────────────────────────────────────────

test('pr merge --auto without a queue enables auto-merge with the chosen method', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', '--squash', ...R], { rules: [] });
  is(result.error, undefined);
  is(gql(result, 'enqueuePullRequest'), []);
  const en = gql(result, 'enablePullRequestAutoMerge');
  is(en.length, 1);
  is(en[0].options.body.variables, {
    input: { pullRequestId: 'PR_node42', mergeMethod: 'SQUASH', expectedHeadOid: HEAD },
  });
  is(puts(result), []);
  ok(
    /automatically merged via squash when all requirements are met/.test(result.stdout.join('\n'))
  );
});

test('pr merge --auto surfaces a repo that does not allow auto-merge verbatim', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    rules: [],
    enableAuto: { errors: [{ message: 'Auto merge is not allowed for this repository' }] },
  });
  is(result.error.name, 'NodeExitError');
  ok(/GraphQL error: Auto merge is not allowed for this repository/.test(result.error.message));
  is(puts(result), []);
});

test('pr merge --auto merges now when the PR is already mergeable (upstream semantics)', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', ...R], {
    rules: [],
    pr: prState({ mergeStateStatus: 'CLEAN' }),
  });
  is(result.error, undefined);
  is(mutations(result), []);
  is(puts(result).length, 1);
});

test('plain pr merge without a queue keeps the REST merge', async () => {
  const result = await runGh(['pr', 'merge', '42', '--rebase', ...R], { rules: [] });
  is(result.error, undefined);
  is(mutations(result), []);
  const put = puts(result);
  is(put.length, 1);
  is(put[0].path, '/repos/octo/repo/pulls/42/merge');
  is(put[0].options.body, { merge_method: 'rebase' });
});

test('pr merge --match-head-commit pins the REST merge to the full head sha', async () => {
  const result = await runGh(['pr', 'merge', '42', '--match-head-commit', HEAD.slice(0, 7), ...R], {
    rules: [],
  });
  is(result.error, undefined);
  is(puts(result)[0].options.body, { merge_method: 'merge', sha: HEAD });
});

test('pr merge reports a missing PR with the GraphQL message', async () => {
  const result = await runGh(['pr', 'merge', '999', ...R], {
    prErrors: [
      { type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 999.' },
    ],
  });
  is(result.error.name, 'NodeExitError');
  ok(/Could not resolve to a PullRequest with the number of 999\./.test(result.error.message));
  is(mutations(result), []);
  is(puts(result), []);
});

// ─── --disable-auto ──────────────────────────────────────────────────────────

test('pr merge --disable-auto dequeues a queued PR by its node id', async () => {
  const result = await runGh(['pr', 'merge', '42', '--disable-auto', ...R], {
    pr: prState({ isInMergeQueue: true, mergeQueueEntry: { position: 3, state: 'QUEUED' } }),
  });
  is(result.error, undefined);
  const dq = gql(result, 'dequeuePullRequest');
  is(dq.length, 1);
  is(dq[0].options.body.variables, { id: 'PR_node42' });
  is(mutations(result).length, 1);
  ok(/Removed PR #42 from the merge queue for main/.test(result.stdout.join('\n')));
});

test('pr merge --disable-auto disables auto-merge when the PR is not queued', async () => {
  const result = await runGh(['pr', 'merge', '42', '--disable-auto', ...R], {
    pr: prState({ autoMergeRequest: { enabledAt: '2026-10-02T12:00:00Z', mergeMethod: 'MERGE' } }),
  });
  is(result.error, undefined);
  const dis = gql(result, 'disablePullRequestAutoMerge');
  is(dis.length, 1);
  is(dis[0].options.body.variables, { id: 'PR_node42' });
  is(mutations(result).length, 1);
});

test('pr merge --disable-auto with nothing enabled makes no mutation', async () => {
  const result = await runGh(['pr', 'merge', '42', '--disable-auto', ...R]);
  is(result.error, undefined);
  is(mutations(result), []);
  ok(/nothing to disable/.test(result.stdout.join('\n')));
});

test('pr merge rejects --auto together with --disable-auto', async () => {
  const result = await runGh(['pr', 'merge', '42', '--auto', '--disable-auto', ...R]);
  is(result.error.name, 'NodeExitError');
  ok(/mutually exclusive/.test(result.error.message));
  is(result.calls, []);
});

// ─── pr queue (shim-only) ────────────────────────────────────────────────────

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
  const q = gql(result, 'mergeQueue\\(branch');
  is(q[0].options.body.variables, { owner: 'octo', name: 'repo', branch: 'main' });
  is(mutations(result), []);
  const entries = JSON.parse(result.stdout.join('\n'));
  is(entries, [
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
  is(JSON.parse(result.stdout.join('\n')), [
    { number: 42, state: 'AWAITING_CHECKS', position: 1 },
    { number: 43, state: 'QUEUED', position: 2 },
  ]);
});

test('pr queue defaults to the repository default branch', async () => {
  const result = await runGh(['pr', 'queue', '--json', ...R], { queue: QUEUE });
  is(result.error, undefined);
  is(gql(result, 'mergeQueue\\(branch')[0].options.body.variables.branch, 'trunk');
});

test('pr queue exits 1 when the branch has no merge queue', async () => {
  const result = await runGh(['pr', 'queue', 'main', ...R], { queue: null });
  is(result.error.name, 'NodeExitError');
  is(result.error.exitCode, 1);
  ok(/octo\/repo has no merge queue on main/.test(result.error.message));
});

test('pr queue human output shows position, state and PR', async () => {
  const result = await runGh(['pr', 'queue', 'main', ...R], { queue: QUEUE });
  const out = result.stdout.join('\n');
  ok(/1 {2}AWAITING_CHECKS +#42 {2}First/.test(out), out);
  ok(/2 {2}QUEUED +#43 {2}Second/.test(out), out);
});

// ─── help ────────────────────────────────────────────────────────────────────

test('pr merge --help documents the merge-queue flags', async () => {
  const result = await runGh(['pr', 'merge', '--help']);
  is(result.error.exitCode, 0);
  const help = result.stdout.join('\n');
  for (const flag of ['--auto', '--disable-auto', '--admin', '--match-head-commit']) {
    ok(help.includes(flag), 'help mentions ' + flag);
  }
  ok(/gh pr queue/.test(help));
});

test('pr queue --help marks the command as shim-only', async () => {
  const result = await runGh(['pr', 'queue', '--help']);
  is(result.error.exitCode, 0);
  ok(/Not in the real GitHub CLI/.test(result.stdout.join('\n')));
});
