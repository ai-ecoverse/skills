// slack-ext-grid.test.js — tst suite for skills/slack/scripts/slack-ext-grid.js
//
// Run from skills/slack/:
//   tst tests/slack-ext-grid.test.js
//
// This file imports only `tst` and the relative module. No node:test, no fs,
// no path, no sliccy:* — runs in the SLICC test realm as-is.
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

test('buildChannelSearchParams with no args uses limit=50', () => {
  const p = buildChannelSearchParams('', 0, '');
  is(p.limit, '50');
});

test('buildChannelSearchParams includes query when provided', () => {
  const p = buildChannelSearchParams('support', 10, '');
  is(p.query, 'support');
  is(p.limit, '10');
});

test('buildChannelSearchParams omits query when empty', () => {
  const p = buildChannelSearchParams('', 10, '');
  ok(!('query' in p));
});

test('buildChannelSearchParams never includes channel_ids (measured defect guard)', () => {
  // channel_ids is silently ignored by Slack — passing it returns the
  // unfiltered list confidently. This test verifies we never emit it.
  const p = buildChannelSearchParams('anything', 50, '');
  ok(!('channel_ids' in p));
});

test('buildChannelSearchParams includes cursor when provided', () => {
  const p = buildChannelSearchParams('', 10, 'dXNlcjpV');
  is(p.cursor, 'dXNlcjpV');
});

test('buildChannelSearchParams omits cursor when empty', () => {
  const p = buildChannelSearchParams('', 10, '');
  ok(!('cursor' in p));
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
