// argv.test.js — tst suite for skills/slack/scripts/argv.js
//
// Run from skills/slack/:
//   tst tests/argv.test.js
//
// This file imports `tst` and a single relative module; no node:test, no fs,
// no path, no sliccy:* — it runs in the SLICC test realm as-is (CLAUDE.md §16).

import test, { is, ok, throws } from 'tst';
import * as argvMod from '../scripts/argv.js';

const { BOOL_FLAGS, parseArgv, parseList } = argvMod.default || argvMod;

// ─── parseArgv: bare boolean flags ───────────────────────────────────────────

test('bare --confirm is boolean true', () => {
  const r = parseArgv(['set-single', 'U1', '--confirm']);
  is(r.flags.confirm, true);
});

test('absent --confirm is undefined (not false)', () => {
  const r = parseArgv(['set-single', 'U1']);
  is(r.flags.confirm, undefined);
});

test('bare --json is boolean true', () => {
  is(parseArgv(['status', '--json']).flags.json, true);
});

// ─── parseArgv: --name=value bool normalisation ───────────────────────────────

test('--confirm=false stores boolean false', () => {
  is(parseArgv(['x', '--confirm=false']).flags.confirm, false);
});

test('--confirm=0 stores boolean false', () => {
  is(parseArgv(['x', '--confirm=0']).flags.confirm, false);
});

test('--confirm=no stores boolean false', () => {
  is(parseArgv(['x', '--confirm=no']).flags.confirm, false);
});

test('--confirm=off stores boolean false', () => {
  is(parseArgv(['x', '--confirm=off']).flags.confirm, false);
});

test('--confirm=FALSE stores boolean false (case-insensitive)', () => {
  is(parseArgv(['x', '--confirm=FALSE']).flags.confirm, false);
});

test('--confirm= (empty string) stores boolean false', () => {
  is(parseArgv(['x', '--confirm=']).flags.confirm, false);
});

test('--confirm=true stores boolean true', () => {
  is(parseArgv(['x', '--confirm=true']).flags.confirm, true);
});

test('--confirm=1 stores boolean true', () => {
  is(parseArgv(['x', '--confirm=1']).flags.confirm, true);
});

test('--confirm=yes stores boolean true', () => {
  is(parseArgv(['x', '--confirm=yes']).flags.confirm, true);
});

test('--confirm=on stores boolean true', () => {
  is(parseArgv(['x', '--confirm=on']).flags.confirm, true);
});

test('--confirm=TRUE stores boolean true (case-insensitive)', () => {
  is(parseArgv(['x', '--confirm=TRUE']).flags.confirm, true);
});

// ─── parseArgv: typo is fatal ─────────────────────────────────────────────────

test('--confirm=fasle (typo) is a fatal error', () => {
  // process.exit(1) throws in the SLICC sandbox; throws() catches it.
  throws(() => parseArgv(['x', '--confirm=fasle']));
});

test('--confirm=maybe (unrecognised value) is a fatal error', () => {
  throws(() => parseArgv(['x', '--confirm=maybe']));
});

// ─── parseArgv: non-boolean flags keep string values ─────────────────────────

test('--channel=false keeps the string "false" (not a bool flag)', () => {
  is(parseArgv(['x', '--channel=false']).flags.channel, 'false');
});

test('--ws=T06DUTYDQ keeps the string', () => {
  is(parseArgv(['x', '--ws=T06DUTYDQ']).flags.ws, 'T06DUTYDQ');
});

// ─── parseArgv: -- stops flag parsing ────────────────────────────────────────

test('-- stops flag parsing', () => {
  const r = parseArgv(['set-single', '--', '--confirm']);
  is(r.flags.confirm, undefined);
  ok(r.positional.includes('--confirm'));
});

test('-- passes remaining tokens as positionals', () => {
  const r = parseArgv(['cmd', '--ws=T1', '--', 'a', 'b']);
  is(r.positional[1], 'a');
  is(r.positional[2], 'b');
});

// ─── parseArgv: positionals and mixed ordering ───────────────────────────────

test('positional words are collected in order', () => {
  const r = parseArgv(['set-single', 'U12345', '--ws=T1', '--channel=C2']);
  is(r.positional[0], 'set-single');
  is(r.positional[1], 'U12345');
});

test('BOOL_FLAGS set contains confirm, json, help, h, allow-deletions', () => {
  ok(BOOL_FLAGS.has('confirm'));
  ok(BOOL_FLAGS.has('json'));
  ok(BOOL_FLAGS.has('help'));
  ok(BOOL_FLAGS.has('h'));
  ok(BOOL_FLAGS.has('allow-deletions'));
});

// ─── parseList ────────────────────────────────────────────────────────────────

test('parseList splits on commas', () => {
  const r = parseList('channels:read,chat:write', 'scopes');
  is(r.length, 2);
  is(r[0], 'channels:read');
  is(r[1], 'chat:write');
});

test('parseList splits on whitespace', () => {
  const r = parseList('channels:read chat:write', 'scopes');
  is(r.length, 2);
  is(r[0], 'channels:read');
});

test('parseList splits on comma-and-space', () => {
  const r = parseList('a, b, c', 'items');
  is(r.length, 3);
  is(r[2], 'c');
});

test('parseList deduplicates', () => {
  is(parseList('a,a,b', 'x').length, 2);
});

test('parseList returns [] for undefined', () => {
  is(parseList(undefined, 'x').length, 0);
});

test('parseList with valueless flag (true) is fatal', () => {
  // raw === true means the flag was passed without a value; process.exit(1) throws.
  throws(() => parseList(true, 'scopes'));
});

test('--allow-shared is boolean and never swallows the next positional', () => {
  const r = parseArgv(['channel-archive', '--allow-shared', 'C04633RSEDU']);
  is(r.flags['allow-shared'], true);
  is(r.positional.join(','), 'channel-archive,C04633RSEDU');
  is(parseArgv(['x', '--allow-shared=false']).flags['allow-shared'], false);
});
