// cache.test.js — the on-disk cache and the rate-limit retry, through the shipped workday.jsh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as F from './fixtures.js';
import { ORIGIN, ROUTES, run } from './harness.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wdcache-'));
const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')) : []);
const entries = (dir) => files(dir).flatMap((n) => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).entries));
const other = (routes) => Object.fromEntries(Object.entries(routes).map(([k, v]) => [k.replace(' /acme/', ' /other/'), v]));

test('a second run is answered from the cache: no requests', async () => {
  const cacheDir = tmp();
  const first = await run(['orgchart', 'Ada Lovelace', '--json'], { cacheDir });
  is(first.code, 0, first.stderr);
  ok(first.calls.length > 4, `first run fetched (${first.calls.length})`);
  const second = await run(['orgchart', 'Ada Lovelace', '--json'], { cacheDir });
  is(second.code, 0, second.stderr);
  is(second.calls, []);
  is(JSON.parse(second.stdout), JSON.parse(first.stdout));
});

test('what is stored: parsed answers per tenant, no chunk URL, cookie, token or header', async () => {
  const cacheDir = tmp();
  await run(['orgchart', 'Ada Lovelace', '--json'], { cacheDir });
  is(files(cacheDir), ['wd3.myworkday.com_acme.json']);
  const raw = fs.readFileSync(path.join(cacheDir, files(cacheDir)[0]), 'utf8');
  ok(!raw.includes('navigablechunk'), 'chunk URLs are cursors; never stored');
  ok(!/cookie|token|content-type|set-cookie|authorization/i.test(raw), raw.slice(0, 300));
  ok(entries(cacheDir).every((k) => /^(search|profile|team|org):/.test(k)), entries(cacheDir).join(','));
  ok(entries(cacheDir).includes('org:2500$2001'));
  // the assembled member list is stored, including the member that came from the chunk page
  ok(raw.includes('Compilers'));
});

test('the cache is private to the user: directory 0700, file 0600', async () => {
  const cacheDir = path.join(tmp(), 'nested', 'workday');
  // A permissive umask, as on a typical host: the modes must come from the code, not the umask.
  const old = process.umask(0o022);
  try {
    await run(['orgchart', 'Ada Lovelace', '--json'], { cacheDir });
  } finally {
    process.umask(old);
  }
  is(fs.statSync(cacheDir).mode & 0o777, 0o700);
  is(fs.statSync(path.join(cacheDir, files(cacheDir)[0])).mode & 0o777, 0o600);
});

test('an entry older than --max-age is fetched again; the default is 24 hours', async () => {
  const cacheDir = tmp();
  await run(['find', 'Ada'], { cacheDir });
  const file = path.join(cacheDir, files(cacheDir)[0]);
  const age = (ms) => {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of Object.values(d.entries)) e.at = Date.now() - ms;
    fs.writeFileSync(file, JSON.stringify(d));
  };
  age(23 * 3600000);
  is((await run(['find', 'Ada'], { cacheDir })).calls, [], '23 h old is still fresh');
  age(25 * 3600000);
  is((await run(['find', 'Ada'], { cacheDir })).calls.length, 1, '25 h old is refetched');
  age(25 * 3600000);
  is((await run(['find', 'Ada', '--max-age', '2d'], { cacheDir })).calls, [], '--max-age 2d keeps it');
  age(2 * 3600000);
  is((await run(['find', 'Ada', '--max-age', '1h'], { cacheDir })).calls.length, 1, '--max-age 1h expires a 2 h old entry');
});

test('--fresh refetches everything once and refreshes the cache', async () => {
  const cacheDir = tmp();
  const first = await run(['orgchart', 'Ada Lovelace', '--json'], { cacheDir });
  const fresh = await run(['orgchart', 'Ada Lovelace', '--json', '--fresh'], { cacheDir });
  is(fresh.code, 0, fresh.stderr);
  is(fresh.calls.map((c) => c.key), first.calls.map((c) => c.key));
  is((await run(['orgchart', 'Ada Lovelace', '--json'], { cacheDir })).calls, []);
  // the refresh really replaced the data: change the answer, refresh, read it back
  const changed = { ...ROUTES, 'GET /acme/search.htmld?q=Ada&autocomplete=true': { listItems: [F.SEARCH.listItems[0]] } };
  await run(['find', 'Ada', '--fresh'], { cacheDir, routes: changed });
  const again = await run(['find', 'Ada', '--json'], { cacheDir });
  is(again.calls, []);
  is(JSON.parse(again.stdout).length, 1);
});

test('errors, XML error bodies, sign-in pages and 401 are never cached', async () => {
  const bad = [F.SIGN_IN_PAGE, F.MISSING_PARM, F.SERVER_ERROR, { status: 401, body: '' }, { status: 403, body: '' }, { status: 500, body: '{"x":1}' }];
  for (const body of bad) {
    const cacheDir = tmp();
    const routes = { ...ROUTES, 'GET /acme/search.htmld?q=Ada&autocomplete=true': body };
    const r = await run(['find', 'Ada'], { cacheDir, routes });
    is(r.code, 1, String(r.stdout));
    is(entries(cacheDir), [], `nothing stored after ${typeof body === 'string' ? body.slice(0, 40) : JSON.stringify(body)}`);
    const ok2 = await run(['find', 'Ada'], { cacheDir });
    is(ok2.code, 0, ok2.stderr);
    is(ok2.calls.length, 1, 'the good answer is fetched, not a remembered failure');
  }
});

test('a failed org chart is not cached either', async () => {
  const cacheDir = tmp();
  const routes = { ...ROUTES, 'POST /acme/navigable/2500$2001.htmld': F.MISSING_PARM };
  const r = await run(['org', '2500$2001'], { cacheDir, routes });
  is(r.code, 1);
  ok(!entries(cacheDir).some((k) => k.startsWith('org:')), entries(cacheDir).join(','));
});

test('an org whose chunk fails to complete is not cached as if whole', async () => {
  const cacheDir = tmp();
  const routes = { ...ROUTES, 'GET /acme/navigablechunk/c1-x/9.htmld?startRow=2&maxRows=50': { widget: 'navigatorDetailsChunk', totalCount: 3, navigatorDetails: [] } };
  const r = await run(['org', '2500$2001', '--json'], { cacheDir, routes });
  is(r.code, 0, r.stderr);
  ok(r.stderr.includes('2 of 3'), r.stderr);
  ok(!entries(cacheDir).includes('org:2500$2001'));
});

test('tenants do not share entries', async () => {
  const cacheDir = tmp();
  await run(['find', 'Ada'], { cacheDir });
  const otherTab = { targetId: 'T', url: `${ORIGIN}/other/d/home.htmld` };
  const r = await run(['find', 'Ada'], { cacheDir, routes: other(ROUTES), tab: otherTab });
  is(r.calls.map((c) => c.key), ['GET /other/search.htmld?q=Ada&autocomplete=true']);
  is(files(cacheDir).sort(), ['wd3.myworkday.com_acme.json', 'wd3.myworkday.com_other.json']);
});

test('cache info shows entries, size and path; cache clear empties it', async () => {
  const cacheDir = tmp();
  await run(['find', 'Ada'], { cacheDir });
  const info = await run(['cache', 'info', '--json'], { cacheDir, tab: null });
  is(info.code, 0, info.stderr);
  const d = JSON.parse(info.stdout);
  is(d.path, cacheDir);
  is(d.entries, 1);
  ok(d.bytes > 0);
  is(d.files.length, 1);
  const bare = await run(['cache'], { cacheDir, tab: null });
  ok(bare.stdout.includes(cacheDir) && bare.stdout.includes('1 entries'), bare.stdout);
  const clear = await run(['cache', 'clear'], { cacheDir, tab: null });
  is(clear.code, 0, clear.stderr);
  is(files(cacheDir), []);
  is(JSON.parse((await run(['cache', '--json'], { cacheDir, tab: null })).stdout).entries, 0);
  is((await run(['find', 'Ada'], { cacheDir })).calls.length, 1, 'cleared: fetched again');
  is((await run(['cache', 'wipe'], { cacheDir, tab: null })).code, 1);
});

test('a damaged cache file is ignored, not fatal', async () => {
  const cacheDir = tmp();
  fs.writeFileSync(path.join(cacheDir, 'wd3.myworkday.com_acme.json'), '{not json');
  const r = await run(['find', 'Ada'], { cacheDir });
  is(r.code, 0, r.stderr);
  is(r.calls.length, 1);
});

test('--max-age needs a duration', async () => {
  const r = await run(['find', 'Ada', '--max-age', 'soon']);
  is(r.code, 1);
  ok(r.stderr.includes('--max-age'), r.stderr);
  is(r.calls, []);
});

// ── rate limit ────────────────────────────────────────────────────────
const searchKey = 'GET /acme/search.htmld?q=Ada&autocomplete=true';

test('"Too many repeating requests" twice, then data: waits 15 s and 30 s, then succeeds', async () => {
  const routes = { ...ROUTES, [searchKey]: [F.TOO_MANY, F.TOO_MANY, F.SEARCH] };
  const r = await run(['find', 'Ada', '--json'], { routes });
  is(r.code, 0, r.stderr);
  is(r.sleeps, [15000, 30000]);
  is(r.calls.length, 3);
  is(JSON.parse(r.stdout).length, 2);
  ok(r.stderr.includes('too many requests'), r.stderr);
});

test('after 4 tries it exits non-zero with a clear message, and caches nothing', async () => {
  const cacheDir = tmp();
  const routes = { ...ROUTES, [searchKey]: F.TOO_MANY };
  const r = await run(['find', 'Ada'], { routes, cacheDir });
  is(r.code, 1);
  is(r.calls.length, 4);
  is(r.sleeps, [15000, 30000, 60000]);
  ok(r.stderr.includes('rate limiting') && r.stderr.includes('wait a few minutes'), r.stderr);
  is(entries(cacheDir), []);
});

test('--retry-wait sets the first wait; other Workday errors are not retried', async () => {
  const routes = { ...ROUTES, [searchKey]: [F.TOO_MANY, F.SEARCH] };
  const r = await run(['find', 'Ada', '--retry-wait', '2s'], { routes });
  is(r.code, 0, r.stderr);
  is(r.sleeps, [2000]);
  const err = await run(['find', 'Ada'], { routes: { ...ROUTES, [searchKey]: F.SERVER_ERROR } });
  is(err.code, 1);
  is(err.calls.length, 1);
  is(err.sleeps, []);
  const parm = await run(['find', 'Ada'], { routes: { ...ROUTES, [searchKey]: F.MISSING_PARM } });
  is(parm.calls.length, 1);
});

test('the chunk request is retried too', async () => {
  const key = 'GET /acme/navigablechunk/c1-x/9.htmld?startRow=2&maxRows=50';
  const routes = { ...ROUTES, [key]: [F.TOO_MANY, ROUTES[key]] };
  const r = await run(['org', '2500$2001', '--json'], { routes });
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout).children.length, 3);
  is(r.sleeps, [15000]);
});
