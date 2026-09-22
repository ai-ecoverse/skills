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
// AUDIT: every call is attributed in the Slack audit log to the HUMAN whose
//   xoxc token is in use. These are NOT bot operations. The adjacent project
//   adobe-rnd/slack-automation performs writes as a bot so the audit trail
//   names the app — this path cannot do that.
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
// NOTE: channel_ids parameter is SILENTLY IGNORED (measured defect). Never pass it.
// Filter results locally using filterChannelsByName/Id after collecting pages.
function buildChannelSearchParams(query, limit, cursor) {
  const p = { limit: String(limit || 50) };
  if (query) p.query = query;
  if (cursor) p.cursor = cursor;
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
  filterChannels,
  summarizeChannel,
  summarizeApproval,
  classifyUser,
  collectPages,
};
