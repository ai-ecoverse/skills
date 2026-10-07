/**
 * gmaps — Google Maps directions via the Maps web app's own backend endpoint.
 *
 * Usage:
 *   gmaps route <from> <to> [--mode m] [--depart T | --arrive T] [--json]
 *   gmaps link  <from> <to> [--mode m]
 *
 * Backend (reverse-engineered 2026-10-06, see references/internals.md):
 *   GET https://www.google.com/maps/preview/directions?hl=en&pb=<protobuf-url>
 * Needs no cookie, no key and no browser tab. The minimal request was found by
 * removing one field at a time from a request captured in a real Maps tab:
 *   !1m2!1s<origin>!6e0 !1m2!1s<destination>!6e0 !6m<n>!20m2!1e<mode>!2e3[!19m…]
 * The response is JSON behind a `)]}'` guard line, made of positional arrays
 * with no field names. Every index used below is named in PATH, so a Google
 * change shows up as one clear error instead of a quiet wrong answer.
 */

const cli = require('sliccy:cli');

const MODES = { driving: 0, bicycling: 1, walking: 2, transit: 3 };
const ORDER = ['walking', 'transit', 'bicycling', 'driving'];
const ENDPOINT = 'https://www.google.com/maps/preview/directions';
// Some requests never answer (measured 2026-10-06: Munich→Freising and London→Oxford driving hung
// for minutes while other routes answered in ~1 s). The realm fetch ignores AbortSignal, so the
// whole request+body read is raced against a timer instead.
const TIMEOUT_MS = Number(process.env.GMAPS_TIMEOUT_MS) || 20000;

function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${ms / 1000}s`), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const HELP = `gmaps — Google Maps directions (no browser tab needed)

Usage:
  gmaps route <from> <to> [options]   Routes with time, distance, and transit legs
  gmaps link  <from> <to> [--mode m]  Print the shareable Google Maps URL

Options:
  --mode <m>       walking | transit | bicycling | driving | all   (default: all)
  --depart <t>     Leave at <t>: "19:00" (today on this machine) or "2026-10-07T08:30"
  --arrive <t>     Arrive by <t> (same formats)
  --json           Machine-readable output
  --help           This help

Times are local wall-clock time at the trip. Without --depart/--arrive, routes
are for leaving now (live traffic, live transit departures).

Examples:
  gmaps route "Levelingstraße 2, München" "Ostbahnhof München"
  gmaps route "Marienplatz München" "Munich Airport" --mode transit --arrive 08:00`;

// ─── args ───────────────────────────────────────────────────────────────────
// Not process.argv.parseFlags(): it has no notion of boolean flags, so a long flag swallows
// the next word as its value. Measured: `gmaps route --json A B` parsed as {json: "A"} with
// only "B" left as a place. Knowing which flags take a value is the whole fix.
const VALUE_FLAGS = new Set(['mode', 'depart', 'arrive']);
const BOOL_FLAGS = new Set(['json', 'help']);

function parseArgs(argv) {
  const pos = [];
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a === '-h') { f.help = true; continue; }
    if (!a.startsWith('--')) {
      if (a.startsWith('-') && a.length > 1) cli.die(`unknown option ${a}\n\n${HELP}`, { prefix: 'gmaps', exitCode: 2 });
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (BOOL_FLAGS.has(name) && eq < 0) f[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
      if (v === undefined || v === '' || (eq < 0 && v.startsWith('--'))) cli.die(`--${name} needs a value`, { prefix: 'gmaps', exitCode: 2 });
      f[name] = v;
    } else cli.die(`unknown option ${a}\n\n${HELP}`, { prefix: 'gmaps', exitCode: 2 });
  }
  return { pos, f };
}

// "19:00" | "2026-10-07T08:30" | "2026-10-07 08:30" → seconds of LOCAL wall-clock time encoded
// as if it were UTC. That is what Maps puts in `!3j`: 19:00 in Munich is sent as 19:00Z.
function wallClock(spec, flag) {
  const hm = spec.match(/^(\d{1,2}):(\d{2})$/);
  const full = spec.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
  let y, mo, d, h, mi;
  if (hm) {
    // HH:MM takes TODAY'S DATE ON THIS MACHINE. The trip timezone is unknown until Google answers,
    // so for a trip in another timezone near midnight this can be the wrong day; the resolved date
    // is printed in the header and in --json `time`, and an explicit date avoids it (Codex review).
    const now = new Date();
    [y, mo, d] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
    [h, mi] = [Number(hm[1]), Number(hm[2])];
  } else if (full) {
    [y, mo, d, h, mi] = full.slice(1).map(Number);
  } else {
    cli.die(`${flag} '${spec}': use HH:MM or YYYY-MM-DDTHH:MM`, { prefix: 'gmaps', exitCode: 2 });
  }
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  // Date.UTC normalises 2026-02-31 to March 3; a round-trip check rejects it instead (Codex review).
  if (h > 23 || mi > 59 || back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    cli.die(`${flag} '${spec}': not a valid date/time`, { prefix: 'gmaps', exitCode: 2 });
  }
  return { secs: ms / 1000, label: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

// ─── request ────────────────────────────────────────────────────────────────
// pb string values escape '*' and '!' as *2A / *21 (Maps' own encoding), then URL-encode.
const pbStr = s => s.replace(/\*/g, '*2A').replace(/!/g, '*21');
const urlEnc = s => encodeURIComponent(s).replace(/%21/g, '!');

function buildPb(from, to, mode, time) {
  let inner = `!20m2!1e${MODES[mode]}!2e3`;
  if (time) inner += time.arrive ? `!19m3!1e1!2e2!3j${time.secs}` : `!19m2!2e2!3j${time.secs}`;
  const n = inner.split('!').length - 1;
  return `!1m2!1s${pbStr(from)}!6e0!1m2!1s${pbStr(to)}!6e0!6m${n}${inner}`;
}

async function fetchRoutes(from, to, mode, time) {
  const url = `${ENDPOINT}?hl=en&pb=${urlEnc(buildPb(from, to, mode, time))}`;
  let res;
  let text;
  try {
    [res, text] = await withTimeout(
      fetch(url).then(async (r) => [r, await r.text()]),
      TIMEOUT_MS
    );
  } catch (e) {
    if (e?.name === 'TimeoutError') return { mode, error: `Google gave ${e.message} — try again` };
    return { mode, error: `network error: ${e.message}` };
  }
  if (!res.ok) return { mode, error: `Google answered HTTP ${res.status}` };
  let j;
  try {
    j = JSON.parse(text.replace(/^\)\]\}'\s*\n/, ''));
  } catch (_) {
    return { mode, error: 'response was not JSON — the endpoint may have changed (see references/internals.md)' };
  }
  return decode(j, mode);
}

// ─── response decoding (positional; every path documented in internals.md) ──
const at = (v, ...p) => p.reduce((x, k) => (x == null ? undefined : x[k]), v);

// [epochSecs, "Europe/Berlin", "4:32 PM", utcOffsetSecs, ...] → "16:32"
function clock(t) {
  if (!Array.isArray(t) || typeof t[0] !== 'number') return null;
  const d = new Date((t[0] + (t[3] || 0)) * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function placeName(wp) {
  const parts = at(wp, 0, 1, 0);
  return Array.isArray(parts) && parts.length ? parts.join(', ') : at(wp, 0, 0, 0);
}

function decodeLeg(seg) {
  const s = seg[0];
  const kind = at(s, 14, 0, 2, 3) || 'Step';
  const leg = { mode: kind, duration: at(s, 3, 1) || null, seconds: at(s, 3, 0) ?? null };
  if (kind === 'Walk') {
    leg.distance = at(s, 2, 1) || null;
    return leg;
  }
  const tags = at(s, 14) || [];
  const line = tags.filter(t => t && t[0] === 5).map(t => at(t, 1, 0)).filter(Boolean);
  const head = tags.find(t => t && t[0] === 7);
  if (line.length) leg.line = line.join('/');
  if (head) leg.headsign = at(head, 1, 0);
  leg.from = at(s, 6, 0) || null;
  leg.to = at(s, 6, 1) || null;
  leg.departs = clock(at(s, 6, 12, 3));
  leg.arrives = clock(at(s, 6, 13, 2));
  const stops = at(s, 6, 14);
  if (Array.isArray(stops)) leg.stops = stops.length + 1;
  return leg;
}

const LAYOUT = 'unexpected response layout — the endpoint may have changed (see references/internals.md)';

function decode(j, mode) {
  // Validate the envelope first. Without this, an error envelope or a moved container decodes as
  // "no waypoints, no routes" and reports a legitimate-looking "no route" (Codex review, PR #476).
  const wps = at(j, 0, 0);
  if (!Array.isArray(wps) || wps.length < 2 || !wps.every((w) => typeof at(w, 0, 0, 0) === 'string')) {
    return { mode, routes: [], error: LAYOUT };
  }
  const routesBox = at(j, 0, 1);
  if (routesBox != null && !Array.isArray(routesBox)) return { mode, routes: [], error: LAYOUT };
  const from = placeName(wps[0]);
  const to = placeName(wps[1]);
  const unknown = wps.map((w, i) => (at(w, 0, 0, 2) ? null : [at(w, 0, 0, 0), i])).filter(Boolean);
  if (unknown.length) {
    return { mode, from, to, routes: [], error: unknown.map(([q]) => `Google Maps can't find "${q}" — add a city or postcode`).join('; ') };
  }
  const raw = routesBox || [];
  if (!raw.length) return { mode, from, to, routes: [], error: `no ${mode} route between these places` };
  const routes = raw.map(r => {
    const s = r[0];
    const out = {
      duration: at(s, 3, 1) || null,
      seconds: at(s, 3, 0) ?? null,
      distance: at(s, 2, 1) || null,
      meters: at(s, 2, 0) ?? null,
    };
    if (mode === 'transit') {
      out.departs = clock(at(s, 5, 0));
      out.arrives = clock(at(s, 5, 1));
      if (at(s, 11, 1)) out.fare = at(s, 11, 1);
      if (at(s, 1)) out.headway = at(s, 1);
      out.legs = (at(r, 1, 0, 1) || []).map(decodeLeg);
    } else if (at(s, 1)) {
      out.via = at(s, 1);
    }
    if (mode === 'driving' && at(s, 10, 4, 2)) out.typical = at(s, 10, 4, 2);
    return out;
  });
  if (routes.every(r => !r.duration)) {
    return { mode, from, to, routes: [], error: 'routes came back without durations — the response layout changed (see references/internals.md)' };
  }
  return { mode, from, to, routes };
}

function mapsLink(from, to, mode) {
  const q = new URLSearchParams({ api: '1', origin: from, destination: to, travelmode: mode });
  return `https://www.google.com/maps/dir/?${q}`;
}

// ─── output ─────────────────────────────────────────────────────────────────
function legText(l) {
  if (l.mode === 'Walk') return `walk ${l.duration}`;
  return `${l.mode} ${l.line || ''}`.trim() + (l.departs ? ` ${l.departs}` : '') + (l.from ? ` from ${l.from}` : '');
}

function printHuman(results, timeNote) {
  const head = results.find(r => r.from);
  if (head) console.log(`${head.from}  →  ${head.to}${timeNote ? `   (${timeNote})` : ''}\n`);
  for (const r of results) {
    console.log(r.mode.toUpperCase());
    if (r.error) { console.log(`  ✗ ${r.error}\n`); continue; }
    r.routes.forEach((x, i) => {
      let line = `  ${i === 0 ? '★' : ' '} ${[x.duration, x.distance].filter(Boolean).join(' · ')}`;
      if (x.departs) line += `  ${x.departs}–${x.arrives}`;
      if (x.via) line += `  via ${x.via}`;
      if (x.typical) line += `  (typically ${x.typical})`;
      console.log(line);
      if (x.legs && x.legs.length) console.log(`      ${x.legs.map(legText).join(' → ')}`);
      const extra = [x.fare, x.headway].filter(Boolean);
      if (extra.length) console.log(`      ${extra.join(' · ')}`);
    });
    console.log('');
  }
  if (head) console.log(`Open in Maps: ${mapsLink(head.from, head.to, results[0].mode)}`);
}

// ─── main ───────────────────────────────────────────────────────────────────
const { pos, f } = parseArgs(process.argv.slice(2));
const [cmd, from, to, ...extra] = pos;
if (f.help || !cmd || cmd === 'help') { console.log(HELP); process.exit(0); }
if (cmd !== 'route' && cmd !== 'link') cli.die(`unknown command '${cmd}'\n\n${HELP}`, { prefix: 'gmaps', exitCode: 2 });
if (!from || !to) cli.die(`${cmd} needs <from> and <to>\n\n${HELP}`, { prefix: 'gmaps', exitCode: 2 });
if (extra.length) cli.die(`unexpected argument '${extra[0]}' — quote places that contain spaces`, { prefix: 'gmaps', exitCode: 2 });
const mode = (f.mode || 'all').toLowerCase();
if (mode !== 'all' && !(mode in MODES)) cli.die(`unknown mode '${mode}' (use ${ORDER.join(', ')} or all)`, { prefix: 'gmaps', exitCode: 2 });
const modes = mode === 'all' ? ORDER : [mode];

if (cmd === 'link') {
  for (const m of modes) console.log(modes.length > 1 ? `${m}\t${mapsLink(from, to, m)}` : mapsLink(from, to, m));
  process.exit(0);
}

if (f.depart && f.arrive) cli.die('use --depart or --arrive, not both', { prefix: 'gmaps', exitCode: 2 });
let time = null;
if (f.depart || f.arrive) {
  const w = wallClock(f.depart || f.arrive, f.depart ? '--depart' : '--arrive');
  time = { secs: w.secs, arrive: !!f.arrive, label: `${f.arrive ? 'arrive by' : 'depart'} ${w.label}` };
}

async function main() {
  const results = await Promise.all(modes.map(m => fetchRoutes(from, to, m, time)));
  if (f.json) {
    console.log(JSON.stringify(results.map(r => ({ ...r, url: mapsLink(r.from || from, r.to || to, r.mode), ...(time ? { time: time.label } : {}) })), null, 2));
  } else {
    printHuman(results, time ? time.label : null);
  }
  // Non-zero only when EVERY mode failed (also in --json mode), so one missing mode such as
  // "no transit here" does not fail a walking/driving answer.
  process.exit(results.every(r => r.error) ? 1 : 0);
}

try {
  await main();
} catch (err) {
  if (err?.name === 'NodeExitError') throw err;
  cli.die(err.message, { prefix: 'gmaps' });
}
