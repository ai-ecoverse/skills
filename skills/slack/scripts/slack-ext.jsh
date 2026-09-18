// slack-ext.jsh — Slack admin user-management commands
//
// Exposes Slack's legacy users.admin.* namespace for converting users between
// account types (regular member, multi-channel guest, single-channel guest) and
// for adding/removing channels on guest accounts.
//
// ── Wire facts, all verified live 2026-09-18 ──────────────────────────────────
//
// 1. METHOD NAMES — these are LEGACY, UNDOCUMENTED methods in the
//    users.admin.* namespace. The documented admin.users.* namespace is NOT used
//    here (those methods return `not_allowed_token_type` for xoxc session tokens
//    and require an org-level app token with admin.users:write).
//    Real methods (return "not_authed" on unauthenticated probe):
//      users.admin.setUltraRestricted  → single-channel guest
//      users.admin.setRestricted       → multi-channel guest
//      users.admin.setRegular          → regular member
//    Fake methods (return "unknown_method" on probe — do NOT call):
//      admin.users.setRestricted
//      admin.users.setUltraRestricted
//
// 2. TOKEN — these methods REJECT bot tokens (xoxb) with not_allowed_token_type.
//    They work with the xoxc admin user token from Slack's localStorage.
//    An xoxc token MUST travel with the `d` cookie (Slack's session cookie).
//    This script uses browser.fetch from the Slack tab (same-origin XHR), which
//    sends cookies automatically — exactly the same mechanism as slack.jsh.
//
// 3. PARAMETER NAMES — users.admin.setUltraRestricted takes `channel` (SINGULAR).
//    Passing `channels` returns invalid_arguments. Verified both ways.
//
// 4. VERIFICATION WITHOUT MUTATION — use user id U000000BOGUS0 to confirm auth,
//    permission, and parameter shape. A correct call returns `user_not_found`,
//    which proves everything is right except the target. Verified live.
//
// 5. AUDIT ATTRIBUTION — these calls run as the admin user whose xoxc token is
//    in use. Slack's audit log will attribute every change to THAT HUMAN, not to
//    a bot or app. Operators must be aware before using these commands.
//
// 6. CHANNEL ADD/REMOVE — uses the standard documented conversations.invite and
//    conversations.kick methods (both verified real via unauthenticated probe).
//
// ── Safety policy ─────────────────────────────────────────────────────────────
//
// Every mutating command requires --confirm. Without it the command prints what
// WOULD happen and exits 0 without touching Slack.
// Bots are always refused; already-in-state is a no-op.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');

const PREFIX = 'slack-ext';
const SLACK_DOMAIN = 'app.slack.com';

const HELP = `slack-ext [--ws=<TEAM_ID>] <command> [options]

Admin user-management commands for Slack Enterprise Grid.
Requires an open Slack tab (app.slack.com) logged in as an admin.

IMPORTANT: These commands run as the admin whose token is in use. Every
change is attributed to THAT HUMAN in Slack's audit log, not to a bot.
These use undocumented legacy endpoints (users.admin.*) that could change
without notice. Bot tokens (xoxb) are rejected; only xoxc session tokens work.

Global flags:
  --ws=<TEAM_ID>               Workspace team ID (required for mutations)
  --json                       Output raw API response for read commands

Commands:
  status <user_id>
      Show user type (regular / multi-channel guest / single-channel guest /
      bot / deactivated) and, for guests, which channels they are in.

  set-single <user_id> --channel=<channel_id> [--confirm]
      Convert a member to a SINGLE-channel guest (setUltraRestricted).
      Requires --ws and --channel. The user loses access to all channels
      except the one specified. Without --confirm, shows what would happen.

  set-multi <user_id> [--confirm]
      Convert a member to a MULTI-channel guest (setRestricted).
      Requires --ws. The user is downgraded; channel access must then be
      set separately with add-channel. Without --confirm, shows what would
      happen.

  set-member <user_id> [--confirm]
      Promote a guest back to a regular member (setRegular). The inverse of
      set-single and set-multi. Requires --ws. Without --confirm, shows what
      would happen.

  add-channel <user_id> --channel=<channel_id> [--confirm]
      Invite a multi-channel guest to an additional channel.
      Requires --ws and --channel. Without --confirm, shows what would happen.

  remove-channel <user_id> --channel=<channel_id> [--confirm]
      Remove a guest from a channel (conversations.kick).
      Requires --ws and --channel. Without --confirm, shows what would happen.

All mutating commands check the current account state first and refuse to
act if the user is already in the requested state.

Examples:
  slack-ext --ws=T06DUTYDQ status W5BPKRLUA
  slack-ext --ws=T06DUTYDQ set-single W5BPKRLUA --channel=C0899S7HV0E
  slack-ext --ws=T06DUTYDQ set-single W5BPKRLUA --channel=C0899S7HV0E --confirm
  slack-ext --ws=T06DUTYDQ set-multi W5BPKRLUA --confirm
  slack-ext --ws=T06DUTYDQ set-member W5BPKRLUA --confirm
  slack-ext --ws=T06DUTYDQ add-channel W5BPKRLUA --channel=C0899S7HV0E --confirm
  slack-ext --ws=T06DUTYDQ remove-channel W5BPKRLUA --channel=C0899S7HV0E --confirm

See also: slack user <id> (read-only profile from the standard slack CLI)
`;

// ── Argument parsing ──────────────────────────────────────────────────────────

// Flags that take no value (presence = true). This explicit set is required
// because the generic parser cannot distinguish a boolean flag from a
// value-less flag when the next token looks like a value.
const BOOL_FLAGS = new Set(['confirm', 'json', 'help', 'h']);

function parseArgv(argv) {
  const f = Object.create(null);
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let m = /^--([^=]+)=([\s\S]*)$/.exec(a);
    if (m) {
      f[m[1]] = m[2];
      continue;
    }
    m = /^--(.+)$/.exec(a);
    if (m) {
      const name = m[1];
      const next = argv[i + 1];
      if (BOOL_FLAGS.has(name) || next === undefined || /^--/.test(next)) {
        f[name] = true;
        continue;
      }
      f[name] = next;
      i += 1;
      continue;
    }
    pos.push(a);
  }
  return { flags: f, positional: pos };
}

const parsed = parseArgv(process.argv.slice(2));
const flags = parsed.flags;
const words = parsed.positional;

// ── Browser / auth helpers ────────────────────────────────────────────────────
// Copied from slack.jsh: find the Slack tab, read the xoxc token from
// localStorage, and make authenticated XHR calls via browser.fetch (same-origin,
// cookies included automatically).

let _cachedTab = null;
let _cachedTabUrl = null;

async function findSlackTab() {
  if (_cachedTab) return _cachedTab;
  let tab = await browser.findTab({ domain: SLACK_DOMAIN, urlMatch: /\/client\/[A-Z0-9]+/ });
  if (!tab) tab = await browser.findTab({ domain: SLACK_DOMAIN });
  if (!tab) {
    cli.die(
      'No Slack tab found. Open app.slack.com in your browser and try again.',
      { prefix: PREFIX }
    );
  }
  _cachedTab = tab;
  _cachedTabUrl = tab.url;
  return tab;
}

async function readLocalConfig(tab, attempts) {
  const tries = attempts || 4;
  for (let i = 0; i < tries; i += 1) {
    try {
      const raw = await browser.localStorage(tab, 'localConfig_v2');
      if (raw) {
        const cfg = JSON.parse(raw);
        if (cfg && cfg.teams) return cfg;
      }
    } catch (e) {
      // transient — retry
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function resolveWorkspaceToken(workspaceId) {
  const tab = await findSlackTab();
  let cfg = await readLocalConfig(tab);
  let team = cfg && cfg.teams && cfg.teams[workspaceId];
  if (team && team.token) return { tab, token: team.token };

  // Fallback: find a tab scoped to this workspace
  const wsTab = await browser.findTab({
    domain: SLACK_DOMAIN,
    urlMatch: new RegExp('/client/' + workspaceId + '(?![A-Z0-9])'),
  });
  if (wsTab) {
    _cachedTab = wsTab;
    _cachedTabUrl = wsTab.url;
    cfg = await readLocalConfig(wsTab);
    team = cfg && cfg.teams && cfg.teams[workspaceId];
    if (team && team.token) return { tab: wsTab, token: team.token };
  }
  return { tab, token: null };
}

// ── Workspace resolution ──────────────────────────────────────────────────────

function getWorkspaceFromTabUrl() {
  if (!_cachedTabUrl) return null;
  const m = _cachedTabUrl.match(/\/client\/([A-Z0-9]+)/);
  return m ? m[1] : null;
}

// For mutations, --ws is required because team_id is a required API parameter
// and silently defaulting to the wrong workspace could change the wrong person.
// For read-only status, the auto-detected workspace is acceptable.
async function resolveWorkspace(forMutation) {
  const ws = flags.ws || flags.workspace;
  if (ws) {
    if (!/^[A-Z0-9]+$/.test(ws)) {
      cli.die(
        'Invalid workspace ID "' + ws + '". Expected alphanumeric (e.g. T06DUTYDQ, E23RE8G4F).',
        { prefix: PREFIX }
      );
    }
    return ws;
  }

  // For mutations, an explicit --ws is required to avoid hitting the wrong workspace
  if (forMutation) {
    cli.die(
      '--ws=<TEAM_ID> is required for this command.\n' +
        '  The team_id parameter must be explicit for user-management operations.\n' +
        '  Run "slack workspaces" to list available workspace IDs.',
      { prefix: PREFIX }
    );
  }

  // For read-only commands, auto-detect from the Slack tab
  await findSlackTab();
  const wsId = getWorkspaceFromTabUrl();
  if (wsId) return wsId;

  cli.die(
    'Could not determine workspace. Use --ws=<TEAM_ID> to specify one explicitly.',
    { prefix: PREFIX }
  );
}

// ── Slack API wrapper ─────────────────────────────────────────────────────────
// Makes authenticated calls via browser.fetch (same-origin XHR, cookies
// included automatically). Mirrors slackApi() in slack.jsh.

async function slackApi(method, params, workspaceId, opts) {
  const fatal = !opts || opts.fatal !== false;
  const { tab, token } = await resolveWorkspaceToken(workspaceId);

  let data;
  if (!token) {
    data = {
      ok: false,
      error: 'token_not_found',
      detail: 'No token for workspace ' + workspaceId,
    };
  } else {
    const body = new URLSearchParams();
    body.append('token', token);
    for (const [k, v] of Object.entries(params)) {
      body.append(k, String(v));
    }
    try {
      const resp = await browser.fetch(tab, '/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      data =
        resp && typeof resp.body === 'object' && resp.body
          ? resp.body
          : { ok: false, error: 'xhr_error' };
    } catch (e) {
      data = { ok: false, error: 'xhr_error' };
    }
  }

  if (!data.ok) {
    const { error } = data;
    if (error === 'invalid_auth' || error === 'token_not_found') {
      if (!fatal) return data;
      cli.die(
        'Auth failed. Log into Slack at app.slack.com in your browser and try again.',
        { prefix: PREFIX }
      );
    }
    if (error === 'not_allowed_token_type') {
      if (!fatal) return data;
      cli.die(
        'Token type rejected by Slack (not_allowed_token_type).\n' +
          '  These admin methods require an xoxc user token, not a bot (xoxb) token.\n' +
          '  Make sure you are logged in at app.slack.com as an admin user.',
        { prefix: PREFIX }
      );
    }
    if (error === 'ratelimited') {
      if (!fatal) return data;
      cli.die('Rate limited by Slack. Wait a moment and try again.', { prefix: PREFIX });
    }
    if (!fatal) return data;
    cli.die('Slack API error (' + method + '): ' + error, { prefix: PREFIX });
  }

  return data;
}

// ── User helpers ──────────────────────────────────────────────────────────────

// Classify the user type from a users.info response object.
// Returns one of: 'regular', 'multi-channel guest', 'single-channel guest',
//                 'bot', 'deactivated'.
function userTypeLabel(user) {
  if (user.deleted) return 'deactivated';
  if (user.is_bot) return 'bot';
  if (user.is_ultra_restricted) return 'single-channel guest';
  if (user.is_restricted) return 'multi-channel guest';
  return 'regular';
}

async function lookupUser(userId, workspaceId) {
  const data = await slackApi('users.info', { user: userId }, workspaceId, { fatal: false });
  if (!data.ok) {
    if (data.error === 'user_not_found') {
      cli.die('User not found: ' + userId, { prefix: PREFIX });
    }
    cli.die('Could not look up user ' + userId + ': ' + data.error, { prefix: PREFIX });
  }
  return data.user;
}

// ── Pure parameter builders (extracted for test coverage) ────────────────────
// These functions build the API parameter objects. Keeping them pure makes them
// directly testable and documents the exact wire format in one place.

function buildSetUltraRestrictedParams(userId, channelId, teamId) {
  // CRITICAL: the parameter is `channel` (SINGULAR). `channels` returns
  // invalid_arguments. Verified live 2026-09-18.
  return { user: userId, team_id: teamId, channel: channelId };
}

function buildSetRestrictedParams(userId, teamId) {
  return { user: userId, team_id: teamId };
}

function buildSetRegularParams(userId, teamId) {
  return { user: userId, team_id: teamId };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function section(title) {
  console.log('');
  console.log('  ' + color.cyan(color.bold(title)));
}

function kv(label, value) {
  const padded = (label + ':').padEnd(14);
  console.log('    ' + padded + ' ' + value);
}

function rule() {
  console.log(color.dim('  ' + '\u2500'.repeat(52)));
}

// ── Command: status ───────────────────────────────────────────────────────────

async function cmdStatus() {
  const userId = words[1];
  if (!userId) {
    cli.die('Usage: slack-ext [--ws=<TEAM_ID>] status <user_id>', { prefix: PREFIX });
  }

  const wsId = await resolveWorkspace(false);
  const user = await lookupUser(userId, wsId);

  const typeLabel = userTypeLabel(user);
  const p = user.profile || {};

  section('User: ' + (user.real_name || user.name));
  kv('ID', user.id);
  kv('Username', '@' + user.name);
  kv('Display', p.display_name || color.dim('(none)'));
  kv('Type', typeLabel);
  kv('Workspace', wsId);

  if (user.is_restricted || user.is_ultra_restricted) {
    // Fetch guest channel memberships
    const convData = await slackApi(
      'users.conversations',
      { user: userId, types: 'public_channel,private_channel', limit: '200' },
      wsId,
      { fatal: false }
    );
    if (convData.ok && Array.isArray(convData.channels) && convData.channels.length > 0) {
      section('Guest channels (' + convData.channels.length + ')');
      for (const ch of convData.channels) {
        console.log('    ' + (ch.name ? '#' + ch.name : ch.id) + ' (' + ch.id + ')');
      }
    } else {
      section('Guest channels');
      console.log(color.dim('    (none found)'));
    }
  }

  if (flags.json) {
    console.log('');
    console.log(JSON.stringify(user, null, 2));
  }

  console.log('');
}

// ── Command: set-single ───────────────────────────────────────────────────────

async function cmdSetSingle() {
  const userId = words[1];
  const channelId = flags.channel;

  if (!userId) {
    cli.die(
      'Usage: slack-ext --ws=<TEAM_ID> set-single <user_id> --channel=<channel_id> [--confirm]',
      { prefix: PREFIX }
    );
  }
  if (!channelId) {
    cli.die('--channel=<channel_id> is required for set-single.', { prefix: PREFIX });
  }

  const wsId = await resolveWorkspace(true);
  const user = await lookupUser(userId, wsId);
  const typeLabel = userTypeLabel(user);

  if (user.is_bot) {
    cli.die(
      'Refusing to operate on bot user ' + userId + ' (@' + user.name + ').\n' +
        '  Bot account types are managed by the app that owns them.',
      { prefix: PREFIX }
    );
  }
  if (user.deleted) {
    cli.die('User ' + userId + ' is deactivated. Reactivate them first.', { prefix: PREFIX });
  }
  if (user.is_ultra_restricted) {
    section('No change needed');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Already', 'single-channel guest');
    console.log('');
    return;
  }

  const params = buildSetUltraRestrictedParams(userId, channelId, wsId);

  if (!flags.confirm) {
    section('Would change (no --confirm, nothing changed)');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Current', typeLabel);
    kv('New type', 'single-channel guest');
    kv('Channel', channelId);
    kv('Via', 'users.admin.setUltraRestricted');
    kv('Workspace', wsId);
    console.log('');
    console.log(
      color.yellow('  Audit: this change will be attributed to the admin whose token is in use.')
    );
    console.log(color.dim('  Re-run with --confirm to proceed.'));
    console.log('');
    return;
  }

  const result = await slackApi('users.admin.setUltraRestricted', params, wsId);
  if (!result.ok) {
    cli.die('users.admin.setUltraRestricted failed: ' + result.error, { prefix: PREFIX });
  }

  section('Done');
  kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
  kv('New type', 'single-channel guest');
  kv('Channel', channelId);
  kv('Workspace', wsId);
  console.log('');
  console.log(color.dim('  Audit: change attributed to the admin user whose token was used.'));
  console.log('');
}

// ── Command: set-multi ────────────────────────────────────────────────────────

async function cmdSetMulti() {
  const userId = words[1];

  if (!userId) {
    cli.die(
      'Usage: slack-ext --ws=<TEAM_ID> set-multi <user_id> [--confirm]',
      { prefix: PREFIX }
    );
  }

  const wsId = await resolveWorkspace(true);
  const user = await lookupUser(userId, wsId);
  const typeLabel = userTypeLabel(user);

  if (user.is_bot) {
    cli.die(
      'Refusing to operate on bot user ' + userId + ' (@' + user.name + ').\n' +
        '  Bot account types are managed by the app that owns them.',
      { prefix: PREFIX }
    );
  }
  if (user.deleted) {
    cli.die('User ' + userId + ' is deactivated. Reactivate them first.', { prefix: PREFIX });
  }
  if (user.is_restricted && !user.is_ultra_restricted) {
    section('No change needed');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Already', 'multi-channel guest');
    console.log('');
    return;
  }

  const params = buildSetRestrictedParams(userId, wsId);

  if (!flags.confirm) {
    section('Would change (no --confirm, nothing changed)');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Current', typeLabel);
    kv('New type', 'multi-channel guest');
    kv('Via', 'users.admin.setRestricted');
    kv('Workspace', wsId);
    console.log('');
    console.log(
      color.yellow('  Audit: this change will be attributed to the admin whose token is in use.')
    );
    console.log(color.dim('  Re-run with --confirm to proceed.'));
    console.log('');
    return;
  }

  const result = await slackApi('users.admin.setRestricted', params, wsId);
  if (!result.ok) {
    cli.die('users.admin.setRestricted failed: ' + result.error, { prefix: PREFIX });
  }

  section('Done');
  kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
  kv('New type', 'multi-channel guest');
  kv('Workspace', wsId);
  console.log('');
  console.log(color.dim('  Audit: change attributed to the admin user whose token was used.'));
  console.log('');
}

// ── Command: set-member ───────────────────────────────────────────────────────

async function cmdSetMember() {
  const userId = words[1];

  if (!userId) {
    cli.die(
      'Usage: slack-ext --ws=<TEAM_ID> set-member <user_id> [--confirm]',
      { prefix: PREFIX }
    );
  }

  const wsId = await resolveWorkspace(true);
  const user = await lookupUser(userId, wsId);
  const typeLabel = userTypeLabel(user);

  if (user.is_bot) {
    cli.die(
      'Refusing to operate on bot user ' + userId + ' (@' + user.name + ').\n' +
        '  Bot account types are managed by the app that owns them.',
      { prefix: PREFIX }
    );
  }
  if (user.deleted) {
    cli.die('User ' + userId + ' is deactivated. Reactivate them first.', { prefix: PREFIX });
  }
  if (!user.is_restricted && !user.is_ultra_restricted) {
    section('No change needed');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Already', 'regular member');
    console.log('');
    return;
  }

  const params = buildSetRegularParams(userId, wsId);

  if (!flags.confirm) {
    section('Would change (no --confirm, nothing changed)');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Current', typeLabel);
    kv('New type', 'regular member');
    kv('Via', 'users.admin.setRegular');
    kv('Workspace', wsId);
    console.log('');
    console.log(
      color.yellow('  Audit: this change will be attributed to the admin whose token is in use.')
    );
    console.log(color.dim('  Re-run with --confirm to proceed.'));
    console.log('');
    return;
  }

  const result = await slackApi('users.admin.setRegular', params, wsId);
  if (!result.ok) {
    cli.die('users.admin.setRegular failed: ' + result.error, { prefix: PREFIX });
  }

  section('Done');
  kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
  kv('New type', 'regular member');
  kv('Workspace', wsId);
  console.log('');
  console.log(color.dim('  Audit: change attributed to the admin user whose token was used.'));
  console.log('');
}

// ── Command: add-channel ──────────────────────────────────────────────────────

async function cmdAddChannel() {
  const userId = words[1];
  const channelId = flags.channel;

  if (!userId) {
    cli.die(
      'Usage: slack-ext --ws=<TEAM_ID> add-channel <user_id> --channel=<channel_id> [--confirm]',
      { prefix: PREFIX }
    );
  }
  if (!channelId) {
    cli.die('--channel=<channel_id> is required for add-channel.', { prefix: PREFIX });
  }

  const wsId = await resolveWorkspace(true);
  const user = await lookupUser(userId, wsId);

  if (user.is_bot) {
    cli.die(
      'Refusing to operate on bot user ' + userId + ' (@' + user.name + ').\n' +
        '  Bot account types are managed by the app that owns them.',
      { prefix: PREFIX }
    );
  }
  if (user.deleted) {
    cli.die('User ' + userId + ' is deactivated. Reactivate them first.', { prefix: PREFIX });
  }

  if (!flags.confirm) {
    section('Would change (no --confirm, nothing changed)');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Type', userTypeLabel(user));
    kv('Action', 'invite to channel ' + channelId);
    kv('Via', 'conversations.invite');
    kv('Workspace', wsId);
    console.log('');
    console.log(
      color.yellow('  Audit: this change will be attributed to the admin whose token is in use.')
    );
    console.log(color.dim('  Re-run with --confirm to proceed.'));
    console.log('');
    return;
  }

  const result = await slackApi(
    'conversations.invite',
    { channel: channelId, users: userId },
    wsId,
    { fatal: false }
  );
  if (!result.ok) {
    if (result.error === 'already_in_channel') {
      section('No change needed');
      kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
      kv('Already in', channelId);
      console.log('');
      return;
    }
    cli.die('conversations.invite failed: ' + result.error, { prefix: PREFIX });
  }

  section('Done');
  kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
  kv('Added to', channelId);
  kv('Workspace', wsId);
  console.log('');
  console.log(color.dim('  Audit: change attributed to the admin user whose token was used.'));
  console.log('');
}

// ── Command: remove-channel ───────────────────────────────────────────────────

async function cmdRemoveChannel() {
  const userId = words[1];
  const channelId = flags.channel;

  if (!userId) {
    cli.die(
      'Usage: slack-ext --ws=<TEAM_ID> remove-channel <user_id> --channel=<channel_id> [--confirm]',
      { prefix: PREFIX }
    );
  }
  if (!channelId) {
    cli.die('--channel=<channel_id> is required for remove-channel.', { prefix: PREFIX });
  }

  const wsId = await resolveWorkspace(true);
  const user = await lookupUser(userId, wsId);

  if (user.is_bot) {
    cli.die(
      'Refusing to operate on bot user ' + userId + ' (@' + user.name + ').\n' +
        '  Bot account types are managed by the app that owns them.',
      { prefix: PREFIX }
    );
  }
  if (user.deleted) {
    cli.die('User ' + userId + ' is deactivated. Reactivate them first.', { prefix: PREFIX });
  }

  if (!flags.confirm) {
    section('Would change (no --confirm, nothing changed)');
    kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
    kv('Type', userTypeLabel(user));
    kv('Action', 'remove from channel ' + channelId);
    kv('Via', 'conversations.kick');
    kv('Workspace', wsId);
    console.log('');
    console.log(
      color.yellow('  Audit: this change will be attributed to the admin whose token is in use.')
    );
    console.log(color.dim('  Re-run with --confirm to proceed.'));
    console.log('');
    return;
  }

  const result = await slackApi(
    'conversations.kick',
    { channel: channelId, user: userId },
    wsId,
    { fatal: false }
  );
  if (!result.ok) {
    if (result.error === 'not_in_channel') {
      section('No change needed');
      kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
      kv('Not in', channelId);
      console.log('');
      return;
    }
    cli.die('conversations.kick failed: ' + result.error, { prefix: PREFIX });
  }

  section('Done');
  kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
  kv('Removed from', channelId);
  kv('Workspace', wsId);
  console.log('');
  console.log(color.dim('  Audit: change attributed to the admin user whose token was used.'));
  console.log('');
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function main() {
  const cmd = words[0] || '';

  if (flags.help || flags.h || !cmd || cmd === 'help') {
    cli.help(HELP);
  }

  if (cmd === 'status') return cmdStatus();
  if (cmd === 'set-single') return cmdSetSingle();
  if (cmd === 'set-multi') return cmdSetMulti();
  if (cmd === 'set-member') return cmdSetMember();
  if (cmd === 'add-channel') return cmdAddChannel();
  if (cmd === 'remove-channel') return cmdRemoveChannel();

  cli.die(
    'Unknown command: ' + cmd + '\n  Run \'slack-ext --help\' for usage.',
    { prefix: PREFIX }
  );
}

try {
  await main();
} catch (err) {
  if (err && err.name === 'NodeExitError') throw err;
  cli.die((err && err.message) || String(err), { prefix: PREFIX });
}
