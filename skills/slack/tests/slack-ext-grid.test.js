// slack-ext-grid.test.js — tst suite for skills/slack/scripts/slack-ext-grid.js
//
// Run from skills/slack/:
//   tst tests/slack-ext-grid.test.js
//
// This file imports only `tst` and the relative module — no builtin test runner,
// no fs, no path, no sliccy:* — so it runs in the SLICC test realm as-is, and no
// integration detector can class it as a skip. Do not name that runner even in a
// comment here: a substring-based detector would skip this file for mentioning it.
//
// Covers: parameter builders, ID classifiers, channel helpers, approval
// helpers, user classification, and the pagination utility.

import test, { is, ok, throws } from 'tst';
import * as gridMod from '../scripts/slack-ext-grid.js';

const {
  buildEgSetRestrictedParams,
  buildEgSetRegularParams,
  buildEgSetStatusParams,
  buildDeidentifyParams,
  buildEgSetUltraRestrictedParams,
  buildConvertChannelParams,
  buildChannelSearchParams,
  buildApprovalsListParams,
  buildAppApproveRestrictParams,
  buildAppClearResolutionParams,
  buildAppPermissionsParams,
  buildAppListParams,
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
} = gridMod.default || gridMod;

// ── buildEgSetRestrictedParams ────────────────────────────────────────────────

test('buildEgSetRestrictedParams returns {user}', () => {
  const p = buildEgSetRestrictedParams('U12345');
  is(p.user, 'U12345');
});

test('buildEgSetRestrictedParams has no team_id field', () => {
  const p = buildEgSetRestrictedParams('U12345');
  is(p.team_id, undefined);
});

test('buildEgSetRestrictedParams only has user key', () => {
  const p = buildEgSetRestrictedParams('U12345');
  is(Object.keys(p).length, 1);
});

// ── buildEgSetRegularParams ───────────────────────────────────────────────────

test('buildEgSetRegularParams returns {user}', () => {
  const p = buildEgSetRegularParams('U67890');
  is(p.user, 'U67890');
  is(Object.keys(p).length, 1);
});

// ── buildEgSetStatusParams ────────────────────────────────────────────────────

test('buildEgSetStatusParams with status=delete returns correct shape', () => {
  const p = buildEgSetStatusParams('U12345', 'delete');
  is(p.user, 'U12345');
  is(p.status, 'delete');
});

test('buildEgSetStatusParams includes both user and status keys', () => {
  const p = buildEgSetStatusParams('U12345', 'delete');
  ok(Object.keys(p).includes('user'));
  ok(Object.keys(p).includes('status'));
  is(Object.keys(p).length, 2);
});

test('buildEgSetStatusParams status=delete is NOT permanent delete (wire trap)', () => {
  // status=delete means DEACTIVATE (reversible). The value 'delete' is the wire
  // value observed from the UI; it does not delete the account permanently.
  const p = buildEgSetStatusParams('U12345', 'delete');
  is(p.status, 'delete');
  // The trap: if someone changes this to 'inactive' or 'disabled' they would be
  // calling a DIFFERENT operation. The wire value must stay 'delete'.
  ok(p.status !== 'inactive');
  ok(p.status !== 'disabled');
});

// ── buildDeidentifyParams ─────────────────────────────────────────────────────

test('buildDeidentifyParams returns {user}', () => {
  const p = buildDeidentifyParams('U12345');
  is(p.user, 'U12345');
  is(Object.keys(p).length, 1);
});

// MUTATION TARGET: changing `user` to `user_id` would break this test
test('buildDeidentifyParams uses the key "user" not "user_id"', () => {
  const p = buildDeidentifyParams('U12345');
  ok('user' in p);
  ok(!('user_id' in p));
});

// ── buildEgSetUltraRestrictedParams (UNVERIFIED) ──────────────────────────────

test('buildEgSetUltraRestrictedParams returns {user} — UNVERIFIED endpoint', () => {
  // NOTE: enterprise.users.admin.setUltraRestricted is real (probe confirms
  // user_not_found, not unknown_method) but ok:true was never observed from UI.
  // This test only checks the parameter shape, not the method's behavior.
  const p = buildEgSetUltraRestrictedParams('U12345');
  is(p.user, 'U12345');
  is(Object.keys(p).length, 1);
});

// ── buildConvertChannelParams ─────────────────────────────────────────────────

test('buildConvertChannelParams uses channel_id (not channel)', () => {
  const p = buildConvertChannelParams('C12345');
  is(p.channel_id, 'C12345');
  ok(!('channel' in p));
});

test('buildConvertChannelParams has exactly one key', () => {
  is(Object.keys(buildConvertChannelParams('C12345')).length, 1);
});

// ── buildChannelSearchParams ──────────────────────────────────────────────────

test('buildChannelSearchParams defaults: limit=50, search_channel_types=exclude_archived, sort=name, sort_dir=asc', () => {
  const p = buildChannelSearchParams('', 0, '', '', '', '');
  is(p.limit, '50');
  is(p.search_channel_types, 'exclude_archived');
  is(p.sort, 'name');
  is(p.sort_dir, 'asc');
});

test('buildChannelSearchParams: query always present (empty string)', () => {
  const p = buildChannelSearchParams('', 10, '', '', '', '');
  ok('query' in p);
  is(p.query, '');
});

test('buildChannelSearchParams: cursor always present (empty string)', () => {
  const p = buildChannelSearchParams('', 10, '', '', '', '');
  ok('cursor' in p);
  is(p.cursor, '');
});

test('buildChannelSearchParams: explicit search_channel_types respected', () => {
  is(buildChannelSearchParams('', 10, '', 'all', '', '').search_channel_types, 'all');
  is(buildChannelSearchParams('', 10, '', 'private', '', '').search_channel_types, 'private');
  is(buildChannelSearchParams('', 10, '', 'archived', '', '').search_channel_types, 'archived');
});

test('buildChannelSearchParams: explicit sort respected', () => {
  is(buildChannelSearchParams('', 10, '', '', 'member_count', '').sort, 'member_count');
  is(buildChannelSearchParams('', 10, '', '', 'created', '').sort, 'created');
});

test('buildChannelSearchParams: explicit sort_dir=desc respected', () => {
  is(buildChannelSearchParams('', 10, '', '', '', 'desc').sort_dir, 'desc');
});

test('buildChannelSearchParams includes query when provided', () => {
  const p = buildChannelSearchParams('support', 10, '', '', '', '');
  is(p.query, 'support');
  is(p.limit, '10');
});

test('buildChannelSearchParams never includes channel_ids (measured defect guard)', () => {
  // channel_ids is silently ignored by Slack — passing it returns the unfiltered
  // list confidently. This test verifies we never emit it.
  const p = buildChannelSearchParams('anything', 50, '', 'all', 'name', 'asc');
  ok(!('channel_ids' in p));
});

test('buildChannelSearchParams includes cursor when provided', () => {
  const p = buildChannelSearchParams('', 10, 'dXNlcjpV', '', '', '');
  is(p.cursor, 'dXNlcjpV');
});

// MUTATION TARGET: defaulting to 'all' instead of 'exclude_archived' silently
// changes result counts (2072 all vs 1515 exclude_archived in this org).
test('buildChannelSearchParams default is exclude_archived not all', () => {
  const p = buildChannelSearchParams('', 10, '', '', '', '');
  ok(p.search_channel_types !== 'all');
  is(p.search_channel_types, 'exclude_archived');
});

// ── VALID_SEARCH_CHANNEL_TYPES and VALID_CHANNEL_SORT_FIELDS ──────────────────

test('VALID_SEARCH_CHANNEL_TYPES has all 5 observed values', () => {
  ok(VALID_SEARCH_CHANNEL_TYPES.has('all'));
  ok(VALID_SEARCH_CHANNEL_TYPES.has('exclude_archived'));
  ok(VALID_SEARCH_CHANNEL_TYPES.has('private'));
  ok(VALID_SEARCH_CHANNEL_TYPES.has('private_exclude'));
  ok(VALID_SEARCH_CHANNEL_TYPES.has('archived'));
  is(VALID_SEARCH_CHANNEL_TYPES.size, 5);
});

test('VALID_CHANNEL_SORT_FIELDS: name, member_count, created are valid', () => {
  ok(VALID_CHANNEL_SORT_FIELDS.has('name'));
  ok(VALID_CHANNEL_SORT_FIELDS.has('member_count'));
  ok(VALID_CHANNEL_SORT_FIELDS.has('created'));
});

test('VALID_CHANNEL_SORT_FIELDS: last_activity_ts not valid (returns invalid_sort live)', () => {
  // Probed live 2026-09-22: last_activity_ts and num_members both return invalid_sort.
  ok(!VALID_CHANNEL_SORT_FIELDS.has('last_activity_ts'));
  ok(!VALID_CHANNEL_SORT_FIELDS.has('num_members'));
});

// ── buildApprovalsListParams ──────────────────────────────────────────────────

test('buildApprovalsListParams includes sort and sort_dir', () => {
  const p = buildApprovalsListParams(10, '', '');
  is(p.sort, 'date_expire');
  is(p.sort_dir, 'desc');
});

test('buildApprovalsListParams default limit is 25', () => {
  const p = buildApprovalsListParams(0, '', '');
  is(p.limit, '25');
});

test('buildApprovalsListParams omits query when empty', () => {
  const p = buildApprovalsListParams(10, '', '');
  ok(!('query' in p));
});

// ── buildAppApproveRestrictParams ─────────────────────────────────────────────

test('buildAppApproveRestrictParams with requestId uses request_id', () => {
  const p = buildAppApproveRestrictParams({ requestId: 'I0C3EKRE3S5' });
  is(p.request_id, 'I0C3EKRE3S5');
  ok(!('app_id' in p));
  ok(!('enterprise_id' in p));
});

test('buildAppApproveRestrictParams with appId uses app_id+enterprise_id', () => {
  const p = buildAppApproveRestrictParams({ appId: 'A0123456789', enterpriseId: 'E06V3987PMY' });
  is(p.app_id, 'A0123456789');
  is(p.enterprise_id, 'E06V3987PMY');
  ok(!('request_id' in p));
});

// MUTATION TARGET: swapping request_id key name or dropping it would fail this
test('buildAppApproveRestrictParams request_id key is exactly "request_id"', () => {
  const p = buildAppApproveRestrictParams({ requestId: 'I999' });
  ok('request_id' in p);
  ok(!('requestId' in p));
});

// ── buildAppClearResolutionParams ─────────────────────────────────────────────

test('buildAppClearResolutionParams returns app_id and enterprise_id', () => {
  const p = buildAppClearResolutionParams('A0123456789', 'E06V3987PMY');
  is(p.app_id, 'A0123456789');
  is(p.enterprise_id, 'E06V3987PMY');
  is(Object.keys(p).length, 2);
});

// ── buildAppPermissionsParams ─────────────────────────────────────────────────

test('buildAppPermissionsParams returns app_id and permission_type', () => {
  const p = buildAppPermissionsParams('A0123456789', 'no_one');
  is(p.app_id, 'A0123456789');
  is(p.permission_type, 'no_one');
});

test('buildAppPermissionsParams with everyone', () => {
  is(buildAppPermissionsParams('A1', 'everyone').permission_type, 'everyone');
});

test('buildAppPermissionsParams with named_entities', () => {
  is(buildAppPermissionsParams('A1', 'named_entities').permission_type, 'named_entities');
});

// ── buildAppListParams ────────────────────────────────────────────────────────

test('buildAppListParams returns enterprise_id and limit', () => {
  const p = buildAppListParams('E06V3987PMY', 10, '');
  is(p.enterprise_id, 'E06V3987PMY');
  is(p.limit, '10');
  ok(!('cursor' in p));
});

test('buildAppListParams includes cursor when provided', () => {
  const p = buildAppListParams('E06V3987PMY', 10, 'abc');
  is(p.cursor, 'abc');
});

// ── resolveAppOrRequestId ─────────────────────────────────────────────────────

test('resolveAppOrRequestId: I-prefix is request ID', () => {
  const r = resolveAppOrRequestId('I0C3EKRE3S5');
  is(r.requestId, 'I0C3EKRE3S5');
  ok(!('appId' in r));
});

test('resolveAppOrRequestId: A-prefix is app ID', () => {
  const r = resolveAppOrRequestId('A0123456789');
  is(r.appId, 'A0123456789');
  ok(!('requestId' in r));
});

test('resolveAppOrRequestId: invalid input returns null', () => {
  is(resolveAppOrRequestId('XBOGUS'), null);
  is(resolveAppOrRequestId(''), null);
  is(resolveAppOrRequestId(null), null);
  is(resolveAppOrRequestId(undefined), null);
});

test('resolveAppOrRequestId: short ID is rejected', () => {
  is(resolveAppOrRequestId('A123'), null);
  is(resolveAppOrRequestId('I123'), null);
});

// MUTATION TARGET: swapping the I/A check would cause wrong routing
test('resolveAppOrRequestId: I and A are not interchangeable', () => {
  const r1 = resolveAppOrRequestId('I0C3EKRE3S5');
  const r2 = resolveAppOrRequestId('A0C3EKRE3S5');
  ok('requestId' in r1);
  ok('appId' in r2);
});

// ── isValidPermissionType ─────────────────────────────────────────────────────

test('isValidPermissionType: known values pass', () => {
  ok(isValidPermissionType('no_one'));
  ok(isValidPermissionType('everyone'));
  ok(isValidPermissionType('named_entities'));
});

test('isValidPermissionType: unknown value fails', () => {
  ok(!isValidPermissionType('admins_only'));
  ok(!isValidPermissionType(''));
  ok(!isValidPermissionType('NO_ONE'));
});

test('VALID_PERMISSION_TYPES has exactly 3 entries', () => {
  is(VALID_PERMISSION_TYPES.size, 3);
});

// ── filterChannels ────────────────────────────────────────────────────────────

const SAMPLE_CHANNELS = [
  { id: 'C001', name: 'general' },
  { id: 'C002', name: 'support-tickets' },
  { id: 'C003', name: 'eng-support' },
  { id: 'C004', name: 'random' },
];

test('filterChannels: no query returns all channels', () => {
  is(filterChannels(SAMPLE_CHANNELS, '').length, 4);
});

test('filterChannels: name substring match is case-insensitive', () => {
  const r = filterChannels(SAMPLE_CHANNELS, 'SUPPORT');
  is(r.length, 2);
  ok(r.some(c => c.id === 'C002'));
  ok(r.some(c => c.id === 'C003'));
});

test('filterChannels: exact ID match works', () => {
  const r = filterChannels(SAMPLE_CHANNELS, 'C001');
  is(r.length, 1);
  is(r[0].name, 'general');
});

test('filterChannels: no match returns empty array', () => {
  is(filterChannels(SAMPLE_CHANNELS, 'zzz-no-such-channel').length, 0);
});

test('filterChannels: does not mutate input array', () => {
  const original = SAMPLE_CHANNELS.slice();
  filterChannels(SAMPLE_CHANNELS, 'support');
  is(SAMPLE_CHANNELS.length, original.length);
});

// MUTATION TARGET: removing case normalization would break this
test('filterChannels: query "General" matches "general" (case insensitive)', () => {
  is(filterChannels(SAMPLE_CHANNELS, 'General').length, 1);
});

// ── summarizeChannel ──────────────────────────────────────────────────────────

test('summarizeChannel picks expected keys', () => {
  const full = {
    id: 'C001',
    name: 'general',
    is_private: false,
    is_archived: false,
    member_count: 150,
    external_user_count: 0,
    purpose: 'General',
    created: 1600000000,
    creator_id: 'U999',
    last_activity_ts: 1700000000,
    // extra fields that should be dropped:
    canvas: {},
    lists: [],
    connected_team_ids: [],
  };
  const s = summarizeChannel(full);
  is(s.id, 'C001');
  is(s.name, 'general');
  is(s.member_count, 150);
  ok(!('canvas' in s));
  ok(!('lists' in s));
});

// ── summarizeApproval ─────────────────────────────────────────────────────────

test('summarizeApproval extracts id, partner_org, channel, status, expires', () => {
  const a = {
    id: 'I0C3EKRE3S5',
    connecting_team: { name: 'Slalom Consulting' },
    channel: { name: 'rtcdp-alphasense' },
    status: 'fulfilled',
    date_expire: 1791213421,
  };
  const s = summarizeApproval(a);
  is(s.id, 'I0C3EKRE3S5');
  is(s.partner_org, 'Slalom Consulting');
  is(s.channel, 'rtcdp-alphasense');
  is(s.status, 'fulfilled');
  is(s.expires, 1791213421);
});

test('summarizeApproval handles missing connecting_team gracefully', () => {
  const s = summarizeApproval({ id: 'I001', status: 'pending', date_expire: 0 });
  is(s.partner_org, '');
  is(s.channel, '');
});

// ── classifyUser ──────────────────────────────────────────────────────────────

test('classifyUser: regular member', () => {
  is(classifyUser({ is_restricted: false, is_ultra_restricted: false, deleted: false, is_bot: false }), 'regular');
});

test('classifyUser: multi-channel guest (is_restricted=true)', () => {
  is(classifyUser({ is_restricted: true, is_ultra_restricted: false, deleted: false, is_bot: false }), 'multi-channel guest');
});

test('classifyUser: single-channel guest (is_ultra_restricted=true)', () => {
  is(classifyUser({ is_restricted: true, is_ultra_restricted: true, deleted: false, is_bot: false }), 'single-channel guest');
});

test('classifyUser: deactivated (deleted=true) overrides guest flags', () => {
  is(classifyUser({ is_restricted: true, is_ultra_restricted: true, deleted: true, is_bot: false }), 'deactivated');
});

test('classifyUser: bot', () => {
  is(classifyUser({ is_restricted: false, is_ultra_restricted: false, deleted: false, is_bot: true }), 'bot');
});

test('classifyUser: deleted takes priority over bot', () => {
  is(classifyUser({ deleted: true, is_bot: true }), 'deactivated');
});

test('classifyUser: null input returns unknown', () => {
  is(classifyUser(null), 'unknown');
  is(classifyUser(undefined), 'unknown');
});

// MUTATION TARGET: swapping deleted/bot priority would break this
test('classifyUser: priority order is deactivated > bot > single-guest > multi-guest > regular', () => {
  is(classifyUser({ deleted: true, is_bot: true, is_ultra_restricted: true }), 'deactivated');
  is(classifyUser({ deleted: false, is_bot: true, is_ultra_restricted: true }), 'bot');
  is(classifyUser({ deleted: false, is_bot: false, is_ultra_restricted: true }), 'single-channel guest');
  is(classifyUser({ deleted: false, is_bot: false, is_restricted: true }), 'multi-channel guest');
  is(classifyUser({ deleted: false, is_bot: false }), 'regular');
});

// ── collectPages ──────────────────────────────────────────────────────────────

test('collectPages: single page with no next_cursor', async () => {
  const pages = [{ ok: true, items: [1, 2, 3], next_cursor: '' }];
  let call = 0;
  const fetch = async () => pages[call++];
  const r = await collectPages(fetch, 'items', 0);
  is(r.items.length, 3);
  is(r.pages, 1);
  is(r.error, undefined);
});

test('collectPages: two pages with cursor handoff', async () => {
  const responses = [
    { ok: true, items: ['a', 'b'], next_cursor: 'cursor1' },
    { ok: true, items: ['c', 'd'], next_cursor: '' },
  ];
  let call = 0;
  const fetch = async (cursor) => {
    // First call cursor should be '', second 'cursor1'
    if (call === 0) is(cursor, '');
    if (call === 1) is(cursor, 'cursor1');
    return responses[call++];
  };
  const r = await collectPages(fetch, 'items', 0);
  is(r.items.length, 4);
  is(r.pages, 2);
});

test('collectPages: response_metadata.next_cursor is respected', async () => {
  const responses = [
    { ok: true, items: ['a'], response_metadata: { next_cursor: 'meta-cursor' } },
    { ok: true, items: ['b'], response_metadata: { next_cursor: '' } },
  ];
  let call = 0;
  const fetch = async () => responses[call++];
  const r = await collectPages(fetch, 'items', 0);
  is(r.items.length, 2);
  is(r.pages, 2);
});

test('collectPages: error on first page returns error, no items', async () => {
  const fetch = async () => ({ ok: false, error: 'not_authed' });
  const r = await collectPages(fetch, 'items', 0);
  is(r.error, 'not_authed');
  is(r.items.length, 0);
});

test('collectPages: maxItems cap stops early', async () => {
  const responses = [
    { ok: true, items: ['a', 'b', 'c'], next_cursor: 'next' },
    { ok: true, items: ['d', 'e'], next_cursor: '' },
  ];
  let call = 0;
  const fetch = async () => responses[call++];
  const r = await collectPages(fetch, 'items', 2);
  is(r.items.length, 2);
  // Should NOT have fetched the second page because cap was hit on first
  is(r.pages, 1);
});

// MUTATION TARGET: removing the maxItems check would break this
test('collectPages: maxItems=1 fetches only one item and stops', async () => {
  const fetch = async () => ({ ok: true, items: ['x', 'y'], next_cursor: 'more' });
  const r = await collectPages(fetch, 'items', 1);
  is(r.items.length, 1);
  is(r.pages, 1);
});

test('collectPages: missing items key returns empty chunk without error', async () => {
  const fetch = async () => ({ ok: true, next_cursor: '' });
  const r = await collectPages(fetch, 'conversations', 0);
  is(r.items.length, 0);
  is(r.error, undefined);
});

// ── Mutation verification matrix ──────────────────────────────────────────────
//
// Each mutation and the test(s) that catch it:
//
// MUTATION G1: In buildEgSetStatusParams, change 'delete' to 'inactive'
//   Caught by: "buildEgSetStatusParams status=delete is NOT permanent delete"
//              "buildEgSetStatusParams includes both user and status keys"
//
// MUTATION G2: In buildDeidentifyParams, change key name to 'user_id'
//   Caught by: "buildDeidentifyParams uses the key 'user' not 'user_id'"
//
// MUTATION G3: In buildConvertChannelParams, change key to 'channel' (not channel_id)
//   Caught by: "buildConvertChannelParams uses channel_id (not channel)"
//
// MUTATION G4: In buildChannelSearchParams, add a channel_ids field
//   Caught by: "buildChannelSearchParams never includes channel_ids"
//
// MUTATION G5: In buildAppApproveRestrictParams, swap requestId branch
//              (use app_id+enterprise_id for request ID input)
//   Caught by: "buildAppApproveRestrictParams with requestId uses request_id"
//              "buildAppApproveRestrictParams request_id key is exactly 'request_id'"
//
// MUTATION G6: In resolveAppOrRequestId, swap I→appId, A→requestId
//   Caught by: "resolveAppOrRequestId: I and A are not interchangeable"
//              "resolveAppOrRequestId: I-prefix is request ID"
//              "resolveAppOrRequestId: A-prefix is app ID"
//
// MUTATION G7: In filterChannels, remove toLowerCase() case normalization
//   Caught by: "filterChannels: name substring match is case-insensitive"
//              "filterChannels: query 'General' matches 'general'"
//
// MUTATION G8: In classifyUser, swap deleted and bot priority
//   Caught by: "classifyUser: deleted takes priority over bot"
//              "classifyUser: priority order is deactivated > bot > ..."
//
// MUTATION G9: In collectPages, remove the maxItems cap check
//   Caught by: "collectPages: maxItems cap stops early"
//              "collectPages: maxItems=1 fetches only one item and stops"
//
// MUTATION G10: In collectPages, ignore response_metadata.next_cursor
//   Caught by: "collectPages: response_metadata.next_cursor is respected"
//
// VERIFICATION RECORD:
//   Each mutation G1-G10 was applied, the named test confirmed to fail,
//   and then reverted. See PR description for details.

// MUTATION G11: In buildChannelSearchParams, change default to 'all' (not 'exclude_archived')
//   Caught by: tests 13, 22
//   (Matters: 'all' returns 2072 channels, 'exclude_archived' returns 1515 in this org)
//
// MUTATION G12: In buildChannelSearchParams, omit query/cursor when empty (undefined)
//   Caught by: tests 14, 15
//   (query and cursor must be present even as empty strings, per observed API behaviour)
//
// VERIFICATION: G1-G12 each applied, named test confirmed to fail, mutation reverted.

// ── channel-archive / channel-unarchive ─────────────────────────────────────────
//
// Every flow test drives runChannelArchiveFlow with a stubbed call() that
// records the exact call sequence, a stubbed sleep() that records each delay,
// and a fixed clock. The write methods must appear only on the paths that are
// allowed to write.

const {
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
  evaluateChannelGuards,
  lookupChannel,
  runChannelArchiveFlow,
} = gridMod.default || gridMod;

const ORG = 'E06V3987PMY';
// 2026-09-25T13:03:06Z, the day these wire facts were measured.
const NOW_MS = 1790341386000;
const DAY = 86400000;
// last_activity_ts is MICROSECONDS on the wire.
const usAgo = (days) => (NOW_MS - days * DAY) * 1000;

function chan(over) {
  return Object.assign(
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
      last_activity_ts: 1679564401348099,
    },
    over || {}
  );
}

// states: channel object per search call, in order (the last one repeats).
// null means "the search does not return it". Each search answers the channel
// plus a decoy with a different id, so a match that is not by id is caught.
function stub(spec) {
  const s = spec || {};
  const calls = [];
  const sleeps = [];
  let searches = 0;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'admin.conversations.search') {
      if (s.searchError) return { ok: false, error: s.searchError };
      const list = s.states || [chan()];
      const st = list[Math.min(searches, list.length - 1)];
      searches += 1;
      const decoy = chan({ id: 'C0DECOY0001', name: 'decoy', is_archived: !(st && st.is_archived) });
      return { ok: true, conversations: st ? [decoy, st] : [decoy], next_cursor: '' };
    }
    if (method === 'conversations.info') {
      return s.info || { ok: false, error: 'channel_not_found' };
    }
    if (method === 'admin.conversations.archive' || method === 'admin.conversations.unarchive') {
      return s.writeResult || { ok: true };
    }
    return { ok: false, error: 'not_mocked' };
  };
  return {
    call,
    calls,
    sleeps,
    seq: () => calls.map((c) => c.method).join(','),
    run: (over) =>
      runChannelArchiveFlow(
        Object.assign(
          {
            action: 'archive',
            channelId: 'C04633RSEDU',
            orgId: ORG,
            confirm: false,
            maxMembers: null,
            minIdleDays: null,
            allowShared: false,
            call,
            sleep: async (ms) => {
              sleeps.push(ms);
            },
            now: () => NOW_MS,
          },
          over || {}
        )
      ),
  };
}

const S = 'admin.conversations.search';
const A = 'admin.conversations.archive';
const U = 'admin.conversations.unarchive';
const writes = (h) => h.calls.filter((c) => c.method === A || c.method === U).length;

// ── pure helpers ──

test('buildArchiveChannelParams sends channel_id only', () => {
  const p = buildArchiveChannelParams('C0634KMGW2G');
  is(JSON.stringify(p), '{"channel_id":"C0634KMGW2G"}');
});

test('buildChannelLookupParams: all six required params, limit 20, types all, no channel_ids', () => {
  const p = buildChannelLookupParams('C0634KMGW2G', '');
  is(
    JSON.stringify(Object.keys(p).sort()),
    JSON.stringify(['cursor', 'limit', 'query', 'search_channel_types', 'sort', 'sort_dir'])
  );
  is(p.limit, '20');
  is(p.search_channel_types, 'all');
  is(p.query, 'C0634KMGW2G');
  is(p.cursor, '');
  is(p.channel_ids, undefined);
});

test('CHANNEL_SEARCH_MAX_LIMIT never exceeds 20 (21 answers invalid_arguments)', () => {
  ok(CHANNEL_SEARCH_MAX_LIMIT <= 20);
  is(Number(buildChannelLookupParams('x').limit) <= 20, true);
});

test('lastActivityToMs: 16-digit microseconds convert to milliseconds', () => {
  is(lastActivityToMs(1686690712432979), 1686690712432);
  is(new Date(lastActivityToMs(1686690712432979)).toISOString(), '2023-06-13T21:11:52.432Z');
  is(lastActivityToMs('1686690712432979'), 1686690712432);
});

test('lastActivityToMs: microseconds are NOT read as milliseconds or seconds', () => {
  // Reading the measured value as ms would land in year ~55,000; as seconds, further.
  const ms = lastActivityToMs(1686690712432979);
  is(new Date(ms).getUTCFullYear(), 2023);
});

test('lastActivityToMs: seconds and milliseconds recognised by magnitude', () => {
  is(lastActivityToMs(1686690712), 1686690712000);
  is(lastActivityToMs('1686690712.432979'), 1686690712432);
  is(lastActivityToMs(1686690712432), 1686690712432);
});

test('lastActivityToMs: missing, zero, negative and garbage are null (unknown)', () => {
  is(lastActivityToMs(undefined), null);
  is(lastActivityToMs(null), null);
  is(lastActivityToMs(0), null);
  is(lastActivityToMs(-5), null);
  is(lastActivityToMs('soon'), null);
  is(lastActivityToMs(12345), null);
});

test('idleDaysSince: assets-adidas measured value is 1282 days idle', () => {
  is(idleDaysSince(lastActivityToMs(1679564401348099), NOW_MS), 1282);
});

test('idleDaysSince: unknown stays null, future clamps to 0', () => {
  is(idleDaysSince(null, NOW_MS), null);
  is(idleDaysSince(NOW_MS + DAY, NOW_MS), 0);
});

test('knownCount: -1, null and undefined are unknown, 0 is a count', () => {
  is(knownCount(-1), null);
  is(knownCount(null), null);
  is(knownCount(undefined), null);
  is(knownCount('6'), null);
  is(knownCount(0), 0);
  is(knownCount(6), 6);
});

test('classifyChannelHost: not-shared, us, other, unknown', () => {
  is(classifyChannelHost(chan(), ORG), 'not-shared');
  is(classifyChannelHost(chan({ is_ext_shared: true, conversation_host_id: ORG }), ORG), 'us');
  is(classifyChannelHost(chan({ is_ext_shared: true, conversation_host_id: 'ELWSLBREU' }), ORG), 'other');
  is(classifyChannelHost(chan({ is_ext_shared: true }), ORG), 'unknown');
  is(classifyChannelHost(chan({ is_pending_ext_shared: true, conversation_host_id: ORG }), ORG), 'us');
});

test('normalizeChannelState: fields, microsecond date, idle days, unknown members', () => {
  const st = normalizeChannelState(chan({ member_count: -1 }), ORG, NOW_MS);
  is(st.name, 'assets-adidas');
  is(st.is_private, true);
  is(st.is_archived, false);
  is(st.member_count, null);
  is(st.member_count_raw, -1);
  is(st.last_activity_date, '2023-03-23');
  is(st.idle_days, 1282);
  is(st.host, 'not-shared');
});

test('evaluateChannelGuards: null state is not-found', () => {
  is(evaluateChannelGuards('archive', null, { orgId: ORG }).reason, 'not-found');
});

test('evaluateChannelGuards: members-unknown for null AND -1 when --max-members is set', () => {
  for (const mc of [null, undefined, -1]) {
    const st = normalizeChannelState(chan({ member_count: mc }), ORG, NOW_MS);
    const d = evaluateChannelGuards('archive', st, { orgId: ORG, maxMembers: 2 });
    is(d.outcome, 'refuse', 'member_count=' + mc);
    is(d.reason, 'members-unknown', 'member_count=' + mc);
  }
});

test('evaluateChannelGuards: unknown members are irrelevant without --max-members', () => {
  const st = normalizeChannelState(chan({ member_count: null }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG }).outcome, 'proceed');
});

test('evaluateChannelGuards: members-over-limit is strictly greater than', () => {
  const st = normalizeChannelState(chan({ member_count: 2 }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG, maxMembers: 2 }).outcome, 'proceed');
  is(evaluateChannelGuards('archive', st, { orgId: ORG, maxMembers: 1 }).reason, 'members-over-limit');
  const zero = normalizeChannelState(chan({ member_count: 0 }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', zero, { orgId: ORG, maxMembers: 0 }).outcome, 'proceed');
});

test('evaluateChannelGuards: active-recently and activity-unknown', () => {
  const recent = normalizeChannelState(chan({ last_activity_ts: usAgo(10) }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', recent, { orgId: ORG, minIdleDays: 30 }).reason, 'active-recently');
  is(evaluateChannelGuards('archive', recent, { orgId: ORG, minIdleDays: 10 }).outcome, 'proceed');
  const unknown = normalizeChannelState(chan({ last_activity_ts: 0 }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', unknown, { orgId: ORG, minIdleDays: 30 }).reason, 'activity-unknown');
});

test('evaluateChannelGuards: ext-shared hosted elsewhere is refused for both actions', () => {
  const st = normalizeChannelState(chan({ is_ext_shared: true, conversation_host_id: 'ELWSLBREU' }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG, allowShared: true }).reason, 'ext-shared-hosted-elsewhere');
  const arch = normalizeChannelState(
    chan({ is_archived: true, is_ext_shared: true, conversation_host_id: 'ELWSLBREU' }),
    ORG,
    NOW_MS
  );
  is(evaluateChannelGuards('unarchive', arch, { orgId: ORG }).reason, 'ext-shared-hosted-elsewhere');
});

test('evaluateChannelGuards: ext-shared hosted by us needs --allow-shared to archive', () => {
  const st = normalizeChannelState(chan({ is_ext_shared: true, conversation_host_id: ORG }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG }).reason, 'ext-shared-requires-allow-shared');
  is(evaluateChannelGuards('archive', st, { orgId: ORG, allowShared: true }).outcome, 'proceed');
});

test('evaluateChannelGuards: ext-shared with no host id is refused as ext-shared-host-unknown', () => {
  const st = normalizeChannelState(chan({ is_ext_shared: true }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG, allowShared: true }).reason, 'ext-shared-host-unknown');
});

test('evaluateChannelGuards: already-archived / not-archived are noop, missing is_archived refuses', () => {
  const arch = normalizeChannelState(chan({ is_archived: true, member_count: -1 }), ORG, NOW_MS);
  const d = evaluateChannelGuards('archive', arch, { orgId: ORG, maxMembers: 1 });
  is(d.outcome, 'noop');
  is(d.reason, 'already-archived');
  is(evaluateChannelGuards('unarchive', normalizeChannelState(chan(), ORG, NOW_MS), { orgId: ORG }).reason, 'not-archived');
  const noFlag = normalizeChannelState(chan({ is_archived: undefined }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', noFlag, { orgId: ORG }).reason, 'archived-unknown');
});

// ── lookup ──

test('lookupChannel: finds by query=<id> and matches on id, not on position', async () => {
  const h = stub();
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, true);
  is(r.channel.id, 'C04633RSEDU');
  is(r.via, 'id');
  is(h.seq(), S);
  is(h.calls[0].params.query, 'C04633RSEDU');
  is(h.calls[0].params.limit, '20');
});

test('lookupChannel: id miss falls back to conversations.info name, then query=<name>', async () => {
  const states = [null, chan()];
  const h = stub({ states, info: { ok: true, channel: { id: 'C04633RSEDU', name: 'assets-adidas' } } });
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, true);
  is(r.via, 'name');
  is(h.seq(), [S, 'conversations.info', S].join(','));
  is(h.calls[2].params.query, 'assets-adidas');
});

test('lookupChannel: miss everywhere is found:false (caller refuses not-found)', async () => {
  const h = stub({ states: [null] });
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, false);
  is(h.seq(), [S, 'conversations.info'].join(','));
});

test('lookupChannel: pages with the cursor, capped, matching id locally', async () => {
  const calls = [];
  const call = async (method, params) => {
    calls.push(params.cursor);
    if (params.cursor === '') return { ok: true, conversations: [chan({ id: 'C0OTHER0001' })], next_cursor: 'p2' };
    return { ok: true, conversations: [chan()], next_cursor: '' };
  };
  const r = await lookupChannel(call, 'C04633RSEDU');
  is(r.found, true);
  is(calls.join('|'), '|p2');
});

// ── flow: dry run ──

test('flow dry run: reads only, makes no archive call', async () => {
  const h = stub();
  const r = await h.run();
  is(h.seq(), S);
  is(writes(h), 0);
  is(r.mode, 'dry-run');
  is(r.status, 'dry-run');
  is(r.decision.outcome, 'proceed');
  is(r.state.member_count, 6);
  is(r.state.idle_days, 1282);
  is(r.exitCode, 0);
});

test('flow dry run: a would-be refusal is reported, still no write', async () => {
  const h = stub();
  const r = await h.run({ maxMembers: 2 });
  is(h.seq(), S);
  is(r.decision.reason, 'members-over-limit');
  is(r.exitCode, 0);
});

test('flow dry run: already archived channel reports already-archived', async () => {
  const h = stub({ states: [chan({ id: 'C0634KMGW2G', name: 'aem-axeno1', is_private: false, is_archived: true, member_count: -1 })] });
  const r = await h.run({ channelId: 'C0634KMGW2G' });
  is(r.decision.reason, 'already-archived');
  is(writes(h), 0);
});

// ── flow: named refusals under --confirm (each: no write, exit 1) ──

const REFUSALS = [
  ['not-found', { states: [null] }, {}],
  ['members-over-limit', {}, { maxMembers: 2 }],
  ['members-unknown', { states: [chan({ member_count: null })] }, { maxMembers: 10 }],
  ['active-recently', { states: [chan({ last_activity_ts: usAgo(3) })] }, { minIdleDays: 30 }],
  ['activity-unknown', { states: [chan({ last_activity_ts: undefined })] }, { minIdleDays: 30 }],
  ['ext-shared-hosted-elsewhere', { states: [chan({ is_ext_shared: true, conversation_host_id: 'E01UA4N2G78' })] }, { allowShared: true }],
  ['ext-shared-host-unknown', { states: [chan({ is_ext_shared: true })] }, {}],
  ['ext-shared-requires-allow-shared', { states: [chan({ is_ext_shared: true, conversation_host_id: ORG })] }, {}],
];

for (const [reason, stubSpec, runOver] of REFUSALS) {
  test('flow --confirm refusal ' + reason + ': named, exit 1, no archive call', async () => {
    const h = stub(stubSpec);
    const r = await h.run(Object.assign({ confirm: true }, runOver));
    is(r.status, 'refused');
    is(r.decision.reason, reason);
    is(r.exitCode, 1);
    is(writes(h), 0);
  });
}

test('flow --confirm members-unknown: member_count null is refused, never read as 0', async () => {
  const h = stub({ states: [chan({ member_count: null })] });
  const r = await h.run({ confirm: true, maxMembers: 5 });
  is(r.decision.reason, 'members-unknown');
  is(r.state.member_count, null);
  is(h.seq(), S);
});

test('flow --confirm re-check: dry run saw 1 member, 4 by confirm time -> refused', async () => {
  // The measured incident: checked at 1 member, 4 members 45 s later.
  const h = stub({ states: [chan({ member_count: 1 }), chan({ member_count: 4 })] });
  const dry = await h.run({ maxMembers: 1 });
  is(dry.decision.outcome, 'proceed');
  const r = await h.run({ confirm: true, maxMembers: 1 });
  is(r.decision.reason, 'members-over-limit');
  is(r.state.member_count, 4);
  is(h.seq(), [S, S].join(','));
  is(writes(h), 0);
});

test('flow --confirm with a failing pre-write read: exit 1, no write', async () => {
  const h = stub({ searchError: 'ratelimited' });
  const r = await h.run({ confirm: true });
  is(r.status, 'read-error');
  is(r.exitCode, 1);
  is(writes(h), 0);
});

// ── flow: already-archived / not-archived ──

test('flow --confirm already-archived: exit 0, nothing to do, no write', async () => {
  const h = stub({ states: [chan({ is_archived: true, member_count: -1 })] });
  const r = await h.run({ confirm: true, maxMembers: 1 });
  is(r.status, 'already-archived');
  is(r.exitCode, 0);
  is(h.seq(), S);
});

test('flow --confirm unarchive of an unarchived channel: not-archived, exit 0, no write', async () => {
  const h = stub();
  const r = await h.run({ action: 'unarchive', confirm: true });
  is(r.status, 'not-archived');
  is(r.exitCode, 0);
  is(writes(h), 0);
});

// ── flow: success, lag, exhausted ──

test('flow --confirm success: re-check, archive, read-back (exact sequence)', async () => {
  const h = stub({ states: [chan(), chan({ is_archived: true, member_count: -1 })] });
  const r = await h.run({ confirm: true, maxMembers: 10, minIdleDays: 365 });
  is(h.seq(), [S, A, S].join(','));
  is(JSON.stringify(h.calls[1].params), '{"channel_id":"C04633RSEDU"}');
  is(r.status, 'archived (confirmed)');
  is(r.readback.confirmed, true);
  is(r.readback.attempts, 1);
  is(r.exitCode, 0);
  is(h.sleeps.length, 0);
});

test('flow --confirm read-back lag: first two reads stale, third confirms', async () => {
  const h = stub({ states: [chan(), chan(), chan(), chan({ is_archived: true })] });
  const r = await h.run({ confirm: true });
  is(h.seq(), [S, A, S, S, S].join(','));
  is(r.status, 'archived (confirmed)');
  is(r.readback.attempts, 3);
  is(h.sleeps.join(','), [READBACK_DELAY_MS, READBACK_DELAY_MS].join(','));
  is(r.exitCode, 0);
});

test('flow --confirm read-back exhausted: unconfirmed (not failed), exit 3', async () => {
  const h = stub({ states: [chan()] });
  const r = await h.run({ confirm: true });
  is(h.calls.filter((c) => c.method === S).length, 1 + READBACK_ATTEMPTS);
  is(writes(h), 1);
  is(r.readback.confirmed, false);
  is(r.readback.attempts, READBACK_ATTEMPTS);
  is(r.status, 'archived (unconfirmed: search index did not reflect it after ' + READBACK_ATTEMPTS + ' attempts)');
  is(r.exitCode, 3);
  is(h.sleeps.length, READBACK_ATTEMPTS - 1);
});

test('flow read-back window covers the measured 38-51 s archive index lag', () => {
  // Live round trip 2026-09-25: the archive showed in the index 38-51 s after
  // the write. A 30 s window (7 x 5 s) ran out and reported unconfirmed.
  ok((READBACK_ATTEMPTS - 1) * READBACK_DELAY_MS >= 60000);
});

test('flow --confirm write error: reported, exit 1, no read-back', async () => {
  const h = stub({ writeResult: { ok: false, error: 'restricted_action' } });
  const r = await h.run({ confirm: true });
  is(h.seq(), [S, A].join(','));
  is(r.status, 'error');
  is(r.write.error, 'restricted_action');
  is(r.exitCode, 1);
});

test('flow --confirm unarchive success: re-check, unarchive, read-back until not archived', async () => {
  const h = stub({ states: [chan({ is_archived: true }), chan({ is_archived: true }), chan({ is_archived: false })] });
  const r = await h.run({ action: 'unarchive', confirm: true });
  is(h.seq(), [S, U, S, S].join(','));
  is(r.status, 'unarchived (confirmed)');
  is(r.exitCode, 0);
});

test('flow: every search call in every path uses limit 20', async () => {
  const h = stub({ states: [chan()] });
  await h.run({ confirm: true });
  ok(h.calls.length > 2);
  for (const c of h.calls.filter((x) => x.method === S)) is(c.params.limit, '20');
});

// MUTATION M1 (pre-write re-check always passes): in runChannelArchiveFlow,
//   skip the `decision.outcome === 'refuse'` return under --confirm.
//   Caught by: every "flow --confirm refusal <reason>" test, "flow --confirm
//   members-unknown ...", "flow --confirm re-check: dry run saw 1 member ...".
// MUTATION M2 (null member count read as 0): in evaluateChannelGuards, drop
//   the members-unknown branch and compare (member_count || 0).
//   Caught by: "evaluateChannelGuards: members-unknown for null AND -1 ...",
//   "flow --confirm refusal members-unknown ...", "flow --confirm
//   members-unknown: member_count null is refused, never read as 0".

// ── member_count: -1 (measured on archived channels) and Slack Connect impact ──

const { externalTeamIds, sharedArchiveImpact, summarizeChannel: _summarize } = gridMod.default || gridMod;

test('knownCount: any negative or non-finite count is unknown', () => {
  for (const n of [-1, -5, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    is(knownCount(n), null, 'knownCount(' + n + ')');
  }
});

test('evaluateChannelGuards: member_count -1 on an ACTIVE channel is members-unknown, not a pass', () => {
  // A plain `members <= max` check would pass -1 for any max.
  const st = normalizeChannelState(chan({ is_archived: false, member_count: -1 }), ORG, NOW_MS);
  is(st.member_count, null);
  const d = evaluateChannelGuards('archive', st, { orgId: ORG, maxMembers: 0 });
  is(d.outcome, 'refuse');
  is(d.reason, 'members-unknown');
});

test('evaluateChannelGuards: NaN / Infinity / -5 member counts are members-unknown', () => {
  for (const mc of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    const st = normalizeChannelState(chan({ member_count: mc }), ORG, NOW_MS);
    is(evaluateChannelGuards('archive', st, { orgId: ORG, maxMembers: 100 }).reason, 'members-unknown', String(mc));
  }
});

test('evaluateChannelGuards: ARCHIVED channel with member_count -1 reports already-archived, not members-unknown', () => {
  const st = normalizeChannelState(chan({ is_archived: true, member_count: -1 }), ORG, NOW_MS);
  const d = evaluateChannelGuards('archive', st, { orgId: ORG, maxMembers: 2, minIdleDays: 30 });
  is(d.outcome, 'noop');
  is(d.reason, 'already-archived');
});

test('flow --confirm: active channel with member_count -1 is refused members-unknown, no archive call', async () => {
  const h = stub({ states: [chan({ is_archived: false, member_count: -1 })] });
  const r = await h.run({ confirm: true, maxMembers: 50 });
  is(r.status, 'refused');
  is(r.decision.reason, 'members-unknown');
  is(r.exitCode, 1);
  is(h.seq(), S);
  is(writes(h), 0);
});

test('flow --confirm: archived channel with member_count -1 reports already-archived, exit 0, no write', async () => {
  const h = stub({ states: [chan({ is_archived: true, member_count: -1 })] });
  const r = await h.run({ confirm: true, maxMembers: 2 });
  is(r.status, 'already-archived');
  is(r.decision.reason, 'already-archived');
  is(r.exitCode, 0);
  is(writes(h), 0);
});

// Measured shape of a Slack Connect channel we host (aem-pga-tour, read-only).
const connectChan = (over) =>
  chan(
    Object.assign(
      {
        id: 'C03GXBSC72T',
        name: 'aem-pga-tour',
        is_private: false,
        member_count: 116,
        external_user_count: 41,
        is_ext_shared: true,
        conversation_host_id: ORG,
        context_team_id: 'T0385CHDU9E',
        connected_team_ids: ['T0BQQL6FJ', ORG, 'E08CP5WPXGT'],
        pending_connected_team_ids: [],
        internal_team_ids: ['T0385CHDU9E'],
      },
      over || {}
    )
  );

test('externalTeamIds: drops this org, its internal workspaces and context team', () => {
  const c = connectChan({ connected_team_ids: ['T0BQQL6FJ', ORG, 'T0385CHDU9E', 'E08CP5WPXGT', 'T0BQQL6FJ'] });
  is(externalTeamIds(c.connected_team_ids, c, ORG).join(','), 'T0BQQL6FJ,E08CP5WPXGT');
  // A missing list is UNKNOWN (null), never an empty list (Codex round 5).
  is(externalTeamIds(undefined, c, ORG), null);
  is(externalTeamIds(null, c, ORG), null);
  is(externalTeamIds('T0BQQL6FJ', c, ORG), null);
  is(externalTeamIds([], c, ORG).length, 0, 'an actual empty list stays empty');
});

test('sharedArchiveImpact: says N external users, M organisations, and NOT reversible', () => {
  const imp = sharedArchiveImpact(normalizeChannelState(connectChan(), ORG, NOW_MS));
  is(imp.external_users, 41);
  is(imp.external_team_ids.join(','), 'T0BQQL6FJ,E08CP5WPXGT');
  is(imp.reversible, false);
  ok(imp.text.includes('Archiving will disconnect 41 external users from 2 external organisations'), imp.text);
  ok(imp.text.includes('Unarchiving will NOT reconnect them'), imp.text);
});

test('sharedArchiveImpact: unknown external count is said as unknown, never 0', () => {
  const imp = sharedArchiveImpact(normalizeChannelState(connectChan({ external_user_count: -1 }), ORG, NOW_MS));
  is(imp.external_users, null);
  ok(imp.text.includes('an unknown number of external users'), imp.text);
});

test('sharedArchiveImpact: pending invitations are named; not-shared channels have no impact', () => {
  const imp = sharedArchiveImpact(
    normalizeChannelState(connectChan({ pending_connected_team_ids: ['T0PENDING1'] }), ORG, NOW_MS)
  );
  ok(imp.text.includes('1 pending Slack Connect invitation (T0PENDING1)'), imp.text);
  is(sharedArchiveImpact(normalizeChannelState(chan(), ORG, NOW_MS)), null);
});

test('ext-shared-requires-allow-shared refusal names the disconnect in plain words', () => {
  const d = evaluateChannelGuards('archive', normalizeChannelState(connectChan(), ORG, NOW_MS), { orgId: ORG });
  is(d.reason, 'ext-shared-requires-allow-shared');
  ok(d.detail.includes('disconnect 41 external users from 2 external organisations'), d.detail);
  ok(d.detail.includes('--allow-shared'), d.detail);
});

test('already-archived is checked before the Slack Connect guard', () => {
  const st = normalizeChannelState(connectChan({ is_archived: true, member_count: -1 }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG }).reason, 'already-archived');
});

test('flow dry run on a Slack Connect channel without --allow-shared: refusal + impact, no write', async () => {
  const h = stub({ states: [connectChan()] });
  const r = await h.run({ channelId: 'C03GXBSC72T' });
  is(h.seq(), S);
  is(r.decision.reason, 'ext-shared-requires-allow-shared');
  is(r.impact.external_users, 41);
  is(r.impact.reversible, false);
});

test('flow --confirm --allow-shared on a Slack Connect channel: re-check, archive, read-back; impact reported', async () => {
  const after = connectChan({
    is_archived: true,
    member_count: -1,
    is_ext_shared: false,
    external_user_count: 0,
    connected_team_ids: [],
  });
  const h = stub({ states: [connectChan(), after] });
  const r = await h.run({ channelId: 'C03GXBSC72T', confirm: true, allowShared: true });
  is(h.seq(), [S, A, S].join(','));
  is(r.status, 'archived (confirmed)');
  is(r.impact.external_team_ids.length, 2);
  is(r.readback.state.is_ext_shared, false);
  is(r.readback.state.external_team_ids.length, 0);
});

test('state read uses the RAW search entry: fields channel-search --json drops still drive the guards', () => {
  const raw = connectChan();
  const summary = _summarize(raw);
  is(summary.is_ext_shared, undefined, 'summarizeChannel drops is_ext_shared (known follow-up)');
  is(summary.conversation_host_id, undefined);
  const st = normalizeChannelState(raw, ORG, NOW_MS);
  is(st.is_ext_shared, true);
  is(st.conversation_host_id, ORG);
  is(st.host, 'us');
});

// MUTATION M3 (-1 accepted as a count): in knownCount, drop `&& n >= 0`.
//   Caught by: "knownCount: any negative or non-finite count is unknown",
//   "evaluateChannelGuards: member_count -1 on an ACTIVE channel ...",
//   "flow --confirm: active channel with member_count -1 is refused ...".
// MUTATION M4 (member guard before already-archived): move the
//   already-archived check below the member-count guard.
//   Caught by: "... ARCHIVED channel with member_count -1 reports already-archived ...",
//   "flow --confirm: archived channel with member_count -1 reports already-archived ...".

// ── A lookup that did not complete is a FAILURE, never "not found" ────────────
//
// channel-search has shipped two false "no channels matched" answers: --max
// dropping matches, and --json printing no JSON on zero results. A false
// not-found here would say a channel does not exist when it does. So every
// incomplete read must surface as an error.

function rawCall(fn) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    return fn(method, params, calls.length);
  };
  return { call, calls };
}

test('lookupChannel: no body at all is an error, not not-found', async () => {
  const h = rawCall(() => undefined);
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, false);
  is(r.error, 'no_response');
});

test('lookupChannel: null / non-object body is an error, not not-found', async () => {
  for (const body of [null, 'oops', 42]) {
    const r = await lookupChannel(rawCall(() => body).call, 'C04633RSEDU');
    is(r.error, 'no_response', 'body=' + JSON.stringify(body));
  }
});

test('lookupChannel: ok:true with no conversations array is malformed_response, not not-found', async () => {
  for (const body of [{ ok: true }, { ok: true, conversations: null }, { ok: true, conversations: {} }]) {
    const h = rawCall((m) => (m === 'admin.conversations.search' ? body : { ok: false, error: 'channel_not_found' }));
    const r = await lookupChannel(h.call, 'C04633RSEDU');
    is(r.found, false);
    is(r.error, 'malformed_response', JSON.stringify(body));
    is(h.calls.length, 1, 'must stop at the malformed page, not fall back and call it a miss');
  }
});

test('lookupChannel: page cap reached with a cursor pending is lookup_truncated, not not-found', async () => {
  const h = rawCall(() => ({ ok: true, conversations: [chan({ id: 'C0OTHER0001' })], next_cursor: 'more' }));
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, false);
  is(r.error, 'lookup_truncated');
  is(h.calls.filter((c) => c.method === S).length, 5);
});

test('lookupChannel: a complete search with no hit (cursor exhausted) IS not-found', async () => {
  // Control for the three tests above: a genuine, complete miss stays a miss.
  const h = rawCall((m) =>
    m === 'admin.conversations.search'
      ? { ok: true, conversations: [chan({ id: 'C0OTHER0001' })], next_cursor: '' }
      : { ok: false, error: 'channel_not_found' }
  );
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, false);
  is(r.error, undefined);
});

test('lookupChannel: conversations.info failing with anything but channel_not_found is an error', async () => {
  const miss = { ok: true, conversations: [], next_cursor: '' };
  const r1 = await lookupChannel(
    rawCall((m) => (m === S ? miss : { ok: false, error: 'ratelimited' })).call,
    'C04633RSEDU'
  );
  is(r1.error, 'conversations.info: ratelimited');
  const r2 = await lookupChannel(rawCall((m) => (m === S ? miss : undefined)).call, 'C04633RSEDU');
  is(r2.error, 'no_response');
});

test('lookupChannel: never calls channel-search-style params (no max, no channel_ids)', async () => {
  const h = rawCall((m) => (m === S ? { ok: true, conversations: [], next_cursor: '' } : { ok: false, error: 'channel_not_found' }));
  await lookupChannel(h.call, 'C04633RSEDU');
  for (const c of h.calls.filter((x) => x.method === S)) {
    is(c.params.max, undefined);
    is(c.params.channel_ids, undefined);
    is(c.params.limit, '20');
  }
});

test('flow --confirm with a missing body: read-error, exit 1, no decision, no write', async () => {
  const h = rawCall(() => undefined);
  const r = await runChannelArchiveFlow({
    action: 'archive', channelId: 'C04633RSEDU', orgId: ORG, confirm: true,
    maxMembers: null, minIdleDays: null, call: h.call, sleep: async () => {}, now: () => NOW_MS,
  });
  is(r.status, 'read-error');
  is(r.exitCode, 1);
  is(r.decision, null, 'must not be evaluated as not-found');
  is(h.calls.filter((c) => c.method === A).length, 0);
});

test('flow dry run with a malformed body: read-error (exit 1), not a not-found report', async () => {
  const h = rawCall(() => ({ ok: true }));
  const r = await runChannelArchiveFlow({
    action: 'archive', channelId: 'C04633RSEDU', orgId: ORG, confirm: false,
    maxMembers: null, minIdleDays: null, call: h.call, sleep: async () => {}, now: () => NOW_MS,
  });
  is(r.status, 'read-error');
  is(r.exitCode, 1);
  ok(/malformed_response/.test(r.error), r.error);
});

// MUTATION M5 (malformed body read as empty): in lookupChannel, replace the
//   Array.isArray(r.conversations) check with `(r.conversations || [])`.
//   Caught by: "lookupChannel: ok:true with no conversations array is
//   malformed_response ...", "flow dry run with a malformed body ...".

// ── argument validation (channel-archive / channel-unarchive) ─────────────────

const { suggestFlag, parseGuardCount, checkChannelArchiveArgs, editDistance, CHANNEL_GLOBAL_FLAGS } =
  gridMod.default || gridMod;
const P = ['channel-archive', 'C04633RSEDU'];

test('suggestFlag: singular, missing hyphen and typo map to the real flag', () => {
  const allowed = CHANNEL_GLOBAL_FLAGS.concat(['max-members', 'min-idle-days', 'allow-shared']);
  is(suggestFlag('max-member', allowed), 'max-members');
  is(suggestFlag('min-idle-day', allowed), 'min-idle-days');
  is(suggestFlag('allowshared', allowed), 'allow-shared');
  is(suggestFlag('confrm', allowed), 'confirm');
  is(suggestFlag('completely-unrelated-thing', allowed), null);
  is(editDistance('kitten', 'sitting'), 3);
});

test('parseGuardCount: only plain non-negative integers', () => {
  is(JSON.stringify(parseGuardCount(undefined)), '{"ok":true,"value":null}');
  is(parseGuardCount('0').value, 0);
  is(parseGuardCount('180').value, 180);
  for (const bad of [true, '', 'abc', '-3', '2.5', '1e3', ' 2', '+2', '0x10', '99999999999999999999']) {
    is(parseGuardCount(bad).ok, false, 'must reject ' + JSON.stringify(bad));
  }
});

test('checkChannelArchiveArgs: every global and command flag is accepted', () => {
  const r = checkChannelArchiveArgs(
    'archive',
    { ws: 'T0385CHDU9E', workspace: 'T1', org: 'E06V3987PMY', json: true, confirm: true, 'max-members': '2', 'min-idle-days': '180', 'allow-shared': true },
    P
  );
  is(r.ok, true, JSON.stringify(r.errors));
  is(r.maxMembers, 2);
  is(r.minIdleDays, 180);
});

test('checkChannelArchiveArgs: unknown flags fail closed with the named code and a suggestion', () => {
  const r = checkChannelArchiveArgs('archive', { 'max-member': '2', confirm: true }, P);
  is(r.ok, false);
  is(r.errors[0].code, 'unknown-flag');
  is(r.errors[0].message, 'unknown-flag: --max-member (did you mean --max-members?)');
  is(r.maxMembers, null, 'the misspelled guard must never populate the real one');
});

test('checkChannelArchiveArgs: an unknown flag with no near match still fails', () => {
  const r = checkChannelArchiveArgs('archive', { 'totally-new': '1' }, P);
  is(r.ok, false);
  is(r.errors[0].message, 'unknown-flag: --totally-new');
});

test('checkChannelArchiveArgs: bad guard values are invalid-value, never null', () => {
  for (const [name, raw] of [['max-members', 'abc'], ['max-members', ''], ['min-idle-days', '-3'], ['max-members', true]]) {
    const r = checkChannelArchiveArgs('archive', { [name]: raw }, P);
    is(r.ok, false, name + '=' + JSON.stringify(raw));
    is(r.errors[0].code, 'invalid-value');
  }
});

test('checkChannelArchiveArgs: a stray positional word is refused', () => {
  const r = checkChannelArchiveArgs('archive', {}, ['channel-archive', 'C04633RSEDU', 'max-members=2']);
  is(r.ok, false);
  is(r.errors[0].code, 'unexpected-argument');
});

test('checkChannelArchiveArgs: unarchive refuses archive-only flags and typos', () => {
  is(checkChannelArchiveArgs('unarchive', { 'max-members': '2' }, P).errors[0].code, 'archive-only-flag');
  is(checkChannelArchiveArgs('unarchive', { 'allow-shared': true }, P).errors[0].code, 'archive-only-flag');
  is(checkChannelArchiveArgs('unarchive', { confrm: true }, P).errors[0].message, 'unknown-flag: --confrm (did you mean --confirm?)');
  is(checkChannelArchiveArgs('unarchive', { confirm: true, json: true }, P).ok, true);
});

// ── Codex round 3 (P1): missing sharing flags are UNKNOWN, never "not shared" ──

test('classifyChannelHost: missing or non-boolean is_ext_shared / is_pending_ext_shared is sharing-unknown', () => {
  for (const over of [
    { is_ext_shared: undefined },
    { is_pending_ext_shared: undefined },
    { is_ext_shared: undefined, is_pending_ext_shared: undefined },
    { is_ext_shared: 'true' },
    { is_ext_shared: 1 },
    { is_pending_ext_shared: null },
  ]) {
    is(classifyChannelHost(chan(over), ORG), 'sharing-unknown', JSON.stringify(over));
  }
  is(classifyChannelHost(chan(), ORG), 'not-shared', 'control: both real booleans, false');
});

test('evaluateChannelGuards: sharing-unknown refuses archive even with --allow-shared', () => {
  const st = normalizeChannelState(chan({ is_ext_shared: undefined }), ORG, NOW_MS);
  const d = evaluateChannelGuards('archive', st, { orgId: ORG, allowShared: true });
  is(d.outcome, 'refuse');
  is(d.reason, 'sharing-unknown');
  is(sharedArchiveImpact(st), null, 'no made-up disconnect count for an unknown sharing state');
});

test('evaluateChannelGuards: sharing-unknown refuses unarchive too', () => {
  const st = normalizeChannelState(chan({ is_archived: true, is_pending_ext_shared: undefined }), ORG, NOW_MS);
  is(evaluateChannelGuards('unarchive', st, { orgId: ORG }).reason, 'sharing-unknown');
});

test('evaluateChannelGuards: an archived channel with missing sharing flags is still already-archived (no write)', () => {
  const st = normalizeChannelState(chan({ is_archived: true, is_ext_shared: undefined }), ORG, NOW_MS);
  is(evaluateChannelGuards('archive', st, { orgId: ORG }).reason, 'already-archived');
});

test('flow --confirm --allow-shared with missing sharing flags: refused sharing-unknown, no archive call', async () => {
  const h = stub({ states: [chan({ is_ext_shared: undefined, is_pending_ext_shared: undefined })] });
  const r = await h.run({ confirm: true, allowShared: true });
  is(r.status, 'refused');
  is(r.decision.reason, 'sharing-unknown');
  is(r.exitCode, 1);
  is(h.seq(), S);
  is(writes(h), 0);
});

// MUTATION M9 (absent sharing flag read as false): in classifyChannelHost,
//   drop the typeof boolean check. Caught by: "classifyChannelHost: missing or
//   non-boolean ...", "evaluateChannelGuards: sharing-unknown refuses ...",
//   "flow --confirm --allow-shared with missing sharing flags ...".

// ── Codex round 4 (P2): conversations.info ok:true without a usable channel ────

const EMPTY_SEARCH = { ok: true, conversations: [], next_cursor: '' };

test('lookupChannel: conversations.info ok:true without a usable channel is malformed_response, not not-found', async () => {
  for (const info of [
    { ok: true },
    { ok: true, channel: null },
    { ok: true, channel: { id: 'C04633RSEDU' } },
    { ok: true, channel: { id: 'C04633RSEDU', name: '' } },
    { ok: true, channel: { id: 'C04633RSEDU', name: 42 } },
    { ok: true, channel: { id: 'C0SOMEOTHER', name: 'other-channel' } },
  ]) {
    const h = rawCall((m) => (m === S ? EMPTY_SEARCH : info));
    const r = await lookupChannel(h.call, 'C04633RSEDU');
    is(r.found, false);
    is(r.error, 'conversations.info: malformed_response', JSON.stringify(info));
    is(h.calls.filter((c) => c.method === S).length, 1, 'no name search on a malformed info answer');
  }
});

test('lookupChannel: conversations.info ok:true with this channel and a name still drives the name search (control)', async () => {
  let n = 0;
  const h = rawCall((m) => {
    if (m === S) return (n += 1) === 1 ? EMPTY_SEARCH : { ok: true, conversations: [chan()], next_cursor: '' };
    return { ok: true, channel: { id: 'C04633RSEDU', name: 'assets-adidas' } };
  });
  const r = await lookupChannel(h.call, 'C04633RSEDU');
  is(r.found, true);
  is(r.via, 'name');
});

test('flow --confirm: malformed conversations.info fallback is read-error (exit 1), no decision, no write', async () => {
  const h = rawCall((m) => (m === S ? EMPTY_SEARCH : m === 'conversations.info' ? { ok: true } : { ok: true }));
  const r = await runChannelArchiveFlow({
    action: 'archive', channelId: 'C04633RSEDU', orgId: ORG, confirm: true,
    maxMembers: null, minIdleDays: null, call: h.call, sleep: async () => {}, now: () => NOW_MS,
  });
  is(r.status, 'read-error');
  is(r.decision, null);
  is(h.calls.filter((c) => c.method === A).length, 0);
});

test('flow --confirm: a write answering a non-boolean ok is an error, not a success', async () => {
  for (const [wr, err] of [[{ ok: 'false' }, 'malformed_response'], [{ ok: 1 }, 'malformed_response'], [null, 'no_response'], [{ ok: false }, 'no_response']]) {
    const h = stub({ writeResult: wr === null ? undefined : wr });
    if (wr === null) {
      // stub() falls back to {ok:true} for undefined; use a raw call for a missing body.
      const raw = rawCall((m) => (m === S ? { ok: true, conversations: [chan()], next_cursor: '' } : m === A ? null : { ok: false, error: 'channel_not_found' }));
      const r = await runChannelArchiveFlow({ action: 'archive', channelId: 'C04633RSEDU', orgId: ORG, confirm: true, maxMembers: null, minIdleDays: null, call: raw.call, sleep: async () => {}, now: () => NOW_MS });
      is(r.status, 'error');
      is(r.write.error, err);
      continue;
    }
    const r = await h.run({ confirm: true });
    is(r.status, 'error', JSON.stringify(wr));
    is(r.write.ok, false);
    is(r.write.error, err, JSON.stringify(wr));
    is(r.readback, null, 'no read-back after a failed write');
  }
});

// MUTATION M10 (malformed info read as a miss): in lookupChannel, drop the
//   ok:true channel check (accept any ok:true, name = ch && ch.name).
//   Caught by: "lookupChannel: conversations.info ok:true without a usable
//   channel ...", "flow --confirm: malformed conversations.info fallback ...".

// ── Codex round 5 (P2): missing connected-team lists are unknown, never 0 ──────

test('sharedArchiveImpact: missing connected_team_ids is "could not be determined", never 0 organisations', () => {
for (const ids of [undefined, null, 'T0BQQL6FJ', { a: 1 }]) {
const st = normalizeChannelState(connectChan({ connected_team_ids: ids }), ORG, NOW_MS);
const imp = sharedArchiveImpact(st);
is(imp.external_team_ids, null, JSON.stringify(ids));
ok(imp.text.includes('an unknown number of external organisations'), imp.text);
ok(imp.text.includes('could not be determined'), imp.text);
ok(!/\b0 external organisations\b/.test(imp.text), 'must not claim 0: ' + imp.text);
ok(imp.text.includes('Unarchiving will NOT reconnect them'), imp.text);
}
});

test('sharedArchiveImpact: missing pending_connected_team_ids is unknown, never "no pending invitations"', () => {
const st = normalizeChannelState(connectChan({ pending_connected_team_ids: undefined }), ORG, NOW_MS);
const imp = sharedArchiveImpact(st);
is(imp.pending_external_team_ids, null);
ok(imp.text.includes('pending_connected_team_ids, so their number could not be determined'), imp.text);
is(imp.external_team_ids.join(','), 'T0BQQL6FJ,E08CP5WPXGT', 'a present connected list is still counted');
});

test('ext-shared-requires-allow-shared refusal with a missing connected list says unknown, not 0', () => {
const st = normalizeChannelState(connectChan({ connected_team_ids: undefined }), ORG, NOW_MS);
const d = evaluateChannelGuards('archive', st, { orgId: ORG });
is(d.reason, 'ext-shared-requires-allow-shared');
ok(d.detail.includes('an unknown number of external organisations'), d.detail);
});

test('sharedArchiveImpact: real empty lists still read as 0 (control)', () => {
const st = normalizeChannelState(connectChan({ connected_team_ids: [ORG], pending_connected_team_ids: [] }), ORG, NOW_MS);
const imp = sharedArchiveImpact(st);
is(imp.external_team_ids.length, 0);
ok(imp.text.includes('from 0 external organisations.'), imp.text);
});

// MUTATION M11 (unknown list read as empty): in externalTeamIds, return []
//   instead of null for a non-array. Caught by: "externalTeamIds: drops this
//   org ...", "sharedArchiveImpact: missing connected_team_ids ...",
//   "... missing pending_connected_team_ids ...", "ext-shared-requires-allow-shared
//   refusal with a missing connected list ...".

// ── Codex round 6 (P2): only ok === true is a successful read ──────────────────
//
// A truthy non-boolean ok (e.g. "false") must never let a matching row through:
// that row could authorize a confirmed archive. Writes are already strict.

test('lookupChannel: search ok that is not the boolean true is malformed_response, even with a matching row', async () => {
  for (const ok of ['false', 'true', 1, undefined, null]) {
    const h = rawCall((m) => (m === S ? { ok, conversations: [chan()], next_cursor: '' } : { ok: false, error: 'channel_not_found' }));
    const r = await lookupChannel(h.call, 'C04633RSEDU');
    is(r.found, false, 'ok=' + JSON.stringify(ok));
    is(r.channel, null);
    is(r.error, 'malformed_response', 'ok=' + JSON.stringify(ok));
  }
});

test('lookupChannel: search ok:false still reports the Slack error (control)', async () => {
  const r = await lookupChannel(rawCall(() => ({ ok: false, error: 'ratelimited' })).call, 'C04633RSEDU');
  is(r.error, 'ratelimited');
});

test('lookupChannel: conversations.info with a non-boolean ok is malformed, never the expected miss', async () => {
  const miss = { ok: true, conversations: [], next_cursor: '' };
  for (const ok of ['false', 0, undefined]) {
    const r = await lookupChannel(rawCall((m) => (m === S ? miss : { ok, error: 'channel_not_found' })).call, 'C04633RSEDU');
    is(r.error, 'conversations.info: malformed_response', 'ok=' + JSON.stringify(ok));
  }
  // control: the real boolean false + channel_not_found is the expected private-channel miss
  const r = await lookupChannel(rawCall((m) => (m === S ? miss : { ok: false, error: 'channel_not_found' })).call, 'C04633RSEDU');
  is(r.found, false);
  is(r.error, undefined);
});

test('flow --confirm: search {ok:"false"} with a matching row is read-error, no decision, no archive call', async () => {
  const h = rawCall((m) => (m === S ? { ok: 'false', conversations: [chan()], next_cursor: '' } : { ok: true }));
  const r = await runChannelArchiveFlow({
    action: 'archive', channelId: 'C04633RSEDU', orgId: ORG, confirm: true,
    maxMembers: null, minIdleDays: null, call: h.call, sleep: async () => {}, now: () => NOW_MS,
  });
  is(r.status, 'read-error');
  is(r.decision, null);
  is(r.exitCode, 1);
  is(h.calls.filter((c) => c.method === A).length, 0);
});

// MUTATION M12 (truthy ok trusted): in lookupChannel, drop the
//   `if (r.ok !== true) return { error: 'malformed_response' };` line.
//   Caught by: "lookupChannel: search ok that is not the boolean true ...",
//   "flow --confirm: search {ok:\"false\"} with a matching row ...", and the
//   entry-point test "channel-archive --confirm (entry point): search {ok:"false"} ...".

// ── Codex round 7 (P1): contradictory Slack Connect metadata is sharing-unknown ─

test('classifyChannelHost: both flags false but the row shows sharing evidence is sharing-unknown', () => {
const cases = [
[{ external_user_count: 3 }, 'external_user_count 3'],
[{ connected_team_ids: ['T0BQQL6FJ', ORG] }, 'external connected_team_ids T0BQQL6FJ'],
[{ pending_connected_team_ids: ['T0PENDING1'] }, 'external pending_connected_team_ids T0PENDING1'],
[{ conversation_host_id: 'E01UA4N2G78' }, 'conversation_host_id E01UA4N2G78'],
[{ conversation_host_id: ORG }, 'conversation_host_id ' + ORG],
];
for (const [over, reason] of cases) {
const c = chan(Object.assign({ is_ext_shared: false, is_pending_ext_shared: false }, over));
is(classifyChannelHost(c, ORG), 'sharing-unknown', JSON.stringify(over));
const st = normalizeChannelState(c, ORG, NOW_MS);
ok(st.sharing_conflicts.includes(reason), JSON.stringify(st.sharing_conflicts));
}
});

test('classifyChannelHost: consistent not-shared rows stay not-shared (controls)', () => {
for (const over of [
{},
{ connected_team_ids: null, external_user_count: 0 },
{ connected_team_ids: [ORG, 'T0385CHDU9E'], internal_team_ids: ['T0385CHDU9E'] },
{ external_user_count: -1 },
{ pending_connected_team_ids: [] },
]) {
is(classifyChannelHost(chan(over), ORG), 'not-shared', JSON.stringify(over));
}
});

test('evaluateChannelGuards: contradictory metadata refuses archive even with --allow-shared, naming the evidence', () => {
const st = normalizeChannelState(chan({ external_user_count: 4, conversation_host_id: ORG }), ORG, NOW_MS);
const d = evaluateChannelGuards('archive', st, { orgId: ORG, allowShared: true });
is(d.outcome, 'refuse');
is(d.reason, 'sharing-unknown');
ok(d.detail.includes('is_ext_shared and is_pending_ext_shared are false, but the same row reports external_user_count 4'), d.detail);
ok(d.detail.includes('conversation_host_id ' + ORG), d.detail);
});

test('flow --confirm --allow-shared with contradictory metadata: refused sharing-unknown, no archive call', async () => {
const h = stub({ states: [chan({ connected_team_ids: ['T04650MFY', ORG], external_user_count: 2 })] });
const r = await h.run({ confirm: true, allowShared: true });
is(r.status, 'refused');
is(r.decision.reason, 'sharing-unknown');
is(writes(h), 0);
});

test('an archived channel with contradictory metadata is still already-archived (no write)', () => {
const st = normalizeChannelState(chan({ is_archived: true, member_count: -1, conversation_host_id: ORG }), ORG, NOW_MS);
is(evaluateChannelGuards('archive', st, { orgId: ORG }).reason, 'already-archived');
});

// MUTATION M13 (contradictions ignored): in classifyChannelHost, return
//   'not-shared' whenever both flags are false. Caught by: "classifyChannelHost:
//   both flags false but the row shows sharing evidence ...", "evaluateChannelGuards:
//   contradictory metadata refuses ...", "flow --confirm --allow-shared with
//   contradictory metadata ...", and the entry-point contradiction test.
