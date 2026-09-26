import test, { is, ok } from 'tst';

/* Agent reports on cards: data/reports.json (written only by `gh dashboard`)
   overlaid on the snapshot, and the `report` field every request lick carries.

     R0       the panel embeds report-overlay-shared.cjs's REPORT-OVERLAY block
              VERBATIM (scripts/embed-report-overlay.js re-embeds it);
     R1-R12   the overlay rules, on the module itself and through the panel's
              categorize(), cut out of the BUILT panel's GHD-CLASSIFY region;
     C1-C2    the card's report line (reportLineSpec), who reported and when;
     L1-L2    every slicc.lick( call in the panel's module script, evaluated
              from its source text: `report` sits inside `data`, key filled in;
     W1-W4    the wiring: the 5 s tick, render/reconcile order, first paint,
              and refreshReports() against a stubbed bridge.

     cd skills/github-dashboard && tst tests/report-overlay.test.js
     GHD_PANEL=... GHD_REPORT_OVERLAY=... tst tests/report-overlay.test.js

   Fake ids only: octocat/hello-world, thr_example01, bb.example.invalid. */
const { fs, locate, paths, fenced, panelModule, fnBody, stripComments, record, H, iso } =
  require('./thread-helpers.js');

const modPath = () =>
  locate(
    'GHD_REPORT_OVERLAY',
    ['../report-overlay-shared.cjs', '../scripts/report-overlay-shared.cjs'],
    'report-overlay-shared.cjs'
  );

/** The module, evaluated from its text with no require() (it must stay
    dependency-free, like thread-stage-shared.cjs). */
let MOD = null;
function mod() {
  if (MOD) return MOD;
  const m = { exports: {} };
  new Function('module', 'exports', 'require', fs.readFileSync(modPath(), 'utf8'))(
    m,
    m.exports,
    (x) => {
      throw new Error(`report-overlay-shared.cjs requires ${x}; it must stay dependency-free`);
    }
  );
  MOD = m.exports;
  return MOD;
}

/** A region of the BUILT panel, from the comment that opens its START marker. */
function region(src, name) {
  const a = src.indexOf(`GHD-${name}:START`);
  const b = src.indexOf(`GHD-${name}:END`);
  if (a < 0 || b < 0 || b < a) throw new Error(`panel has no GHD-${name} region`);
  return src.slice(src.lastIndexOf('/*', a), src.lastIndexOf('\n', b));
}

/** GHD-CLASSIFY + GHD-FMT, evaluated, plus reportLineSpec from the module
    script with PASS_NOW pinned to `passNow`. */
const NAMES = [
  'categorize',
  'reportFor',
  'reportOverlay',
  'attachReports',
  'reportInstructions',
  'stallLimitFor',
  'STALL_AFTER_HOURS',
  'REPORT_WORKING_STAGE',
  'DONE_RETENTION_WORKING_DAYS',
  'reportLineSpec',
];
function panel(passNow) {
  const src = fs.readFileSync(paths.panel(), 'utf8');
  const script = panelModule();
  const spec = fnBody(script, 'reportLineSpec');
  const code = [
    region(src, 'CLASSIFY'),
    region(src, 'FMT'),
    `let PASS_NOW = ${Number(passNow) || 0};`,
    spec ? `function reportLineSpec(item) ${spec}` : '',
  ].join('\n');
  const ret = `{ ${NAMES.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} }`;
  return new Function(`let META = null;\n${code}\nreturn ${ret};`)();
}

// Wednesday 2026-09-30 12:00Z: no weekend inside any window below.
const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const P = panel(NOW);
const KEY = 'octocat/hello-world#101';
const BB_URL = 'https://bb.example.invalid/projects/proj_example01/threads/thr_example01';
const bb = { kind: 'bb', id: 'thr_example01', url: BB_URL };
const scoop = { kind: 'scoop', name: 'octocat-scoop' };
const report = (over) => ({
  status: 'working',
  thread: bb,
  pr: null,
  note: null,
  at: iso(NOW - 1 * H),
  history: [],
  ...over,
});
// An open issue nobody linked a thread to: on its own, needs-attention.
const issue = (over) => record({ stage: 1, lastActivityAt: iso(NOW - 3 * H), ...over });
const withReport = (rec, rep, threadEntry) => ({
  ...rec,
  __report: rep,
  ...(threadEntry ? { __reportThread: threadEntry } : {}),
});
const cat = (r) => P.categorize(r, NOW);
const over = (rec, rep, opts) => mod().reportOverlay(rec, rep, NOW, opts);

// ---- R0: one text ---------------------------------------------------------------

test('R0 the panel embeds the REPORT-OVERLAY block VERBATIM', () => {
  const START = '---- 8< REPORT-OVERLAY';
  const END = '---- >8 end REPORT-OVERLAY';
  const m = fenced(fs.readFileSync(modPath(), 'utf8'), START, END, modPath());
  const raw = fenced(fs.readFileSync(paths.panel(), 'utf8'), START, END, paths.panel());
  const p = raw
    .split('\n')
    .map((l) => (l.startsWith('      ') ? l.slice(6) : l))
    .join('\n');
  ok(m.length > 2000, `module block is ${m.length} chars`);
  if (p === m) return ok(true, 'identical');
  const a = m.split('\n');
  const b = p.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  is(b[i], a[i], `DRIFT at block line ${i + 1} (run scripts/embed-report-overlay.js)`);
});

// ---- R1-R12: the rules ------------------------------------------------------------

test('R1 no report: nothing changes, and the card is where GitHub puts it', () => {
  const o = over(issue(), null);
  is(o.present, false);
  is(o.category, null);
  is(o.effect, 'none');
  is(o.links.thread, null);
  is(o.links.pr, null);
  is(cat(issue()).category, 'needs-attention', 'untouched open issue');
  is(
    cat(withReport(issue(), undefined)).reason,
    cat(issue()).reason,
    'same reason as no field at all'
  );
  const st = mod().attachReports([issue()], null, null);
  is(st.reports, 0, 'missing file = no reports');
});

test('R2 working puts the card in Active; an open issue reads "agent working"', () => {
  const o = over(issue(), report({}));
  is(o.effect, 'applied');
  is(o.category, 'active');
  is(o.stage, 4, 'glyph stage for an open issue');
  const c = cat(withReport(issue(), report({})));
  is(c.category, 'active');
  ok(/^agent reported working 1h ago$/.test(c.reason), c.reason);
  is(over(record({ kind: 'pr', stage: 6 }), report({})).stage, null, 'a PR keeps its GitHub stage');
});

test('R3 needs-attention: Needs attention with the note as the reason', () => {
  const rep = report({ status: 'needs-attention', note: 'Which retry policy: fixed or backoff?' });
  const rec = record({ kind: 'pr', stage: 6, lastActivityAt: iso(NOW - 3 * H) });
  is(cat(rec).category, 'active', 'a PR in review is active on its own');
  const c = cat(withReport(rec, rep));
  is(c.category, 'needs-attention');
  is(c.reason, 'Which retry policy: fixed or backoff?');
  is(over(issue(), rep).stage, 3, 'an open issue reads "needs guidance"');
  is(
    over(rec, report({ status: 'needs-attention' })).reason,
    'agent reported needs-attention',
    'no note'
  );
});

test("R4 done puts the card in Done, with the done mark's retention counted from the report", () => {
  const rep = report({ status: 'done' });
  is(over(issue(), rep).category, 'done');
  is(cat(withReport(issue(), rep)).category, 'done');
  const old = report({ status: 'done', at: iso(NOW - 3 * 24 * H) });
  const rec = issue({ lastActivityAt: iso(NOW - 4 * 24 * H) });
  is(cat(withReport(rec, old)).category, 'aged-out', 'three working days after the report');
});

test('R5 GitHub wins: closed or merged ignores every report', () => {
  const closed = issue({ stage: 11, stateReason: 'completed', lastActivityAt: iso(NOW - 2 * H) });
  for (const status of ['working', 'needs-attention', 'done']) {
    const o = over(closed, report({ status, at: iso(NOW - 1 * H) }));
    is(o.effect, 'github', `${status} on a closed issue`);
    is(o.category, null);
  }
  is(cat(withReport(closed, report({ status: 'needs-attention', note: 'x' }))).category, 'done');
  ok(/^closed/.test(cat(withReport(closed, report({}))).reason), 'the normal closed stage applies');
  const merged = record({
    kind: 'pr',
    stage: 9,
    mergedAt: iso(NOW - 2 * H),
    lastActivityAt: iso(NOW - 2 * H),
  });
  is(cat(withReport(merged, report({}))).category, 'snoozed', 'merged: release train, not Active');
  is(
    over(record({ kind: 'pr', stage: 6, mergedAt: iso(NOW - 2 * H) }), report({})).effect,
    'github',
    'mergedAt alone'
  );
  is(over(issue({ stateReason: 'not_planned' }), report({})).effect, 'github', 'stateReason alone');
  is(over(issue({ stateReason: 'reopened' }), report({})).effect, 'applied', 'reopened is open');
  const links = over(closed, report({ pr: 'octocat/hello-world#57' })).links;
  ok(links.thread && links.pr, 'links are still returned: the card still shows who reported');
});

test('R6 done / needs-attention are superseded by GitHub activity newer than the report', () => {
  const at = iso(NOW - 2 * H);
  const newer = issue({ lastActivityAt: iso(NOW - 1 * H) });
  const older = issue({ lastActivityAt: iso(NOW - 3 * H) });
  for (const status of ['done', 'needs-attention']) {
    is(over(newer, report({ status, at })).effect, 'superseded', `${status}, activity after`);
    is(over(older, report({ status, at })).effect, 'applied', `${status}, activity before`);
  }
  is(
    cat(withReport(newer, report({ status: 'done', at }))).category,
    'needs-attention',
    "back to GitHub's own rules"
  );
  is(
    over(newer, report({ status: 'working', at })).effect,
    'applied',
    'working is not superseded by activity'
  );
});

test("R7 a working report goes stale at the panel's Active stall limit, measured from `at`", () => {
  is(P.REPORT_WORKING_STAGE, 4, 'the stage a working report stands for');
  is(
    P.stallLimitFor(P.REPORT_WORKING_STAGE),
    P.STALL_AFTER_HOURS,
    'stage 4 uses STALL_AFTER_HOURS'
  );
  is(P.STALL_AFTER_HOURS, 6);
  const limit = P.STALL_AFTER_HOURS;
  const fresh = withReport(issue(), report({ at: iso(NOW - (limit - 0.1) * H) }));
  const stale = withReport(issue(), report({ at: iso(NOW - limit * H) }));
  is(P.reportFor(fresh, NOW).effect, 'applied', `${limit - 0.1}h: still working`);
  is(P.reportFor(stale, NOW).effect, 'stale', `${limit}h: stale (idle >= limit, as categorize)`);
  is(cat(fresh).category, 'active');
  is(cat(stale).category, 'needs-attention', 'stale: no longer held in Active');
  is(cat(stale).reason, cat(issue()).reason, 'exactly the rules without a report');
  ok(
    /stallLimitFor\(REPORT_WORKING_STAGE\)/.test(stripComments(fnBody(panelModule(), 'reportFor'))),
    'the panel passes its own limit'
  );
  is(
    over(issue(), report({ at: iso(NOW - 6 * H) }), { staleAfterHours: 24 }).effect,
    'applied',
    "the limit is the caller's"
  );
  const archived = {
    state: 'idle',
    archived: true,
    live: false,
    busy: false,
    updatedAt: iso(NOW - 60000),
  };
  is(
    over(issue(), report({}), { thread: archived }).effect,
    'stale',
    'its bb thread is archived per threads.json'
  );
});

test('R8 user state keeps its place: the done mark beats every report; a snooze holds working/done back', () => {
  const doneMark = issue({ doneAt: iso(NOW - 1 * H) });
  is(cat(withReport(doneMark, report({ status: 'needs-attention', note: 'x' }))).category, 'done');
  const snoozed = record({
    kind: 'pr',
    stage: 6,
    lastActivityAt: iso(NOW - 3 * H),
    snoozedAt: iso(NOW - 2 * H),
    snoozedUntil: iso(NOW + 24 * H),
    snoozeCount: 0,
  });
  is(cat(withReport(snoozed, report({}))).category, 'snoozed', 'working under a snooze');
  is(
    cat(withReport(snoozed, report({ status: 'done' }))).category,
    'snoozed',
    'done under a snooze'
  );
  is(P.reportFor(withReport(snoozed, report({})), NOW).effect, 'snoozed');
  const na = cat(
    withReport(snoozed, report({ status: 'needs-attention', note: 'blocked on a decision' }))
  );
  is(
    na.category,
    'needs-attention',
    'needs-attention breaks through, like the other blocked signals'
  );
  is(na.reason, 'blocked on a decision');
});

test('R9 a bb thread report links its URL and carries threads.json state; a scoop is a name, not a link', () => {
  const entry = {
    state: 'active',
    archived: false,
    live: true,
    busy: true,
    updatedAt: iso(NOW - 60000),
  };
  const b = over(issue(), report({}), { thread: entry });
  is(b.reporter.kind, 'bb');
  is(b.reporter.url, BB_URL);
  is(b.links.thread.url, BB_URL);
  is(b.links.thread.label, 'thr_example01');
  is(b.reporter.threadState, entry, 'threads.json entry passed through');
  is(over(issue(), report({})).reporter.threadState, null, 'no entry: no state');
  const s = over(issue(), report({ thread: scoop }));
  is(s.reporter.kind, 'scoop');
  is(s.reporter.label, 'octocat-scoop');
  is(s.reporter.url, null);
  is(s.links.thread, null, 'no link for a scoop');
  is(s.category, 'active', 'a scoop report counts the same');
  is(
    over(
      issue(),
      report({ thread: { kind: 'bb', id: 'thr_example01', url: 'javascript:alert(1)' } })
    ).links.thread,
    null,
    'only http(s) links'
  );
  is(
    over(issue(), report({ thread: { kind: 'bb', id: 'not-a-thread', url: BB_URL } })).reporter,
    null,
    'a malformed thread is no reporter'
  );
  is(over(issue(), report({ thread: null })).reporter, null);
});

test('R10 a reported PR links at once, straight from its key', () => {
  const o = over(issue(), report({ pr: 'octocat/Hello-World#57' }));
  is(o.links.pr.url, 'https://github.com/octocat/Hello-World/pull/57');
  is(o.links.pr.label, 'Hello-World#57');
  is(o.links.pr.key, 'octocat/Hello-World#57');
  is(over(issue(), report({ pr: KEY })).links.pr, null, "the card's own item: no second link");
  is(over(issue(), report({ pr: 'octocat/hello-world#0' })).links.pr, null);
  is(
    over(issue(), report({ pr: 'https://github.com/octocat/hello-world/pull/57' })).links.pr,
    null,
    'the file holds keys only'
  );
  is(
    over(issue(), report({ status: null, pr: 'octocat/Hello-World#57' })).links.pr.url,
    'https://github.com/octocat/Hello-World/pull/57',
    'even with no status'
  );
});

test('R11 attachReports: idempotent, case-insensitive keys, threads.json entry for a bb reporter', () => {
  const recs = [issue({ id: '101' }), issue({ id: '102' }), issue({ id: '103' })];
  const file = {
    version: 1,
    reports: {
      [KEY]: report({}),
      'Octocat/Hello-World#102': report({ thread: scoop }),
      'octocat/hello-world#999': report({}),
    },
  };
  const threads = { threads: { thr_example01: { state: 'active', busy: true, live: true } } };
  const st = mod().attachReports(recs, file, threads);
  is(st.reports, 3);
  is(st.matched, 2);
  is(JSON.stringify(st.unmatched), JSON.stringify(['octocat/hello-world#999']));
  is(recs[0].__report, file.reports[KEY]);
  is(recs[0].__reportThread, threads.threads.thr_example01);
  is(recs[1].__report, file.reports['Octocat/Hello-World#102'], 'matched case-insensitively');
  is(recs[1].__reportThread, undefined, 'a scoop has no thread entry');
  is(recs[2].__report, undefined);
  const again = JSON.stringify(recs);
  mod().attachReports(recs, file, threads);
  is(JSON.stringify(recs), again, 'second pass = first pass');
  mod().attachReports(recs, null, threads);
  ok(
    recs.every((r) => !('__report' in r) && !('__reportThread' in r)),
    'no file: every report removed'
  );
  ok(typeof P.attachReports === 'function', 'embedded in the panel too');
});

test('R12 reportInstructions: the exact commands, key filled in', () => {
  const r = mod().reportInstructions('octocat/Hello-World#42');
  is(
    JSON.stringify(r),
    JSON.stringify({
      how: 'Report progress with gh dashboard (see gh dashboard update --help).',
      start:
        'gh dashboard update octocat/Hello-World#42 --status working --thread <bb-thread-url|scoop-name>',
      pr: 'gh dashboard update octocat/Hello-World#42 --pr <number>',
      blocked: 'gh dashboard update octocat/Hello-World#42 --status needs-attention --note "<why>"',
      done: 'gh dashboard update octocat/Hello-World#42 --status done',
      clear: 'gh dashboard clear octocat/Hello-World#42',
    })
  );
});

// ---- C1-C2: the card's report line ------------------------------------------------

test('C1 the card line: bb reporter linked, phase from threads.json, PR linked, time kept for the clock', () => {
  ok(typeof P.reportLineSpec === 'function', 'reportLineSpec is in the panel');
  is(P.reportLineSpec(issue()), null, 'no report: no line');
  const entry = {
    state: 'active',
    archived: false,
    live: true,
    busy: true,
    hasPendingInteraction: false,
  };
  const s = P.reportLineSpec(withReport(issue(), report({ pr: 'octocat/Hello-World#57' }), entry));
  is(s.status, 'working');
  is(s.who.kind, 'bb');
  is(s.who.label, 'thr_example01');
  is(s.who.url, BB_URL);
  is(s.who.phase, 'busy', 'threadPhase of the threads.json entry');
  is(s.pr.url, 'https://github.com/octocat/Hello-World/pull/57');
  is(s.at, iso(NOW - 1 * H));
  ok(/^Reported working by bb thread thr_example01 at 2026-09-30 11:00Z\./.test(s.title), s.title);
  ok(!/ago/.test(JSON.stringify(s)), 'no clock-relative text in the signature');
});

test('C2 the card line: scoop is plain text; a report that decides nothing says why, tersely', () => {
  const s = P.reportLineSpec(withReport(issue(), report({ thread: scoop })));
  is(s.who.kind, 'scoop');
  is(s.who.url, null);
  is(s.who.label, 'octocat-scoop');
  is(
    P.reportLineSpec(withReport(issue(), report({ at: iso(NOW - 7 * H) }))).status,
    'working, stale'
  );
  const closed = issue({ stage: 11, stateReason: 'completed' });
  is(P.reportLineSpec(withReport(closed, report({ status: 'done' }))).status, 'done, ignored');
  const newer = issue({ lastActivityAt: iso(NOW - 1 * H) });
  is(
    P.reportLineSpec(withReport(newer, report({ status: 'needs-attention', at: iso(NOW - 2 * H) })))
      .status,
    'needs attention, superseded'
  );
});

// ---- L1-L2: the licks -------------------------------------------------------------

/** Every `slicc.lick({...})` argument in the module script, brace-matched. */
function lickCalls() {
  const src = panelModule();
  const out = [];
  let i = src.indexOf('slicc.lick(');
  while (i >= 0) {
    const open = src.indexOf('{', i);
    let depth = 0;
    let j = open;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    out.push(src.slice(open, j + 1));
    i = src.indexOf('slicc.lick(', j);
  }
  return out;
}

test("L1 every request lick carries `report` INSIDE data, with the item's key filled in", () => {
  const calls = lickCalls();
  is(
    calls.length,
    2,
    'start-scoop and the action dispatch (do-nudge / clarify-question / review-before-approval)'
  );
  const item = {
    repo: 'octocat/Hello-World',
    id: '42',
    kind: 'issue',
    title: 't',
    url: 'https://github.com/octocat/Hello-World/issues/42',
  };
  const want = JSON.stringify(mod().reportInstructions('octocat/Hello-World#42'));
  for (const text of calls) {
    const lick = new Function(
      'item',
      'recordKey',
      'bbProject',
      'at',
      'spec',
      'action',
      'reportInstructions',
      `return (${text});`
    )(
      item,
      (r) => `${r.repo}#${r.id}`,
      () => null,
      '2026-09-30T12:00:00.000Z',
      { lick: 'do-nudge', note: 'n' },
      { kind: 'nudge', label: 'Chase the reviewer' },
      mod().reportInstructions
    );
    ok(lick.action, `action ${lick.action}`);
    ok(!('report' in lick), `${lick.action}: no top-level report (the runtime drops it)`);
    ok(lick.data && lick.data.report, `${lick.action}: data.report present`);
    is(JSON.stringify(lick.data.report), want, `${lick.action}: data.report, key filled in`);
    ok(
      typeof lick.data.note === 'string' && lick.data.note.length > 0,
      `${lick.action}: note kept`
    );
    is(lick.target, 'cone');
  }
});

test('L2 the action dispatch lick covers every registered kind', () => {
  const src = stripComments(panelModule());
  const kinds = (src.match(/lick: '([a-z-]+)'/g) || []).map((s) => s.slice(7, -1));
  is(
    JSON.stringify(kinds.sort()),
    JSON.stringify(['clarify-question', 'do-nudge', 'review-before-approval'])
  );
  ok(/action: spec\.lick,/.test(fnBody(src, 'actionClick')), 'one call site sends all three');
  ok(/action: 'start-scoop'/.test(fnBody(src, 'scoopClick')), 'start-scoop');
});

// ---- W1-W4: wiring ----------------------------------------------------------------

const body = (name) => {
  const b = fnBody(stripComments(panelModule()), name);
  if (!b) throw new Error(`no function ${name} in the panel`);
  return b;
};

test('W1 the 5 s tick reads reports.json, and a change alone reconciles', () => {
  const src = stripComments(panelModule());
  ok(/let REPORTS_PATH = '\/shared\/sprinkles\/github-dashboard\/data\/reports\.json'/.test(src));
  const poll = body('pollForUpdates');
  ok(
    poll.indexOf('refreshReports()') >= 0 &&
      poll.indexOf('refreshReports()') < poll.indexOf('readVersion()'),
    'before the version check can return early'
  );
  ok(
    /reportsMoved && !reconciled/.test(poll) && /regroup: 'reports'/.test(poll),
    'reports-only change reconciles the same records'
  );
});

test('W2 render() and reconcile(): thread overlay, then reports, then user state, then categorize', () => {
  for (const name of ['render', 'reconcile']) {
    const b = body(name);
    const t = b.indexOf('applyThreadOverlay()');
    const r = b.indexOf('applyReportOverlay()');
    const u = b.indexOf('applyUserState()');
    ok(t >= 0 && r > t && u > r && b.indexOf('categorize(') > u, `${name}: order`);
  }
  ok(/attachReports\(RECORDS, REPORTS_FILE, THREAD_FILE\)/.test(body('applyReportOverlay')));
});

test('W3 the first paint already has the reports', () => {
  const src = stripComments(panelModule());
  const boot = src.slice(src.lastIndexOf('setTimeout(async () => {'));
  const r = boot.indexOf('await refreshReports()');
  ok(r >= 0 && r < boot.indexOf('render()'), 'boot reads reports.json before the first render()');
});

test('W4 refreshReports(): missing file = no reports, a change is adopted once, junk keeps what it has', async () => {
  const src = panelModule();
  const files = {};
  const slicc = {
    exists: async (p) => p in files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p];
    },
  };
  const run = new Function(
    'slicc',
    `let REPORTS_PATH = '/tmp/r.json'; let REPORTS_FILE = null; let LAST_REPORTS_HASH = null;
     const reportUpdate = { reads: 0, readFailures: 0, hashChanges: 0, reconciles: 0, lastError: null, lastHash: null };
     function textHash(s) ${fnBody(src, 'textHash')}
     async function refreshReports() ${fnBody(src, 'refreshReports')}
     return { refresh: refreshReports, file: () => REPORTS_FILE, stats: reportUpdate };`
  )(slicc);
  is(await run.refresh(), false, 'no file, nothing held: no change');
  is(run.file(), null);
  is(run.stats.readFailures, 0, 'a missing file is not a failure');
  files['/tmp/r.json'] = JSON.stringify({ version: 1, reports: { [KEY]: report({}) } });
  is(await run.refresh(), true, 'new file adopted');
  ok(run.file().reports[KEY]);
  is(await run.refresh(), false, 'same text: nothing re-applied');
  files['/tmp/r.json'] = '{"version":1,"rep';
  is(await run.refresh(), false, 'unparseable: not adopted');
  ok(run.file().reports[KEY], '... and the held reports stay');
  is(run.stats.readFailures, 1);
  delete files['/tmp/r.json'];
  is(await run.refresh(), true, 'deleted: a change');
  is(run.file(), null, '... to no reports');
});
