import test, { is, ok, throws } from 'tst';

// The mirror's own comment (and bot comments) must not leak into ANY
// comment-derived field. Evaluates the FENCED block of the fetcher named by
// GHD_FETCHER (default: the staged copy), so the shipped text is what is tested.
// A function the file does not define becomes a stub that throws, so each test
// goes red on its own instead of the whole file failing to load.
const fs = require('fs');
const FILE = (process.env && process.env.GHD_FETCHER) ||
  ['../scripts/fetch-snapshot.mjs', '../fetch-snapshot.mjs']
    .map((p) => new URL(p, import.meta.url).pathname)
    .find((p) => fs.existsSync(p)) ||
  (() => { throw new Error('fetch-snapshot.mjs not found; set GHD_FETCHER'); })();
const src = fs.readFileSync(FILE, 'utf8');
const a = src.indexOf('/* ---- 8< lastComment');
const b = src.indexOf('/* ---- >8 end lastComment');
if (a < 0 || b < a) throw new Error(`fence markers not found in ${FILE}`);
const NAMES = ['commentCounts', 'lastCommentPhase', 'counterFromTimeline', 'activityWithoutExcluded', 'commentFromGraphql', 'excludedSummary'];
const M = new Function(
  src.slice(a, b) + '\nreturn {' + NAMES.map((n) => `${n}: typeof ${n} === 'function' ? ${n} : null`).join(', ') + '};',
)();
for (const n of NAMES) if (!M[n]) M[n] = () => { throw new Error(`${n} is not defined in ${FILE}`); };

const ME = 'octocat';
const MARK = '<!-- ghd-mirror:v1 -->';
const mirrorBody = `${MARK}\n**Filed on my dashboard**\n\n- Snoozed until 2026-09-26\n`;
const CREATED = '2026-09-19T10:00:00Z';
// REST comment and GraphQL timeline node builders.
const rc = (login, type, created_at, body = 'hello', updated_at = created_at, id) => ({ id, user: { login, type }, created_at, updated_at, body });
const gc = (login, typename, createdAt, body = 'hello') => ({ __typename: 'IssueComment', createdAt, body, author: { login, __typename: typename } });
const label = (createdAt) => ({ __typename: 'LabeledEvent', createdAt });
const timeline = (nodes, totalCount = nodes.length) => M.counterFromTimeline({ nodes, totalCount, createdAt: CREATED, selfLogin: ME, maxComments: 3, commentChars: 400 });
const MIRROR_AT = '2026-09-22T20:21:17Z'; // real skills#412 comment 5783527662

async function phaseOn(thread, count = thread.length) {
  const records = [{ repo: 'o/r', id: '1', commentsCount: count, lastActivityAt: MIRROR_AT }];
  const out = await M.lastCommentPhase({ records, cache: { entries: {} }, getLogin: async () => ME, getPage: async () => ({ comments: thread, link: null }) });
  return { rec: records[0], out };
}

// ---- a record whose only recent comment is the mirror's -----------------------

test('X1 stall counter: the mirror comment does not reset it (a label before it does)', () => {
  const c = timeline([label('2026-09-20T08:00:00Z'), gc(ME, 'User', MIRROR_AT, mirrorBody)]);
  is(c.resetAt, '2026-09-20T08:00:00Z');
  is(c.resetBy, 'LabeledEvent');
  is(c.qualifyingCount, 1);
});

test('X1b stall counter: mirror-only timeline (real skills#412 shape) counts from creation', () => {
  const c = timeline([gc(ME, 'User', MIRROR_AT, mirrorBody)]);
  is(c.resetAt, CREATED);
  is(c.resetBy, 'IssueCreated');
});

test('X2 activity: an updated_at bumped by the mirror post does not make the item look newly active', () => {
  const r = M.activityWithoutExcluded({ raw: MIRROR_AT, updatedAt: MIRROR_AT, excludedLatestAt: MIRROR_AT, others: [CREATED] });
  is(r.at, CREATED);
  is(r.adjusted, true);
});

test('X2b activity: the phase reports the mirror instant that explains the bump', async () => {
  const { out } = await phaseOn([rc(ME, 'User', MIRROR_AT, mirrorBody, MIRROR_AT, 5783527662)]);
  is(out.excludedAt['o/r#1'], MIRROR_AT);
});

test('X2c activity: a mirror EDIT (PATCH) is attributed too, via the comment updated_at', () => {
  const edited = M.excludedSummary([rc(ME, 'User', MIRROR_AT, mirrorBody, '2026-09-24T09:00:00Z')], ME);
  is(edited.excludedLatestAt, '2026-09-24T09:00:00Z');
  const r = M.activityWithoutExcluded({ raw: '2026-09-24T09:00:01Z', updatedAt: '2026-09-24T09:00:01Z', excludedLatestAt: edited.excludedLatestAt, others: [CREATED, '2026-09-21T00:00:00Z'] });
  is(r.at, '2026-09-21T00:00:00Z');
});

test('X3 commentsCount: the mirror is not counted; commentsTotal keeps the raw GitHub count', async () => {
  const { rec } = await phaseOn([rc(ME, 'User', MIRROR_AT, mirrorBody, MIRROR_AT, 1)]);
  is(rec.commentsCount, 0);
  is(rec.commentsTotal, 1);
});

test('X4 recentComments: the mirror text is never handed to the model', () => {
  const c = timeline([gc('bob', 'User', '2026-09-21T10:00:00Z', 'real question'), gc(ME, 'User', MIRROR_AT, mirrorBody)]);
  is(c.recentComments.length, 1);
  ok(!c.recentComments.some((x) => x.text.includes(MARK)), 'no marker text in recentComments');
  is(c.recentComments[0].text, 'real question');
});

// ---- controls -----------------------------------------------------------------

test('C1 a human comment still counts everywhere (counter, model text, count, activity)', async () => {
  const c = timeline([label('2026-09-20T08:00:00Z'), gc(ME, 'User', '2026-09-22T11:00:00Z', 'my own ordinary comment')]);
  is(c.resetAt, '2026-09-22T11:00:00Z');
  is(c.recentComments.length, 1);
  const { rec, out } = await phaseOn([rc(ME, 'User', '2026-09-22T11:00:00Z', 'my own ordinary comment', undefined, 1)]);
  is(rec.commentsCount, 1);
  is(out.excludedAt['o/r#1'], null);
  is(M.activityWithoutExcluded({ raw: '2026-09-22T11:00:00Z', updatedAt: '2026-09-22T11:00:00Z', excludedLatestAt: null, others: [CREATED] }).at, '2026-09-22T11:00:00Z');
});

test('C2 the marker from a DIFFERENT author still counts everywhere', async () => {
  const c = timeline([gc('mallory', 'User', MIRROR_AT, mirrorBody)]);
  is(c.resetAt, MIRROR_AT);
  is(c.recentComments.length, 1);
  const { rec, out } = await phaseOn([rc('mallory', 'User', MIRROR_AT, mirrorBody, MIRROR_AT, 1)]);
  is(rec.commentsCount, 1);
  is(out.excludedAt['o/r#1'], null);
});

test('C3 a Bot comment is excluded everywhere (GraphQL __typename Bot, REST user.type Bot)', async () => {
  const c = timeline([label('2026-09-20T08:00:00Z'), gc('github-actions', 'Bot', '2026-09-23T09:00:00Z', 'Released in v6.180.0')]);
  is(c.resetAt, '2026-09-20T08:00:00Z');
  is(c.recentComments.length, 0);
  const { rec } = await phaseOn([rc('github-actions[bot]', 'Bot', '2026-09-23T09:00:00Z', 'Released', undefined, 1), rc('bob', 'User', '2026-09-21T00:00:00Z', 'hi', undefined, 2)]);
  is(rec.commentsCount, 1);
  is(rec.commentsTotal, 2);
});

// ---- fail-safe and edges --------------------------------------------------------

test('F1 no identity: the timeline counter refuses rather than count the mirror', () => {
  let msg = '';
  try { M.counterFromTimeline({ nodes: [gc(ME, 'User', MIRROR_AT, mirrorBody)], totalCount: 1, createdAt: CREATED, selfLogin: '', maxComments: 3, commentChars: 400 }); } catch (e) { msg = String(e.message); }
  // Must be the login refusal itself, not any throw (a missing function also throws).
  ok(/authenticated login is required/.test(msg), 'refused for lack of login: ' + msg);
});

test('F2 every event in the 20-event window excluded, older ones exist: counter UNDETERMINED', () => {
  const nodes = Array.from({ length: 20 }, (_, i) => gc('x', 'Bot', `2026-09-2${Math.floor(i / 10)}T0${i % 10}:00:00Z`));
  const c = timeline(nodes, 25);
  is(c.resetAt, undefined);
  is(c.resetBy, undefined);
});

test('F3 activity: unknown exclusion data or later real activity keeps the raw value', () => {
  is(M.activityWithoutExcluded({ raw: MIRROR_AT, updatedAt: MIRROR_AT, excludedLatestAt: undefined, others: [CREATED] }).at, MIRROR_AT);
  is(M.activityWithoutExcluded({ raw: '2026-09-23T12:00:00Z', updatedAt: '2026-09-23T12:00:00Z', excludedLatestAt: MIRROR_AT, others: [CREATED] }).at, '2026-09-23T12:00:00Z');
  // CI after the mirror post: raw already reflects it, nothing to correct.
  is(M.activityWithoutExcluded({ raw: '2026-09-23T11:58:28Z', updatedAt: MIRROR_AT, excludedLatestAt: MIRROR_AT, others: ['2026-09-23T11:58:28Z'] }).adjusted, false);
});

test('N1 nothing excluded: counter output equals the previous inline algorithm', () => {
  const nodes = [label('2026-09-10T00:00:00Z'), gc('bob', 'User', '2026-09-11T00:00:00Z', 'one'), gc('amy', 'User', '2026-09-12T00:00:00Z', 'two'), { __typename: 'AssignedEvent', createdAt: '2026-09-13T00:00:00Z' }];
  // previous inline code, verbatim in substance
  const evs = nodes.map((e) => ({ type: e.__typename, at: e.createdAt, body: e.body || null }));
  const latest = evs.reduce((m, e) => (m && m.at >= e.at ? m : e), null);
  const oldRecent = evs.slice(-5).filter((e) => e.type === 'IssueComment' && e.body).slice(-3).map((e) => ({ at: e.at, text: String(e.body).slice(0, 400) }));
  const c = timeline(nodes, 4);
  is(c.resetAt, latest.at);
  is(c.resetBy, latest.type);
  is(c.qualifyingCount, 4);
  is(JSON.stringify(c.recentComments), JSON.stringify(oldRecent));
});

test('K1 cache: a v1 entry (no exclusion counts) is re-read once; a v2 entry serves commentsCount with no request', async () => {
  let pages = 0;
  const getPage = async () => { pages++; return { comments: [rc(ME, 'User', MIRROR_AT, mirrorBody, MIRROR_AT, 1)], link: null }; };
  const cache = { login: ME, entries: { 'o/r#1': { lastActivityAt: MIRROR_AT, commentsCount: 1, login: ME, lastCommentAt: null } } };
  const r1 = [{ repo: 'o/r', id: '1', commentsCount: 1, lastActivityAt: MIRROR_AT }];
  await M.lastCommentPhase({ records: r1, cache, getLogin: async () => ME, getPage });
  is(pages, 1);
  is(cache.entries['o/r#1'].v, 2);
  const r2 = [{ repo: 'o/r', id: '1', commentsCount: 1, lastActivityAt: MIRROR_AT }];
  const out = await M.lastCommentPhase({ records: r2, cache, getLogin: async () => ME, getPage });
  is(pages, 1);
  is(r2[0].commentsCount, 0);
  is(out.excludedAt['o/r#1'], MIRROR_AT);
});

test('S1 ONE predicate: the marker rule is written once in the whole fetcher', () => {
  // The marker is read in exactly one place (commentCounts) besides its definition,
  // the bot rule is written once, and every new field reaches it via commentCounts.
  is(src.split('GHD_MIRROR_MARKER').length - 1, 2);
  is(src.split("if (user && user.type === 'Bot') return false;").length - 1, 1);
  const fence = src.slice(a, b);
  for (const fn of ['excludedSummary', 'counterFromTimeline']) {
    const at = fence.indexOf('function ' + fn + '(');
    ok(at >= 0 && fence.slice(at, fence.indexOf('\n}\n', at)).includes('commentCounts('), fn + ' uses commentCounts');
  }
});
