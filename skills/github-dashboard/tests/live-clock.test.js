/* Phase 8e: the live clock. The same record, seen when the panel opened and
   26 h later, must give the later label, group and snooze state.

   Runs against the BUILT PANEL: it cuts the GHD-CLASSIFY, GHD-SNOOZESPEC and
   GHD-FMT regions out of github-dashboard.shtml and evaluates them, and reads
   the module script for the wiring checks. The 8d panel has none of these
   regions and still has a module clock, so every test here is red against it.

     cd /shared/sprinkles/github-dashboard && tst tests/live-clock.test.js
     GHD_PANEL=/path/to/other.shtml tst tests/live-clock.test.js

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

let SRC = null;
const src = () => (SRC = SRC || fs.readFileSync(panelPath(), 'utf8'));

function region(name) {
  const s = src();
  const a = s.indexOf(`GHD-${name}:START`);
  const b = s.indexOf(`GHD-${name}:END`);
  if (a < 0 || b < 0 || b < a) throw new Error(`panel has no GHD-${name} region`);
  return s.slice(s.lastIndexOf('/*', a), s.lastIndexOf('\n', b));
}

function moduleScript() {
  const m = src().match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('module script not found');
  return m[1];
}

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The body of `function name(` in the module script, brace-matched. */
function fnBody(name) {
  const m = moduleScript();
  const a = m.indexOf(`function ${name}(`);
  if (a < 0) throw new Error(`no function ${name}`);
  let i = m.indexOf('{', m.indexOf(')', a));
  let depth = 0;
  for (let j = i; j < m.length; j++) {
    if (m[j] === '{') depth++;
    else if (m[j] === '}' && --depth === 0) return m.slice(i, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

let API = null;
function api() {
  if (API) return API;
  const code = [region('CLASSIFY'), region('SNOOZESPEC'), region('FMT')].join('\n');
  // bbOrigin() in the region reads META only when called; give it a name.
  API = new Function(
    'let META = null;\n' + code +
      '\nreturn { categorize, snoozeState, snoozeSpec, whenLabel, categoryDrift, canRegroup, workingDaysSince };',
  )();
  return API;
}

const H = 36e5;
// Wednesday 2026-09-23 12:00Z: the panel opens. LATER is 26 h on, Thursday 14:00Z.
const OPEN = Date.parse('2026-09-23T12:00:00.000Z');
const LATER = OPEN + 26 * H;
const iso = (ms) => new Date(ms).toISOString();
const keyOf = (r) => `${r.repo}#${r.id}`;
const rec = (over) => ({ repo: 'o/r', id: 1, kind: 'pr', title: 't', url: 'https://x', stage: 4, labels: [], lastActivityAt: iso(OPEN - 2 * H), ...over });

test('no module clock: the pure regions and the module read time only from their callers', () => {
  for (const r of ['CLASSIFY', 'SNOOZESPEC', 'FMT']) {
    const code = stripComments(region(r));
    ok(!/\bNOW\b/.test(code), r + ' does not read NOW');
    ok(!code.includes('Date.now'), r + ' does not call Date.now');
    ok(!/new Date\(\s*\)/.test(code), r + ' does not construct the current time');
    ok(!/=\s*NOW\s*[,)]/.test(code), r + ' has no NOW default parameter');
  }
  const mod = stripComments(moduleScript());
  ok(!/const NOW\s*=/.test(mod), 'no `const NOW =` anywhere in the module');
});

test('render() and reconcile() take the time fresh before they categorize', () => {
  for (const name of ['render', 'reconcile']) {
    const body = stripComments(fnBody(name));
    const pass = body.indexOf('clockPass()');
    const cat = body.indexOf('categorize(');
    ok(pass >= 0, name + ' calls clockPass()');
    ok(cat > pass, name + ' categorizes after taking the time');
    ok(/categorize\(it, nowMs\)/.test(body), name + ' categorizes with that time');
  }
});

test('the 30 s tick repaints labels in place and regroups only through the idle gate', () => {
  const tick = stripComments(fnBody('onClockTick'));
  ok(tick.includes('repaintTimeLabels('), 'tick repaints time labels');
  ok(!/\brender\(/.test(tick), 'tick never calls render()');
  const gate = tick.indexOf('canRegroup(');
  const move = tick.indexOf('reconcile(');
  ok(gate >= 0 && move > gate, 'reconcile is reached only after canRegroup');
  ok(stripComments(fnBody('startAgeClock')).includes('onClockTick()'), 'the 8d timer drives onClockTick');
});

test('label: the same record reads 2h at open and 28h at +26 h', () => {
  const { whenLabel } = api();
  const r = rec({});
  is(whenLabel(r.lastActivityAt, OPEN), '2h ago');
  is(whenLabel(r.lastActivityAt, LATER), '28h ago');
  is(whenLabel(r.lastActivityAt, OPEN + 50 * H), '2d ago');
});

test('label: activity later than the clock never reads negative', () => {
  const { whenLabel } = api();
  is(whenLabel(iso(OPEN + 30 * 60000), OPEN), '0m ago');
});

test('group: a working PR idle 2 h is active at open and stalled at +26 h', () => {
  const { categorize } = api();
  const r = rec({ stage: 4 });
  is(categorize(r, OPEN).category, 'active');
  is(categorize(r, LATER).category, 'stalled');
});

test('snooze: expires between open and +26 h -> leaves Snoozed, button becomes Snooze', () => {
  const { categorize, snoozeState, snoozeSpec } = api();
  const r = rec({ stage: 6, lastActivityAt: iso(OPEN - 1 * H), snoozedAt: iso(OPEN - 22 * H), snoozedUntil: iso(OPEN + 2 * H), snoozeCount: 0 });
  is(categorize(r, OPEN).category, 'snoozed', 'snoozed at open');
  is(snoozeState(r, OPEN).active, true);
  is(snoozeSpec(r, OPEN).mode, 'unsnooze', 'button un-snoozes at open');
  is(snoozeState(r, LATER).active, false, 'not active at +26 h');
  is(snoozeState(r, LATER).expired, true, 'expired at +26 h');
  is(categorize(r, LATER).category, 'stalled', 'review idle 27 h > 24 h: stalled');
  is(snoozeSpec(r, LATER).mode, 'snooze');
  is(snoozeSpec(r, LATER).label, 'Snooze');
});

test('done retention: released 1.5 working days before open ages out by +26 h', () => {
  const { categorize } = api();
  const r = rec({ stage: 10, lastActivityAt: '2026-09-22T00:00:00.000Z' });
  is(categorize(r, OPEN).category, 'done');
  is(categorize(r, LATER).category, 'aged-out');
});

test('open issue: 4.5 working days untouched at open, stalled (5+) at +26 h', () => {
  const { categorize } = api();
  const r = rec({ kind: 'issue', stage: 1, thread: null, hasClosingPr: false, commentsCount: 0, counterResetAt: '2026-09-17T00:00:00.000Z', lastActivityAt: '2026-09-17T00:00:00.000Z' });
  is(categorize(r, OPEN).category, 'needs-attention');
  is(categorize(r, LATER).category, 'stalled');
});

test('categoryDrift names exactly the records time has moved', () => {
  const { categorize, categoryDrift } = api();
  const moving = rec({ id: 1, stage: 4 });
  const still = rec({ id: 2, stage: 6, lastActivityAt: iso(OPEN - 1 * H), snoozedAt: iso(OPEN), snoozedUntil: iso(OPEN + 5 * 24 * H) });
  const unseen = rec({ id: 3, stage: 4 });
  const rendered = new Map([moving, still].map((r) => [keyOf(r), categorize(r, OPEN).category]));
  // tst's same() is shallow over members, so compare the serialised lists.
  is(JSON.stringify(categoryDrift([moving, still, unseen], rendered, OPEN, keyOf)), '[]', 'no drift at the pass time');
  is(
    JSON.stringify(categoryDrift([moving, still, unseen], rendered, LATER, keyOf)),
    JSON.stringify([{ key: 'o/r#1', from: 'active', to: 'stalled' }]),
    'only the stalled PR; the long snooze and the never-rendered record are not drift',
  );
});

test('canRegroup: only at an idle boundary', () => {
  const { canRegroup } = api();
  const idle = { hidden: false, dialogOpen: false, pointerInside: false, focusInside: false };
  is(canRegroup(idle), true, 'visible and idle');
  is(canRegroup({ ...idle, pointerInside: true }), false, 'pointer over the panel');
  is(canRegroup({ ...idle, dialogOpen: true }), false, 'quick view open');
  is(canRegroup({ ...idle, focusInside: true }), false, 'focus in the list');
  is(canRegroup({ hidden: true, dialogOpen: true, pointerInside: true, focusInside: true }), true, 'hidden: nobody is looking');
});
