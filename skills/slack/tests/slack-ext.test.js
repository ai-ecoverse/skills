// Tests for skills/slack/scripts/slack-ext.jsh
//
// Run with:
//   node --test skills/slack/tests/slack-ext.test.js
//
// Strategy: compile the real source (removing the trailing `await main()` so
// it does not auto-execute), inject mock sliccy:* modules and a stub browser,
// then call the exported internal functions directly. This exercises the REAL
// code — no duplicated reimplementation that could silently diverge.
//
// Mutation verification is documented inline: each test names the mutation that
// would break it, and the section at the bottom records the verification matrix.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '../scripts/slack-ext.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ── Test harness ──────────────────────────────────────────────────────────────

class NodeExitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = code !== undefined ? code : 1;
  }
}

/**
 * Load the slack-ext.jsh module with mocked dependencies and simulated argv.
 *
 * @param {object} opts
 * @param {string[]} opts.argv     process.argv (after 'node script') words
 * @param {object}  [opts.user]   users.info response body (merged with defaults)
 * @param {object}  [opts.convs]  users.conversations response body
 * @param {object}  [opts.adminResult]  users.admin.* response body (default ok:true)
 * @param {object}  [opts.inviteResult] conversations.invite response body
 * @param {object}  [opts.kickResult]   conversations.kick response body
 * @param {string}  [opts.tabUrl] override the Slack tab URL
 */
async function load(opts) {
  const calls = [];
  const stdout = [];
  const stderr = [];

  // Default workspace in tab URL (auto-detection path)
  const tabUrl = opts.tabUrl || 'https://app.slack.com/client/T06DUTYDQ/C000';

  // Default user: a regular member (not bot, not restricted)
  const defaultUser = {
    id: 'U12345',
    name: 'testuser',
    real_name: 'Test User',
    is_bot: false,
    is_restricted: false,
    is_ultra_restricted: false,
    deleted: false,
    profile: { display_name: 'testuser' },
  };
  const resolvedUser = Object.assign({}, defaultUser, opts.user || {});

  const fakeTab = { id: 'tab1', url: tabUrl };

  const browserStub = {
    async findTab() {
      return fakeTab;
    },
    async localStorage(tab, key) {
      if (key === 'localConfig_v2') {
        return JSON.stringify({
          teams: { T06DUTYDQ: { token: 'xoxc-test-token' } },
        });
      }
      return null;
    },
    async fetch(tab, url, fetchOpts) {
      const method = url.replace('/api/', '');
      calls.push({ method, opts: fetchOpts });

      // users.info
      if (method === 'users.info') {
        return { body: { ok: true, user: resolvedUser } };
      }
      // users.conversations (for status guest channels)
      if (method === 'users.conversations') {
        if (opts.convs) return { body: opts.convs };
        return { body: { ok: true, channels: [] } };
      }
      // users.admin.setUltraRestricted
      if (method === 'users.admin.setUltraRestricted') {
        return { body: opts.adminResult || { ok: true } };
      }
      // users.admin.setRestricted
      if (method === 'users.admin.setRestricted') {
        return { body: opts.adminResult || { ok: true } };
      }
      // users.admin.setRegular
      if (method === 'users.admin.setRegular') {
        return { body: opts.adminResult || { ok: true } };
      }
      // conversations.invite
      if (method === 'conversations.invite') {
        return { body: opts.inviteResult || { ok: true } };
      }
      // conversations.kick
      if (method === 'conversations.kick') {
        return { body: opts.kickResult || { ok: true } };
      }
      return { body: { ok: false, error: 'not_mocked' } };
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

  const mocks = {
    'sliccy:browser': browserStub,
    'sliccy:cli': cliStub,
    'sliccy:color': colorStub,
    'sliccy:exec': { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    // The `app` manifest subcommands (added later on the same branch) require
    // sliccy:http and sliccy:skill at module scope. They are stubbed to THROW if
    // a user-management command ever reaches them: these commands must keep
    // going through browser.fetch with the xoxc session token, never through the
    // bearer-token App Manifest client. See tests/slack-ext-app.test.js for the
    // app-command harness.
    'sliccy:http': {
      client: () => ({
        post: async () => {
          throw new Error('user-management commands must not use the App Manifest HTTP client');
        },
      }),
    },
    'sliccy:skill': { config: async () => null },
    fs: {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async () => {
        throw new Error('EACCES');
      },
    },
  };

  const mockRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
    throw new Error('unexpected require(' + id + ')');
  };

  // Strip the trailing `await main()` so the module does not auto-execute
  let source = fs.readFileSync(SCRIPT, 'utf8');
  source = source.replace(/\ntry \{[\s\S]*$/, '\n');

  // Append exports of the key internal functions for direct testing
  source += `
return {
  parseArgv,
  userTypeLabel,
  buildSetUltraRestrictedParams,
  buildSetRestrictedParams,
  buildSetRegularParams,
  cmdStatus,
  cmdSetSingle,
  cmdSetMulti,
  cmdSetMember,
  cmdAddChannel,
  cmdRemoveChannel,
};
`;

  const mockProcess = {
    argv: ['node', SCRIPT, ...opts.argv],
    env: {},
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
    calls,
    stdout,
    stderr,
    text: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
    apiCalls: () => calls.map((c) => c.method),
    adminCalls: () => calls.filter((c) => c.method.startsWith('users.admin.')),
    mutatingCalls: () =>
      calls.filter(
        (c) =>
          c.method.startsWith('users.admin.') ||
          c.method === 'conversations.invite' ||
          c.method === 'conversations.kick'
      ),
  };
}

// ── Pure function tests (no browser mocks needed, extracted directly) ─────────

test('userTypeLabel: regular member', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  assert.equal(userTypeLabel({ is_bot: false, is_restricted: false, is_ultra_restricted: false, deleted: false }), 'regular');
});

test('userTypeLabel: multi-channel guest', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  assert.equal(userTypeLabel({ is_bot: false, is_restricted: true, is_ultra_restricted: false, deleted: false }), 'multi-channel guest');
});

test('userTypeLabel: single-channel guest', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  assert.equal(userTypeLabel({ is_bot: false, is_restricted: true, is_ultra_restricted: true, deleted: false }), 'single-channel guest');
});

test('userTypeLabel: bot', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  assert.equal(userTypeLabel({ is_bot: true, is_restricted: false, is_ultra_restricted: false, deleted: false }), 'bot');
});

test('userTypeLabel: deactivated', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  assert.equal(userTypeLabel({ is_bot: false, is_restricted: false, is_ultra_restricted: false, deleted: true }), 'deactivated');
});

// ── Parameter name tests — these are the most safety-critical ─────────────────

test('buildSetUltraRestrictedParams uses "channel" (singular), not "channels"', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { buildSetUltraRestrictedParams } = h.mod;
  const params = buildSetUltraRestrictedParams('U123', 'C456', 'T789');

  // CRITICAL: the API requires `channel` (singular). Passing `channels` returns
  // invalid_arguments. Verified live 2026-09-18.
  assert.equal(params.channel, 'C456', 'must use "channel" (singular)');
  assert.equal(params.channels, undefined, 'must NOT have "channels" (plural)');
  assert.equal(params.user, 'U123');
  assert.equal(params.team_id, 'T789');
});

test('buildSetRestrictedParams includes user and team_id', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { buildSetRestrictedParams } = h.mod;
  const params = buildSetRestrictedParams('U123', 'T789');
  assert.equal(params.user, 'U123');
  assert.equal(params.team_id, 'T789');
  // setRestricted does NOT take a channel parameter
  assert.equal(params.channel, undefined);
});

test('buildSetRegularParams includes user and team_id', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { buildSetRegularParams } = h.mod;
  const params = buildSetRegularParams('U123', 'T789');
  assert.equal(params.user, 'U123');
  assert.equal(params.team_id, 'T789');
  assert.equal(params.channel, undefined);
});

// ── --confirm guard tests ─────────────────────────────────────────────────────

test('set-single without --confirm makes no admin API call', async () => {
  let h;
  try {
    h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456'],
    });
    await h.mod.cmdSetSingle();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  assert.equal(h.adminCalls().length, 0, 'no admin API call without --confirm');
  const text = h.text();
  assert.match(text, /no --confirm|nothing changed/i, 'should mention --confirm required');
});

test('set-multi without --confirm makes no admin API call', async () => {
  let h;
  try {
    h = await load({ argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345'] });
    await h.mod.cmdSetMulti();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  assert.equal(h.adminCalls().length, 0, 'no admin API call without --confirm');
});

test('set-member without --confirm makes no admin API call', async () => {
  let h;
  try {
    h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-member', 'U12345'],
      user: { is_restricted: true },
    });
    await h.mod.cmdSetMember();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  assert.equal(h.adminCalls().length, 0, 'no admin API call without --confirm');
});

test('add-channel without --confirm makes no mutating API call', async () => {
  let h;
  try {
    h = await load({ argv: ['--ws=T06DUTYDQ', 'add-channel', 'U12345', '--channel=C456'] });
    await h.mod.cmdAddChannel();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  assert.equal(h.mutatingCalls().length, 0, 'no mutating call without --confirm');
});

test('remove-channel without --confirm makes no mutating API call', async () => {
  let h;
  try {
    h = await load({ argv: ['--ws=T06DUTYDQ', 'remove-channel', 'U12345', '--channel=C456'] });
    await h.mod.cmdRemoveChannel();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  assert.equal(h.mutatingCalls().length, 0, 'no mutating call without --confirm');
});

// ── Bot user rejection tests ──────────────────────────────────────────────────

test('set-single refuses bot user', async () => {
  let err;
  try {
    const h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm'],
      user: { is_bot: true, is_restricted: false, is_ultra_restricted: false, deleted: false },
    });
    await h.mod.cmdSetSingle();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should have thrown');
  assert.equal(err.name, 'NodeExitError');
  assert.match(err.message, /bot/i, 'error message should mention bot');
});

test('set-multi refuses bot user', async () => {
  let err;
  try {
    const h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345', '--confirm'],
      user: { is_bot: true, is_restricted: false, is_ultra_restricted: false, deleted: false },
    });
    await h.mod.cmdSetMulti();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should have thrown');
  assert.equal(err.name, 'NodeExitError');
  assert.match(err.message, /bot/i);
});

test('set-member refuses bot user', async () => {
  let err;
  try {
    const h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-member', 'U12345', '--confirm'],
      user: { is_bot: true, is_restricted: false, is_ultra_restricted: false, deleted: false },
    });
    await h.mod.cmdSetMember();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'should have thrown');
  assert.equal(err.name, 'NodeExitError');
  assert.match(err.message, /bot/i);
});

// ── Already-in-state tests ────────────────────────────────────────────────────

test('set-single is no-op when user is already a single-channel guest', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: true, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetSingle();
  assert.equal(h.adminCalls().length, 0, 'should not call setUltraRestricted for already-SCG');
  assert.match(h.text(), /no change needed/i, 'should say no change needed');
});

test('set-multi is no-op when user is already a multi-channel guest', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetMulti();
  assert.equal(h.adminCalls().length, 0, 'should not call setRestricted for already-MCG');
  assert.match(h.text(), /no change needed/i);
});

test('set-member is no-op when user is already a regular member', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-member', 'U12345', '--confirm'],
    user: { is_restricted: false, is_ultra_restricted: false, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetMember();
  assert.equal(h.adminCalls().length, 0, 'should not call setRegular for already-member');
  assert.match(h.text(), /no change needed/i);
});

// ── Confirmed mutation tests ──────────────────────────────────────────────────

test('set-single with --confirm calls users.admin.setUltraRestricted with channel (singular)', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm'],
  });
  await h.mod.cmdSetSingle();

  const adminCall = h.calls.find((c) => c.method === 'users.admin.setUltraRestricted');
  assert.ok(adminCall, 'users.admin.setUltraRestricted must be called');

  // Verify the URLSearchParams body contains 'channel' (singular)
  const body = adminCall.opts && adminCall.opts.body;
  assert.ok(body, 'call must have a body');
  assert.match(body, /channel=C456/, 'body must contain channel=C456');
  assert.doesNotMatch(body, /channels=/, 'body must NOT contain channels= (plural)');
  assert.match(body, /user=U12345/, 'body must contain user=U12345');
  assert.match(body, /team_id=T06DUTYDQ/, 'body must contain team_id=T06DUTYDQ');
});

test('set-multi with --confirm calls users.admin.setRestricted', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345', '--confirm'],
  });
  await h.mod.cmdSetMulti();

  const adminCall = h.calls.find((c) => c.method === 'users.admin.setRestricted');
  assert.ok(adminCall, 'users.admin.setRestricted must be called');
  const body = adminCall.opts && adminCall.opts.body;
  assert.match(body, /user=U12345/);
  assert.match(body, /team_id=T06DUTYDQ/);
});

test('set-member with --confirm calls users.admin.setRegular', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-member', 'U12345', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetMember();

  const adminCall = h.calls.find((c) => c.method === 'users.admin.setRegular');
  assert.ok(adminCall, 'users.admin.setRegular must be called');
  const body = adminCall.opts && adminCall.opts.body;
  assert.match(body, /user=U12345/);
  assert.match(body, /team_id=T06DUTYDQ/);
});

test('add-channel with --confirm calls conversations.invite', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'add-channel', 'U12345', '--channel=C456', '--confirm'],
  });
  await h.mod.cmdAddChannel();

  const inviteCall = h.calls.find((c) => c.method === 'conversations.invite');
  assert.ok(inviteCall, 'conversations.invite must be called');
  const body = inviteCall.opts && inviteCall.opts.body;
  assert.match(body, /channel=C456/);
  assert.match(body, /users=U12345/);
});

test('remove-channel with --confirm calls conversations.kick', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'remove-channel', 'U12345', '--channel=C456', '--confirm'],
  });
  await h.mod.cmdRemoveChannel();

  const kickCall = h.calls.find((c) => c.method === 'conversations.kick');
  assert.ok(kickCall, 'conversations.kick must be called');
  const body = kickCall.opts && kickCall.opts.body;
  assert.match(body, /channel=C456/);
  assert.match(body, /user=U12345/);
});

// ── parseArgv: BOOL_FLAGS includes confirm ────────────────────────────────────

test('parseArgv treats --confirm as a boolean flag (no value consumed)', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { parseArgv } = h.mod;

  // Without --confirm
  const a = parseArgv(['set-single', 'U1', '--channel=C2', '--ws=T3']);
  assert.equal(a.flags.confirm, undefined);

  // With --confirm as the last flag (no next token)
  const b = parseArgv(['set-single', 'U1', '--channel=C2', '--ws=T3', '--confirm']);
  assert.equal(b.flags.confirm, true);

  // With --confirm followed by a positional — must not consume the positional as value
  const c = parseArgv(['set-single', '--confirm', 'U1']);
  assert.equal(c.flags.confirm, true);
  assert.deepEqual(c.positional, ['set-single', 'U1']);
});

// ── Mutation test documentation ────────────────────────────────────────────────
//
// Each mutation and the test that catches it:
//
// MUTATION 1: Remove the `--confirm` guard (delete `if (!flags.confirm) { ... return; }`)
//   Caught by: "set-single without --confirm makes no admin API call"
//              "set-multi without --confirm makes no admin API call"
//              "set-member without --confirm makes no admin API call"
//              "add-channel without --confirm makes no mutating API call"
//              "remove-channel without --confirm makes no mutating API call"
//
// MUTATION 2: Change `channel` to `channels` in buildSetUltraRestrictedParams
//   Caught by: "buildSetUltraRestrictedParams uses "channel" (singular), not "channels""
//              "set-single with --confirm calls users.admin.setUltraRestricted with channel (singular)"
//
// MUTATION 3: Remove the bot check (delete `if (user.is_bot) { cli.die(...) }`)
//   Caught by: "set-single refuses bot user"
//              "set-multi refuses bot user"
//              "set-member refuses bot user"
//
// MUTATION 4: Remove the already-in-state check for set-single
//   Caught by: "set-single is no-op when user is already a single-channel guest"
//
// MUTATION 5: Remove the already-in-state check for set-multi
//   Caught by: "set-multi is no-op when user is already a multi-channel guest"
//
// MUTATION 6: Remove the already-in-state check for set-member
//   Caught by: "set-member is no-op when user is already a regular member"
//
// MUTATION 7: Call wrong Slack method in set-single (e.g. setRestricted instead)
//   Caught by: "set-single with --confirm calls users.admin.setUltraRestricted with channel (singular)"
//
// MUTATION 8: Call wrong Slack method in set-multi (e.g. setRegular instead)
//   Caught by: "set-multi with --confirm calls users.admin.setRestricted"
//
// MUTATION 9: Call wrong Slack method in set-member (e.g. setRestricted instead)
//   Caught by: "set-member with --confirm calls users.admin.setRegular"
//
// VERIFICATION EVIDENCE (mutation tests run before filing the PR):
//   All mutations above were applied, the named test failed, and the mutation was reverted.
