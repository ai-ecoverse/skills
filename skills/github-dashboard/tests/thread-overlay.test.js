/* The thread-state overlay: data/threads.json (thread-poll.jsh) refreshes the
   STATE of threads the snapshot already links, and the open issue's stage is
   recomputed from it before categorize(). Links stay the snapshot's.

   Two halves:
     O1-O8  overlayThreadState(), cut out of the BUILT panel's GHD-CLASSIFY
            region (the embedded THREAD-STAGE block), run over fake records;
     W1-W4  the panel's wiring, read from its module script: the 5 s tick reads
            the file, render/reconcile overlay before categorize, the first
            paint has it, and the status note.
   Against the pre-2026-09-25 panel overlayThreadState does not exist and none
   of the wiring is there: every test is red.

     cd skills/github-dashboard && tst tests/thread-overlay.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/thread-overlay.test.js */
const { default: test, is, ok } = require('tst');
const { panelApi, panelModule, fnBody, stripComments, recThread, record, H, iso } = require('./thread-helpers.js');

let API = null;
const api = () => (API = API || panelApi());
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const overlay = (records, file) => {
  const f = api().overlayThreadState;
  if (typeof f !== 'function') throw new Error('overlayThreadState is not in the panel');
  return f(records, file);
};
const file = (threads) => ({ version: 1, generatedAt: iso(NOW), contentHash: 'h-' + Object.keys(threads).join(','), threads });
const entry = (over) => ({ state: 'idle', archived: false, live: true, busy: false, hasPendingInteraction: false, queuedWork: 'none', updatedAt: iso(NOW - 60000), project: 'proj_example01', ...over });

// A snapshot that still says "agent working" for thr_example01.
const busySnapshot = () => [
  record({ id: '101', stage: 4, stageWhy: 'bb thread has work in flight', lastActivityAt: iso(NOW - 2 * H), thread: recThread({ id: 'thr_example01', busy: true, state: 'active', updatedAt: iso(NOW - 3 * H) }) }),
  record({ id: '102', stage: 1, title: 'Unlinked issue', lastActivityAt: iso(NOW - 2 * H) }),
  record({ id: '201', kind: 'pr', stage: 6, lastActivityAt: iso(NOW - 2 * H), thread: recThread({ id: 'thr_example02', busy: true, state: 'active', updatedAt: iso(NOW - 3 * H) }) }),
  record({ id: '103', stage: 4, lastActivityAt: iso(NOW - 2 * H), thread: recThread({ id: 'thr_example03', busy: true, state: 'active', updatedAt: iso(NOW - 3 * H) }) }),
];
const LINK_FIELDS = ['id', 'title', 'branch', 'matchedBy', 'provider'];

test('O1 the overlay refreshes state and the card moves: busy (stage 4, active) -> settled (stage 2, needs-attention)', () => {
  const recs = busySnapshot();
  is(api().categorize(recs[0], NOW).category, 'active', 'before: active');
  const st = overlay(recs, file({ thr_example01: entry({}) }));
  is(recs[0].stage, 2, 'stage recomputed');
  is(recs[0].thread.busy, false);
  is(recs[0].thread.state, 'idle');
  ok(/settled/.test(recs[0].stageWhy), `stageWhy: ${recs[0].stageWhy}`);
  const c = api().categorize(recs[0], NOW);
  is(c.category, 'needs-attention', 'after: needs-attention');
  ok(/^thread settled\b/.test(c.reason), c.reason);
  is(st.refreshed, 1);
  is(st.stageChanged, 1);
});

test('O2 links are never changed: no thread added, none removed, link fields kept', () => {
  const recs = busySnapshot();
  const before = recs.map((r) => (r.thread ? LINK_FIELDS.map((f) => r.thread[f]).join('|') : null));
  // The file ALSO carries threads nobody links, and one whose id no record has.
  overlay(recs, file({ thr_example01: entry({ title: 'A DIFFERENT TITLE', id: 'thr_evil', branch: 'x', matchedBy: 'branch' }), thr_example02: entry({}), thr_example99: entry({}) }));
  const after = recs.map((r) => (r.thread ? LINK_FIELDS.map((f) => r.thread[f]).join('|') : null));
  is(JSON.stringify(after), JSON.stringify(before), 'link fields identical');
  is(recs[1].thread, undefined, 'the unlinked issue got no thread');
  is(recs.filter((r) => r.thread).length, 3, 'still three linked records');
});

test('O3 a thread MISSING from the file (out of the top 200, or archived) keeps its snapshot state', () => {
  const recs = busySnapshot();
  const snap = JSON.stringify(recs[3]);
  const st = overlay(recs, file({ thr_example01: entry({}) }));
  is(JSON.stringify(recs[3]), snap, 'record 103 untouched');
  is(api().categorize(recs[3], NOW).category, 'active', 'still active, as the snapshot said');
  ok(st.missing >= 1, `missing counted: ${st.missing}`);
});

test('O4 PRs: thread state refreshes, the stage does not (GitHub drives it)', () => {
  const recs = busySnapshot();
  overlay(recs, file({ thr_example02: entry({}) }));
  is(recs[2].stage, 6, 'PR stage unchanged');
  is(recs[2].thread.busy, false, 'PR thread state refreshed');
});

test('O5 idempotent and reversible: re-applying is a no-op, an empty file restores the snapshot', () => {
  const recs = busySnapshot();
  const orig = JSON.stringify(recs);
  const f = file({ thr_example01: entry({}) });
  overlay(recs, f);
  const once = JSON.stringify(recs.map((r) => ({ ...r, __threadOverlay: undefined })));
  overlay(recs, f);
  is(JSON.stringify(recs.map((r) => ({ ...r, __threadOverlay: undefined }))), once, 'second pass = first pass');
  overlay(recs, null);
  is(JSON.stringify(recs), orig, 'no file: back to the snapshot exactly');
});

test('O6 an entry OLDER than the snapshot is ignored (a dead poller cannot roll a new snapshot back)', () => {
  const recs = busySnapshot();
  const st = overlay(recs, file({ thr_example01: entry({ updatedAt: iso(NOW - 5 * H) }) }));
  is(recs[0].stage, 4, 'stage kept');
  is(recs[0].thread.busy, true, 'state kept');
  is(st.older, 1);
});

test('O7 the other directions: settled -> busy moves back to active; settled -> pending goes to stage 3', () => {
  const settled = () => [record({ id: '104', stage: 2, lastActivityAt: iso(NOW - 2 * H), thread: recThread({ id: 'thr_example04', updatedAt: iso(NOW - 3 * H) }) })];
  let r = settled();
  is(api().categorize(r[0], NOW).category, 'needs-attention', 'settled in the snapshot');
  overlay(r, file({ thr_example04: entry({ busy: true, state: 'active' }) }));
  is(r[0].stage, 4);
  is(api().categorize(r[0], NOW).category, 'active');
  r = settled();
  overlay(r, file({ thr_example04: entry({ hasPendingInteraction: true }) }));
  is(r[0].stage, 3);
  is(api().categorize(r[0], NOW).reason, 'thread wants guidance');
});

test('O8 the overlay records the phase change the status note reads', () => {
  const recs = busySnapshot();
  overlay(recs, file({ thr_example01: entry({}), thr_example03: entry({ busy: true, state: 'active' }) }));
  is(recs[0].__threadOverlay.phaseFrom, 'busy');
  is(recs[0].__threadOverlay.phaseTo, 'settled');
  is(recs[3].__threadOverlay.phaseFrom, recs[3].__threadOverlay.phaseTo, 'no change, no note');
});

// ---- wiring ----------------------------------------------------------------
const MOD = () => stripComments(panelModule());
const body = (name) => {
  const b = fnBody(MOD(), name);
  if (!b) throw new Error(`no function ${name} in the panel`);
  return b;
};

test('W1 the 5 s tick reads threads.json, and a hash change alone reconciles', () => {
  const src = MOD();
  ok(/let THREADS_PATH = '\/shared\/sprinkles\/github-dashboard\/data\/threads\.json'/.test(src), 'THREADS_PATH is data/threads.json');
  const poll = body('pollForUpdates');
  ok(poll.indexOf('refreshThreadState()') >= 0, 'pollForUpdates calls refreshThreadState');
  ok(poll.indexOf('refreshThreadState()') < poll.indexOf('readVersion()'), '... before the version check can return early');
  ok(/threadsMoved && !reconciled/.test(poll) && /reconcile\(\{ records: RECORDS, meta: META \}/.test(poll), 'threads-only change reconciles the same records');
  const read = body('refreshThreadState');
  ok(/f\.contentHash === LAST_THREADS_HASH\) return false/.test(read), 'unchanged hash: nothing re-applied');
});

test('W2 render() and reconcile() overlay BEFORE they categorize', () => {
  for (const name of ['render', 'reconcile']) {
    const b = body(name);
    const o = b.indexOf('applyThreadOverlay()');
    ok(o >= 0, `${name} calls applyThreadOverlay`);
    ok(o < b.indexOf('categorize('), `${name}: overlay before categorize`);
  }
  ok(/overlayThreadState\(RECORDS, THREAD_FILE\)/.test(body('applyThreadOverlay')), 'applyThreadOverlay runs the shared overlay');
});

test('W3 the first paint already has the fresh state', () => {
  const src = MOD();
  const boot = src.slice(src.lastIndexOf('setTimeout(async () => {'));
  const r = boot.indexOf('await refreshThreadState()');
  ok(r >= 0 && r < boot.indexOf('render()'), 'boot reads threads.json before the first render()');
});

test('W4 the status note: tooltip (card + update) and quick view, only when the phase moved', () => {
  const src = MOD();
  ok((src.match(/threadStatusNote\(item\)/g) || []).length >= 3, 'used by card(), updateCard() and the quick view');
  const f = new Function(fnBody(src, 'threadStatusNote').replace(/^\{/, '').replace(/\}$/, '').replace(/^/, 'return (function(item){') + '})')();
  is(f({ __threadOverlay: { phaseFrom: 'busy', phaseTo: 'settled' } }), '(status written when the bb thread was busy; it is settled now)');
  is(f({ __threadOverlay: { phaseFrom: 'settled', phaseTo: 'settled' } }), null);
  is(f({}), null);
});
