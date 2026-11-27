import { createRequire } from 'node:module';
import test, { is, ok } from 'tst';
import * as F from './fixtures.js';
import { run } from './harness.js';

const require = createRequire(import.meta.url);
const wd = require('../scripts/lib/workday.js');

const HOME = 'GET /acme/home.htmld';
const PING = 'GET /acme/ping.htmld?clientRequestID=req0001';
const MIN = 60000;
const site = (home = F.homeWith(30), ping = F.PING_OK(30)) => ({ [HOME]: home, [PING]: ping });

test("--once: home.htmld, then the client's ping with the session token; exit 0", async () => {
  const r = await run(['keepalive', '--once'], { routes: site() });
  is(r.code, 0, r.stderr);
  is(
    r.calls.map((c) => c.key),
    [HOME, PING]
  );
  is(r.calls[1].headers['Session-Secure-Token'], 'TEST-SESSION-TOKEN-0000');
  ok(/^\d\d:\d\d:\d\d OK \(idle timeout 30m\)$/.test(r.stdout), r.stdout);
  is(r.sleeps, []);
});

test('the token is sent but never printed', async () => {
  const r = await run(['keepalive', '--once'], { routes: site() });
  ok(!(r.stdout + r.stderr).includes('TEST-SESSION-TOKEN'), r.stdout + r.stderr);
});

test('--once only reads: GET requests to home.htmld and ping.htmld, nothing else', async () => {
  for (const routes of [site(), site(F.SIGN_IN_PAGE), site(F.homeWith(30), F.SIGN_IN_PAGE)]) {
    const r = await run(['keepalive', '--once'], { routes });
    for (const c of r.calls) ok(c.key === HOME || c.key === PING, c.key);
    ok(r.calls.every((c) => c.body === undefined));
  }
});

test('--once: a sign-in page instead of home.htmld exits 1 with the sign-in message', async () => {
  const r = await run(['keepalive', '--once'], { routes: site(F.SIGN_IN_PAGE) });
  is(r.code, 1);
  ok(r.stderr.includes('sign in to Workday') && r.stderr.includes('never signs in'), r.stderr);
  ok(r.stdout.includes('SESSION GONE (sign-in page)'), r.stdout);
  is(
    r.calls.map((c) => c.key),
    [HOME]
  );
});

test('--once: a sign-in page instead of the ping answer exits 1', async () => {
  const r = await run(['keepalive', '--once'], { routes: site(F.homeWith(30), F.SIGN_IN_PAGE) });
  is(r.code, 1);
  ok(r.stderr.includes('sign in to Workday'), r.stderr);
});

test('--once: 401 and 403 exit 1 with the sign-in message', async () => {
  for (const status of [401, 403]) {
    for (const routes of [site({ status, body: '' }), site(F.homeWith(30), { status, body: '' })]) {
      const r = await run(['keepalive', '--once'], { routes });
      is(r.code, 1, `${status}`);
      ok(r.stderr.includes('sign in to Workday') && r.stderr.includes(`HTTP ${status}`), r.stderr);
    }
  }
});

test('--once: an XML error exits 1 with the sign-in message', async () => {
  for (const routes of [site(F.MISSING_PARM), site(F.homeWith(30), F.SERVER_ERROR)]) {
    const r = await run(['keepalive', '--once'], { routes });
    is(r.code, 1);
    ok(r.stderr.includes('sign in to Workday') && r.stderr.includes('XML error'), r.stderr);
  }
});

test('--once: a home.htmld without a session token is a lost session', async () => {
  const r = await run(['keepalive', '--once'], { routes: site(F.HOME) });
  is(r.code, 1);
  ok(r.stderr.includes('sign in to Workday') && r.calls.length === 1, r.stderr);
});

test('--once: a rate-limit body is retried with the injected sleep, then it succeeds', async () => {
  const r = await run(['keepalive', '--once'], {
    routes: { ...site(), [PING]: [F.TOO_MANY, F.TOO_MANY, F.PING_OK()] },
  });
  is(r.code, 0, r.stderr);
  is(r.sleeps, [15000, 30000]);
  is(r.calls.filter((c) => c.key === PING).length, 3);
  ok(r.stdout.includes(' OK'), r.stdout);
});

test('--once: rate limited on every try exits 1 with the rate-limit message, not the sign-in one', async () => {
  const r = await run(['keepalive', '--once'], { routes: { ...site(), [HOME]: F.TOO_MANY } });
  is(r.code, 1);
  is(r.sleeps, [15000, 30000, 60000]);
  ok(r.stderr.includes('rate limiting') && !r.stderr.includes('never signs in'), r.stderr);
});

test('--once: an unknown ping answer or a 500 is a problem, exit 1', async () => {
  for (const ping of ['{"x":1}', { status: 500, body: 'oops' }]) {
    const r = await run(['keepalive', '--once'], { routes: site(F.homeWith(30), ping) });
    is(r.code, 1);
    ok(r.stderr.includes('keepalive failed') && r.stdout.includes('PROBLEM'), r.stderr);
  }
});

test('the loop touches, waits the interval, touches again, and stops on the first failure', async () => {
  const routes = site(F.homeWith(30), [F.PING_OK(), F.PING_OK(), F.SIGN_IN_PAGE, F.PING_OK()]);
  const r = await run(['keepalive', '--every', '10m'], { routes });
  is(r.code, 1);
  is(r.sleeps, [10 * MIN, 10 * MIN]);
  is(r.calls.filter((c) => c.key === PING).length, 3);
  const lines = r.stdout.split('\n');
  is(lines.length, 3);
  ok(/^\d\d:\d\d:\d\d OK/.test(lines[0]) && lines[0].includes('next in 10m'), lines[0]);
  ok(lines[2].includes('SESSION GONE'), lines[2]);
  ok(r.stderr.includes('sign in to Workday'), r.stderr);
});

test('the interval comes from sessionTimeoutMinutes when --every is not given', async () => {
  for (const [minutes, want] of [
    [30, 10 * MIN],
    [15, 5 * MIN],
    [60, 20 * MIN],
    [2, MIN],
  ]) {
    const r = await run(['keepalive', '--count', '2'], {
      routes: site(F.homeWith(minutes), F.PING_OK(minutes)),
    });
    is(r.code, 0, r.stderr);
    is(r.sleeps, [want], `${minutes} minutes`);
    ok(want < minutes * MIN || minutes < 2, 'below the timeout');
  }
});

test('--every overrides the derived interval', async () => {
  const r = await run(['keepalive', '--every', '90s', '--count', '3'], { routes: site() });
  is(r.code, 0, r.stderr);
  is(r.sleeps, [90000, 90000]);
});

test('the wait counts from the start of the touch (the clock is read)', async () => {
  const routes = site(F.homeWith(30), [F.TOO_MANY, F.PING_OK(), F.PING_OK()]);
  const r = await run(['keepalive', '--every', '10m', '--count', '2', '--retry-wait', '3s'], {
    routes,
  });
  is(r.code, 0, r.stderr);
  is(r.sleeps, [3000, 10 * MIN - 3000]);
});

test('--every longer than the session timeout warns', async () => {
  const r = await run(['keepalive', '--every', '45m', '--once'], { routes: site() });
  is(r.code, 0, r.stderr);
  ok(r.stderr.includes('not below the session timeout'), r.stderr);
});

test('a transient problem is retried at the next interval; three in a row stop it', async () => {
  const routes = site(F.homeWith(30), [
    F.PING_OK(),
    { status: 503, body: '' },
    F.PING_OK(),
    { status: 503, body: '' },
    { status: 503, body: '' },
    { status: 503, body: '' },
    F.PING_OK(),
  ]);
  const r = await run(['keepalive', '--every', '5m'], { routes });
  is(r.code, 1);
  is(r.sleeps.length, 5);
  is(r.calls.filter((c) => c.key === PING).length, 6);
  ok(r.stderr.includes('3 times in a row'), r.stderr);
});

test('--count 2: a working touch then HTTP 503 exits 1, with and without --json', async () => {
  for (const json of [[], ['--json']]) {
    const routes = site(F.homeWith(30), [F.PING_OK(), { status: 503, body: '' }]);
    const r = await run(['keepalive', '--count', '2', ...json], { routes });
    is(r.code, 1, `${json.join(' ')} ${r.stderr}`);
    is(r.calls.filter((c) => c.key === PING).length, 2);
    is(r.sleeps, [10 * MIN]);
    ok(r.stdout.includes(json.length ? '"status":"problem"' : 'PROBLEM HTTP 503'), r.stdout);
    ok(r.stderr.includes('1 of 2 touches failed'), r.stderr);
  }
});

test('--json: one JSON object per touch, no human lines', async () => {
  const routes = site(F.homeWith(30), [F.PING_OK(), { status: 503, body: '' }, F.SIGN_IN_PAGE]);
  const r = await run(['keepalive', '--count', '3', '--json'], { routes });
  is(r.code, 1, r.stderr);
  const lines = r.stdout.split('\n').map((l) => JSON.parse(l));
  is(lines, [
    { at: '2030-01-02T09:00:00.000Z', status: 'ok', timeoutMinutes: 30, nextMs: 10 * MIN },
    {
      at: '2030-01-02T09:10:00.000Z',
      status: 'problem',
      problem: 'HTTP 503 from ping.htmld',
      nextMs: 5 * MIN,
    },
    { at: '2030-01-02T09:15:00.000Z', status: 'gone', reason: 'sign-in page' },
  ]);
  ok(!r.stdout.includes('TEST-SESSION-TOKEN'), r.stdout);
});

test('bad --every, --count', async () => {
  for (const args of [
    ['--every', 'soon'],
    ['--every', '0s'],
    ['--count', '0'],
    ['--count', 'x'],
  ]) {
    const r = await run(['keepalive', ...args], { routes: site() });
    is(r.code, 1, args.join(' '));
    is(r.calls, []);
  }
});

test('no Workday tab: exit 1, nothing sent', async () => {
  const r = await run(['keepalive', '--once'], { tab: null });
  is(r.code, 1);
  is(r.calls, []);
});

test('keepalive does not touch the cache', async () => {
  const r = await run(['keepalive', '--once'], { routes: site() });
  is(r.code, 0);
  const fs = await import('node:fs');
  is(fs.readdirSync(r.cacheDir), []);
});

test('parseKeepalive reads the answer and nothing else', () => {
  is(wd.parseKeepalive(F.PING_OK(30)), { minutes: 30 });
  is(wd.parseKeepalive('<a:Keepalive_Response/>'), { minutes: null });
  is(wd.parseKeepalive(F.SIGN_IN_PAGE), null);
  is(wd.parseKeepalive(F.MISSING_PARM), null);
  is(wd.parseKeepalive({}), null);
});

test('keepaliveInterval: a third of the timeout, at least a minute, 5 minutes if unknown', () => {
  is(wd.keepaliveInterval(30), 10 * MIN);
  is(wd.keepaliveInterval(2), MIN);
  is(wd.keepaliveInterval(null), 5 * MIN);
  is(wd.keepaliveInterval(0), 5 * MIN);
});

test('sessionGone: 401, 403, a sign-in page and an XML error; data is not', () => {
  is(wd.sessionGone(401, ''), 'HTTP 401');
  is(wd.sessionGone(403, ''), 'HTTP 403');
  is(wd.sessionGone(200, F.SIGN_IN_PAGE), 'sign-in page');
  ok(wd.sessionGone(200, F.MISSING_PARM).startsWith('XML error'));
  is(wd.sessionGone(200, F.PING_OK()), null);
  is(wd.sessionGone(200, '{"a":1}'), null);
});
