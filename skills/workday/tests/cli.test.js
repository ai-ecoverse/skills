// cli.test.js — run the shipped workday.jsh against a fake Workday site.
import test, { is, ok } from 'tst';
import * as F from './fixtures.js';
import { ROUTES, ORIGIN, run } from './harness.js';

test('--help prints usage, exits 0 and calls nothing', async () => {
  const r = await run(['--help']);
  is(r.code, 0);
  ok(r.stdout.includes('workday orgchart'), r.stdout);
  is(r.calls, []);
});

test('whoami reads the signed-in user, not a fixed id', async () => {
  const r = await run(['whoami', '--json']);
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout).id, '247$1001');
  is(r.calls.map((c) => c.key), ['GET /acme/home.htmld', 'GET /acme/inst/autocompletesearch/247$1001.htmld']);
});

test('the tenant comes from the tab, so another tenant gets its own paths', async () => {
  const routes = Object.fromEntries(
    Object.entries(ROUTES).map(([k, v]) => [k.replace(' /acme/', ' /other/'), v])
  );
  const r = await run(['whoami', '--json'], { routes, tab: { targetId: 'T', url: `${ORIGIN}/other/d/home.htmld` } });
  is(r.code, 0, r.stderr);
  is(r.calls[0].key, 'GET /other/home.htmld');
});

test('find lists people only, with ids', async () => {
  const r = await run(['find', 'Ada']);
  is(r.code, 0, r.stderr);
  ok(r.stdout.includes('Ada Lovelace') && r.stdout.includes('id:247$1001'), r.stdout);
  ok(!r.stdout.includes('Request Absence') && !r.stdout.includes('LOVELACE_123'), r.stdout);
});

test('a name with several matches stops with the candidates', async () => {
  const r = await run(['person', 'Ada']);
  is(r.code, 1);
  ok(r.stderr.includes('matches 2 people') && r.stderr.includes('id:247$1004'), r.stderr);
});

test('a name with no match exits 1', async () => {
  const r = await run(['person', 'Nobody']);
  is(r.code, 1);
  ok(r.stderr.includes('no one'), r.stderr);
});

test('orgchart sends the task id from the team page, and pages the chunk at once', async () => {
  const r = await run(['orgchart', 'Ada Lovelace', '--json']);
  is(r.code, 0, r.stderr);
  const nav = r.calls.find((c) => c.key === 'POST /acme/navigable/2500$2001.htmld');
  is(nav.body, 'initial-step=2998%2455');
  is(nav.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const i = r.calls.indexOf(nav);
  is(r.calls[i + 1].key, 'GET /acme/navigablechunk/c1-x/9.htmld?startRow=2&maxRows=50');
  const d = JSON.parse(r.stdout);
  is(d.chain.map((m) => m.name), ['Charles Babbage', 'Grace Hopper']);
  is(d.team.members.map((m) => m.name), ['Ada Lovelace', 'Alan Turing', 'Compilers (Kathleen Booth)']);
  is(d.reports, null);
});

test("orgchart for a manager shows the team they lead as reports and the parent as their team", async () => {
  const r = await run(['orgchart', '247$7', '--json']);
  is(r.code, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  is(d.reports.id, '2500$2001');
  is(d.reports.members.length, 3);
  is(d.team.id, '2500$3000');
  is(d.chain.map((m) => m.name), ['Grace Hopper']);
});

test('--chain caps the management chain', async () => {
  const r = await run(['orgchart', '--chain', '1', '--json']);
  is(r.code, 0, r.stderr);
  is(JSON.parse(r.stdout).chain.map((m) => m.name), ['Charles Babbage']);
});

test('org rejects anything but a 2500$ id before calling Workday', async () => {
  const r = await run(['org', '247$1001']);
  is(r.code, 1);
  is(r.calls, []);
  const bad = await run(['org', '2500$1/../../x']);
  is(bad.code, 1);
  is(bad.calls, []);
});

test('an XML error with HTTP 200 is reported, not parsed as data', async () => {
  const routes = { ...ROUTES, 'POST /acme/navigable/2500$2001.htmld': F.MISSING_PARM };
  const r = await run(['org', '2500$2001'], { routes });
  is(r.code, 1);
  ok(r.stderr.includes('Missing Required Parm'), r.stderr);
});

test('a sign-in page or 401 says to sign in again', async () => {
  const page = await run(['whoami'], { routes: { 'GET /acme/home.htmld': F.SIGN_IN_PAGE } });
  is(page.code, 1);
  ok(page.stderr.includes('sign in to Workday'), page.stderr);
  const denied = await run(['whoami'], { routes: { 'GET /acme/home.htmld': { status: 401, body: '' } } });
  is(denied.code, 1);
  ok(denied.stderr.includes('session expired'), denied.stderr);
});

test('no Workday tab exits 1 with what to open', async () => {
  const r = await run(['whoami'], { tab: null });
  is(r.code, 1);
  ok(r.stderr.includes('myworkday.com'), r.stderr);
});

test('every request is a read: GET, or the org chart POST', async () => {
  for (const args of [['whoami'], ['find', 'Ada'], ['person'], ['orgchart'], ['org', '2500$2001']]) {
    const r = await run(args);
    is(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    for (const c of r.calls) {
      ok(c.key.startsWith('GET ') || /^POST \/acme\/navigable\/2500\$\d+\.htmld$/.test(c.key), c.key);
    }
  }
});
