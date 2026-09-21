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
const http = require('sliccy:http');
const skill = require('sliccy:skill');
const fs = require('fs');

const PREFIX = 'slack-ext';
const SLACK_DOMAIN = 'app.slack.com';

// App Manifest API (see the `app` section below). Called over plain HTTPS with a
// bearer app configuration token — NOT through the Slack tab, because this
// credential is not the tab's xoxc session token.
const SLACK_API_BASE = 'https://slack.com/api';
const APP_TOKEN_ENV = 'SLACK_APP_CONFIG_TOKEN';
const APP_TOKEN_CONFIG_KEY = 'appConfigToken';

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

App manifest commands, for app configuration instead of users:

  app export <app_id> [--out=<file>] [--json]
      Fetch the live app manifest (apps.manifest.export) and pretty-print it,
      or write it to <file> with --out.

  app show <app_id> [--json]
      Human summary of the live manifest: name, bot user, bot scopes, event
      subscriptions + request URL, and the notable boolean settings.

  app validate <app_id> --manifest=<file> [--json]
      Validate a candidate manifest file (apps.manifest.validate). Each error
      is rendered with its JSON pointer into the manifest.
      A PASS DOES NOT MEAN SAFE: a partial manifest validates ok=true.
      Always run 'app diff' before applying anything.

  app diff <app_id> --manifest=<file> [--json]
      Compare a candidate manifest against the LIVE one, leaf field by leaf
      field, and flag every DELETION (present live, absent in the candidate).
      Slack has no merge semantics: an omitted field is REMOVED and arrays are
      REPLACED WHOLESALE, so deletions are the silent-damage case.

  app set-scopes <app_id> [--add=a,b] [--remove=c,d] [--confirm]
      Add and/or remove bot scopes (/oauth_config/scopes/bot). Export, adjust
      that one array, update with the complete manifest. Reports
      permissions_updated; when true, the app must be REINSTALLED before the
      new scope reaches the live bot token.

  app set-events <app_id> [--add=a,b] [--remove=c,d] [--confirm]
      Add and/or remove subscribed bot events
      (/settings/event_subscriptions/bot_events). Touches nothing else.

  app set-request-url <app_id> <https url> [--confirm]
      Set the event-subscription request URL.
      Slack VERIFIES the URL immediately on save: it posts a url_verification
      challenge and REJECTS the update unless the endpoint echoes the challenge
      value back. The endpoint must already be live and answering before this
      command is run.

  app apply <app_id> --manifest=<file> [--allow-deletions] [--confirm]
      Apply a manifest file. The file is overlaid on a fresh live export, so a
      field the file omits is PRESERVED rather than deleted. The diff shown is
      live-vs-FILE, so you still see everything the file leaves out. If that
      diff contains deletions the command REFUSES and names them; pass
      --allow-deletions to send the file as the complete manifest and really
      delete them.

  app token-rotate [--refresh-token=<tok>] [--confirm] [--json]
      Rotate the app configuration token pair (tooling.tokens.rotate).
      A rotate INVALIDATES the refresh token it consumes, so never run it
      speculatively. The new pair is written to the skill config BEFORE
      anything else happens with it; if that write fails the pair is printed
      so the credential is not lost.

Every mutating app command requires --confirm and prints the full diff first.
Any deletion the command was not explicitly asked to make is a hard stop, even
with --confirm: re-run with --allow-deletions once every named deletion is
intended. Writes always export the live manifest first and send the complete
result, because apps.manifest.update deletes anything the payload omits.

These app commands need an APP CONFIGURATION TOKEN (xoxe.xoxp-...), which is a
third credential: not a bot xoxb token and not the xoxc session token used by
every other command here. There is deliberately no fallback between them.
Set it with --token=<tok>, $SLACK_APP_CONFIG_TOKEN, or in the skill config under
"appConfigToken". Minting the first one is a human step in the browser:
api.slack.com/apps -> Your App Configuration Tokens -> Generate Token.

Two manifest methods will never be wired up: apps.manifest.create and
apps.manifest.delete. Deleting a Slack app is unrecoverable, and there is no
reason for a CLI to offer it.

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
  slack-ext app show A0123456789
  slack-ext app export A0123456789 --out=./manifest.json
  slack-ext app validate A0123456789 --manifest=./manifest.json
  slack-ext app diff A0123456789 --manifest=./manifest.json
  slack-ext app set-scopes A0123456789 --add=chat:write --confirm
  slack-ext app set-events A0123456789 --remove=team_join --confirm
  slack-ext app set-request-url A0123456789 https://relay.example.com --confirm
  slack-ext app apply A0123456789 --manifest=./manifest.json --confirm

See also: slack user <id> (read-only profile from the standard slack CLI)
`;

// ── Argument parsing ──────────────────────────────────────────────────────────
const { BOOL_FLAGS, parseArgv, parseList } = require('./argv.js');

// parseArgv throws on a malformed flag (e.g. --confirm=fasle). This call is at
// module top level, OUTSIDE the try/catch that wraps main(), so the throw would
// otherwise surface as an uncaught exception with a stack trace instead of the
// clean refusal a CLI owes its caller. Exit code is 1 either way; this is about
// the message, and about a malformed boolean never reaching a mutation guard.
let parsed;
try {
  parsed = parseArgv(process.argv.slice(2));
} catch (err) {
  cli.die((err && err.message) || String(err), { prefix: PREFIX });
}
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

  // FINDING 3 FIX: distinguish success-with-channels, success-empty, and failure.
  // An API failure must never be rendered as a statement of fact about the world.
  // Collapsing !ok and ok+empty into "(none found)" was a false claim on enterprise_is_restricted
  // or any other Slack error. convJsonStatus is also surfaced in --json output so scripted
  // callers can detect a failure; the JSON shape changes for guest users (documented in report).
  let convJsonStatus = null; // null = not a guest, otherwise { ok, channels?, error? }
  if (user.is_restricted || user.is_ultra_restricted) {
    // Fetch guest channel memberships
    const convData = await slackApi(
      'users.conversations',
      { user: userId, types: 'public_channel,private_channel', limit: '200' },
      wsId,
      { fatal: false }
    );
    if (!convData.ok) {
      // FAILURE path: state the fact and the actual error code.
      section('Guest channels');
      console.log(color.yellow('    API error: ' + convData.error));
      console.log(color.yellow('    Cannot confirm channel access. Verify manually.'));
      convJsonStatus = { ok: false, error: convData.error };
    } else if (Array.isArray(convData.channels) && convData.channels.length > 0) {
      // SUCCESS with channels
      section('Guest channels (' + convData.channels.length + ')');
      for (const ch of convData.channels) {
        console.log('    ' + (ch.name ? '#' + ch.name : ch.id) + ' (' + ch.id + ')');
      }
      convJsonStatus = { ok: true, channels: convData.channels };
    } else {
      // SUCCESS, but the guest has no channel memberships yet
      section('Guest channels');
      console.log(color.dim('    (none — guest has no channel access yet)'));
      convJsonStatus = { ok: true, channels: [] };
    }
  }

  if (flags.json) {
    console.log('');
    if (convJsonStatus === null) {
      // Non-guest user: output user object unchanged
      console.log(JSON.stringify(user, null, 2));
    } else {
      // Guest user: wrap user + channels info so scripted callers can detect
      // a failed channels lookup. JSON shape change from plain user object to
      // { user, channels } or { user, channels_error } for guest accounts.
      const out = { user };
      if (convJsonStatus.ok) {
        out.channels = convJsonStatus.channels;
      } else {
        out.channels_error = convJsonStatus.error;
      }
      console.log(JSON.stringify(out, null, 2));
    }
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
    // FINDING 2 FIX: a single-channel guest is defined by (type, channel). Moving
    // a guest from channel A to channel B is a real change. We must look up which
    // channel the guest is currently in and only no-op when it matches the request.
    // If the lookup fails, we cannot determine whether a change is needed and must
    // say so — we must NOT claim "no change needed" on a failed API call.
    const scgConv = await slackApi(
      'users.conversations',
      { user: userId, types: 'public_channel,private_channel', limit: '200' },
      wsId,
      { fatal: false }
    );
    if (!scgConv.ok) {
      cli.die(
        'Cannot determine current channel for single-channel guest ' + userId +
          ': users.conversations failed (' + scgConv.error + ').' +
          '\n  Cannot safely determine whether a change is needed. Resolve the API error first.',
        { prefix: PREFIX }
      );
    }
    const currentChannelIds = (scgConv.channels || []).map((c) => c.id);
    if (currentChannelIds.length === 1 && currentChannelIds[0] === channelId) {
      // True no-op: already in exactly the requested channel
      section('No change needed');
      kv('User', (user.real_name || user.name) + ' (' + user.id + ')');
      kv('Already', 'single-channel guest in ' + channelId);
      console.log('');
      return;
    }
    // Guest is in a different channel (or no channels): fall through to the
    // setUltraRestricted path to move them. The --confirm gate still applies below.
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

// ══ App manifest management (`slack-ext app <sub>`) ═══════════════════════════
//
// Wraps Slack's App Manifest API so app configuration (name, scopes, event
// subscriptions) can be read and compared from the CLI. The app-settings web UI
// is NOT automatable: api.slack.com/apps/<id>/oauth now 302s into
// app.slack.com/app-settings/... inside the Slack client SPA, which renders zero
// controls in a fresh tab and takes 30+ seconds when it renders at all, and its
// workspace picker is a Slack Kit `.c-basic-select` that ignores every synthetic
// event (click on the placeholder, click on `.c-select_button`,
// Enter/Space/ArrowDown KeyboardEvents, and a full
// pointerdown/mousedown/pointerup/mouseup/click sequence all leave
// aria-expanded="false"). Verified 2026-09-18. The manifest API replaces all of
// that, so there is deliberately no browser automation in this section.
//
// ── Wire facts, each verified live 2026-09-18 ────────────────────────────────
//
// A. AUTH IS A THIRD, SEPARATE CREDENTIAL: an *app configuration token* of shape
//    xoxe.xoxp-..., sent as `Authorization: Bearer <token>`. It is NOT the xoxc
//    session token every other command in this file uses, and NOT a bot xoxb
//    token. There is deliberately NO fallback between them — a wrong-credential
//    call either fails confusingly or acts as the wrong identity.
// B. Requests are FORM-ENCODED (application/x-www-form-urlencoded); the
//    `manifest` parameter is a JSON STRING. A JSON request body is rejected:
//    posting {"refresh_token":"..."} as JSON returned invalid_arguments
//    ("missing required field: refresh_token") while the same value form-encoded
//    was parsed. Measured with curl.
// C. SLACK ANSWERS HTTP 200 WITH {ok:false,error:...} ON FAILURE. A bogus bearer
//    token returned HTTP 200 + invalid_auth. `body.ok` is the ONLY verdict;
//    reading the HTTP status would call every error a success.
// D. apps.manifest.export and apps.manifest.validate both answer `not_authed` to
//    an unauthenticated probe (a nonexistent method answers `unknown_method`),
//    so both method names are real.
// E. apps.manifest.validate returns structured errors carrying JSON POINTERS,
//    e.g. {"code":"illegal_bot_scopes","message":"Illegal bot scopes found
//    ...","pointer":"/oauth_config/scopes/bot"}. A valid manifest returns
//    ok=true with errors: [].
// F. Adding `; charset=utf-8` to the content-type makes Slack attach
//    warning:"superfluous_charset" to the response body. Harmless, and the
//    charset is sent anyway because it is what Slack's own docs specify.
//
// ── Why `app diff` exists: apps.manifest.update has NO merge semantics ───────
//
//   * OMITTING A FIELD DELETES IT. Omitting display_information.description
//     removed it from the live app.
//   * ARRAYS ARE REPLACED WHOLESALE. Sending bot_events: ["channel_created"]
//     removed team_join outright.
//   * A PARTIAL MANIFEST VALIDATES ok=true. A display_information-only payload
//     passes apps.manifest.validate, so the API will accept a payload that
//     silently strips the bot user, every scope and every event subscription.
//     The validator catches only *some* incoherence (omitting oauth_config fails
//     with requires_a_bot_scope@/features/bot_user), which is worse than blanket
//     rejection: the dangerous payloads are the ones that pass.
//
// The single measured exception was display_information.background_color, which
// survived being omitted because it can never be null. That is ONE exceptional
// field, NOT merge semantics — generalising from it is exactly the wrong
// conclusion, and it was drawn (wrongly) once already.
//
// Therefore any future write must export the live manifest, modify THAT object,
// and send the complete result. `app diff` is the pre-flight a human runs first:
// it enumerates every DELETION a candidate manifest would cause.
//
// apps.manifest.create and apps.manifest.delete are real methods and are
// deliberately NEVER wired up: deleting a Slack app is unrecoverable and there
// is no reason for a CLI to offer it. The guard below makes a call impossible
// even by accident.

const FORBIDDEN_MANIFEST_METHODS = new Set(['apps.manifest.create', 'apps.manifest.delete']);

const APP_TOKEN_HELP =
  'Provide an app configuration token (xoxe.xoxp-...) with --token=<tok>,\n' +
  '  export ' + APP_TOKEN_ENV + '=<tok>, or store it in the skill config as\n' +
  '  "' + APP_TOKEN_CONFIG_KEY + '".\n' +
  '  Minting the first one is a human step and cannot be automated:\n' +
  '  api.slack.com/apps -> "Your App Configuration Tokens" -> Generate Token\n' +
  '  -> pick a workspace -> Generate.';

// Resolution order mirrors the repo convention (explicit flag, env var, skill
// config). It never reaches for the xoxc session token: these are different
// credentials for different APIs, and silently substituting one for the other is
// how a command ends up acting as the wrong identity.
async function getAppConfigToken() {
  let token = typeof flags.token === 'string' && flags.token ? flags.token : '';
  if (!token && process.env && process.env[APP_TOKEN_ENV]) {
    token = process.env[APP_TOKEN_ENV];
  }
  if (!token) {
    const cfg = (await skill.config()) || {};
    if (cfg[APP_TOKEN_CONFIG_KEY]) token = cfg[APP_TOKEN_CONFIG_KEY];
  }
  if (!token) {
    cli.die('No app configuration token found.\n  ' + APP_TOKEN_HELP, { prefix: PREFIX });
  }
  // Deliberately NO generic shape check on the value beyond the two
  // known-wrong token types below. A SLICC masked secret (e.g. a session secret
  // named SLACK_APP_CONFIG_TOKEN scoped to slack.com) arrives in the script as an
  // opaque hex placeholder and is unmasked by the kernel at request time —
  // measured 2026-09-18, where a 'does it start with xoxe.' check warned on a
  // token that then authenticated successfully. Shape-checking a value you may
  // never see is a false alarm generator.
  if (/^xoxb-/.test(token)) {
    cli.die(
      'That is a BOT token (xoxb-), which the App Manifest API rejects.\n  ' + APP_TOKEN_HELP,
      { prefix: PREFIX }
    );
  }
  if (/^xoxc-/.test(token)) {
    cli.die(
      'That is a Slack SESSION token (xoxc-), used by the user-management\n' +
        '  commands in this script. The App Manifest API needs a separate app\n' +
        '  configuration token.\n  ' + APP_TOKEN_HELP,
      { prefix: PREFIX }
    );
  }
  return token;
}

// A null/absent token builds a client with NO Authorization header. That is not
// an oversight: tooling.tokens.rotate authenticates BY ARGUMENT (refresh_token),
// so no bearer is required and none is sent.
//
// An earlier version of this comment claimed a bearer header "took precedence and
// produced invalid_auth". That was re-probed and did NOT reproduce: with a bogus
// refresh_token the answer is invalid_refresh_token whether or not an
// Authorization header is present, and a bearer with no refresh_token gives
// invalid_arguments -- never invalid_auth. Sending no header remains correct, but
// because it is NOT REQUIRED rather than because it is harmful. Behaviour with a
// VALID refresh token plus a bearer is still untested (no spare token to burn),
// so do not add a header on the assumption that it is harmless either.
function appApiClient(token) {
  const config = {
    baseUrl: SLACK_API_BASE,
    retry: { on: [429, 500, 502, 503, 504], maxAttempts: 3 },
    timeoutMs: 60000,
  };
  if (token) config.token = () => token;
  return http.client(config);
}

// Low-level call. Returns the PARSED BODY, never a status code, because Slack
// signals failure in the body with HTTP 200 (fact C above).
async function manifestApi(method, params, token) {
  if (FORBIDDEN_MANIFEST_METHODS.has(method)) {
    cli.die(
      'Refusing to call ' + method + '.\n' +
        '  Creating and deleting Slack apps is deliberately not supported by this\n' +
        '  CLI: deleting an app is unrecoverable. Use api.slack.com/apps.',
      { prefix: PREFIX }
    );
  }

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    body.append(k, String(v));
  }

  let res;
  try {
    res = await appApiClient(token).post('/' + method, {
      body: body.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      raw: true,
    });
  } catch (e) {
    if (e && e.name === 'NodeExitError') throw e;
    // A transport/non-2xx failure is rare here (Slack uses 200 + ok:false), so
    // surface it as an ok:false body and let the caller report it uniformly.
    return { ok: false, error: 'http_error', detail: (e && e.message) || String(e) };
  }

  const data = res && typeof res.body === 'object' && res.body ? res.body : null;
  if (!data) return { ok: false, error: 'bad_response' };
  return data;
}

// Error mapping for an ok:false App Manifest API body.
function dieOnManifestError(method, data, what) {
  const err = (data && data.error) || 'unknown_error';
  if (err === 'invalid_auth' || err === 'not_authed' || err === 'token_expired') {
    cli.die(
      'App configuration token rejected by Slack (' + err + ').\n' +
        '  These tokens expire and must then be rotated or regenerated.\n  ' + APP_TOKEN_HELP,
      { prefix: PREFIX }
    );
  }
  if (err === 'app_not_found' || err === 'invalid_app_id') {
    cli.die(
      'Slack does not recognise that app id (' + err + ').\n' +
        '  App ids look like A0123456789 and are listed on api.slack.com/apps.',
      { prefix: PREFIX }
    );
  }
  cli.die('Could not ' + what + ': ' + method + ' returned ' + err, { prefix: PREFIX });
}

// Single place where an App Manifest API response is judged. The verdict is
// data.ok — NOT the HTTP status, which is 200 even for invalid_auth.
async function manifestCall(method, params, token, what) {
  const data = await manifestApi(method, params, token);
  if (!data.ok) dieOnManifestError(method, data, what);
  return data;
}

function requireAppId(sub) {
  const appId = words[2];
  if (!appId) {
    cli.die('Usage: slack-ext app ' + sub + ' <app_id> [options]', { prefix: PREFIX });
  }
  if (!/^A[A-Z0-9]+$/i.test(appId)) {
    cli.die(
      'Invalid app id "' + appId + '". App ids start with A (e.g. A0123456789)\n' +
        '  and are listed on api.slack.com/apps.',
      { prefix: PREFIX }
    );
  }
  return appId;
}

async function exportLiveManifest(appId, token) {
  const data = await manifestCall(
    'apps.manifest.export',
    { app_id: appId },
    token,
    'export the manifest for ' + appId
  );
  if (!data.manifest || typeof data.manifest !== 'object') {
    cli.die('apps.manifest.export returned no manifest object for ' + appId, { prefix: PREFIX });
  }
  return data.manifest;
}

async function readManifestFile(label) {
  const file = flags.manifest;
  if (!file || file === true) {
    cli.die('--manifest=<file> is required for ' + label + '.', { prefix: PREFIX });
  }
  let raw;
  try {
    raw = await fs.readFile(file);
  } catch (e) {
    cli.die('Could not read manifest file ' + file + ': ' + ((e && e.message) || e), {
      prefix: PREFIX,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch (e) {
    cli.die(
      'Manifest file ' + file + ' is not valid JSON: ' + ((e && e.message) || e) + '\n' +
        '  The file must contain a single JSON manifest object.',
      { prefix: PREFIX }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    cli.die('Manifest file ' + file + ' must contain a JSON object.', { prefix: PREFIX });
  }
  return parsed;
}

// ── Leaf walking and diffing ─────────────────────────────────────────────────

// isPlainObject, pointerJoin, manifestLeaves, collectSubtree, diffManifests
// extracted to ./manifest-diff.js
const { isPlainObject, pointerJoin, manifestLeaves, collectSubtree, diffManifests } = require('./manifest-diff.js');
function formatLeaf(value) {
  if (Array.isArray(value)) return '[' + value.map((v) => JSON.stringify(v)).join(', ') + ']';
  return JSON.stringify(value);
}

// ── Command: app export ──────────────────────────────────────────────────────

async function cmdAppExport() {
  const appId = requireAppId('export');
  const token = await getAppConfigToken();
  const manifest = await exportLiveManifest(appId, token);
  const text = JSON.stringify(manifest, null, 2);

  const out = flags.out;
  if (out && out !== true) {
    try {
      await fs.writeFile(out, text + '\n');
    } catch (e) {
      cli.die('Could not write ' + out + ': ' + ((e && e.message) || e), { prefix: PREFIX });
    }
    section('Manifest exported');
    kv('App', appId);
    kv('File', out);
    kv('Leaves', String(Object.keys(manifestLeaves(manifest, '', {})).length));
    console.log('');
    console.log(
      color.dim('  Edit it, then run: slack-ext app diff ' + appId + ' --manifest=' + out)
    );
    console.log('');
    return;
  }

  if (flags.json) return cli.out(manifest);
  console.log(text);
}

// ── Command: app show ────────────────────────────────────────────────────────

async function cmdAppShow() {
  const appId = requireAppId('show');
  const token = await getAppConfigToken();
  const manifest = await exportLiveManifest(appId, token);

  if (flags.json) return cli.out(manifest);

  const di = manifest.display_information || {};
  const bot = (manifest.features && manifest.features.bot_user) || {};
  const oauth = manifest.oauth_config || {};
  const scopes = (oauth.scopes && oauth.scopes.bot) || [];
  const settings = manifest.settings || {};
  const events = settings.event_subscriptions || {};
  const botEvents = events.bot_events || [];

  section('App: ' + (di.name || appId));
  kv('App ID', appId);
  kv('Description', di.description || color.dim('(none)'));
  kv('Color', di.background_color || color.dim('(none)'));

  section('Bot user');
  kv('Display', bot.display_name || color.dim('(no bot user)'));
  kv('Always on', String(Boolean(bot.always_online)));

  section('Bot scopes (' + scopes.length + ')');
  if (scopes.length === 0) {
    console.log(color.dim('    (none)'));
  } else {
    for (const s of scopes) console.log('    ' + s);
  }

  section('Event subscriptions (' + botEvents.length + ')');
  kv('Request URL', events.request_url || color.dim('(none)'));
  if (botEvents.length === 0) {
    console.log(color.dim('    (no bot events)'));
  } else {
    for (const e of botEvents) console.log('    ' + e);
  }

  section('Settings');
  kv('Socket mode', String(Boolean(settings.socket_mode_enabled)));
  kv('Org deploy', String(Boolean(settings.org_deploy_enabled)));
  kv('Token rot.', String(Boolean(settings.token_rotation_enabled)));
  kv('App tok rot', String(Boolean(settings.app_level_token_rotation_enabled)));
  kv('MCP', String(Boolean(settings.is_mcp_enabled)));
  kv('PKCE', String(Boolean(oauth.pkce_enabled)));
  rule();
  console.log(
    color.dim('  Full manifest: slack-ext app export ' + appId + ' --out=./manifest.json')
  );
  console.log('');
}

// ── Command: app validate ────────────────────────────────────────────────────

function renderValidationErrors(errors) {
  section('Manifest INVALID (' + errors.length + ' error(s))');
  for (const err of errors) {
    const code = (err && err.code) || 'error';
    const message = (err && err.message) || JSON.stringify(err);
    // The JSON pointer is the only thing that says WHERE in the manifest the
    // problem is; printing the message alone makes the error unactionable.
    const pointer = err && err.pointer ? err.pointer : '(no pointer)';
    console.log('    ' + color.red('\u2717') + ' [' + code + '] ' + message);
    console.log('      ' + color.dim('pointer: ') + pointer);
  }
}

async function cmdAppValidate() {
  const appId = requireAppId('validate');
  const candidate = await readManifestFile('app validate');
  const token = await getAppConfigToken();

  const data = await manifestApi(
    'apps.manifest.validate',
    { app_id: appId, manifest: JSON.stringify(candidate) },
    token
  );

  const errors = Array.isArray(data.errors) ? data.errors : [];

  if (flags.json) cli.out(data);

  // body.ok is the verdict (HTTP is 200 either way). Errors are rendered with
  // their pointers before exiting non-zero.
  if (!data.ok) {
    if (errors.length > 0) {
      if (!flags.json) renderValidationErrors(errors);
      console.log('');
      cli.die('Manifest rejected by apps.manifest.validate (' + errors.length + ' error(s)).', {
        prefix: PREFIX,
      });
    }
    // No errors[] means the call itself failed (auth, bad app id, ...) rather
    // than the manifest being invalid.
    return dieOnManifestError('apps.manifest.validate', data, 'validate the manifest');
  }

  if (flags.json) return;

  section('Manifest valid');
  kv('App', appId);
  kv('File', String(flags.manifest));
  console.log('');
  console.log(
    color.yellow('  VALID DOES NOT MEAN SAFE. A partial manifest validates ok=true:') +
      '\n  a display_information-only payload passes this check, and applying it\n' +
      '  would strip the bot user, every scope and every event subscription.\n' +
      '  Run: slack-ext app diff ' + appId + ' --manifest=' + String(flags.manifest)
  );
  console.log('');
}

// ── Diff rendering (shared by `app diff` and every write command) ─────────────
//
// `emit` is injected so the write path can render the very same diff, and so
// --json mode can suppress the human rendering without a second code path.

function renderDiffBody(diff, emit) {
  // Deletions first and loudest: they are the silent-damage case.
  if (diff.deletions.length > 0) {
    emit('');
    emit(
      '  ' +
        color.cyan(
          color.bold('DELETIONS (' + diff.deletions.length + ') — these would be REMOVED')
        )
    );
    for (const d of diff.deletions) {
      const suffix = d.entry ? ' ' + color.dim('(array entry)') : '';
      emit('    ' + color.red('- ' + d.pointer) + '  ' + formatLeaf(d.value) + suffix);
    }
  }

  if (diff.modifications.length > 0) {
    emit('');
    emit('  ' + color.cyan(color.bold('Modifications (' + diff.modifications.length + ')')));
    for (const m of diff.modifications) {
      emit(
        '    ' + color.yellow('~ ' + m.pointer) + '  ' + formatLeaf(m.from) + ' -> ' +
          formatLeaf(m.to)
      );
    }
  }

  if (diff.additions.length > 0) {
    emit('');
    emit('  ' + color.cyan(color.bold('Additions (' + diff.additions.length + ')')));
    for (const a of diff.additions) {
      const suffix = a.entry ? ' ' + color.dim('(array entry)') : '';
      emit('    ' + color.green('+ ' + a.pointer) + '  ' + formatLeaf(a.value) + suffix);
    }
  }
}

function renderDeletionWarning(diff, emit) {
  if (diff.deletions.length === 0) {
    emit(color.dim('  No deletions. Additions/modifications only.'));
    return;
  }
  emit(
    color.red('  WARNING: ' + diff.deletions.length + ' field(s)/entry(ies) would be DELETED.')
  );
  emit(
    '  apps.manifest.update has no merge semantics: a field omitted from the\n' +
      '  payload is REMOVED, and arrays are REPLACED WHOLESALE. Validation will\n' +
      '  NOT stop this — a partial manifest returns ok=true.'
  );
  const bg = diff.deletions.find((d) => d.pointer === '/display_information/background_color');
  if (bg) {
    emit(
      color.dim(
        '  (Measured exception: display_information.background_color survives\n' +
          '  omission because it can never be null. It is the ONLY field observed\n' +
          '  to do so — do not generalise from it.)'
      )
    );
  }
}

// ── Command: app diff ────────────────────────────────────────────────────────

async function cmdAppDiff() {
  const appId = requireAppId('diff');
  const candidate = await readManifestFile('app diff');
  const token = await getAppConfigToken();
  const live = await exportLiveManifest(appId, token);

  const diff = diffManifests(live, candidate);

  if (flags.json) return cli.out(diff);

  section('Diff vs live manifest');
  kv('App', appId);
  kv('Candidate', String(flags.manifest));
  kv('Live leaves', String(Object.keys(manifestLeaves(live, '', {})).length));

  if (!diff.changed) {
    console.log('');
    console.log(color.dim('  No changes — the candidate matches the live manifest.'));
    console.log('');
    return;
  }

  const emit = (line) => console.log(line);
  renderDiffBody(diff, emit);
  console.log('');
  renderDeletionWarning(diff, emit);
  console.log('');
}

// ══ WRITES ════════════════════════════════════════════════════════════════
//
// EVERY manifest write goes through updateFromLiveManifest() below. That is not
// a style preference: apps.manifest.update has no merge semantics (omitting a
// field DELETES it, arrays are REPLACED WHOLESALE, and a partial manifest
// VALIDATES ok=true), so a payload built from anything other than a fresh export
// silently strips whatever it does not mention. The helper exports first, refuses
// to continue if the export failed or carried no manifest, mutates a CLONE of
// that object, and sends the COMPLETE result. There is no other call site for
// apps.manifest.update in this file.

const UPDATE_METHOD = 'apps.manifest.update';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Walk/create an object path inside an ALREADY-EXPORTED manifest. Used only to
// reach the field a command owns; it never invents a manifest.
function ensureObjectPath(root, keys) {
  let node = root;
  for (const key of keys) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  return node;
}

// Overlay a user-supplied manifest onto the live export: present fields win,
// arrays replace wholesale (matching Slack), and fields the file omits are kept
// from the export. This is what makes `app apply` incapable of deleting anything
// unless --allow-deletions is given.
function deepOverlay(base, patch) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (isPlainObject(value) && isPlainObject(base[key])) {
      deepOverlay(base[key], value);
      continue;
    }
    base[key] = isPlainObject(value) || Array.isArray(value) ? deepClone(value) : value;
  }
  return base;
}

function sameDeletion(a, b) {
  return a.pointer === b.pointer && JSON.stringify(a.value) === JSON.stringify(b.value);
}

// parseList extracted to ./argv.js

function validateNames(names, pattern, what) {
  for (const name of names) {
    if (!pattern.test(name)) {
      cli.die(
        'Invalid ' + what + ' "' + name + '".\n' +
          '  Expected lowercase names such as channels:read or team_join, comma-separated.',
        { prefix: PREFIX }
      );
    }
  }
}

// Apply --add/--remove to an array of names, preserving existing order and
// appending additions. Returns the new array plus exactly what changed, so the
// caller can declare its intentional deletions to the safety gate.
function applyAddRemove(current, add, remove) {
  const existing = Array.isArray(current) ? current.slice() : [];
  const removed = remove.filter((name) => existing.includes(name));
  const skippedRemovals = remove.filter((name) => !existing.includes(name));
  const added = add.filter((name) => !existing.includes(name));
  const next = existing.filter((name) => !removed.includes(name)).concat(added);
  return { next: next, added: added, removed: removed, skippedRemovals: skippedRemovals };
}

function reinstallWarning(emit, appId) {
  emit('');
  emit(color.red(color.bold('  REINSTALL REQUIRED (permissions_updated = true)')));
  emit(
    '  Slack reports that this update changed the app\'s permissions. The change is\n' +
      '  live in the app CONFIGURATION but the existing bot token does NOT carry it:\n' +
      '  a scope only reaches the token when the app is REINSTALLED and the token is\n' +
      '  reissued. Until then calls with the old token keep failing on missing_scope.\n' +
      '  Reinstall at api.slack.com/apps/' + appId + '/install-on-team, then replace the\n' +
      '  stored bot token with the newly issued one.'
  );
}

/**
 * The single write path. Export -> modify a clone -> diff -> gate -> update.
 *
 * spec.appId       app id to export and update
 * spec.token       app configuration token
 * spec.action      human label, e.g. 'set-scopes'
 * spec.summary     [[label, value], ...] rendered above the diff
 * spec.mutate      (clone(liveManifest)) => next manifest (must return the WHOLE manifest)
 * spec.diffAgainst the object compared with live for the SAFETY diff. Defaults to
 *                  the payload. `app apply` passes the user's FILE here, because
 *                  its payload is the file overlaid on the live export: the
 *                  overlay cannot delete anything, so diffing it would hide
 *                  exactly the omissions the operator has to see.
 * spec.intentional [{pointer, value}] deletions this command means to make, or a
 *                  function returning them (read after mutate has run)
 * spec.rerun       the command line to re-run with --confirm
 */
async function updateFromLiveManifest(spec) {
  const emit = flags.json ? () => {} : (line) => console.log(line);

  // 1. ALWAYS export first. No export, no write — a write built on anything else
  //    would delete every field it failed to mention. exportLiveManifest() dies
  //    unless body.ok is true AND a manifest object came back.
  const live = await exportLiveManifest(spec.appId, spec.token);

  // 2. Mutate a CLONE of the live manifest, never a fresh object.
  const next = spec.mutate(deepClone(live));
  if (!isPlainObject(next)) {
    cli.die('Internal error: ' + spec.action + ' produced no manifest object.', { prefix: PREFIX });
  }

  // 3. Diff and always show it. The comparison target is what the OPERATOR asked
  //    for, which for `apply` is the file itself rather than the safer overlay.
  const compare = spec.diffAgainst ? spec.diffAgainst : next;
  const diff = diffManifests(live, compare);
  emit('');
  emit('  ' + color.cyan(color.bold('app ' + spec.action + ' — proposed change')));
  emit('    ' + 'App:'.padEnd(14) + ' ' + spec.appId);
  for (const [label, value] of spec.summary || []) {
    emit('    ' + (label + ':').padEnd(14) + ' ' + value);
  }
  if (!diff.changed) {
    emit('');
    emit(color.dim('  No change needed — the live manifest already matches.'));
    emit('');
    if (flags.json) cli.out({ action: spec.action, app_id: spec.appId, changed: false, diff: diff });
    return { updated: false, reason: 'no-change', diff: diff, live: live, next: next };
  }
  renderDiffBody(diff, emit);

  // 4. Deletion gate. Deletions the command declared (a --remove the operator
  //    asked for) are expected; anything else is UNEXPECTED and blocked unless
  //    --allow-deletions is passed on top of --confirm. The three measured
  //    hazards all surface here as deletions.
  const intentional =
    typeof spec.intentional === 'function' ? spec.intentional() : spec.intentional || [];
  const unexpected = diff.deletions.filter(
    (d) => !intentional.some((i) => sameDeletion(i, d))
  );
  const allowDeletions = Boolean(flags['allow-deletions']);
  const blocked = unexpected.length > 0 && !allowDeletions;

  emit('');
  renderDeletionWarning(diff, emit);

  if (blocked) {
    const named = unexpected
      .map((d) => '    - ' + d.pointer + '  ' + formatLeaf(d.value) + (d.entry ? ' (entry)' : ''))
      .join('\n');
    // Hard stop, even with --confirm: the operator asked for one thing and the
    // payload would remove something else.
    cli.die(
      'Refusing to update ' + spec.appId + ': ' + unexpected.length +
        ' unrequested deletion(s).\n' + named + '\n' +
        '  These fields exist on the live app and are absent from the payload, so\n' +
        '  apps.manifest.update would REMOVE them (omission deletes; arrays are\n' +
        '  replaced wholesale). Nothing was changed.\n' +
        '  If every deletion above is intended, re-run with --allow-deletions.',
      { prefix: PREFIX }
    );
  }

  // 5. THE --confirm GATE. The only place apps.manifest.update can be reached is
  //    below this return.
  if (!flags.confirm) {
    emit('');
    emit(color.yellow('  No --confirm: nothing was changed.'));
    emit(color.dim('  Re-run with --confirm to apply: ' + spec.rerun));
    emit('');
    if (flags.json) {
      cli.out({
        action: spec.action,
        app_id: spec.appId,
        changed: true,
        confirmed: false,
        updated: false,
        diff: diff,
      });
    }
    return { updated: false, reason: 'no-confirm', diff: diff, live: live, next: next };
  }

  // 6. Update with the COMPLETE manifest object (a JSON string on the wire).
  const result = await manifestCall(
    UPDATE_METHOD,
    { app_id: spec.appId, manifest: JSON.stringify(next) },
    spec.token,
    'update the manifest for ' + spec.appId
  );

  // 7. permissions_updated is the ONLY signal that the live bot token is now
  //    stale. Ignoring it is how "I added the scope but it still 403s" happens.
  const permissionsUpdated = result.permissions_updated === true;
  emit('');
  emit('  ' + color.green('\u2713') + ' Updated ' + spec.appId + ' (' + spec.action + ')');
  emit('    ' + 'Deleted:'.padEnd(14) + ' ' + String(diff.deletions.length));
  emit('    ' + 'Modified:'.padEnd(14) + ' ' + String(diff.modifications.length));
  emit('    ' + 'Added:'.padEnd(14) + ' ' + String(diff.additions.length));
  if (permissionsUpdated) {
    reinstallWarning(emit, spec.appId);
  } else {
    emit(color.dim('    permissions_updated = false — no reinstall needed.'));
  }
  emit('');

  if (flags.json) {
    cli.out({
      action: spec.action,
      app_id: spec.appId,
      changed: true,
      confirmed: true,
      updated: true,
      permissions_updated: permissionsUpdated,
      reinstall_required: permissionsUpdated,
      diff: diff,
    });
  }

  return {
    updated: true,
    permissionsUpdated: permissionsUpdated,
    diff: diff,
    live: live,
    next: next,
    result: result,
  };
}

// ── Command: app set-scopes ───────────────────────────────────────────────────

const SCOPE_PATTERN = /^[a-z0-9_.:-]+$/;
const EVENT_PATTERN = /^[a-z0-9_.]+$/;

async function cmdAppSetScopes() {
  const appId = requireAppId('set-scopes');
  const add = parseList(flags.add, 'add');
  const remove = parseList(flags.remove, 'remove');
  if (add.length === 0 && remove.length === 0) {
    cli.die(
      'Nothing to do. Pass --add=<scope,...> and/or --remove=<scope,...>.\n' +
        '  Usage: slack-ext app set-scopes <app_id> [--add=a,b] [--remove=c] [--confirm]',
      { prefix: PREFIX }
    );
  }
  validateNames(add, SCOPE_PATTERN, 'scope');
  validateNames(remove, SCOPE_PATTERN, 'scope');

  const token = await getAppConfigToken();
  let change = null;

  return updateFromLiveManifest({
    appId: appId,
    token: token,
    action: 'set-scopes',
    summary: [
      ['Add', add.length ? add.join(', ') : color.dim('(none)')],
      ['Remove', remove.length ? remove.join(', ') : color.dim('(none)')],
      ['Field', '/oauth_config/scopes/bot'],
    ],
    // Touches oauth_config.scopes.bot and nothing else.
    mutate: (manifest) => {
      const scopes = ensureObjectPath(manifest, ['oauth_config', 'scopes']);
      change = applyAddRemove(scopes.bot, add, remove);
      scopes.bot = change.next;
      return manifest;
    },
    // The removals this command was ASKED for are expected deletions; read after
    // mutate() has run, which is why this is a function and not an array.
    intentional: () =>
      (change ? change.removed : []).map((scope) => ({
        pointer: '/oauth_config/scopes/bot',
        value: scope,
        entry: true,
      })),
    rerun:
      'slack-ext app set-scopes ' + appId +
      (add.length ? ' --add=' + add.join(',') : '') +
      (remove.length ? ' --remove=' + remove.join(',') : '') + ' --confirm',
  });
}

// ── Command: app set-events ───────────────────────────────────────────────────

async function cmdAppSetEvents() {
  const appId = requireAppId('set-events');
  const add = parseList(flags.add, 'add');
  const remove = parseList(flags.remove, 'remove');
  if (add.length === 0 && remove.length === 0) {
    cli.die(
      'Nothing to do. Pass --add=<event,...> and/or --remove=<event,...>.\n' +
        '  Usage: slack-ext app set-events <app_id> [--add=a,b] [--remove=c] [--confirm]',
      { prefix: PREFIX }
    );
  }
  validateNames(add, EVENT_PATTERN, 'event');
  validateNames(remove, EVENT_PATTERN, 'event');

  const token = await getAppConfigToken();
  let change = null;

  return updateFromLiveManifest({
    appId: appId,
    token: token,
    action: 'set-events',
    summary: [
      ['Add', add.length ? add.join(', ') : color.dim('(none)')],
      ['Remove', remove.length ? remove.join(', ') : color.dim('(none)')],
      ['Field', '/settings/event_subscriptions/bot_events'],
    ],
    // Touches settings.event_subscriptions.bot_events and nothing else — in
    // particular it must never touch oauth_config.scopes.
    mutate: (manifest) => {
      const events = ensureObjectPath(manifest, ['settings', 'event_subscriptions']);
      change = applyAddRemove(events.bot_events, add, remove);
      events.bot_events = change.next;
      return manifest;
    },
    intentional: () =>
      (change ? change.removed : []).map((event) => ({
        pointer: '/settings/event_subscriptions/bot_events',
        value: event,
        entry: true,
      })),
    rerun:
      'slack-ext app set-events ' + appId +
      (add.length ? ' --add=' + add.join(',') : '') +
      (remove.length ? ' --remove=' + remove.join(',') : '') + ' --confirm',
  });
}

// ── Command: app set-request-url ─────────────────────────────────────────────

async function cmdAppSetRequestUrl() {
  const appId = requireAppId('set-request-url');
  const url = words[3];
  if (!url) {
    cli.die(
      'Usage: slack-ext app set-request-url <app_id> <https url> [--confirm]',
      { prefix: PREFIX }
    );
  }
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    cli.die(
      'Invalid request URL "' + url + '". Slack requires an https:// URL.',
      { prefix: PREFIX }
    );
  }

  const token = await getAppConfigToken();

  return updateFromLiveManifest({
    appId: appId,
    token: token,
    action: 'set-request-url',
    summary: [
      ['URL', url],
      ['Field', '/settings/event_subscriptions/request_url'],
    ],
    // Slack VERIFIES this URL at save time: it posts a url_verification
    // challenge and the update is rejected unless the endpoint echoes the
    // challenge value back. The endpoint must be live BEFORE this runs.
    mutate: (manifest) => {
      const events = ensureObjectPath(manifest, ['settings', 'event_subscriptions']);
      events.request_url = url;
      return manifest;
    },
    intentional: [],
    rerun: 'slack-ext app set-request-url ' + appId + ' ' + url + ' --confirm',
  });
}

// ── Command: app apply ───────────────────────────────────────────────────────

async function cmdAppApply() {
  const appId = requireAppId('apply');
  const candidate = await readManifestFile('app apply');
  const token = await getAppConfigToken();
  const allowDeletions = Boolean(flags['allow-deletions']);

  return updateFromLiveManifest({
    appId: appId,
    token: token,
    action: 'apply',
    summary: [
      ['Manifest', String(flags.manifest)],
      ['Mode', allowDeletions ? 'full replace (--allow-deletions)' : 'overlay on live export'],
    ],
    // The file is OVERLAID on the live export, so a field the file omits is kept
    // rather than deleted. With --allow-deletions the file is taken as the
    // complete manifest, which is what actually performs the deletions the diff
    // reported. Either way the payload starts from a fresh export, and the diff
    // is computed live-vs-FILE (diffAgainst below) so the operator sees every
    // omission even though the overlay would not act on it.
    mutate: (manifest) =>
      allowDeletions ? deepClone(candidate) : deepOverlay(manifest, candidate),
    diffAgainst: candidate,
    intentional: [],
    rerun:
      'slack-ext app apply ' + appId + ' --manifest=' + String(flags.manifest) +
      (allowDeletions ? ' --allow-deletions' : '') + ' --confirm',
  });
}

// ── Command: app token-rotate ────────────────────────────────────────────────
//
// tooling.tokens.rotate authenticates BY ARGUMENT, not by header: measured
// 2026-09-18, refresh_token=<bogus> returns invalid_refresh_token, token=<bogus>
// returns invalid_auth, and no params returns invalid_arguments ("missing
// required field: refresh_token"). An Authorization header sent alongside a bogus
// refresh_token was suspected to take precedence, but that did NOT reproduce on
// re-probe (see the note above the manifest client). No header is sent because
// none is needed, not because one is known to break the call.
// WITHOUT one.

const REFRESH_TOKEN_ENV = 'SLACK_APP_REFRESH_TOKEN';
const REFRESH_TOKEN_CONFIG_KEY = 'appRefreshToken';

function maskToken(value) {
  const s = String(value || '');
  if (s.length <= 12) return '(' + s.length + ' chars)';
  return s.slice(0, 10) + '...' + s.slice(-4) + ' (' + s.length + ' chars)';
}

async function cmdAppTokenRotate() {
  let refresh =
    typeof flags['refresh-token'] === 'string' && flags['refresh-token']
      ? flags['refresh-token']
      : '';
  let source = refresh ? '--refresh-token' : '';
  if (!refresh && process.env && process.env[REFRESH_TOKEN_ENV]) {
    refresh = process.env[REFRESH_TOKEN_ENV];
    source = '$' + REFRESH_TOKEN_ENV;
  }
  if (!refresh) {
    const cfg = (await skill.config()) || {};
    if (cfg[REFRESH_TOKEN_CONFIG_KEY]) {
      refresh = cfg[REFRESH_TOKEN_CONFIG_KEY];
      source = 'skill config ' + REFRESH_TOKEN_CONFIG_KEY;
    }
  }
  if (!refresh) {
    cli.die(
      'No refresh token. Pass --refresh-token=<tok>, export ' + REFRESH_TOKEN_ENV + ',\n' +
        '  or store one in the skill config as "' + REFRESH_TOKEN_CONFIG_KEY + '".\n' +
        '  The refresh token is issued next to the app configuration token at\n' +
        '  api.slack.com/apps -> "Your App Configuration Tokens".',
      { prefix: PREFIX }
    );
  }

  // Rotation is ONE-SHOT AND DESTRUCTIVE: a successful rotate INVALIDATES the
  // refresh token that was just used. Never rotate speculatively — only on this
  // explicit command (or in response to a 401) — which is why --confirm is
  // required even though nothing about the app itself changes.
  if (!flags.confirm) {
    section('Would rotate app configuration token (no --confirm, nothing done)');
    kv('Refresh', maskToken(refresh));
    kv('Source', source);
    kv('Via', 'tooling.tokens.rotate');
    console.log('');
    console.log(
      color.yellow('  A rotate INVALIDATES the refresh token it consumes.') + '\n' +
        '  The new pair is written to the skill config BEFORE anything else happens\n' +
        '  with it; if that write fails the new pair is printed so it is not lost.\n' +
        '  Only a human can mint a replacement (api.slack.com/apps), so do not run\n' +
        '  this unless the current token actually needs replacing.'
    );
    console.log(color.dim('  Re-run with --confirm to rotate.'));
    console.log('');
    return { rotated: false };
  }

  // No bearer header here (see the note above): the refresh token IS the credential.
  const data = await manifestApi('tooling.tokens.rotate', { refresh_token: refresh }, null);
  if (!data.ok) {
    if (data.error === 'invalid_refresh_token') {
      cli.die(
        'Slack rejected the refresh token (invalid_refresh_token).\n' +
          '  A refresh token is single-use: if it was already rotated, the pair from\n' +
          '  that rotation is the current one. If it is lost, mint a new token by hand\n' +
          '  at api.slack.com/apps -> "Your App Configuration Tokens".',
        { prefix: PREFIX }
      );
    }
    dieOnManifestError('tooling.tokens.rotate', data, 'rotate the app configuration token');
  }
  if (!data.token || !data.refresh_token) {
    cli.die(
      'tooling.tokens.rotate returned ok without a token pair — refusing to discard\n' +
        '  the old credential. Raw response keys: ' + Object.keys(data).join(', '),
      { prefix: PREFIX }
    );
  }

  // PERSIST FIRST, BEFORE ANY OTHER USE OF THE NEW PAIR. The rotate above has
  // already invalidated the old refresh token, so from this moment the ONLY copy
  // of a usable credential is in `data`. If this process dies before the write
  // lands, the credential is gone permanently and only a human can mint another.
  // That is why persistence happens here and not after the summary, and why a
  // failed write falls back to printing the pair.
  let persisted = false;
  let persistError = '';
  try {
    await skill.config({
      [APP_TOKEN_CONFIG_KEY]: data.token,
      [REFRESH_TOKEN_CONFIG_KEY]: data.refresh_token,
    });
    persisted = true;
  } catch (e) {
    if (e && e.name === 'NodeExitError') throw e;
    persistError = (e && e.message) || String(e);
  }

  if (!persisted) {
    // Last resort. Printing a secret is normally forbidden (it lands in the
    // transcript), but the old refresh token is ALREADY dead: losing this pair
    // means a human has to mint a replacement by hand. Surfacing beats swallowing.
    console.log('');
    console.log(color.red('  COULD NOT PERSIST THE NEW TOKEN PAIR: ' + persistError));
    console.log(color.red('  Store these NOW — the previous refresh token is already invalid:'));
    console.log('    ' + APP_TOKEN_CONFIG_KEY + ' = ' + data.token);
    console.log('    ' + REFRESH_TOKEN_CONFIG_KEY + ' = ' + data.refresh_token);
    console.log('');
  }

  section('Rotated app configuration token');
  kv('Access', maskToken(data.token));
  kv('Refresh', maskToken(data.refresh_token));
  kv('Stored', persisted ? 'skill config' : color.red('NOT STORED — see above'));
  if (data.exp) kv('Expires', String(data.exp) + ' (unix)');
  if (data.team_id) kv('Team', String(data.team_id));
  console.log('');
  console.log(color.dim('  The previous refresh token is now invalid — it cannot be reused.'));
  console.log('');

  if (flags.json) {
    // Never the token values: this output lands in the agent transcript.
    cli.out({
      rotated: true,
      persisted: persisted,
      access_token: maskToken(data.token),
      refresh_token: maskToken(data.refresh_token),
      exp: data.exp,
      team_id: data.team_id,
    });
  }

  return { rotated: true, persisted: persisted };
}

// ── app group dispatch ──────────────────────────────────────────────────────

async function cmdApp() {
  const sub = words[1] || '';
  if (sub === 'export') return cmdAppExport();
  if (sub === 'show') return cmdAppShow();
  if (sub === 'validate') return cmdAppValidate();
  if (sub === 'diff') return cmdAppDiff();
  if (sub === 'set-scopes') return cmdAppSetScopes();
  if (sub === 'set-events') return cmdAppSetEvents();
  if (sub === 'set-request-url') return cmdAppSetRequestUrl();
  if (sub === 'apply') return cmdAppApply();
  if (sub === 'token-rotate') return cmdAppTokenRotate();
  cli.die(
    'Unknown app subcommand: ' + (sub || '(none)') + '\n' +
      '  Read-only: export, show, validate, diff\n' +
      '  Writes (need --confirm): set-scopes, set-events, set-request-url, apply,\n' +
      '  token-rotate\n' +
      '  apps.manifest.create and apps.manifest.delete are deliberately never wired\n' +
      '  up (deleting a Slack app is unrecoverable).',
    { prefix: PREFIX }
  );
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
  if (cmd === 'app') return cmdApp();

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
