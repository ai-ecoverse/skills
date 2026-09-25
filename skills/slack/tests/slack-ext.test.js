// Tests for skills/slack/scripts/slack-ext.jsh
//
// Run with:
//   tst <path-to-this-file>
//
// Strategy: compile the real source (removing the trailing `await main()` so
// it does not auto-execute), inject mock sliccy:* modules and a stub browser,
// then call the exported internal functions directly. This exercises the REAL
// code — no duplicated reimplementation that could silently diverge.
//
// Mutation verification is documented inline: each test names the mutation that
// would break it, and the section at the bottom records the verification matrix.

import test, { is, ok, not, fail } from 'tst';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as _argvMod from '../scripts/argv.js';
import * as _manifestDiffMod from '../scripts/manifest-diff.js';
import * as _gridMod from '../scripts/slack-ext-grid.js';

const SCRIPT = fileURLToPath(new URL('../scripts/slack-ext.jsh', import.meta.url));
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
 * @param {function} [opts.api]   (method, params) => body | undefined. Consulted
 *                                first; undefined falls through to the defaults.
 * @param {boolean} [opts.noTab]  browser.findTab finds no Slack tab.
 * @param {boolean} [opts.fakeTimers] replace setTimeout inside the script with
 *                                one that fires at once and records each delay
 *                                in h.sleeps (the read-back waits 5 s per retry).
 */
async function load(opts) {
  const calls = [];
  const sleeps = [];
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
      return opts.noTab ? null : fakeTab;
    },
    async localStorage(tab, key) {
      if (key === 'localConfig_v2') {
        return JSON.stringify({
          teams: {
            T06DUTYDQ: { token: 'xoxc-test-token' },
            // Org-level token, used by the Enterprise Grid (eg-*) commands.
            E06V3987PMY: { token: 'xoxc-test-org-token' },
          },
        });
      }
      return null;
    },
    async fetch(tab, url, fetchOpts) {
      const method = url.replace('/api/', '');
      const params = {};
      if (fetchOpts && typeof fetchOpts.body === 'string') {
        for (const [k, v] of new URLSearchParams(fetchOpts.body)) if (k !== 'token') params[k] = v;
      }
      calls.push({ method, opts: fetchOpts, params });

      if (opts.api) {
        const custom = opts.api(method, params);
        if (custom !== undefined) return { body: custom };
      }

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
      // enterprise.users.admin.* (Grid writes)
      if (method.startsWith('enterprise.users.admin.')) {
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
    die(message, options) {
      const code = options && typeof options === 'object' && options.exitCode !== undefined ? options.exitCode : 1;
      throw new NodeExitError(String(message), code);
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

  // Strip the trailing `await main()` so the module does not auto-execute
  let source = readFileSync(SCRIPT, 'utf8');
  // Anchor on the actual trailer (`try { await main(); }`), NOT on the first
  // top-level `try {` in the file. The greedy form truncated the module at the
  // first top-level try block, which silently discarded ~1800 lines and made
  // every test fail with '<fn> is not defined'.
  // opts.runMain compiles the file UNMODIFIED, so main() runs exactly as it does
  // when a user types the command. That is the only mode that can see a
  // top-level ordering bug such as a const read in its temporal dead zone.
  if (!opts.runMain) {
  source = source.replace(/\ntry \{\s*\n\s*await main\(\);[\s\S]*$/, '\n');

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
  cmdEgStatus,
  cmdEgSetRestricted,
};
`;
  }

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

  const scriptSetTimeout = opts.fakeTimers
    ? (fn, ms) => {
        sleeps.push(ms);
        Promise.resolve().then(fn);
        return 0;
      }
    : setTimeout;
  const factory = new AsyncFunction('require', 'process', 'console', 'setTimeout', source);
  let mod = null;
  let runError = null;
  try {
    mod = await factory(mockRequire, mockProcess, mockConsole, scriptSetTimeout);
  } catch (e) {
    if (!opts.runMain) throw e;
    runError = e;
  }

  return {
    mod,
    runError,
    calls,
    sleeps,
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
  is(userTypeLabel({ is_bot: false, is_restricted: false, is_ultra_restricted: false, deleted: false }), 'regular');
});

test('userTypeLabel: multi-channel guest', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  is(userTypeLabel({ is_bot: false, is_restricted: true, is_ultra_restricted: false, deleted: false }), 'multi-channel guest');
});

test('userTypeLabel: single-channel guest', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  is(userTypeLabel({ is_bot: false, is_restricted: true, is_ultra_restricted: true, deleted: false }), 'single-channel guest');
});

test('userTypeLabel: bot', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  is(userTypeLabel({ is_bot: true, is_restricted: false, is_ultra_restricted: false, deleted: false }), 'bot');
});

test('userTypeLabel: deactivated', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { userTypeLabel } = h.mod;
  is(userTypeLabel({ is_bot: false, is_restricted: false, is_ultra_restricted: false, deleted: true }), 'deactivated');
});

// ── Parameter name tests — these are the most safety-critical ─────────────────

test('buildSetUltraRestrictedParams uses "channel" (singular), not "channels"', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { buildSetUltraRestrictedParams } = h.mod;
  const params = buildSetUltraRestrictedParams('U123', 'C456', 'T789');

  // CRITICAL: the API requires `channel` (singular). Passing `channels` returns
  // invalid_arguments. Verified live 2026-09-18.
  is(params.channel, 'C456', 'must use "channel" (singular)');
  is(params.channels, undefined, 'must NOT have "channels" (plural)');
  is(params.user, 'U123');
  is(params.team_id, 'T789');
});

test('buildSetRestrictedParams includes user and team_id', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { buildSetRestrictedParams } = h.mod;
  const params = buildSetRestrictedParams('U123', 'T789');
  is(params.user, 'U123');
  is(params.team_id, 'T789');
  // setRestricted does NOT take a channel parameter
  is(params.channel, undefined);
});

test('buildSetRegularParams includes user and team_id', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { buildSetRegularParams } = h.mod;
  const params = buildSetRegularParams('U123', 'T789');
  is(params.user, 'U123');
  is(params.team_id, 'T789');
  is(params.channel, undefined);
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
  is(h.adminCalls().length, 0, 'no admin API call without --confirm');
  const text = h.text();
  ok(/no --confirm|nothing changed/i.test(text), 'should mention --confirm required');
});

test('set-multi without --confirm makes no admin API call', async () => {
  let h;
  try {
    h = await load({ argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345'] });
    await h.mod.cmdSetMulti();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  is(h.adminCalls().length, 0, 'no admin API call without --confirm');
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
  is(h.adminCalls().length, 0, 'no admin API call without --confirm');
});

test('add-channel without --confirm makes no mutating API call', async () => {
  let h;
  try {
    h = await load({ argv: ['--ws=T06DUTYDQ', 'add-channel', 'U12345', '--channel=C456'] });
    await h.mod.cmdAddChannel();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  is(h.mutatingCalls().length, 0, 'no mutating call without --confirm');
});

test('remove-channel without --confirm makes no mutating API call', async () => {
  let h;
  try {
    h = await load({ argv: ['--ws=T06DUTYDQ', 'remove-channel', 'U12345', '--channel=C456'] });
    await h.mod.cmdRemoveChannel();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) { /* ok */ } else throw e;
  }
  is(h.mutatingCalls().length, 0, 'no mutating call without --confirm');
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
  ok(err, 'should have thrown');
  is(err.name, 'NodeExitError');
  ok(/bot/i.test(err.message), 'error message should mention bot');
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
  ok(err, 'should have thrown');
  is(err.name, 'NodeExitError');
  ok(/bot/i.test(err.message), 'must match /bot/i');
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
  ok(err, 'should have thrown');
  is(err.name, 'NodeExitError');
  ok(/bot/i.test(err.message), 'must match /bot/i');
});

// ── Already-in-state tests ────────────────────────────────────────────────────


test('set-multi is no-op when user is already a multi-channel guest', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetMulti();
  is(h.adminCalls().length, 0, 'should not call setRestricted for already-MCG');
  ok(/no change needed/i.test(h.text()), 'must match /no change needed/i');
});

test('set-member is no-op when user is already a regular member', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-member', 'U12345', '--confirm'],
    user: { is_restricted: false, is_ultra_restricted: false, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetMember();
  is(h.adminCalls().length, 0, 'should not call setRegular for already-member');
  ok(/no change needed/i.test(h.text()), 'must match /no change needed/i');
});

// ── Confirmed mutation tests ──────────────────────────────────────────────────

test('set-single with --confirm calls users.admin.setUltraRestricted with channel (singular)', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm'],
  });
  await h.mod.cmdSetSingle();

  const adminCall = h.calls.find((c) => c.method === 'users.admin.setUltraRestricted');
  ok(adminCall, 'users.admin.setUltraRestricted must be called');

  // Verify the URLSearchParams body contains 'channel' (singular)
  const body = adminCall.opts && adminCall.opts.body;
  ok(body, 'call must have a body');
  ok(/channel=C456/.test(body), 'body must contain channel=C456');
  ok(!(/channels=/.test(body)), 'body must NOT contain channels= (plural)');
  ok(/user=U12345/.test(body), 'body must contain user=U12345');
  ok(/team_id=T06DUTYDQ/.test(body), 'body must contain team_id=T06DUTYDQ');
});

test('set-multi with --confirm calls users.admin.setRestricted', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-multi', 'U12345', '--confirm'],
  });
  await h.mod.cmdSetMulti();

  const adminCall = h.calls.find((c) => c.method === 'users.admin.setRestricted');
  ok(adminCall, 'users.admin.setRestricted must be called');
  const body = adminCall.opts && adminCall.opts.body;
  ok(/user=U12345/.test(body), 'must match /user=U12345/');
  ok(/team_id=T06DUTYDQ/.test(body), 'must match /team_id=T06DUTYDQ/');
});

test('set-member with --confirm calls users.admin.setRegular', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-member', 'U12345', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
  });
  await h.mod.cmdSetMember();

  const adminCall = h.calls.find((c) => c.method === 'users.admin.setRegular');
  ok(adminCall, 'users.admin.setRegular must be called');
  const body = adminCall.opts && adminCall.opts.body;
  ok(/user=U12345/.test(body), 'must match /user=U12345/');
  ok(/team_id=T06DUTYDQ/.test(body), 'must match /team_id=T06DUTYDQ/');
});

test('add-channel with --confirm calls conversations.invite', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'add-channel', 'U12345', '--channel=C456', '--confirm'],
  });
  await h.mod.cmdAddChannel();

  const inviteCall = h.calls.find((c) => c.method === 'conversations.invite');
  ok(inviteCall, 'conversations.invite must be called');
  const body = inviteCall.opts && inviteCall.opts.body;
  ok(/channel=C456/.test(body), 'must match /channel=C456/');
  ok(/users=U12345/.test(body), 'must match /users=U12345/');
});

test('remove-channel with --confirm calls conversations.kick', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'remove-channel', 'U12345', '--channel=C456', '--confirm'],
  });
  await h.mod.cmdRemoveChannel();

  const kickCall = h.calls.find((c) => c.method === 'conversations.kick');
  ok(kickCall, 'conversations.kick must be called');
  const body = kickCall.opts && kickCall.opts.body;
  ok(/channel=C456/.test(body), 'must match /channel=C456/');
  ok(/user=U12345/.test(body), 'must match /user=U12345/');
});

// ── parseArgv: BOOL_FLAGS includes confirm ────────────────────────────────────

test('parseArgv treats --confirm as a boolean flag (no value consumed)', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { parseArgv } = h.mod;

  // Without --confirm
  const a = parseArgv(['set-single', 'U1', '--channel=C2', '--ws=T3']);
  is(a.flags.confirm, undefined);

  // With --confirm as the last flag (no next token)
  const b = parseArgv(['set-single', 'U1', '--channel=C2', '--ws=T3', '--confirm']);
  is(b.flags.confirm, true);

  // With --confirm followed by a positional — must not consume the positional as value
  const c = parseArgv(['set-single', '--confirm', 'U1']);
  is(c.flags.confirm, true);
  is(c.positional, ['set-single', 'U1']);
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
//   Caught by: "set-single: guest already in B with --channel=B is a no-op"
//   NOTE: the original test here asserted the no-op from account type ALONE, with no
//   convs fixture, which is the very defect Codex finding 2 reported. It was removed;
//   the superseding test supplies the current channel and asserts the true no-op.
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

// ── Finding 1: --confirm=value bool normalization ─────────────────────────────

test('--confirm=false does NOT authorize a mutation (admin call must not happen)', async () => {
  // The string "false" is truthy; before the fix it bypassed the --confirm guard.
  // After the fix, --confirm=false is boolean false and the guard blocks the call.
  let h;
  try {
    h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm=false'],
    });
    await h.mod.cmdSetSingle();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) {
      /* expected: dry-run exit */
    } else {
      throw e;
    }
  }
  is(
    h.adminCalls().length,
    0,
    '--confirm=false must NOT issue the admin API call'
  );
});

test('--confirm=false dry-run still mentions what would happen', async () => {
  let h;
  try {
    h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm=false'],
    });
    await h.mod.cmdSetSingle();
  } catch (e) {
    if (e.name !== 'NodeExitError' || e.exitCode !== 0) throw e;
  }
  ok(
    /would change|no --confirm|nothing changed/i.test(h.text()),
    'dry-run output must describe the would-be change'
  );
});

test('--confirm=true (equals form) DOES authorize the mutation', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm=true'],
  });
  await h.mod.cmdSetSingle();
  is(
    h.adminCalls().length,
    1,
    '--confirm=true must issue the admin API call'
  );
});

test('--confirm=fasle (typo) is a fatal error, not an authorization', async () => {
  // A typo in the value must never authorize a mutation. It must be a fatal
  // error so the operator knows the flag was not understood.
  let err;
  try {
    await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm=fasle'],
    });
  } catch (e) {
    err = e;
  }
  ok(err, 'should have thrown an error');
  is(err.name, 'NodeExitError', 'must exit non-zero');
  ok(err.exitCode !== 0, 'exit code must be non-zero');
});

test('parseArgv: --confirm=false stores false (not truthy string "false")', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { parseArgv } = h.mod;
  const r = parseArgv(['set-single', 'U1', '--confirm=false']);
  is(r.flags.confirm, false, '--confirm=false must be stored as boolean false');
});

test('parseArgv: --confirm=true stores true', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { parseArgv } = h.mod;
  const r = parseArgv(['set-single', 'U1', '--confirm=true']);
  is(r.flags.confirm, true, '--confirm=true must be stored as boolean true');
});

test('parseArgv: --confirm=yes, --confirm=1, --confirm=on all store true', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { parseArgv } = h.mod;
  is(parseArgv(['x', '--confirm=yes']).flags.confirm, true);
  is(parseArgv(['x', '--confirm=1']).flags.confirm, true);
  is(parseArgv(['x', '--confirm=on']).flags.confirm, true);
});

test('parseArgv: --confirm=no, --confirm=0, --confirm=off all store false', async () => {
  const h = await load({ argv: ['status', 'U1'] });
  const { parseArgv } = h.mod;
  is(parseArgv(['x', '--confirm=no']).flags.confirm, false);
  is(parseArgv(['x', '--confirm=0']).flags.confirm, false);
  is(parseArgv(['x', '--confirm=off']).flags.confirm, false);
});

// ── Finding 2: set-single already-SCG channel comparison ─────────────────────

test('set-single: guest already in A with --channel=B attempts the change', async () => {
  // The guest is currently in C_OLD. We request C_NEW. This is a real change;
  // setUltraRestricted MUST be called.
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=CNEW', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: true, deleted: false, is_bot: false },
    convs: { ok: true, channels: [{ id: 'COLD', name: 'old-channel' }] },
  });
  await h.mod.cmdSetSingle();
  is(
    h.adminCalls().length,
    1,
    'must call setUltraRestricted when the requested channel differs from the current one'
  );
  const adminCall = h.calls.find((c) => c.method === 'users.admin.setUltraRestricted');
  ok(adminCall, 'call must be setUltraRestricted');
  ok(/channel=CNEW/.test(adminCall.opts.body), 'must use the new channel ID');
});

test('set-single: guest already in B with --channel=B is a no-op', async () => {
  // The guest is already in the exact same channel. This is a true no-op.
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=CSAME', '--confirm'],
    user: { is_restricted: true, is_ultra_restricted: true, deleted: false, is_bot: false },
    convs: { ok: true, channels: [{ id: 'CSAME', name: 'same-channel' }] },
  });
  await h.mod.cmdSetSingle();
  is(h.adminCalls().length, 0, 'must NOT call setUltraRestricted when channel unchanged');
  ok(/no change needed/i.test(h.text()), 'must say no change needed');
});

test('set-single: failed users.conversations lookup is fatal, not "no change needed"', async () => {
  // If we cannot determine the current channel, we must not claim anything about
  // the account state. Claiming "no change needed" on a failed API call is
  // dangerous — it could mask a real difference.
  let err;
  try {
    const h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=C456', '--confirm'],
      user: { is_restricted: true, is_ultra_restricted: true, deleted: false, is_bot: false },
      convs: { ok: false, error: 'enterprise_is_restricted' },
    });
    await h.mod.cmdSetSingle();
  } catch (e) {
    err = e;
  }
  ok(err, 'should have thrown');
  is(err.name, 'NodeExitError');
  // Must NOT print "no change needed" — that would be a false claim
  // (We can't check h.text() here since we don't have h in scope; the throw
  //  itself is the proof that the command did not silently succeed or no-op.)
});

test('set-single: channel-change path respects --confirm gate', async () => {
  // Even when a channel change is needed, the --confirm gate must block the call.
  let h;
  try {
    h = await load({
      argv: ['--ws=T06DUTYDQ', 'set-single', 'U12345', '--channel=CNEW'],
      user: { is_restricted: true, is_ultra_restricted: true, deleted: false, is_bot: false },
      convs: { ok: true, channels: [{ id: 'COLD', name: 'old-channel' }] },
    });
    await h.mod.cmdSetSingle();
  } catch (e) {
    if (e.name === 'NodeExitError' && e.exitCode === 0) {
      /* expected dry-run exit */
    } else {
      throw e;
    }
  }
  is(
    h.adminCalls().length,
    0,
    'channel-change path must still require --confirm'
  );
});

// ── Finding 3: cmdStatus users.conversations failure handling ─────────────────

test('status: failed users.conversations does NOT print "(none found)"', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'status', 'U12345'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
    convs: { ok: false, error: 'enterprise_is_restricted' },
  });
  await h.mod.cmdStatus();
  const out = h.text();
  ok(
    !/(none found)/i.test(out),
    'must NOT print "(none found)" when the API call failed'
  );
});

test('status: failed users.conversations prints the actual Slack error code', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'status', 'U12345'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
    convs: { ok: false, error: 'enterprise_is_restricted' },
  });
  await h.mod.cmdStatus();
  const out = h.text();
  ok(
    /enterprise_is_restricted/.test(out),
    'must print the actual Slack error code so the user knows what went wrong'
  );
});

test('status: success with zero channels prints a distinct empty-state message', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'status', 'U12345'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
    convs: { ok: true, channels: [] },
  });
  await h.mod.cmdStatus();
  const out = h.text();
  ok(
    !/(none found)/i.test(out),
    'empty-success path must use a different message from the old "(none found)" bucket'
  );
  // Should say something about "none" or "no channel" but NOT "(none found)"
  ok(
    /none|no channel/i.test(out),
    'should still describe the empty state'
  );
});

test('status --json: failed users.conversations produces channels_error in output', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'status', 'U12345', '--json'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
    convs: { ok: false, error: 'enterprise_is_restricted' },
  });
  await h.mod.cmdStatus();
  // Find the JSON line in stdout
  const jsonLine = h.stdout.find((l) => {
    try { JSON.parse(l); return true; } catch (e) { return false; }
  });
  ok(jsonLine, 'should have a JSON output line');
  const parsed = JSON.parse(jsonLine);
  ok(
    parsed.channels_error === 'enterprise_is_restricted',
    'channels_error must be present and equal to the Slack error code'
  );
});

test('status --json: success with channels produces channels array in output', async () => {
  const h = await load({
    argv: ['--ws=T06DUTYDQ', 'status', 'U12345', '--json'],
    user: { is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false },
    convs: { ok: true, channels: [{ id: 'C111', name: 'chan1' }] },
  });
  await h.mod.cmdStatus();
  const jsonLine = h.stdout.find((l) => {
    try { JSON.parse(l); return true; } catch (e) { return false; }
  });
  ok(jsonLine, 'should have JSON output');
  const parsed = JSON.parse(jsonLine);
  ok(Array.isArray(parsed.channels), 'channels must be an array in JSON output');
  is(parsed.channels[0].id, 'C111', 'channel id must match');
});

// ── Updated mutation matrix (additions for the three findings) ────────────────
//
// MUTATION 10: In parseArgv, do NOT normalize BOOL_FLAGS in the --name=value branch
//   (i.e. keep `f[m[1]] = m[2]` for all names, even bool ones)
//   Caught by: "--confirm=false does NOT authorize a mutation"
//              "parseArgv: --confirm=false stores false (not truthy string)"
//
// MUTATION 11: In parseArgv, accept --confirm=fasle (typo) silently as true
//   Caught by: "--confirm=fasle (typo) is a fatal error"
//
// MUTATION 12: In set-single, keep the old "return immediately on is_ultra_restricted"
//   without channel comparison
//   Caught by: "set-single: guest already in A with --channel=B attempts the change"
//
// MUTATION 13: In set-single, call users.conversations but skip the fatal-error branch
//   for !scgConv.ok (treat it as no change needed instead)
//   Caught by: "set-single: failed users.conversations lookup is fatal"
//
// MUTATION 14: In cmdStatus, collapse !ok and ok+empty back into a single else branch
//   Caught by: "status: failed users.conversations does NOT print (none found)"
//              "status: failed users.conversations prints the actual Slack error code"
//
// MUTATION 15: In cmdStatus, omit channels_error from the JSON output on failure
//   Caught by: "status --json: failed users.conversations produces channels_error"
//
// VERIFICATION: mutations 10-15 were each applied, the named test was confirmed to fail,
// then the mutation was reverted. See report for details.

// ── Entry-point ordering (temporal dead zone) ──────────────────────────────────
//
// Every eg-* and channel-* command once died on invocation with
// "Cannot access 'ORG_ID' before initialization": the `await main()` trailer sat
// above the Grid section, so main() ran before that section's top-level consts
// were initialised. All other tests missed it because they strip from the trailer
// to EOF, which removed the Grid section before compiling. These tests close that.

const ENTRY_TRAILER = /\ntry \{\s*\n\s*await main\(\);\s*\n\} catch \(err\) \{[\s\S]*?\n\}\n/;

test('entry point: nothing but whitespace follows the await main() trailer', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const m = ENTRY_TRAILER.exec(src);
  ok(m, 'the await main() trailer must exist');
  const after = src.slice(m.index + m[0].length);
  is(after.trim(), '', 'no top-level statement may follow the trailer (found: ' + after.trim().slice(0, 60) + ')');
});

test('entry point: every top-level const/let is declared before main() runs', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const m = ENTRY_TRAILER.exec(src);
  ok(m, 'the await main() trailer must exist');
  const late = src.slice(m.index).split('\n').filter((l) => /^(const|let) /.test(l));
  is(late.length, 0, 'top-level declarations after the trailer: ' + late.join(' | '));
});

test('eg-status runs end to end from the real entry point', async () => {
  const h = await load({ runMain: true, argv: ['eg-status', 'U12345'] });
  const msg = h.runError ? String(h.runError.message) : '';
  ok(!/before initialization/.test(msg), 'must not hit a temporal dead zone: ' + msg);
  ok(!h.runError || h.runError.exitCode === 0, 'must not exit non-zero: ' + msg);
  ok(h.apiCalls().includes('users.info'), 'must call users.info; calls were ' + h.apiCalls().join(','));
  ok(/Enterprise user: U12345/.test(h.text()), 'must print the enterprise user section');
});

test('eg-set-restricted from the real entry point makes no write without --confirm', async () => {
  const h = await load({ runMain: true, argv: ['eg-set-restricted', 'U12345'] });
  const msg = h.runError ? String(h.runError.message) : '';
  ok(!/before initialization/.test(msg), 'must not hit a temporal dead zone: ' + msg);
  const writes = h.calls.filter((c) => c.method.startsWith('enterprise.users.admin.'));
  is(writes.length, 0, 'dry run must make zero enterprise.users.admin.* calls');
});

test('eg-set-restricted --confirm reaches the Grid write method', async () => {
  // Control for the test above: proves the dry-run assertion is not vacuously
  // true because the command never got far enough to write at all.
  const h = await load({ runMain: true, argv: ['eg-set-restricted', 'U12345', '--confirm'] });
  const msg = h.runError ? String(h.runError.message) : '';
  ok(!/before initialization/.test(msg), 'must not hit a temporal dead zone: ' + msg);
  ok(
    h.apiCalls().includes('enterprise.users.admin.setRestricted'),
    'with --confirm the write must be issued; calls were ' + h.apiCalls().join(',')
  );
});

test('the stripped harness now includes Grid code', async () => {
  const h = await load({ argv: ['eg-status', 'U12345'] });
  is(typeof h.mod.cmdEgStatus, 'function', 'cmdEgStatus must survive the strip');
  await h.mod.cmdEgStatus();
  ok(/Enterprise user: U12345/.test(h.text()), 'cmdEgStatus must print the enterprise user section');
});

// ── channel-archive / channel-unarchive through the real entry point ──────────
//
// runMain: the file is compiled UNMODIFIED and main() dispatches the command
// exactly as a user typing it would. opts.api answers the Slack methods;
// opts.fakeTimers makes the 5 s read-back delay instant and records it.

const ARCH_NOW = Date.now();
const archChan = (over) =>
  Object.assign(
    {
      id: 'C04633RSEDU',
      name: 'assets-adidas',
      is_private: true,
      is_archived: false,
      member_count: 6,
      external_user_count: 0,
      is_ext_shared: false,
      is_pending_ext_shared: false,
      is_org_shared: false,
      // 1282 days ago, in MICROSECONDS as on the wire
      last_activity_ts: (ARCH_NOW - 1282 * 86400000 - 3600000) * 1000,
    },
    over || {}
  );

// states: channel per admin.conversations.search call (the last one repeats).
function archApi(states, extra) {
  let n = 0;
  const x = extra || {};
  return (method, params) => {
    if (method === 'admin.conversations.search') {
      const st = states[Math.min(n, states.length - 1)];
      n += 1;
      return { ok: true, conversations: st ? [st] : [], next_cursor: '' };
    }
    if (method === 'conversations.info') return { ok: false, error: 'channel_not_found' };
    if (method === 'admin.conversations.archive' || method === 'admin.conversations.unarchive') {
      return x.writeResult || { ok: true };
    }
    return undefined;
  };
}

const ARCH_WRITES = ['admin.conversations.archive', 'admin.conversations.unarchive'];
const archWrites = (h) => h.calls.filter((c) => ARCH_WRITES.includes(c.method)).length;
const archSeq = (h) => h.apiCalls().join(',');
const exitOf = (h) => (h.runError ? h.runError.exitCode : 0);
const errOf = (h) => (h.runError ? String(h.runError.message) : '');

// --json contract: stdout is exactly ONE JSON document and nothing else. The
// whole of stdout must parse; a human line anywhere breaks the parse.
function onlyJson(h) {
  is(h.stdout.length, 1, 'stdout must hold exactly one write in --json mode, got ' + h.stdout.length + ': ' + JSON.stringify(h.stdout).slice(0, 300));
  const whole = h.stdout.join('\n');
  let parsed = null;
  try {
    parsed = JSON.parse(whole);
  } catch (e) {
    fail('entire stdout must parse as JSON: ' + e.message + ' -- stdout was: ' + whole.slice(0, 300));
  }
  ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'stdout must be a JSON object');
  return parsed;
}

test('channel-archive dry run (entry point): reads state, prints it, makes no write', async () => {
  const h = await load({ runMain: true, fakeTimers: true, argv: ['channel-archive', 'C04633RSEDU'], api: archApi([archChan()]) });
  is(errOf(h), '');
  is(exitOf(h), 0);
  is(archSeq(h), 'admin.conversations.search');
  is(archWrites(h), 0);
  const t = h.text();
  ok(/#assets-adidas \(C04633RSEDU\)/.test(t), 'prints name and id');
  ok(/Visibility:\s+private/.test(t), 'prints visibility');
  ok(/Archived:\s+no/.test(t), 'prints archived state');
  ok(/Members:\s+6/.test(t), 'prints member count');
  ok(/External:\s+0 users/.test(t), 'prints external users');
  ok(/Shared:\s+not ext-shared/.test(t), 'prints sharing');
  ok(/Last activity: \d{4}-\d{2}-\d{2} \(1282 days idle\)/.test(t), 'prints date and days idle');
  ok(/--confirm would: re-read this channel/.test(t), 'says what --confirm would do');
  ok(/indistinguishable from a direct human action/.test(t), 'attribution notice');
});

test('channel-archive dry run (entry point) with --max-members=2 shows the members-over-limit refusal', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--max-members=2'], api: archApi([archChan()]) });
  is(exitOf(h), 0);
  is(archWrites(h), 0);
  ok(/--confirm would REFUSE: members-over-limit \(6 members > --max-members=2\)/.test(h.text()), h.text());
});

test('channel-archive --confirm (entry point): re-check, archive, read-back, confirmed', async () => {
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm', '--max-members=10', '--min-idle-days=365'],
    api: archApi([archChan(), archChan({ is_archived: true, member_count: -1 })]),
  });
  is(errOf(h), '');
  is(archSeq(h), 'admin.conversations.search,admin.conversations.archive,admin.conversations.search');
  const w = h.calls.find((c) => c.method === 'admin.conversations.archive');
  is(JSON.stringify(w.params), '{"channel_id":"C04633RSEDU"}');
  ok(/archived \(confirmed\)/.test(h.text()));
});

test('channel-archive --confirm uses the ORG token, not a workspace token', async () => {
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm'],
    api: archApi([archChan(), archChan({ is_archived: true })]),
  });
  const w = h.calls.find((c) => c.method === 'admin.conversations.archive');
  is(new URLSearchParams(w.opts.body).get('token'), 'xoxc-test-org-token');
});

test('channel-archive --confirm members-over-limit (entry point): exit 1, named, no write', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--confirm', '--max-members=2'], api: archApi([archChan()]) });
  is(exitOf(h), 1);
  ok(/refused: members-over-limit/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive --confirm members-unknown (entry point): null count refused, no write', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm', '--max-members=100'],
    api: archApi([archChan({ member_count: null })]),
  });
  is(exitOf(h), 1);
  ok(/refused: members-unknown/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive --confirm already-archived (entry point): exit 0, no write', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C0634KMGW2G', '--confirm'],
    api: archApi([archChan({ id: 'C0634KMGW2G', name: 'aem-axeno1', is_private: false, is_archived: true, member_count: -1 })]),
  });
  is(errOf(h), '');
  is(exitOf(h), 0);
  is(archSeq(h), 'admin.conversations.search');
  ok(/already-archived: nothing to do/.test(h.text()));
});

test('channel-archive --confirm read-back exhausted (entry point): unconfirmed, exit 3, 10 s apart', async () => {
  const h = await load({ runMain: true, fakeTimers: true, argv: ['channel-archive', 'C04633RSEDU', '--confirm'], api: archApi([archChan()]) });
  is(exitOf(h), 3);
  is(archWrites(h), 1);
  ok(/archived \(unconfirmed: search index did not reflect it after 10 attempts\)/.test(h.text()), h.text());
  is(h.sleeps.join(','), '10000,10000,10000,10000,10000,10000,10000,10000,10000');
});

test('channel-archive --confirm read-back lag (entry point): confirms on a later attempt', async () => {
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm'],
    api: archApi([archChan(), archChan(), archChan({ is_archived: true })]),
  });
  is(exitOf(h), 0);
  is(archSeq(h), 'admin.conversations.search,admin.conversations.archive,admin.conversations.search,admin.conversations.search');
  is(h.sleeps.join(','), '10000');
  ok(/after 2 attempt/.test(h.text()));
});

test('channel-archive --confirm not-found (entry point): exit 1, named, no write', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C0NOTHERE01', '--confirm'], api: archApi([null]) });
  is(exitOf(h), 1);
  ok(/refused: not-found/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive --confirm write error (entry point): API error surfaced, exit 1', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm'],
    api: archApi([archChan()], { writeResult: { ok: false, error: 'restricted_action' } }),
  });
  is(exitOf(h), 1);
  ok(/admin.conversations.archive failed: restricted_action/.test(errOf(h)), errOf(h));
});

test('channel-archive --json (entry point) emits the result object', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--json'], api: archApi([archChan()]) });
  const j = onlyJson(h);
  is(j.mode, 'dry-run');
  is(j.state.member_count, 6);
  is(j.decision.outcome, 'proceed');
});

test('channel-archive rejects a malformed --max-members before any API call', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--max-members=lots', '--confirm'], api: archApi([archChan()]) });
  is(exitOf(h), 1);
  ok(/--max-members needs a non-negative integer/.test(errOf(h)), errOf(h));
  is(h.calls.length, 0);
});

test('channel-unarchive --confirm (entry point): re-check, unarchive, read-back', async () => {
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['channel-unarchive', 'C0634KMGW2G', '--confirm'],
    api: archApi([archChan({ id: 'C0634KMGW2G', is_archived: true }), archChan({ id: 'C0634KMGW2G', is_archived: false })]),
  });
  is(errOf(h), '');
  is(archSeq(h), 'admin.conversations.search,admin.conversations.unarchive,admin.conversations.search');
  ok(/unarchived \(confirmed\)/.test(h.text()));
});

test('channel-unarchive dry run (entry point): no write; --max-members is refused as archive-only', async () => {
  const dry = await load({ runMain: true, argv: ['channel-unarchive', 'C0634KMGW2G'], api: archApi([archChan({ id: 'C0634KMGW2G', is_archived: true })]) });
  is(exitOf(dry), 0);
  is(archWrites(dry), 0);
  const bad = await load({ runMain: true, argv: ['channel-unarchive', 'C0634KMGW2G', '--max-members=1'], api: archApi([archChan()]) });
  is(exitOf(bad), 1);
  is(bad.calls.length, 0);
});

test('help lists channel-archive and channel-unarchive', async () => {
  const h = await load({ runMain: true, argv: ['--help'] });
  ok(/channel-archive <channel_id>/.test(h.text()));
  ok(/channel-unarchive <channel_id>/.test(h.text()));
});

// ── member_count -1 and Slack Connect channels through the real entry point ────

const connectArch = (over) =>
  archChan(
    Object.assign(
      {
        id: 'C03GXBSC72T',
        name: 'aem-pga-tour',
        is_private: false,
        member_count: 116,
        external_user_count: 41,
        is_ext_shared: true,
        conversation_host_id: 'E06V3987PMY',
        context_team_id: 'T0385CHDU9E',
        connected_team_ids: ['T0BQQL6FJ', 'E06V3987PMY', 'E08CP5WPXGT'],
        pending_connected_team_ids: [],
        internal_team_ids: ['T0385CHDU9E'],
      },
      over || {}
    )
  );

test('channel-archive --confirm (entry point): ACTIVE channel with member_count -1 refused members-unknown', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm', '--max-members=50'],
    api: archApi([archChan({ is_archived: false, member_count: -1 })]),
  });
  is(exitOf(h), 1);
  ok(/refused: members-unknown/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive --confirm (entry point): ARCHIVED channel with -1 and --max-members is already-archived, exit 0', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C0634KMGW2G', '--confirm', '--max-members=2'],
    api: archApi([archChan({ id: 'C0634KMGW2G', is_archived: true, member_count: -1 })]),
  });
  is(errOf(h), '');
  is(exitOf(h), 0);
  ok(/already-archived: nothing to do/.test(h.text()));
  is(archWrites(h), 0);
});

test('channel-archive dry run (entry point) on a Slack Connect channel: refusal names the disconnect', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C03GXBSC72T'], api: archApi([connectArch()]) });
  is(exitOf(h), 0);
  is(archWrites(h), 0);
  const t = h.text();
  ok(/--confirm would REFUSE: ext-shared-requires-allow-shared/.test(t), t);
  ok(/disconnect 41 external users from 2 external organisations/.test(t), t);
});

test('channel-archive dry run --allow-shared (entry point): plain-words warning, still no write', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C03GXBSC72T', '--allow-shared'], api: archApi([connectArch()]) });
  is(exitOf(h), 0);
  is(archWrites(h), 0);
  const t = h.text();
  ok(/WARNING: Archiving will disconnect 41 external users from 2 external organisations \(T0BQQL6FJ, E08CP5WPXGT\)/.test(t), t);
  ok(/Unarchiving will NOT reconnect them/.test(t), t);
  ok(/--confirm would: re-read this channel/.test(t), t);
});

test('channel-archive --confirm without --allow-shared (entry point): Slack Connect channel refused, no write', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C03GXBSC72T', '--confirm'], api: archApi([connectArch()]) });
  is(exitOf(h), 1);
  ok(/refused: ext-shared-requires-allow-shared/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive --confirm --allow-shared (entry point): archives, says what it disconnected, reads sharing back', async () => {
  // The measured post-archive row (5 of 5): flags false, 0 external users, no connected
  // teams. Whether conversation_host_id survives an archive was not measured; see the
  // next test for a row that keeps it.
  const after = connectArch({ is_archived: true, member_count: -1, is_ext_shared: false, external_user_count: 0, connected_team_ids: [], conversation_host_id: undefined });
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['channel-archive', 'C03GXBSC72T', '--confirm', '--allow-shared'],
    api: archApi([connectArch(), after]),
  });
  is(errOf(h), '');
  is(archSeq(h), 'admin.conversations.search,admin.conversations.archive,admin.conversations.search');
  const t = h.text();
  ok(/--allow-shared given\. Archiving will disconnect 41 external users from 2 external organisations/.test(t), t);
  ok(/Unarchiving will NOT reconnect them/.test(t), t);
  ok(/Shared now:\s+not ext-shared/.test(t), t);
});

test('channel-unarchive dry run (entry point) warns that connections are not restored', async () => {
  const h = await load({ runMain: true, argv: ['channel-unarchive', 'C0634KMGW2G'], api: archApi([archChan({ id: 'C0634KMGW2G', is_archived: true })]) });
  is(exitOf(h), 0);
  ok(/unarchiving is not expected to reconnect them/.test(h.text()), h.text());
});

// ── An incomplete read is a failure, never "not found" (entry point) ──────────

test('channel-archive (entry point): ok:true body without conversations fails, not not-found', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm'],
    api: (m) => (m === 'admin.conversations.search' ? { ok: true } : undefined),
  });
  is(exitOf(h), 1);
  ok(/channel lookup failed \(malformed_response\)/.test(errOf(h)), errOf(h));
  ok(!/not-found/.test(errOf(h)), 'must not be reported as not-found');
  is(archWrites(h), 0);
});

test('channel-archive (entry point): a missing response body fails, not not-found', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU'],
    api: (m) => (m === 'admin.conversations.search' ? null : undefined),
  });
  is(exitOf(h), 1);
  ok(/channel lookup failed \(xhr_error\)/.test(errOf(h)), errOf(h));
  ok(!/not-found/.test(errOf(h)));
});

test('channel-archive --json (entry point): a failed lookup still emits a JSON result', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--json'],
    api: (m) => (m === 'admin.conversations.search' ? { ok: true } : undefined),
  });
  is(exitOf(h), 1);
  const j = onlyJson(h);
  is(j.status, 'read-error');
  is(j.state, null);
  is(j.decision, null);
});

test('channel-archive --json (entry point): a genuine not-found also emits JSON', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C0NOTHERE01', '--json'], api: archApi([null]) });
  is(exitOf(h), 0);
  const j = onlyJson(h);
  is(j.decision.reason, 'not-found');
});

// ── P1: misspelled or invalid guard flags fail CLOSED, before any Slack call ──
//
// parseArgv keeps unknown flags. The command used to read only the correctly
// spelled keys, so --max-member=2 left the guard null and a confirmed archive
// went ahead without it. Every case below must exit non-zero with a named
// error and make ZERO Slack API calls, on the dry run and with --confirm.

const REFUSED_ARGS = [
  ['--max-member=2', ['--max-member=2'], /unknown-flag: --max-member \(did you mean --max-members\?\)/],
  ['--min-idle-day=180', ['--min-idle-day=180'], /unknown-flag: --min-idle-day \(did you mean --min-idle-days\?\)/],
  ['--allowshared', ['--allowshared'], /unknown-flag: --allowshared \(did you mean --allow-shared\?\)/],
  ['--max-members=abc', ['--max-members=abc'], /invalid-value: --max-members needs a non-negative integer, got "abc"/],
  ['--max-members= (empty)', ['--max-members='], /invalid-value: --max-members needs a non-negative integer, got ""/],
  ['--min-idle-days=-3', ['--min-idle-days=-3'], /invalid-value: --min-idle-days needs a non-negative integer, got "-3"/],
  ['--max-members (no value)', ['--max-members'], /invalid-value: --max-members needs a non-negative integer, got \(no value\)/],
  ['--max-members=2.5', ['--max-members=2.5'], /invalid-value: --max-members/],
  ['--confrm (typo of --confirm)', ['--confrm'], /unknown-flag: --confrm \(did you mean --confirm\?\)/],
  ['stray positional max-members=2', ['max-members=2'], /unexpected-argument: "max-members=2"/],
];

for (const [label, extra, want] of REFUSED_ARGS) {
  for (const confirm of [true, false]) {
    test('channel-archive ' + label + (confirm ? ' --confirm' : ' (dry run)') + ' (entry point): refused, no Slack call', async () => {
      const argv = ['channel-archive', 'C04633RSEDU'].concat(extra, confirm ? ['--confirm'] : []);
      const h = await load({ runMain: true, fakeTimers: true, argv, api: archApi([archChan(), archChan({ is_archived: true })]) });
      ok(exitOf(h) !== 0, 'must exit non-zero, got ' + exitOf(h));
      ok(want.test(errOf(h)), 'named error expected, got: ' + errOf(h));
      is(h.calls.length, 0, 'no Slack call may be made; calls were ' + archSeq(h));
    });
  }
}

test('channel-archive --allowshared before the id (entry point): refused, the id is not silently swallowed', async () => {
  // parseArgv hands the next word to an unknown flag as its value.
  const h = await load({ runMain: true, argv: ['channel-archive', '--allowshared', 'C04633RSEDU', '--confirm'], api: archApi([archChan()]) });
  ok(exitOf(h) !== 0);
  ok(/unknown-flag: --allowshared/.test(errOf(h)), errOf(h));
  is(h.calls.length, 0);
});

test('channel-unarchive --confrm / --max-members (entry point): refused, no Slack call', async () => {
  const a = await load({ runMain: true, argv: ['channel-unarchive', 'C0634KMGW2G', '--confrm'], api: archApi([archChan({ is_archived: true })]) });
  ok(/unknown-flag: --confrm \(did you mean --confirm\?\)/.test(errOf(a)), errOf(a));
  is(a.calls.length, 0);
  const b = await load({ runMain: true, argv: ['channel-unarchive', 'C0634KMGW2G', '--max-members=2', '--confirm'], api: archApi([archChan({ is_archived: true })]) });
  ok(/archive-only-flag: --max-members applies to channel-archive only/.test(errOf(b)), errOf(b));
  is(b.calls.length, 0);
});

test('channel-archive correctly spelled guards --confirm (entry point): CONTROL, proceeds to the write', async () => {
  // Proves the refusals above are not vacuous: the same argv shape with the
  // right spelling gets as far as the archive call.
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['--ws=T0385CHDU9E', 'channel-archive', 'C04633RSEDU', '--max-members=10', '--min-idle-days=180', '--allow-shared', '--confirm', '--org=E06V3987PMY'],
    api: archApi([archChan(), archChan({ is_archived: true })]),
  });
  is(errOf(h), '');
  is(archSeq(h), 'admin.conversations.search,admin.conversations.archive,admin.conversations.search');
});

test('channel-archive correctly spelled guards, dry run (entry point): CONTROL, reads state', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--max-members=10', '--min-idle-days=180'], api: archApi([archChan()]) });
  is(exitOf(h), 0);
  is(archSeq(h), 'admin.conversations.search');
});

// ── P2: --json writes exactly one JSON document to stdout, on every path ──────

const JSON_PATHS = [
  ['dry run, proceed', ['channel-archive', 'C04633RSEDU'], [archChan()], {}, 0, 'dry-run'],
  ['dry run, would refuse', ['channel-archive', 'C04633RSEDU', '--max-members=2'], [archChan()], {}, 0, 'dry-run'],
  ['confirm, refused', ['channel-archive', 'C04633RSEDU', '--confirm', '--max-members=2'], [archChan()], {}, 1, 'refused'],
  ['confirm, already-archived', ['channel-archive', 'C04633RSEDU', '--confirm'], [archChan({ is_archived: true, member_count: -1 })], {}, 0, 'already-archived'],
  ['confirm, success', ['channel-archive', 'C04633RSEDU', '--confirm'], [archChan(), archChan({ is_archived: true })], {}, 0, 'archived (confirmed)'],
  ['confirm, unconfirmed', ['channel-archive', 'C04633RSEDU', '--confirm'], [archChan()], {}, 3, 'archived (unconfirmed: search index did not reflect it after 10 attempts)'],
  ['confirm, write error', ['channel-archive', 'C04633RSEDU', '--confirm'], [archChan()], { writeResult: { ok: false, error: 'restricted_action' } }, 1, 'error'],
  ['dry run, not-found', ['channel-archive', 'C0NOTHERE01'], [null], {}, 0, 'dry-run'],
  ['unarchive, success', ['channel-unarchive', 'C04633RSEDU', '--confirm'], [archChan({ is_archived: true }), archChan()], {}, 0, 'unarchived (confirmed)'],
  ['unknown flag', ['channel-archive', 'C04633RSEDU', '--max-member=2', '--confirm'], [archChan()], {}, 1, 'unknown-flag'],
  ['invalid value', ['channel-archive', 'C04633RSEDU', '--min-idle-days=-3'], [archChan()], {}, 1, 'invalid-value'],
  ['missing channel id', ['channel-archive'], [archChan()], {}, 1, 'usage'],
  ['invalid channel id', ['channel-archive', 'not-an-id'], [archChan()], {}, 1, 'usage'],
  ['invalid --org', ['channel-archive', 'C04633RSEDU', '--org=bogus'], [archChan()], {}, 1, 'invalid-value'],
];

for (const [label, argv, states, extra, code, status] of JSON_PATHS) {
  test('--json ' + label + ' (entry point): entire stdout is one JSON document', async () => {
    const h = await load({ runMain: true, fakeTimers: true, argv: argv.concat(['--json']), api: archApi(states, extra) });
    is(exitOf(h), code, 'exit code; error was: ' + errOf(h));
    const j = onlyJson(h);
    is(j.status, status);
    is(j.exitCode, code);
    is(j.notice, 'xoxc session call: indistinguishable from a direct human action in channel event history.');
  });
}

test('--json read-error (entry point): entire stdout is one JSON document', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--json'], api: (m) => (m === 'admin.conversations.search' ? { ok: true } : undefined) });
  is(exitOf(h), 1);
  const j = onlyJson(h);
  is(j.status, 'read-error');
  ok(/malformed_response/.test(j.error), j.error);
});

test('--json with no Slack tab (entry point): entire stdout is one JSON document', async () => {
  const h = await load({ runMain: true, noTab: true, argv: ['channel-archive', 'C04633RSEDU', '--json'], api: archApi([archChan()]) });
  is(exitOf(h), 1);
  const j = onlyJson(h);
  is(j.status, 'no-slack-tab');
  is(h.calls.length, 0);
});

test('--json unknown flag lists every error with its suggestion', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--max-member=2', '--allowshared', '--json'], api: archApi([archChan()]) });
  const j = onlyJson(h);
  is(j.status, 'unknown-flag');
  is(j.errors.map((e) => e.flag + '>' + e.suggestion).join(','), '--max-member>--max-members,--allowshared>--allow-shared');
  is(h.calls.length, 0);
});

test('without --json the human output is unchanged (attribution notice still printed)', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU'], api: archApi([archChan()]) });
  ok(/indistinguishable from a direct human action/.test(h.text()));
  ok(/Dry run: channel-archive/.test(h.text()));
  ok(h.stdout.length > 5);
});

// MUTATION M6 (allow-list disabled): in checkChannelArchiveArgs, skip the
//   unknown-flag push. Caught by every "channel-archive --max-member=2 ...",
//   "--min-idle-day=180 ...", "--allowshared ...", "--confrm ..." test, and
//   "--json unknown flag ...".
// MUTATION M7 (a human line in JSON mode): print the attribution line with
//   console.log instead of say(). Caught by every "--json ... entire stdout is
//   one JSON document" test that reaches the flow.

// ── Codex round 2 (P2): a parseArgv failure in --json mode still emits JSON ────
//
// parseArgv throws at module init for a malformed boolean (e.g.
// --allow-shared=maybe), before any command runs. The top-level catch now emits
// the JSON error document for channel-archive / channel-unarchive.

const PARSE_FAILURES = [
  ['--allow-shared=maybe', ['channel-archive', 'C04633RSEDU', '--allow-shared=maybe', '--json'], 'archive'],
  ['--confirm=fasle', ['channel-archive', 'C04633RSEDU', '--confirm=fasle', '--json'], 'archive'],
  ['unarchive --confirm=maybe', ['channel-unarchive', 'C0634KMGW2G', '--confirm=maybe', '--json'], 'unarchive'],
  ['--json=true form', ['--ws=T0385CHDU9E', 'channel-archive', 'C04633RSEDU', '--allow-shared=2', '--json=true'], 'archive'],
];

for (const [label, argv, action] of PARSE_FAILURES) {
  test('--json parse failure ' + label + ' (entry point): entire stdout is one JSON document, no Slack call', async () => {
    const h = await load({ runMain: true, argv, api: archApi([archChan()]) });
    is(exitOf(h), 1);
    ok(/is not a valid boolean value/.test(errOf(h)), errOf(h));
    const j = onlyJson(h);
    is(j.status, 'invalid-value');
    is(j.action, action);
    ok(/^invalid-value: --[a-z-]+=\S+ is not a valid boolean value/.test(j.error), j.error);
    is(j.exitCode, 1);
    is(j.notice, 'xoxc session call: indistinguishable from a direct human action in channel event history.');
    is(h.calls.length, 0);
  });
}

test('parse failure WITHOUT --json (entry point): plain error only, nothing on stdout', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--allow-shared=maybe'], api: archApi([archChan()]) });
  is(exitOf(h), 1);
  is(h.stdout.length, 0);
  is(h.calls.length, 0);
});

test('parse failure on another command with --json is unchanged (scope: archive commands only)', async () => {
  const h = await load({ runMain: true, argv: ['eg-status', 'U12345', '--confirm=fasle', '--json'] });
  is(exitOf(h), 1);
  is(h.stdout.length, 0);
});

// MUTATION M8 (parse failure answered in text only): in the top-level
//   parseArgv catch, drop the jsonInvocation / cli.out block. Caught by every
//   "--json parse failure ... entire stdout is one JSON document" test.

// ── Codex round 3 (P1): missing sharing flags fail closed (entry point) ────────

test('channel-archive --confirm --allow-shared (entry point): missing is_ext_shared refused sharing-unknown, no write', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm', '--allow-shared'],
    api: archApi([archChan({ is_ext_shared: undefined })]),
  });
  is(exitOf(h), 1);
  ok(/refused: sharing-unknown/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive dry run --json (entry point): missing is_pending_ext_shared reported as would-refuse sharing-unknown', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C04633RSEDU', '--json'], api: archApi([archChan({ is_pending_ext_shared: undefined })]) });
  is(exitOf(h), 0);
  const j = onlyJson(h);
  is(j.decision.reason, 'sharing-unknown');
  is(j.state.host, 'sharing-unknown');
  is(archWrites(h), 0);
});

test('channel-unarchive --confirm (entry point): missing sharing flags refused sharing-unknown, no write', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-unarchive', 'C0634KMGW2G', '--confirm'],
    api: archApi([archChan({ id: 'C0634KMGW2G', is_archived: true, is_ext_shared: 'false' })]),
  });
  is(exitOf(h), 1);
  ok(/refused: sharing-unknown/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

// ── Codex round 4 (P2): malformed conversations.info fallback (entry point) ────

test('channel-archive --confirm (entry point): search miss + conversations.info {ok:true} fails, not not-found', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm'],
    api: (m) =>
      m === 'admin.conversations.search'
        ? { ok: true, conversations: [], next_cursor: '' }
        : m === 'conversations.info'
          ? { ok: true }
          : undefined,
  });
  is(exitOf(h), 1);
  ok(/channel lookup failed \(conversations\.info: malformed_response\)/.test(errOf(h)), errOf(h));
  ok(!/not-found/.test(errOf(h)));
  is(archWrites(h), 0);
});

test('channel-archive --json (entry point): malformed conversations.info is a read-error JSON document', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--json'],
    api: (m) =>
      m === 'admin.conversations.search'
        ? { ok: true, conversations: [], next_cursor: '' }
        : m === 'conversations.info'
          ? { ok: true, channel: { id: 'C04633RSEDU' } }
          : undefined,
  });
  is(exitOf(h), 1);
  const j = onlyJson(h);
  is(j.status, 'read-error');
  ok(/conversations\.info: malformed_response/.test(j.error), j.error);
});

// ── Codex round 5 (P2): missing connected-team lists (entry point) ────────────

test('channel-archive dry run --allow-shared (entry point): missing connected_team_ids warns "unknown", never 0', async () => {
  const h = await load({ runMain: true, argv: ['channel-archive', 'C03GXBSC72T', '--allow-shared'], api: archApi([connectArch({ connected_team_ids: undefined })]) });
  is(exitOf(h), 0);
  const t = h.text();
  ok(/WARNING: Archiving will disconnect 41 external users from an unknown number of external organisations/.test(t), t);
  ok(/could not be determined/.test(t), t);
  ok(!/0 external organisations/.test(t), t);
  ok(/unknown number of external orgs/.test(t), 'the Shared: line says unknown too');
  is(archWrites(h), 0);
});

test('channel-archive --json dry run (entry point): impact.external_team_ids is null, not []', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C03GXBSC72T', '--allow-shared', '--json'],
    api: archApi([connectArch({ connected_team_ids: undefined, pending_connected_team_ids: 'bogus' })]),
  });
  const j = onlyJson(h);
  is(j.impact.external_team_ids, null);
  is(j.impact.pending_external_team_ids, null);
  is(j.state.external_team_ids, null);
});

// ── Codex round 6 (P2): a truthy non-boolean ok never authorizes an archive ────

test('channel-archive --confirm (entry point): search {ok:"false"} with a matching row fails closed, no archive call', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm'],
    api: (m) => (m === 'admin.conversations.search' ? { ok: 'false', conversations: [archChan()], next_cursor: '' } : undefined),
  });
  is(exitOf(h), 1);
  ok(/channel lookup failed \(malformed_response\)/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive --json (entry point): search {ok:"false"} is a read-error JSON document', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--json'],
    api: (m) => (m === 'admin.conversations.search' ? { ok: 'false', conversations: [archChan()], next_cursor: '' } : undefined),
  });
  is(exitOf(h), 1);
  const j = onlyJson(h);
  is(j.status, 'read-error');
  is(j.state, null);
});

// ── Codex round 7 (P1): contradictory Slack Connect metadata (entry point) ────

test('channel-archive --confirm --allow-shared (entry point): flags false but external users + host id -> refused sharing-unknown, no write', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--confirm', '--allow-shared'],
    api: archApi([archChan({ is_ext_shared: false, is_pending_ext_shared: false, external_user_count: 3, conversation_host_id: 'E06V3987PMY' })]),
  });
  is(exitOf(h), 1);
  ok(/refused: sharing-unknown \(is_ext_shared and is_pending_ext_shared are false, but the same row reports external_user_count 3/.test(errOf(h)), errOf(h));
  is(archWrites(h), 0);
});

test('channel-archive dry run --json (entry point): contradictory row reports sharing-unknown with its evidence', async () => {
  const h = await load({
    runMain: true,
    argv: ['channel-archive', 'C04633RSEDU', '--json'],
    api: archApi([archChan({ connected_team_ids: ['T04650MFY', 'E06V3987PMY'] })]),
  });
  const j = onlyJson(h);
  is(j.decision.reason, 'sharing-unknown');
  is(j.state.sharing_conflicts.join('|'), 'external connected_team_ids T04650MFY');
});

test('channel-archive --confirm --allow-shared (entry point): a read-back row that keeps conversation_host_id prints Shared now UNKNOWN', async () => {
  const after = connectArch({ is_archived: true, member_count: -1, is_ext_shared: false, external_user_count: 0, connected_team_ids: [] });
  const h = await load({
    runMain: true,
    fakeTimers: true,
    argv: ['channel-archive', 'C03GXBSC72T', '--confirm', '--allow-shared'],
    api: archApi([connectArch(), after]),
  });
  is(errOf(h), '');
  ok(/archived \(confirmed\)/.test(h.text()));
  ok(/Shared now:\s+UNKNOWN \(flags say not shared, but the row reports conversation_host_id E06V3987PMY\)/.test(h.text()), h.text());
});
