import test, { is, ok } from 'tst';
import * as _mod_0 from './jsh-runtime.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Behaviour tests for scripts/search.jsh, run against the .jsh runtime stub in
// jsh-runtime.js:
//
//   tst skills/search/tests/search.test.js
//
// Provider payloads below are hand-built from each vendor's documented response
// shape; they are fixtures, not captures of a live account.

const { runJsh, mockFetch } = _mod_0.default || _mod_0;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'search.jsh');

const run = (argv, env = {}, fetchImpl = mockFetch(failUnexpected)) =>
  runJsh(SCRIPT, argv, env, fetchImpl);

function failUnexpected(url) {
  throw new Error(`unexpected request to ${url}`);
}

/** Route by URL fragment; anything unmatched is an error. */
function route(map) {
  return mockFetch((url) => {
    for (const [fragment, body] of Object.entries(map)) {
      if (url.includes(fragment)) return body;
    }
    return failUnexpected(url);
  });
}

const BRAVE_WEB = {
  web: {
    results: [
      {
        title: 'Brave <strong>Search API</strong> pricing &amp; plans',
        url: 'https://brave.com/search/api/',
        description: 'Free tier of <strong>1 query/sec</strong>, then $5 CPM.',
        page_age: '2026-03-01T12:00:00Z',
      },
      {
        title: 'Reddit thread',
        url: 'https://www.reddit.com/r/search/x',
        description: 'people arguing',
        age: '3 days ago',
      },
    ],
  },
};

const EXA_BODY = {
  results: [
    {
      title: 'Is RAG obsolete?',
      url: 'https://arxiv.org/abs/2601.00001',
      publishedDate: '2026-01-15T00:00:00.000Z',
      text: 'long body text',
      highlights: ['Long-context models subsume retrieval.', 'But cost dominates.'],
    },
  ],
};

const TAVILY_BODY = {
  results: [
    {
      title: 'LLM grounding best practices',
      url: 'https://example.com/grounding',
      content: 'Ground every claim with a citation.',
      published_date: 'Mon, 03 Mar 2026 00:00:00 GMT',
      score: 0.9,
    },
  ],
};

// Kagi API v1 splits results into named arrays by type under `data`; the date
// field is `time`. (v0's heterogeneous data[] + `t` discriminator is gone.)
const KAGI_BODY = {
  meta: { trace: 'abc', node: 'us-east' },
  data: {
    search: [
      {
        url: 'https://practicaltypography.com/',
        title: 'Butterick&rsquo;s Practical Typography',
        snippet: 'A book about <b>typography</b>.',
        time: '2026-02-10T00:00:00Z',
      },
    ],
    related_search: [{ url: 'https://kagi.com/search?q=x', title: 'typography books' }],
  },
};

const KAGI_NEWS_BODY = {
  data: {
    news: [
      {
        url: 'https://news.example/typo',
        title: 'Type news',
        snippet: 'n',
        time: '2026-08-01T00:00:00Z',
      },
    ],
  },
};

// ── CLI surface ──────────────────────────────────────────────────────────────

test('--help prints usage and exits 0', async () => {
  const r = await run(['--help']);
  is(r.exitCode, 0);
  ok((/USAGE/).test(r.stdout));
  ok((/--provider/).test(r.stdout));
});

test('a missing query is an actionable error with an empty stdout', async () => {
  const r = await run(['--json'], { BRAVE_API_KEY: 'k' });
  is(r.exitCode, 1);
  ok((/missing query/).test(r.stderr));
  is(r.stdout, '');
});

test('a boolean flag before the query does not swallow it', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(
    ['--json', '--provider', 'brave', 'my multi word query'],
    {
      BRAVE_API_KEY: 'k',
    },
    f
  );
  is(r.exitCode, 0);
  is(new URL(f.calls[0].url).searchParams.get('q'), 'my multi word query');
});

test('bare positionals join into one query and -- ends flag parsing', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['multi', 'word', 'unquoted', '--json'], { BRAVE_API_KEY: 'k' }, f);
  is(new URL(f.calls[0].url).searchParams.get('q'), 'multi word unquoted');

  const f2 = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['--', '--not-a-flag', '--json'], { BRAVE_API_KEY: 'k' }, f2);
  is(new URL(f2.calls[0].url).searchParams.get('q'), '--not-a-flag --json');
});

test('a value-taking flag left without a value fails loudly', async () => {
  const r = await run(['q', '--provider', '--json'], { BRAVE_API_KEY: 'k' });
  is(r.exitCode, 1);
  ok((/--provider expects a value/).test(r.stderr));

  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const okRun = await run(['q', '--exclude-domains=-weird.com', '--json'], { BRAVE_API_KEY: 'k' }, f);
  is(okRun.exitCode, 0, 'the --flag=value form still accepts a leading dash');
});

test('unknown --provider and --type are rejected', async () => {
  const p = await run(['q', '--provider', 'google'], { BRAVE_API_KEY: 'k' });
  is(p.exitCode, 1);
  ok((/unknown --provider/).test(p.stderr));

  const t = await run(['q', '--type', 'video', '--json'], { BRAVE_API_KEY: 'k' });
  is(t.exitCode, 1);
  ok((/unknown --type/).test(t.stderr));
});

test('-n is clamped to 1..20 and rejects non-numbers', async () => {
  const hi = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['q', '-n', '999', '--json'], { BRAVE_API_KEY: 'k' }, hi);
  ok((/count=20/).test(hi.calls[0].url));

  const lo = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['q', '--num=0', '--json'], { BRAVE_API_KEY: 'k' }, lo);
  ok((/count=1/).test(lo.calls[0].url));

  const one = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['q', '-n', '1', '--json'], { BRAVE_API_KEY: 'k' }, one);
  is(JSON.parse(r.stdout).length, 1, '-n also truncates the returned list');

  const bad = await run(['q', '-n', 'many'], { BRAVE_API_KEY: 'k' });
  is(bad.exitCode, 1);
  ok((/expects a number/).test(bad.stderr));
});

// ── auth ─────────────────────────────────────────────────────────────────────

test('auto with no keys lists every expected env var', async () => {
  const r = await run(['test query', '--json'], {});
  is(r.exitCode, 1);
  for (const v of ['BRAVE_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'KAGI_API_KEY']) {
    ok((new RegExp(v)).test(r.stderr));
  }
});

test('an explicit provider without its key names that key', async () => {
  const r = await run(['q', '--provider', 'exa'], { BRAVE_API_KEY: 'k' });
  is(r.exitCode, 1);
  ok((/EXA_API_KEY/).test(r.stderr));
});

test('a 401 adds a key-specific hint and never echoes the key', async () => {
  const f = mockFetch(() => ({ status: 401, body: { message: 'invalid key' } }));
  const r = await run(['q', '--provider', 'tavily'], { TAVILY_API_KEY: 'sekrit' }, f);
  is(r.exitCode, 1);
  ok((/TAVILY_API_KEY was rejected/).test(r.stderr));
  ok(!r.stderr.includes('sekrit'));
});

// ── providers ────────────────────────────────────────────────────────────────

test('brave: request shape and normalized results', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['brave api pricing', '--json'], { BRAVE_API_KEY: 'bk' }, f);
  is(r.exitCode, 0);

  ok(f.calls[0].url.startsWith('https://api.search.brave.com/res/v1/web/search'));
  is(f.calls[0].init.headers['X-Subscription-Token'], 'bk');
  ok((/count=8/).test(f.calls[0].url));

  const data = JSON.parse(r.stdout);
  is(data.length, 2);
  is(Object.keys(data[0]), ['title', 'url', 'snippet', 'source', 'published']);
  is(data[0].source, 'brave');
  is(data[0].title, 'Brave Search API pricing & plans', 'tags and entities stripped');
  is(data[0].snippet, 'Free tier of 1 query/sec, then $5 CPM.');
  is(data[0].published, '2026-03-01T12:00:00.000Z');
  ok(!('published' in data[1]), '"3 days ago" is not a date — the key is omitted');
  ok(!r.stdout.includes('bk') && !r.stderr.includes('bk'), 'key never printed');
});

test('exa: POST body and highlight-first snippets', async () => {
  const f = route({ 'api.exa.ai': EXA_BODY });
  const r = await run(
    ['papers arguing RAG is obsolete', '--provider', 'exa', '--json'],
    {
      EXA_API_KEY: 'ek',
    },
    f
  );

  is(f.calls[0].init.method, 'POST');
  is(f.calls[0].init.headers['x-api-key'], 'ek');
  const body = JSON.parse(f.calls[0].init.body);
  is(body.query, 'papers arguing RAG is obsolete');
  is(body.numResults, 8);
  is(
    body.contents.highlights,
    true,
    'the deprecated {numSentences,…} object is not sent'
  );

  const data = JSON.parse(r.stdout);
  is(data[0].source, 'exa');
  is(data[0].snippet, 'Long-context models subsume retrieval. … But cost dominates.');
  is(data[0].published, '2026-01-15T00:00:00.000Z');
});

test('exa: falls back to text when a page yields no highlights', async () => {
  const f = route({
    'api.exa.ai': { results: [{ title: 'T', url: 'https://a.com', text: 'body text here' }] },
  });
  const r = await run(['q', '--provider', 'exa', '--json'], { EXA_API_KEY: 'ek' }, f);
  const data = JSON.parse(r.stdout);
  is(data[0].snippet, 'body text here');
  ok(!('published' in data[0]));
});

test('tavily: bearer auth, body shape, RFC 1123 date', async () => {
  const f = route({ 'api.tavily.com': TAVILY_BODY });
  const r = await run(
    ['best practices for LLM grounding', '--provider', 'tavily', '--json'],
    {
      TAVILY_API_KEY: 'tk',
    },
    f
  );

  is(f.calls[0].init.headers.Authorization, 'Bearer tk');
  const body = JSON.parse(f.calls[0].init.body);
  is(body.max_results, 8);
  is(body.topic, 'general');

  const data = JSON.parse(r.stdout);
  is(data[0].snippet, 'Ground every claim with a citation.');
  is(data[0].published, '2026-03-03T00:00:00.000Z');
});

test('kagi: v1 POST, Bearer auth, and normalized results', async () => {
  const f = route({ 'kagi.com': KAGI_BODY });
  const r = await run(
    ['the best essays on typography', '--provider', 'kagi', '--json'],
    { KAGI_API_KEY: 'kk' },
    f
  );
  is(r.exitCode, 0);

  is(f.calls[0].url, 'https://kagi.com/api/v1/search', 'v1, not the sunset v0');
  is(f.calls[0].init.method, 'POST');
  is(f.calls[0].init.headers.Authorization, 'Bearer kk', 'Bearer, not v0 Bot');
  const body = JSON.parse(f.calls[0].init.body);
  is(body.query, 'the best essays on typography');
  is(body.workflow, 'search');
  is(body.limit, 8);

  const data = JSON.parse(r.stdout);
  is(data.length, 1, 'only data.search[] — related_search is not a result');
  is(data[0].source, 'kagi');
  is(data[0].title, 'Butterick\u2019s Practical Typography');
  is(data[0].snippet, 'A book about typography.');
  is(data[0].published, '2026-02-10T00:00:00.000Z', 'mapped from `time`');
  ok(!r.stdout.includes('kk') && !r.stderr.includes('kk'));
});

test('kagi: --type news sends workflow news and reads data.news[]', async () => {
  const f = route({ 'kagi.com': KAGI_NEWS_BODY });
  const r = await run(
    ['q', '--provider', 'kagi', '--type', 'news', '--json'],
    { KAGI_API_KEY: 'kk' },
    f
  );
  is(r.exitCode, 0, r.stderr);
  is(JSON.parse(f.calls[0].init.body).workflow, 'news');
  const data = JSON.parse(r.stdout);
  is(data.length, 1);
  is(data[0].url, 'https://news.example/typo');
});

test('kagi: a news workflow falls back through interesting_news to search', async () => {
  const f = route({
    'kagi.com': {
      data: { interesting_news: [{ url: 'https://a.example/1', title: 'T', snippet: 's' }] },
    },
  });
  const r = await run(
    ['q', '--provider', 'kagi', '--type', 'news', '--json'],
    { KAGI_API_KEY: 'kk' },
    f
  );
  is(JSON.parse(r.stdout).length, 1);
});

test('kagi: error[] bodies are surfaced as readable text', async () => {
  // v1 puts the human text in `message`; v0 used `msg`. Both are read.
  const f = mockFetch(() => ({
    status: 401,
    body: {
      error: [{ code: 'search.unauthorized', message: 'Invalid API token', location: null }],
      data: null,
    },
  }));
  const r = await run(['q', '--provider', 'kagi'], { KAGI_API_KEY: 'bad' }, f);
  is(r.exitCode, 1);
  ok((/Invalid API token/).test(r.stderr));
  ok((/KAGI_API_KEY was rejected/).test(r.stderr));
});

test('kagi: a 400 invalid_token is an auth failure, and `errors` is read', async () => {
  // Live behaviour, not deducible from the spec: a rotated or v0-era Kagi token
  // answers HTTP 400 (not 401) and names the array `errors` where the OpenAPI
  // spec says `error`. Reading only the spec's key drops the message entirely.
  const f = mockFetch(() => ({
    status: 400,
    statusText: 'Bad Request',
    body: {
      errors: [{ code: 'general.invalid_token', message: 'Token signature failed to verify.' }],
    },
  }));
  const r = await run(['q', '--provider', 'kagi'], { KAGI_API_KEY: 'stale' }, f);
  is(r.exitCode, 1);
  ok((/Token signature failed to verify/).test(r.stderr), 'the plural key is read');
  ok((/KAGI_API_KEY was rejected/).test(r.stderr), '400 + invalid_token is an auth failure');
  ok(!r.stderr.includes('stale'));
});

test('a 400 that is not an auth problem is not blamed on the key', async () => {
  const f = mockFetch(() => ({
    status: 400,
    body: { errors: [{ code: 'search.invalid_query', message: 'query was empty' }] },
  }));
  const r = await run(['q', '--provider', 'kagi'], { KAGI_API_KEY: 'k' }, f);
  is(r.exitCode, 1);
  ok((/query was empty/).test(r.stderr));
  ok(!/was rejected/.test(r.stderr), 'the auth hint keys off the code, not any 400');
});

test('kagi is last in the auto chain, so cheaper providers win', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['q', '--json'], { KAGI_API_KEY: 'kk', BRAVE_API_KEY: 'bk' }, f);
  is(JSON.parse(r.stdout)[0].source, 'brave');
  ok(
    f.calls.every((c) => !c.url.includes('kagi.com')),
    'kagi is never billed here'
  );
});

test('kagi is still used by auto when it is the only key', async () => {
  const f = route({ 'kagi.com': KAGI_BODY });
  const r = await run(['q', '--json'], { KAGI_API_KEY: 'kk' }, f);
  is(r.exitCode, 0);
  is(JSON.parse(r.stdout)[0].source, 'kagi');
});

test('kagi domain filters use a native lens and are still enforced client-side', async () => {
  const f = route({ 'kagi.com': KAGI_BODY });
  const r = await run(
    [
      'q',
      '--provider',
      'kagi',
      '--include-domains',
      'example.org',
      '--exclude-domains',
      'practicaltypography.com',
      '--json',
    ],
    { KAGI_API_KEY: 'kk' },
    f
  );
  const body = JSON.parse(f.calls[0].init.body);
  is(body.lens.sites_included, ['example.org'], 'native lens, no site: operator');
  is(body.lens.sites_excluded, ['practicaltypography.com']);
  ok(!JSON.stringify(body).includes('site:'), 'v1 needs no query operators');
  is(JSON.parse(r.stdout), [], 'the client-side pass is authoritative');
});

test('--type news reaches the right knob on every provider', async () => {
  const brave = route({
    'api.search.brave.com': { results: [{ title: 'n', url: 'https://n.com', description: 'd' }] },
  });
  await run(
    ['q', '--provider', 'brave', '--type', 'news', '--json'],
    { BRAVE_API_KEY: 'k' },
    brave
  );
  ok((/\/res\/v1\/news\/search/).test(brave.calls[0].url));

  const exa = route({ 'api.exa.ai': EXA_BODY });
  await run(['q', '--provider', 'exa', '--type', 'news', '--json'], { EXA_API_KEY: 'k' }, exa);
  is(JSON.parse(exa.calls[0].init.body).category, 'news');

  const tavily = route({ 'api.tavily.com': TAVILY_BODY });
  await run(
    ['q', '--provider', 'tavily', '--type', 'news', '--json'],
    { TAVILY_API_KEY: 'k' },
    tavily
  );
  is(JSON.parse(tavily.calls[0].init.body).topic, 'news');

  const kagi = route({ 'kagi.com': KAGI_NEWS_BODY });
  await run(['q', '--provider', 'kagi', '--type', 'news', '--json'], { KAGI_API_KEY: 'k' }, kagi);
  is(JSON.parse(kagi.calls[0].init.body).workflow, 'news');
});

// ── provider chain ───────────────────────────────────────────────────────────

test('auto falls through to the next provider on failure', async () => {
  const f = mockFetch((url) => {
    if (url.includes('brave')) return { status: 500, body: { message: 'boom' } };
    if (url.includes('exa')) return EXA_BODY;
    return failUnexpected(url);
  });
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'a', EXA_API_KEY: 'b' }, f);
  is(r.exitCode, 0);
  is(JSON.parse(r.stdout)[0].source, 'exa');
  ok((/brave failed/).test(r.stderr));
  ok(!r.stdout.includes('brave failed'), 'warnings stay off stdout');
});

test('an explicit provider never silently falls back', async () => {
  const f = mockFetch((url) => (url.includes('brave') ? { status: 500, body: {} } : EXA_BODY));
  const r = await run(
    ['q', '--provider', 'brave', '--json'],
    {
      BRAVE_API_KEY: 'a',
      EXA_API_KEY: 'b',
    },
    f
  );
  is(r.exitCode, 1);
  ok(f.calls.every((c) => !c.url.includes('exa')));
  is(r.stdout, '', 'non-zero exit prints no JSON');
});

test('every provider failing reports each failure', async () => {
  const f = mockFetch(() => ({ status: 500, body: {} }));
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'a', TAVILY_API_KEY: 'b' }, f);
  is(r.exitCode, 1);
  ok((/brave/).test(r.stderr));
  ok((/tavily/).test(r.stderr));
});

// ── transport ────────────────────────────────────────────────────────────────

test('a 429 is retried exactly once', async () => {
  const okFetch = mockFetch((_u, _i, n) =>
    n === 1 ? { status: 429, headers: { 'retry-after': '0' }, body: {} } : BRAVE_WEB
  );
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'k' }, okFetch);
  is(r.exitCode, 0);
  is(okFetch.calls.length, 2);

  const stubborn = mockFetch(() => ({ status: 429, headers: { 'retry-after': '0' }, body: {} }));
  const gave = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, stubborn);
  is(gave.exitCode, 1);
  is(stubborn.calls.length, 2, 'one retry, then give up');
});

test('an HTML login wall is reported as a JSON error, not a stack', async () => {
  const f = mockFetch(() => ({ body: '<html>login</html>' }));
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  is(r.exitCode, 1);
  ok((/not valid JSON/).test(r.stderr));
});

test('a network error is reported cleanly', async () => {
  const f = mockFetch(() => new Error('getaddrinfo ENOTFOUND'));
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  is(r.exitCode, 1);
  ok((/network error/).test(r.stderr));
});

test('a hanging request is aborted by the 20s timeout', { timeout: 30000 }, async () => {
  const f = mockFetch(() => ({ __hang: true }));
  const started = Date.now();
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  is(r.exitCode, 1);
  ok((/timed out/).test(r.stderr));
  ok(Date.now() - started >= 19_000, 'the abort fires on the documented timeout');
});

test('a body that stalls after the headers still hits the timeout', { timeout: 30000 }, async () => {
  // The timer must stay armed through res.text(): fetch() resolving only means
  // the headers arrived, so clearing it there would let a stalled body hang
  // forever despite the advertised 20s timeout.
  const f = mockFetch(() => ({ __hangBody: true }));
  const started = Date.now();
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  is(r.exitCode, 1);
  ok((/timed out/).test(r.stderr));
  ok(Date.now() - started >= 19_000);
});

// ── results ──────────────────────────────────────────────────────────────────

test('an empty result set is a success', async () => {
  const j = await run(
    ['nothing at all', '--json'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': { web: { results: [] } } })
  );
  is(j.exitCode, 0);
  is(j.stdout.trim(), '[]');

  const h = await run(
    ['nothing at all'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': { web: { results: [] } } })
  );
  is(h.exitCode, 0);
  ok((/No results found\./).test(h.stdout));
});

test('results are de-duplicated and malformed rows are dropped', async () => {
  const body = {
    web: {
      results: [
        { title: 'A', url: 'https://a.com/1', description: 'x' },
        { title: 'A dup', url: 'https://a.com/1', description: 'y' },
        { title: 'no url', description: 'z' },
        { url: 'https://b.com/2' },
      ],
    },
  };
  const r = await run(
    ['q', '--json'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': body })
  );
  const data = JSON.parse(r.stdout);
  is(data.length, 2);
  is(data[1].title, 'https://b.com/2', 'a missing title falls back to the URL');
  is(data[1].snippet, '');
});

test('domain filters apply natively and client-side', async () => {
  const inc = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(
    ['q', '--include-domains', 'brave.com', '--json'],
    { BRAVE_API_KEY: 'k' },
    inc
  );
  const kept = JSON.parse(r.stdout);
  is(kept.length, 1);
  ok((/brave\.com/).test(kept[0].url));
  ok((/site:brave\.com/).test(decodeURIComponent(inc.calls[0].url)));

  const exc = route({ 'api.search.brave.com': BRAVE_WEB });
  const r2 = await run(
    ['q', '--exclude-domains', 'reddit.com', '--json'],
    { BRAVE_API_KEY: 'k' },
    exc
  );
  const left = JSON.parse(r2.stdout);
  is(left.length, 1, 'www.reddit.com matches the bare domain');
  ok((/-site:reddit\.com/).test(decodeURIComponent(exc.calls[0].url)));

  const exa = route({ 'api.exa.ai': EXA_BODY });
  await run(
    [
      'q',
      '--provider',
      'exa',
      '--include-domains',
      'https://www.arxiv.org/, x.com',
      '--exclude-domains',
      'spam.io',
      '--json',
    ],
    { EXA_API_KEY: 'k' },
    exa
  );
  const eb = JSON.parse(exa.calls[0].init.body);
  is(eb.includeDomains, ['arxiv.org', 'x.com'], 'scheme, www and path stripped');
  is(eb.excludeDomains, ['spam.io']);

  const tav = route({ 'api.tavily.com': TAVILY_BODY });
  await run(
    ['q', '--provider', 'tavily', '--include-domains', 'example.com', '--json'],
    { TAVILY_API_KEY: 'k' },
    tav
  );
  is(JSON.parse(tav.calls[0].init.body).include_domains, ['example.com']);
});

test('markup does not leave orphaned punctuation in a snippet', async () => {
  const f = route({
    'api.search.brave.com': {
      web: {
        results: [
          {
            title: 'T',
            url: 'https://a.com',
            description: 'Free tier: <strong>1 query/second</strong>, then $5 CPM.',
          },
        ],
      },
    },
  });
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'k' }, f);
  is(JSON.parse(r.stdout)[0].snippet, 'Free tier: 1 query/second, then $5 CPM.');
});

// ── output modes ─────────────────────────────────────────────────────────────

test('human mode prints a summary, never JSON', async () => {
  const r = await run(
    ['brave api pricing'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': BRAVE_WEB })
  );
  is(r.exitCode, 0);
  ok((/Brave Search API pricing/).test(r.stdout));
  ok((/https:\/\/brave\.com\/search\/api\//).test(r.stdout));
  ok((/via brave/).test(r.stdout));
  ok(!r.stdout.trimStart().startsWith('['));
});

test('--debug logs to stderr only and leaks no key', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['q', '--json', '--debug'], { BRAVE_API_KEY: 'secretkey' }, f);
  ok((/chain=/).test(r.stderr));
  ok((/brave GET/).test(r.stderr));
  ok(Array.isArray(JSON.parse(r.stdout)), 'stdout stays parseable JSON');
  ok(!r.stderr.includes('secretkey'));
});
