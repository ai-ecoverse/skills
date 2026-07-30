// metaculus-ext.jsh — SLICC-only extensions to the `metaculus` skill that are
// NOT expressible through the public Metaculus API. Kept in a separate binary
// (`metaculus-ext`) so `metaculus` itself stays a clean API client.
//
//   metaculus-ext cp <post_id> [post_id...] [--json]
//       Community prediction for one or more questions.
//   metaculus-ext divergence [--min-forecasters N] [--limit N]
//                            [--include-withdrawn] [--json]
//       Rank YOUR active binary forecasts by how far they sit from the crowd.
//
// WHY: Metaculus strips the community-prediction aggregations from API
// responses (`aggregations.recency_weighted.latest` comes back null for a
// normal API token — the same gating as the restricted `aggregation_explorer`
// endpoint). The website still shows the CP because it is server-rendered into
// the page. So, exactly like gcloud-ext replays the Console's private billing
// API from a logged-in tab, this replays the *page* fetch from a logged-in
// metaculus.com browser tab and reads the CP out of the embedded Next.js flight
// data. It needs an open, logged-in www.metaculus.com tab.
//
// Caveat: this parses an undocumented server-rendered payload. If Metaculus
// changes its page structure this may break — re-inspect a question page's
// `"recency_weighted":{ ... "latest": ...}` block and update extractCp().

const cli     = require('sliccy:cli');
const fmt     = require('sliccy:fmt');
const skill   = require('sliccy:skill');
const c       = require('sliccy:color');
const browser = require('sliccy:browser');

const API = 'https://www.metaculus.com/api';

function str(v) { return typeof v === 'string' ? v : undefined; }
function num(v, d) { const n = Number(str(v)); return Number.isFinite(n) ? n : d; }

// ─── token-backed API (reuses the metaculus skill config) ────────────────────
async function getToken() {
  const t = process.env.METACULUS_TOKEN || ((await skill.config()) || {}).token;
  if (!t) cli.die('No API token. Run `metaculus auth <token>` first.', { prefix: 'metaculus-ext' });
  return t;
}
async function api(token, path, query) {
  let url = API + path;
  if (query) {
    const qs = Object.entries(query).filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  // credentials only ever go to metaculus.com
  if (!/(^|\.)metaculus\.com$/i.test(new URL(url).host)) throw new Error('refusing non-metaculus host');
  const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json();
}

// ─── browser session: read CP out of the server-rendered question page ────────
async function findTab() {
  const tab = await browser.findTab({ urlMatch: /(^|\.)metaculus\.com/ });
  if (!tab) cli.die(
    'No logged-in metaculus.com tab found.\n' +
    'Open https://www.metaculus.com (signed in) and retry.', { prefix: 'metaculus-ext' });
  return tab;
}

// Fetch CP for a batch of post ids from inside the logged-in tab. Returns
// { <id>: { centers:[...], fc:<n> } | { err } }. Parsing note: the CP lives in
// the SSR flight data as `"recency_weighted":{...,"latest":{...,"forecaster_count":N,...,"centers":[...]}}`.
// `String.fromCharCode(34)` = `"`, `(92)` = `\` — avoids quote-escaping hell.
async function fetchCpBatch(tab, ids, conc = 6) {
  const src = `
    (async () => {
      const IDS = ${JSON.stringify(ids)};
      const Q = String.fromCharCode(34), BS = String.fromCharCode(92);
      const out = {};
      let i = 0;
      async function worker() {
        while (i < IDS.length) {
          const id = IDS[i++];
          try {
            const res = await fetch('/questions/' + id + '/', { credentials: 'include' });
            const html = await res.text();
            const u = html.split(BS + Q).join(Q).split(BS + 'n').join('').split(BS + BS).join(BS);
            const key = Q + 'recency_weighted' + Q + ':{';
            const idx = u.indexOf(key);
            let centers = null, fc = null;
            if (idx >= 0) {
              const li = u.indexOf(Q + 'latest' + Q, idx);
              if (li >= 0) {
                const chunk = u.slice(li, li + 500);
                const fm = chunk.match(new RegExp(Q + 'forecaster_count' + Q + ':(\\\\d+)'));
                const cm = chunk.match(new RegExp(Q + 'centers' + Q + ':' + BS + '[([^' + BS + ']]*)' + BS + ']'));
                if (fm) fc = Number(fm[1]);
                if (cm) centers = cm[1].split(',').map(Number);
              }
            }
            out[id] = { centers, fc };
          } catch (e) { out[id] = { err: String(e) }; }
        }
      }
      await Promise.all(Array.from({ length: ${conc} }, worker));
      return out;
    })()
  `;
  return browser.evalAsync(tab, src);
}

// chunk helper
function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }

async function cpForIds(ids) {
  const tab = await findTab();
  const results = {};
  for (const c of chunk(ids, 24)) {
    const r = await fetchCpBatch(tab, c);
    Object.assign(results, r || {});
  }
  return results;
}

// ─── commands ─────────────────────────────────────────────────────────────────
async function cmdCp(ids, flags) {
  if (!ids.length) cli.die('usage: metaculus-ext cp <post_id> [post_id...]', { prefix: 'metaculus-ext' });
  const res = await cpForIds(ids.map(Number));
  if (flags.json) return cli.out(res);
  const rows = ids.map((id) => {
    const r = res[id] || {};
    const cp = r.centers && r.centers.length === 1 ? `${(r.centers[0] * 100).toFixed(1)}%`
      : r.centers ? `[${r.centers.map((x) => (x * 100).toFixed(0) + '%').join(', ')}]`
      : (r.err ? 'error' : 'n/a');
    return [String(id), cp, r.fc != null ? String(r.fc) : ''];
  });
  cli.out(fmt.table([['POST', 'COMMUNITY', 'FORECASTERS'], ...rows]));
}

async function cmdDivergence(flags) {
  const token = await getToken();
  const me = await api(token, '/users/me/');
  const minF = num(flags['min-forecasters'], 0);
  const limit = num(flags.limit, 15);

  // 1. Pull all my open forecasts (with my_forecasts + end_time).
  const mine = [];
  const nowS = Date.now() / 1000;
  for (let offset = 0; offset < 1000; offset += 50) {
    const j = await api(token, '/posts/', {
      forecaster_id: me.id, statuses: 'open', with_cp: 'true', limit: 50, offset,
    });
    const res = j.results || [];
    for (const p of res) {
      const q = p.question || {};
      const mf = q.my_forecasts && q.my_forecasts.latest;
      if (!mf || q.type !== 'binary') continue;               // v1: binary only
      const active = mf.end_time == null || mf.end_time > nowS;
      if (!active && !flags['include-withdrawn']) continue;    // current forecasts only
      const pyes = (mf.forecast_values || [])[1];
      if (pyes == null) continue;
      mine.push({ id: p.id, title: p.title, pyes, active });
    }
    if (res.length < 50) break;
  }
  if (!mine.length) cli.die('No active binary forecasts found.', { prefix: 'metaculus-ext' });

  // 2. Fetch the community prediction for each from the logged-in tab.
  const cp = await cpForIds(mine.map((m) => m.id));

  // 3. Compute signed divergence (me − crowd).
  const rows = [];
  for (const m of mine) {
    const r = cp[m.id];
    if (!r || !r.centers || r.centers.length !== 1) continue;
    if (r.fc != null && r.fc < minF) continue;
    const crowd = r.centers[0];
    rows.push({ ...m, crowd, fc: r.fc, div: m.pyes - crowd, adiv: Math.abs(m.pyes - crowd) });
  }
  rows.sort((a, b) => b.adiv - a.adiv);
  const top = rows.slice(0, limit);

  if (flags.json) return cli.out({ compared: rows.length, active_total: mine.length, rows: top });

  cli.out('');
  cli.out(`  ${c.dim(`${rows.length} of your ${mine.length} active binary forecasts have a community prediction`)}`);
  cli.out('');
  const body = top.map((r) => {
    const dir = r.div > 0 ? c.green('▲ higher') : c.red('▼ lower');
    return [
      `${(r.adiv * 100).toFixed(0)}pp`,
      `${(r.pyes * 100).toFixed(0)}%`,
      `${(r.crowd * 100).toFixed(0)}%`,
      r.fc != null ? String(r.fc) : '',
      dir,
      fmt.trunc(r.title, 52),
    ];
  });
  cli.out(fmt.table([['Δ', 'YOU', 'CROWD', 'f', 'DIR', 'QUESTION'], ...body]));
}

// ─── main ─────────────────────────────────────────────────────────────────────
const HELP = `
metaculus-ext — SLICC-only extensions to the metaculus skill (not public API).

USAGE
  metaculus-ext cp <post_id> [post_id...] [--json]
      Community prediction for one or more questions.

  metaculus-ext divergence [--min-forecasters N] [--limit N]
                           [--include-withdrawn] [--json]
      Rank YOUR active binary forecasts by distance from the community
      prediction (the real "out on a limb" metric). By default only counts
      forecasts you're currently making (skips auto-withdrawn ones).

Both read the community prediction from a logged-in www.metaculus.com browser
tab (the API omits it). Open metaculus.com signed in, then run these.

EXAMPLES
  metaculus-ext cp 44798 19453
  metaculus-ext divergence --min-forecasters 20 --limit 20
`.trim();

async function main() {
  const { positional, flags } = process.argv.parseFlags();
  const [cmd, ...rest] = positional;
  if (!cmd || flags.help || flags.h || cmd === 'help') return cli.help(HELP);
  switch (cmd) {
    case 'cp':          return cmdCp(rest, flags);
    case 'divergence':  return cmdDivergence(flags);
    default:            return cli.die(`unknown command: ${cmd}\n\n${HELP}`, { prefix: 'metaculus-ext' });
  }
}

await main().catch((e) => cli.die(e.message, { prefix: 'metaculus-ext' }));
