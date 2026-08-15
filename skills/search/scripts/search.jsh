// search.jsh — multi-provider web search for SLICC agents.
//
// Queries Brave, Exa or Tavily and returns one normalized result shape so an
// agent can swap providers without changing its parsing:
//
//   { title, url, snippet, source: 'brave'|'exa'|'tavily', published?: <ISO 8601> }
//
// USAGE
//   search "<query>" [--provider brave|exa|tavily|auto] [-n N] [--type web|news]
//                    [--include-domains a,b] [--exclude-domains a,b] [--json] [--debug]
//
// AUTH (env only — no config file, nothing is persisted)
//   BRAVE_API_KEY | EXA_API_KEY | TAVILY_API_KEY
//   `auto` walks Brave → Exa → Tavily, taking the first provider that has a key
//   and falling through to the next one when a provider errors.
//
// Read-only and side-effect free: every command is a single search request.
//
// TODO(kagi): KAGI_API_KEY is documented as an optional future provider but is
// deliberately NOT wired up here. Kagi's Search API (POST-less GET
// https://kagi.com/api/v0/search, `Authorization: Bot <token>`, results under
// `data[]` with `t:0` = search result / `t:1` = related searches) is invite-only
// and metered per search, and adding it would widen the documented `source`
// union that agents already parse. Wire it in a follow-up that updates SKILL.md's
// output schema and the --provider list in the same change.

const cli = require('sliccy:cli');
const color = require('sliccy:color');

const PREFIX = 'search';

const HELP = `
search — multi-provider web search (Brave, Exa, Tavily)

USAGE
  search "<query>" [options]

OPTIONS
  --provider <brave|exa|tavily|auto>  Backend to use (default: auto)
  -n, --num <N>                       Number of results, 1-20 (default: 8)
  --type <web|news>                   Result type where supported (default: web)
  --include-domains <a,b>             Keep only results from these domains
  --exclude-domains <a,b>             Drop results from these domains
  --json                              Emit a JSON array instead of a human summary
  --debug                             Log provider/endpoint decisions to stderr
  -h, --help                          Show this help

AUTH (environment variables, or SLICC secrets exposed as env)
  BRAVE_API_KEY    Brave  — independent index, low latency, privacy
  EXA_API_KEY      Exa    — neural/semantic, research and discovery
  TAVILY_API_KEY   Tavily — LLM-optimized snippets for RAG

  auto uses the first provider that has a key, in the order Brave, Exa, Tavily,
  and falls through to the next one when a provider errors.

JSON OUTPUT
  [{ "title": "…", "url": "https://…", "snippet": "…",
     "source": "brave|exa|tavily", "published": "2026-01-31T00:00:00.000Z" }]
  "published" is omitted when the provider does not report a parseable date.

EXAMPLES
  search "Brave Search API pricing 2026"
  search "current status of the Bing Search API" --provider brave -n 5
  search "papers arguing RAG is obsolete" --provider exa --json
  search "LLM grounding best practices" --provider tavily --type news --json
  search "edge caching" --include-domains fastly.com,cloudflare.com --json
`.trim();

// ─── args ────────────────────────────────────────────────────────────────────

// Flag parsing is deliberately local rather than process.argv.parseFlags().
// The runtime helper has no boolean-flag allowlist, so it consumes the token
// after a bare boolean as that flag's value — with a free-form positional query
// `search --json "my query"` would swallow the query and leave nothing to search
// for. fj.jsh keeps a local parser for exactly this reason.
const BOOLEAN_FLAGS = new Set(['json', 'debug', 'help']);
const ALIASES = { n: 'num', h: 'help' };
const FLAG_RE = /^--?[A-Za-z]/;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!literal && a === '--') {
      literal = true;
      continue;
    }
    if (literal || !FLAG_RE.test(a)) {
      positional.push(a);
      continue;
    }
    let key = a.slice(a.startsWith('--') ? 2 : 1);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    key = ALIASES[key] || key;
    if (val === undefined) {
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || FLAG_RE.test(next)) val = true;
      else {
        val = next;
        i++;
      }
    }
    flags[key] = val;
  }
  return { positional, flags };
}

/** parseArgs yields boolean `true` for bare flags — only accept real strings. */
function str(v) {
  return typeof v === 'string' ? v : undefined;
}

/** "a.com, https://www.b.org/x" → ['a.com', 'b.org'] */
function splitList(v) {
  return (str(v) || '')
    .split(',')
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^[a-z]+:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#].*$/, '')
    )
    .filter(Boolean);
}

let DEBUG = false;
function debug(msg) {
  if (DEBUG) console.error(color.dim(`[${PREFIX}] ${msg}`));
}

// ─── text helpers ────────────────────────────────────────────────────────────

// The named entities that actually show up in search snippets; anything else is
// left verbatim rather than guessed at.
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
};

function decodeEntity(entity) {
  if (entity[0] === '#') {
    const code = entity[1] === 'x' || entity[1] === 'X'
      ? parseInt(entity.slice(2), 16)
      : parseInt(entity.slice(1), 10);
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return '';
  }
  const named = NAMED_ENTITIES[entity.toLowerCase()];
  return named === undefined ? `&${entity};` : named;
}

/** Brave descriptions carry <strong> markup and entities; keep snippets plain. */
function stripHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, e) => decodeEntity(e))
    .replace(/\s+/g, ' ')
    // Tags become spaces, so `<strong>x</strong>, y` would leave " ,".
    .replace(/ ([,.;:!?])/g, '$1')
    .trim();
}

/** Provider dates vary (ISO, RFC 1123, "3 days ago"). Emit ISO or nothing. */
function toIso(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

function trunc(s, max) {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function wrap(s, width) {
  const lines = [];
  let line = '';
  for (const word of s.split(' ')) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Host equal to, or a subdomain of, `domain` (www. is ignored on both sides). */
function hostMatches(url, domain) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  return host === domain || host.endsWith('.' + domain);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 20000;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(res) {
  const header = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_WAIT_MS);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_WAIT_MS);
    }
  }
  return 1000;
}

/** Best-effort human detail from an error body. Never contains the API key. */
function errorDetail(text) {
  if (!text) return '';
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return ' — ' + trunc(stripHtml(text), 200);
  }
  const msg =
    (body && body.error && (body.error.detail || body.error.message || body.error.meta)) ||
    (body && (body.detail || body.message || body.error));
  if (!msg) return '';
  return ' — ' + trunc(typeof msg === 'string' ? msg : JSON.stringify(msg), 200);
}

/**
 * One JSON request with an abort-based timeout and a single retry on the
 * transient statuses (honouring Retry-After). Throws Error with `.status` set
 * for HTTP failures so the caller can map 401/403 onto an auth hint.
 */
async function request(url, { method = 'GET', headers, body, label, timeoutMs = TIMEOUT_MS }) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if ((err && err.name === 'AbortError') || /abort/i.test(msg)) {
        throw new Error(`${label}: request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw new Error(`${label}: network error — ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (attempt === 0 && RETRY_STATUS.has(res.status)) {
      const wait = retryDelay(res);
      debug(`${label}: HTTP ${res.status}, retrying once in ${wait}ms`);
      await sleep(wait);
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      const err = new Error(
        `${label}: HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}${errorDetail(text)}`
      );
      err.status = res.status;
      throw err;
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${label}: response was not valid JSON (HTTP ${res.status})`);
    }
  }
}

// ─── providers ───────────────────────────────────────────────────────────────

const BRAVE_WEB = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_NEWS = 'https://api.search.brave.com/res/v1/news/search';
const EXA_SEARCH = 'https://api.exa.ai/search';
const TAVILY_SEARCH = 'https://api.tavily.com/search';

async function braveSearch(key, query, opts) {
  // Brave takes no structured domain filter — it understands `site:` / `-site:`
  // operators inside the query. Applied best-effort here; filterDomains() on the
  // way out is what actually guarantees the documented flag behaviour.
  let q = query;
  if (opts.includeDomains.length) {
    q += ' ' + opts.includeDomains.map((d) => `site:${d}`).join(' OR ');
  }
  if (opts.excludeDomains.length) {
    q += ' ' + opts.excludeDomains.map((d) => `-site:${d}`).join(' ');
  }

  const url = new URL(opts.type === 'news' ? BRAVE_NEWS : BRAVE_WEB);
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(opts.num));
  debug(`brave GET ${url.toString()}`);

  const data = await request(url.toString(), {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    label: 'brave',
  });

  // web → { web: { results: [...] } }; news → { results: [...] }
  const results =
    opts.type === 'news'
      ? data.results || (data.news && data.news.results) || []
      : (data.web && data.web.results) || data.results || [];

  return results.map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    snippet: stripHtml(r.description || r.snippet || ''),
    source: 'brave',
    published: toIso(r.page_age || r.age),
  }));
}

async function exaSearch(key, query, opts) {
  const body = {
    query,
    numResults: opts.num,
    type: 'auto',
    // Highlights are the token-efficient snippet; text is the fallback when a
    // page yields none.
    contents: {
      text: { maxCharacters: 800 },
      highlights: { numSentences: 2, highlightsPerUrl: 2 },
    },
  };
  if (opts.type === 'news') body.category = 'news';
  if (opts.includeDomains.length) body.includeDomains = opts.includeDomains;
  if (opts.excludeDomains.length) body.excludeDomains = opts.excludeDomains;
  debug(`exa POST ${EXA_SEARCH} (numResults=${opts.num}${body.category ? ', category=news' : ''})`);

  const data = await request(EXA_SEARCH, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify(body),
    label: 'exa',
  });

  return (data.results || []).map((r) => {
    const highlights = Array.isArray(r.highlights)
      ? r.highlights.filter((h) => typeof h === 'string' && h.trim())
      : [];
    return {
      title: stripHtml(r.title),
      url: r.url,
      snippet: stripHtml(highlights.length ? highlights.join(' … ') : r.text || r.summary || ''),
      source: 'exa',
      published: toIso(r.publishedDate),
    };
  });
}

async function tavilySearch(key, query, opts) {
  const body = {
    query,
    max_results: opts.num,
    search_depth: 'basic',
    topic: opts.type === 'news' ? 'news' : 'general',
    include_answer: false,
    include_raw_content: false,
  };
  if (opts.includeDomains.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains.length) body.exclude_domains = opts.excludeDomains;
  debug(`tavily POST ${TAVILY_SEARCH} (max_results=${opts.num}, topic=${body.topic})`);

  const data = await request(TAVILY_SEARCH, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    label: 'tavily',
  });

  return (data.results || []).map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    snippet: stripHtml(r.content || ''),
    source: 'tavily',
    published: toIso(r.published_date),
  }));
}

const PROVIDERS = {
  brave: { id: 'brave', env: 'BRAVE_API_KEY', search: braveSearch },
  exa: { id: 'exa', env: 'EXA_API_KEY', search: exaSearch },
  tavily: { id: 'tavily', env: 'TAVILY_API_KEY', search: tavilySearch },
};
// auto order: independent index first, then semantic, then RAG snippets.
const AUTO_ORDER = ['brave', 'exa', 'tavily'];

// ─── result handling ─────────────────────────────────────────────────────────

/**
 * Enforce the documented schema: drop entries without a URL, de-duplicate,
 * and omit `published` rather than emitting null.
 */
function normalize(raw) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(raw) ? raw : []) {
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const item = {
      title: r.title || url,
      url,
      snippet: r.snippet || '',
      source: r.source,
    };
    if (r.published) item.published = r.published;
    out.push(item);
  }
  return out;
}

/**
 * Client-side domain filter. Exa and Tavily filter server-side and Brave gets
 * `site:` operators, but only this pass makes the flags behave identically
 * across providers.
 */
function filterDomains(results, include, exclude) {
  let out = results;
  if (include.length) out = out.filter((r) => include.some((d) => hostMatches(r.url, d)));
  if (exclude.length) out = out.filter((r) => !exclude.some((d) => hostMatches(r.url, d)));
  return out;
}

function render(results, provider, query) {
  console.log('');
  console.log(`  ${color.bold(`Results for "${trunc(query, 70)}"`)} ${color.dim(`via ${provider}`)}`);
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!results.length) {
    console.log(color.dim('  No results found.'));
    console.log('');
    return;
  }
  results.forEach((r, i) => {
    const n = String(i + 1).padStart(2, ' ');
    const date = r.published ? '  ' + color.dim(r.published.slice(0, 10)) : '';
    console.log('');
    console.log(`  ${n}. ${color.cyan(color.bold(trunc(r.title, 96)))}`);
    console.log(`      ${color.dim(r.url)}${date}`);
    if (r.snippet) {
      for (const line of wrap(trunc(r.snippet, 320), 88)) console.log(`      ${line}`);
    }
  });
  console.log('');
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) cli.help(HELP);
  DEBUG = flags.debug === true;

  // A value-taking flag left holding `true` was written without a value
  // (`--provider --json`); fail loudly rather than silently using the default.
  for (const name of ['provider', 'type', 'num', 'include-domains', 'exclude-domains']) {
    if (flags[name] === true) {
      cli.die(`--${name} expects a value (use --${name}=<value> if the value starts with "-")`, {
        prefix: PREFIX,
      });
    }
  }

  const query = positional.join(' ').trim();
  if (!query) {
    cli.die(
      'missing query.\n' +
        '  usage: search "<query>" [--provider brave|exa|tavily|auto] [-n N] [--json]\n' +
        "  run 'search --help' for the full flag list.",
      { prefix: PREFIX }
    );
  }

  const provider = (str(flags.provider) || 'auto').toLowerCase();
  if (provider !== 'auto' && !PROVIDERS[provider]) {
    cli.die(`unknown --provider "${provider}" — expected brave, exa, tavily or auto`, {
      prefix: PREFIX,
    });
  }

  const type = (str(flags.type) || 'web').toLowerCase();
  if (type !== 'web' && type !== 'news') {
    cli.die(`unknown --type "${type}" — expected web or news`, { prefix: PREFIX });
  }

  let num = 8;
  if (flags.num !== undefined) {
    const parsed = Number(str(flags.num));
    if (!Number.isFinite(parsed)) {
      cli.die('-n/--num expects a number between 1 and 20', { prefix: PREFIX });
    }
    num = Math.min(Math.max(Math.trunc(parsed), 1), 20);
  }

  const opts = {
    num,
    type,
    includeDomains: splitList(flags['include-domains']),
    excludeDomains: splitList(flags['exclude-domains']),
  };

  // Provider chain: an explicit --provider never falls back (a silent switch
  // would misattribute results); auto walks every provider that has a key.
  let chain;
  if (provider === 'auto') {
    chain = AUTO_ORDER.filter((id) => process.env[PROVIDERS[id].env]);
    if (!chain.length) {
      cli.die(
        'no search provider API key found.\n' +
          '  Set at least one of:\n' +
          '    export BRAVE_API_KEY=…    (https://api-dashboard.search.brave.com)\n' +
          '    export EXA_API_KEY=…      (https://dashboard.exa.ai)\n' +
          '    export TAVILY_API_KEY=…   (https://app.tavily.com)',
        { prefix: PREFIX }
      );
    }
  } else {
    if (!process.env[PROVIDERS[provider].env]) {
      cli.die(
        `--provider ${provider} needs ${PROVIDERS[provider].env}.\n` +
          `  export ${PROVIDERS[provider].env}=…  (or drop --provider to use auto)`,
        { prefix: PREFIX }
      );
    }
    chain = [provider];
  }
  debug(`chain=${chain.join(' → ')} type=${type} num=${num}`);

  let results = null;
  let used = null;
  const failures = [];
  for (const id of chain) {
    const p = PROVIDERS[id];
    try {
      results = normalize(await p.search(process.env[p.env], query, opts));
      used = id;
      break;
    } catch (err) {
      if (err && err.name === 'NodeExitError') throw err;
      let message = err && err.message ? err.message : String(err);
      if (err && (err.status === 401 || err.status === 403)) {
        message += `\n  ${p.env} was rejected — check that the key is valid and its plan covers this endpoint.`;
      }
      failures.push(`${id}: ${message}`);
      if (chain.length > 1) cli.warn(`${id} failed, trying next provider — ${message}`);
    }
  }

  if (used === null) {
    cli.die(
      failures.length === 1 ? failures[0] : 'every provider failed:\n  ' + failures.join('\n  '),
      { prefix: PREFIX }
    );
  }

  const filtered = filterDomains(results, opts.includeDomains, opts.excludeDomains).slice(0, num);
  debug(`${used} returned ${results.length} result(s), ${filtered.length} after filtering`);

  // Empty is a successful search, not an error.
  if (flags.json) cli.out(filtered);
  else render(filtered, used, query);
}

await main().catch((err) => {
  if (err && err.name === 'NodeExitError') throw err; // mandatory re-throw
  cli.die(err && err.message ? err.message : String(err), { prefix: PREFIX });
});
