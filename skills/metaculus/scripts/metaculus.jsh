// metaculus.jsh — Metaculus API client (forecasting questions + tournaments).
//
//   metaculus auth <token> | --show
//   metaculus me
//   metaculus questions [--search q] [--status open|closed|resolved|upcoming]
//                       [--type binary|multiple_choice|numeric|date|group]
//                       [--tournament <id|slug>] [--order-by <field>]
//                       [--limit n] [--offset n] [--json]
//   metaculus question <post_id> [--cp] [--json]
//   metaculus forecast <question_id> <prob>          binary (0.001–0.999)
//   metaculus forecast <question_id> --data '<json>' MC / continuous
//   metaculus withdraw <question_id>
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
async function req(token, method, path, { query, body } = {}) {
  let url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path);
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
  metaculus questions [--search q] [--status open|closed|resolved|upcoming]
                      [--type binary|multiple_choice|numeric|date|group]
                      [--tournament <id|slug>] [--order-by <field>]
                      [--limit n] [--offset n] [--json]
  metaculus question <post_id> [--cp] [--json]
  metaculus forecast <question_id> <prob>            binary, 0.001–0.999
  metaculus forecast <question_id> --data '<json>'   MC/continuous forecast object
  metaculus withdraw <question_id>
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
        resolution: q.resolution, url: `https://www.metaculus.com/questions/${j.id}/`,
      };
      if (flags.cp) {
        const cp = q.aggregations?.recency_weighted?.latest;
        out.community_prediction = cp
          ? { centers: cp.centers, forecaster_count: cp.forecaster_count }
          : 'not available (Metaculus hides the community prediction until you have forecast on this question)';
      }
      return cli.out(out);
    }

    case 'forecast': {
      const qid = str(flags.question) || positional[1];
      if (!qid) return cli.die('usage: metaculus forecast <question_id> <prob>  |  --data \'<json>\'');
      let entry;
      if (flags.data) {
        entry = JSON.parse(str(flags.data));
        if (entry.question == null) entry.question = Number(qid);
      } else {
        const prob = positional[2];
        if (prob == null) return cli.die('binary forecast needs a probability, e.g. `metaculus forecast 123 0.65`');
        entry = { question: Number(qid), probability_yes: Number(prob) };
      }
      const j = await req(token, 'POST', '/questions/forecast/', { body: [entry] });
      return cli.out(flags.json ? j : { ok: true, submitted: entry, response: j });
    }

    case 'withdraw': {
      const qid = str(flags.question) || positional[1];
      if (!qid) return cli.die('usage: metaculus withdraw <question_id>');
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
