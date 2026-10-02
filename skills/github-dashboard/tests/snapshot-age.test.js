/* Phase 8d: snapshot age + staleness threshold, as pure logic.

   Runs against the BUILT PANEL, not a copy: it cuts the region between the
   GHD-SNAPSHOT-AGE markers out of github-dashboard.shtml and evaluates it. A
   panel without that region fails every test here, which is the point: the
   pre-8d panel had no staleness state at all.

     cd /shared/sprinkles/github-dashboard && tst tests/snapshot-age.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/snapshot-age.test.js   # any panel

   Uses the builtin `tst` runner (node:test is not available here). */
const fs = require('fs');
const { default: test, is, ok } = require('tst');

function panelPath() {
  if (process.env.GHD_PANEL) return process.env.GHD_PANEL;
  // Deployed layout (tests/ next to the panel) or skill-repo layout
  // (tests/ next to assets/sprinkle/), the same two layouts build.sh knows.
  for (const p of [__dirname + '/../github-dashboard.shtml', __dirname + '/../assets/sprinkle/github-dashboard.shtml']) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('github-dashboard.shtml not found; set GHD_PANEL');
}

function region() {
  const src = fs.readFileSync(panelPath(), 'utf8');
  const a = src.indexOf('GHD-SNAPSHOT-AGE:START');
  const b = src.indexOf('GHD-SNAPSHOT-AGE:END');
  if (a < 0 || b < 0 || b < a) throw new Error('panel has no GHD-SNAPSHOT-AGE region (no snapshot-age logic)');
  // From the opening comment (which the START marker sits in) to the line
  // holding the END marker.
  return src.slice(src.lastIndexOf('/*', a), src.lastIndexOf('\n', b));
}

let cached = null;
function load() {
  if (cached) return cached;
  const code = region();
  // eslint-disable-next-line no-new-func
  const api = new Function(
    code + '\nreturn { SNAPSHOT_STALE_AFTER_MS, SNAPSHOT_CLOCK_SKEW_MS, snapshotAgeState, fmtSnapshotAge };',
  )();
  cached = { code, ...api };
  return cached;
}

const MIN = 60 * 1000;
// 2026-09-23 11:14Z: the moment the first good snapshot landed after the outage.
const NOW = Date.parse('2026-09-23T11:14:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('threshold is ONE named constant of 65 min, explained in terms of NORMAL_MS', () => {
  const { code, SNAPSHOT_STALE_AFTER_MS } = load();
  is(SNAPSHOT_STALE_AFTER_MS, 65 * MIN, '65 minutes');
  ok(/const SNAPSHOT_STALE_AFTER_MS = 65 \* 60 \* 1000;/.test(code), 'declared once, literally');
  const decl = code.indexOf('const SNAPSHOT_STALE_AFTER_MS');
  ok(/NORMAL_MS/.test(code.slice(Math.max(0, decl - 900), decl)), 'the comment above it names poll.jsh NORMAL_MS');
});

test('pure: no DOM, no module clock (the panel NOW is frozen at open)', () => {
  const code = load().code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const banned of ['document', 'window', 'META', 'Date.now', 'new Date()']) {
    ok(!code.includes(banned), 'region does not use ' + banned);
  }
  ok(!/\bNOW\b/.test(code), 'region does not use the frozen NOW');
});

test('fresh: 5 min old', () => {
  const s = load().snapshotAgeState(ago(5 * MIN), NOW);
  is(s.state, 'fresh');
  is(s.text, 'Fetched 5 min ago');
  is(s.ageMs, 5 * MIN);
});

test('fresh: under a minute reads "just now"', () => {
  const s = load().snapshotAgeState(ago(40 * 1000), NOW);
  is(s.state, 'fresh');
  is(s.text, 'Fetched just now');
});

test('exactly at the threshold (65 min) is still fresh', () => {
  const s = load().snapshotAgeState(ago(65 * MIN), NOW);
  is(s.state, 'fresh');
  is(s.text, 'Fetched 1 h 5 min ago');
});

test('just over the threshold (65 min + 1 ms) is stale, with the fetch time', () => {
  const s = load().snapshotAgeState(ago(65 * MIN + 1), NOW);
  is(s.state, 'stale');
  is(s.text, 'May be out of date: fetched 10:08Z, 1 h 5 min ago');
  ok(s.title.includes('2026-09-23 10:08Z'), 'tooltip carries the full UTC fetch time');
});

test('far over: 6.6 h old', () => {
  const s = load().snapshotAgeState(ago(6.6 * 60 * MIN), NOW);
  is(s.state, 'stale');
  is(s.text, 'May be out of date: fetched 04:38Z, 6 h 36 min ago');
});

test('the 2026-09-23 outage itself: last good 04:36Z, seen at 11:14Z', () => {
  const s = load().snapshotAgeState('2026-09-23T04:36:00.000Z', NOW);
  is(s.state, 'stale');
  is(s.text, 'May be out of date: fetched 04:36Z, 6 h 38 min ago');
});

test('stale across a UTC day boundary names the date', () => {
  const s = load().snapshotAgeState('2026-09-22T23:50:00.000Z', Date.parse('2026-09-23T01:00:00.000Z'));
  is(s.state, 'stale');
  is(s.text, 'May be out of date: fetched 2026-09-22 23:50Z, 1 h 10 min ago');
});

test('missing generatedAt: visible "age unknown", not blank', () => {
  const f = load().snapshotAgeState;
  for (const v of [undefined, null, '']) {
    const s = f(v, NOW);
    is(s.state, 'unknown', 'state for ' + JSON.stringify(v));
    is(s.reason, 'missing');
    is(s.text, 'Snapshot age unknown');
    ok(s.title.length > 0, 'tooltip explains');
  }
});

test('unparseable generatedAt: "age unknown", never a throw or NaN', () => {
  const f = load().snapshotAgeState;
  for (const v of ['not a date', '2026-09-23', '2026-09-23T04:36:00', '23/09/2026 04:36', 1790000000000, {}, []]) {
    let s;
    try {
      s = f(v, NOW);
    } catch (e) {
      ok(false, 'threw on ' + JSON.stringify(v) + ': ' + e);
    }
    is(s.state, 'unknown', 'state for ' + JSON.stringify(v));
    is(s.reason, 'unparseable', 'reason for ' + JSON.stringify(v));
    is(s.text, 'Snapshot age unknown');
    ok(!/NaN|undefined|Invalid/.test(s.text + s.title), 'no NaN / Invalid Date leaks for ' + JSON.stringify(v));
  }
});

test('clock skew, small: 2 min in the future reads as just now', () => {
  const s = load().snapshotAgeState(ago(-2 * MIN), NOW);
  is(s.state, 'fresh');
  is(s.ageMs, 0);
  is(s.text, 'Fetched just now');
});

test('clock skew, large: 3 h in the future is "age unknown", not fresh and not negative', () => {
  const s = load().snapshotAgeState(ago(-3 * 60 * MIN), NOW);
  is(s.state, 'unknown');
  is(s.reason, 'future');
  is(s.text, 'Snapshot age unknown');
  ok(!s.text.includes('-') && !s.title.includes('-180'), 'no negative age');
});

test('a new snapshot resets the age: same clock, newer generatedAt', () => {
  const f = load().snapshotAgeState;
  is(f(ago(6.6 * 60 * MIN), NOW).state, 'stale', 'before');
  is(f(ago(0), NOW).text, 'Fetched just now', 'after');
});
