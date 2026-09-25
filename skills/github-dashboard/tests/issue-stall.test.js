/* Issue stall rule (2026-09-25): a comment RESETS the five-working-day clock of
   an open stage-1 issue with no thread and no closing PR; it does not exempt it.

   Runs against the BUILT PANEL: cuts the GHD-CLASSIFY region (categorize() and
   every helper it uses) out of github-dashboard.shtml and evaluates it.

     cd <dir holding tests/> && tst tests/issue-stall.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/issue-stall.test.js

   Builtin `tst` runner (node:test is not available here). */
const fs = require('fs');
const { default: test, is, ok } = require('tst');

function panelPath() {
  if (process.env.GHD_PANEL) return process.env.GHD_PANEL;
  for (const p of [__dirname + '/../github-dashboard.shtml', __dirname + '/../assets/sprinkle/github-dashboard.shtml']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('github-dashboard.shtml not found; set GHD_PANEL');
}

let API = null;
function api() {
  if (API) return API;
  const s = fs.readFileSync(panelPath(), 'utf8');
  const a = s.indexOf('GHD-CLASSIFY:START');
  const b = s.indexOf('GHD-CLASSIFY:END');
  if (a < 0 || b < 0 || b < a) throw new Error('panel has no GHD-CLASSIFY region');
  const code = s.slice(s.lastIndexOf('/*', a), s.lastIndexOf('\n', b));
  // whenLabel (in the region) calls fmtHours from GHD-FMT; not needed here, so a stub.
  API = new Function('let META = null; function fmtHours(h) { return String(h); }\n' + code +
    '\nreturn { categorize, workingDaysSince, ISSUE_STALL_AFTER_WORKING_DAYS };')();
  if (typeof API.categorize !== 'function') throw new Error('categorize() not found in the GHD-CLASSIFY region');
  return API;
}

// The live snapshot's generatedAt: Friday 2026-09-25 12:18:14Z.
const NOW = Date.parse('2026-09-25T12:18:14.441Z');
const FRI_NOON = Date.parse('2026-09-25T12:00:00.000Z');

// ai-ecoverse/skills#360 exactly as the live snapshot carries it (classification fields).
const SKILLS_360 = {
  id: '360', repo: 'ai-ecoverse/skills', kind: 'issue', stage: 1, labels: ['enhancement', 'cosmos-skipped'],
  openedAt: '2026-09-08T15:05:54Z', lastActivityAt: '2026-09-09T09:05:58Z', stateReason: 'open',
  commentsCount: 1, commentsTotal: 2, lastCommentAt: '2026-09-08T15:31:59Z',
  counterResetAt: '2026-09-09T09:05:58Z', counterResetBy: 'LabeledEvent', counterQualifyingEvents: 3,
};
const issue = (over) => ({ id: '1', repo: 'o/r', kind: 'issue', stage: 1, labels: [], openedAt: '2026-09-01T00:00:00Z', commentsCount: 0, ...over });
const cat = (item, now) => api().categorize(item, now).category;

test('skills#360 (1 comment, counter 12.1 working days ago) is STALLED', () => {
  const wd = api().workingDaysSince(SKILLS_360.counterResetAt, NOW);
  ok(wd > 12 && wd < 12.2, `counter age ${wd.toFixed(2)} working days`);
  is(cat(SKILLS_360, NOW), 'stalled');
});

test('a commented issue whose counter is 2 working days old is still needs-attention', () => {
  const it = issue({ commentsCount: 3, lastCommentAt: '2026-09-23T12:18:14Z', counterResetAt: '2026-09-23T12:18:14Z', lastActivityAt: '2026-09-23T12:18:14Z' });
  is(api().workingDaysSince(it.counterResetAt, NOW).toFixed(3), '2.000');
  is(cat(it, NOW), 'needs-attention');
});

test('zero comments: unchanged either side of 5 working days (>= 5 stalls)', () => {
  const at = (iso) => issue({ counterResetAt: iso, lastActivityAt: iso });
  // Fri 2026-09-18 12:00Z -> Fri 2026-09-25 12:00Z is exactly 5 working days.
  is(cat(at('2026-09-18T14:24:00Z'), FRI_NOON), 'needs-attention', '4.9 wd');
  is(cat(at('2026-09-18T12:00:00Z'), FRI_NOON), 'stalled', '5.0 wd');
  is(cat(at('2026-09-18T09:36:00Z'), FRI_NOON), 'stalled', '5.1 wd');
});

test('an issue WITH a thread is not touched by this rule', () => {
  const it = { ...SKILLS_360, thread: { id: 't1', title: 'x' } };
  ok(cat(it, NOW) !== 'stalled', 'not stalled by the issue rule');
  is(cat(it, NOW), 'needs-attention');
});

test('an issue with a closing PR is not touched by this rule', () => {
  is(cat({ ...SKILLS_360, hasClosingPr: true }, NOW), 'needs-attention');
});

test('a snoozed issue stays snoozed (snooze beats stalled)', () => {
  const it = { ...SKILLS_360, snoozedAt: '2026-09-24T08:00:00Z', snoozedUntil: '2026-09-29T08:00:00Z', snoozeCount: 1 };
  is(cat(it, NOW), 'snoozed');
});

test('the counter, not the comment count, decides: 1 comment at 4.9 wd waits, at 5.1 wd stalls', () => {
  const at = (iso) => issue({ commentsCount: 1, lastCommentAt: iso, counterResetAt: iso, lastActivityAt: iso });
  is(cat(at('2026-09-18T14:24:00Z'), FRI_NOON), 'needs-attention');
  is(cat(at('2026-09-18T09:36:00Z'), FRI_NOON), 'stalled');
});
