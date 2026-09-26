import test, { is, ok } from 'tst';

/* Drift test: the working-day rule exists TWICE and nothing else checks that
   the copies agree.
     (a) scripts/workdays-shared.cjs  - the fetcher's copy (require()d by it)
     (b) the inline workingDaysSince in the panel's module script (+ every
         top-level helper/constant it reaches, found by text)
   Both are evaluated from their shipped TEXT and compared, case by case, with
   exact equality over a deterministic battery of start/end pairs.

   Targets, deployed layout or skill-repo layout (tried in that order), or:
     GHD_PANEL=<path to github-dashboard.shtml>
     GHD_WORKDAYS=<path to workdays-shared.cjs>
   Runner: the builtin `tst` (relative path from cwd), e.g.
     cd skills/github-dashboard && tst tests/workdays-drift.test.js */
const fs = require('fs');

const env = (typeof process !== 'undefined' && process.env) || {};
function locate(envName, candidates, what) {
  if (env[envName]) {
    if (!fs.existsSync(env[envName])) throw new Error(`${envName}=${env[envName]} does not exist`);
    return env[envName];
  }
  const found = candidates.map((p) => new URL(p, import.meta.url).pathname).find((p) => fs.existsSync(p));
  if (!found) throw new Error(`${what} not found (tried ${candidates.join(', ')}); set ${envName}`);
  return found;
}
const PANEL = locate('GHD_PANEL', ['../github-dashboard.shtml', '../assets/sprinkle/github-dashboard.shtml'], 'github-dashboard.shtml');
const SHARED = locate('GHD_WORKDAYS', ['../workdays-shared.cjs', '../scripts/workdays-shared.cjs'], 'workdays-shared.cjs');

// ---- (b) the panel's inline copy, extracted by text ----------------------------
function panelModule() {
  const html = fs.readFileSync(PANEL, 'utf8');
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`${PANEL}: no <script type="module"> found`);
  return m[1];
}

/** Top-level declarations of the module script, by name: source text. The
    panel's top level is indented six spaces; nested declarations are deeper. */
function topLevelDecls(code) {
  const decls = new Map();
  const re = /^      (?:(?:async )?function (\w+)\s*\(|(?:const|let|var) (\w+)\s*=)/gm;
  let mm;
  while ((mm = re.exec(code))) {
    const name = mm[1] || mm[2];
    const start = mm.index;
    let end;
    if (mm[1]) {
      // function: brace-match from the body's opening brace
      let i = code.indexOf('{', code.indexOf(')', start));
      let depth = 0;
      for (end = i; end < code.length; end++) {
        if (code[end] === '{') depth++;
        else if (code[end] === '}' && --depth === 0) { end++; break; }
      }
    } else {
      // const/let: up to the first ; at bracket depth 0
      let depth = 0;
      for (end = start; end < code.length; end++) {
        const c = code[end];
        if ('{[('.includes(c)) depth++;
        else if ('}])'.includes(c)) depth--;
        else if (c === ';' && depth === 0) { end++; break; }
      }
    }
    if (!decls.has(name)) decls.set(name, code.slice(start, end));
  }
  return decls;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** workingDaysSince plus the closure of top-level names it references. */
function extractPanel() {
  const decls = topLevelDecls(panelModule());
  if (!decls.has('workingDaysSince')) {
    throw new Error(`${PANEL}: no top-level "function workingDaysSince(" in the module script; extraction found nothing to compare`);
  }
  const need = ['workingDaysSince'];
  const got = new Set();
  while (need.length) {
    const n = need.pop();
    if (got.has(n)) continue;
    got.add(n);
    const body = stripComments(decls.get(n));
    for (const id of new Set(body.match(/\b[A-Za-z_$][\w$]*\b/g) || [])) {
      if (id !== n && decls.has(id) && !got.has(id)) need.push(id);
    }
  }
  // Constants first, then functions (declarations hoist; consts do not).
  const names = [...got];
  const order = names.filter((n) => !/^\s*(?:async )?function/.test(decls.get(n))).concat(names.filter((n) => /^\s*(?:async )?function/.test(decls.get(n))));
  const src = order.map((n) => decls.get(n)).join('\n');
  const fn = new Function(src + '\nreturn workingDaysSince;')();
  if (typeof fn !== 'function') throw new Error('panel extraction did not yield a function');
  return { fn, names: order };
}

// ---- (a) the shared module, read + evaluated (a computed require() path fails here)
function loadShared() {
  const src = fs.readFileSync(SHARED, 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, (p) => {
    throw new Error(`${SHARED} requires ${p}; the drift test expects a dependency-free module`);
  });
  if (typeof mod.exports.workingDaysSince !== 'function') {
    throw new Error(`${SHARED}: module.exports.workingDaysSince is not a function; nothing to compare`);
  }
  return mod.exports.workingDaysSince;
}

let LOADED = null;
function load() {
  if (!LOADED) LOADED = { panel: extractPanel(), shared: loadShared() };
  return LOADED;
}

// ---- the battery ---------------------------------------------------------------
const DAY = 864e5;
const TIMES = [0, 9 * 36e5 + 17 * 6e4 + 23456, DAY - 1]; // 00:00, 09:17:23.456, 23:59:59.999 UTC
// Extra instants that matter to a LOCAL-time implementation: local midnights and
// the DST switch instants themselves (all UTC-based code should be indifferent).
const SPECIAL = {
  'autumn 2026': [
    '2026-09-30T22:00:00+02:00', '2026-10-01T00:00:00+02:00',               // month end, Berlin
    '2026-10-25T00:00:00+02:00', '2026-10-25T01:00:00Z', '2026-10-25T02:30:00+01:00', '2026-10-26T00:00:00+01:00', // Berlin DST end
    '2026-10-31T23:30:00-07:00', '2026-11-01T09:00:00Z', '2026-11-01T01:30:00-08:00', '2026-11-02T00:00:00-08:00', // LA DST end
  ],
  'year end 2026/27': ['2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00+01:00', '2026-12-31T16:00:00-08:00', '2027-01-01T00:00:00.001Z'],
  'spring 2027': [
    '2027-02-28T23:00:00Z', '2027-03-01T00:00:00+01:00',
    '2027-03-14T10:00:00Z', '2027-03-14T03:30:00-07:00', '2027-03-14T00:00:00-08:00', // LA DST start
    '2027-03-28T01:00:00Z', '2027-03-28T03:30:00+02:00', '2027-03-28T00:00:00+01:00', // Berlin DST start
    '2027-03-31T23:00:00+02:00',
  ],
  'leap 2028': ['2028-02-29T12:00:00Z', '2028-02-29T00:00:00+01:00', '2028-03-01T00:00:00Z', '2028-03-26T01:00:00Z', '2028-03-12T10:00:00Z'],
};
// Each window is at least 6 weeks and starts on a Monday.
const WINDOWS = [
  { name: 'autumn 2026', from: '2026-09-21', weeks: 7 },     // Sep/Oct/Nov month ends, both autumn DST changes
  { name: 'year end 2026/27', from: '2026-12-07', weeks: 7 }, // Dec 31 -> Jan 1 (a Thursday -> Friday)
  { name: 'spring 2027', from: '2027-02-22', weeks: 6 },      // Feb/Mar month ends, both spring DST changes
  { name: 'leap 2028', from: '2028-02-07', weeks: 7 },        // Feb 29 (a Tuesday), DST 2028
];
function points(w) {
  const t0 = Date.parse(w.from + 'T00:00:00Z');
  const out = [];
  for (let d = 0; d < w.weeks * 7; d++) for (const t of TIMES) out.push(new Date(t0 + d * DAY + t).toISOString());
  return out.concat(SPECIAL[w.name] || []);
}

/** Compare every ordered pair (start, end), including end-before-start and
    start === end, calling both copies with `now` as a Date (the fetcher's
    call) and as epoch ms (the panel's call). Returns the case count. */
function compareWindow(w) {
  const { panel, shared } = load();
  const pts = points(w);
  let n = 0;
  for (const start of pts) {
    for (const end of pts) {
      const endMs = Date.parse(end);
      for (const [kind, now] of [['Date', new Date(endMs)], ['ms', endMs]]) {
        const p = panel.fn(start, now);
        const s = shared(start, now);
        n++;
        // One exact-equality assertion PER CASE; the message is the input.
        // (Object.is is checked first only so the message is built lazily.)
        is(p, s, Object.is(p, s) ? 'ok' : `DRIFT in "${w.name}": workingDaysSince(${JSON.stringify(start)}, ${kind}(${end})) panel=${p} shared=${s}`);
      }
    }
  }
  return n;
}

// ---- tests ----------------------------------------------------------------------
test('extraction: the panel copy and the shared module both load', () => {
  const { panel, shared } = load();
  ok(panel.names.includes('workingDaysSince'), 'panel: workingDaysSince extracted');
  ok(panel.names.length >= 2, `panel: helpers extracted too (${panel.names.join(', ')})`);
  is(typeof shared, 'function', 'shared: workingDaysSince exported');
});

test('non-vacuous: both copies give the known answers on anchor cases', () => {
  const { panel, shared } = load();
  const anchors = [
    ['2026-09-21T00:00:00Z', '2026-09-22T00:00:00Z', 1], // Mon -> Tue
    ['2026-09-25T12:00:00Z', '2026-09-28T12:00:00Z', 1], // Fri noon -> Mon noon: the weekend is free
    ['2026-09-26T00:00:00Z', '2026-09-28T00:00:00Z', 0], // Sat -> Mon
    ['2026-09-21T00:00:00Z', '2026-09-21T06:00:00Z', 0.25],
    ['2026-09-22T00:00:00Z', '2026-09-21T00:00:00Z', 0], // end before start
  ];
  for (const [a, b, want] of anchors) {
    is(panel.fn(a, new Date(b)), want, `panel workingDaysSince(${a}, ${b})`);
    is(shared(a, new Date(b)), want, `shared workingDaysSince(${a}, ${b})`);
  }
});

let TOTAL = 0;
for (const w of WINDOWS) {
  test(`agree exactly on every ordered pair in "${w.name}" (${w.weeks} weeks from ${w.from})`, () => {
    const n = compareWindow(w);
    TOTAL += n;
    ok(n > 1000, `${n} cases compared`);
  });
}

test('battery size', () => {
  ok(TOTAL > 0, `total cases compared: ${TOTAL}`);
  console.log(`# workdays-drift: ${TOTAL} cases compared; panel=${PANEL} (extracted: ${load().panel.names.join(', ')}) shared=${SHARED}`);
});
