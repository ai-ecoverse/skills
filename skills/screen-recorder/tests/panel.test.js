import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// The panel's own functions, cut out of recording-setup.shtml and run against
// stubs. Every free name resolves through `scope`: the test supplies what each
// case needs, and anything else is a no-op, so the function under test is the
// shipped source, not a copy. The skill root is the cwd under tst.
const SHTML = fs.readFileSync(
  path.join(process.cwd(), 'assets/sprinkle/recording-setup.shtml'),
  'utf8'
);

function extract(signature) {
  const start = SHTML.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const indent = SHTML.slice(SHTML.lastIndexOf('\n', start) + 1, start);
  const end = SHTML.indexOf(`\n${indent}}\n`, start);
  return SHTML.slice(start, end + indent.length + 2);
}

const noop = async () => undefined;
function load(signature, name, stubs) {
  const scope = new Proxy(stubs, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : k in globalThis ? globalThis[k] : noop),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return new Function('scope', `with (scope) { ${extract(signature)}\nreturn ${name}; }`)(scope);
}

function openTargetStubs(over = {}) {
  const calls = [];
  const state = {};
  const stubs = {
    calls,
    state,
    $: () => ({ disabled: false, textContent: '' }),
    readConfig: () => ({ tabW: 1280, tabH: 800 }),
    validateUrl: (u) => ({ ok: true, url: u }),
    checkDisplayFit: () => ({ fitsDisplay: true }),
    displayFitWarning: () => null,
    withTimeout: (p) => p,
    tabIds: (tabs) => (tabs || []).map((t) => t.id),
    parseTabList: () => [],
    newTargetId: () => null,
    findTargetId: () => null,
    isNavigated: () => true,
    landedElsewhere: () => null,
    describeTargetWindow: () => ({}),
    windowGeometryCmd: (id) => `geometry ${id}`,
    parseGeometry: () => null,
    geometryIsCoherent: () => true,
    log: (m) => calls.push(['log', m]),
    showOpenResult: (...a) => calls.push(['showOpenResult', ...a]),
    slicc: {
      exec: async (cmd) => {
        calls.push(['exec', cmd]);
        return { stdout: '' };
      },
    },
    ...over,
  };
  return stubs;
}

test('openTarget uses the targetId openWindow returned, even when tab-list cannot find it', async () => {
  const s = openTargetStubs({
    openTargetWindowApi: async () => ({
      targetId: 'T9',
      openedVia: 'slicc.browser.openWindow',
      sized: true,
    }),
  });
  s.slicc.browser = { openWindow: async () => 'T9' };
  await load('async function openTarget() {', 'openTarget', s)();
  is(s.state.targetTabId, 'T9');
  ok(
    s.calls.some((c) => c[0] === 'log' && /resolved via openWindow/.test(c[1])),
    'logged where the id came from'
  );
  ok(
    s.calls.some((c) => c[0] === 'exec' && c[1] === 'geometry T9'),
    'geometry probe ran on it'
  );
});

test('without openWindow, window.open runs before openTarget awaits anything (user activation)', async () => {
  let openedSync = false;
  let started = false;
  const s = openTargetStubs({
    openTargetWindowApi: async () => ({ unavailable: true }),
    openTargetWindow: () => {
      openedSync = !started;
      return { handle: {}, openedVia: 'window.open', sized: true };
    },
  });
  const run = load('async function openTarget() {', 'openTarget', s)();
  started = true; // anything after this line ran after the first await
  await run;
  ok(openedSync, 'window.open was called synchronously inside the click');
});

test('config clear: a reloadconfig with no config file resets the CLI-settable fields', async () => {
  const fields = {
    startUrl: { value: 'https://a.example', defaultValue: '' },
    tabW: { value: '1280', defaultValue: '' },
    tabH: { value: '800', defaultValue: '' },
    countdown: { value: '5', defaultValue: '0' },
    driver: { value: '/x.sh', defaultValue: '' },
    maxDur: { value: '12', defaultValue: '0' },
  };
  const logs = [];
  const s = {
    $: (id) => fields[id],
    readConfigFile: async () => null,
    CONFIG_FIELDS: {
      startUrl: 'startUrl',
      width: 'tabW',
      height: 'tabH',
      countdownSec: 'countdown',
      driver: 'driver',
    },
    log: (m) => logs.push(m),
  };
  const apply = load('async function applyConfigFile(announce) {', 'applyConfigFile', s);
  is(await apply(false), false, 'boot with no file changes nothing');
  is(fields.startUrl.value, 'https://a.example');
  is(await apply(true), true);
  for (const [id, el] of Object.entries(fields)) is(el.value, el.defaultValue, id);
  ok(logs.some((m) => /config cleared/.test(m)));
});
