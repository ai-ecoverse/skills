import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';

// Under jsh (a host, or SLICC 7) `slack watch` runs in the foreground and
// prints messages itself (watchForeground). These run the shipped helpers that
// decide what it reports and how long it runs.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/slack.jsh'), 'utf8');
const WATCH_MAX_MS = 2 ** 31 - 1;
const WATCH_SUBTYPES = new Set(['bot_message', 'thread_broadcast', 'file_share', 'me_message']);
const { parseWatchDuration, isWatchedMessage } = load(
  SOURCE,
  ['parseWatchDuration', 'isWatchedMessage'],
  { WATCH_SUBTYPES, WATCH_MAX_MS }
);

test('--for takes seconds, minutes, hours and days', () => {
  is(parseWatchDuration('45'), 45000);
  is(parseWatchDuration('30s'), 30000);
  is(parseWatchDuration('10m'), 600000);
  is(parseWatchDuration('1h'), 3600000);
  is(parseWatchDuration('2d'), 172800000);
  is(parseWatchDuration('24d'), 2073600000);
});

test('--for rejects what is not a duration', () => {
  is(parseWatchDuration('0s'), null);
  is(parseWatchDuration('1.5h'), null);
  is(parseWatchDuration('-1m'), null);
  is(parseWatchDuration('abc'), null);
  is(parseWatchDuration('25d'), null, 'beyond setTimeout’s 2^31-1 ms');
  is(parseWatchDuration(true), null);
});

test('a watch reports new messages once, and not our own', () => {
  const seen = new Set();
  const msg = { type: 'message', channel: 'C1', user: 'U2', ts: '1.1', text: 'hi' };
  is(isWatchedMessage(msg, 'U1', seen), true);
  is(isWatchedMessage(msg, 'U1', seen), false, 'the same ts twice');
  is(isWatchedMessage({ ...msg, ts: '1.2', user: 'U1' }, 'U1', seen), false, 'our own');
  is(isWatchedMessage({ ...msg, ts: '1.3', user: 'U1' }, null, seen), true, '--include-own');
});

test('a watch reports bot posts and broadcasts, not edits or joins', () => {
  const seen = new Set();
  const base = { type: 'message', channel: 'C1', user: 'U2' };
  is(isWatchedMessage({ ...base, ts: '2.1', subtype: 'bot_message' }, null, seen), true);
  is(isWatchedMessage({ ...base, ts: '2.2', subtype: 'thread_broadcast' }, null, seen), true);
  is(isWatchedMessage({ ...base, ts: '2.3', subtype: 'message_changed' }, null, seen), false);
  is(isWatchedMessage({ ...base, ts: '2.4', subtype: 'message_replied' }, null, seen), false);
  is(isWatchedMessage({ ...base, ts: '2.5', subtype: 'channel_join' }, null, seen), false);
  is(isWatchedMessage({ type: 'user_typing', channel: 'C1', ts: '2.6' }, null, seen), false);
  is(isWatchedMessage({ ...base }, null, seen), false, 'no ts');
});
