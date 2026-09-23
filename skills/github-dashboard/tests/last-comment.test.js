import test, { is, ok, throws } from 'tst';

// Evaluates the FENCED block of the fetcher copy itself (the 8< ... >8 markers),
// so these assertions test the shipped text, not a paraphrase of it.
// GHD_FETCHER points at an alternative file, used to show which tests go RED
// against a naive "newest comment" variant.
const fs = require('fs');
// Default: the skill-repo layout (tests/ next to scripts/) or the deployed layout
// (tests/ next to the fetcher), the same two layouts build.sh knows. import.meta.url
// keeps this independent of the cwd; the realm's readFileSync wants a path string.
const FILE = (process.env && process.env.GHD_FETCHER) ||
  ['../scripts/fetch-snapshot.mjs', '../fetch-snapshot.mjs']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => fs.existsSync(p)) ||
  (() => { throw new Error('fetch-snapshot.mjs not found; set GHD_FETCHER'); })();
const src = fs.readFileSync(FILE, 'utf8');
const a = src.indexOf('/* ---- 8< lastComment');
const b = src.indexOf('/* ---- >8 end lastComment');
if (a < 0 || b < a) throw new Error(`fence markers not found in ${FILE}`);
const M = new Function(
  src.slice(a, b) +
    '\nreturn { GHD_MIRROR_MARKER, commentCounts, newestQualifyingCommentAt, combineLastCommentAt, lastPageFromLink, fetchLastCommentAt, lastCommentPhase };',
)();

const ME = 'octocat';
const MARK = '<!-- ghd-mirror:v1 -->';
const mirrorBody = `${MARK}\n**Filed on my dashboard**\n\n- Snoozed until 2026-09-26\n`;
const c = (login, type, created_at, body = 'hello', updated_at = created_at) => ({ user: { login, type }, created_at, updated_at, body });

// ---- the six required cases --------------------------------------------------

test('R1 a mirror comment by the authenticated user is excluded', () => {
  is(M.newestQualifyingCommentAt([c(ME, 'User', '2026-09-22T20:21:17Z', mirrorBody)], ME), null);
});

test('R2 the marker pasted by a different author still counts', () => {
  is(M.newestQualifyingCommentAt([c('someone-else', 'User', '2026-09-22T21:00:00Z', mirrorBody)], ME), '2026-09-22T21:00:00Z');
});

test('R3 a bot comment is excluded', () => {
  is(M.newestQualifyingCommentAt([c('github-actions[bot]', 'Bot', '2026-09-23T09:00:00Z', 'Released in v6.180.0')], ME), null);
});

test('R4 an ordinary comment by the authenticated user counts', () => {
  is(M.newestQualifyingCommentAt([c(ME, 'User', '2026-09-21T16:26:04Z', '## Decision: the op ships ungated')], ME), '2026-09-21T16:26:04Z');
});

test('R5 no comments gives null', () => {
  is(M.newestQualifyingCommentAt([], ME), null);
});

test('R6 mixed thread whose newest is the mirror: answer is the newest NON-mirror comment', () => {
  // Shape of real ai-ecoverse/slicc#3347 (bot, bot, human decision, mirror).
  const thread = [
    c('github-actions[bot]', 'Bot', '2026-09-21T13:54:42Z', 'This bug brought a kazoo to a string quartet.'),
    c('github-actions[bot]', 'Bot', '2026-09-21T16:02:18Z', 'Backlog Dispatcher'),
    c(ME, 'User', '2026-09-21T16:26:04Z', '## Decision: the op ships ungated'),
    c(ME, 'User', '2026-09-22T20:21:33Z', mirrorBody),
  ];
  is(M.newestQualifyingCommentAt(thread, ME), '2026-09-21T16:26:04Z');
});

// ---- guards around the rule --------------------------------------------------

test('G1 login match is case-insensitive (GitHub logins are)', () => {
  is(M.newestQualifyingCommentAt([c('OctoCat', 'User', '2026-09-22T20:21:17Z', mirrorBody)], ME), null);
});

test('G2 no authenticated login: refuse rather than let the mirror count', () => {
  throws(() => M.newestQualifyingCommentAt([c(ME, 'User', '2026-09-22T20:21:17Z', mirrorBody)], ''));
  throws(() => M.commentCounts(c(ME, 'User', '2026-09-22T20:21:17Z'), null));
});

test('G3 created_at is used, not updated_at: editing an old comment is not new follow-up', () => {
  is(M.newestQualifyingCommentAt([c('bob', 'User', '2026-09-01T00:00:00Z', 'typo fixed', '2026-09-23T00:00:00Z')], ME), '2026-09-01T00:00:00Z');
});

test('G4 order-free, deleted-user (null user) counts, unparseable created_at is ignored', () => {
  const t = [c('bob', 'User', '2026-09-20T00:00:00Z'), { user: null, created_at: '2026-09-19T00:00:00Z', body: 'x' }, c('amy', 'User', 'not a date')];
  is(M.newestQualifyingCommentAt(t.slice().reverse(), ME), '2026-09-20T00:00:00Z');
  is(M.newestQualifyingCommentAt([t[1]], ME), '2026-09-19T00:00:00Z');
});

test('G5 merged cards: newest known wins; null+null is null; unknown stays unknown', () => {
  is(M.combineLastCommentAt('2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'), '2026-09-21T00:00:00Z');
  is(M.combineLastCommentAt(null, '2026-09-21T00:00:00Z'), '2026-09-21T00:00:00Z');
  is(M.combineLastCommentAt(null, null), null);
  is(M.combineLastCommentAt(undefined, null), undefined);
});

// ---- pagination: read from the end -------------------------------------------

function fakeThread(comments, perPage) {
  const calls = [];
  const pages = Math.max(1, Math.ceil(comments.length / perPage));
  const getPage = async (p) => {
    calls.push(p);
    const link = [];
    if (p < pages) link.push(`<https://api.github.com/x?per_page=${perPage}&page=${p + 1}>; rel="next"`, `<https://api.github.com/x?per_page=${perPage}&page=${pages}>; rel="last"`);
    if (p > 1) link.push(`<https://api.github.com/x?per_page=${perPage}&page=1>; rel="first"`);
    return { comments: comments.slice((p - 1) * perPage, p * perPage), link: link.join(', ') || null };
  };
  return { getPage, calls };
}
const humans = (n, t0 = Date.parse('2026-09-01T00:00:00Z')) => Array.from({ length: n }, (_, i) => c('bob', 'User', new Date(t0 + i * 60e3).toISOString().replace('.000Z', 'Z')));

test('P1 a 250-comment thread costs ONE request: the computed last page', async () => {
  const all = humans(250);
  const f = fakeThread(all, 100);
  const r = await M.fetchLastCommentAt({ count: 250, selfLogin: ME, getPage: f.getPage, perPage: 100 });
  is(r.at, all[249].created_at);
  is(r.requests, 1);
  is(f.calls.join(','), '3');
});

test('P2 last page all mirror/bot: walks back exactly one page', async () => {
  const all = humans(100).concat([c(ME, 'User', '2026-09-22T20:21:17Z', mirrorBody), c('ci[bot]', 'Bot', '2026-09-22T21:00:00Z')]);
  const f = fakeThread(all, 100);
  const r = await M.fetchLastCommentAt({ count: all.length, selfLogin: ME, getPage: f.getPage, perPage: 100 });
  is(r.at, all[99].created_at);
  is(f.calls.join(','), '2,1');
  is(r.newestAnyAt, '2026-09-22T21:00:00Z');
});

test('P3 a stale-low count is corrected by Link rel="last"', async () => {
  const all = humans(205);
  const f = fakeThread(all, 100);
  const r = await M.fetchLastCommentAt({ count: 150, selfLogin: ME, getPage: f.getPage, perPage: 100 });
  is(r.at, all[204].created_at);
  is(f.calls.join(','), '2,3');
});

test('P4 a mirror-only thread is null after one request (real skills#412 shape)', async () => {
  const f = fakeThread([c(ME, 'User', '2026-09-22T20:21:17Z', mirrorBody)], 100);
  const r = await M.fetchLastCommentAt({ count: 1, selfLogin: ME, getPage: f.getPage });
  is(r.at, null);
  is(r.requests, 1);
});

// ---- the phase: request budget and cache -------------------------------------

function phaseHarness(threads) {
  const calls = { login: 0, pages: [] };
  return {
    calls,
    getLogin: async () => { calls.login++; return ME; },
    getPage: async (rec, p) => { calls.pages.push(`${rec.repo}#${rec.id}:${p}`); return { comments: threads[`${rec.repo}#${rec.id}`] || [], link: null }; },
  };
}

test('B1 cold: zero-comment records cost nothing, others one page, one /user', async () => {
  const records = [
    { repo: 'o/r', id: '1', commentsCount: 0, lastActivityAt: 'A1' },
    { repo: 'o/r', id: '2', commentsCount: 1, lastActivityAt: 'A2' },
    { repo: 'o/r', id: '3', commentsCount: 2, lastActivityAt: 'A3' },
  ];
  const h = phaseHarness({ 'o/r#2': [c(ME, 'User', '2026-09-22T20:21:17Z', mirrorBody)], 'o/r#3': [c('bob', 'User', '2026-09-20T00:00:00Z'), c('x[bot]', 'Bot', '2026-09-21T00:00:00Z')] });
  const cache = { entries: {} };
  const out = await M.lastCommentPhase({ records, cache, getLogin: h.getLogin, getPage: h.getPage });
  is(records.map((r) => r.lastCommentAt).join('|'), '||2026-09-20T00:00:00Z');
  is(records[0].lastCommentAt, null);
  is(records[1].lastCommentAt, null);
  is(h.calls.login, 1);
  is(h.calls.pages.length, 2);
  is(out.stats.zeroComments, 1);
  is(Object.keys(cache.entries).length, 2);
});

test('B2 warm, nothing changed: ZERO requests, values served from cache', async () => {
  const cache = { login: ME, entries: { 'o/r#2': { lastActivityAt: 'A2', commentsCount: 1, login: ME, lastCommentAt: null }, 'o/r#3': { lastActivityAt: 'A3', commentsCount: 2, login: ME, lastCommentAt: '2026-09-20T00:00:00Z' }, 'o/r#9': { lastActivityAt: 'Z', commentsCount: 1, login: ME, lastCommentAt: null } } };
  const records = [{ repo: 'o/r', id: '2', commentsCount: 1, lastActivityAt: 'A2' }, { repo: 'o/r', id: '3', commentsCount: 2, lastActivityAt: 'A3' }];
  const h = phaseHarness({});
  const out = await M.lastCommentPhase({ records, cache, getLogin: h.getLogin, getPage: h.getPage });
  is(h.calls.login + h.calls.pages.length, 0);
  is(records[1].lastCommentAt, '2026-09-20T00:00:00Z');
  is(out.stats.cacheHits, 2);
  ok(!('o/r#9' in cache.entries), 'out-of-window entry pruned');
});

test('B3 a changed lastActivityAt OR commentsCount re-reads only that record', async () => {
  const cache = { login: ME, entries: { 'o/r#2': { lastActivityAt: 'A2', commentsCount: 1, login: ME, lastCommentAt: null }, 'o/r#3': { lastActivityAt: 'A3', commentsCount: 2, login: ME, lastCommentAt: 'x' } } };
  const records = [{ repo: 'o/r', id: '2', commentsCount: 2, lastActivityAt: 'A2' }, { repo: 'o/r', id: '3', commentsCount: 2, lastActivityAt: 'A3' }];
  const h = phaseHarness({ 'o/r#2': [c('bob', 'User', '2026-09-23T10:00:00Z')] });
  await M.lastCommentPhase({ records, cache, getLogin: h.getLogin, getPage: h.getPage });
  is(h.calls.pages.join(','), 'o/r#2:1');
  is(records[0].lastCommentAt, '2026-09-23T10:00:00Z');
});

test('B4 an entry written under another login is not a hit', async () => {
  const cache = { login: 'other', entries: { 'o/r#2': { lastActivityAt: 'A2', commentsCount: 1, login: 'other', lastCommentAt: '2026-09-22T20:21:17Z' }, 'o/r#3': { lastActivityAt: 'OLD', commentsCount: 1, login: 'other', lastCommentAt: null } } };
  const records = [{ repo: 'o/r', id: '2', commentsCount: 1, lastActivityAt: 'A2' }, { repo: 'o/r', id: '3', commentsCount: 1, lastActivityAt: 'A3' }];
  const h = phaseHarness({ 'o/r#2': [c(ME, 'User', '2026-09-22T20:21:17Z', mirrorBody)], 'o/r#3': [] });
  const out = await M.lastCommentPhase({ records, cache, getLogin: h.getLogin, getPage: h.getPage });
  is(records[0].lastCommentAt, null);
  is(out.stats.invalidatedByLogin, 1);
});

test('B5 a failed read or failed /user leaves the field ABSENT, never null', async () => {
  const records = [{ repo: 'o/r', id: '2', commentsCount: 1, lastActivityAt: 'A2' }];
  const out = await M.lastCommentPhase({ records, cache: { entries: {} }, getLogin: async () => ME, getPage: async () => { throw new Error('HTTP 502'); } });
  ok(!('lastCommentAt' in records[0]));
  is(out.stats.failed, 1);
  const records2 = [{ repo: 'o/r', id: '2', commentsCount: 1, lastActivityAt: 'A2' }];
  const out2 = await M.lastCommentPhase({ records: records2, cache: { entries: {} }, getLogin: async () => { throw new Error('401'); }, getPage: async () => ({ comments: [], link: null }) });
  ok(!('lastCommentAt' in records2[0]));
  ok(out2.stats.loginError);
});
