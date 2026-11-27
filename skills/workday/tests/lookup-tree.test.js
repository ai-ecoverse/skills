// lookup-tree.test.js — `workday lookup` and `workday tree`, through the shipped workday.jsh.
import test, { is, ok } from 'tst';
import * as F from './fixtures.js';
import { ROUTES, run } from './harness.js';

const routes = {
  ...ROUTES,
  ...F.TREE_ROUTES,
  'POST /acme/navigable/2500$2002.htmld': F.navigator(F.ORG_TEAM, F.SUB, [F.person(900), F.person(901)]),
};
const ids = (people) => people.map((p) => p.id);

// ── lookup ────────────────────────────────────────────────────────────
test('lookup resolves names from stdin: exact match wins, ambiguous and missing get a status', async () => {
  const r = await run(['lookup', '--gap', '0'], { stdin: 'Ada Lovelace\n\nAda\nNobody\n' });
  is(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  is(lines.length, 3, r.stdout);
  ok(lines[0].includes('Ada Lovelace | found | Principal | Analytical Engines | London | Charles Babbage | id:247$1001'), lines[0]);
  ok(lines[1].includes('Ada | ambiguous (2)'), lines[1]);
  ok(lines[2].includes('Nobody | not-found'), lines[2]);
});

test('lookup --json passes other fields through and adds a workday object', async () => {
  const input = JSON.stringify([
    { name: 'Ada Lovelace', title: 'my own title', ticket: 'T-1' },
    { name: 'Ada', ticket: 'T-2' },
    { name: 'Nobody' },
  ]);
  const r = await run(['lookup', '--json', '--gap', '0'], { stdin: input });
  is(r.code, 0, r.stderr);
  const [a, b, c] = JSON.parse(r.stdout);
  is(a.title, 'my own title', 'input fields are never overwritten');
  is(a.ticket, 'T-1');
  is(a.workday, {
    status: 'found',
    id: '247$1001',
    name: 'Ada Lovelace',
    title: 'Principal',
    org: 'Analytical Engines',
    location: 'London',
    manager: 'Charles Babbage',
    managerId: '247$7',
  });
  is(b.workday.status, 'ambiguous');
  is(b.workday.candidates.map((p) => p.id), ['247$1001', '247$1004']);
  is(b.ticket, 'T-2');
  is(c.workday, { status: 'not-found', candidates: [] });
});

test('lookup: the second run makes no requests, and the gap sits between real requests only', async () => {
  const cacheDir = (await run(['cache', '--json'], { tab: null })).cacheDir;
  const stdin = JSON.stringify([{ name: 'Ada Lovelace' }, { name: 'Ada' }, { name: 'Nobody' }]);
  const first = await run(['lookup', '--json'], { stdin, cacheDir });
  is(first.code, 0, first.stderr);
  is(first.sleeps.length, first.calls.length - 1);
  ok(first.sleeps.every((ms) => ms === 1000));
  const second = await run(['lookup', '--json'], { stdin, cacheDir });
  is(second.calls, []);
  is(second.sleeps, []);
  is(second.stdout, first.stdout);
  const fresh = await run(['lookup', '--json', '--fresh', '--gap', '250ms'], { stdin, cacheDir });
  is(fresh.calls.length, first.calls.length);
  ok(fresh.sleeps.every((ms) => ms === 250));
});

test('lookup rejects empty input and malformed JSON', async () => {
  is((await run(['lookup'], { stdin: '' })).code, 1);
  const bad = await run(['lookup', '--json'], { stdin: '["Ada"]' });
  is(bad.code, 1);
  ok(bad.stderr.includes('"name"'), bad.stderr);
  is((await run(['lookup', '--json'], { stdin: 'not json' })).code, 1);
  is(bad.calls, []);
});

// ── tree ──────────────────────────────────────────────────────────────
test('tree pages every org past its first page: nobody is dropped', async () => {
  const r = await run(['tree', '2500$4000', '--json', '--gap', '0'], { routes });
  is(r.code, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  is(d.root, { id: '2500$4000', name: 'Research (Barbara Liskov)' });
  is(d.count, 185);
  is(d.people.length, 185);
  is(d.incomplete, false);
  const have = new Set(ids(d.people));
  for (let n = 1; n < 119; n++) ok(have.has(`247$${5000 + n}`), `root member ${n}`);
  for (let n = 200; n < 259; n++) ok(have.has(`247$${5000 + n}`), `A member ${n}`);
  // each chunk is requested right after its org's request
  const keys = r.calls.map((c) => c.key);
  const at = (k) => keys.indexOf(k);
  is(at('GET /acme/navigablechunk/r/1.htmld?startRow=50&maxRows=50'), at('POST /acme/navigable/2500$4000.htmld') + 1);
  is(at('GET /acme/navigablechunk/r/1.htmld?startRow=100&maxRows=50'), at('POST /acme/navigable/2500$4000.htmld') + 2);
  is(at('GET /acme/navigablechunk/a/1.htmld?startRow=50&maxRows=50'), at('POST /acme/navigable/2500$4001.htmld') + 1);
});

test('tree lists each person once and breadth-first', async () => {
  const r = await run(['tree', '2500$4000', '--json', '--gap', '0'], { routes });
  const { people } = JSON.parse(r.stdout);
  is(new Set(ids(people)).size, people.length);
  is(r.calls.filter((c) => c.key.startsWith('POST ')).map((c) => /\/(2500\$\d+)\.htmld$/.exec(c.key)[1]), ['2500$4000', '2500$4001', '2500$4002', '2500$4003']);
  is(r.calls.filter((c) => c.key.startsWith('POST ')).length, 4, 'every org is requested once');
  const x = people.find((p) => p.id === '247$6001');
  is(x.group, 'Donald Knuth', 'a person in two orgs sits where the walk saw them first');
  const depths = people.map((p) => p.depth);
  is(depths, [...depths].sort((a, b) => a - b));
});

test('tree assigns the top-level group: the root\'s direct report whose sub-org holds the person', async () => {
  const r = await run(['tree', '2500$4000', '--json', '--gap', '0'], { routes });
  const by = Object.fromEntries(JSON.parse(r.stdout).people.map((p) => [p.id, p]));
  is(by['247$20'].group, null, 'the root owner is in no group');
  is([by['247$21'].group, by['247$21'].groupId], ['Donald Knuth', '247$21']);
  is(by['247$5200'].group, 'Donald Knuth');
  is(by['247$5258'].group, 'Donald Knuth', 'from the chunk page of A');
  is(by['247$6002'].group, 'Margaret Hamilton');
  is([by['247$23'].group, by['247$23'].depth], ['Margaret Hamilton', 2], 'a nested org owner takes the top group');
  is(by['247$6003'].group, 'Margaret Hamilton');
  is(by['247$6004'].depth, 3);
  is([by['247$5001'].group, by['247$5001'].groupId], ['Person 1', '247$5001'], 'a direct report heads their own group');
  is(by['247$6003'].title, 'Tech');
  is(by['247$6003'].location, 'Rome');
});

test('tree --depth limits the walk', async () => {
  const one = JSON.parse((await run(['tree', '2500$4000', '--json', '--depth', '1', '--gap', '0'], { routes })).stdout);
  is(one.depth, 1);
  is(one.count, 1 + 2 + 118, 'root owner, the two sub-org owners, 118 leaves');
  const two = await run(['tree', '2500$4000', '--json', '--depth', '2', '--gap', '0'], { routes });
  ok(!two.calls.some((c) => c.key.includes('2500$4003')), 'C is level 3');
  is(JSON.parse(two.stdout).count, 183, 'C\'s owner is listed, its two members are not');
  is((await run(['tree', '2500$4000', '--depth', '0'], { routes })).code, 1);
});

test('tree by person: resolves the name and walks the team they lead', async () => {
  const r = await run(['tree', '247$7', '--json', '--gap', '0'], { routes });
  is(r.code, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  is(d.root.id, '2500$2001');
  is(ids(d.people).sort(), ['247$1001', '247$1002', '247$1003', '247$5900', '247$5901', '247$7'].sort());
  is(d.people.find((p) => p.id === '247$5900').group, 'Kathleen Booth');
});

test('tree for someone who leads no org says so', async () => {
  const r = await run(['tree', '247$1001', '--gap', '0'], { routes });
  is(r.code, 1);
  ok(r.stderr.includes('leads no organization'), r.stderr);
});

test('tree is cached: the second run makes no requests; an incomplete org is reported', async () => {
  const first = await run(['tree', '2500$4000', '--json'], { routes });
  const second = await run(['tree', '2500$4000', '--json'], { routes, cacheDir: first.cacheDir });
  is(second.calls, []);
  is(second.stdout, first.stdout);
  const short = { ...routes, 'GET /acme/navigablechunk/a/1.htmld?startRow=50&maxRows=50': { widget: 'navigatorDetailsChunk', totalCount: 60, navigatorDetails: [] } };
  const r = await run(['tree', '2500$4000', '--json', '--gap', '0'], { routes: short });
  is(r.code, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  is(d.incomplete, true);
  ok(r.stderr.includes('2500$4001') && r.stderr.includes('50 of 60'), r.stderr);
});

test('tree prints a table without --json', async () => {
  const r = await run(['tree', '2500$4003', '--gap', '0'], { routes });
  is(r.code, 0, r.stderr);
  ok(r.stdout.includes('Zed Example') && r.stdout.includes('Katherine Johnson'), r.stdout);
});
