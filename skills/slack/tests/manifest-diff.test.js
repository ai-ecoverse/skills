// manifest-diff.test.js — tst suite for skills/slack/scripts/manifest-diff.js
//
// Run from skills/slack/:
//   tst tests/manifest-diff.test.js
//
// This file imports `tst` and a single relative module; no node:test, no fs,
// no path, no sliccy:* — it runs in the SLICC test realm as-is (CLAUDE.md §16).

import test, { is, ok } from 'tst';
import * as diffMod from '../scripts/manifest-diff.js';

const { isPlainObject, pointerJoin, manifestLeaves, diffManifests } =
  diffMod.default || diffMod;

// ─── isPlainObject ────────────────────────────────────────────────────────────

test('isPlainObject: plain object is true', () => {
  ok(isPlainObject({ a: 1 }));
});

test('isPlainObject: array is false', () => {
  ok(!isPlainObject([1, 2]));
});

test('isPlainObject: null is false', () => {
  ok(!isPlainObject(null));
});

test('isPlainObject: string is false', () => {
  ok(!isPlainObject('hello'));
});

// ─── pointerJoin ─────────────────────────────────────────────────────────────

test('pointerJoin builds a RFC-6901 pointer', () => {
  is(pointerJoin('', 'features'), '/features');
  is(pointerJoin('/features', 'bot_user'), '/features/bot_user');
});

test('pointerJoin escapes ~ to ~0', () => {
  is(pointerJoin('', 'a~b'), '/a~0b');
});

test('pointerJoin escapes / to ~1', () => {
  is(pointerJoin('', 'a/b'), '/a~1b');
});

// ─── manifestLeaves ───────────────────────────────────────────────────────────

test('manifestLeaves flattens a nested object', () => {
  const leaves = manifestLeaves({ a: { b: 1 } }, '', {});
  is(leaves['/a/b'], 1);
});

test('manifestLeaves treats an array as a leaf (not recursed)', () => {
  const leaves = manifestLeaves({ scopes: { bot: ['channels:read'] } }, '', {});
  ok(Array.isArray(leaves['/scopes/bot']));
  is(leaves['/scopes/bot'][0], 'channels:read');
});

// ─── diffManifests — the semantics that were wrong by assumption ──────────────

// KEY: a wholly-absent array is ONE deletion carrying the FULL array value.
// A live manifest with bot_events; a candidate with the key missing entirely:
// that is a single deletion of the array blob, not per-entry deletions.
test('wholly-absent array is ONE deletion carrying the full array value', () => {
  const live = {
    settings: { event_subscriptions: { bot_events: ['channel_created', 'team_join'] } },
  };
  const candidate = {
    settings: { event_subscriptions: {} },
  };
  const diff = diffManifests(live, candidate);
  is(diff.deletions.length, 1);
  ok(Array.isArray(diff.deletions[0].value));
  is(diff.deletions[0].value.length, 2);
  is(diff.deletions[0].pointer, '/settings/event_subscriptions/bot_events');
});

// KEY: a SHRUNK array (both present, but candidate has fewer entries) reports
// per-entry deletions with entry:true, NOT one blob deletion.
test('shrunk array reports per-entry deletions', () => {
  const live = {
    settings: { event_subscriptions: { bot_events: ['channel_created', 'team_join'] } },
  };
  const candidate = {
    settings: { event_subscriptions: { bot_events: ['channel_created'] } },
  };
  const diff = diffManifests(live, candidate);
  is(diff.deletions.length, 1);
  is(diff.deletions[0].value, 'team_join');
  is(diff.deletions[0].pointer, '/settings/event_subscriptions/bot_events');
  ok(diff.deletions[0].entry === true);
});

// A completely unchanged manifest has no diff.
test('identical manifests produce no diff', () => {
  const m = { display_information: { name: 'Bot' }, settings: { org_deploy_enabled: false } };
  const diff = diffManifests(m, m);
  is(diff.deletions.length, 0);
  is(diff.additions.length, 0);
  is(diff.modifications.length, 0);
  ok(!diff.changed);
});

// A modified leaf value is a modification, not a deletion+addition.
test('modified leaf is a modification', () => {
  const live = { display_information: { name: 'Old Name', background_color: '#000000' } };
  const cand = { display_information: { name: 'New Name', background_color: '#000000' } };
  const diff = diffManifests(live, cand);
  is(diff.modifications.length, 1);
  is(diff.modifications[0].pointer, '/display_information/name');
  is(diff.modifications[0].from, 'Old Name');
  is(diff.modifications[0].to, 'New Name');
  is(diff.deletions.length, 0);
  is(diff.additions.length, 0);
});

// An added leaf in the candidate that is absent in live is an addition.
test('added leaf is an addition', () => {
  const live = { display_information: { name: 'Bot' } };
  const cand = { display_information: { name: 'Bot', description: 'A bot' } };
  const diff = diffManifests(live, cand);
  is(diff.additions.length, 1);
  is(diff.additions[0].pointer, '/display_information/description');
  is(diff.additions[0].value, 'A bot');
  is(diff.deletions.length, 0);
});

// A leaf present in live and absent in candidate is a deletion (the
// silent-damage case the whole diff command exists to surface).
test('absent leaf in candidate is a deletion', () => {
  const live = {
    oauth_config: {
      scopes: { bot: ['channels:read', 'chat:write'] },
      pkce_enabled: false,
    },
  };
  const cand = {
    oauth_config: {
      scopes: { bot: ['channels:read', 'chat:write'] },
    },
  };
  const diff = diffManifests(live, cand);
  is(diff.deletions.length, 1);
  is(diff.deletions[0].pointer, '/oauth_config/pkce_enabled');
  is(diff.deletions[0].value, false);
});

// Array entry additions and the changed flag
test('added array entry is an addition and sets changed', () => {
  const live = { settings: { event_subscriptions: { bot_events: ['channel_created'] } } };
  const cand = {
    settings: { event_subscriptions: { bot_events: ['channel_created', 'team_join'] } },
  };
  const diff = diffManifests(live, cand);
  is(diff.additions.length, 1);
  is(diff.additions[0].value, 'team_join');
  ok(diff.additions[0].entry === true);
  ok(diff.changed);
});
