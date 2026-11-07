import test, { is, ok } from 'tst';

/* Owner's rule, 2026-09-28: "if a bb thread has the agent waiting, asking
   questions with a tool, then this absolutely needs attention. and if the bb
   thread has been waiting too long, then that's stalled".

     W1-W2  an OPEN PR whose linked live bb thread has a pending interaction:
            needs attention (glyph stage 3), then stalled after
            ISSUE_STALL_AFTER_WORKING_DAYS working days from bb latestAttentionAt;
     W3-W4  everything else about PRs is unchanged: busy / settled / archived
            threads, merged and closed PRs;
     W5     issues are unchanged;
     W6     precedence against the done mark, an applied report and a snooze;
     W7-W8  the clock travels: threadStateOf / THREAD_STATE_FIELDS (thread-poll,
            threads.json overlay) and the fetcher's own summary (threadRef).

   Runs against the BUILT panel's GHD-CLASSIFY region and the module's text.
     cd skills/github-dashboard && tst tests/pr-thread-wait.test.js
   Fake ids only: thr_example01, proj_example01, octocat/Hello-World. */
const { fs, paths, panelModule, fnBody, sharedModule, recThread, record, H, iso } =
  require('./thread-helpers.js');

function region(src, name) {
  const a = src.indexOf(`GHD-${name}:START`);
  const b = src.indexOf(`GHD-${name}:END`);
  if (a < 0 || b < 0 || b < a) throw new Error(`panel has no GHD-${name} region`);
  return src.slice(src.lastIndexOf('/*', a), src.lastIndexOf('\n', b));
}

// Wednesday 2026-09-30 12:00Z.
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const PANEL = (() => {
  const src = fs.readFileSync(paths.panel(), 'utf8');
  const stateOf = fnBody(panelModule(), 'stateOf');
  const names = ['categorize', 'ISSUE_STALL_AFTER_WORKING_DAYS', 'overlayThreadState', 'STATE'];
  const ret = `{ ${names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')}, stateOf: typeof stateOf === 'undefined' ? undefined : stateOf }`;
  return new Function(
    `let META = null;\n${region(src, 'CLASSIFY')}\n${region(src, 'FMT')}\nlet PASS_NOW = ${NOW};\n` +
      `function stateOf(item) ${stateOf}\nreturn ${ret};`
  )();
})();
const M = sharedModule();
const cat = (r) => PANEL.categorize(r, NOW);

const REPO = 'octocat/Hello-World';
const pending = (over) =>
  recThread({
    id: 'thr_example01',
    state: 'idle',
    hasPendingInteraction: true,
    updatedAt: iso(NOW - 1 * H),
    attentionAt: iso(NOW - 2 * H),
    ...over,
  });
const pr = (over) =>
  record({
    repo: REPO,
    id: '57',
    kind: 'pr',
    stage: 6,
    url: `https://github.com/${REPO}/pull/57`,
    lastActivityAt: iso(NOW - 3 * H),
    stateReason: 'open',
    ...over,
  });

test('W1 an open PR whose bb thread waits on an answer -> Needs attention, glyph stage 3, reason names the thread', () => {
  const r = pr({ thread: pending() });
  const c = cat(r);
  is(c.category, 'needs-attention');
  ok(/^bb thread thr_example01 is waiting on an answer\b/.test(c.reason), c.reason);
  is(cat(pr()).category, 'active', 'the same PR without the thread: in review, active');
  const w = typeof M.prThreadWaiting === 'function' ? M.prThreadWaiting(r) : null;
  ok(w && w.stage === 3 && w.threadId === 'thr_example01', 'prThreadWaiting: stage 3, the thread');
  ok(
    typeof PANEL.stateOf === 'function' && PANEL.stateOf(r) === PANEL.STATE[3],
    'the card reads "needs guidance"'
  );
  is(r.stage, 6, 'the GitHub stage stays on the record');
  for (const stage of [5, 7, 8])
    is(cat(pr({ stage, thread: pending() })).category, 'needs-attention', `stage ${stage}`);
  is(
    cat(pr({ substage: '6b', thread: pending() })).category,
    'needs-attention',
    'changes requested too'
  );
});

test('W2 waiting past ISSUE_STALL_AFTER_WORKING_DAYS (from latestAttentionAt) -> Stalled', () => {
  is(PANEL.ISSUE_STALL_AFTER_WORKING_DAYS, 5, 'the existing limit, reused');
  // Wed 2026-09-23 12:00Z is exactly 5.0 working days before NOW; 09-24 is 4.0.
  const at = (a) => pr({ thread: pending({ attentionAt: a }) });
  is(cat(at('2026-09-24T12:00:00.000Z')).category, 'needs-attention', '4.0 working days');
  const c5 = cat(at('2026-09-23T12:00:00.000Z'));
  is(c5.category, 'stalled', '5.0 working days: stalled (>= limit, as a settled issue)');
  ok(
    /^bb thread thr_example01 waiting on an answer 5\.0 working days \(limit 5\)$/.test(c5.reason),
    c5.reason
  );
  is(cat(at('2026-09-22T12:00:00.000Z')).category, 'stalled', '6.0 working days');
  // updatedAt is not the clock: reading the thread moves it, the wait does not end.
  is(
    cat(
      pr({
        thread: pending({ attentionAt: '2026-09-22T12:00:00.000Z', updatedAt: iso(NOW - 60000) }),
      })
    ).category,
    'stalled',
    'fresh updatedAt, old attentionAt: stalled'
  );
  // A summary written before attentionAt existed falls back to updatedAt.
  is(
    cat(pr({ thread: pending({ attentionAt: undefined, updatedAt: '2026-09-22T12:00:00.000Z' }) }))
      .category,
    'stalled',
    'fallback: updatedAt'
  );
  is(
    cat(pr({ thread: pending({ attentionAt: undefined, updatedAt: iso(NOW - 1 * H) }) })).category,
    'needs-attention'
  );
});

test('W3 busy, settled or archived thread: the PR keeps its GitHub-driven category exactly', () => {
  const same = (thread, why) => {
    const a = cat(pr({ thread }));
    const b = cat(pr());
    is(JSON.stringify(a), JSON.stringify(b), why);
  };
  same(recThread({ id: 'thr_example01', state: 'idle', busy: false }), 'settled thread');
  same(recThread({ id: 'thr_example01', state: 'active', busy: true }), 'busy thread');
  same(
    recThread({ id: 'thr_example01', archived: true, live: false, hasPendingInteraction: true }),
    'archived, stale pending flag'
  );
  is(M.prThreadWaiting(pr({ thread: recThread({ busy: true }) })), null);
  is(M.prThreadWaiting(pr()), null, 'no thread');
});

test('W4 merged and closed PRs with a waiting thread: unchanged', () => {
  const merged = pr({
    stage: 9,
    mergedAt: iso(NOW - 5 * H),
    stateReason: 'merged',
    lastActivityAt: iso(NOW - 5 * H),
  });
  is(
    JSON.stringify(cat({ ...merged, thread: pending() })),
    JSON.stringify(cat(merged)),
    'merged, awaiting release'
  );
  is(cat({ ...merged, thread: pending() }).category, 'snoozed');
  const released = pr({
    stage: 10,
    mergedAt: iso(NOW - 5 * H),
    stateReason: 'merged',
    lastActivityAt: iso(NOW - 5 * H),
  });
  is(cat({ ...released, thread: pending() }).category, 'done', 'released');
  const closed = pr({
    stage: 11,
    stateReason: 'closed_unmerged',
    lastActivityAt: iso(NOW - 5 * H),
  });
  is(cat({ ...closed, thread: pending() }).category, 'done', 'closed unmerged');
  is(M.prThreadWaiting({ ...merged, thread: pending() }), null);
  is(
    M.prThreadWaiting(pr({ stage: 6, mergedAt: iso(NOW - 1 * H), thread: pending() })),
    null,
    'a mergedAt alone'
  );
});

test('W5 issues: a pending thread is stage 3 "thread wants guidance", and stalls after 5 working days (cone, 2026-09-28)', () => {
  const issue = record({
    repo: REPO,
    id: '42',
    kind: 'issue',
    stage: 1,
    lastActivityAt: iso(NOW - 3 * H),
  });
  const th = pending({ attentionAt: '2026-09-15T12:00:00.000Z' });
  const promoted = M.stageFromThread(issue, th);
  is(promoted.stage, 3);
  is(cat({ ...issue, stage: 3, thread: th }).category, 'stalled', '11 working days: stalled');
  const at = (a) => cat({ ...issue, stage: 3, thread: pending({ attentionAt: a }) });
  const fresh = at('2026-09-24T12:00:00.000Z');
  is(fresh.category, 'needs-attention', '4.0 working days');
  is(fresh.reason, 'thread wants guidance', 'the existing issue reason until it stalls');
  is(at('2026-09-23T18:00:00.000Z').category, 'needs-attention', '4.75 working days');
  const c5 = at('2026-09-23T12:00:00.000Z');
  is(c5.category, 'stalled', '5.0 working days: stalled');
  ok(
    /^bb thread thr_example01 waiting on an answer 5\.0 working days \(limit 5\)$/.test(c5.reason),
    c5.reason
  );
  is(
    cat({
      ...issue,
      stage: 3,
      thread: pending({ attentionAt: undefined, updatedAt: '2026-09-22T12:00:00.000Z' }),
    }).category,
    'stalled',
    'fallback: updatedAt'
  );
  is(M.threadWaiting({ ...issue, stage: 3, thread: th }).kind, 'issue');
  is(M.threadWaiting({ ...issue, stage: 11, thread: th }), null, 'a closed issue: no');
  const settled = recThread({
    id: 'thr_example01',
    state: 'idle',
    busy: false,
    updatedAt: iso(NOW - 1 * H),
  });
  is(
    cat({ ...issue, stage: 2, thread: settled }).reason.startsWith('thread settled'),
    true,
    'settled issue: unchanged'
  );
  const busy = recThread({
    id: 'thr_example01',
    state: 'active',
    busy: true,
    updatedAt: iso(NOW - 1 * H),
  });
  is(
    cat({ ...issue, stage: 4, thread: busy, lastActivityAt: iso(NOW - 1 * H) }).category,
    'active',
    'busy issue: unchanged'
  );
  is(
    M.prThreadWaiting({ ...issue, stage: 3, thread: th }),
    null,
    'the PR rule never reads an issue'
  );
});

test('W6 precedence: done mark first; a waiting thread beats a working report and a snooze', () => {
  is(cat(pr({ thread: pending(), doneAt: iso(NOW - 1 * H) })).category, 'done', 'your done mark');
  const working = {
    status: 'working',
    thread: { kind: 'scoop', name: 'octocat-scoop' },
    pr: null,
    note: null,
    at: iso(NOW - 1 * H),
    history: [],
  };
  is(
    cat({ ...pr({ thread: pending() }), __report: working }).category,
    'needs-attention',
    'a waiting thread outranks an applied working report'
  );
  const stale = { ...working, at: iso(NOW - 7 * H) };
  is(
    cat({ ...pr({ thread: pending() }), __report: stale }).category,
    'needs-attention',
    'a stale report does not hide the question'
  );
  const snoozed = pr({
    thread: pending(),
    snoozedAt: iso(NOW - 2 * H),
    snoozedUntil: iso(NOW + 24 * H),
    snoozeCount: 0,
  });
  is(cat(snoozed).category, 'needs-attention', 'beats a snooze, like the other blocked signals');
  is(cat({ ...snoozed, thread: undefined }).category, 'snoozed', 'without the question: snoozed');
});

test('W7 the clock travels through thread-poll and the threads.json overlay', () => {
  const raw = {
    id: 'thr_example01',
    status: 'idle',
    archivedAt: null,
    deletedAt: null,
    queuedWork: 'none',
    activity: {},
    hasPendingInteraction: true,
    updatedAt: NOW - 60000,
    latestAttentionAt: NOW - 2 * H,
  };
  const s = M.threadStateOf(raw);
  is(s.attentionAt, iso(NOW - 2 * H), 'threadStateOf: latestAttentionAt -> attentionAt');
  ok(M.THREAD_STATE_FIELDS.includes('attentionAt'), 'an overlay may refresh it');
  // A PR the snapshot shows settled; threads.json says it now waits on an answer.
  const recs = [pr({ thread: recThread({ id: 'thr_example01', updatedAt: iso(NOW - 3 * H) }) })];
  is(cat(recs[0]).category, 'active', 'before the overlay');
  PANEL.overlayThreadState(recs, {
    threads: { thr_example01: { ...s, project: 'proj_example01' } },
  });
  is(recs[0].stage, 6, 'the overlay leaves the PR stage alone');
  is(
    cat(recs[0]).category,
    'needs-attention',
    'after: the question reaches the card within a minute'
  );
  PANEL.overlayThreadState(recs, {
    threads: { thr_example01: { ...s, attentionAt: '2026-09-22T12:00:00.000Z' } },
  });
  is(cat(recs[0]).category, 'stalled', 'and the overlay carries the clock');
});

test('W8 the fetcher summary (threadRef) carries attentionAt', () => {
  const src = fs.readFileSync(paths.fetcher(), 'utf8');
  const fn = (name) => {
    const a = src.indexOf(`\nfunction ${name}(`);
    if (a < 0) throw new Error(`no ${name} in the fetcher`);
    const i = src.indexOf('{', src.indexOf(')', a));
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(a + 1, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const threadRef = new Function(
    `const THREAD_BUSY_STATUSES = ['active', 'running', 'working'];\n${fn('threadIsLive')}\n${fn('threadIsBusy')}\n${fn('threadRef')}\nreturn threadRef;`
  )();
  const ref = threadRef(
    {
      id: 'thr_example01',
      status: 'idle',
      hasPendingInteraction: true,
      updatedAt: NOW - 60000,
      latestAttentionAt: NOW - 2 * H,
      activity: {},
    },
    'title'
  );
  is(ref.attentionAt, iso(NOW - 2 * H));
  is(
    threadRef({ id: 'thr_example01', status: 'idle', activity: {} }, 'title').attentionAt,
    null,
    'absent: null'
  );
});

// ---- W9-W11: a waiting thread against an agent's report (cone, 2026-09-28) --------

const workingReport = (thread) => ({
  status: 'working',
  thread: thread || { kind: 'scoop', name: 'octocat-scoop' },
  pr: null,
  note: null,
  at: iso(NOW - 1 * H),
  history: [],
});
const bbReport = (id) => ({
  kind: 'bb',
  id,
  url: `https://bb.example.invalid/projects/proj_example01/threads/${id}`,
});
const issueRec = (over) =>
  record({
    repo: REPO,
    id: '42',
    kind: 'issue',
    stage: 3,
    lastActivityAt: iso(NOW - 3 * H),
    ...over,
  });

test('W9 an applied WORKING report does not hold back a waiting thread: PR and issue -> Needs attention, glyph 3', () => {
  for (const rep of [workingReport(), workingReport(bbReport('thr_example01'))]) {
    const p = { ...pr({ thread: pending() }), __report: rep };
    is(cat(p).category, 'needs-attention', `PR, ${rep.thread.kind} report`);
    ok(/^bb thread thr_example01 is waiting on an answer\b/.test(cat(p).reason), cat(p).reason);
    is(PANEL.stateOf(p), PANEL.STATE[3], 'PR glyph: needs guidance');
    const i = { ...issueRec({ thread: pending() }), __report: rep };
    is(cat(i).category, 'needs-attention', `issue, ${rep.thread.kind} report`);
    is(
      PANEL.stateOf(i),
      PANEL.STATE[3],
      'issue glyph: needs guidance, not the report\'s "agent working"'
    );
  }
  const oldQ = {
    ...pr({ thread: pending({ attentionAt: '2026-09-22T12:00:00.000Z' }) }),
    __report: workingReport(),
  };
  is(cat(oldQ).category, 'stalled', 'and it still stalls');
  is(
    cat({ ...pr(), __report: workingReport() }).category,
    'active',
    'no waiting thread: the report holds, as before'
  );
});

test('W10 the done mark, an applied done or needs-attention report still decide the card', () => {
  const th = pending({ attentionAt: '2026-09-22T12:00:00.000Z' });
  is(
    cat({ ...pr({ thread: th }), doneAt: iso(NOW - 1 * H), __report: workingReport() }).category,
    'done',
    'done mark'
  );
  const done = { ...workingReport(), status: 'done' };
  is(cat({ ...pr({ thread: th }), __report: done }).category, 'done', 'done report, PR');
  is(cat({ ...issueRec({ thread: th }), __report: done }).category, 'done', 'done report, issue');
  const na = { ...workingReport(), status: 'needs-attention', note: 'Pick the retry policy' };
  const c = cat({ ...pr({ thread: th }), __report: na });
  is(c.category, 'needs-attention', 'needs-attention report');
  is(c.reason, 'Pick the retry policy', "the report's note stays the reason");
  const closed = pr({
    stage: 11,
    stateReason: 'closed_unmerged',
    lastActivityAt: iso(NOW - 5 * H),
    thread: th,
  });
  is(cat({ ...closed, __report: workingReport() }).category, 'done', 'closed on GitHub');
});

test('W11 the Go slot for a working report + a waiting thread: Go to thread (the waiting one), never "Working: ..."', () => {
  const src = fs.readFileSync(paths.panel(), 'utf8');
  const script = panelModule();
  const fn = (name, args) => `function ${name}(${args}) ${fnBody(script, name)}`;
  const goTarget = new Function(
    [
      'let META = null;',
      region(src, 'CLASSIFY'),
      region(src, 'FMT'),
      `let PASS_NOW = ${NOW};`,
      fn('recordKey', 'item'),
      fn('bbProject', 'repo'),
      fn('threadFor', 'item, now'),
      fn('goTarget', 'item, now'),
      'return goTarget;',
    ].join('\n')
  )();
  const cases = [
    ['scoop report', workingReport()],
    ['bb report naming another thread', workingReport(bbReport('thr_example02'))],
  ];
  for (const [why, rep] of cases) {
    for (const rec of [pr({ thread: pending() }), issueRec({ thread: pending() })]) {
      const g = goTarget({ ...rec, __report: rep }, NOW);
      is(g.mode, 'thread', `${rec.kind}, ${why}: a thread link`);
      is(g.reported, undefined, `${rec.kind}, ${why}: no dispatched state`);
      is(g.label, 'Go to thread', 'the existing label');
      ok(
        /thr_example01/.test(g.url) && !/Working:/.test(g.title),
        `${rec.kind}, ${why}: the waiting thread (${g.url})`
      );
    }
  }
  const held = goTarget({ ...pr(), __report: workingReport() }, NOW);
  ok(
    held.reported && /^Working: /.test(held.label),
    'no waiting thread: the dispatched "Working: ..." state, as before'
  );
});
