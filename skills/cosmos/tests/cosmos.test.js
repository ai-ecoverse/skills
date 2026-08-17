// Behaviour tests for scripts/cosmos.jsh:
//
//   node --test skills/cosmos/tests/cosmos.test.js
//
// The runtime stub below follows skills/search/tests/jsh-runtime.js: compile the
// script body as an AsyncFunction, resolve require('sliccy:*') to stubs, map
// cli.die / cli.help / process.exit onto an exit code, and record every request
// for assertions. It is inlined rather than shared because this repo has no
// common test harness yet, and Cosmos needs one thing search does not: a
// sliccy:browser stub, since Cosmos auth is a session cookie and every call goes
// through browser.fetch inside a logged-in tab.
//
// Response fixtures are trimmed copies of real shapes captured on 2026-08-17.
// They prove argument handling, request bodies, id resolution, rendering and
// exit codes. They prove nothing about the live service.

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cosmos.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const RPC = 'https://cosmos.augmentcode.com/rpc/';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

/**
 * Run cosmos.jsh.
 *
 * opts.tab      is the tab browser.findTab resolves to (null = no Cosmos tab open)
 * opts.handler  is (method, body, url, n) => fixture; see normalizeResponse
 * opts.uuids    is the sequence crypto.randomUUID() hands out
 *
 * Returns { exitCode, stdout, stderr, calls, findTabCalls }.
 */
async function runCosmos(argv, opts = {}) {
  const src = readFileSync(SCRIPT, 'utf8');
  const stdout = [];
  const stderr = [];
  const calls = [];
  const findTabCalls = [];
  const tab = opts.tab === undefined ? { targetId: 'TAB1' } : opts.tab;
  const uuids = (opts.uuids || ['uuid-1', 'uuid-2', 'uuid-3']).slice();
  const fmtArg = (v) => (typeof v === 'string' ? v : JSON.stringify(v));

  const proc = {
    argv: ['node', SCRIPT, ...argv],
    env: {},
    cwd: () => '/workspace',
    exit(code = 0) {
      throw new NodeExitError(code);
    },
    stdout: { isTTY: false },
    stderr: { isTTY: false },
  };

  const cons = {
    log: (...a) => stdout.push(a.map(fmtArg).join(' ')),
    info: (...a) => stdout.push(a.map(fmtArg).join(' ')),
    warn: (...a) => stderr.push(a.map(fmtArg).join(' ')),
    error: (...a) => stderr.push(a.map(fmtArg).join(' ')),
  };

  // Non-TTY: sliccy:color is a set of identity functions.
  const color = new Proxy({}, { get: () => (s) => String(s) });

  const cli = {
    die(msg, o = {}) {
      const prefix = o.prefix === undefined ? 'Error' : o.prefix;
      stderr.push(prefix === '' ? String(msg) : `${prefix}: ${msg}`);
      throw new NodeExitError(o.exitCode === undefined ? 1 : o.exitCode);
    },
    out(value) {
      stdout.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
    warn(msg) {
      stderr.push(`Warning: ${msg}`);
    },
    help(text) {
      stdout.push(text);
      throw new NodeExitError(0);
    },
  };

  const browser = {
    async findTab(query) {
      findTabCalls.push(query);
      return tab;
    },
    async fetch(t, url, init = {}) {
      assert.equal(t, tab, 'browser.fetch must use the tab findTab returned');
      const method = String(url).slice(String(url).lastIndexOf('/') + 1);
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ url: String(url), method, init, body });
      if (!opts.handler) throw new Error(`unexpected request to ${url}`);
      return normalizeResponse(await opts.handler(method, body, String(url), calls.length));
    },
  };

  const req = (name) => {
    if (name === 'sliccy:cli') return cli;
    if (name === 'sliccy:color') return color;
    if (name === 'sliccy:browser') return browser;
    throw new Error(`jsh stub: unsupported require(${name})`);
  };

  const cryptoStub = {
    randomUUID: () => uuids.shift() || 'uuid-exhausted',
    getRandomValues: (a) => a.fill(7),
  };

  const bodyFn = new AsyncFunction(
    'require',
    'process',
    'console',
    'fetch',
    'crypto',
    '__dirname',
    src
  );

  let exitCode = 0;
  try {
    await bodyFn(req, proc, cons, undefined, cryptoStub, path.dirname(SCRIPT));
  } catch (err) {
    if (err && err.name === 'NodeExitError') exitCode = err.code;
    else {
      exitCode = 1;
      stderr.push(String(err && err.stack ? err.stack : err));
    }
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), calls, findTabCalls };
}

/**
 * A fixture may be a plain payload (200 with that JSON object), a string (200
 * with that raw body, which is what a login wall looks like), or
 * { status, body } for full control. browser.fetch hands back
 * { ok, status, body } with body already parsed when it is JSON.
 */
function normalizeResponse(raw) {
  const shaped = raw && typeof raw === 'object' && ('status' in raw || 'body' in raw);
  const res = shaped ? raw : { body: raw };
  const status = res.status === undefined ? 200 : res.status;
  return { ok: status >= 200 && status < 300, status, body: res.body };
}

/** Route by RPC method name; anything unrouted fails the test. */
function route(map) {
  return (method) => {
    if (!(method in map)) throw new Error(`unexpected RPC ${method}`);
    return map[method];
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const PR_AUTHOR_ID = '87db6bd0-4fbc-4620-94e9-0da28169183b';
const PR_AUTHOR_2_ID = 'e59ab3f8-a39e-4635-b5a2-09882ed50e82';
const REVIEWER_ID = '4dc61de5-b491-4617-9b0f-be7a9a378d6d';
const ECOVERSE_ID = 'e6117b1e-a264-4537-8e87-f7dd3a524a5c';
const AGENT_ID = '01M07QQF8ZPWVGG1TWEWCK9S9W';

const WRITE_KEY = 'jvDOhU1pQjDwqGdGCErllL5qoAiedMJe';

const IS_AUTH = { authenticated: true, homeCosmosHostname: 'cosmos.augmentcode.com' };
const BOOT_CONFIG = {
  segment: {
    writeKey: WRITE_KEY,
    scriptUrl: 'https://evs.example/x.js',
    cdn: 'https://evs.example',
  },
  authCentralBaseUrl: 'https://auth.augmentcode.com',
};

// ListExpertsWithUsage groups experts, and the same expert appears twice.
const EXPERTS = {
  recentlyUsed: [
    {
      expert: {
        expertId: PR_AUTHOR_ID,
        scope: 'EXPERT_SCOPE_TENANT',
        slug: 'pr-author-github-2z4hvjvghl',
        config: {
          name: 'PR Author (GitHub)',
          description: 'Owns a GitHub PR from open through merge.',
          sessionConfig: { model: 'gpt-5-6-sol' },
        },
      },
      lastUsedAt: '2026-08-17T11:29:22.841159Z',
    },
    {
      expert: {
        expertId: REVIEWER_ID,
        slug: 'deep-code-reviewer-td75yp4gj5',
        config: {
          name: 'Deep Code Reviewer',
          description: 'Non-interactive line-by-line bug review.',
          sessionConfig: { model: 'claude-opus-5' },
          vmConfig: { baseImageId: 'b5f4e056-ef37-490b-9f38-dbb7e05eff22' },
        },
      },
      lastUsedAt: '2026-08-06T17:43:20.090483Z',
    },
  ],
  popular: [
    {
      expert: {
        expertId: PR_AUTHOR_2_ID,
        slug: 'pr-author-github-9kk2zz1abc',
        config: { name: 'PR Author (GitHub)', sessionConfig: { model: 'gpt-5-6-sol' } },
      },
    },
  ],
  other: [
    { expert: { expertId: REVIEWER_ID, config: { name: 'Deep Code Reviewer' } } },
    {
      expert: {
        expertId: '285eafff-1261-423b-9bb0-065584880fa3',
        slug: 'personal-assistant-qq11',
        config: { name: 'Personal Assistant' },
      },
    },
  ],
};

const ENVIRONMENTS = {
  environments: [
    {
      id: ECOVERSE_ID,
      kind: 'ENVIRONMENT_KIND_BASE_IMAGE',
      displayName: 'AI Ecoverse',
      description: 'Bash, Typescript, and Chrome, gh CLI, ffmpeg, jq',
      status: 'IMAGE_STATUS_ACTIVE',
      currentVersion: 'v20260817-073414.943959004-ae8bec39',
    },
    {
      id: 'b5f4e056-ef37-490b-9f38-dbb7e05eff22',
      kind: 'ENVIRONMENT_KIND_BASE_IMAGE',
      displayName: 'staging',
      status: 'IMAGE_STATUS_ACTIVE',
    },
    {
      id: 'pool-11465981-f13c-4b71-8e93-db84f4b6b719',
      kind: 'ENVIRONMENT_KIND_DAEMON_POOL',
      displayName: 'daemon-pool',
    },
  ],
  totalCount: 3,
};

const AGENTS = {
  agents: [
    {
      agentId: AGENT_ID,
      agentName: 'Implement Directory Symlinks Removal in VFS',
      status: 'AGENT_STATUS_PROCESSING',
      createdAt: '2026-08-17T11:29:22.827876715Z',
      updatedAt: '2026-08-17T11:29:25.805623534Z',
      sessionConfig: { model: 'gpt-5-6-sol', visibility: 'SESSION_VISIBILITY_SHARED' },
      expertId: PR_AUTHOR_ID,
      environmentId: ECOVERSE_ID,
      capabilities: ['AGENT_CAPABILITY_WEB_ACCESS', 'AGENT_CAPABILITY_GITHUB'],
      workspaceFolders: ['/workspace/ai-ecoverse/slicc'],
      tags: [`expert:${PR_AUTHOR_ID}`],
    },
    {
      agentId: '01M07GA2SCC1PJ8S7ABGJ6H4VN',
      agentName: 'Implement Slicc Issue 2137',
      status: 'AGENT_STATUS_IDLE',
      createdAt: '2026-08-17T10:15:00.000000000Z',
      sessionConfig: { model: 'claude-opus-5' },
    },
  ],
  totalCount: 285,
  hasMore: true,
  nextPageToken: 'Chow0MUta',
};

const BUILD_LOG = `first line of build output\n${'x'.repeat(5000)}`;
const THINKING = `**Clarifying URL issues**\n${'t'.repeat(3000)}`;

const MESSAGES = {
  messages: [
    {
      id: '4ca38820-user',
      role: 'user',
      createdAt: '2026-08-17T10:22:44.738806Z',
      content: [
        {
          toolResult: {
            toolUseId: 'call_RiuFbcdz2Ffzee9TDNNGJOI0',
            content: BUILD_LOG,
            isError: false,
          },
        },
      ],
      metadata: { requestId: '4ca38820' },
    },
    {
      id: '4ca38820-assistant',
      role: 'assistant',
      createdAt: '2026-08-17T10:22:45.000000Z',
      content: [
        { thinking: { content: THINKING } },
        { toolUse: { id: 'call_Vff', name: 'read', input: '{"path": "/workspace/lick-urls.ts"}' } },
        { text: 'I will fix the expected path in the test.' },
      ],
      metadata: { requestId: '4ca38820', tokenUsage: { outputTokens: 114 } },
    },
  ],
  hasMore: true,
  agentStatus: 'AGENT_STATUS_IDLE',
  firstMessageId: '4ca38820-user',
  lastMessageId: '4ca38820-assistant',
};

const MODELS = {
  default_model: '9c199f09053b637dd66d9fe1454467b6de40ce10344042674b7f34c9cb69f440',
  models: [
    { name: '45c2c5c9bae4f0cb4a0efef0b66ca6d7e2a9035724adebca415e8f2d05657144', is_default: true },
    { name: '27839f16c68e2366428cb39002b98550ffcd3df67ec9508b525a76db3ca6e844' },
  ],
};

const CREATED = {
  agent: {
    agentId: '01M07ZZZZZZZZZZZZZZZZZZZZZ',
    agentName: 'Fix the flaky VFS test',
    status: 'AGENT_STATUS_STARTING',
    capabilities: ['AGENT_CAPABILITY_WEB_ACCESS', 'AGENT_CAPABILITY_GITHUB'],
    createdAt: '2026-08-17T12:00:00Z',
    tags: [`expert:${PR_AUTHOR_ID}`],
  },
};

const readRoutes = {
  IsAuthenticated: IS_AUTH,
  GetBootConfig: BOOT_CONFIG,
  ListExpertsWithUsage: EXPERTS,
  ListEnvironments: ENVIRONMENTS,
  ListAgents: AGENTS,
  GetAgent: { agent: AGENTS.agents[0], vmErrorInfo: { vmStatus: 'RUNNING' } },
  GetMessages: MESSAGES,
  GetModels: MODELS,
  CreateAgentFromExpert: CREATED,
};

const all = () => route(readRoutes);
const created = (calls) => calls.filter((c) => c.method === 'CreateAgentFromExpert');

// ── help is side-effect free ─────────────────────────────────────────────────

test('--help prints usage, exits 0, and touches nothing', async () => {
  const r = await runCosmos(['--help']);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /cosmos delegate/);
  assert.equal(r.calls.length, 0, 'help must not issue a request');
  assert.equal(r.findTabCalls.length, 0, 'help must not even look for a tab');
});

test('no arguments prints usage instead of guessing a command', async () => {
  const r = await runCosmos([]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /USAGE/);
  assert.equal(r.calls.length, 0);
});

test('per-command help is scoped and still side-effect free', async () => {
  const d = await runCosmos(['delegate', '--help']);
  assert.equal(d.exitCode, 0);
  assert.match(d.stdout, /cosmos delegate - create a session from an expert/);
  assert.match(d.stdout, /--confirm/);
  assert.equal(d.calls.length, 0, 'delegate --help must not create anything');

  const m = await runCosmos(['help', 'messages']);
  assert.equal(m.exitCode, 0);
  assert.match(m.stdout, /limit counts exchanges/);
  assert.equal(m.calls.length, 0);
});

test('an unknown command fails with a pointer to --help', async () => {
  const r = await runCosmos(['frobnicate']);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
  assert.equal(r.calls.length, 0);
});

// ── flag parsing ─────────────────────────────────────────────────────────────

test('a boolean flag before a positional does not swallow it', async () => {
  const r = await runCosmos(['messages', '--json', AGENT_ID], { handler: all() });
  assert.equal(r.exitCode, 0);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].body.agentId, AGENT_ID);
});

test('--confirm before the prompt does not swallow the prompt', async () => {
  const r = await runCosmos(
    ['delegate', '--confirm', 'Fix the flaky VFS test', '--expert', PR_AUTHOR_ID],
    { handler: all() }
  );
  assert.equal(r.exitCode, 0);
  const posts = created(r.calls);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.initial_message, 'Fix the flaky VFS test');
});

test('bare positionals after delegate join into one prompt', async () => {
  const r = await runCosmos(
    ['delegate', 'fix', 'the', 'flaky', 'test', '--expert', PR_AUTHOR_ID, '--confirm'],
    { handler: all() }
  );
  assert.equal(created(r.calls)[0].body.initial_message, 'fix the flaky test');
});

test('-- ends flag parsing so a prompt may start with a dash', async () => {
  const r = await runCosmos(
    ['delegate', '--expert', PR_AUTHOR_ID, '--confirm', '--', '--not-a-flag please'],
    { handler: all() }
  );
  assert.equal(created(r.calls)[0].body.initial_message, '--not-a-flag please');
});

test('--limit takes a value, is clamped, and rejects non-numbers', async () => {
  const three = await runCosmos(['agents', '--limit', '3'], { handler: all() });
  assert.deepEqual(three.calls[0].body, { limit: 3 });

  const hi = await runCosmos(['agents', '--limit=900'], { handler: all() });
  assert.deepEqual(hi.calls[0].body, { limit: 100 }, 'clamped to the observed server max');

  const lo = await runCosmos(['agents', '--limit', '0'], { handler: all() });
  assert.deepEqual(lo.calls[0].body, { limit: 1 });

  const bad = await runCosmos(['agents', '--limit', 'lots'], { handler: all() });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /--limit expects a number/);
});

test('a value flag left without a value fails loudly', async () => {
  const r = await runCosmos(['delegate', 'do a thing', '--expert', '--json'], { handler: all() });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--expert expects a value/);
  assert.equal(created(r.calls).length, 0);
});

// ── request bodies ───────────────────────────────────────────────────────────

test('every read command posts JSON to the documented rpc path', async () => {
  const r = await runCosmos(['agents', '--limit', '2'], { handler: all() });
  const call = r.calls[0];
  assert.equal(call.url, `${RPC}web_rpc_proxy.PoseidonProxyService/ListAgents`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.equal(typeof call.init.body, 'string', 'the body is serialized explicitly');
});

test('me asks the boot service twice and nothing else', async () => {
  const r = await runCosmos(['me'], { handler: all() });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(
    r.calls.map((c) => c.method),
    ['IsAuthenticated', 'GetBootConfig']
  );
  assert.deepEqual(r.calls[0].body, {});
});

test('agents defaults to a bounded limit rather than the 1.2 MB full page', async () => {
  const r = await runCosmos(['agents'], { handler: all() });
  assert.deepEqual(r.calls[0].body, { limit: 20 });
});

test('agent and messages send the id the caller passed', async () => {
  const a = await runCosmos(['agent', AGENT_ID], { handler: all() });
  assert.equal(a.calls[0].url, `${RPC}web_rpc_proxy.PoseidonProxyService/GetAgent`);
  assert.deepEqual(a.calls[0].body, { agentId: AGENT_ID });

  const m = await runCosmos(['messages', AGENT_ID, '--limit', '2'], { handler: all() });
  assert.deepEqual(m.calls[0].body, { agentId: AGENT_ID, limit: 2 });
});

test('experts, environments and models post an empty message', async () => {
  const e = await runCosmos(['experts'], { handler: all() });
  assert.equal(e.calls[0].url, `${RPC}web_rpc_proxy.ExpertProxyService/ListExpertsWithUsage`);
  assert.deepEqual(e.calls[0].body, {});

  const v = await runCosmos(['environments'], { handler: all() });
  assert.equal(v.calls[0].url, `${RPC}web_rpc_proxy.PoseidonProxyService/ListEnvironments`);

  const f = await runCosmos(['folders'], { handler: all() });
  assert.equal(f.calls[0].method, 'ListEnvironments', 'folders is an alias');

  const m = await runCosmos(['models'], { handler: all() });
  assert.equal(m.calls[0].url, `${RPC}public_api.Augment/GetModels`);
});

test('a malformed agent id is rejected before any request', async () => {
  const r = await runCosmos(['agent', 'not-an-id'], { handler: all() });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /invalid agent id/);
  assert.equal(r.calls.length, 0);
});

// ── response mapping ─────────────────────────────────────────────────────────

test('agents renders name, id, status and the total count', async () => {
  const r = await runCosmos(['agents'], { handler: all() });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Implement Directory Symlinks Removal in VFS/);
  assert.match(r.stdout, new RegExp(`id:${AGENT_ID}`));
  assert.match(r.stdout, /processing/, 'AGENT_STATUS_ prefix is stripped');
  assert.match(r.stdout, /showing 2 of 285/);
  assert.match(r.stdout, /More sessions exist/, 'hasMore is surfaced');
});

test('--json passes the raw response through untouched', async () => {
  const r = await runCosmos(['agents', '--json'], { handler: all() });
  assert.deepEqual(JSON.parse(r.stdout), AGENTS);
});

test('agent detail shows the session url so the id can be chained', async () => {
  const r = await runCosmos(['agent', AGENT_ID], { handler: all() });
  assert.match(r.stdout, new RegExp(`session\\?agentId=${AGENT_ID}`));
  assert.match(r.stdout, /gpt-5-6-sol/);
  assert.match(r.stdout, /shared/, 'SESSION_VISIBILITY_ prefix is stripped');
});

test('experts de-duplicates across recentlyUsed / popular / other', async () => {
  const r = await runCosmos(['experts'], { handler: all() });
  const hits = r.stdout.match(/Deep Code Reviewer/g) || [];
  assert.equal(hits.length, 1, 'the same expertId must be listed once');
  assert.match(r.stdout, /\(4\)/, 'four distinct experts across three groups');
  assert.match(r.stdout, /slug:pr-author-github-2z4hvjvghl/);
});

test('messages summarises tool output instead of dumping it', async () => {
  const r = await runCosmos(['messages', AGENT_ID], { handler: all() });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /tool-result:/);
  assert.match(r.stdout, /call_RiuFbcdz2Ffzee/);
  assert.match(r.stdout, /first line of build output/);
  assert.match(r.stdout, /thinking:/);
  assert.match(r.stdout, /tool-use: read/);
  assert.match(r.stdout, /I will fix the expected path in the test\./, 'text parts print');
  assert.ok(!r.stdout.includes('x'.repeat(200)), 'the 5 KB tool result body is not dumped');
  assert.ok(!r.stdout.includes('t'.repeat(200)), 'the 3 KB thinking block is not dumped');
  assert.ok(r.stdout.length < 2000, `human transcript stayed small (${r.stdout.length} chars)`);
  assert.match(r.stdout, /older messages exist/);
});

test('messages --full prints the whole tool result', async () => {
  const r = await runCosmos(['messages', AGENT_ID, '--full'], { handler: all() });
  assert.ok(r.stdout.includes('x'.repeat(5000)), '--full must change behaviour');
  assert.ok(r.stdout.includes('t'.repeat(3000)));
});

test('models labels the hashes and points at experts for session model ids', async () => {
  const r = await runCosmos(['models'], { handler: all() });
  assert.match(r.stdout, /9c199f09053b637dd66d9fe1454467b6de40ce10344042674b7f34c9cb69f440/);
  assert.match(r.stdout, /opaque completion-model hashes/);
});

test('me never prints the analytics write key', async () => {
  const human = await runCosmos(['me'], { handler: all() });
  assert.equal(human.exitCode, 0);
  assert.ok(!human.stdout.includes(WRITE_KEY));
  assert.match(human.stdout, /write key not shown/);

  const json = await runCosmos(['me', '--json'], { handler: all() });
  assert.equal(json.exitCode, 0);
  const data = JSON.parse(json.stdout);
  assert.equal(data.bootConfig.segment.writeKey, '[redacted]');
  assert.ok(!json.stdout.includes(WRITE_KEY));
});

test('me exits non-zero when the session is not authenticated, json included', async () => {
  const handler = route({ ...readRoutes, IsAuthenticated: { authenticated: false } });
  const human = await runCosmos(['me'], { handler });
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /not authenticated/);

  const json = await runCosmos(['me', '--json'], { handler });
  assert.equal(json.exitCode, 1, 'exit code must survive --json');
});

// ── expert and environment resolution ────────────────────────────────────────

test('an expert uuid needs no lookup at all', async () => {
  const r = await runCosmos(['delegate', 'do the thing', '--expert', PR_AUTHOR_ID], {
    handler: all(),
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.calls.length, 0, 'a uuid short-circuits ListExpertsWithUsage');
  assert.match(r.stdout, new RegExp(PR_AUTHOR_ID));
});

test('a unique expert name resolves to its id', async () => {
  const r = await runCosmos(['delegate', 'review this', '--expert', 'Deep Code Reviewer'], {
    handler: all(),
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(
    r.calls.map((c) => c.method),
    ['ListExpertsWithUsage']
  );
  assert.match(r.stdout, new RegExp(`"expertId": "${REVIEWER_ID}"`));
});

test('an expert slug resolves, and so does a unique substring', async () => {
  const bySlug = await runCosmos(
    ['delegate', 'x', '--expert', 'pr-author-github-9kk2zz1abc'],
    { handler: all() }
  );
  assert.match(bySlug.stdout, new RegExp(`"expertId": "${PR_AUTHOR_2_ID}"`));

  const bySubstring = await runCosmos(['delegate', 'x', '--expert', 'personal assist'], {
    handler: all(),
  });
  assert.match(bySubstring.stdout, /285eafff-1261-423b-9bb0-065584880fa3/);
});

test('an ambiguous expert name lists the candidates and creates nothing', async () => {
  const r = await runCosmos(
    ['delegate', 'ship it', '--expert', 'PR Author (GitHub)', '--confirm'],
    { handler: all() }
  );
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /matches 2 experts by name/);
  assert.match(r.stderr, new RegExp(PR_AUTHOR_ID));
  assert.match(r.stderr, new RegExp(PR_AUTHOR_2_ID));
  assert.match(r.stderr, /Pass an id to disambiguate/);
  assert.equal(created(r.calls).length, 0, 'ambiguity must never fall through to a write');
});

test('an unknown expert name is an error, not a silent default', async () => {
  const r = await runCosmos(['delegate', 'x', '--expert', 'Nobody Home', '--confirm'], {
    handler: all(),
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no expert matches "Nobody Home"/);
  assert.equal(created(r.calls).length, 0);
});

test('an environment name becomes override_vm_config.base_image_id', async () => {
  const r = await runCosmos(
    ['delegate', 'x', '--expert', PR_AUTHOR_ID, '--env', 'AI Ecoverse', '--confirm'],
    { handler: all() }
  );
  assert.equal(r.exitCode, 0);
  const body = created(r.calls)[0].body;
  assert.deepEqual(body.override_vm_config, { base_image_id: ECOVERSE_ID });
  assert.ok(!('resources' in body.override_vm_config), 'resources only on request');
});

test('an ambiguous environment substring is rejected', async () => {
  const r = await runCosmos(['delegate', 'x', '--expert', PR_AUTHOR_ID, '--env', 'a'], {
    handler: all(),
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /matches \d+ environments by substring/);
});

test('--cpu and --memory add resources, and need --env', async () => {
  const ok = await runCosmos(
    [
      'delegate',
      'x',
      '--expert',
      PR_AUTHOR_ID,
      '--env',
      ECOVERSE_ID,
      '--cpu',
      '0.125',
      '--memory',
      '2048',
      '--confirm',
    ],
    { handler: all() }
  );
  assert.deepEqual(created(ok.calls)[0].body.override_vm_config, {
    base_image_id: ECOVERSE_ID,
    resources: { cpuCores: 0.125, memoryMib: 2048 },
  });

  const orphan = await runCosmos(['delegate', 'x', '--expert', PR_AUTHOR_ID, '--cpu', '1'], {
    handler: all(),
  });
  assert.equal(orphan.exitCode, 1);
  assert.match(orphan.stderr, /--cpu and --memory only apply together with --env/);
});

// ── delegate: the mutation gate ──────────────────────────────────────────────

test('delegate without --confirm sends no write and exits 0', async () => {
  const r = await runCosmos(['delegate', 'Fix the flaky VFS test', '--expert', PR_AUTHOR_ID], {
    handler: all(),
  });
  assert.equal(r.exitCode, 0);
  assert.equal(created(r.calls).length, 0, 'dry run must not create a session');
  assert.match(r.stdout, /Delegate \(dry run\)/);
  assert.match(r.stdout, /nothing was sent/);
  assert.match(r.stdout, /Re-run with --confirm/);
  assert.match(r.stdout, /"initial_message": "Fix the flaky VFS test"/);
  assert.match(r.stdout, /CreateAgentFromExpert/, 'the preview names the endpoint');
});

test('delegate --json --confirm-less emits a machine-readable preview', async () => {
  const r = await runCosmos(
    ['delegate', 'Fix the flaky VFS test', '--expert', PR_AUTHOR_ID, '--json'],
    { handler: all() }
  );
  assert.equal(r.exitCode, 0);
  const preview = JSON.parse(r.stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.method, 'POST');
  assert.equal(
    preview.endpoint,
    `${RPC}web_rpc_proxy.ExpertProxyService/CreateAgentFromExpert`
  );
  assert.equal(preview.body.expertId, PR_AUTHOR_ID);
  assert.equal(created(r.calls).length, 0);
});

test('delegate --confirm posts exactly one request with the captured field names', async () => {
  const r = await runCosmos(
    ['delegate', 'Fix the flaky VFS test', '--expert', PR_AUTHOR_ID, '--confirm'],
    { handler: all(), uuids: ['idem-uuid', 'req-uuid'] }
  );
  assert.equal(r.exitCode, 0);
  const posts = created(r.calls);
  assert.equal(posts.length, 1, 'exactly one write, no retry loop');
  assert.equal(posts[0].url, `${RPC}web_rpc_proxy.ExpertProxyService/CreateAgentFromExpert`);
  assert.equal(posts[0].init.method, 'POST');

  // Field naming is reproduced from the capture: camelCase next to snake_case.
  assert.deepEqual(Object.keys(posts[0].body), [
    'expertId',
    'agentName',
    'idempotency_key',
    'initial_message',
    'initial_message_request_id',
  ]);
  assert.deepEqual(posts[0].body, {
    expertId: PR_AUTHOR_ID,
    agentName: 'Fix the flaky VFS test',
    idempotency_key: 'idem-uuid',
    initial_message: 'Fix the flaky VFS test',
    initial_message_request_id: 'req-uuid',
  });
  assert.match(r.stdout, /Session created/);
  assert.match(r.stdout, /01M07ZZZZZZZZZZZZZZZZZZZZZ/);
});

test('the two idempotency uuids are distinct and generated per call', async () => {
  const first = await runCosmos(
    ['delegate', 'x', '--expert', PR_AUTHOR_ID, '--confirm'],
    { handler: all(), uuids: ['a-1', 'a-2'] }
  );
  const second = await runCosmos(
    ['delegate', 'x', '--expert', PR_AUTHOR_ID, '--confirm'],
    { handler: all(), uuids: ['b-1', 'b-2'] }
  );
  const one = created(first.calls)[0].body;
  const two = created(second.calls)[0].body;
  assert.notEqual(one.idempotency_key, one.initial_message_request_id);
  assert.notEqual(one.idempotency_key, two.idempotency_key);
});

test('override_model and override_visibility are only sent when asked for', async () => {
  const plain = await runCosmos(['delegate', 'x', '--expert', PR_AUTHOR_ID, '--confirm'], {
    handler: all(),
  });
  const plainBody = created(plain.calls)[0].body;
  assert.ok(!('override_model' in plainBody), "the expert's own model applies by default");
  assert.ok(!('override_visibility' in plainBody));
  assert.ok(
    !('override_builtin_capabilities' in plainBody) &&
      !('has_override_builtin_capabilities' in plainBody),
    'capabilities are never overridden, see references/api.md'
  );

  const explicit = await runCosmos(
    [
      'delegate',
      'x',
      '--expert',
      PR_AUTHOR_ID,
      '--model',
      'claude-opus-5',
      '--visibility',
      'private',
      '--confirm',
    ],
    { handler: all() }
  );
  const body = created(explicit.calls)[0].body;
  assert.equal(body.override_model, 'claude-opus-5');
  assert.equal(body.override_visibility, 'SESSION_VISIBILITY_PRIVATE');

  const bad = await runCosmos(
    ['delegate', 'x', '--expert', PR_AUTHOR_ID, '--visibility', 'world'],
    { handler: all() }
  );
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /--visibility must be shared or private/);
});

test('agentName is the first line of the prompt, capped at 100 chars', async () => {
  const long = `${'A'.repeat(130)}\nsecond line`;
  const r = await runCosmos(['delegate', long, '--expert', PR_AUTHOR_ID, '--confirm'], {
    handler: all(),
  });
  const body = created(r.calls)[0].body;
  assert.equal(body.agentName.length, 100);
  assert.equal(body.agentName, 'A'.repeat(100));
  assert.equal(body.initial_message, long, 'the full prompt still goes out');
});

test('delegate requires a prompt and an expert', async () => {
  const noPrompt = await runCosmos(['delegate', '--expert', PR_AUTHOR_ID], { handler: all() });
  assert.equal(noPrompt.exitCode, 1);
  assert.match(noPrompt.stderr, /usage: cosmos delegate/);

  const noExpert = await runCosmos(['delegate', 'do a thing'], { handler: all() });
  assert.equal(noExpert.exitCode, 1);
  assert.match(noExpert.stderr, /--expert is required/);
  assert.equal(noExpert.calls.length, 0);
});

// ── failures ─────────────────────────────────────────────────────────────────

test('no Cosmos tab is an actionable error before any request', async () => {
  const r = await runCosmos(['agents'], { tab: null, handler: all() });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no Cosmos tab found/);
  assert.match(r.stderr, /cosmos\.augmentcode\.com/);
  assert.equal(r.calls.length, 0);
  assert.deepEqual(r.findTabCalls.length, 1);
});

test('the tab is matched by url, not by bare domain', async () => {
  const r = await runCosmos(['agents'], { handler: all() });
  const query = r.findTabCalls[0];
  assert.ok(query.urlMatch instanceof RegExp);
  assert.ok(query.urlMatch.test('https://cosmos.augmentcode.com/session?agentId=01M0'));
});

test('a 500 exits non-zero with the method and status, in json mode too', async () => {
  const boom = route({ ...readRoutes, ListAgents: { status: 500, body: { message: 'boom' } } });
  const human = await runCosmos(['agents'], { handler: boom });
  assert.equal(human.exitCode, 1);
  assert.match(human.stderr, /ListAgents failed with 500: boom/);

  const json = await runCosmos(['agents', '--json'], { handler: boom });
  assert.equal(json.exitCode, 1);
  assert.equal(json.stdout, '', 'no half-written json on failure');
});

test('401 and 403 say the session expired', async () => {
  for (const status of [401, 403]) {
    const r = await runCosmos(['agents'], {
      handler: route({ ...readRoutes, ListAgents: { status, body: '' } }),
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /session expired/);
  }
});

test('an html login wall is translated, not JSON.parse-crashed', async () => {
  const r = await runCosmos(['agents'], {
    handler: route({ ...readRoutes, ListAgents: '<!DOCTYPE html><html>login</html>' }),
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /session expired/);
  assert.ok(!r.stderr.includes('JSON.parse'));
});

test('a string json body from the bridge is parsed, not rejected', async () => {
  const r = await runCosmos(['agents', '--json'], {
    handler: route({ ...readRoutes, ListAgents: JSON.stringify(AGENTS) }),
  });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(JSON.parse(r.stdout), AGENTS);
});

test('a write that fails exits non-zero and reports the method', async () => {
  const r = await runCosmos(['delegate', 'x', '--expert', PR_AUTHOR_ID, '--confirm'], {
    handler: route({
      ...readRoutes,
      CreateAgentFromExpert: { status: 400, body: { message: 'expert not found' } },
    }),
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /CreateAgentFromExpert failed with 400: expert not found/);
});
