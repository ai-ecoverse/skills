// Tests for the `app` manifest subcommands of skills/slack/scripts/slack-ext.jsh
//
// Run with:
//   tst <path-to-this-file>
//
// Same strategy as slack-ext.test.js: compile the REAL source (dropping the
// trailing `await main()` so it does not auto-execute), inject mock sliccy:*
// modules, and call the real internal functions. Nothing here reimplements
// production logic — a copied diff engine would silently diverge from the one
// that ships and then prove nothing.
//
// Everything is offline. The App Manifest API is never contacted: the sliccy:http
// client is stubbed and records every request, which is also how the tests prove
// that no code path can reach apps.manifest.create or apps.manifest.delete.
//
// The mutation matrix verified against these tests is recorded at the bottom.

import test, { is, ok, not, fail } from 'tst';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as _argvMod from '../scripts/argv.js';
import * as _manifestDiffMod from '../scripts/manifest-diff.js';
import * as _gridMod from '../scripts/slack-ext-grid.js';

const SCRIPT = fileURLToPath(new URL('../scripts/slack-ext.jsh', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The exact manifest observed live on 2026-09-18: 14 leaf fields, 709 bytes.
// Used as the live-export fixture everywhere below.
const LIVE_MANIFEST = {
  display_information: {
    name: 'AEM Ops Automation',
    description:
      'Channel naming and membership governance notices for the AEM support workspace.',
    background_color: '#d32600',
  },
  features: {
    bot_user: { display_name: 'AEM Ops Automation', always_online: false },
  },
  oauth_config: {
    scopes: {
      bot: [
        'channels:manage',
        'channels:read',
        'chat:write',
        'im:write',
        'users:read',
        'users:read.email',
      ],
    },
    pkce_enabled: false,
  },
  settings: {
    event_subscriptions: {
      request_url: 'https://slack-automation-relay.adobeaem.workers.dev',
      bot_events: ['channel_created', 'team_join'],
    },
    org_deploy_enabled: false,
    socket_mode_enabled: false,
    token_rotation_enabled: false,
    app_level_token_rotation_enabled: false,
    is_mcp_enabled: false,
  },
};

const APP_ID = 'A0123456789';
const TEST_TOKEN = 'xoxe.xoxp-test-config-token';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class NodeExitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = code !== undefined ? code : 1;
  }
}

/**
 * Load slack-ext.jsh with mocked dependencies.
 *
 * @param {object}  opts
 * @param {string[]} opts.argv        argv words after the script path
 * @param {object}  [opts.live]       manifest returned by apps.manifest.export
 * @param {object}  [opts.responses]  method -> response body overrides
 * @param {number}  [opts.status]     HTTP status the stub reports (default 200)
 * @param {object}  [opts.files]      path -> file contents for the fs stub
 * @param {string|null} [opts.token]  value of $SLACK_APP_CONFIG_TOKEN (null = unset)
 * @param {object}  [opts.config]     skill.config() return value
 * @param {string|null} [opts.refreshToken] value of $SLACK_APP_REFRESH_TOKEN
 * @param {boolean} [opts.configWriteFails] make skill.config(patch) throw
 */
async function load(opts) {
  const options = opts || {};
  const httpCalls = [];
  const writes = [];
  const browserUses = [];
  const configWrites = [];
  // One ordered timeline of every observable side effect, so ordering invariants
  // (persist-before-anything-else on token-rotate) can be asserted.
  const events = [];
  const stdout = [];
  const stderr = [];

  const live = options.live ? clone(options.live) : clone(LIVE_MANIFEST);

  function defaultResponse(method) {
    if (method === 'apps.manifest.export') return { ok: true, manifest: live };
    if (method === 'apps.manifest.validate') return { ok: true, errors: [] };
    if (method === 'apps.manifest.update') return { ok: true, permissions_updated: false };
    if (method === 'tooling.tokens.rotate') {
      return {
        ok: true,
        token: 'xoxe.xoxp-rotated-access-token',
        refresh_token: 'xoxe-1-rotated-refresh-token',
        team_id: 'T06DUTYDQ',
        iat: 1789000000,
        exp: 1789043200,
      };
    }
    return { ok: false, error: 'not_mocked' };
  }

  const httpStub = {
    client(clientOpts) {
      return {
        async post(reqPath, postOpts) {
          const method = String(reqPath).replace(/^\//, '');
          const bodyText =
            postOpts && typeof postOpts.body === 'string' ? postOpts.body : '';
          const params = {};
          for (const [k, v] of new URLSearchParams(bodyText)) params[k] = v;
          httpCalls.push({
            method,
            baseUrl: clientOpts && clientOpts.baseUrl,
            token:
              clientOpts && typeof clientOpts.token === 'function'
                ? clientOpts.token()
                : clientOpts && clientOpts.token,
            hasTokenConfig: Boolean(clientOpts && clientOpts.token),
            headers: (postOpts && postOpts.headers) || {},
            body: bodyText,
            params,
            raw: Boolean(postOpts && postOpts.raw),
          });
          events.push({ type: 'http', method: method });
          const responses = options.responses || {};
          const body = Object.prototype.hasOwnProperty.call(responses, method)
            ? responses[method]
            : defaultResponse(method);
          return { status: options.status || 200, headers: {}, body };
        },
      };
    },
  };

  // The app commands use a bearer app configuration token over plain HTTPS. If
  // one of them ever reaches for the Slack tab (i.e. falls back to the xoxc
  // session token), these stubs record it and the call throws.
  const browserStub = {
    async findTab() {
      browserUses.push('findTab');
      throw new Error('app commands must not use the browser session');
    },
    async localStorage() {
      browserUses.push('localStorage');
      throw new Error('app commands must not read the xoxc token');
    },
    async fetch() {
      browserUses.push('fetch');
      throw new Error('app commands must not use browser.fetch');
    },
  };

  const cliStub = {
    die(message, _options) {
      throw new NodeExitError(String(message), 1);
    },
    help(message) {
      stdout.push(String(message));
      throw new NodeExitError('help', 0);
    },
    out(value) {
      stdout.push(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    },
    warn(message) {
      stderr.push(String(message));
    },
  };

  const colorStub = new Proxy(
    {},
    {
      get: () => (s) => String(s),
    }
  );

  const fsStub = {
    async readFile(p) {
      const files = options.files || {};
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      throw new Error('ENOENT: no such file ' + p);
    },
    async writeFile(p, contents) {
      writes.push({ path: p, contents: String(contents) });
    },
  };

  // skill.config() with no argument READS; with a patch it PERSISTS. Both are
  // recorded, the write lands on the shared timeline, and it can be made to fail.
  const skillStub = {
    async config(patch) {
      if (patch === undefined) return options.config || null;
      configWrites.push(patch);
      events.push({ type: 'persist', patch: patch });
      if (options.configWriteFails) throw new Error('EACCES: skill config not writable');
      return patch;
    },
  };

  const mocks = {
    'sliccy:browser': browserStub,
    'sliccy:cli': cliStub,
    'sliccy:color': colorStub,
    'sliccy:http': httpStub,
    'sliccy:skill': skillStub,
    'sliccy:exec': { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    fs: fsStub,
  };

  // Relative specifiers (./argv.js, ./manifest-diff.js, ./slack-ext-grid.js) are
  // pre-loaded via static ESM imports above (the tst realm resolves imports statically
  // but its createRequire shim does not resolve relative file-system paths).
  const relativeModules = {
    './argv.js': () => (_argvMod.default || _argvMod),
    './manifest-diff.js': () => (_manifestDiffMod.default || _manifestDiffMod),
    './slack-ext-grid.js': () => (_gridMod.default || _gridMod)
  };
  const scriptRequire = (id) => {
    const key = id.replace(/^\.\.\/(scripts\/)?/, './');
    if (Object.prototype.hasOwnProperty.call(relativeModules, key)) return relativeModules[key]();
    throw new Error('unexpected relative require(' + id + ') — add a static import');
  };
  const mockRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
    if (id.startsWith('./') || id.startsWith('../')) return scriptRequire(id);
    throw new Error('unexpected require(' + id + ')');
  };

  let source = readFileSync(SCRIPT, 'utf8');
  // Anchor on the actual trailer (`try { await main(); }`), NOT on the first
  // top-level `try {` in the file. The greedy form truncated the module at the
  // first top-level try block, which silently discarded ~1800 lines and made
  // every test fail with '<fn> is not defined'.
  source = source.replace(/\ntry \{\s*\n\s*await main\(\);[\s\S]*$/, '\n');
  source += `
return {
  parseArgv,
  manifestLeaves,
  diffManifests,
  pointerJoin,
  formatLeaf,
  manifestApi,
  getAppConfigToken,
  renderValidationErrors,
  deepClone,
  deepOverlay,
  ensureObjectPath,
  parseList,
  applyAddRemove,
  sameDeletion,
  maskToken,
  updateFromLiveManifest,
  cmdApp,
  cmdAppExport,
  cmdAppShow,
  cmdAppValidate,
  cmdAppDiff,
  cmdAppSetScopes,
  cmdAppSetEvents,
  cmdAppSetRequestUrl,
  cmdAppApply,
  cmdAppTokenRotate,
};
`;

  const env = {};
  if (options.token !== null) {
    env.SLACK_APP_CONFIG_TOKEN = options.token || TEST_TOKEN;
  }
  if (options.refreshToken) {
    env.SLACK_APP_REFRESH_TOKEN = options.refreshToken;
  }

  const mockProcess = {
    argv: ['node', SCRIPT, ...(options.argv || [])],
    env,
    exit: (code) => {
      throw new NodeExitError('exit', code);
    },
  };

  const mockConsole = {
    log: (msg) => {
      const line = String(msg === undefined ? '' : msg);
      stdout.push(line);
      events.push({ type: 'out', line: line });
    },
    error: (msg) => stderr.push(String(msg === undefined ? '' : msg)),
    warn: (msg) => stderr.push(String(msg === undefined ? '' : msg)),
  };

  const factory = new AsyncFunction('require', 'process', 'console', source);
  const mod = await factory(mockRequire, mockProcess, mockConsole);

  return {
    mod,
    httpCalls,
    writes,
    browserUses,
    configWrites,
    events,
    stdout,
    stderr,
    live,
    text: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
    methods: () => httpCalls.map((c) => c.method),
    // Every call that CHANGES something on Slack's side.
    writeCalls: () =>
      httpCalls.filter(
        (c) => c.method === 'apps.manifest.update' || c.method === 'tooling.tokens.rotate'
      ),
    updateCalls: () => httpCalls.filter((c) => c.method === 'apps.manifest.update'),
    // The manifest actually put on the wire, parsed back from the form body.
    sentManifest: () => {
      const call = httpCalls.find((c) => c.method === 'apps.manifest.update');
      ok(call, 'expected an apps.manifest.update call');
      return JSON.parse(call.params.manifest);
    },
  };
}

async function expectDie(fn) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  ok(err, 'expected the command to exit with an error');
  is(err.name, 'NodeExitError', 'expected NodeExitError, got: ' + err.message);
  return err;
}

function pointers(list) {
  return list.map((d) => d.pointer);
}

// ── manifestLeaves: the shape the diff is built on ────────────────────────────

test('manifestLeaves flattens the live fixture to its 14 leaf fields', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  const leaves = h.mod.manifestLeaves(LIVE_MANIFEST, '', {});
  const keys = Object.keys(leaves).sort();
  is(keys.length, 14, 'fixture has 14 leaves, got: ' + keys.join(','));
  ok(keys.includes('/display_information/description'));
  ok(keys.includes('/oauth_config/scopes/bot'));
  ok(keys.includes('/settings/event_subscriptions/bot_events'));
  ok(keys.includes('/settings/is_mcp_enabled'));
  // An array is ONE leaf: apps.manifest.update replaces arrays wholesale.
  is(leaves['/settings/event_subscriptions/bot_events'], [
    'channel_created',
    'team_join',
  ]);
});

test('pointerJoin escapes ~ and / per RFC 6901', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  is(h.mod.pointerJoin('', 'settings'), '/settings');
  is(h.mod.pointerJoin('/a', 'b/c'), '/a/b~1c');
  is(h.mod.pointerJoin('/a', 'b~c'), '/a/b~0c');
});

// ── diff: deletions are the whole point ───────────────────────────────────────

test('diff reports a missing display_information.description as a DELETION', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  delete candidate.display_information.description;

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  is(pointers(diff.deletions), ['/display_information/description']);
  is(diff.deletions[0].value, LIVE_MANIFEST.display_information.description);
  // A deletion must NOT be reported as a modification: omitting a field DELETES
  // it (measured live 2026-09-18), which is a different hazard entirely.
  is(diff.modifications.length, 0, 'must not be counted as a modification');
  is(diff.additions.length, 0);
  is(diff.changed, true);
});

test('diff reports bot_events shrinking 2 -> 1 as a DELETION of the removed entry', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.event_subscriptions.bot_events = ['channel_created'];

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  // The team_join case: arrays are REPLACED WHOLESALE, so a shrunk array is a
  // deletion of the dropped entries — not a modification of the array.
  is(diff.deletions.length, 1);
  is(diff.deletions[0].pointer, '/settings/event_subscriptions/bot_events');
  is(diff.deletions[0].value, 'team_join');
  is(diff.deletions[0].entry, true, 'deletion must be marked as an array entry');
  is(diff.modifications.length, 0, 'array shrinkage is not a modification');
  is(diff.additions.length, 0);
});

test('diff reports a dropped bot scope as a DELETION of that scope entry', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  candidate.oauth_config.scopes.bot = LIVE_MANIFEST.oauth_config.scopes.bot.filter(
    (s) => s !== 'users:read.email'
  );

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  is(diff.deletions.length, 1);
  is(diff.deletions[0].pointer, '/oauth_config/scopes/bot');
  is(diff.deletions[0].value, 'users:read.email');
  is(diff.modifications.length, 0);
});

test('diff on an identical manifest reports NO changes', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const diff = h.mod.diffManifests(LIVE_MANIFEST, clone(LIVE_MANIFEST));
  is(diff.deletions.length, 0);
  is(diff.additions.length, 0);
  is(diff.modifications.length, 0);
  is(diff.changed, false);
});

test('diff separates additions and modifications from deletions', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.socket_mode_enabled = true; // modification
  candidate.settings.event_subscriptions.bot_events.push('app_mention'); // addition
  candidate.display_information.name = 'Renamed App'; // modification

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  is(diff.deletions.length, 0, 'nothing was removed');
  is(pointers(diff.additions), ['/settings/event_subscriptions/bot_events']);
  is(diff.additions[0].value, 'app_mention');
  is(pointers(diff.modifications).sort(), [
    '/display_information/name',
    '/settings/socket_mode_enabled',
  ]);
  const socket = diff.modifications.find((m) => m.pointer === '/settings/socket_mode_enabled');
  is(socket.from, false);
  is(socket.to, true);
});

test('diff reports every stripped leaf of a display_information-only partial manifest', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = { display_information: clone(LIVE_MANIFEST.display_information) };

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  // This payload VALIDATES ok=true against Slack, which is exactly why diff has
  // to enumerate the damage: bot user, all scopes and all events would be gone.
  const ptrs = pointers(diff.deletions);
  ok(ptrs.includes('/features/bot_user/display_name'));
  ok(ptrs.includes('/features/bot_user/always_online'));
  ok(ptrs.includes('/oauth_config/scopes/bot'));
  ok(ptrs.includes('/settings/event_subscriptions/request_url'));
  ok(ptrs.includes('/settings/event_subscriptions/bot_events'));
  ok(ptrs.includes('/settings/is_mcp_enabled'));
  is(diff.deletions.length, 11, 'all 11 non-display_information leaves');
  is(diff.modifications.length, 0);
});

// ── diff rendering ────────────────────────────────────────────────────────────

test('app diff output flags deletions distinctly and warns they would be REMOVED', async () => {
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.event_subscriptions.bot_events = ['channel_created'];
  delete candidate.display_information.description;

  const h = await load({
    argv: ['app', 'diff', APP_ID, '--manifest=/tmp/candidate.json'],
    files: { '/tmp/candidate.json': JSON.stringify(candidate) },
  });
  await h.mod.cmdAppDiff();

  const text = h.text();
  ok(/DELETIONS \(2\)/.test(text), 'deletions must have their own labelled section');
  ok(/- \/display_information\/description/.test(text), 'must match /- \/display_information\/description/');
  ok(/- \/settings\/event_subscriptions\/bot_events/.test(text), 'must match /- \/settings\/event_subscriptions\/bot_events/');
  ok(/team_join/.test(text), 'the dropped array entry must be named');
  ok(/would be DELETED/.test(text), 'must warn loudly about deletions');
  ok(/REPLACED WHOLESALE/.test(text), 'must explain array replacement');
  // The candidate is only ever compared against a fresh live export.
  is(h.methods(), ['apps.manifest.export']);
});

test('app diff on an identical manifest prints no-changes and no deletion warning', async () => {
  const h = await load({
    argv: ['app', 'diff', APP_ID, '--manifest=/tmp/same.json'],
    files: { '/tmp/same.json': JSON.stringify(LIVE_MANIFEST) },
  });
  await h.mod.cmdAppDiff();

  const text = h.text();
  ok(/No changes/i.test(text), 'must match /No changes/i');
  ok(!(/DELETIONS/.test(text)), 'must not match /DELETIONS/');
  ok(!(/would be DELETED/.test(text)), 'must not match /would be DELETED/');
});

test('app diff --json emits separate deletions/additions/modifications buckets', async () => {
  const candidate = clone(LIVE_MANIFEST);
  delete candidate.settings.event_subscriptions.request_url;
  candidate.settings.is_mcp_enabled = true;

  const h = await load({
    argv: ['app', 'diff', APP_ID, '--manifest=/tmp/c.json', '--json'],
    files: { '/tmp/c.json': JSON.stringify(candidate) },
  });
  await h.mod.cmdAppDiff();

  const payload = JSON.parse(h.text());
  is(pointers(payload.deletions), ['/settings/event_subscriptions/request_url']);
  is(pointers(payload.modifications), ['/settings/is_mcp_enabled']);
  is(payload.additions.length, 0);
  is(payload.changed, true);
});

test('app diff notes the measured background_color exception when it is dropped', async () => {
  const candidate = clone(LIVE_MANIFEST);
  delete candidate.display_information.background_color;

  const h = await load({
    argv: ['app', 'diff', APP_ID, '--manifest=/tmp/nobg.json'],
    files: { '/tmp/nobg.json': JSON.stringify(candidate) },
  });
  await h.mod.cmdAppDiff();

  const text = h.text();
  ok(/- \/display_information\/background_color/.test(text), 'must match /- \/display_information\/background_color/');
  ok(/can never be null/.test(text), 'the one measured exception must be called out');
  ok(/do not generalise/i.test(text), 'must match /do not generalise/i');
});

test('app diff without --manifest dies with a usage message and calls nothing', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const err = await expectDie(() => h.mod.cmdAppDiff());
  ok(/--manifest/.test(err.message), 'must match /--manifest/');
  is(h.httpCalls.length, 0, 'no API call before the arguments are valid');
});

// ── show ──────────────────────────────────────────────────────────────────────

test('app show renders all 6 bot scopes and both bot events', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  await h.mod.cmdAppShow();

  const text = h.text();
  for (const scope of LIVE_MANIFEST.oauth_config.scopes.bot) {
    ok(new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text), 'scope ' + scope + ' must appear in output');
  }
  ok(/Bot scopes \(6\)/.test(text), 'must match /Bot scopes \(6\)/');
  ok(/Event subscriptions \(2\)/.test(text), 'must match /Event subscriptions \(2\)/');
  ok(/channel_created/.test(text), 'must match /channel_created/');
  ok(/team_join/.test(text), 'must match /team_join/');
  is(h.methods().length, 1);
  is(h.methods()[0], 'apps.manifest.export');
});

test('app show renders name, bot user, request URL and the notable booleans', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  await h.mod.cmdAppShow();

  const text = h.text();
  ok(/AEM Ops Automation/.test(text), 'must match /AEM Ops Automation/');
  ok(/slack-automation-relay\.adobeaem\.workers\.dev/.test(text), 'must match /slack-automation-relay\.adobeaem\.workers\.dev/');
  ok(/Socket mode/.test(text), 'must match /Socket mode/');
  ok(/Org deploy/.test(text), 'must match /Org deploy/');
  ok(/MCP/.test(text), 'must match /MCP/');
  ok(/PKCE/.test(text), 'must match /PKCE/');
  ok(new RegExp(APP_ID).test(text), 'must match new RegExp(APP_ID)');
});

test('app show handles a manifest with no bot user and no events without crashing', async () => {
  const bare = {
    display_information: { name: 'Bare App' },
    oauth_config: { scopes: {} },
    settings: {},
  };
  const h = await load({ argv: ['app', 'show', APP_ID], live: bare });
  await h.mod.cmdAppShow();

  const text = h.text();
  ok(/Bare App/.test(text), 'must match /Bare App/');
  ok(/Bot scopes \(0\)/.test(text), 'must match /Bot scopes \(0\)/');
  ok(/no bot user/i.test(text), 'must match /no bot user/i');
});

// ── export ────────────────────────────────────────────────────────────────────

test('app export pretty-prints the live manifest', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID] });
  await h.mod.cmdAppExport();

  const parsed = JSON.parse(h.text());
  is(parsed, LIVE_MANIFEST);
  is(h.methods(), ['apps.manifest.export']);
  is(h.writes.length, 0, 'no file written without --out');
});

test('app export --out writes the manifest to the file and reports the leaf count', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID, '--out=/tmp/out.json'] });
  await h.mod.cmdAppExport();

  is(h.writes.length, 1);
  is(h.writes[0].path, '/tmp/out.json');
  is(JSON.parse(h.writes[0].contents), LIVE_MANIFEST);
  ok(/Leaves/.test(h.text()), 'must match /Leaves/');
  ok(/14/.test(h.text()), 'must match /14/');
});

test('app export dies when the response carries no manifest object', async () => {
  const h = await load({
    argv: ['app', 'export', APP_ID],
    responses: { 'apps.manifest.export': { ok: true } },
  });
  const err = await expectDie(() => h.mod.cmdAppExport());
  ok(/no manifest/i.test(err.message), 'must match /no manifest/i');
});

// ── validate ──────────────────────────────────────────────────────────────────

test('app validate renders each error with its JSON pointer', async () => {
  const candidate = clone(LIVE_MANIFEST);
  candidate.oauth_config.scopes.bot.push('this:is:not:a:real:scope');

  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/bad.json'],
    files: { '/tmp/bad.json': JSON.stringify(candidate) },
    responses: {
      // Byte-exact live response captured 2026-09-18: this manifest was posted to
      // apps.manifest.validate with a real app configuration token and Slack
      // answered HTTP 200 with exactly this body (plus a superfluous_charset
      // warning). The top-level error is `invalid_manifest`; the actionable
      // detail is the pointer inside errors[].
      'apps.manifest.validate': {
        ok: false,
        error: 'invalid_manifest',
        errors: [
          {
            code: 'illegal_bot_scopes',
            message: 'Illegal bot scopes found `this:is:not:a:real:scope`',
            pointer: '/oauth_config/scopes/bot',
          },
        ],
      },
    },
  });

  const err = await expectDie(() => h.mod.cmdAppValidate());
  const text = h.text();
  ok(/illegal_bot_scopes/.test(text), 'must match /illegal_bot_scopes/');
  ok(/Illegal bot scopes found/.test(text), 'must match /Illegal bot scopes found/');
  // The pointer is the only thing that says WHERE the problem is.
  ok(/pointer/i.test(text), 'the pointer must be labelled in the output');
  ok(/\/oauth_config\/scopes\/bot/.test(text), 'the JSON pointer itself must be printed');
  ok(/rejected by apps\.manifest\.validate/.test(err.message), 'must match /rejected by apps\.manifest\.validate/');
});

test('app validate renders multiple errors each with its own pointer', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/bad2.json'],
    files: { '/tmp/bad2.json': JSON.stringify({ display_information: { name: 'x' } }) },
    responses: {
      'apps.manifest.validate': {
        ok: false,
        errors: [
          { code: 'requires_a_bot_scope', message: 'Bot user requires a scope', pointer: '/features/bot_user' },
          {
            code: 'target_component_is_null',
            message: 'Event subscription target is null',
            pointer: '/settings/event_subscriptions',
          },
        ],
      },
    },
  });

  await expectDie(() => h.mod.cmdAppValidate());
  const text = h.text();
  ok(/INVALID \(2 error\(s\)\)/.test(text), 'must match /INVALID \(2 error\(s\)\)/');
  ok(/\/features\/bot_user/.test(text), 'must match /\/features\/bot_user/');
  ok(/\/settings\/event_subscriptions/.test(text), 'must match /\/settings\/event_subscriptions/');
});

test('app validate sends the manifest as a JSON string with the app_id', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/ok.json'],
    files: { '/tmp/ok.json': JSON.stringify(LIVE_MANIFEST) },
  });
  await h.mod.cmdAppValidate();

  is(h.methods(), ['apps.manifest.validate']);
  const call = h.httpCalls[0];
  is(call.params.app_id, APP_ID);
  is(typeof call.params.manifest, 'string', 'manifest must be a JSON string');
  is(JSON.parse(call.params.manifest), LIVE_MANIFEST);
});

test('app validate on a valid manifest still warns that valid does not mean safe', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/ok.json'],
    files: { '/tmp/ok.json': JSON.stringify(LIVE_MANIFEST) },
  });
  await h.mod.cmdAppValidate();

  const text = h.text();
  ok(/Manifest valid/.test(text), 'must match /Manifest valid/');
  ok(/VALID DOES NOT MEAN SAFE/.test(text), 'must match /VALID DOES NOT MEAN SAFE/');
  ok(/partial manifest validates ok=true/i.test(text), 'must match /partial manifest validates ok=true/i');
  ok(/app diff/.test(text), 'must point at the diff command');
});

test('app validate dies on a manifest file that is not valid JSON', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/broken.json'],
    files: { '/tmp/broken.json': '{ not json' },
  });
  const err = await expectDie(() => h.mod.cmdAppValidate());
  ok(/not valid JSON/.test(err.message), 'must match /not valid JSON/');
  is(h.httpCalls.length, 0);
});

test('app validate dies when the manifest file is missing', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/absent.json'],
  });
  const err = await expectDie(() => h.mod.cmdAppValidate());
  ok(/Could not read manifest file/.test(err.message), 'must match /Could not read manifest file/');
  is(h.httpCalls.length, 0);
});

// ── HTTP 200 + ok:false is a FAILURE ──────────────────────────────────────────

test('ok:false with HTTP 200 fails the export even when a manifest is present', async () => {
  // The adversarial shape: HTTP 200, a usable-looking manifest, but ok:false.
  // Only the body.ok check can reject this — nothing downstream would notice.
  const h = await load({
    argv: ['app', 'show', APP_ID],
    status: 200,
    responses: {
      'apps.manifest.export': { ok: false, error: 'ratelimited', manifest: clone(LIVE_MANIFEST) },
    },
  });
  const err = await expectDie(() => h.mod.cmdAppShow());
  ok(/ratelimited/.test(err.message), 'the Slack error code must be surfaced');
  ok(!(/Bot scopes/.test(h.text())), 'nothing may be rendered from a failed response');
});

test('ok:false invalid_auth with HTTP 200 is reported as a token failure', async () => {
  const h = await load({
    argv: ['app', 'export', APP_ID],
    status: 200,
    responses: { 'apps.manifest.export': { ok: false, error: 'invalid_auth' } },
  });
  const err = await expectDie(() => h.mod.cmdAppExport());
  ok(/invalid_auth/.test(err.message), 'must match /invalid_auth/');
  ok(/SLACK_APP_CONFIG_TOKEN/.test(err.message), 'must say how to supply a good token');
});

test('ok:false with HTTP 200 fails validate even when errors[] is absent', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/ok.json'],
    files: { '/tmp/ok.json': JSON.stringify(LIVE_MANIFEST) },
    status: 200,
    responses: { 'apps.manifest.validate': { ok: false, error: 'app_not_found' } },
  });
  const err = await expectDie(() => h.mod.cmdAppValidate());
  ok(/app_not_found|app id/i.test(err.message), 'must match /app_not_found|app id/i');
  ok(!(/Manifest valid/.test(h.text())), 'must not match /Manifest valid/');
});

test('every app request is read with raw:true so body.ok is available', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID] });
  await h.mod.cmdAppExport();
  is(h.httpCalls[0].raw, true);
  is(h.httpCalls[0].baseUrl, 'https://slack.com/api');
});

// ── wire format and credential separation ─────────────────────────────────────

test('app requests are form-encoded and bearer-authenticated with the config token', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID] });
  await h.mod.cmdAppExport();

  const call = h.httpCalls[0];
  const ct = call.headers['content-type'] || call.headers['Content-Type'];
  ok(/application\/x-www-form-urlencoded/.test(String(ct)), 'must match /application\/x-www-form-urlencoded/');
  is(call.body, 'app_id=' + APP_ID, 'body must be form-encoded, not JSON');
  is(call.token, TEST_TOKEN, 'the app configuration token must authenticate the call');
});

test('app commands never touch the browser session (no xoxc fallback)', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  await h.mod.cmdAppShow();
  is(h.browserUses, [], 'no browser/tab/localStorage access from app commands');
});

test('getAppConfigToken prefers --token, then env, then skill config', async () => {
  const fromFlag = await load({ argv: ['app', 'show', APP_ID, '--token=xoxe.xoxp-flag'] });
  is(await fromFlag.mod.getAppConfigToken(), 'xoxe.xoxp-flag');

  const fromEnv = await load({ argv: ['app', 'show', APP_ID] });
  is(await fromEnv.mod.getAppConfigToken(), TEST_TOKEN);

  const fromConfig = await load({
    argv: ['app', 'show', APP_ID],
    token: null,
    config: { appConfigToken: 'xoxe.xoxp-from-config' },
  });
  is(await fromConfig.mod.getAppConfigToken(), 'xoxe.xoxp-from-config');
});

test('getAppConfigToken refuses a bot token and a session token', async () => {
  const bot = await load({ argv: ['app', 'show', APP_ID], token: 'xoxb-1234' });
  const botErr = await expectDie(() => bot.mod.getAppConfigToken());
  ok(/BOT token/i.test(botErr.message), 'must match /BOT token/i');

  const session = await load({ argv: ['app', 'show', APP_ID], token: 'xoxc-1234' });
  const sessionErr = await expectDie(() => session.mod.getAppConfigToken());
  ok(/SESSION token/i.test(sessionErr.message), 'must match /SESSION token/i');
});

test('getAppConfigToken dies with the manual minting steps when nothing is set', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID], token: null });
  const err = await expectDie(() => h.mod.getAppConfigToken());
  ok(/No app configuration token/.test(err.message), 'must match /No app configuration token/');
  ok(/api\.slack\.com\/apps/.test(err.message), 'must match /api\.slack\.com\/apps/');
  ok(/Generate Token/.test(err.message), 'must match /Generate Token/');
});

// ── create/delete are unreachable ─────────────────────────────────────────────

test('manifestApi refuses apps.manifest.create and apps.manifest.delete', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });

  const createErr = await expectDie(() =>
    h.mod.manifestApi('apps.manifest.create', {}, TEST_TOKEN)
  );
  ok(/apps\.manifest\.create/.test(createErr.message), 'must match /apps\.manifest\.create/');
  const deleteErr = await expectDie(() =>
    h.mod.manifestApi('apps.manifest.delete', { app_id: APP_ID }, TEST_TOKEN)
  );
  ok(/unrecoverable/i.test(deleteErr.message), 'must match /unrecoverable/i');

  is(h.httpCalls.length, 0, 'the guard must fire before any request is made');
});

test('no app subcommand issues apps.manifest.create or apps.manifest.delete', async () => {
  const candidate = clone(LIVE_MANIFEST);
  delete candidate.display_information.description;
  const files = { '/tmp/c.json': JSON.stringify(candidate) };
  const observed = [];

  for (const argv of [
    ['app', 'export', APP_ID],
    ['app', 'show', APP_ID],
    ['app', 'validate', APP_ID, '--manifest=/tmp/c.json'],
    ['app', 'diff', APP_ID, '--manifest=/tmp/c.json'],
  ]) {
    const h = await load({ argv, files });
    await h.mod.cmdApp();
    observed.push(...h.methods());
  }

  ok(observed.length >= 4, 'each subcommand must have called the API');
  for (const method of observed) {
    ok(
      method === 'apps.manifest.export' || method === 'apps.manifest.validate',
      'unexpected method called: ' + method
    );
  }
  ok(!observed.includes('apps.manifest.create'));
  ok(!observed.includes('apps.manifest.delete'));
});

// ── group dispatch ────────────────────────────────────────────────────────────

test('an unknown app subcommand lists the available ones and calls nothing', async () => {
  const h = await load({ argv: ['app', 'set-colour', APP_ID] });
  const err = await expectDie(() => h.mod.cmdApp());
  ok(/Unknown app subcommand: set-colour/.test(err.message), 'must match /Unknown app subcommand: set-colour/');
  ok(/export, show, validate, diff/.test(err.message), 'must match /export, show, validate, diff/');
  ok(/set-scopes, set-events, set-request-url, apply/.test(err.message), 'must match /set-scopes, set-events, set-request-url, apply/');
  is(h.httpCalls.length, 0);
});

test('app subcommands reject a malformed app id before calling the API', async () => {
  const h = await load({ argv: ['app', 'show', 'not-an-app-id'] });
  const err = await expectDie(() => h.mod.cmdApp());
  ok(/Invalid app id/.test(err.message), 'must match /Invalid app id/');
  is(h.httpCalls.length, 0);
});

test('app show with no app id prints a usage line', async () => {
  const h = await load({ argv: ['app', 'show'] });
  const err = await expectDie(() => h.mod.cmdApp());
  ok(/Usage: slack-ext app show <app_id>/.test(err.message), 'must match /Usage: slack-ext app show <app_id>/');
  is(h.httpCalls.length, 0);
});


// ══ WRITES ════════════════════════════════════════════════════════════════════
//
// Every test below asserts on the manifest actually put on the wire
// (h.sentManifest(), parsed back out of the form body), not on an intermediate
// object, so an implementation that quietly sent a fragment could not pass.

// ── The shared write path: export first, or do not write at all ────────────────

test('write helper exports the live manifest before updating', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();
  // Order matters: the export is what the payload is built from.
  is(h.methods(), ['apps.manifest.export', 'apps.manifest.update']);
});

test('write helper refuses to update when the export fails', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
    responses: { 'apps.manifest.export': { ok: false, error: 'ratelimited' } },
  });
  const err = await expectDie(() => h.mod.cmdAppSetScopes());
  ok(/ratelimited/.test(err.message), 'must match /ratelimited/');
  is(h.updateCalls().length, 0, 'no update may be attempted without a live export');
});

test('write helper refuses to update when the export carries no manifest', async () => {
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--add=app_mention', '--confirm'],
    responses: { 'apps.manifest.export': { ok: true } },
  });
  const err = await expectDie(() => h.mod.cmdAppSetEvents());
  ok(/no manifest/i.test(err.message), 'must match /no manifest/i');
  is(h.updateCalls().length, 0);
});

test('every untouched leaf of the 14-field manifest survives a write', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();

  const sent = h.sentManifest();
  const before = h.mod.manifestLeaves(LIVE_MANIFEST, '', {});
  const after = h.mod.manifestLeaves(sent, '', {});

  // Same leaf set: nothing dropped, nothing invented.
  is(Object.keys(after).sort(), Object.keys(before).sort());
  is(Object.keys(after).length, 14);
  for (const pointer of Object.keys(before)) {
    if (pointer === '/oauth_config/scopes/bot') continue;
    is(
      after[pointer],
      before[pointer],
      'leaf ' + pointer + ' must survive the write untouched'
    );
  }
});

test('the payload is a complete manifest, not a fragment', async () => {
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--add=app_mention', '--confirm'],
  });
  await h.mod.cmdAppSetEvents();

  const sent = h.sentManifest();
  ok(sent.display_information, 'display_information must be present');
  ok(sent.features && sent.features.bot_user, 'bot user must be present');
  ok(sent.oauth_config && sent.oauth_config.scopes, 'scopes must be present');
  ok(sent.settings, 'settings must be present');
  is(sent.display_information.description, LIVE_MANIFEST.display_information.description);
});

// ── set-scopes ────────────────────────────────────────────────────────────────

test('set-scopes --add keeps all six scopes and appends the new one', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();

  const sent = h.sentManifest();
  is(sent.oauth_config.scopes.bot, [
    'channels:manage',
    'channels:read',
    'chat:write',
    'im:write',
    'users:read',
    'users:read.email',
    'reactions:read',
  ]);
  // The other array must not move.
  is(sent.settings.event_subscriptions.bot_events, ['channel_created', 'team_join']);
});

test('set-scopes --add accepts a comma-separated list and ignores duplicates', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read,chat:write,reactions:read', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();
  const scopes = h.sentManifest().oauth_config.scopes.bot;
  is(scopes.filter((s) => s === 'reactions:read').length, 1);
  is(scopes.filter((s) => s === 'chat:write').length, 1, 'already present, not doubled');
  is(scopes.length, 7);
});

test('set-scopes --remove removes only the named scope', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--remove=users:read.email', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();

  const sent = h.sentManifest();
  is(sent.oauth_config.scopes.bot, [
    'channels:manage',
    'channels:read',
    'chat:write',
    'im:write',
    'users:read',
  ]);
  is(sent.settings.event_subscriptions.bot_events, ['channel_created', 'team_join']);
});

test('set-scopes --remove of an intentional scope needs no --allow-deletions', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--remove=im:write', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();
  is(h.updateCalls().length, 1, 'a requested removal proceeds with --confirm alone');
  ok(!h.sentManifest().oauth_config.scopes.bot.includes('im:write'));
});

test('set-scopes --remove of an absent scope changes nothing and writes nothing', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--remove=files:write', '--confirm'],
  });
  await h.mod.cmdAppSetScopes();
  is(h.updateCalls().length, 0, 'no-op must not call update');
  ok(/No change needed/i.test(h.text()), 'must match /No change needed/i');
});

test('set-scopes rejects a malformed scope name before any API call', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=Chat Write; rm -rf /', '--confirm'],
  });
  const err = await expectDie(() => h.mod.cmdAppSetScopes());
  ok(/Invalid scope/.test(err.message), 'must match /Invalid scope/');
  is(h.httpCalls.length, 0);
});

test('set-scopes with neither --add nor --remove dies without calling Slack', async () => {
  const h = await load({ argv: ['app', 'set-scopes', APP_ID, '--confirm'] });
  const err = await expectDie(() => h.mod.cmdAppSetScopes());
  ok(/Nothing to do/.test(err.message), 'must match /Nothing to do/');
  is(h.httpCalls.length, 0);
});

// ── set-events ────────────────────────────────────────────────────────────────

test('set-events --remove removes only the named event and leaves scopes untouched', async () => {
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--remove=team_join', '--confirm'],
  });
  await h.mod.cmdAppSetEvents();

  const sent = h.sentManifest();
  is(sent.settings.event_subscriptions.bot_events, ['channel_created']);
  // The team_join case must not take the scopes with it.
  is(sent.oauth_config.scopes.bot, LIVE_MANIFEST.oauth_config.scopes.bot);
  is(sent.oauth_config.scopes.bot.length, 6);
  is(sent.settings.event_subscriptions.request_url, LIVE_MANIFEST.settings.event_subscriptions.request_url);
});

test('set-events --add appends without disturbing the existing events or scopes', async () => {
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--add=app_mention,message.im', '--confirm'],
  });
  await h.mod.cmdAppSetEvents();

  const sent = h.sentManifest();
  is(sent.settings.event_subscriptions.bot_events, [
    'channel_created',
    'team_join',
    'app_mention',
    'message.im',
  ]);
  is(sent.oauth_config.scopes.bot, LIVE_MANIFEST.oauth_config.scopes.bot);
});

test('set-events on a manifest without event_subscriptions creates the path only', async () => {
  const bare = {
    display_information: { name: 'Bare App' },
    oauth_config: { scopes: { bot: ['chat:write'] } },
    settings: { socket_mode_enabled: true },
  };
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--add=app_mention', '--confirm'],
    live: bare,
  });
  await h.mod.cmdAppSetEvents();

  const sent = h.sentManifest();
  is(sent.settings.event_subscriptions.bot_events, ['app_mention']);
  is(sent.settings.socket_mode_enabled, true, 'sibling settings preserved');
  is(sent.oauth_config.scopes.bot, ['chat:write']);
});

// ── set-request-url ───────────────────────────────────────────────────────────

test('set-request-url changes only the request URL', async () => {
  const h = await load({
    argv: ['app', 'set-request-url', APP_ID, 'https://relay.example.com/slack', '--confirm'],
  });
  await h.mod.cmdAppSetRequestUrl();

  const sent = h.sentManifest();
  is(sent.settings.event_subscriptions.request_url, 'https://relay.example.com/slack');
  is(sent.settings.event_subscriptions.bot_events, ['channel_created', 'team_join']);
  is(sent.oauth_config.scopes.bot, LIVE_MANIFEST.oauth_config.scopes.bot);
  is(Object.keys(h.mod.manifestLeaves(sent, '', {})).length, 14);
});

test('set-request-url rejects a non-https URL and a missing URL', async () => {
  const bad = await load({
    argv: ['app', 'set-request-url', APP_ID, 'http://insecure.example.com', '--confirm'],
  });
  const badErr = await expectDie(() => bad.mod.cmdAppSetRequestUrl());
  ok(/https/.test(badErr.message), 'must match /https/');
  is(bad.httpCalls.length, 0);

  const missing = await load({ argv: ['app', 'set-request-url', APP_ID, '--confirm'] });
  const missingErr = await expectDie(() => missing.mod.cmdAppSetRequestUrl());
  ok(/Usage: slack-ext app set-request-url/.test(missingErr.message), 'must match /Usage: slack-ext app set-request-url/');
  is(missing.httpCalls.length, 0);
});

// ── apply ─────────────────────────────────────────────────────────────────────

test('apply with a display_information-only file REFUSES and names what would be lost', async () => {
  const partial = { display_information: clone(LIVE_MANIFEST.display_information) };
  const h = await load({
    argv: ['app', 'apply', APP_ID, '--manifest=/tmp/partial.json', '--confirm'],
    files: { '/tmp/partial.json': JSON.stringify(partial) },
  });

  const err = await expectDie(() => h.mod.cmdAppApply());
  // The refusal itself must name the casualties.
  ok(/unrequested deletion/i.test(err.message), 'must match /unrequested deletion/i');
  ok(/\/features\/bot_user\/display_name/.test(err.message), 'must match /\/features\/bot_user\/display_name/');
  ok(/\/oauth_config\/scopes\/bot/.test(err.message), 'must match /\/oauth_config\/scopes\/bot/');
  ok(/\/settings\/event_subscriptions\/bot_events/.test(err.message), 'must match /\/settings\/event_subscriptions\/bot_events/');
  ok(/--allow-deletions/.test(err.message), 'must match /--allow-deletions/');
  is(h.updateCalls().length, 0, 'nothing may be written when deletions are refused');
});

test('apply with --allow-deletions proceeds and sends the file as the complete manifest', async () => {
  const partial = { display_information: clone(LIVE_MANIFEST.display_information) };
  const h = await load({
    argv: [
      'app',
      'apply',
      APP_ID,
      '--manifest=/tmp/partial.json',
      '--allow-deletions',
      '--confirm',
    ],
    files: { '/tmp/partial.json': JSON.stringify(partial) },
  });

  await h.mod.cmdAppApply();
  is(h.updateCalls().length, 1);
  is(h.sentManifest(), partial, 'the file becomes the whole manifest');
  ok(/DELETIONS \(11\)/.test(h.text()), 'the diff is still shown in full');
});

test('apply of a superset file writes it and reports no deletions', async () => {
  const candidate = clone(LIVE_MANIFEST);
  candidate.oauth_config.scopes.bot.push('reactions:read');
  candidate.settings.is_mcp_enabled = true;
  const h = await load({
    argv: ['app', 'apply', APP_ID, '--manifest=/tmp/full.json', '--confirm'],
    files: { '/tmp/full.json': JSON.stringify(candidate) },
  });

  await h.mod.cmdAppApply();
  const sent = h.sentManifest();
  is(sent.settings.is_mcp_enabled, true);
  ok(sent.oauth_config.scopes.bot.includes('reactions:read'));
  is(sent.display_information.description, LIVE_MANIFEST.display_information.description);
  // When the file omits nothing, the overlay and the file are the same object
  // graph, so the operator gets exactly what the diff promised.
  is(sent, candidate);
  ok(/No deletions/.test(h.text()), 'must match /No deletions/');
});

test('deepOverlay keeps every live field a partial candidate omits (defense in depth)', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  const partial = { display_information: { name: 'Renamed' } };
  const merged = h.mod.deepOverlay(h.mod.deepClone(LIVE_MANIFEST), partial);

  // Even if the deletion gate were bypassed, the payload built without
  // --allow-deletions cannot drop a field: it starts from the live export.
  is(merged.display_information.name, 'Renamed');
  is(merged.display_information.description, LIVE_MANIFEST.display_information.description);
  is(merged.oauth_config.scopes.bot, LIVE_MANIFEST.oauth_config.scopes.bot);
  is(Object.keys(h.mod.manifestLeaves(merged, '', {})).length, 14);
});

test('deepOverlay replaces arrays wholesale, matching Slack semantics', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  const merged = h.mod.deepOverlay(h.mod.deepClone(LIVE_MANIFEST), {
    oauth_config: { scopes: { bot: ['chat:write'] } },
  });
  is(merged.oauth_config.scopes.bot, ['chat:write']);
});

// ── The deletion gate: requested vs unrequested ───────────────────────────────

test('the deletion gate blocks a deletion the command did not declare', async () => {
  const h = await load({ argv: ['app', 'set-scopes', APP_ID, '--add=x:y', '--confirm'] });

  const err = await expectDie(() =>
    h.mod.updateFromLiveManifest({
      appId: APP_ID,
      token: TEST_TOKEN,
      action: 'set-scopes',
      summary: [],
      mutate: (manifest) => {
        delete manifest.display_information.description;
        return manifest;
      },
      intentional: [],
      rerun: 'x',
    })
  );
  ok(/unrequested deletion/i.test(err.message), 'must match /unrequested deletion/i');
  ok(/\/display_information\/description/.test(err.message), 'must match /\/display_information\/description/');
  is(h.updateCalls().length, 0);
});

test('the deletion gate allows a deletion the command declared', async () => {
  const h = await load({ argv: ['app', 'set-events', APP_ID, '--remove=team_join', '--confirm'] });

  const result = await h.mod.updateFromLiveManifest({
    appId: APP_ID,
    token: TEST_TOKEN,
    action: 'set-events',
    summary: [],
    mutate: (manifest) => {
      manifest.settings.event_subscriptions.bot_events = ['channel_created'];
      return manifest;
    },
    intentional: () => [
      { pointer: '/settings/event_subscriptions/bot_events', value: 'team_join', entry: true },
    ],
    rerun: 'x',
  });

  is(result.updated, true);
  is(h.updateCalls().length, 1);
});

test('an unrequested deletion is blocked even when a requested one is declared', async () => {
  const h = await load({ argv: ['app', 'set-events', APP_ID, '--remove=team_join', '--confirm'] });

  const err = await expectDie(() =>
    h.mod.updateFromLiveManifest({
      appId: APP_ID,
      token: TEST_TOKEN,
      action: 'set-events',
      summary: [],
      mutate: (manifest) => {
        manifest.settings.event_subscriptions.bot_events = ['channel_created'];
        delete manifest.settings.event_subscriptions.request_url;
        return manifest;
      },
      intentional: () => [
        { pointer: '/settings/event_subscriptions/bot_events', value: 'team_join', entry: true },
      ],
      rerun: 'x',
    })
  );
  ok(/\/settings\/event_subscriptions\/request_url/.test(err.message), 'must match /\/settings\/event_subscriptions\/request_url/');
  ok(!(/- \/settings\/event_subscriptions\/bot_events/.test(err.message)), 'must not match /- \/settings\/event_subscriptions\/bot_events/');
  is(h.updateCalls().length, 0);
});

test('--allow-deletions overrides the gate for an unrequested deletion', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=x:y', '--allow-deletions', '--confirm'],
  });

  const result = await h.mod.updateFromLiveManifest({
    appId: APP_ID,
    token: TEST_TOKEN,
    action: 'set-scopes',
    summary: [],
    mutate: (manifest) => {
      delete manifest.display_information.description;
      return manifest;
    },
    intentional: [],
    rerun: 'x',
  });
  is(result.updated, true);
  is(h.updateCalls().length, 1);
});

// ── --confirm guards: zero write calls ────────────────────────────────────────

test('set-scopes without --confirm performs zero write calls', async () => {
  const h = await load({ argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read'] });
  await h.mod.cmdAppSetScopes();
  is(h.writeCalls().length, 0);
  is(h.methods(), ['apps.manifest.export'], 'export is a read, and it is all');
  ok(/No --confirm/.test(h.text()), 'must match /No --confirm/');
  ok(/--confirm to apply/.test(h.text()), 'must match /--confirm to apply/');
});

test('set-events without --confirm performs zero write calls', async () => {
  const h = await load({ argv: ['app', 'set-events', APP_ID, '--remove=team_join'] });
  await h.mod.cmdAppSetEvents();
  is(h.writeCalls().length, 0);
  ok(/No --confirm/.test(h.text()), 'must match /No --confirm/');
});

test('set-request-url without --confirm performs zero write calls', async () => {
  const h = await load({
    argv: ['app', 'set-request-url', APP_ID, 'https://relay.example.com/slack'],
  });
  await h.mod.cmdAppSetRequestUrl();
  is(h.writeCalls().length, 0);
  ok(/No --confirm/.test(h.text()), 'must match /No --confirm/');
});

test('apply without --confirm performs zero write calls', async () => {
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.is_mcp_enabled = true;
  const h = await load({
    argv: ['app', 'apply', APP_ID, '--manifest=/tmp/c.json'],
    files: { '/tmp/c.json': JSON.stringify(candidate) },
  });
  await h.mod.cmdAppApply();
  is(h.writeCalls().length, 0);
  ok(/No --confirm/.test(h.text()), 'must match /No --confirm/');
});

test('token-rotate without --confirm performs zero write calls', async () => {
  const h = await load({
    argv: ['app', 'token-rotate'],
    refreshToken: 'xoxe-1-old-refresh-token',
  });
  await h.mod.cmdAppTokenRotate();
  is(h.writeCalls().length, 0);
  is(h.httpCalls.length, 0, 'a rotate must never be speculative');
  is(h.configWrites.length, 0);
  ok(/INVALIDATES/.test(h.text()), 'must match /INVALIDATES/');
});

// ── permissions_updated: the reinstall signal ─────────────────────────────────

test('permissions_updated true produces a visible REINSTALL warning', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
    responses: { 'apps.manifest.update': { ok: true, permissions_updated: true } },
  });
  await h.mod.cmdAppSetScopes();

  const text = h.text();
  ok(/REINSTALL REQUIRED/.test(text), 'must match /REINSTALL REQUIRED/');
  ok(/permissions_updated = true/.test(text), 'must match /permissions_updated = true/');
  ok(/does NOT carry it|reissued/.test(text), 'must explain the stale bot token');
  ok(new RegExp(APP_ID).test(text), 'must point at the app to reinstall');
});

test('permissions_updated false produces no reinstall warning', async () => {
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--add=app_mention', '--confirm'],
    responses: { 'apps.manifest.update': { ok: true, permissions_updated: false } },
  });
  await h.mod.cmdAppSetEvents();

  const text = h.text();
  ok(!(/REINSTALL REQUIRED/.test(text)), 'must not match /REINSTALL REQUIRED/');
  ok(/permissions_updated = false/.test(text), 'must match /permissions_updated = false/');
});

test('a missing permissions_updated is treated as false, not as a reinstall', async () => {
  const h = await load({
    argv: ['app', 'set-events', APP_ID, '--add=app_mention', '--confirm'],
    responses: { 'apps.manifest.update': { ok: true } },
  });
  await h.mod.cmdAppSetEvents();
  ok(!(/REINSTALL REQUIRED/.test(h.text())), 'must not match /REINSTALL REQUIRED/');
});

test('write --json emits a machine-readable result including reinstall_required', async () => {
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm', '--json'],
    responses: { 'apps.manifest.update': { ok: true, permissions_updated: true } },
  });
  await h.mod.cmdAppSetScopes();

  const payload = JSON.parse(h.text());
  is(payload.updated, true);
  is(payload.permissions_updated, true);
  is(payload.reinstall_required, true);
  is(payload.action, 'set-scopes');
  ok(payload.diff, 'the diff travels with the result');
});

// ── HTTP 200 + ok:false on a write ────────────────────────────────────────────

test('ok:false with HTTP 200 fails the update even when the body looks usable', async () => {
  // Adversarial: HTTP 200, permissions_updated present, ok:false. Only the
  // body.ok check can reject this.
  const h = await load({
    argv: ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
    status: 200,
    responses: {
      'apps.manifest.update': { ok: false, error: 'invalid_manifest', permissions_updated: true },
    },
  });
  const err = await expectDie(() => h.mod.cmdAppSetScopes());
  ok(/invalid_manifest/.test(err.message), 'must match /invalid_manifest/');
  ok(!(/Updated /.test(h.text())), 'nothing may be reported as updated');
  ok(!(/REINSTALL REQUIRED/.test(h.text())), 'must not match /REINSTALL REQUIRED/');
});

// ── token-rotate ──────────────────────────────────────────────────────────────

test('token-rotate sends refresh_token form-encoded with no Authorization header', async () => {
  const h = await load({
    argv: ['app', 'token-rotate', '--refresh-token=xoxe-1-old-refresh-token', '--confirm'],
  });
  await h.mod.cmdAppTokenRotate();

  is(h.methods(), ['tooling.tokens.rotate']);
  const call = h.httpCalls[0];
  is(call.params.refresh_token, 'xoxe-1-old-refresh-token');
  ok(/application\/x-www-form-urlencoded/.test(String(call.headers['content-type'])), 'must match /application\/x-www-form-urlencoded/');
  // Measured: a bearer header alongside refresh_token produced invalid_auth.
  is(call.hasTokenConfig, false, 'the rotate call must carry no bearer token');
});

test('token-rotate persists the new pair BEFORE anything else happens with it', async () => {
  const h = await load({
    argv: ['app', 'token-rotate', '--refresh-token=xoxe-1-old-refresh-token', '--confirm'],
  });
  await h.mod.cmdAppTokenRotate();

  is(h.configWrites.length, 1, 'exactly one persist');
  is(h.configWrites[0].appConfigToken, 'xoxe.xoxp-rotated-access-token');
  is(h.configWrites[0].appRefreshToken, 'xoxe-1-rotated-refresh-token');

  // The rotate has already invalidated the old refresh token, so the persist must
  // be the FIRST thing that happens after the response: any output before it is a
  // window in which a crash loses the only usable credential.
  const kinds = h.events.map((e) => e.type);
  const rotateAt = kinds.indexOf('http');
  const persistAt = kinds.indexOf('persist');
  const firstOutAt = kinds.indexOf('out');
  ok(rotateAt >= 0 && persistAt >= 0, 'both events observed');
  ok(persistAt > rotateAt, 'persist after the rotate response');
  ok(
    firstOutAt === -1 || persistAt < firstOutAt,
    'persist must precede every line of output about the new pair'
  );
});

test('token-rotate prints the new pair when persisting fails instead of swallowing it', async () => {
  const h = await load({
    argv: ['app', 'token-rotate', '--refresh-token=xoxe-1-old-refresh-token', '--confirm'],
    configWriteFails: true,
  });
  await h.mod.cmdAppTokenRotate();

  const text = h.text();
  ok(/COULD NOT PERSIST/.test(text), 'must match /COULD NOT PERSIST/');
  ok(/EACCES/.test(text), 'must match /EACCES/');
  // Last resort: the old refresh token is already dead, so losing this is worse
  // than printing it.
  ok(/xoxe\.xoxp-rotated-access-token/.test(text), 'must match /xoxe\.xoxp-rotated-access-token/');
  ok(/xoxe-1-rotated-refresh-token/.test(text), 'must match /xoxe-1-rotated-refresh-token/');
  ok(/NOT STORED/.test(text), 'must match /NOT STORED/');
});

test('token-rotate masks the tokens on the success path', async () => {
  const h = await load({
    argv: ['app', 'token-rotate', '--refresh-token=xoxe-1-old-refresh-token', '--confirm'],
  });
  await h.mod.cmdAppTokenRotate();
  const text = h.text();
  ok(/Rotated app configuration token/.test(text), 'must match /Rotated app configuration token/');
  ok(!(/xoxe\.xoxp-rotated-access-token/.test(text)), 'no full token in the transcript');
  ok(/xoxe\.xoxp-\.\.\./.test(text), 'masked form shown instead');
  ok(/previous refresh token is now invalid/i.test(text), 'must match /previous refresh token is now invalid/i');
});

test('token-rotate reads the refresh token from env then skill config', async () => {
  const fromEnv = await load({
    argv: ['app', 'token-rotate', '--confirm'],
    refreshToken: 'xoxe-1-env-refresh',
  });
  await fromEnv.mod.cmdAppTokenRotate();
  is(fromEnv.httpCalls[0].params.refresh_token, 'xoxe-1-env-refresh');

  const fromConfig = await load({
    argv: ['app', 'token-rotate', '--confirm'],
    config: { appRefreshToken: 'xoxe-1-config-refresh' },
  });
  await fromConfig.mod.cmdAppTokenRotate();
  is(fromConfig.httpCalls[0].params.refresh_token, 'xoxe-1-config-refresh');
});

test('token-rotate dies with minting instructions when no refresh token exists', async () => {
  const h = await load({ argv: ['app', 'token-rotate', '--confirm'] });
  const err = await expectDie(() => h.mod.cmdAppTokenRotate());
  ok(/No refresh token/.test(err.message), 'must match /No refresh token/');
  ok(/api\.slack\.com\/apps/.test(err.message), 'must match /api\.slack\.com\/apps/');
  is(h.httpCalls.length, 0);
});

test('token-rotate maps invalid_refresh_token to a single-use explanation', async () => {
  const h = await load({
    argv: ['app', 'token-rotate', '--refresh-token=xoxe-1-stale', '--confirm'],
    responses: { 'tooling.tokens.rotate': { ok: false, error: 'invalid_refresh_token' } },
  });
  const err = await expectDie(() => h.mod.cmdAppTokenRotate());
  ok(/invalid_refresh_token/.test(err.message), 'must match /invalid_refresh_token/');
  ok(/single-use/.test(err.message), 'must match /single-use/');
  is(h.configWrites.length, 0, 'nothing may be persisted on a failed rotate');
});

test('token-rotate refuses to discard the old credential when the pair is missing', async () => {
  const h = await load({
    argv: ['app', 'token-rotate', '--refresh-token=xoxe-1-old', '--confirm'],
    responses: { 'tooling.tokens.rotate': { ok: true, token: 'xoxe.xoxp-only-half' } },
  });
  const err = await expectDie(() => h.mod.cmdAppTokenRotate());
  ok(/without a token pair/.test(err.message), 'must match /without a token pair/');
  is(h.configWrites.length, 0);
});

// ── create/delete remain unreachable from the write paths ─────────────────────

test('no write path issues apps.manifest.create or apps.manifest.delete', async () => {
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.is_mcp_enabled = true;
  const files = { '/tmp/w.json': JSON.stringify(candidate) };
  const observed = [];

  for (const argv of [
    ['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'],
    ['app', 'set-events', APP_ID, '--remove=team_join', '--confirm'],
    ['app', 'set-request-url', APP_ID, 'https://relay.example.com/slack', '--confirm'],
    ['app', 'apply', APP_ID, '--manifest=/tmp/w.json', '--confirm'],
    ['app', 'token-rotate', '--refresh-token=xoxe-1-old', '--confirm'],
  ]) {
    const h = await load({ argv, files });
    await h.mod.cmdApp();
    observed.push(...h.methods());
  }

  ok(observed.length >= 9, 'each command must have reached the API');
  const allowed = new Set(['apps.manifest.export', 'apps.manifest.update', 'tooling.tokens.rotate']);
  for (const method of observed) {
    ok(allowed.has(method), 'unexpected method called: ' + method);
  }
});

test('all five write subcommands are reachable through the app dispatcher', async () => {
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.is_mcp_enabled = true;
  const files = { '/tmp/w.json': JSON.stringify(candidate) };

  const cases = [
    [['app', 'set-scopes', APP_ID, '--add=reactions:read', '--confirm'], 'apps.manifest.update'],
    [['app', 'set-events', APP_ID, '--add=app_mention', '--confirm'], 'apps.manifest.update'],
    [
      ['app', 'set-request-url', APP_ID, 'https://relay.example.com/slack', '--confirm'],
      'apps.manifest.update',
    ],
    [['app', 'apply', APP_ID, '--manifest=/tmp/w.json', '--confirm'], 'apps.manifest.update'],
    [['app', 'token-rotate', '--refresh-token=xoxe-1-old', '--confirm'], 'tooling.tokens.rotate'],
  ];

  for (const [argv, expected] of cases) {
    const h = await load({ argv, files });
    await h.mod.cmdApp();
    ok(h.methods().includes(expected), argv.join(' ') + ' must call ' + expected);
  }
});

// ── pure helpers used by the write path ──────────────────────────────────────

test('applyAddRemove reports added, removed and skipped removals', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  const r = h.mod.applyAddRemove(['a', 'b', 'c'], ['d', 'b'], ['a', 'zz']);
  is(r.next, ['b', 'c', 'd']);
  is(r.added, ['d']);
  is(r.removed, ['a']);
  is(r.skippedRemovals, ['zz']);
});

test('parseList splits on commas and whitespace and rejects a valueless flag', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  is(h.mod.parseList('a,b , c', 'add'), ['a', 'b', 'c']);
  is(h.mod.parseList(undefined, 'add'), []);
  // parseList now lives in the pure ./argv.js module, which must not depend on
  // sliccy:cli, so a valueless flag THROWS instead of calling cli.die. The
  // user-visible behaviour is unchanged and was measured end to end:
  //   jsh scripts/slack-ext.jsh app set-scopes A0C2DNYR0TF --add
  //   -> "slack-ext: --add needs a value, e.g. --add=channels:read", exit 1
  // because the top-level catch around main() converts the throw via cli.die.
  // What matters here is that it REFUSES and names the flag - not the class.
  let plErr;
  try {
    h.mod.parseList(true, 'add');
  } catch (e) {
    plErr = e;
  }
  ok(plErr, 'a valueless --add must be refused, not silently treated as empty');
  ok(/--add needs a value/.test(plErr.message), 'must match /--add needs a value/');
});

test('maskToken never reveals the whole value', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  const masked = h.mod.maskToken('xoxe.xoxp-1234567890-abcdefghij');
  ok(!(/1234567890-abcdefghij/.test(masked)), 'must not match /1234567890-abcdefghij/');
  ok(/^xoxe\.xoxp/.test(masked), 'must match /^xoxe\.xoxp/');
  ok(/chars/.test(masked), 'must match /chars/');
});

// ── Mutation matrix ───────────────────────────────────────────────────────────
//
// Each mutation was applied to slack-ext.jsh, the suite was run, the named test
// below failed, and the mutation was reverted. The baseline was verified GREEN
// before the first mutation.
//
// MUTATION 1: diff treats deletions as modifications
//             (collectSubtree(deletions, ...) -> collectSubtree(modifications, ...))
//   Caught by: "diff reports a missing display_information.description as a DELETION"
//              "diff reports every stripped leaf of a display_information-only partial manifest"
//              "app diff output flags deletions distinctly and warns they would be REMOVED"
//
// MUTATION 2: diff ignores array shrinkage (drop the removed-entry loop in the
//             array branch of diffManifests)
//   Caught by: "diff reports bot_events shrinking 2 -> 1 as a DELETION of the removed entry"
//              "diff reports a dropped bot scope as a DELETION of that scope entry"
//
// MUTATION 3: body.ok ignored in favour of the HTTP status
//             (delete `if (!data.ok) dieOnManifestError(...)` in manifestCall)
//   Caught by: "ok:false with HTTP 200 fails the export even when a manifest is present"
//              "ok:false invalid_auth with HTTP 200 is reported as a token failure"
//
// MUTATION 4: the JSON pointer is dropped from validation output
//             (remove the pointer line in renderValidationErrors)
//   Caught by: "app validate renders each error with its JSON pointer"
//              "app validate renders multiple errors each with its own pointer"
