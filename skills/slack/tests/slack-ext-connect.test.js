// Tests for the Slack Connect invite commands in skills/slack/scripts/slack-ext.jsh:
//   guest-invite, connect-revoke, approvals --detail / approvals show.
//
// Run with:
//   tst <path-to-this-file>
//
// Same strategy as slack-ext.test.js: compile the REAL .jsh unmodified (so
// main() dispatches exactly as a user's command line would), inject mock
// sliccy:* modules and a stub browser whose fetch plays the Slack API. Every id,
// name and address here is a fake.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';
import * as _argvMod from '../scripts/argv.js';
import * as _manifestDiffMod from '../scripts/manifest-diff.js';
import * as _gridMod from '../scripts/slack-ext-grid.js';

const SCRIPT = fileURLToPath(new URL('../scripts/slack-ext.jsh', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const grid = _gridMod.default || _gridMod;

const ORG = 'E0EXAMPLE01';
const WS = 'T0EXAMPLE01';
const CHAN = 'C0EXAMPLE01';
const INVITE = 'I0EXAMPLE01';
const EMAIL = 'guest@example.com';

class NodeExitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = code !== undefined ? code : 1;
  }
}

// A sharedApprovals.list row as measured, with fakes, INCLUDING icon/avatar
// fields that the detail view must strip.
function approvalRow(over) {
  return Object.assign(
    {
      id: INVITE,
      status: 'pending',
      connection_status: 'pending',
      channel: { id: CHAN, name: 'example-shared' },
      home_user: {
        id: 'U0EXAMPLE01',
        real_name: 'Example Inviter',
        profile: { image_48: 'https://example.invalid/avatar-home.png' },
      },
      away_user: {
        id: 'U0EXAMPLE02',
        real_name: 'Example Guest',
        team_id: 'T0EXAMPLE02',
        profile: { email: EMAIL, image_72: 'https://example.invalid/avatar-away.png' },
      },
      connecting_team: {
        id: 'T0EXAMPLE02',
        name: 'Example Partner Org',
        domain: 'example-partner',
        requires_sponsorship: true,
        icon: { image_68: 'https://example.invalid/icon-team.png' },
      },
      home_date_approve: 1790000000,
      away_date_approve: 0,
      approving_user_id: 'U0EXAMPLE01',
      invite_date_created: 1789900000,
      date_expire: 1791000000,
    },
    over || {}
  );
}

/**
 * @param {object} opts
 * @param {string[]} opts.argv
 * @param {function} [opts.api] (method, params, state) => body | undefined
 * @param {object[]} [opts.rows] initial sharedApprovals rows
 */
async function load(opts) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const state = { rows: (opts.rows || [approvalRow()]).map((r) => JSON.parse(JSON.stringify(r))) };
  const fakeTab = { id: 'tab1', url: 'https://app.slack.com/client/' + WS + '/' + CHAN };

  const browserStub = {
    async findTab() {
      return fakeTab;
    },
    async localStorage(_tab, key) {
      if (key !== 'localConfig_v2') return null;
      return JSON.stringify({ teams: { [WS]: { token: 'xoxc-test-ws' }, [ORG]: { token: 'xoxc-test-org' } } });
    },
    async fetch(_tab, url, fetchOpts) {
      const method = url.replace('/api/', '');
      const params = {};
      let token = null;
      if (fetchOpts && typeof fetchOpts.body === 'string') {
        for (const [k, v] of new URLSearchParams(fetchOpts.body)) {
          if (k === 'token') token = v;
          else params[k] = v;
        }
      }
      calls.push({ method, params, token });
      if (opts.api) {
        const custom = opts.api(method, params, state);
        if (custom !== undefined) return { body: custom };
      }
      if (method === 'conversations.sharedApprovals.list') {
        return { body: { ok: true, approvals: JSON.parse(JSON.stringify(state.rows)), response_metadata: { next_cursor: '' } } };
      }
      if (method === 'conversations.revokeSharedInvite') {
        const row = state.rows.find((r) => r.id === params.invite_id);
        if (row) {
          row.status = 'expired';
          row.date_expire = 1790500000;
        }
        return { body: { ok: true } };
      }
      if (method === 'users.admin.inviteBulk') {
        const invites = JSON.parse(params.invites);
        return {
          body: {
            ok: true,
            invites: invites.map((i) => ({ email: i.email, ok: true, invite_id: 'I0EXAMPLE02', expiration_ts: 1791000000 })),
          },
        };
      }
      return { body: { ok: false, error: 'not_mocked' } };
    },
  };

  const cliStub = {
    die(message, options) {
      const code = options && options.exitCode !== undefined ? options.exitCode : 1;
      stderr.push(String(message));
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

  const mocks = {
    'sliccy:browser': browserStub,
    'sliccy:cli': cliStub,
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:exec': { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    'sliccy:http': {
      client: () => ({
        post: async () => {
          throw new Error('these commands must not use the App Manifest HTTP client');
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
  const relativeModules = {
    './argv.js': () => _argvMod.default || _argvMod,
    './manifest-diff.js': () => _manifestDiffMod.default || _manifestDiffMod,
    './slack-ext-grid.js': () => grid,
  };
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    const key = id.replace(/^\.\.\/(scripts\/)?/, './');
    if (Object.hasOwn(relativeModules, key)) return relativeModules[key]();
    throw new Error('unexpected require(' + id + ')');
  };
  const mockProcess = {
    argv: ['node', SCRIPT, ...opts.argv],
    env: {},
    exit: (code) => {
      throw new NodeExitError('exit', code);
    },
  };
  const mockConsole = {
    log: (m) => stdout.push(String(m === undefined ? '' : m)),
    error: (m) => stderr.push(String(m === undefined ? '' : m)),
    warn: (m) => stderr.push(String(m === undefined ? '' : m)),
  };

  const source = readFileSync(SCRIPT, 'utf8');
  const factory = new AsyncFunction('require', 'process', 'console', 'setTimeout', source);
  let runError = null;
  try {
    await factory(mockRequire, mockProcess, mockConsole, setTimeout);
  } catch (e) {
    runError = e;
  }
  return {
    runError,
    calls,
    state,
    text: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
    exit: () => (runError ? (runError.name === 'NodeExitError' ? runError.exitCode : 'THROW:' + runError.message) : 0),
    methods: () => calls.map((c) => c.method).join(','),
    count: (m) => calls.filter((c) => c.method === m).length,
  };
}

const MUTATING = ['users.admin.inviteBulk', 'conversations.revokeSharedInvite'];
const mutations = (h) => h.calls.filter((c) => MUTATING.includes(c.method)).length;

// ── guest-invite ──────────────────────────────────────────────────────────────

test('guest-invite dry run: makes no Slack call at all, shows the payload target', async () => {
  const h = await load({ argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN] });
  is(h.exit(), 0);
  is(h.calls.length, 0);
  is(mutations(h), 0);
  const t = h.text();
  ok(/Dry run — would invite a single-channel guest/.test(t), t);
  ok(t.includes(EMAIL) && t.includes(WS) && t.includes(CHAN), t);
  ok(/No --confirm; nothing changed/.test(t), t);
});

test('guest-invite dry run --json: one JSON document with the exact params, no call', async () => {
  const h = await load({ argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--json'] });
  is(h.exit(), 0);
  is(h.calls.length, 0);
  const doc = JSON.parse(h.text());
  is(doc.dry_run, true);
  is(doc.params.team_id, WS);
});

test('guest-invite --confirm: exactly one inviteBulk with exactly the measured fields, ORG token', async () => {
  const h = await load({ argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--confirm'] });
  is(h.exit(), 0, h.errText());
  is(h.methods(), 'users.admin.inviteBulk');
  const c = h.calls[0];
  is(c.params, {
    team_id: WS,
    invites: JSON.stringify([{ email: EMAIL, type: 'ultra_restricted', mode: 'manual' }]),
    channels: CHAN,
    ultra_restricted: 'true',
    source: 'invite_modal',
    mode: 'manual',
  });
  is(c.token, 'xoxc-test-org');
  const t = h.text();
  ok(/Result:\s+invited/.test(t), t);
  ok(t.includes('I0EXAMPLE02'), t);
  ok(/Expires:\s+\d{4}-\d\d-\d\d \d\d:\d\dZ/.test(t), t);
});

test('guest-invite --confirm: top-level ok:true with a failed per-invite result exits non-zero', async () => {
  const h = await load({
    argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--confirm'],
    api: (m) => (m === 'users.admin.inviteBulk' ? { ok: true, invites: [{ email: EMAIL, ok: false, error: 'already_invited' }] } : undefined),
  });
  is(h.exit(), 1);
  ok(/FAILED: already_invited/.test(h.text()), h.text());
  ok(/1 of 1 invite\(s\) failed/.test(h.errText()), h.errText());
});

test('guest-invite --confirm: ok:true with no per-invite entry is a failure, not success', async () => {
  const h = await load({
    argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--confirm'],
    api: (m) => (m === 'users.admin.inviteBulk' ? { ok: true, invites: [] } : undefined),
  });
  is(h.exit(), 1);
  ok(/missing_from_response/.test(h.text()), h.text());
});

test('guest-invite --confirm --json: failure still exits non-zero', async () => {
  const h = await load({
    argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--confirm', '--json'],
    api: (m) => (m === 'users.admin.inviteBulk' ? { ok: true, invites: [{ email: EMAIL, ok: false, error: 'invalid_email' }] } : undefined),
  });
  is(h.exit(), 1);
  const doc = JSON.parse(h.text());
  is(doc.summary.failed, 1);
});

test('guest-invite without --ws is refused before any call', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--confirm'] });
  is(h.exit(), 1);
  is(h.calls.length, 0);
  ok(/--ws=<TEAM_ID> is required/.test(h.errText()), h.errText());
});

test('guest-invite with the org id as --ws is refused (team_id must be the workspace)', async () => {
  const h = await load({ argv: ['--ws=' + ORG, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=' + CHAN, '--confirm'] });
  is(h.exit(), 1);
  is(h.calls.length, 0);
  ok(/WORKSPACE ID/.test(h.errText()), h.errText());
});

test('guest-invite refuses a channel list and a bad email', async () => {
  const a = await load({ argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', EMAIL, '--channel=C0EXAMPLE01,C0EXAMPLE02', '--confirm'] });
  is(a.exit(), 1);
  is(a.calls.length, 0);
  const b = await load({ argv: ['--ws=' + WS, '--org=' + ORG, 'guest-invite', 'not-an-email', '--channel=' + CHAN, '--confirm'] });
  is(b.exit(), 1);
  is(b.calls.length, 0);
});

// ── connect-revoke ────────────────────────────────────────────────────────────

test('connect-revoke dry run: reads sharedApprovals.list only and shows the invite', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=' + CHAN] });
  is(h.exit(), 0, h.errText());
  is(h.methods(), 'conversations.sharedApprovals.list');
  is(mutations(h), 0);
  const t = h.text();
  ok(/Dry run — would revoke Slack Connect invite/.test(t), t);
  ok(t.includes('Example Partner Org') && t.includes('Example Guest'), t);
  ok(/No --confirm; nothing changed/.test(t), t);
});

test('connect-revoke --confirm: revokes, RE-READS the row and reports the new status', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=' + CHAN, '--confirm'] });
  is(h.exit(), 0, h.errText());
  is(h.methods(), 'conversations.sharedApprovals.list,conversations.revokeSharedInvite,conversations.sharedApprovals.list');
  is(h.calls[1].params, { invite_id: INVITE, channel: CHAN });
  is(h.calls[1].token, 'xoxc-test-org');
  const t = h.text();
  ok(/Status before:\s+pending/.test(t), t);
  ok(/Status now:\s+expired/.test(t), t);
  ok(/Match:\s+yes/.test(t), t);
});

test('connect-revoke --confirm: ok:true but the re-read still shows pending -> exit 3', async () => {
  const h = await load({
    argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=' + CHAN, '--confirm'],
    api: (m) => (m === 'conversations.revokeSharedInvite' ? { ok: true } : undefined),
  });
  is(h.exit(), 3);
  ok(/Revoke sent, NOT confirmed/.test(h.text()), h.text());
  ok(/re-read shows status pending/.test(h.errText()), h.errText());
});

test('connect-revoke --confirm: team_is_restricted -> clear error and org-token hint, no re-read', async () => {
  const h = await load({
    argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=' + CHAN, '--confirm'],
    api: (m) => (m === 'conversations.revokeSharedInvite' ? { ok: false, error: 'team_is_restricted' } : undefined),
  });
  is(h.exit(), 1);
  const e = h.errText();
  ok(/team_is_restricted\. Nothing was revoked/.test(e), e);
  ok(/ORG-level token/.test(e) && /--org=<E id>/.test(e), e);
  is(h.methods(), 'conversations.sharedApprovals.list,conversations.revokeSharedInvite');
});

test('connect-revoke: unknown invite is refused without a revoke call', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'connect-revoke', 'I0EXAMPLE09', '--channel=' + CHAN, '--confirm'] });
  is(h.exit(), 1);
  is(mutations(h), 0);
  ok(/not found in conversations\.sharedApprovals\.list/.test(h.errText()), h.errText());
});

test('connect-revoke: --channel that does not match the row is refused', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=C0EXAMPLE02', '--confirm'] });
  is(h.exit(), 1);
  is(mutations(h), 0);
  ok(/is for channel C0EXAMPLE01, not C0EXAMPLE02/.test(h.errText()), h.errText());
});

test('connect-revoke: already expired is nothing to do, no revoke call', async () => {
  const h = await load({ rows: [approvalRow({ status: 'expired' })], argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=' + CHAN, '--confirm'] });
  is(h.exit(), 0);
  is(mutations(h), 0);
  ok(/already expired; nothing to revoke/.test(h.text()), h.text());
});

test('connect-revoke: finds the row on a later page', async () => {
  let page = 0;
  const h = await load({
    argv: ['--org=' + ORG, 'connect-revoke', INVITE, '--channel=' + CHAN],
    api: (m) => {
      if (m !== 'conversations.sharedApprovals.list') return undefined;
      page += 1;
      if (page === 1) return { ok: true, approvals: [approvalRow({ id: 'I0EXAMPLE05' })], response_metadata: { next_cursor: 'c2' } };
      return { ok: true, approvals: [approvalRow()], response_metadata: { next_cursor: '' } };
    },
  });
  is(h.exit(), 0, h.errText());
  is(h.count('conversations.sharedApprovals.list'), 2);
  is(h.calls[1].params.cursor, 'c2');
});

// ── approvals detail ──────────────────────────────────────────────────────────

test('approvals show: both approval sides, inviter, invitee + org; icons stripped', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'approvals', 'show', INVITE] });
  is(h.exit(), 0, h.errText());
  is(mutations(h), 0);
  const t = h.text();
  ok(/Inviter:\s+Example Inviter \(U0EXAMPLE01\)/.test(t), t);
  ok(/Invitee:\s+Example Guest \(U0EXAMPLE02\) <guest@example\.com>/.test(t), t);
  ok(/Invitee org:\s+Example Partner Org \(T0EXAMPLE02\)/.test(t), t);
  ok(/Our side:\s+approved \d{4}-/.test(t), t);
  ok(/Other org:\s+NOT approved/.test(t), t);
  ok(/Waiting on:\s+other org/.test(t), t);
  ok(/Sponsorship:\s+required/.test(t), t);
  ok(!/example\.invalid|image_|icon/.test(t), t);
});

test('approvals --detail --json: stdout is one JSON document, both sides present, no icon fields', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'approvals', '--detail', '--json'] });
  is(h.exit(), 0, h.errText());
  const raw = h.text();
  const doc = JSON.parse(raw);
  is(doc.total, 1);
  const d = doc.approvals[0];
  is(d.home_approved, 1790000000);
  is(d.away_approved, 0);
  is(d.waiting_on, 'other org');
  is(d.invitee, { id: 'U0EXAMPLE02', real_name: 'Example Guest', email: EMAIL, team_id: 'T0EXAMPLE02' });
  is(d.connecting_team, { id: 'T0EXAMPLE02', name: 'Example Partner Org', domain: 'example-partner', requires_sponsorship: true });
  ok(!/example\.invalid|image_|"icon"/.test(raw), raw);
});

test('approvals --detail (human): prints the detail block per row', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'approvals', '--detail'] });
  is(h.exit(), 0, h.errText());
  ok(/Other org:\s+NOT approved/.test(h.text()), h.text());
});

test('approvals with an unknown subcommand is refused', async () => {
  const h = await load({ argv: ['--org=' + ORG, 'approvals', 'bogus'] });
  is(h.exit(), 1);
  is(h.calls.length, 0);
});

// ── pure helpers ──────────────────────────────────────────────────────────────

test('summarizeApprovalDetail: waiting_on covers all four states', () => {
  const w = (h, a) => grid.summarizeApprovalDetail(approvalRow({ home_date_approve: h, away_date_approve: a })).waiting_on;
  is(w(1, 0), 'other org');
  is(w(0, 1), 'our side');
  is(w(0, 0), 'both sides');
  is(w(1, 1), 'nobody');
});

test('summarizeInviteResults: case-insensitive email match, per-invite ok only', () => {
  const s = grid.summarizeInviteResults({ ok: true, invites: [{ email: 'Guest@Example.com', ok: true, invite_id: 'I0EXAMPLE03' }] }, [EMAIL]);
  is(s.ok, true);
  is(s.failed, 0);
  const f = grid.summarizeInviteResults({ ok: true, invites: [{ email: EMAIL, ok: 'true' }] }, [EMAIL]);
  is(f.ok, false);
});
