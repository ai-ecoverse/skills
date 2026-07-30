// metaculus.jsh — Metaculus API client (forecasting questions + tournaments).
//
//   metaculus auth <token> | --show
//   metaculus me
//   metaculus mine [--status active|withdrawn|all] [--json]
//   metaculus questions [--search q] [--status open|closed|resolved|upcoming]
//                       [--type binary|multiple_choice|numeric|date|group]
//                       [--tournament <id|slug>] [--order-by <field>]
//                       [--limit n] [--offset n] [--json]
//   metaculus question <post_id> [--cp] [--json]
//   metaculus forecast <question_id> <prob> --confirm          binary (0.001–0.999)
//   metaculus forecast <question_id> --data '<json>' --confirm MC / continuous
//   metaculus withdraw <question_id> --confirm
//   metaculus comment <post_id> <text> [--private] [--parent <comment_id>]
//   metaculus comments [--post <id>] [--author me|<id>] [--limit n] [--json]
//   metaculus tournaments [--json]
//   metaculus tournament <id|slug> [--json]
//   metaculus api <METHOD> <path> [--data '<json>'] [--query k=v ...] [--json]
//
// Auth priority: --token <t> | METACULUS_TOKEN | skill config (`metaculus auth`).
// Get a token at https://www.metaculus.com/accounts/settings/ (API section).

const cli   = require('sliccy:cli');
const fmt   = require('sliccy:fmt');
const skill = require('sliccy:skill');

const BASE = 'https://www.metaculus.com/api';

function str(v) { return typeof v === 'string' ? v : undefined; }

// Collect every question the caller has forecast within a post, whether it is a
// single question, a group, or a conditional pair. Returns [{ q, mf }].
function questionsInPost(p) {
  const qs = [];
  if (p.question) qs.push(p.question);
  if (Array.isArray(p.group_of_questions)) qs.push(...p.group_of_questions);
  if (p.conditional) {
    if (p.conditional.question_yes) qs.push(p.conditional.question_yes);
    if (p.conditional.question_no) qs.push(p.conditional.question_no);
  }
  return qs.map((q) => ({ q, mf: q && q.my_forecasts && q.my_forecasts.latest }))
           .filter((x) => x.mf);
}

// ─── config / auth ──────────────────────────────────────────────────────────
async function loadConfig() { return (await skill.config()) || {}; }
async function saveConfig(u) { await skill.config({ ...(await loadConfig()), ...u }); }
async function getToken(override) {
  const t = override || process.env.METACULUS_TOKEN || (await loadConfig()).token;
  if (!t) cli.die('No API token. Run `metaculus auth <token>` or set METACULUS_TOKEN.\n' +
                  'Create one at https://www.metaculus.com/accounts/settings/');
  return t;
}

// ─── request helper ───────────────────────────────────────────────────────────
// Returns parsed JSON (or text). Throws {message,status} on non-2xx.
// SECURITY: the auth token is only ever attached to metaculus.com hosts, so an
// absolute URL pointing elsewhere (e.g. `metaculus api GET https://evil/`) can
// never leak the token.
function assertMetaculusHost(url) {
  let host;
  try { host = new URL(url).host; } catch { throw new Error(`invalid URL: ${url}`); }
  if (!/(^|\.)metaculus\.com$/i.test(host)) {
    throw new Error(`refusing to send credentials to non-Metaculus host: ${host}`);
  }
}
async function req(token, method, path, { query, body } = {}) {
  let url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path);
  assertMetaculusHost(url);
  if (query && Object.keys(query).length) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'Authorization': `Token ${token}` };
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.error || data.non_field_errors)) || text || res.statusText;
    const e = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    e.status = res.status;
    throw e;
  }
  return data;
}

// ─── formatting ─────────────────────────────────────────────────────────────
function questionRow(p) {
  const q = p.question || {};
  const type = q.type || (p.group_of_questions ? 'group' : (p.notebook ? 'notebook' : '?'));
  return [String(p.id), p.status || '', type, String(p.nr_forecasters ?? ''), fmt.trunc(p.title || '', 60)];
}

// ─── main ─────────────────────────────────────────────────────────────────────
const HELP = `metaculus — Metaculus forecasting API

  metaculus auth <token> | --show
  metaculus me
  metaculus mine [--status active|withdrawn|all] [--json]
  metaculus questions [--search q] [--status open|closed|resolved|upcoming]
                      [--type binary|multiple_choice|numeric|date|group]
                      [--tournament <id|slug>] [--order-by <field>]
                      [--limit n] [--offset n] [--json]
  metaculus question <post_id> [--cp] [--json]
  metaculus forecast <question_id> <prob> --confirm            binary, 0.001–0.999
  metaculus forecast <question_id> --data '<json>' --confirm   MC/continuous forecast object
  metaculus withdraw <question_id> --confirm
  metaculus comment <post_id> <text> [--private] [--parent <comment_id>]
  metaculus comments [--post <id>] [--author me|<id>] [--limit n] [--json]
  metaculus tournaments [--json]
  metaculus tournament <id|slug> [--json]
  metaculus api <METHOD> <path> [--data '<json>'] [--query k=v] [--json]

Auth: --token <t> | METACULUS_TOKEN | \`metaculus auth <token>\`.
Forecast payload shapes:
  binary          {"question":<id>,"probability_yes":0.65}
  multiple_choice {"question":<id>,"probability_yes_per_category":{"Yes":0.6,"No":0.4}}
  continuous      {"question":<id>,"continuous_cdf":[201 increasing values 0..1]}`;

async function main() {
  const { positional, flags } = process.argv.parseFlags();
  const [cmd] = positional;
  if (!cmd || flags.help || flags.h) return cli.help(HELP);

  // auth: no token needed
  if (cmd === 'auth') {
    if (flags.show) {
      const cfg = await loadConfig();
      if (!cfg.token) return cli.out('No token stored.');
      const t = cfg.token;
      return cli.out(`Stored token: ${t.slice(0, 6)}…${t.slice(-4)}`);
    }
    const token = str(flags.token) || positional[1];
    if (!token) return cli.die('usage: metaculus auth <token>  (or: metaculus auth --show)');
    await saveConfig({ token });
    return cli.out('API token saved to skill config.');
  }

  const token = await getToken(str(flags.token));

  switch (cmd) {
    case 'me': {
      const j = await req(token, 'GET', '/users/me/');
      if (flags.json) return cli.out(j);
      return cli.out({ id: j.id, username: j.username, joined: j.date_joined, email: j.email,
                       is_bot: j.is_bot, pro: j.metadata?.pro_details?.is_current_pro });
    }

    case 'questions': {
      const query = {
        limit: str(flags.limit) || 20,
        offset: str(flags.offset),
        search: str(flags.search),
        statuses: str(flags.status),
        forecast_type: str(flags.type),
        tournaments: str(flags.tournament),
        order_by: str(flags['order-by']),
      };
      const j = await req(token, 'GET', '/posts/', { query });
      if (flags.json) return cli.out(j);
      const rows = (j.results || []).map(questionRow);
      cli.out(fmt.table([['ID', 'STATUS', 'TYPE', 'FCASTERS', 'TITLE'], ...rows]));
      if (j.count != null) cli.out(`\n${rows.length} shown${j.count ? ` of ${j.count}` : ''}.`);
      return;
    }

    case 'question': {
      const id = str(flags.id) || positional[1];
      if (!id) return cli.die('usage: metaculus question <post_id> [--cp] [--json]');
      const j = await req(token, 'GET', `/posts/${id}/`, { query: { with_cp: flags.cp ? 'true' : undefined } });
      if (flags.json) return cli.out(j);
      const q = j.question || {};
      const out = {
        post_id: j.id,
        question_id: q.id,   // use THIS for `forecast`/`withdraw` (differs from post_id)
        title: j.title, type: q.type, status: j.status, resolved: j.resolved,
        nr_forecasters: j.nr_forecasters, open_time: j.open_time,
        scheduled_close_time: j.scheduled_close_time, scheduled_resolve_time: j.scheduled_resolve_time,
        resolution: q.resolution,
        // resolution rules matter for forecasting — surface them (agents need them)
        description: q.description || null,
        resolution_criteria: q.resolution_criteria || null,
        fine_print: q.fine_print || null,
        options: q.options || undefined,
        url: `https://www.metaculus.com/questions/${j.id}/`,
      };
      if (flags.cp) {
        const cp = q.aggregations?.recency_weighted?.latest;
        // A latest object may exist yet still have null centers (CP is gated
        // until you have forecast) — test centers explicitly, not just `cp`.
        out.community_prediction = (cp && cp.centers != null)
          ? { centers: cp.centers, forecaster_count: cp.forecaster_count }
          : 'not available via API (gated — use `metaculus-ext cp ' + j.id + '` with a logged-in browser tab)';
      }
      // Surface the caller's own forecast + whether it is still active. Metaculus
      // auto-withdraws stale forecasts (prediction expiration), but a forecast can
      // also be withdrawn manually — both leave end_time in the past, and the API
      // doesn't distinguish them, so we only assert "withdrawn", not the cause.
      const mine = q.my_forecasts?.latest;
      if (mine) {
        const nowS = Date.now() / 1000;
        const active = mine.end_time == null || mine.end_time > nowS;
        out.my_forecast = {
          probability_yes: (mine.forecast_values || [])[1] ?? null,
          active,
          status: active ? 'active' : 'withdrawn or expired',
          end_time: mine.end_time ? new Date(mine.end_time * 1000).toISOString() : null,
        };
      }
      return cli.out(out);
    }

    case 'mine': {
      // List the caller's forecasts on currently-open questions, flagging which
      // are still active vs auto-withdrawn (Metaculus expires stale forecasts).
      const me = await req(token, 'GET', '/users/me/');
      const want = (str(flags.status) || 'active').toLowerCase(); // active|withdrawn|all
      const nowS = Date.now() / 1000;
      const rows = [];
      for (let offset = 0; offset < 2000; offset += 50) {
        const j = await req(token, 'GET', '/posts/', {
          query: { forecaster_id: me.id, statuses: 'open', with_cp: 'true', limit: 50, offset },
        });
        const res = j.results || [];
        for (const p of res) {
          for (const { q, mf } of questionsInPost(p)) {
            const active = mf.end_time == null || mf.end_time > nowS;
            if (want === 'active' && !active) continue;
            if (want === 'withdrawn' && active) continue;
            rows.push({
              post_id: p.id, question_id: q.id, type: q.type,
              probability_yes: q.type === 'binary' ? (mf.forecast_values || [])[1] ?? null : null,
              active, title: q.title && q.title !== p.title ? `${p.title} — ${q.title}` : p.title,
            });
          }
        }
        if (res.length < 50) break;
      }
      if (flags.json) return cli.out({ count: rows.length, status: want, forecasts: rows });
      const table = rows.map((r) => [String(r.post_id), r.active ? 'active' : 'withdrawn', r.type || '',
        r.probability_yes != null ? `${(r.probability_yes * 100).toFixed(0)}%` : '', fmt.trunc(r.title, 56)]);
      cli.out(fmt.table([['POST', 'STATUS', 'TYPE', 'P(yes)', 'TITLE'], ...table]));
      cli.out(`\n${rows.length} ${want} forecast(s).`);
      return;
    }

    case 'forecast': {
      const qid = str(flags.question) || positional[1];
      if (!qid) return cli.die('usage: metaculus forecast <question_id> <prob>  |  --data \'<json>\'');
      let entry;
      if (flags.data) {
        entry = JSON.parse(str(flags.data));
        // Reject a payload whose embedded question id contradicts the positional
        // id — otherwise we'd silently forecast on a different question.
        if (entry.question != null && Number(entry.question) !== Number(qid)) {
          return cli.die(`question id mismatch: positional ${qid} vs --data question ${entry.question}. ` +
            `Pass one, or make them match.`);
        }
        entry.question = Number(qid);
      } else {
        const prob = positional[2];
        if (prob == null) return cli.die('binary forecast needs a probability, e.g. `metaculus forecast 123 0.65`');
        entry = { question: Number(qid), probability_yes: Number(prob) };
      }
      // Forecasting is a real mutation against the user's track record — require
      // an explicit --confirm. Without it, preview the payload and stop.
      if (!flags.confirm) {
        cli.out({ preview: entry,
          note: 'This will submit a forecast on your Metaculus account. Re-run with --confirm to send it.' });
        return;
      }
      const j = await req(token, 'POST', '/questions/forecast/', { body: [entry] });
      return cli.out(flags.json ? j : { ok: true, submitted: entry, response: j });
    }

    case 'withdraw': {
      const qid = str(flags.question) || positional[1];
      if (!qid) return cli.die('usage: metaculus withdraw <question_id> [--confirm]');
      if (!flags.confirm) {
        cli.out({ preview: { withdraw_question: Number(qid) },
          note: 'This will withdraw your active forecast. Re-run with --confirm to proceed.' });
        return;
      }
      const j = await req(token, 'POST', '/questions/withdraw/', { body: [{ question: Number(qid) }] });
      return cli.out(flags.json ? j : { ok: true, withdrawn: Number(qid), response: j });
    }

    case 'comment': {
      const postId = str(flags.post) || positional[1];
      const text = str(flags.text) || positional.slice(2).join(' ');
      if (!postId || !text) return cli.die('usage: metaculus comment <post_id> <text> [--private] [--parent <id>]');
      const body = { on_post: Number(postId), text, is_private: !!flags.private };
      if (flags.parent) body.parent_id = Number(str(flags.parent));
      const j = await req(token, 'POST', '/comments/create/', { body });
      return cli.out(flags.json ? j : { ok: true, comment_id: j.id, on_post: Number(postId) });
    }

    case 'comments': {
      let author = str(flags.author);
      if (author === 'me') author = String((await req(token, 'GET', '/users/me/')).id);
      const query = { limit: str(flags.limit) || 20, offset: str(flags.offset),
                      post: str(flags.post), author };
      const j = await req(token, 'GET', '/comments/', { query });
      if (flags.json) return cli.out(j);
      const rows = (j.results || []).map((c) => [String(c.id),
        c.author?.username || '', (c.created_at || '').slice(0, 10),
        fmt.trunc((c.text || '').replace(/\s+/g, ' '), 70)]);
      return cli.out(fmt.table([['ID', 'AUTHOR', 'DATE', 'TEXT'], ...rows]));
    }

    case 'tournaments': {
      const j = await req(token, 'GET', '/projects/tournaments/');
      if (flags.json) return cli.out(j);
      const rows = (j || []).map((t) => [String(t.id), t.slug || '',
        t.prize_pool ? `$${t.prize_pool}` : '', fmt.trunc(t.name || '', 50)]);
      return cli.out(fmt.table([['ID', 'SLUG', 'PRIZE', 'NAME'], ...rows]));
    }

    case 'tournament': {
      const idOrSlug = str(flags.id) || positional[1];
      if (!idOrSlug) return cli.die('usage: metaculus tournament <id|slug>');
      const j = await req(token, 'GET', `/projects/tournaments/${idOrSlug}/`);
      if (flags.json) return cli.out(j);
      return cli.out({ id: j.id, name: j.name, slug: j.slug, prize_pool: j.prize_pool,
        questions_count: j.questions_count, start_date: j.start_date, close_date: j.close_date,
        is_ongoing: j.is_ongoing });
    }

    case 'api': {
      const method = (positional[1] || 'GET').toUpperCase();
      const path = positional[2];
      if (!path) return cli.die('usage: metaculus api <METHOD> <path> [--data \'<json>\'] [--query k=v]');
      const query = {};
      for (const q of [].concat(flags.query || [])) {
        const s = str(q); if (!s) continue;
        const i = s.indexOf('='); if (i > 0) query[s.slice(0, i)] = s.slice(i + 1);
      }
      const body = flags.data ? JSON.parse(str(flags.data)) : undefined;
      const j = await req(token, method, path, { query, body });
      return cli.out(j);
    }

    default:
      return cli.die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

await main().catch((e) => cli.die(e.message + (e.status ? ` (HTTP ${e.status})` : ''), { prefix: 'metaculus' }));
