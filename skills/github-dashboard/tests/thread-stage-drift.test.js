/* Drift test for the thread-derived stage rule, which exists in three places:
     (a) thread-stage-shared.cjs, the module (fenced THREAD-STAGE block);
     (b) the panel's embedded copy of that block (GHD-CLASSIFY);
     (c) the fetcher's threadIsLive / threadIsBusy / threadRef /
         stageFromThread in fetch-snapshot.mjs, read from its TEXT, never run.

   What is compared, and what deliberately is not:
     D1  (a) == (b), byte for byte (after the panel's six-space indent).
     D2  RAW helpers: threadIsLive identical; threadIsBusy identical except
         bb status "active" (the module adds it; measured evidence in (a)).
     D3  THE MAPPING. The fetcher's stageFromThread fed the RAW thread (the
         shape its code reads, i.e. its INTENDED input) against the module's
         stageFromThread fed the SUMMARY the fetcher's own threadRef builds
         from that same RAW thread. Identical on every case, no exceptions.
     D4  An independent oracle, the intended mapping as the fetcher's doc
         comment states it (plus phase 5: archived -> 2): both agree with it.
     D5  THE ONE INTENTIONAL DIVERGENCE: the fetcher's CALL SITE passes the
         SUMMARY (stageFromThread(rec, rec.thread)) to a function that reads
         RAW fields. This test does NOT reproduce that call. It checks that
         the call site still looks like that (to say so in the log, and to
         notice the port), and asserts the module gives the intended stage
         on the summary shape the call site actually has.

     cd skills/github-dashboard && tst tests/thread-stage-drift.test.js
     GHD_FETCHER=... GHD_PANEL=... GHD_THREAD_STAGE=... tst tests/thread-stage-drift.test.js */
const { default: test, is, ok } = require('tst');
const { fs, paths, fenced, sharedModule } = require('./thread-helpers.js');

const START = '---- 8< THREAD-STAGE';
const END = '---- >8 end THREAD-STAGE';

test('D1 the panel embeds the module block VERBATIM', () => {
  const mod = fenced(fs.readFileSync(paths.shared(), 'utf8'), START, END, paths.shared());
  const panelRaw = fenced(fs.readFileSync(paths.panel(), 'utf8'), START, END, paths.panel());
  const panel = panelRaw.split('\n').map((l) => (l.startsWith('      ') ? l.slice(6) : l)).join('\n');
  ok(mod.length > 1000, `module block is ${mod.length} chars`);
  if (panel === mod) return ok(true, 'identical');
  const a = mod.split('\n');
  const b = panel.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  is(b[i], a[i], `DRIFT at block line ${i + 1}: panel vs module (run embed-thread-stage.js)`);
});

// ---- the fetcher, from its text ---------------------------------------------------
function topLevelFn(src, name) {
  const a = src.indexOf(`\nfunction ${name}(`);
  if (a < 0) return null;
  const i = src.indexOf('{', src.indexOf(')', a));
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(a + 1, j + 1);
  }
  throw new Error(`unbalanced ${name} in the fetcher`);
}
let F = null;
function fetcher() {
  if (F) return F;
  const src = fs.readFileSync(paths.fetcher(), 'utf8');
  const need = ['threadIsLive', 'threadIsBusy', 'threadRef'];
  const texts = need.map((n) => topLevelFn(src, n));
  if (texts.some((t) => !t)) throw new Error(`${paths.fetcher()}: ${need.filter((n, i) => !texts[i]).join(', ')} not found`);
  const local = topLevelFn(src, 'stageFromThread'); // may be gone after the port
  const fns = new Function(texts.concat(local ? [local] : []).join('\n') +
    `\nreturn { threadIsLive, threadIsBusy, threadRef, stageFromThread: ${local ? 'stageFromThread' : 'null'} };`)();
  // The call site that promotes a record's stage from its thread.
  const call = (src.match(/const promoted = ([\w.]+)\(rec, rec\.thread\);/) || [])[1] || null;
  const ported = /require\(['"]\.\/thread-stage-shared\.cjs['"]\)/.test(src) && call !== 'stageFromThread';
  F = { ...fns, call, ported, summary: (t) => fns.threadRef(t, 'title') };
  return F;
}
const S = () => sharedModule();

// ---- the battery: RAW bb threads ---------------------------------------------------
const ACT = ['activeBackgroundAgentCount', 'activeBackgroundCommandCount', 'activeGoalCount', 'activePlanModeCount', 'activeWorkflowCount'];
function threads() {
  const out = [];
  const activities = [undefined, {}].concat(ACT.map((k) => Object.fromEntries(ACT.map((j) => [j, j === k ? 2 : 0]))));
  for (const status of ['idle', 'error', 'active', 'running', 'working', undefined, 'unknown-status'])
    for (const archivedAt of [null, 1790000000000])
      for (const deletedAt of [null, 1790000000001])
        for (const hasPendingInteraction of [false, true])
          for (const queuedWork of ['none', 'waiting', null])
            for (const activity of activities)
              out.push({ id: 'thr_example01', status, archivedAt, deletedAt, hasPendingInteraction, queuedWork, activity, updatedAt: 1790000000000, title: 'Example (#101)' });
  return out;
}
const RECS = [{ kind: 'issue', stage: 1 }, { kind: 'issue', stage: 2 }, { kind: 'issue', stage: 11 }, { kind: 'pr', stage: 1 }, { kind: 'pr', stage: 6 }];
const stageOf = (x) => (x ? x.stage : null);

test('D2 RAW helpers: threadIsLive identical; threadIsBusy identical except bb status "active"', () => {
  const f = fetcher();
  const s = S();
  let n = 0;
  let active = 0;
  for (const t of threads()) {
    n++;
    is(s.threadIsLive(t), f.threadIsLive(t), `threadIsLive ${JSON.stringify(t)}`);
    if (t.status === 'active' && !f.threadIsBusy(t)) {
      active++;
      is(s.threadIsBusy(t), true, 'module: status "active" is busy');
    } else {
      is(s.threadIsBusy(t), f.threadIsBusy(t), `threadIsBusy ${JSON.stringify(t)}`);
    }
  }
  ok(n > 1000, `${n} threads, ${active} differ, all of them status "active"`);
});

test('D3 THE MAPPING: fetcher stageFromThread on RAW == module stageFromThread on the fetcher\'s own SUMMARY, every case', () => {
  const f = fetcher();
  const s = S();
  if (!f.stageFromThread) return ok(f.ported, 'no local stageFromThread: the fetcher is ported (D4 still checks the module against the intended mapping)');
  let n = 0;
  let same = 0;
  const bad = [];
  for (const t of threads()) {
    for (const rec of RECS) {
      n++;
      const want = stageOf(f.stageFromThread(rec, t)); // its intended input
      const got = stageOf(s.stageFromThread(rec, f.summary(t))); // the shape it stores
      if (want === got) same++;
      else if (bad.length < 3) bad.push({ rec, t, fetcherOnRaw: want, moduleOnSummary: got });
    }
  }
  is(same, n, bad.length ? `DRIFT: ${JSON.stringify(bad)}` : `${n} cases identical`);
  console.log(`# drift D3: ${n} cases, ${same} identical (fetcher ${paths.fetcher()})`);
});

test('D4 both match the INTENDED mapping (doc comment of the fetcher\'s stageFromThread, with phase 5 archived -> 2)', () => {
  const f = fetcher();
  const s = S();
  const issue = { kind: 'issue', stage: 1 };
  const base = { id: 'thr_example01', status: 'idle', archivedAt: null, deletedAt: null, hasPendingInteraction: false, queuedWork: 'none', activity: {}, updatedAt: 1790000000000, title: 'Example (#101)' };
  // The doc comment's table still says "only archived threads -> 1 (unchanged)";
  // the code below it and its phase-5 comment return 2, and so does the brief.
  const cases = [
    ['live + hasPendingInteraction -> 3 needs guidance', { hasPendingInteraction: true }, 3],
    ['live + busy (queued) -> 4', { queuedWork: 'waiting' }, 4],
    ['live + busy (active goal) -> 4', { activity: { activeGoalCount: 1 } }, 4],
    ['live + busy (status running) -> 4', { status: 'running' }, 4],
    ['live + idle -> 2', {}, 2],
    ['live + status=error -> 2', { status: 'error' }, 2],
    ['archived only -> 2 (phase 5)', { archivedAt: 1790000000000 }, 2],
    ['archived + stale pending flag -> 2', { archivedAt: 1790000000000, hasPendingInteraction: true }, 2],
    ['deleted -> 2', { deletedAt: 1790000000000 }, 2],
  ];
  for (const [name, over, want] of cases) {
    const t = { ...base, ...over };
    if (f.stageFromThread) is(stageOf(f.stageFromThread(issue, t)), want, `fetcher on RAW: ${name}`);
    is(stageOf(s.stageFromThread(issue, f.summary(t))), want, `module on SUMMARY: ${name}`);
    is(stageOf(s.stageFromThread(issue, s.threadStateOf(t))), want, `module on its own SUMMARY (thread-poll.jsh): ${name}`);
  }
  is(s.stageFromThread(issue, f.summary(base)).settled, true, 'live idle is flagged settled');
  for (const rec of [{ kind: 'pr', stage: 1 }, { kind: 'issue', stage: 11 }]) {
    if (f.stageFromThread) is(f.stageFromThread(rec, base), null, `fetcher: ${rec.kind} ${rec.stage} untouched`);
    is(s.stageFromThread(rec, f.summary(base)), null, `module: ${rec.kind} ${rec.stage} untouched`);
  }
});

test('D5 the one intentional divergence: the call site passes the SUMMARY; the module maps that shape as intended', () => {
  const f = fetcher();
  const s = S();
  ok(f.call, 'found `const promoted = <fn>(rec, rec.thread);` in the fetcher');
  if (f.ported) {
    console.log(`# drift D5: PORTED, the call site uses ${f.call}(rec, rec.thread)`);
  } else {
    is(f.call, 'stageFromThread', 'unported: the call site hands rec.thread (a SUMMARY) to the RAW-reading local stageFromThread');
    console.log('# drift D5: NOT PORTED: fetch-snapshot.mjs still calls its RAW-reading stageFromThread with rec.thread (a SUMMARY); see the port note in the reply');
  }
  // Not the fetcher's call reproduced: the module on the summary the call site
  // holds, against the intended mapping (the fetcher on RAW, D3's oracle).
  // slicc#3482 on 2026-09-25: archived, state=error.
  const t3482 = { id: 'thr_example82', status: 'error', archivedAt: 1790000000000, deletedAt: null, hasPendingInteraction: false, queuedWork: 'none', activity: {}, updatedAt: 1790000000000, title: '#3482 example' };
  const r = s.stageFromThread({ kind: 'issue', stage: 1 }, f.summary(t3482));
  is(r.stage, 2);
  ok(/archived/.test(r.why) && /status=error/.test(r.why), `why names the archive and the real status: ${r.why}`);
  const busy = { ...t3482, archivedAt: null, status: 'running' };
  is(s.stageFromThread({ kind: 'issue', stage: 1 }, f.summary(busy)).stage, 4, 'a running thread (no queued work) is 4 on the summary');
});
