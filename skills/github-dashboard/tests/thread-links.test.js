import test, { is, ok } from 'tst';

// Operator-approved bb-thread linking rules (2026-09-25). Evaluates the FENCED
// threadLinks block (8< ... >8) of the fetcher, located like the other suites;
// GHD_FETCHER points elsewhere. An absent block makes every function a stub
// that throws, so each test goes red on its own.
// Fixtures are shaped like `bb thread list --json` rows and GitHub PR details,
// with FAKE ids and names only.
const fs = require('fs');
const FILE = (process.env && process.env.GHD_FETCHER) ||
  ['../scripts/fetch-snapshot.mjs', '../fetch-snapshot.mjs']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => fs.existsSync(p)) ||
  (() => { throw new Error('fetch-snapshot.mjs not found; set GHD_FETCHER'); })();
const src = fs.readFileSync(FILE, 'utf8');
const a = src.indexOf('/* ---- 8< threadLinks');
const b = src.indexOf('/* ---- >8 end threadLinks');
const NAMES = ['threadCandidates', 'linkThreads', 'carryRefsThreads', 'applyRefsAging', 'carriedActivity', 'detectBbRpc', 'parsePullForThread', 'nonClosingRefs', 'sharedEnvironmentIds'];
const M = a >= 0 && b > a
  ? new Function(src.slice(a, b) + '\nreturn {' + NAMES.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : null`).join(', ') + '};')()
  : {};
for (const n of NAMES) if (!M[n]) M[n] = () => { throw new Error(`${n} is not defined in ${FILE}`); };

const REPO = 'octocat/widgets';
const ms = (iso) => Date.parse(iso);
let seq = 0;
// A `bb thread list --json` row (updatedAt is epoch ms there).
const thread = (o = {}) => ({
  id: `thr_example${++seq}`, projectId: 'proj_example1', environmentId: `env_example${seq}`, providerId: 'codex',
  title: null, titleFallback: null, status: 'idle', visibility: 'visible', archivedAt: null, deletedAt: null,
  createdAt: ms('2026-09-20T08:00:00Z'), updatedAt: ms('2026-09-24T10:00:00Z'), activity: {}, queuedWork: 'none',
  environmentBranchName: `bb/some-work-thr_example${seq}`, hasPendingInteraction: false, ...o,
});
const issue = (id, o = {}) => ({ repo: REPO, id: String(id), kind: 'issue', stage: 1, title: `issue ${id}`, lastActivityAt: '2026-09-20T00:00:00Z', ...o });
const pr = (id, o = {}) => ({ repo: REPO, id: String(id), kind: 'pr', stage: 6, title: `pr ${id}`, lastActivityAt: '2026-09-24T12:00:00Z', ...o });
const info = (headRef, createdAt, refs = [], headRepo = REPO) => ({ headRef, headRepo, createdAt, refs: new Set(refs) });
const link = (records, threads, extra = {}) => M.linkThreads({ records, threadsByRepo: { [REPO]: threads }, ...extra });

// ---- unchanged: the title "#N" rule ---------------------------------------------

test('U1 title "#N" still links an issue (title), branch digits corroborate (both), branch-only is rejected', () => {
  const recs = [issue(12), issue(13), issue(14)];
  const out = link(recs, [
    thread({ title: 'Fix the widget crash (#12)' }),
    thread({ title: 'Work on #13', environmentBranchName: 'bb/work-13-thr_example99' }),
    thread({ title: 'unrelated', environmentBranchName: 'bb/bump-node-14-thr_example98' }),
  ]);
  is(recs[0].thread.matchedBy, 'title');
  is(recs[1].thread.matchedBy, 'both');
  is(recs[2].thread, undefined);
  ok(out.rejected.some((r) => r.number === '14' && /branch digits only/.test(r.reason)), 'branch-only rejected');
});

test('U2 several title matches: the most recently updated thread wins; threadCandidates counts them all', () => {
  const recs = [issue(20)];
  const older = thread({ title: 'first go at #20', updatedAt: ms('2026-09-21T00:00:00Z') });
  const newer = thread({ title: 'second go at #20', updatedAt: ms('2026-09-23T00:00:00Z') });
  link(recs, [newer, older]);
  is(recs[0].thread.id, newer.id);
  is(recs[0].threadCandidates, 2);
});

test('U3 no fuzzy, bare-number or number-anywhere rules: none of these link', () => {
  const recs = [issue(3180)];
  link(recs, [
    thread({ title: 'benchmark runs on actions' }),
    thread({ title: 'look at 3180 please' }),
    thread({ title: 'x', environmentBranchName: 'feat/octocat-3180-benchmark' }),
  ]);
  is(recs[0].thread, undefined);
});

// ---- signal A: pr-env, feature detection, the shared-environment guard ------------

test('A1 feature detect: old bb ("unknown command: rpc", ANSI) -> skipped; new bb usage -> available; anything else -> skipped', () => {
  const old = M.detectBbRpc({ exitCode: 1, stdout: '', stderr: '\u001b[31mbb:\u001b[0m unknown command: rpc\nRun \'bb --help\' for usage.\n' });
  is(old.available, false);
  ok(/unknown/.test(old.why), old.why);
  is(M.detectBbRpc({ exitCode: 1, stdout: '', stderr: 'bb: usage: bb rpc <plugin> <method> [<json> | -] [--json]\n' }).available, true);
  const odd = M.detectBbRpc({ exitCode: 127, stdout: '', stderr: 'bb: command not found' });
  is(odd.available, false);
  ok(/unclear/.test(odd.why), odd.why);
});

test('A2 fallback when pr-env is unavailable: with no pulls at all, pr-branch still links the PR', () => {
  const recs = [pr(40)];
  const t = thread({ environmentBranchName: 'feat/widget-cache', updatedAt: ms('2026-09-24T10:00:00Z') });
  link(recs, [t], { pulls: new Map(), prInfo: new Map([[`${REPO}#40`, info('feat/widget-cache', '2026-09-22T09:00:00Z')]]) });
  is(recs[0].thread.id, t.id);
  is(recs[0].thread.matchedBy, 'pr-branch');
});

test('A3 pr-env links a live thread to its PR; the envelope parses; ok:false and bad shapes throw, null is "no PR"', () => {
  const t = thread({});
  const pull = M.parsePullForThread(JSON.stringify({ ok: true, result: { pull: { repo: REPO, number: 41, environmentId: t.environmentId } } }));
  is(JSON.stringify(pull), JSON.stringify({ repo: REPO, number: '41', environmentId: t.environmentId }));
  is(M.parsePullForThread('{"ok":true,"result":{"pull":null}}'), null);
  let threw = 0;
  for (const bad of ['{"ok":false,"error":{"code":"nope"}}', '{"ok":true}', 'not json']) { try { M.parsePullForThread(bad); } catch { threw++; } }
  is(threw, 3);
  const recs = [pr(41)];
  link(recs, [t], { pulls: new Map([[t.id, pull]]) });
  is(recs[0].thread.matchedBy, 'pr-env');
});

test('A4 shared-environment guard: several LIVE threads on one environment -> the pull is ignored', () => {
  const recs = [pr(2474)];
  const shared = [1, 2, 3].map((i) => thread({ environmentId: 'env_example_shared', title: `boy-scout: file ${i}` }));
  const pulls = new Map(shared.map((t) => [t.id, { repo: REPO, number: '2474', environmentId: 'env_example_shared' }]));
  const out = link(recs, shared, { pulls });
  is(recs[0].thread, undefined);
  is(out.stats.prEnvSharedEnvIgnored, 3);
  ok(out.rejected.every((r) => /shared by 3 live threads/.test(r.reason)), 'reason names the sharing');
  // An archived sibling does not count as sharing: it cannot be "live on the environment".
  const recs2 = [pr(2474)];
  const liveOne = thread({ environmentId: 'env_example_two' });
  const archivedSibling = thread({ environmentId: 'env_example_two', archivedAt: ms('2026-09-01T00:00:00Z') });
  link(recs2, [liveOne, archivedSibling], { pulls: new Map([[liveOne.id, { repo: REPO, number: '2474', environmentId: 'env_example_two' }]]) });
  is(recs2[0].thread && recs2[0].thread.matchedBy, 'pr-env');
});

test('A5 pr-env never crosses repos, and is only read for live threads', () => {
  const recs = [pr(42)];
  const t = thread({});
  const out = link(recs, [t], { pulls: new Map([[t.id, { repo: 'octocat/other', number: '42', environmentId: t.environmentId }]]) });
  is(recs[0].thread, undefined);
  is(out.stats.prEnvOtherRepo, 1);
  const recs2 = [pr(43)];
  const arch = thread({ archivedAt: ms('2026-09-10T00:00:00Z') });
  link(recs2, [arch], { pulls: new Map([[arch.id, { repo: REPO, number: '43', environmentId: arch.environmentId }]]) });
  is(recs2[0].thread, undefined);
});

// ---- signal B: pr-branch and its time condition -----------------------------------

test('B1 time condition: a thread last updated BEFORE the PR was created is branch-name reuse -> no link', () => {
  const recs = [pr(50)];
  const stale = thread({ environmentBranchName: 'renovate/widgets-lib-2.x', archivedAt: ms('2026-08-02T00:00:00Z'), updatedAt: ms('2026-08-01T00:00:00Z') });
  const out = link(recs, [stale], { prInfo: new Map([[`${REPO}#50`, info('renovate/widgets-lib-2.x', '2026-09-20T00:00:00Z')]]) });
  is(recs[0].thread, undefined);
  is(out.stats.prBranchBeforePr, 1);
  ok(out.rejected.some((r) => /branch-name reuse/.test(r.reason)), 'reason recorded');
});

test('B2 same branch, thread updated after the PR opened (archived is fine) -> pr-branch; a fork head never matches', () => {
  const recs = [pr(51), pr(52)];
  const t = thread({ environmentBranchName: 'feat/widget-cache', archivedAt: ms('2026-09-24T11:00:00Z'), updatedAt: ms('2026-09-24T11:00:00Z') });
  const t2 = thread({ environmentBranchName: 'feat/shared-name' });
  link(recs, [t, t2], { prInfo: new Map([
    [`${REPO}#51`, info('feat/widget-cache', '2026-09-23T00:00:00Z')],
    [`${REPO}#52`, info('feat/shared-name', '2026-09-23T00:00:00Z', [], 'someone/widgets-fork')],
  ]) });
  is(recs[0].thread && recs[0].thread.matchedBy, 'pr-branch');
  is(recs[0].thread.archived, true);
  is(recs[1].thread, undefined);
});

test('B3 both PR signals on one pair -> "pr-env+branch"; pr-env outranks a NEWER pr-branch-only thread', () => {
  const recs = [pr(60), pr(61)];
  const both = thread({ environmentBranchName: 'feat/sixty' });
  const exact = thread({ environmentBranchName: 'feat/elsewhere', updatedAt: ms('2026-09-24T09:00:00Z') });
  const newerBranchOnly = thread({ environmentBranchName: 'feat/sixty-one', archivedAt: ms('2026-09-24T20:00:00Z'), updatedAt: ms('2026-09-24T20:00:00Z') });
  link(recs, [both, exact, newerBranchOnly], {
    pulls: new Map([[both.id, { repo: REPO, number: '60', environmentId: both.environmentId }], [exact.id, { repo: REPO, number: '61', environmentId: exact.environmentId }]]),
    prInfo: new Map([[`${REPO}#60`, info('feat/sixty', '2026-09-22T00:00:00Z')], [`${REPO}#61`, info('feat/sixty-one', '2026-09-22T00:00:00Z')]]),
  });
  is(recs[0].thread.matchedBy, 'pr-env+branch');
  is(recs[1].thread.id, exact.id);
  is(recs[1].thread.matchedBy, 'pr-env');
  is(recs[1].threadCandidates, 2);
});

// ---- refs-pr: carry-over and aging -------------------------------------------------

test('R1 refs-pr: an issue with no thread inherits the thread of a PR that says "Refs #N" (same repo only)', () => {
  const recs = [issue(3180), pr(3498), issue(70, { title: 'has its own' }), pr(71)];
  const prThread = thread({ environmentBranchName: 'feat/bench' });
  const own = thread({ title: 'Work on #70' });
  link(recs, [prThread, own], { prInfo: new Map([
    [`${REPO}#3498`, info('feat/bench', '2026-09-22T00:00:00Z', [...M.nonClosingRefs('ci: faster runs', 'Refs #3180')])],
    [`${REPO}#71`, info('feat/none', '2026-09-22T00:00:00Z', [...M.nonClosingRefs('', 'Refs #70')])],
  ]) });
  const carried = M.carryRefsThreads({ records: recs, prInfo: new Map([
    [`${REPO}#3498`, info('feat/bench', '2026-09-22T00:00:00Z', ['3180'])],
    [`${REPO}#71`, info('feat/none', '2026-09-22T00:00:00Z', ['70'])],
  ]) });
  is(recs[0].thread.id, prThread.id);
  is(recs[0].thread.matchedBy, 'refs-pr');
  is(recs[0].thread.viaPr, `${REPO}#3498`);
  is(recs[2].thread.matchedBy, 'title');
  is([...carried.keys()].join(), `${REPO}#3180`);
});

test('R2 refs-pr wording: Refs/Ref/References, any case; not closing keywords, not other-repo refs, not bare numbers', () => {
  is([...M.nonClosingRefs('Refs #1. ref #2, REFERENCES #3, References   #4')].join(), '1,2,3,4');
  is(M.nonClosingRefs('Closes #5', 'Fixes #6', 'refs octocat/other#7', 'see 8', 'prefs #9', 'Refs#10').size, 0);
});

test('R3 refs-pr aging: an OPEN issue ages by max(own, referencing PRs); the own value is kept; closed issues are untouched', () => {
  const recs = [issue(80, { stage: 2, lastActivityAt: '2026-09-18T00:00:00Z' }), pr(81, { lastActivityAt: '2026-09-24T12:00:00Z' }),
    issue(82, { stage: 11, lastActivityAt: '2026-09-18T00:00:00Z' }), issue(83, { stage: 2, lastActivityAt: '2026-09-25T00:00:00Z' })];
  const n = M.applyRefsAging(recs, new Map([[`${REPO}#80`, [`${REPO}#81`]], [`${REPO}#82`, [`${REPO}#81`]], [`${REPO}#83`, [`${REPO}#81`]]]));
  is(n, 1);
  is(recs[0].lastActivityAt, '2026-09-24T12:00:00Z');
  is(recs[0].lastActivityAtOwn, '2026-09-18T00:00:00Z');
  is(recs[0].activityCarriedFrom.join(), `${REPO}#81`);
  is(recs[2].lastActivityAt, '2026-09-18T00:00:00Z');
  is(recs[2].lastActivityAtOwn, undefined);
  is(recs[3].lastActivityAt, '2026-09-25T00:00:00Z');
  is(recs[3].lastActivityAtOwn, undefined);
});

// ---- wiring in the fetcher around the fence -------------------------------------------

test('W1 wiring: 200-thread limit, a full page is informational, the status cache keys on OWN activity', () => {
  ok(/const THREAD_LIST_LIMIT = [^\n]*: 200;/.test(src), 'THREAD_LIST_LIMIT defaults to 200');
  ok(!/\[bb\] WARNING/.test(src), 'no WARNING for a full page');
  ok(src.includes("if (e.lastActivityAt !== (rec.lastActivityAtOwn || rec.lastActivityAt))"), 'cache lookup keys on own activity');
  ok(src.includes('lastActivityAt: rec.lastActivityAtOwn || rec.lastActivityAt,'), 'cache store keys on own activity');
  ok(/refsAged = applyRefsAging\(records, refsCarried\);[\s\S]*if \(!activityExclusionApplied\)/.test(src), 'aging runs after the activity correction');
});
