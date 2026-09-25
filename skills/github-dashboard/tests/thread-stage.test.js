/* The thread-derived stage rule (operator, 2026-09-25): an open issue whose
   linked bb thread has SETTLED goes to needs-attention ("thread settled"),
   and stalls after ISSUE_STALL_AFTER_WORKING_DAYS working days since it
   settled. Busy stays active, pending interaction stays stage 3, archived
   stays on the working-stage clock, PRs are untouched.

   Runs against the BUILT PANEL: cuts GHD-CLASSIFY (categorize plus the
   embedded THREAD-STAGE block) out of github-dashboard.shtml and evaluates it.
   Against the pre-2026-09-25 panel every settled case reads 'active', and the
   rule functions are absent: red on assertions, not on a crash.

     cd skills/github-dashboard && tst tests/thread-stage.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/thread-stage.test.js */
const { default: test, is, ok } = require('tst');
const { panelApi, recThread, record, H, iso } = require('./thread-helpers.js');

let API = null;
const api = () => (API = API || panelApi());
const cat = (item, now) => api().categorize(item, now);

// Friday 2026-10-02 12:00Z.
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const settledIssue = (thOver, over) => record({ stage: 2, lastActivityAt: iso(NOW - 3 * 24 * H), thread: recThread({ updatedAt: iso(NOW - 30 * 60000), ...thOver }), ...over });

test('T1 settled (live, idle, nothing queued or pending) -> needs-attention, "thread settled"', () => {
  const r = cat(settledIssue({}), NOW);
  is(r.category, 'needs-attention');
  ok(/^thread settled\b/.test(r.reason), `reason: ${r.reason}`);
});

test('T2 status=error is settled too', () => {
  const r = cat(settledIssue({ state: 'error' }), NOW);
  is(r.category, 'needs-attention');
  ok(/^thread settled\b/.test(r.reason), `reason: ${r.reason}`);
});

test('T3 busy stays ACTIVE; the SUMMARY\'s busy is the only busy input (decided once, from RAW)', () => {
  is(cat(record({ stage: 4, lastActivityAt: iso(NOW - H), thread: recThread({ busy: true, state: 'active' }) }), NOW).category, 'active', 'stage 4, busy');
  // Queued work reaches the summary as busy:true (threadIsBusy on the RAW thread).
  is(cat(settledIssue({ busy: true, queuedWork: 'waiting' }, { lastActivityAt: iso(NOW - H) }), NOW).category, 'active', 'stage 2 snapshot, busy (queued)');
  // Contract: the rule never re-derives busy from state/queuedWork on a summary.
  // A summary saying busy:false IS settled; getting busy right is the job of
  // the code that reads RAW (thread-poll.jsh, the fetcher's link builder).
  is(cat(settledIssue({ state: 'active', busy: false }), NOW).category, 'needs-attention', 'busy:false is trusted');
  const f = api().threadStateOf;
  ok(typeof f === 'function', 'threadStateOf (RAW -> SUMMARY) is in the panel copy');
  if (f) {
    const raw = { id: 'thr_example01', status: 'active', archivedAt: null, deletedAt: null, queuedWork: 'none', activity: {}, hasPendingInteraction: false, updatedAt: NOW };
    is(f(raw).busy, true, 'RAW status "active" -> busy:true in the summary');
    is(f({ ...raw, status: 'idle', queuedWork: 'waiting' }).busy, true, 'RAW queued -> busy:true');
    is(f({ ...raw, status: 'idle', activity: { activeGoalCount: 1 } }).busy, true, 'RAW active goal -> busy:true');
    is(f({ ...raw, status: 'error' }).busy, false, 'RAW error -> not busy');
    is(f({ ...raw, archivedAt: NOW }).live, false, 'RAW archived -> live:false');
  }
});

test('T4 pending interaction stays stage 3 -> needs-attention "thread wants guidance"', () => {
  const r = cat(record({ stage: 3, thread: recThread({ hasPendingInteraction: true }) }), NOW);
  is(r.category, 'needs-attention');
  is(r.reason, 'thread wants guidance');
});

test('T5 archived-only is unchanged: stage 2 on the six-hour working clock', () => {
  const arch = (idleH) => record({ stage: 2, lastActivityAt: iso(NOW - idleH * H), thread: recThread({ archived: true, live: false, updatedAt: iso(NOW - idleH * H) }) });
  is(cat(arch(2), NOW).category, 'active', 'idle 2 h');
  is(cat(arch(7), NOW).category, 'stalled', 'idle 7 h > 6 h');
  const deleted = record({ stage: 2, lastActivityAt: iso(NOW - 2 * H), thread: recThread({ live: false, archived: false }) });
  is(cat(deleted, NOW).category, 'active', 'deleted (live:false) is not settled either');
});

test('T6 PRs are untouched: a settled thread on a PR in review or with failing CI keeps the PR clock', () => {
  const pr = (stage, substage, idleH) => record({ kind: 'pr', stage, substage, lastActivityAt: iso(NOW - idleH * H), thread: recThread({}) });
  is(cat(pr(6, undefined, 2), NOW).category, 'active', 'in review, 2 h');
  is(cat(pr(5, '5a', 2), NOW).category, 'active', 'CI failing, 2 h');
  is(cat(pr(5, '5a', 7), NOW).category, 'stalled', 'CI failing, 7 h');
});

test('T7 precedence: done and snooze still win over a settled thread; closed issues are done', () => {
  is(cat(settledIssue({}, { doneAt: iso(NOW - H) }), NOW).category, 'done', 'marked done');
  is(cat(settledIssue({}, { snoozedAt: iso(NOW - H), snoozedUntil: iso(NOW + 24 * H), snoozeCount: 0 }), NOW).category, 'snoozed', 'snoozed');
  is(cat(settledIssue({}, { stage: 11, lastActivityAt: iso(NOW - H) }), NOW).category, 'done', 'closed issue');
});

test('T8 stall clock: 4.0 working days since settling -> needs-attention; 5.04 -> stalled', () => {
  const at = (since) => settledIssue({ updatedAt: since }, { lastActivityAt: since });
  const four = cat(at('2026-09-28T12:00:00.000Z'), NOW);
  is(four.category, 'needs-attention');
  ok(/4\.0 of 5 working days/.test(four.reason), four.reason);
  const five = cat(at('2026-09-25T11:00:00.000Z'), NOW);
  is(five.category, 'stalled');
  ok(/^thread settled 5\.0 working days ago \(limit 5\)$/.test(five.reason), five.reason);
});

test('T9 stall clock: weekends do not count', () => {
  const r = settledIssue({ updatedAt: '2026-09-25T18:00:00.000Z' }, { lastActivityAt: '2026-09-25T18:00:00.000Z' });
  const mon = Date.parse('2026-09-28T18:00:00.000Z');
  ok(/1\.0 of 5/.test(cat(r, mon).reason), `Fri 18:00 -> Mon 18:00 is 1.0 working day: ${cat(r, mon).reason}`);
});

test('T10 stall clock starts at the LATER of thread.updatedAt and lastActivityAt', () => {
  const old = '2026-09-21T09:00:00.000Z'; // 9+ working days before NOW
  const recent = '2026-09-30T12:00:00.000Z'; // 2 working days
  is(cat(settledIssue({ updatedAt: old }, { lastActivityAt: recent }), NOW).category, 'needs-attention', 'activity after the thread settled resets the clock');
  is(cat(settledIssue({ updatedAt: recent }, { lastActivityAt: old }), NOW).category, 'needs-attention', 'thread settled later than the last activity');
  is(cat(settledIssue({ updatedAt: old }, { lastActivityAt: old }), NOW).category, 'stalled', 'both old');
  is(cat(settledIssue({ updatedAt: null }, { lastActivityAt: old }), NOW).category, 'stalled', 'no thread.updatedAt: lastActivityAt alone');
  const since = api().threadSettledSince;
  ok(typeof since === 'function', 'threadSettledSince is in the panel');
  if (since) is(since(settledIssue({ updatedAt: old }, { lastActivityAt: recent })), recent);
});

test('T11 stageFromThread (the panel copy): open issue -> 3 / 4 / 2 settled / 2 archived; PR and non-stage-1 -> null', () => {
  const f = api().stageFromThread;
  ok(typeof f === 'function', 'stageFromThread is in the panel');
  if (!f) return;
  const issue = { kind: 'issue', stage: 1 };
  is(f(issue, recThread({ hasPendingInteraction: true })).stage, 3, 'pending');
  is(f(issue, recThread({ hasPendingInteraction: true, busy: true })).stage, 3, 'pending beats busy');
  is(f(issue, recThread({ busy: true })).stage, 4, 'busy');
  is(f(issue, recThread({ busy: true, state: 'active' })).stage, 4, 'busy, status active');
  is(f(issue, recThread({ busy: true, queuedWork: 'waiting' })).stage, 4, 'busy, queued');
  is(f(issue, recThread({ archived: true, live: false, state: 'error' })).stage, 2, 'archived + error (slicc#3482 shape): archived path, not live');
  ok(/archived/.test(f(issue, recThread({ archived: true, live: false, state: 'error' })).why), 'and its why says archived, with the real status');
  ok(/status=error/.test(f(issue, recThread({ archived: true, live: false, state: 'error' })).why), 'status=error, not status=undefined');
  const s = f(issue, recThread({}));
  is(s.stage, 2, 'settled: stage 2');
  is(s.settled, true, 'settled: flagged');
  ok(/settled/.test(s.why), `why: ${s.why}`);
  is(f(issue, recThread({ state: 'error' })).settled, true, 'error settled');
  const a = f(issue, recThread({ archived: true, live: false, hasPendingInteraction: true }));
  is(a.stage, 2, 'archived: 2 even with a stale pending flag');
  ok(!a.settled, 'archived is not settled');
  is(f({ kind: 'pr', stage: 1 }, recThread({})), null, 'PR');
  is(f({ kind: 'issue', stage: 11 }, recThread({})), null, 'closed issue');
  is(f(issue, null), null, 'no thread');
});
