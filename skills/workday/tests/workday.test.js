import { createRequire } from 'node:module';
import test, { is, ok } from 'tst';
import * as F from './fixtures.js';

const require = createRequire(import.meta.url);
const wd = require('../scripts/lib/workday.js');

test('tenantFromUrl reads origin and tenant from a Workday tab', () => {
  is(wd.tenantFromUrl('https://wd3.myworkday.com/acme/d/home.htmld'), {
    origin: 'https://wd3.myworkday.com',
    tenant: 'acme',
  });
  is(wd.tenantFromUrl('https://wd3.myworkday.com/wday/asset/x.js'), null);
  is(wd.tenantFromUrl('https://myworkday.com.evil.example/acme/'), null);
  is(wd.tenantFromUrl('http://wd3.myworkday.com/acme/'), null);
  is(wd.tenantFromUrl('not a url'), null);
});

test('workdayError finds the XML error that comes with HTTP 200', () => {
  is(wd.workdayError(F.MISSING_PARM), {
    kind: 'workday',
    message: 'Missing Required Parm: Navigable_Task--IS (15$35098)',
  });
  is(wd.workdayError(F.SIGN_IN_PAGE).kind, 'html');
  is(wd.workdayError('{"widget":"root"}'), null);
  is(wd.workdayError({ widget: 'root' }), null);
});

test('currentUser reads the signed-in worker from home.htmld', () => {
  is(wd.currentUser(F.HOME), { id: '247$1001', name: 'Ada Lovelace', profilePath: '/acme/inst/1$37/247$1001' });
  is(wd.currentUser({ widget: 'root' }), null);
  is(wd.currentUser({ currentUser: { iid: 'x', label: 'y' } }), null);
});

test('searchPeople keeps people and drops tasks and custom orgs', () => {
  const people = wd.searchPeople(F.SEARCH);
  is(people.map((p) => p.id), ['247$1001', '247$1004']);
  is(people[0], {
    id: '247$1001',
    name: 'Ada Lovelace',
    title: 'Principal',
    org: 'Analytical Engines',
    location: 'London',
    kind: 'Employee',
    profilePath: '/acme/inst/autocompletesearch/247$1001',
  });
  is(wd.searchPeople({}), []);
});

test('choosePerson takes an exact name, else the only hit, else lists candidates', () => {
  const people = wd.searchPeople(F.SEARCH);
  is(wd.choosePerson('ada lovelace', people).person.id, '247$1001');
  is(wd.choosePerson('Ada', [people[1]]).person.id, '247$1004');
  const many = wd.choosePerson('Ada', people);
  ok(many.error.includes('matches 2 people'), many.error);
  is(many.candidates.length, 2);
  ok(wd.choosePerson('Nobody', []).error.includes('no one'));
});

test('parseProfile reads title, email, managers, org path and View Team', () => {
  is(wd.parseProfile(F.PROFILE_ADA), {
    id: '247$1001',
    name: 'Ada Lovelace',
    title: 'Principal',
    email: 'ada@example.com',
    location: 'London',
    managers: [{ id: '247$7', name: 'Charles Babbage' }],
    orgPath: ['Engineering (Grace Hopper)', 'Analytical Engines (Charles Babbage)'],
    teamPath: '/acme/inst/4547$1/rel-task/2998$90',
  });
  is(wd.parseProfile(F.HOME), null);
});

test('parseProfile drops a View Team uri that is not a same-origin path', () => {
  const evil = F.profile('247$1', 'Eve', { title: '', email: '', org: '', team: 'https://evil.example/x' });
  is(wd.parseProfile(evil).teamPath, null);
});

test('parseTeamPage reads org, task id, navigation path and ancestors', () => {
  const t = wd.parseTeamPage(F.teamPage('2500$2001', 'Analytical Engines  (Charles Babbage)', [F.ORG_TOP]));
  is(t.orgId, '2500$2001');
  is(t.orgName, 'Analytical Engines (Charles Babbage)');
  is(t.taskId, '2998$55');
  is(t.navigationPath, '/acme/navigable');
  is(t.ancestors.map((a) => a.owners[0].name), ['Grace Hopper']);
  is(wd.parseTeamPage(F.HOME), null);
});

test('parseNavigator splits parent, self and children into people and orgs', () => {
  const nav = wd.parseNavigator(F.navigator(F.ORG_TOP, F.ORG_TEAM, [F.ADA, F.ALAN, F.SUB], { chunk: '/acme/navigablechunk/c1-x/9' }));
  is(nav.parent.id, '2500$3000');
  is(nav.self.owners, [{ id: '247$7', name: 'Charles Babbage' }]);
  is(nav.children.map((c) => [c.id, c.kind]), [
    ['247$1001', 'person'],
    ['247$1002', 'person'],
    ['2500$2002', 'org'],
  ]);
  is(nav.children[0].title, 'Principal');
  is(nav.children[2].size, 4);
  is(nav.total, 3);
  is(nav.chunkPath, '/acme/navigablechunk/c1-x/9');
  is(wd.parseNavigator(F.HOME), null);
});

test('parseChunk reads the next page of members', () => {
  is(wd.parseChunk({ widget: 'navigatorDetailsChunk', totalCount: 5, navigatorDetails: [F.ALAN] }).children[0].name, 'Alan Turing');
  is(wd.parseChunk(F.HOME), null);
});

test('chainOf lists managers nearest first, without the person and without repeats', () => {
  const team = wd.parseTeamPage(F.teamPage('2500$2001', 'Analytical Engines', [F.ORG_TOP, F.ORG_TOP]));
  const self = wd.parseNavigator(F.navigator(F.ORG_TOP, F.ORG_TEAM, [])).self;
  is(wd.chainOf('247$1001', team, self).map((m) => m.name), ['Charles Babbage', 'Grace Hopper']);
  is(wd.chainOf('247$7', team, self).map((m) => m.name), ['Grace Hopper']);
});

test('isRateLimited matches only the "Too many repeating requests" message', () => {
  ok(wd.isRateLimited(F.TOO_MANY));
  ok(!wd.isRateLimited(F.SERVER_ERROR));
  ok(!wd.isRateLimited(F.MISSING_PARM));
  ok(!wd.isRateLimited(F.SIGN_IN_PAGE));
  ok(!wd.isRateLimited('{"widget":"root"}'));
  ok(!wd.isRateLimited({ widget: 'root' }));
});

test('parseDuration reads ms, s, m, h, d and plain seconds', () => {
  is(wd.parseDuration('500ms'), 500);
  is(wd.parseDuration('15s'), 15000);
  is(wd.parseDuration('90'), 90000);
  is(wd.parseDuration('15m'), 900000);
  is(wd.parseDuration('1h'), 3600000);
  is(wd.parseDuration('2d'), 172800000);
  is(wd.parseDuration('0'), 0);
  is(wd.parseDuration('1.5h'), 5400000);
  is(wd.parseDuration('soon'), null);
  is(wd.parseDuration('-1h'), null);
  is(wd.parseDuration(''), null);
  is(wd.parseDuration(true), null);
});

test('entryFresh: within the age, not older, not from the future, not malformed', () => {
  is(wd.entryFresh({ at: 1000, value: 1 }, 1500, 600), true);
  is(wd.entryFresh({ at: 1000, value: 1 }, 1700, 600), false);
  is(wd.entryFresh({ at: 2000, value: 1 }, 1500, 600), false);
  is(wd.entryFresh({ at: 1000 }, 1500, 600), false);
  is(wd.entryFresh(null, 1500, 600), false);
  is(wd.entryFresh({ at: 'x', value: 1 }, 1500, 600), false);
});

test('cacheFileName separates host and tenant and stays a plain file name', () => {
  is(wd.cacheFileName('https://wd3.myworkday.com', 'acme'), 'wd3.myworkday.com_acme.json');
  ok(wd.cacheFileName('https://wd3.myworkday.com', 'acme') !== wd.cacheFileName('https://wd4.myworkday.com', 'acme'));
  ok(wd.cacheFileName('https://wd3.myworkday.com', 'acme') !== wd.cacheFileName('https://wd3.myworkday.com', 'beta'));
  ok(!wd.cacheFileName('https://wd3.myworkday.com', '../x').includes('/'));
});

test('parseLookupInput: lines, blank lines, JSON arrays, and what it refuses', () => {
  is(wd.parseLookupInput('Ada  Lovelace\n\n  Alan Turing \r\n', false).items.map((i) => i.name), ['Ada Lovelace', 'Alan Turing']);
  const j = wd.parseLookupInput('[{"name":"Ada","x":1}]', true);
  is(j.items[0], { name: 'Ada', source: { name: 'Ada', x: 1 } });
  ok(wd.parseLookupInput('{"name":"Ada"}', true).error);
  ok(wd.parseLookupInput('[{"nom":"Ada"}]', true).error);
  ok(wd.parseLookupInput('["Ada"]', true).error);
  ok(wd.parseLookupInput('nope', true).error);
});

test('lookupResult: found, ambiguous, not found, no profile', () => {
  const people = wd.searchPeople(F.SEARCH);
  const prof = wd.parseProfile(F.PROFILE_ADA);
  is(wd.lookupResult('Ada Lovelace', people, prof).status, 'found');
  is(wd.lookupResult('ada lovelace', people, prof).manager, 'Charles Babbage');
  is(wd.lookupResult('Ada', people, null).status, 'ambiguous');
  is(wd.lookupResult('Zed', [], null), { status: 'not-found', candidates: [] });
  is(wd.lookupResult('Ada Lovelace', people, null).status, 'no-profile');
});

test('walkTree: every member of every org once, with groups, and --depth', async () => {
  const org = (id, name, owner, children, extra = {}) => ({ self: { id, name, owners: [owner], title: 'Head', location: 'X' }, children, total: children.length, ...extra });
  const p = (id, name) => ({ kind: 'person', id, name, title: 't', location: 'l', owners: [] });
  const o = (id, name, owner) => ({ kind: 'org', id, name, title: 'Dir', location: 'l', owners: [owner] });
  const orgs = {
    R: org('R', 'Root', { id: 'r', name: 'Rita' }, [o('A', 'A', { id: 'a', name: 'Al' }), p('p1', 'P1')]),
    A: org('A', 'A', { id: 'a', name: 'Al' }, [p('p2', 'P2'), p('p1', 'P1'), o('B', 'B', { id: 'b', name: 'Bo' })]),
    B: org('B', 'B', { id: 'b', name: 'Bo' }, [p('p3', 'P3'), o('R', 'Root', { id: 'r', name: 'Rita' })]),
  };
  const seen = [];
  const load = async (id) => (seen.push(id), orgs[id]);
  const t = await wd.walkTree('R', load, {});
  is(seen, ['R', 'A', 'B']);
  is(t.people.map((x) => x.id), ['r', 'a', 'p1', 'p2', 'b', 'p3']);
  is(t.people.map((x) => x.group), [null, 'Al', 'P1', 'Al', 'Al', 'Al']);
  is(t.people.map((x) => x.depth), [0, 1, 1, 2, 2, 3]);
  const shallow = await wd.walkTree('R', load, { maxDepth: 1 });
  is(shallow.people.map((x) => x.id), ['r', 'a', 'p1']);
  orgs.A.incomplete = true;
  is((await wd.walkTree('R', load, {})).warnings.length, 1);
});
