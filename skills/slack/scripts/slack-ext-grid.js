// slack-ext-grid.js — Pure logic for slack-ext Enterprise Grid admin commands.
//
// This module contains NO `fs`, `path`, or `sliccy:*` imports so it runs in
// the SLICC tst test realm as a plain CommonJS module. All functions are pure
// (no side effects, no I/O) and are consumed by slack-ext.jsh at runtime.
//
// ── Wire facts (verified live 2026-09-22) ─────────────────────────────────────
//
// ENTERPRISE USER METHODS — all in `enterprise.users.admin.*`:
//   enterprise.users.admin.setRestricted  → make MULTI-CHANNEL GUEST
//     verified: ok:true observed from UI; bogus user → user_not_found
//   enterprise.users.admin.setRegular     → make FULL MEMBER
//     verified: ok:true observed from UI; bogus user → user_not_found
//   enterprise.users.admin.setStatus (status=delete) → DEACTIVATE
//     TRAP: status=delete means deactivate (reversible), NOT permanent delete.
//     verified: ok:true observed from UI; bogus user → invalid_user (different
//     from user_not_found — the field is named `user` but Slack validates it
//     differently for this endpoint). Observed _x_reason=deactivateMembers.
//   users.admin.profileDeidentify → GDPR FORGET (IRREVERSIBLE)
//     Real name becomes "Deactivated User", handle becomes deactivateduser<N>,
//     guest flags cleared. CANNOT BE UNDONE. Observed _x_reason=forget-user.
//     This method is in the WORKSPACE-LEVEL `users.admin.*` namespace despite
//     being an org-wide operation.
//   enterprise.users.admin.setUltraRestricted → SINGLE-CHANNEL GUEST
//     ** UNVERIFIED: method exists (bogus user → user_not_found, confirming
//     the endpoint is real) but ok:true was NEVER OBSERVED from the UI.
//     Treat as best-effort; marked UNVERIFIED in SKILL.md and in the code. **
//
// TOKEN: enterprise methods use the ORG-LEVEL xoxc token, found in
//   localStorage['localConfig_v2'].teams['E06V3987PMY'].token
//   (vs workspace-level commands that use teams['T0385CHDU9E'].token).
//   Both are xoxc tokens — same auth mechanism, different org/ws scopes.
//
// AUDIT ATTRIBUTION — IMPORTANT NUANCE:
//   Session-token (xoxc) calls are INDISTINGUISHABLE FROM THE HUMAN'S OWN
//   DIRECT ACTIONS in Slack's channel event history. A concrete case:
//   #aem-fedex (C0C2CUUDWLE) was archived by Zapier at 2026-09-17T00:17:04Z;
//   the channel event log records Lars Trieloff as the actor, not Zapier,
//   because Zapier ran on his user OAuth token. These commands do the same.
//   The Enterprise Audit Logs API (auditlogs:read scope) WOULD record the
//   acting app and distinguish automation from a human click — but
//   admin.audit.* methods return unknown_method (six variants probed, all
//   unknown). There is currently no working API call that distinguishes an
//   xoxc-based script from a human in the channel event log.
//
// CHANNEL COMMANDS — `admin.conversations.*`:
//   admin.conversations.convertToPublic   takes channel_id (verified real)
//   admin.conversations.convertToPrivate  takes channel_id (verified real)
//   PRIVATE CHANNEL INVISIBILITY: after converting to private, the channel
//   becomes invisible to non-members. conversations.info returns channel_not_found,
//   conversations.genericInfo returns ok:true with an EMPTY array, and the edge
//   cache returns the id under failed_ids. This is not an error — handle it by
//   reporting "channel is now private and not visible to this caller".
//
// CHANNEL SEARCH — `admin.conversations.search`:
//   MEASURED DEFECT: the `channel_ids` parameter is SILENTLY IGNORED.
//   Passing channel_ids=C0634KMGW2G (bare string) AND channel_ids=["C0634KMGW2G"]
//   (JSON array) both returned ok:true with the UNFILTERED full list. NEVER use
//   channel_ids as a filter — it silently answers about the wrong channel.
//   Instead: enumerate (with cursor) and filter locally. This code enforces it.
//
// SLACK CONNECT APPROVALS — `conversations.sharedApprovals.list`:
//   Returns pending (and other) Slack Connect invite approvals.
//   Verified: 977 total approvals in the org at time of writing.
//   Paginates via response_metadata.next_cursor.
//
// APP GOVERNANCE:
//   admin.apps.approve / admin.apps.restrict:
//     Either app_id + enterprise_id, OR request_id for a pending install request.
//     SINGLE-USE request_id: approving then restricting the same request_id returns
//     request_already_resolved. To reverse a resolved request, use app_id + enterprise_id.
//   admin.apps.clearResolution  — app_id + enterprise_id
//   admin.apps.permissions.set  — app_id + permission_type (no_one|everyone|named_entities)
//   admin.apps.approved.list / admin.apps.restricted.list — enterprise_id + limit

'use strict';

// ── Parameter builders ─────────────────────────────────────────────────────────
//
// All return plain objects — the caller turns them into FormData / URLSearchParams.
// These are the ONLY call sites that know the exact wire parameter names.

// enterprise.users.admin.setRestricted
// Makes the user a multi-channel guest at the org level.
function buildEgSetRestrictedParams(userId) {
  return { user: userId };
}

// enterprise.users.admin.setRegular
// Promotes the user to a full member at the org level.
function buildEgSetRegularParams(userId) {
  return { user: userId };
}

// enterprise.users.admin.setStatus
// status='delete' = DEACTIVATE (reversible). 'delete' here does NOT mean delete.
// The reactivation status value is NOT KNOWN — do not guess it.
function buildEgSetStatusParams(userId, status) {
  return { user: userId, status: status };
}

// users.admin.profileDeidentify
// IRREVERSIBLE GDPR forget. Real name → "Deactivated User", handle →
// deactivateduser<N>, guest flags cleared. CANNOT BE UNDONE.
function buildDeidentifyParams(userId) {
  return { user: userId };
}

// enterprise.users.admin.setUltraRestricted
// ** UNVERIFIED: endpoint is real (confirmed via probe — bogus user → user_not_found)
// but ok:true was NEVER OBSERVED from the live admin UI session. Do not call
// without confirming the wire format produces the expected result. **
function buildEgSetUltraRestrictedParams(userId) {
  return { user: userId };
}

// admin.conversations.convertToPublic / convertToPrivate
function buildConvertChannelParams(channelId) {
  return { channel_id: channelId };
}

// admin.conversations.search
//
// Observed required/significant parameters (2026-09-22):
//   search_channel_types — changes the result set materially:
//     'all'              — all channels including archived and private
//     'exclude_archived' — non-archived channels only (recommended default)
//     'private'          — private channels only
//     'private_exclude'  — similar to 'all' in observed behaviour
//     'archived'         — archived channels only
//     Note: Lars Trieloff observed omitting this returns invalid_arguments
//     in the UI path; live probe 2026-09-22 returned ok:true without it,
//     suggesting the API defaults internally. Include it explicitly anyway
//     because 'all' vs 'exclude_archived' yields 2072 vs 1515 results —
//     the difference is significant and silent.
//   sort     — valid observed values: 'name', 'member_count', 'created'
//              'last_activity_ts' and 'num_members' return invalid_sort
//   sort_dir — 'asc' | 'desc'
//   query    — may be empty string
//   cursor   — may be empty string
//
// MEASURED DEFECT: channel_ids is SILENTLY IGNORED. Never pass it.
// Filter results locally; see filterChannels() below.

const VALID_SEARCH_CHANNEL_TYPES = new Set(
  ['all', 'exclude_archived', 'private', 'private_exclude', 'archived']
);
const VALID_CHANNEL_SORT_FIELDS = new Set(['name', 'member_count', 'created']);

function buildChannelSearchParams(query, limit, cursor, searchChannelTypes, sort, sortDir) {
  const p = {
    // Empty string is accepted; must be present.
    query: query || '',
    limit: String(limit || 50),
    // Observed in UI; omitting silently defaults to something — include explicitly.
    search_channel_types: searchChannelTypes || 'exclude_archived',
    sort: sort || 'name',
    sort_dir: sortDir || 'asc',
    // Empty-string cursor is accepted and must be present once pagination starts.
    cursor: cursor || '',
  };
  return p;
}

// conversations.sharedApprovals.list
function buildApprovalsListParams(limit, query, cursor) {
  const p = { limit: String(limit || 25), sort: 'date_expire', sort_dir: 'desc' };
  if (query) p.query = query;
  if (cursor) p.cursor = cursor;
  return p;
}

// admin.apps.approve / admin.apps.restrict
// Accepts either a pending-install request_id (I…) or app_id + enterprise_id.
// SINGLE-USE request_id: once resolved, further attempts with the same request_id
// return request_already_resolved. Use app_id + enterprise_id to reverse.
function buildAppApproveRestrictParams(opts) {
  if (opts && opts.requestId) {
    return { request_id: opts.requestId };
  }
  return { app_id: opts.appId, enterprise_id: opts.enterpriseId };
}

// admin.apps.clearResolution
function buildAppClearResolutionParams(appId, enterpriseId) {
  return { app_id: appId, enterprise_id: enterpriseId };
}

// admin.apps.permissions.set
function buildAppPermissionsParams(appId, permissionType) {
  return { app_id: appId, permission_type: permissionType };
}

// admin.apps.approved.list / admin.apps.restricted.list
function buildAppListParams(enterpriseId, limit, cursor) {
  const p = { enterprise_id: enterpriseId, limit: String(limit || 50) };
  if (cursor) p.cursor = cursor;
  return p;
}

// ── ID classifiers ─────────────────────────────────────────────────────────────

// Determine whether input looks like a Slack install-request ID (Ixxxxxxxx)
// or an app ID (Axxxxxxxx). Returns { requestId } or { appId } or null.
function resolveAppOrRequestId(input) {
  if (!input || typeof input !== 'string') return null;
  if (/^I[A-Z0-9]{6,}$/i.test(input)) return { requestId: input };
  if (/^A[A-Z0-9]{6,}$/i.test(input)) return { appId: input };
  return null;
}

// Validate a permission_type value for admin.apps.permissions.set.
// Returns true if the value is one of the observed valid options.
const VALID_PERMISSION_TYPES = new Set(['no_one', 'everyone', 'named_entities']);
function isValidPermissionType(t) {
  return VALID_PERMISSION_TYPES.has(t);
}

// ── Channel search helpers ─────────────────────────────────────────────────────

// Filter a list of channel objects by name substring or exact ID match.
// IMPORTANT: do NOT pass channel IDs to admin.conversations.search (silent defect).
// Use this function to filter the locally-collected results instead.
function filterChannels(channels, query) {
  if (!query) return channels.slice();
  const lq = query.toLowerCase();
  return channels.filter(function (c) {
    return (
      (c.id && c.id.toLowerCase() === lq) ||
      (c.name && c.name.toLowerCase().includes(lq))
    );
  });
}

// Summarize a channel object from admin.conversations.search into a concise form.
function summarizeChannel(c) {
  return {
    id: c.id,
    name: c.name,
    is_private: c.is_private,
    is_archived: c.is_archived,
    member_count: c.member_count,
    external_user_count: c.external_user_count,
    purpose: c.purpose,
    created: c.created,
    creator_id: c.creator_id,
    last_activity_ts: c.last_activity_ts,
  };
}

// ── Approval helpers ──────────────────────────────────────────────────────────

// Summarize a sharedApprovals entry into display form.
function summarizeApproval(a) {
  return {
    id: a.id,
    partner_org: a.connecting_team ? a.connecting_team.name : '',
    channel: a.channel ? a.channel.name : '',
    status: a.status,
    expires: a.date_expire,
  };
}

// ── User type classification ───────────────────────────────────────────────────
//
// Mirrors userTypeLabel() in slack-ext.jsh. Reproduced here so tests can exercise
// the flag interpretation without importing the main script (which has sliccy:* deps).

function classifyUser(user) {
  if (!user) return 'unknown';
  if (user.deleted) return 'deactivated';
  if (user.is_bot) return 'bot';
  if (user.is_ultra_restricted) return 'single-channel guest';
  if (user.is_restricted) return 'multi-channel guest';
  return 'regular';
}

// ── Pagination helper (pure, injectable fetch) ────────────────────────────────
//
// Collects all pages from a cursor-paginaged Slack endpoint.
// fetchPage: async (cursor) => { ok, items, next_cursor, error }
// itemsKey: the response field that holds the array (e.g. 'conversations', 'approvals')
// maxItems: hard cap (0 = unlimited)
//
// Returns { items, total_fetched, pages, error? }
async function collectPages(fetchPage, itemsKey, maxItems) {
  const all = [];
  let cursor = '';
  let pages = 0;
  const cap = maxItems || 0;
  do {
    const r = await fetchPage(cursor);
    if (!r.ok) {
      return { items: all, total_fetched: all.length, pages: pages, error: r.error };
    }
    pages += 1;
    const chunk = r[itemsKey] || [];
    for (const item of chunk) {
      all.push(item);
      if (cap > 0 && all.length >= cap) break;
    }
    // next_cursor may be in response_metadata or directly on the body
    const meta = r.response_metadata || {};
    cursor = meta.next_cursor || r.next_cursor || '';
    if (cap > 0 && all.length >= cap) break;
  } while (cursor);
  return { items: all, total_fetched: all.length, pages: pages };
}

// ── Channel archive / unarchive (`channel-archive`, `channel-unarchive`) ──────
//
// Wire facts, measured live 2026-09-25 on E06V3987PMY:
//
//   admin.conversations.archive / admin.conversations.unarchive take
//   `channel_id` and work with the ORG-level xoxc token (the same one
//   channel-to-public uses), including on PRIVATE channels the admin is not a
//   member of. They answer {ok:true} with no warning, so ok:true is not proof:
//   the state is read back afterwards.
//
//   State is read from admin.conversations.search, because conversations.info
//   answers channel_not_found for a private channel the admin is not in.
//     - limit must be <= 20. limit=21 answers invalid_arguments.
//     - search_channel_types=all covers public, private and archived channels.
//       private_archive answers invalid_search_channel_type.
//     - channel_ids is silently ignored (see CHANNEL SEARCH above).
//     - query=<channel id> finds the channel: measured on a 40-channel sample
//       (public, private, archived, ext-shared; private non-member included),
//       40 of 40 found, each as the only hit. A partial id matches nothing and
//       a bogus id answers zero results. The hit is still matched on `id`
//       locally, and a miss falls back to conversations.info -> name -> query.
//     - member_count is -1 for every archived channel in that sample, so -1 is
//       UNKNOWN, never a count. null/undefined are unknown too.
//     - last_activity_ts is MICROSECONDS (16 digits), e.g. 1686690712432979.
//     - conversation_host_id is only present on ext-shared channels. For a
//       channel this org hosts it equals the org id (E06V3987PMY).
//
//   THE SEARCH INDEX LAGS A WRITE. Right after an archive the channel was not
//   yet reported archived; about 30 s later it was. The live round trip for
//   this command (2026-09-25, C0634KMGW2G) measured both directions:
//     unarchive: index showed is_archived:false on the 2nd read, ~5 s after.
//     archive:   still is_archived:false, then MISSING from the index
//                entirely, then is_archived:true between 38 s and 51 s after
//                the write (conversations.info said archived at once).
//   The read-back therefore retries (READBACK_ATTEMPTS, READBACK_DELAY_MS
//   apart: t = 0..90 s), treats "not in the index" as a miss, and reports
//   "unconfirmed", not "failed", when it runs out.

const CHANNEL_SEARCH_MAX_LIMIT = 20;
const CHANNEL_LOOKUP_MAX_PAGES = 5;
const READBACK_ATTEMPTS = 10;
const READBACK_DELAY_MS = 10000;
const DAY_MS = 86400000;

// admin.conversations.archive / admin.conversations.unarchive
function buildArchiveChannelParams(channelId) {
  return { channel_id: channelId };
}

// admin.conversations.search for a single-channel state read. Never above the
// limit of 20, always search_channel_types=all so archived and private
// channels are both visible.
function buildChannelLookupParams(query, cursor) {
  return {
    query: query || '',
    limit: String(CHANNEL_SEARCH_MAX_LIMIT),
    search_channel_types: 'all',
    sort: 'name',
    sort_dir: 'asc',
    cursor: cursor || '',
  };
}

// last_activity_ts -> epoch milliseconds, or null when unknown.
// The measured wire format is microseconds. Seconds and milliseconds are
// recognised by magnitude so that a format change can never turn a recent
// channel into one that looks idle since 1970 (which would pass an idle guard).
function lastActivityToMs(ts) {
  let n = ts;
  if (typeof n === 'string') {
    if (!/^\d+(\.\d+)?$/.test(n.trim())) return null;
    n = Number(n);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e14) return Math.floor(n / 1000); // microseconds (measured)
  if (n >= 1e11) return Math.floor(n); // milliseconds
  if (n >= 1e8) return Math.floor(n * 1000); // seconds (Slack message ts form)
  return null;
}

// Whole days between lastMs and nowMs, or null when lastMs is unknown.
function idleDaysSince(lastMs, nowMs) {
  if (lastMs === null || lastMs === undefined) return null;
  const d = Math.floor((nowMs - lastMs) / DAY_MS);
  return d < 0 ? 0 : d;
}

// A member / external-user count is only a count when it is a non-negative
// integer. null, undefined, NaN, Infinity and ANY negative value are UNKNOWN
// and must never be read as zero. Measured 2026-09-25: an archived channel
// reports member_count: -1 (not null), so a plain `members <= max` check
// would PASS it. Everything downstream compares only the value returned here.
function knownCount(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

// 'not-shared' | 'us' | 'other' | 'unknown'
function classifyChannelHost(c, orgId) {
  const shared = c.is_ext_shared === true || c.is_pending_ext_shared === true;
  if (!shared) return 'not-shared';
  const host = c.conversation_host_id;
  if (!host) return 'unknown';
  return host === orgId ? 'us' : 'other';
}

// External organisations connected to a channel: connected_team_ids minus this
// org and its own workspaces (internal_team_ids, context_team_id). Measured:
// connected_team_ids is e.g. ["T038ARP0G", "E06V3987PMY"] for a channel we
// host with one partner.
function externalTeamIds(ids, c, orgId) {
  const own = new Set([orgId]);
  for (const t of Array.isArray(c.internal_team_ids) ? c.internal_team_ids : []) own.add(t);
  if (c.context_team_id) own.add(c.context_team_id);
  const out = [];
  for (const t of Array.isArray(ids) ? ids : []) {
    if (t && !own.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// Normalise one admin.conversations.search entry into the fields the guards
// and the output need. Unknowns are null, never a default.
function normalizeChannelState(c, orgId, nowMs) {
  const lastMs = lastActivityToMs(c.last_activity_ts);
  return {
    id: c.id,
    name: c.name || null,
    is_private: c.is_private === true,
    is_archived: typeof c.is_archived === 'boolean' ? c.is_archived : null,
    member_count: knownCount(c.member_count),
    member_count_raw: c.member_count === undefined ? null : c.member_count,
    external_user_count: knownCount(c.external_user_count),
    is_ext_shared: c.is_ext_shared === true,
    is_pending_ext_shared: c.is_pending_ext_shared === true,
    is_org_shared: c.is_org_shared === true,
    conversation_host_id: c.conversation_host_id || null,
    host: classifyChannelHost(c, orgId),
    // Read from the RAW search entry: channel-search's summarizeChannel drops
    // is_ext_shared, is_pending_ext_shared, conversation_host_id and these.
    external_team_ids: externalTeamIds(c.connected_team_ids, c, orgId),
    pending_external_team_ids: externalTeamIds(c.pending_connected_team_ids, c, orgId),
    last_activity_ts: c.last_activity_ts === undefined ? null : c.last_activity_ts,
    last_activity_ms: lastMs,
    last_activity_date: lastMs === null ? null : new Date(lastMs).toISOString().slice(0, 10),
    idle_days: idleDaysSince(lastMs, nowMs),
  };
}

// What archiving a Slack Connect channel we host does to its partners, in
// plain words. Measured 2026-09-25 on 5 of 5 channels: after
// admin.conversations.archive the channel reads is_ext_shared:false,
// is_pending_ext_shared:false, external_user_count:0, connected_team_ids:[].
// Unarchiving is inferred (not tested) NOT to restore the connections; that
// takes a new Slack Connect invitation. Returns null for a channel that is not
// ext-shared or pending.
function sharedArchiveImpact(state) {
  if (!state || state.host === 'not-shared') return null;
  const users = state.external_user_count;
  const orgs = state.external_team_ids || [];
  const pending = state.pending_external_team_ids || [];
  const usersText =
    users === null ? 'an unknown number of external users' : users + ' external user' + (users === 1 ? '' : 's');
  const orgsText =
    orgs.length + ' external organisation' + (orgs.length === 1 ? '' : 's') +
    (orgs.length ? ' (' + orgs.join(', ') + ')' : '');
  let text = 'Archiving will disconnect ' + usersText + ' from ' + orgsText + '.';
  if (pending.length) {
    text += ' It also ends ' + pending.length + ' pending Slack Connect invitation' +
      (pending.length === 1 ? '' : 's') + ' (' + pending.join(', ') + ').';
  }
  text += ' Unarchiving will NOT reconnect them: that needs a new Slack Connect invitation.';
  return {
    external_users: users,
    external_team_ids: orgs.slice(),
    pending_external_team_ids: pending.slice(),
    reversible: false,
    text: text,
  };
}

function guardResult(outcome, reason, detail) {
  return { outcome: outcome, reason: reason, detail: detail };
}

// The guards, in order. action is 'archive' or 'unarchive'.
// outcome: 'proceed' | 'noop' (exit 0, nothing to do) | 'refuse' (exit 1).
// opts: { orgId, maxMembers, minIdleDays, allowShared } — maxMembers and
// minIdleDays are null/undefined when the flag was not given.
function evaluateChannelGuards(action, state, opts) {
  const o = opts || {};
  if (!state) {
    return guardResult(
      'refuse',
      'not-found',
      'no channel with this id in admin.conversations.search (search_channel_types=all)'
    );
  }
  if (state.is_archived === null) {
    return guardResult('refuse', 'archived-unknown', 'Slack did not report is_archived');
  }
  if (action === 'archive' && state.is_archived) {
    return guardResult('noop', 'already-archived', 'the channel is already archived');
  }
  if (action === 'unarchive' && !state.is_archived) {
    return guardResult('noop', 'not-archived', 'the channel is not archived');
  }
  if (state.host === 'other') {
    return guardResult(
      'refuse',
      'ext-shared-hosted-elsewhere',
      'ext-shared channel hosted by ' + state.conversation_host_id + ', not by ' + o.orgId
    );
  }
  if (state.host === 'unknown') {
    return guardResult(
      'refuse',
      'ext-shared-host-unknown',
      'ext-shared channel with no conversation_host_id; cannot tell who hosts it'
    );
  }
  if (action === 'archive') {
    if (state.host === 'us' && !o.allowShared) {
      return guardResult(
        'refuse',
        'ext-shared-requires-allow-shared',
        'Slack Connect channel hosted by this org. ' + sharedArchiveImpact(state).text +
          ' Pass --allow-shared to archive it anyway'
      );
    }
    if (o.maxMembers !== null && o.maxMembers !== undefined) {
      if (state.member_count === null) {
        return guardResult(
          'refuse',
          'members-unknown',
          'member count unknown (Slack reported ' + JSON.stringify(state.member_count_raw) +
            '); --max-members=' + o.maxMembers + ' cannot be checked'
        );
      }
      if (state.member_count > o.maxMembers) {
        return guardResult(
          'refuse',
          'members-over-limit',
          state.member_count + ' members > --max-members=' + o.maxMembers
        );
      }
    }
    if (o.minIdleDays !== null && o.minIdleDays !== undefined) {
      if (state.idle_days === null) {
        return guardResult(
          'refuse',
          'activity-unknown',
          'last activity unknown (last_activity_ts=' + JSON.stringify(state.last_activity_ts) +
            '); --min-idle-days=' + o.minIdleDays + ' cannot be checked'
        );
      }
      if (state.idle_days < o.minIdleDays) {
        return guardResult(
          'refuse',
          'active-recently',
          'idle ' + state.idle_days + ' days < --min-idle-days=' + o.minIdleDays
        );
      }
    }
  }
  return guardResult('proceed', null, 'all guards hold');
}

// Find one channel by id. `call(method, params)` resolves to a Slack body.
// 1. admin.conversations.search query=<id>, matched on id locally.
// 2. On a miss: take the name from opts.name, else from conversations.info
//    (public channels and channels the admin is in), and search by name.
// Returns { found, channel, via, error }. A miss is { found:false } and the
// caller refuses as not-found.
//
// "Not found" is only reported after a COMPLETE search. Anything short of that
// is an error, never a miss (channel-search has shipped both of these as a
// false "no channels matched": --max dropping matches, and --json printing no
// JSON on zero results):
//   - no body, ok:false, or ok:true without a conversations array
//     -> error (no_response / the Slack error / malformed_response)
//   - the page cap reached while a next_cursor is still pending
//     -> error lookup_truncated (the rest was never looked at)
//   - conversations.info failing with anything but channel_not_found
//     -> error (the name fallback never ran)
// This helper never calls channel-search and has no --max-style cap that can
// end a search early and call it empty.
async function lookupChannel(call, channelId, opts) {
  const o = opts || {};
  const maxPages = o.maxPages || CHANNEL_LOOKUP_MAX_PAGES;
  async function searchFor(query) {
    let cursor = '';
    for (let page = 0; page < maxPages; page += 1) {
      const r = await call('admin.conversations.search', buildChannelLookupParams(query, cursor));
      if (!r || typeof r !== 'object') return { error: 'no_response' };
      if (!r.ok) return { error: r.error || 'no_response' };
      if (!Array.isArray(r.conversations)) return { error: 'malformed_response' };
      const hit = r.conversations.find((c) => c && c.id === channelId);
      if (hit) return { channel: hit };
      const meta = r.response_metadata || {};
      cursor = r.next_cursor || meta.next_cursor || '';
      if (!cursor) return { channel: null };
    }
    return { error: 'lookup_truncated' };
  }
  const byId = await searchFor(channelId);
  if (byId.error) return { found: false, channel: null, via: 'id', error: byId.error };
  if (byId.channel) return { found: true, channel: byId.channel, via: 'id' };
  let name = o.name || null;
  if (!name) {
    const info = await call('conversations.info', { channel: channelId });
    if (!info || typeof info !== 'object') {
      return { found: false, channel: null, via: 'id', error: 'no_response' };
    }
    if (info.ok && info.channel && info.channel.name) {
      name = info.channel.name;
    } else if (!info.ok && info.error !== 'channel_not_found') {
      // channel_not_found is the expected answer for a private channel the
      // admin is not in. Anything else means the fallback did not run.
      return { found: false, channel: null, via: 'id', error: 'conversations.info: ' + (info.error || 'no_response') };
    }
  }
  if (!name) return { found: false, channel: null, via: 'id' };
  const byName = await searchFor(name);
  if (byName.error) return { found: false, channel: null, via: 'name', error: byName.error };
  if (byName.channel) return { found: true, channel: byName.channel, via: 'name' };
  return { found: false, channel: null, via: 'name' };
}

// Poll until the search index reports is_archived === wantArchived.
// Returns { confirmed, attempts, channel, error }.
async function readBackArchived(call, channelId, wantArchived, opts) {
  const o = opts || {};
  const attempts = o.attempts || READBACK_ATTEMPTS;
  const delayMs = o.delayMs === undefined ? READBACK_DELAY_MS : o.delayMs;
  const sleep = o.sleep;
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    last = await lookupChannel(call, channelId, { name: o.name });
    if (last.found && last.channel.is_archived === wantArchived) {
      return { confirmed: true, attempts: i, channel: last.channel };
    }
    if (i < attempts) await sleep(delayMs);
  }
  return {
    confirmed: false,
    attempts: attempts,
    channel: last && last.found ? last.channel : null,
    error: last ? last.error || null : null,
  };
}

// The whole channel-archive / channel-unarchive flow, with every side effect
// injected: call(method, params), sleep(ms), now() -> epoch ms.
//
// Dry run:   read -> guards -> report. Never writes.
// --confirm: read (this IS the pre-write re-check: nothing sits between it and
//            the write) -> guards -> write -> read-back with retries.
//
// result.exitCode: 0 dry run / noop / confirmed, 1 refused / read or write
// error, 3 written but the read-back never saw the new state (unconfirmed).
async function runChannelArchiveFlow(spec) {
  const action = spec.action;
  const method = action === 'archive' ? 'admin.conversations.archive' : 'admin.conversations.unarchive';
  const wantArchived = action === 'archive';
  const guardOpts = {
    orgId: spec.orgId,
    maxMembers: spec.maxMembers,
    minIdleDays: spec.minIdleDays,
    allowShared: spec.allowShared === true,
  };
  const result = {
    action: action,
    channel_id: spec.channelId,
    org: spec.orgId,
    mode: spec.confirm ? 'confirm' : 'dry-run',
    method: method,
    state: null,
    lookup_via: null,
    decision: null,
    write: null,
    readback: null,
    status: null,
    exitCode: 0,
  };

  const found = await lookupChannel(spec.call, spec.channelId);
  if (found.error) {
    result.status = 'read-error';
    result.error = 'channel lookup failed (' + found.error + '): whether the channel exists is UNKNOWN, so nothing was changed';
    result.exitCode = 1;
    return result;
  }
  result.lookup_via = found.found ? found.via : null;
  result.state = found.found ? normalizeChannelState(found.channel, spec.orgId, spec.now()) : null;
  result.decision = evaluateChannelGuards(action, result.state, guardOpts);
  result.impact = action === 'archive' ? sharedArchiveImpact(result.state) : null;

  if (!spec.confirm) {
    result.status = 'dry-run';
    return result;
  }
  if (result.decision.outcome === 'noop') {
    result.status = result.decision.reason;
    return result;
  }
  if (result.decision.outcome === 'refuse') {
    result.status = 'refused';
    result.exitCode = 1;
    return result;
  }

  const w = await spec.call(method, buildArchiveChannelParams(spec.channelId));
  result.write = { method: method, ok: !!(w && w.ok), error: w && !w.ok ? w.error || 'no_response' : null };
  if (!result.write.ok) {
    result.status = 'error';
    result.exitCode = 1;
    return result;
  }

  const rb = await readBackArchived(spec.call, spec.channelId, wantArchived, {
    attempts: spec.readbackAttempts,
    delayMs: spec.readbackDelayMs,
    sleep: spec.sleep,
    name: result.state.name,
  });
  const verb = action === 'archive' ? 'archived' : 'unarchived';
  result.readback = {
    confirmed: rb.confirmed,
    attempts: rb.attempts,
    state: rb.channel ? normalizeChannelState(rb.channel, spec.orgId, spec.now()) : null,
    error: rb.error || null,
  };
  if (rb.confirmed) {
    result.status = verb + ' (confirmed)';
  } else {
    result.status =
      verb + ' (unconfirmed: search index did not reflect it after ' + rb.attempts + ' attempts)';
    result.exitCode = 3;
  }
  return result;
}

// ── Argument validation for channel-archive / channel-unarchive ──────────────
//
// Fail CLOSED on anything the command does not understand. parseArgv keeps
// unknown flags, so a typo such as --max-member=2 used to leave the real guard
// unset (null) and let a confirmed archive proceed without the guard the
// operator believed was active. Every flag name is checked against an
// explicit allow-list, every guard value must parse, and a stray positional
// word (e.g. `max-members=2` without dashes) is refused too.

// Global flags this CLI reads (see main(), resolveWorkspace, resolveOrg).
const CHANNEL_GLOBAL_FLAGS = ['ws', 'workspace', 'org', 'json', 'confirm', 'help', 'h'];
const CHANNEL_COMMAND_FLAGS = {
  archive: ['max-members', 'min-idle-days', 'allow-shared'],
  unarchive: [],
};
const ARCHIVE_ONLY_FLAGS = CHANNEL_COMMAND_FLAGS.archive;

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const prev = [];
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[n];
}

// Closest allowed flag, or null. Hyphens are ignored so --allowshared finds
// --allow-shared; otherwise at most 3 edits.
function suggestFlag(name, allowed) {
  const bare = (s) => String(s).toLowerCase().replace(/[-_]/g, '');
  let best = null;
  let bestD = Infinity;
  for (const cand of allowed) {
    if (cand.length < 2) continue;
    const d = bare(name) === bare(cand) ? 0 : editDistance(String(name).toLowerCase(), cand);
    if (d < bestD) {
      best = cand;
      bestD = d;
    }
  }
  return bestD <= 3 ? best : null;
}

// A guard count: a plain non-negative integer, nothing else.
// undefined -> { ok:true, value:null } (flag not given).
// true (valueless), '', 'abc', '-3', '2.5', '1e3', ' 2' -> { ok:false }.
function parseGuardCount(raw) {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return { ok: false, value: null };
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return { ok: false, value: null };
  return { ok: true, value: n };
}

// Validate everything the command was given, before any Slack call.
// flags: parsed flag object; positional: all positional words, i.e.
// [command, channel_id, ...anything else]. Anything after the channel id is refused.
// Returns { ok, errors: [{ code, flag?, suggestion?, message }], maxMembers, minIdleDays }.
function checkChannelArchiveArgs(action, flags, positional) {
  const allowed = CHANNEL_GLOBAL_FLAGS.concat(CHANNEL_COMMAND_FLAGS[action] || []);
  const errors = [];
  for (const name of Object.keys(flags || {})) {
    if (allowed.includes(name)) continue;
    if (action === 'unarchive' && ARCHIVE_ONLY_FLAGS.includes(name)) {
      errors.push({
        code: 'archive-only-flag',
        flag: '--' + name,
        message: 'archive-only-flag: --' + name + ' applies to channel-archive only',
      });
      continue;
    }
    const suggestion = suggestFlag(name, allowed);
    errors.push({
      code: 'unknown-flag',
      flag: '--' + name,
      suggestion: suggestion ? '--' + suggestion : null,
      message:
        'unknown-flag: --' + name + (suggestion ? ' (did you mean --' + suggestion + '?)' : ''),
    });
  }
  const extra = (positional || []).slice(2);
  for (const word of extra) {
    errors.push({
      code: 'unexpected-argument',
      message: 'unexpected-argument: "' + word + '" (flags need a leading --)',
    });
  }
  let maxMembers = null;
  let minIdleDays = null;
  if (action === 'archive') {
    for (const name of ['max-members', 'min-idle-days']) {
      const r = parseGuardCount(flags ? flags[name] : undefined);
      if (!r.ok) {
        const shown = flags[name] === true ? '(no value)' : JSON.stringify(flags[name]);
        errors.push({
          code: 'invalid-value',
          flag: '--' + name,
          message: 'invalid-value: --' + name + ' needs a non-negative integer, got ' + shown,
        });
      } else if (name === 'max-members') {
        maxMembers = r.value;
      } else {
        minIdleDays = r.value;
      }
    }
  }
  return { ok: errors.length === 0, errors: errors, maxMembers: maxMembers, minIdleDays: minIdleDays };
}

// ── Exports ────────────────────────────────────────────────────────────────────

module.exports = {
  // Parameter builders
  buildEgSetRestrictedParams,
  buildEgSetRegularParams,
  buildEgSetStatusParams,
  buildDeidentifyParams,
  buildEgSetUltraRestrictedParams, // UNVERIFIED — see wire facts above
  buildConvertChannelParams,
  buildChannelSearchParams,
  buildApprovalsListParams,
  buildAppApproveRestrictParams,
  buildAppClearResolutionParams,
  buildAppPermissionsParams,
  buildAppListParams,
  // Classifiers and helpers
  resolveAppOrRequestId,
  isValidPermissionType,
  VALID_PERMISSION_TYPES,
  VALID_SEARCH_CHANNEL_TYPES,
  VALID_CHANNEL_SORT_FIELDS,
  filterChannels,
  summarizeChannel,
  summarizeApproval,
  classifyUser,
  collectPages,
  // Channel archive / unarchive
  CHANNEL_SEARCH_MAX_LIMIT,
  READBACK_ATTEMPTS,
  READBACK_DELAY_MS,
  buildArchiveChannelParams,
  buildChannelLookupParams,
  lastActivityToMs,
  idleDaysSince,
  knownCount,
  classifyChannelHost,
  normalizeChannelState,
  externalTeamIds,
  sharedArchiveImpact,
  evaluateChannelGuards,
  lookupChannel,
  readBackArchived,
  runChannelArchiveFlow,
  // Argument validation
  CHANNEL_GLOBAL_FLAGS,
  CHANNEL_COMMAND_FLAGS,
  editDistance,
  suggestFlag,
  parseGuardCount,
  checkChannelArchiveArgs,
};
