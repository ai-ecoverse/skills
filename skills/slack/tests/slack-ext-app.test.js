// Tests for the `app` manifest subcommands of skills/slack/scripts/slack-ext.jsh
//
// Run with:
//   node --test skills/slack/tests/slack-ext-app.test.js
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

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../scripts/slack-ext.jsh');
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
 */
async function load(opts) {
  const options = opts || {};
  const httpCalls = [];
  const writes = [];
  const browserUses = [];
  const stdout = [];
  const stderr = [];

  const live = options.live ? clone(options.live) : clone(LIVE_MANIFEST);

  function defaultResponse(method) {
    if (method === 'apps.manifest.export') return { ok: true, manifest: live };
    if (method === 'apps.manifest.validate') return { ok: true, errors: [] };
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
            headers: (postOpts && postOpts.headers) || {},
            body: bodyText,
            params,
            raw: Boolean(postOpts && postOpts.raw),
          });
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

  const mocks = {
    'sliccy:browser': browserStub,
    'sliccy:cli': cliStub,
    'sliccy:color': colorStub,
    'sliccy:http': httpStub,
    'sliccy:skill': { config: async () => options.config || null },
    'sliccy:exec': { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    fs: fsStub,
  };

  const mockRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
    throw new Error('unexpected require(' + id + ')');
  };

  let source = fs.readFileSync(SCRIPT, 'utf8');
  source = source.replace(/\ntry \{[\s\S]*$/, '\n');
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
  cmdApp,
  cmdAppExport,
  cmdAppShow,
  cmdAppValidate,
  cmdAppDiff,
};
`;

  const env = {};
  if (options.token !== null) {
    env.SLACK_APP_CONFIG_TOKEN = options.token || TEST_TOKEN;
  }

  const mockProcess = {
    argv: ['node', SCRIPT, ...(options.argv || [])],
    env,
    exit: (code) => {
      throw new NodeExitError('exit', code);
    },
  };

  const mockConsole = {
    log: (msg) => stdout.push(String(msg === undefined ? '' : msg)),
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
    stdout,
    stderr,
    live,
    text: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
    methods: () => httpCalls.map((c) => c.method),
  };
}

async function expectDie(fn) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected the command to exit with an error');
  assert.equal(err.name, 'NodeExitError', 'expected NodeExitError, got: ' + err.message);
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
  assert.equal(keys.length, 14, 'fixture has 14 leaves, got: ' + keys.join(','));
  assert.ok(keys.includes('/display_information/description'));
  assert.ok(keys.includes('/oauth_config/scopes/bot'));
  assert.ok(keys.includes('/settings/event_subscriptions/bot_events'));
  assert.ok(keys.includes('/settings/is_mcp_enabled'));
  // An array is ONE leaf: apps.manifest.update replaces arrays wholesale.
  assert.deepEqual(leaves['/settings/event_subscriptions/bot_events'], [
    'channel_created',
    'team_join',
  ]);
});

test('pointerJoin escapes ~ and / per RFC 6901', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  assert.equal(h.mod.pointerJoin('', 'settings'), '/settings');
  assert.equal(h.mod.pointerJoin('/a', 'b/c'), '/a/b~1c');
  assert.equal(h.mod.pointerJoin('/a', 'b~c'), '/a/b~0c');
});

// ── diff: deletions are the whole point ───────────────────────────────────────

test('diff reports a missing display_information.description as a DELETION', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  delete candidate.display_information.description;

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  assert.deepEqual(pointers(diff.deletions), ['/display_information/description']);
  assert.equal(diff.deletions[0].value, LIVE_MANIFEST.display_information.description);
  // A deletion must NOT be reported as a modification: omitting a field DELETES
  // it (measured live 2026-09-18), which is a different hazard entirely.
  assert.equal(diff.modifications.length, 0, 'must not be counted as a modification');
  assert.equal(diff.additions.length, 0);
  assert.equal(diff.changed, true);
});

test('diff reports bot_events shrinking 2 -> 1 as a DELETION of the removed entry', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.event_subscriptions.bot_events = ['channel_created'];

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  // The team_join case: arrays are REPLACED WHOLESALE, so a shrunk array is a
  // deletion of the dropped entries — not a modification of the array.
  assert.equal(diff.deletions.length, 1);
  assert.equal(diff.deletions[0].pointer, '/settings/event_subscriptions/bot_events');
  assert.equal(diff.deletions[0].value, 'team_join');
  assert.equal(diff.deletions[0].entry, true, 'deletion must be marked as an array entry');
  assert.equal(diff.modifications.length, 0, 'array shrinkage is not a modification');
  assert.equal(diff.additions.length, 0);
});

test('diff reports a dropped bot scope as a DELETION of that scope entry', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  candidate.oauth_config.scopes.bot = LIVE_MANIFEST.oauth_config.scopes.bot.filter(
    (s) => s !== 'users:read.email'
  );

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  assert.equal(diff.deletions.length, 1);
  assert.equal(diff.deletions[0].pointer, '/oauth_config/scopes/bot');
  assert.equal(diff.deletions[0].value, 'users:read.email');
  assert.equal(diff.modifications.length, 0);
});

test('diff on an identical manifest reports NO changes', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const diff = h.mod.diffManifests(LIVE_MANIFEST, clone(LIVE_MANIFEST));
  assert.equal(diff.deletions.length, 0);
  assert.equal(diff.additions.length, 0);
  assert.equal(diff.modifications.length, 0);
  assert.equal(diff.changed, false);
});

test('diff separates additions and modifications from deletions', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = clone(LIVE_MANIFEST);
  candidate.settings.socket_mode_enabled = true; // modification
  candidate.settings.event_subscriptions.bot_events.push('app_mention'); // addition
  candidate.display_information.name = 'Renamed App'; // modification

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  assert.equal(diff.deletions.length, 0, 'nothing was removed');
  assert.deepEqual(pointers(diff.additions), ['/settings/event_subscriptions/bot_events']);
  assert.equal(diff.additions[0].value, 'app_mention');
  assert.deepEqual(pointers(diff.modifications).sort(), [
    '/display_information/name',
    '/settings/socket_mode_enabled',
  ]);
  const socket = diff.modifications.find((m) => m.pointer === '/settings/socket_mode_enabled');
  assert.equal(socket.from, false);
  assert.equal(socket.to, true);
});

test('diff reports every stripped leaf of a display_information-only partial manifest', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const candidate = { display_information: clone(LIVE_MANIFEST.display_information) };

  const diff = h.mod.diffManifests(LIVE_MANIFEST, candidate);

  // This payload VALIDATES ok=true against Slack, which is exactly why diff has
  // to enumerate the damage: bot user, all scopes and all events would be gone.
  const ptrs = pointers(diff.deletions);
  assert.ok(ptrs.includes('/features/bot_user/display_name'));
  assert.ok(ptrs.includes('/features/bot_user/always_online'));
  assert.ok(ptrs.includes('/oauth_config/scopes/bot'));
  assert.ok(ptrs.includes('/settings/event_subscriptions/request_url'));
  assert.ok(ptrs.includes('/settings/event_subscriptions/bot_events'));
  assert.ok(ptrs.includes('/settings/is_mcp_enabled'));
  assert.equal(diff.deletions.length, 11, 'all 11 non-display_information leaves');
  assert.equal(diff.modifications.length, 0);
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
  assert.match(text, /DELETIONS \(2\)/, 'deletions must have their own labelled section');
  assert.match(text, /- \/display_information\/description/);
  assert.match(text, /- \/settings\/event_subscriptions\/bot_events/);
  assert.match(text, /team_join/, 'the dropped array entry must be named');
  assert.match(text, /would be DELETED/, 'must warn loudly about deletions');
  assert.match(text, /REPLACED WHOLESALE/, 'must explain array replacement');
  // The candidate is only ever compared against a fresh live export.
  assert.deepEqual(h.methods(), ['apps.manifest.export']);
});

test('app diff on an identical manifest prints no-changes and no deletion warning', async () => {
  const h = await load({
    argv: ['app', 'diff', APP_ID, '--manifest=/tmp/same.json'],
    files: { '/tmp/same.json': JSON.stringify(LIVE_MANIFEST) },
  });
  await h.mod.cmdAppDiff();

  const text = h.text();
  assert.match(text, /No changes/i);
  assert.doesNotMatch(text, /DELETIONS/);
  assert.doesNotMatch(text, /would be DELETED/);
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
  assert.deepEqual(pointers(payload.deletions), ['/settings/event_subscriptions/request_url']);
  assert.deepEqual(pointers(payload.modifications), ['/settings/is_mcp_enabled']);
  assert.equal(payload.additions.length, 0);
  assert.equal(payload.changed, true);
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
  assert.match(text, /- \/display_information\/background_color/);
  assert.match(text, /can never be null/, 'the one measured exception must be called out');
  assert.match(text, /do not generalise/i);
});

test('app diff without --manifest dies with a usage message and calls nothing', async () => {
  const h = await load({ argv: ['app', 'diff', APP_ID] });
  const err = await expectDie(() => h.mod.cmdAppDiff());
  assert.match(err.message, /--manifest/);
  assert.equal(h.httpCalls.length, 0, 'no API call before the arguments are valid');
});

// ── show ──────────────────────────────────────────────────────────────────────

test('app show renders all 6 bot scopes and both bot events', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  await h.mod.cmdAppShow();

  const text = h.text();
  for (const scope of LIVE_MANIFEST.oauth_config.scopes.bot) {
    assert.match(text, new RegExp(scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(text, /Bot scopes \(6\)/);
  assert.match(text, /Event subscriptions \(2\)/);
  assert.match(text, /channel_created/);
  assert.match(text, /team_join/);
  assert.equal(h.methods().length, 1);
  assert.equal(h.methods()[0], 'apps.manifest.export');
});

test('app show renders name, bot user, request URL and the notable booleans', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  await h.mod.cmdAppShow();

  const text = h.text();
  assert.match(text, /AEM Ops Automation/);
  assert.match(text, /slack-automation-relay\.adobeaem\.workers\.dev/);
  assert.match(text, /Socket mode/);
  assert.match(text, /Org deploy/);
  assert.match(text, /MCP/);
  assert.match(text, /PKCE/);
  assert.match(text, new RegExp(APP_ID));
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
  assert.match(text, /Bare App/);
  assert.match(text, /Bot scopes \(0\)/);
  assert.match(text, /no bot user/i);
});

// ── export ────────────────────────────────────────────────────────────────────

test('app export pretty-prints the live manifest', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID] });
  await h.mod.cmdAppExport();

  const parsed = JSON.parse(h.text());
  assert.deepEqual(parsed, LIVE_MANIFEST);
  assert.deepEqual(h.methods(), ['apps.manifest.export']);
  assert.equal(h.writes.length, 0, 'no file written without --out');
});

test('app export --out writes the manifest to the file and reports the leaf count', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID, '--out=/tmp/out.json'] });
  await h.mod.cmdAppExport();

  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/tmp/out.json');
  assert.deepEqual(JSON.parse(h.writes[0].contents), LIVE_MANIFEST);
  assert.match(h.text(), /Leaves/);
  assert.match(h.text(), /14/);
});

test('app export dies when the response carries no manifest object', async () => {
  const h = await load({
    argv: ['app', 'export', APP_ID],
    responses: { 'apps.manifest.export': { ok: true } },
  });
  const err = await expectDie(() => h.mod.cmdAppExport());
  assert.match(err.message, /no manifest/i);
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
  assert.match(text, /illegal_bot_scopes/);
  assert.match(text, /Illegal bot scopes found/);
  // The pointer is the only thing that says WHERE the problem is.
  assert.match(text, /pointer/i, 'the pointer must be labelled in the output');
  assert.match(text, /\/oauth_config\/scopes\/bot/, 'the JSON pointer itself must be printed');
  assert.match(err.message, /rejected by apps\.manifest\.validate/);
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
  assert.match(text, /INVALID \(2 error\(s\)\)/);
  assert.match(text, /\/features\/bot_user/);
  assert.match(text, /\/settings\/event_subscriptions/);
});

test('app validate sends the manifest as a JSON string with the app_id', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/ok.json'],
    files: { '/tmp/ok.json': JSON.stringify(LIVE_MANIFEST) },
  });
  await h.mod.cmdAppValidate();

  assert.deepEqual(h.methods(), ['apps.manifest.validate']);
  const call = h.httpCalls[0];
  assert.equal(call.params.app_id, APP_ID);
  assert.equal(typeof call.params.manifest, 'string', 'manifest must be a JSON string');
  assert.deepEqual(JSON.parse(call.params.manifest), LIVE_MANIFEST);
});

test('app validate on a valid manifest still warns that valid does not mean safe', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/ok.json'],
    files: { '/tmp/ok.json': JSON.stringify(LIVE_MANIFEST) },
  });
  await h.mod.cmdAppValidate();

  const text = h.text();
  assert.match(text, /Manifest valid/);
  assert.match(text, /VALID DOES NOT MEAN SAFE/);
  assert.match(text, /partial manifest validates ok=true/i);
  assert.match(text, /app diff/, 'must point at the diff command');
});

test('app validate dies on a manifest file that is not valid JSON', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/broken.json'],
    files: { '/tmp/broken.json': '{ not json' },
  });
  const err = await expectDie(() => h.mod.cmdAppValidate());
  assert.match(err.message, /not valid JSON/);
  assert.equal(h.httpCalls.length, 0);
});

test('app validate dies when the manifest file is missing', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/absent.json'],
  });
  const err = await expectDie(() => h.mod.cmdAppValidate());
  assert.match(err.message, /Could not read manifest file/);
  assert.equal(h.httpCalls.length, 0);
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
  assert.match(err.message, /ratelimited/, 'the Slack error code must be surfaced');
  assert.doesNotMatch(h.text(), /Bot scopes/, 'nothing may be rendered from a failed response');
});

test('ok:false invalid_auth with HTTP 200 is reported as a token failure', async () => {
  const h = await load({
    argv: ['app', 'export', APP_ID],
    status: 200,
    responses: { 'apps.manifest.export': { ok: false, error: 'invalid_auth' } },
  });
  const err = await expectDie(() => h.mod.cmdAppExport());
  assert.match(err.message, /invalid_auth/);
  assert.match(err.message, /SLACK_APP_CONFIG_TOKEN/, 'must say how to supply a good token');
});

test('ok:false with HTTP 200 fails validate even when errors[] is absent', async () => {
  const h = await load({
    argv: ['app', 'validate', APP_ID, '--manifest=/tmp/ok.json'],
    files: { '/tmp/ok.json': JSON.stringify(LIVE_MANIFEST) },
    status: 200,
    responses: { 'apps.manifest.validate': { ok: false, error: 'app_not_found' } },
  });
  const err = await expectDie(() => h.mod.cmdAppValidate());
  assert.match(err.message, /app_not_found|app id/i);
  assert.doesNotMatch(h.text(), /Manifest valid/);
});

test('every app request is read with raw:true so body.ok is available', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID] });
  await h.mod.cmdAppExport();
  assert.equal(h.httpCalls[0].raw, true);
  assert.equal(h.httpCalls[0].baseUrl, 'https://slack.com/api');
});

// ── wire format and credential separation ─────────────────────────────────────

test('app requests are form-encoded and bearer-authenticated with the config token', async () => {
  const h = await load({ argv: ['app', 'export', APP_ID] });
  await h.mod.cmdAppExport();

  const call = h.httpCalls[0];
  const ct = call.headers['content-type'] || call.headers['Content-Type'];
  assert.match(String(ct), /application\/x-www-form-urlencoded/);
  assert.equal(call.body, 'app_id=' + APP_ID, 'body must be form-encoded, not JSON');
  assert.equal(call.token, TEST_TOKEN, 'the app configuration token must authenticate the call');
});

test('app commands never touch the browser session (no xoxc fallback)', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });
  await h.mod.cmdAppShow();
  assert.deepEqual(h.browserUses, [], 'no browser/tab/localStorage access from app commands');
});

test('getAppConfigToken prefers --token, then env, then skill config', async () => {
  const fromFlag = await load({ argv: ['app', 'show', APP_ID, '--token=xoxe.xoxp-flag'] });
  assert.equal(await fromFlag.mod.getAppConfigToken(), 'xoxe.xoxp-flag');

  const fromEnv = await load({ argv: ['app', 'show', APP_ID] });
  assert.equal(await fromEnv.mod.getAppConfigToken(), TEST_TOKEN);

  const fromConfig = await load({
    argv: ['app', 'show', APP_ID],
    token: null,
    config: { appConfigToken: 'xoxe.xoxp-from-config' },
  });
  assert.equal(await fromConfig.mod.getAppConfigToken(), 'xoxe.xoxp-from-config');
});

test('getAppConfigToken refuses a bot token and a session token', async () => {
  const bot = await load({ argv: ['app', 'show', APP_ID], token: 'xoxb-1234' });
  const botErr = await expectDie(() => bot.mod.getAppConfigToken());
  assert.match(botErr.message, /BOT token/i);

  const session = await load({ argv: ['app', 'show', APP_ID], token: 'xoxc-1234' });
  const sessionErr = await expectDie(() => session.mod.getAppConfigToken());
  assert.match(sessionErr.message, /SESSION token/i);
});

test('getAppConfigToken dies with the manual minting steps when nothing is set', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID], token: null });
  const err = await expectDie(() => h.mod.getAppConfigToken());
  assert.match(err.message, /No app configuration token/);
  assert.match(err.message, /api\.slack\.com\/apps/);
  assert.match(err.message, /Generate Token/);
});

// ── create/delete are unreachable ─────────────────────────────────────────────

test('manifestApi refuses apps.manifest.create and apps.manifest.delete', async () => {
  const h = await load({ argv: ['app', 'show', APP_ID] });

  const createErr = await expectDie(() =>
    h.mod.manifestApi('apps.manifest.create', {}, TEST_TOKEN)
  );
  assert.match(createErr.message, /apps\.manifest\.create/);
  const deleteErr = await expectDie(() =>
    h.mod.manifestApi('apps.manifest.delete', { app_id: APP_ID }, TEST_TOKEN)
  );
  assert.match(deleteErr.message, /unrecoverable/i);

  assert.equal(h.httpCalls.length, 0, 'the guard must fire before any request is made');
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

  assert.ok(observed.length >= 4, 'each subcommand must have called the API');
  for (const method of observed) {
    assert.ok(
      method === 'apps.manifest.export' || method === 'apps.manifest.validate',
      'unexpected method called: ' + method
    );
  }
  assert.ok(!observed.includes('apps.manifest.create'));
  assert.ok(!observed.includes('apps.manifest.delete'));
});

// ── group dispatch ────────────────────────────────────────────────────────────

test('an unknown app subcommand lists the available ones and calls nothing', async () => {
  const h = await load({ argv: ['app', 'set-scopes', APP_ID] });
  const err = await expectDie(() => h.mod.cmdApp());
  assert.match(err.message, /Unknown app subcommand: set-scopes/);
  assert.match(err.message, /export, show, validate, diff/);
  assert.equal(h.httpCalls.length, 0);
});

test('app subcommands reject a malformed app id before calling the API', async () => {
  const h = await load({ argv: ['app', 'show', 'not-an-app-id'] });
  const err = await expectDie(() => h.mod.cmdApp());
  assert.match(err.message, /Invalid app id/);
  assert.equal(h.httpCalls.length, 0);
});

test('app show with no app id prints a usage line', async () => {
  const h = await load({ argv: ['app', 'show'] });
  const err = await expectDie(() => h.mod.cmdApp());
  assert.match(err.message, /Usage: slack-ext app show <app_id>/);
  assert.equal(h.httpCalls.length, 0);
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
