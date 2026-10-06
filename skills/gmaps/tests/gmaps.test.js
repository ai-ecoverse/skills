import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Behaviour tests for scripts/gmaps.jsh:
//
//   tst skills/gmaps/tests/gmaps.test.js
//
// The script body is compiled as an AsyncFunction with require('sliccy:cli'),
// process, console and fetch injected (the pattern in skills/cosmos/tests). No
// network: fetch is a stub that records the request and serves a fixture.
//
// Fixtures are real /maps/preview/directions responses captured 2026-10-06 and
// trimmed to ONLY the array paths gmaps.jsh reads (every other slot is null), so
// a passing suite also proves the decoder depends on nothing else. They prove
// request building, decoding, rendering and exit codes, not the live service.

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gmaps.jsh');
const FIX = (name) => readFileSync(path.join(__dirname, 'fixtures', `${name}.txt`), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

/** Decode the pb parameter of a recorded request URL. */
function pbOf(url) {
  return new URL(url).searchParams.get('pb');
}

/** Mode code inside `!20m2!1e<n>!2e3`. */
function modeOf(url) {
  return Number(pbOf(url).match(/!20m2!1e(\d)!2e3/)[1]);
}

/**
 * Run gmaps.jsh. `serve(url)` returns a fixture name, a raw string, or
 * { status, body }. Returns { exitCode, stdout, stderr, urls }.
 */
async function run(argv, serve = () => 'walking') {
  const src = readFileSync(SCRIPT, 'utf8');
  const stdout = [];
  const stderr = [];
  const urls = [];
  const proc = {
    argv: ['node', SCRIPT, ...argv],
    env: {},
    exit(code = 0) {
      throw new NodeExitError(code);
    },
    stdout: { isTTY: false },
    stderr: { isTTY: false },
  };
  const cons = {
    log: (...a) => stdout.push(a.join(' ')),
    error: (...a) => stderr.push(a.join(' ')),
    warn: (...a) => stderr.push(a.join(' ')),
  };
  const cli = {
    die(msg, o = {}) {
      stderr.push(o.prefix === '' ? String(msg) : `${o.prefix || 'Error'}: ${msg}`);
      throw new NodeExitError(o.exitCode === undefined ? 1 : o.exitCode);
    },
  };
  const req = (name) => {
    if (name === 'sliccy:cli') return cli;
    throw new Error(`jsh stub: unsupported require(${name})`);
  };
  const fetchStub = async (url) => {
    urls.push(String(url));
    const r = serve(String(url));
    const res = typeof r === 'object' ? r : { body: /^[a-z]+$/.test(r) ? FIX(r) : r };
    const status = res.status === undefined ? 200 : res.status;
    return { ok: status < 300, status, text: async () => res.body };
  };
  const body = new AsyncFunction('require', 'process', 'console', 'fetch', src);
  let exitCode = 0;
  try {
    await body(req, proc, cons, fetchStub);
  } catch (err) {
    if (err && err.name === 'NodeExitError') exitCode = err.code;
    else {
      exitCode = 1;
      stderr.push(String(err && err.stack ? err.stack : err));
    }
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), urls };
}

const O = 'Levelingstraße 2, 81673 München';
const D = 'August-Everding-Straße 24, 81671 München';
const byMode = (url) => ({ 0: 'driving', 2: 'walking', 3: 'transit' })[modeOf(url)] || 'walking';

// ── request building ────────────────────────────────────────────────────────

test('route builds the minimal pb request with no key and no cookie', async () => {
  const r = await run(['route', O, D, '--mode', 'walking']);
  is(r.exitCode, 0, r.stderr);
  is(r.urls.length, 1);
  const u = new URL(r.urls[0]);
  is(u.origin + u.pathname, 'https://www.google.com/maps/preview/directions');
  is(pbOf(r.urls[0]), `!1m2!1s${O}!6e0!1m2!1s${D}!6e0!6m3!20m2!1e2!2e3`);
});

test('each mode maps to its backend code (0 drive, 1 bike, 2 walk, 3 transit)', async () => {
  for (const [m, code] of [
    ['driving', 0],
    ['bicycling', 1],
    ['walking', 2],
    ['transit', 3],
  ]) {
    const r = await run(['route', O, D, '--mode', m]);
    is(modeOf(r.urls[0]), code, m);
  }
});

test('--mode all (default) issues one request per mode', async () => {
  const r = await run(['route', O, D], byMode);
  is(r.exitCode, 0, r.stderr);
  is(r.urls.map(modeOf).sort().join(','), '0,1,2,3');
});

test('--depart encodes local wall-clock time as if UTC, after the mode message', async () => {
  const r = await run(
    ['route', O, D, '--mode', 'transit', '--depart', '2026-10-06T19:00'],
    () => 'transit'
  );
  const t = Date.UTC(2026, 9, 6, 19, 0) / 1000;
  ok(pbOf(r.urls[0]).endsWith(`!6m6!20m2!1e3!2e3!19m2!2e2!3j${t}`), pbOf(r.urls[0]));
});

test('--arrive uses the arrive-by message', async () => {
  const r = await run(
    ['route', O, D, '--mode', 'transit', '--arrive', '2026-10-06T19:00'],
    () => 'transit'
  );
  const t = Date.UTC(2026, 9, 6, 19, 0) / 1000;
  ok(pbOf(r.urls[0]).endsWith(`!6m7!20m2!1e3!2e3!19m3!1e1!2e2!3j${t}`), pbOf(r.urls[0]));
});

test('"!" and "*" in a place are escaped the way Maps escapes them', async () => {
  const r = await run(['route', 'Bar! *1*, München', D, '--mode', 'walking']);
  ok(pbOf(r.urls[0]).startsWith('!1m2!1sBar*21 *2A1*2A, München!6e0'), pbOf(r.urls[0]));
});

// ── decoding and rendering ──────────────────────────────────────────────────

test('walking: duration, distance and via, recommended route starred', async () => {
  const r = await run(['route', O, D, '--mode', 'walking']);
  is(r.exitCode, 0, r.stderr);
  ok(r.stdout.includes(`${O}  →  ${D}`), r.stdout);
  ok(/★ 21 min · 1\.5 km {2}via Berg-am-Laim-Straße and Trausnitzstraße/.test(r.stdout), r.stdout);
});

test('transit --json: times from epoch+offset, fare, and per-leg line/stop/headsign', async () => {
  const r = await run(
    ['route', O, D, '--mode', 'transit', '--depart', '2026-10-06T19:00', '--json'],
    () => 'transit'
  );
  is(r.exitCode, 0, r.stderr);
  const [res] = JSON.parse(r.stdout);
  is(res.mode, 'transit');
  is(res.time, 'depart 2026-10-06 19:00');
  const best = res.routes[0];
  is([best.duration, best.departs, best.arrives, best.fare], ['9 min', '19:02', '19:11', '€4.20']);
  is(
    best.legs.map((l) => l.mode),
    ['Walk', 'Bus', 'Walk']
  );
  const bus = best.legs[1];
  is([bus.line, bus.from, bus.departs], ['190', 'Schlüsselbergstraße', '19:03']);
  ok(bus.headsign && bus.stops > 1, JSON.stringify(bus));
});

test('driving shows the typical range', async () => {
  const r = await run(['route', O, D, '--mode', 'driving'], () => 'driving');
  is(r.exitCode, 0, r.stderr);
  ok(/\(typically \d+–\d+ min\)/.test(r.stdout), r.stdout);
});

test('flags before the places do not swallow a place', async () => {
  const r = await run(['route', '--json', O, D, '--mode', 'walking']);
  is(r.exitCode, 0, r.stderr);
  ok(pbOf(r.urls[0]).startsWith(`!1m2!1s${O}!6e0!1m2!1s${D}`), pbOf(r.urls[0]));
});

// ── failures ────────────────────────────────────────────────────────────────

test('unknown place: names the query and exits 1', async () => {
  const r = await run(['route', O, 'Xqzzvv Nowhere 99999', '--mode', 'walking'], () => 'unknown');
  is(r.exitCode, 1);
  ok(r.stdout.includes('can\'t find "Xqzzvv Nowhere 99999"'), r.stdout);
});

test('places that exist but do not connect: "no route", exit 1', async () => {
  const r = await run(['route', 'München', 'New York', '--mode', 'driving'], () => 'noroute');
  is(r.exitCode, 1);
  ok(r.stdout.includes('no driving route'), r.stdout);
});

test('one failing mode does not fail the others', async () => {
  const r = await run(['route', O, D], (u) => (modeOf(u) === 3 ? 'noroute' : byMode(u)));
  is(r.exitCode, 0, r.stderr);
  ok(r.stdout.includes('no transit route'), r.stdout);
  ok(r.stdout.includes('21 min'), r.stdout);
});

test('a non-JSON body is reported as an endpoint change, not as zero routes', async () => {
  const r = await run(['route', O, D, '--mode', 'walking'], () => '<html>sorry</html>');
  is(r.exitCode, 1);
  ok(r.stdout.includes('endpoint may have changed'), r.stdout);
});

test('HTTP errors surface the status', async () => {
  const r = await run(['route', O, D, '--mode', 'walking'], () => ({ status: 429, body: '' }));
  is(r.exitCode, 1);
  ok(r.stdout.includes('HTTP 429'), r.stdout);
});

test('routes without durations are reported as a layout change', async () => {
  const body =
    ")]}'\n" +
    JSON.stringify([
      [
        [[[['A', null, [null, null, 1, 2]]]], [[['B', null, [null, null, 3, 4]]]]],
        [[[null, 'x', [1, '1 m', 0], null]]],
      ],
    ]);
  const r = await run(['route', 'A', 'B', '--mode', 'walking'], () => body);
  is(r.exitCode, 1);
  ok(r.stdout.includes('layout changed'), r.stdout);
});

// ── argument errors (exit 2, no request) ────────────────────────────────────

test('usage errors exit 2 without any request', async () => {
  for (const argv of [
    ['route', O],
    ['route', O, D, 'extra'],
    ['route', O, D, '--mode', 'boat'],
    ['route', O, D, '--mode'],
    ['route', O, D, '--depart', '25:00'],
    ['route', O, D, '--depart', '2026-13-01T10:00'],
    ['route', O, D, '--depart', '19:00', '--arrive', '20:00'],
    ['route', O, D, '--bogus'],
    ['frobnicate', O, D],
  ]) {
    const r = await run(argv);
    is(r.exitCode, 2, argv.join(' ') + ' → ' + r.stderr);
    is(r.urls.length, 0, argv.join(' '));
  }
});

test('link prints a Maps URL and makes no request', async () => {
  const r = await run(['link', O, D, '--mode', 'transit']);
  is(r.exitCode, 0, r.stderr);
  is(r.urls.length, 0);
  const u = new URL(r.stdout.trim());
  is(
    [
      u.searchParams.get('origin'),
      u.searchParams.get('destination'),
      u.searchParams.get('travelmode'),
    ],
    [O, D, 'transit']
  );
});

test('--help exits 0 and lists the options', async () => {
  const r = await run(['--help']);
  is(r.exitCode, 0);
  ok(/--depart/.test(r.stdout) && /--arrive/.test(r.stdout) && /--mode/.test(r.stdout), r.stdout);
});
