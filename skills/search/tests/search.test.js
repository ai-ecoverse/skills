// Behaviour tests for scripts/search.jsh, run against the .jsh runtime stub in
// jsh-runtime.js:
//
//   node --test skills/search/tests/search.test.js
//
// Provider payloads below are hand-built from each vendor's documented response
// shape; they are fixtures, not captures of a live account.

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { runJsh, mockFetch } = require('./jsh-runtime.js');

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
        page_age: '2026-03-01T12:00:00',
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
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /--provider/);
});

test('a missing query is an actionable error with an empty stdout', async () => {
  const r = await run(['--json'], { BRAVE_API_KEY: 'k' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /missing query/);
  assert.equal(r.stdout, '');
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
  assert.equal(r.exitCode, 0);
  assert.equal(new URL(f.calls[0].url).searchParams.get('q'), 'my multi word query');
});

test('bare positionals join into one query and -- ends flag parsing', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['multi', 'word', 'unquoted', '--json'], { BRAVE_API_KEY: 'k' }, f);
  assert.equal(new URL(f.calls[0].url).searchParams.get('q'), 'multi word unquoted');

  const f2 = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['--', '--not-a-flag', '--json'], { BRAVE_API_KEY: 'k' }, f2);
  assert.equal(new URL(f2.calls[0].url).searchParams.get('q'), '--not-a-flag --json');
});

test('a value-taking flag left without a value fails loudly', async () => {
  const r = await run(['q', '--provider', '--json'], { BRAVE_API_KEY: 'k' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /--provider expects a value/);

  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const ok = await run(['q', '--exclude-domains=-weird.com', '--json'], { BRAVE_API_KEY: 'k' }, f);
  assert.equal(ok.exitCode, 0, 'the --flag=value form still accepts a leading dash');
});

test('unknown --provider and --type are rejected', async () => {
  const p = await run(['q', '--provider', 'google'], { BRAVE_API_KEY: 'k' });
  assert.equal(p.exitCode, 1);
  assert.match(p.stderr, /unknown --provider/);

  const t = await run(['q', '--type', 'video', '--json'], { BRAVE_API_KEY: 'k' });
  assert.equal(t.exitCode, 1);
  assert.match(t.stderr, /unknown --type/);
});

test('-n is clamped to 1..20 and rejects non-numbers', async () => {
  const hi = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['q', '-n', '999', '--json'], { BRAVE_API_KEY: 'k' }, hi);
  assert.match(hi.calls[0].url, /count=20/);

  const lo = route({ 'api.search.brave.com': BRAVE_WEB });
  await run(['q', '--num=0', '--json'], { BRAVE_API_KEY: 'k' }, lo);
  assert.match(lo.calls[0].url, /count=1/);

  const one = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['q', '-n', '1', '--json'], { BRAVE_API_KEY: 'k' }, one);
  assert.equal(JSON.parse(r.stdout).length, 1, '-n also truncates the returned list');

  const bad = await run(['q', '-n', 'many'], { BRAVE_API_KEY: 'k' });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /expects a number/);
});

// ── auth ─────────────────────────────────────────────────────────────────────

test('auto with no keys lists every expected env var', async () => {
  const r = await run(['test query', '--json'], {});
  assert.equal(r.exitCode, 1);
  for (const v of ['BRAVE_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'KAGI_API_KEY']) {
    assert.match(r.stderr, new RegExp(v));
  }
});

test('an explicit provider without its key names that key', async () => {
  const r = await run(['q', '--provider', 'exa'], { BRAVE_API_KEY: 'k' });
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /EXA_API_KEY/);
});

test('a 401 adds a key-specific hint and never echoes the key', async () => {
  const f = mockFetch(() => ({ status: 401, body: { message: 'invalid key' } }));
  const r = await run(['q', '--provider', 'tavily'], { TAVILY_API_KEY: 'sekrit' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /TAVILY_API_KEY was rejected/);
  assert.ok(!r.stderr.includes('sekrit'));
});

// ── providers ────────────────────────────────────────────────────────────────

test('brave: request shape and normalized results', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['brave api pricing', '--json'], { BRAVE_API_KEY: 'bk' }, f);
  assert.equal(r.exitCode, 0);

  assert.ok(f.calls[0].url.startsWith('https://api.search.brave.com/res/v1/web/search'));
  assert.equal(f.calls[0].init.headers['X-Subscription-Token'], 'bk');
  assert.match(f.calls[0].url, /count=8/);

  const data = JSON.parse(r.stdout);
  assert.equal(data.length, 2);
  assert.deepEqual(Object.keys(data[0]), ['title', 'url', 'snippet', 'source', 'published']);
  assert.equal(data[0].source, 'brave');
  assert.equal(data[0].title, 'Brave Search API pricing & plans', 'tags and entities stripped');
  assert.equal(data[0].snippet, 'Free tier of 1 query/sec, then $5 CPM.');
  assert.equal(data[0].published, '2026-03-01T12:00:00.000Z');
  assert.ok(!('published' in data[1]), '"3 days ago" is not a date — the key is omitted');
  assert.ok(!r.stdout.includes('bk') && !r.stderr.includes('bk'), 'key never printed');
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

  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers['x-api-key'], 'ek');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.query, 'papers arguing RAG is obsolete');
  assert.equal(body.numResults, 8);
  assert.equal(
    body.contents.highlights,
    true,
    'the deprecated {numSentences,…} object is not sent'
  );

  const data = JSON.parse(r.stdout);
  assert.equal(data[0].source, 'exa');
  assert.equal(data[0].snippet, 'Long-context models subsume retrieval. … But cost dominates.');
  assert.equal(data[0].published, '2026-01-15T00:00:00.000Z');
});

test('exa: falls back to text when a page yields no highlights', async () => {
  const f = route({
    'api.exa.ai': { results: [{ title: 'T', url: 'https://a.com', text: 'body text here' }] },
  });
  const r = await run(['q', '--provider', 'exa', '--json'], { EXA_API_KEY: 'ek' }, f);
  const data = JSON.parse(r.stdout);
  assert.equal(data[0].snippet, 'body text here');
  assert.ok(!('published' in data[0]));
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

  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tk');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.max_results, 8);
  assert.equal(body.topic, 'general');

  const data = JSON.parse(r.stdout);
  assert.equal(data[0].snippet, 'Ground every claim with a citation.');
  assert.equal(data[0].published, '2026-03-03T00:00:00.000Z');
});

test('kagi: v1 POST, Bearer auth, and normalized results', async () => {
  const f = route({ 'kagi.com': KAGI_BODY });
  const r = await run(
    ['the best essays on typography', '--provider', 'kagi', '--json'],
    { KAGI_API_KEY: 'kk' },
    f
  );
  assert.equal(r.exitCode, 0);

  assert.equal(f.calls[0].url, 'https://kagi.com/api/v1/search', 'v1, not the sunset v0');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer kk', 'Bearer, not v0 Bot');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.query, 'the best essays on typography');
  assert.equal(body.workflow, 'search');
  assert.equal(body.limit, 8);

  const data = JSON.parse(r.stdout);
  assert.equal(data.length, 1, 'only data.search[] — related_search is not a result');
  assert.equal(data[0].source, 'kagi');
  assert.equal(data[0].title, 'Butterick\u2019s Practical Typography');
  assert.equal(data[0].snippet, 'A book about typography.');
  assert.equal(data[0].published, '2026-02-10T00:00:00.000Z', 'mapped from `time`');
  assert.ok(!r.stdout.includes('kk') && !r.stderr.includes('kk'));
});

test('kagi: --type news sends workflow news and reads data.news[]', async () => {
  const f = route({ 'kagi.com': KAGI_NEWS_BODY });
  const r = await run(
    ['q', '--provider', 'kagi', '--type', 'news', '--json'],
    { KAGI_API_KEY: 'kk' },
    f
  );
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(JSON.parse(f.calls[0].init.body).workflow, 'news');
  const data = JSON.parse(r.stdout);
  assert.equal(data.length, 1);
  assert.equal(data[0].url, 'https://news.example/typo');
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
  assert.equal(JSON.parse(r.stdout).length, 1);
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
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /Invalid API token/);
  assert.match(r.stderr, /KAGI_API_KEY was rejected/);
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
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /Token signature failed to verify/, 'the plural key is read');
  assert.match(r.stderr, /KAGI_API_KEY was rejected/, '400 + invalid_token is an auth failure');
  assert.ok(!r.stderr.includes('stale'));
});

test('a 400 that is not an auth problem is not blamed on the key', async () => {
  const f = mockFetch(() => ({
    status: 400,
    body: { errors: [{ code: 'search.invalid_query', message: 'query was empty' }] },
  }));
  const r = await run(['q', '--provider', 'kagi'], { KAGI_API_KEY: 'k' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /query was empty/);
  assert.ok(!/was rejected/.test(r.stderr), 'the auth hint keys off the code, not any 400');
});

test('kagi is last in the auto chain, so cheaper providers win', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['q', '--json'], { KAGI_API_KEY: 'kk', BRAVE_API_KEY: 'bk' }, f);
  assert.equal(JSON.parse(r.stdout)[0].source, 'brave');
  assert.ok(
    f.calls.every((c) => !c.url.includes('kagi.com')),
    'kagi is never billed here'
  );
});

test('kagi is still used by auto when it is the only key', async () => {
  const f = route({ 'kagi.com': KAGI_BODY });
  const r = await run(['q', '--json'], { KAGI_API_KEY: 'kk' }, f);
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout)[0].source, 'kagi');
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
  assert.deepEqual(body.lens.sites_included, ['example.org'], 'native lens, no site: operator');
  assert.deepEqual(body.lens.sites_excluded, ['practicaltypography.com']);
  assert.ok(!JSON.stringify(body).includes('site:'), 'v1 needs no query operators');
  assert.deepEqual(JSON.parse(r.stdout), [], 'the client-side pass is authoritative');
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
  assert.match(brave.calls[0].url, /\/res\/v1\/news\/search/);

  const exa = route({ 'api.exa.ai': EXA_BODY });
  await run(['q', '--provider', 'exa', '--type', 'news', '--json'], { EXA_API_KEY: 'k' }, exa);
  assert.equal(JSON.parse(exa.calls[0].init.body).category, 'news');

  const tavily = route({ 'api.tavily.com': TAVILY_BODY });
  await run(
    ['q', '--provider', 'tavily', '--type', 'news', '--json'],
    { TAVILY_API_KEY: 'k' },
    tavily
  );
  assert.equal(JSON.parse(tavily.calls[0].init.body).topic, 'news');

  const kagi = route({ 'kagi.com': KAGI_NEWS_BODY });
  await run(['q', '--provider', 'kagi', '--type', 'news', '--json'], { KAGI_API_KEY: 'k' }, kagi);
  assert.equal(JSON.parse(kagi.calls[0].init.body).workflow, 'news');
});

// ── provider chain ───────────────────────────────────────────────────────────

test('auto falls through to the next provider on failure', async () => {
  const f = mockFetch((url) => {
    if (url.includes('brave')) return { status: 500, body: { message: 'boom' } };
    if (url.includes('exa')) return EXA_BODY;
    return failUnexpected(url);
  });
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'a', EXA_API_KEY: 'b' }, f);
  assert.equal(r.exitCode, 0);
  assert.equal(JSON.parse(r.stdout)[0].source, 'exa');
  assert.match(r.stderr, /brave failed/);
  assert.ok(!r.stdout.includes('brave failed'), 'warnings stay off stdout');
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
  assert.equal(r.exitCode, 1);
  assert.ok(f.calls.every((c) => !c.url.includes('exa')));
  assert.equal(r.stdout, '', 'non-zero exit prints no JSON');
});

test('every provider failing reports each failure', async () => {
  const f = mockFetch(() => ({ status: 500, body: {} }));
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'a', TAVILY_API_KEY: 'b' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /brave/);
  assert.match(r.stderr, /tavily/);
});

// ── transport ────────────────────────────────────────────────────────────────

test('a 429 is retried exactly once', async () => {
  const ok = mockFetch((_u, _i, n) =>
    n === 1 ? { status: 429, headers: { 'retry-after': '0' }, body: {} } : BRAVE_WEB
  );
  const r = await run(['q', '--json'], { BRAVE_API_KEY: 'k' }, ok);
  assert.equal(r.exitCode, 0);
  assert.equal(ok.calls.length, 2);

  const stubborn = mockFetch(() => ({ status: 429, headers: { 'retry-after': '0' }, body: {} }));
  const gave = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, stubborn);
  assert.equal(gave.exitCode, 1);
  assert.equal(stubborn.calls.length, 2, 'one retry, then give up');
});

test('an HTML login wall is reported as a JSON error, not a stack', async () => {
  const f = mockFetch(() => ({ body: '<html>login</html>' }));
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /not valid JSON/);
});

test('a network error is reported cleanly', async () => {
  const f = mockFetch(() => new Error('getaddrinfo ENOTFOUND'));
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /network error/);
});

test('a hanging request is aborted by the 20s timeout', async () => {
  const f = mockFetch(() => ({ __hang: true }));
  const started = Date.now();
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /timed out/);
  assert.ok(Date.now() - started >= 19_000, 'the abort fires on the documented timeout');
});

test('a body that stalls after the headers still hits the timeout', async () => {
  // The timer must stay armed through res.text(): fetch() resolving only means
  // the headers arrived, so clearing it there would let a stalled body hang
  // forever despite the advertised 20s timeout.
  const f = mockFetch(() => ({ __hangBody: true }));
  const started = Date.now();
  const r = await run(['q', '--provider', 'brave'], { BRAVE_API_KEY: 'k' }, f);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /timed out/);
  assert.ok(Date.now() - started >= 19_000);
});

// ── results ──────────────────────────────────────────────────────────────────

test('an empty result set is a success', async () => {
  const j = await run(
    ['nothing at all', '--json'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': { web: { results: [] } } })
  );
  assert.equal(j.exitCode, 0);
  assert.equal(j.stdout.trim(), '[]');

  const h = await run(
    ['nothing at all'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': { web: { results: [] } } })
  );
  assert.equal(h.exitCode, 0);
  assert.match(h.stdout, /No results found\./);
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
  assert.equal(data.length, 2);
  assert.equal(data[1].title, 'https://b.com/2', 'a missing title falls back to the URL');
  assert.equal(data[1].snippet, '');
});

test('domain filters apply natively and client-side', async () => {
  const inc = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(
    ['q', '--include-domains', 'brave.com', '--json'],
    { BRAVE_API_KEY: 'k' },
    inc
  );
  const kept = JSON.parse(r.stdout);
  assert.equal(kept.length, 1);
  assert.match(kept[0].url, /brave\.com/);
  assert.match(decodeURIComponent(inc.calls[0].url), /site:brave\.com/);

  const exc = route({ 'api.search.brave.com': BRAVE_WEB });
  const r2 = await run(
    ['q', '--exclude-domains', 'reddit.com', '--json'],
    { BRAVE_API_KEY: 'k' },
    exc
  );
  const left = JSON.parse(r2.stdout);
  assert.equal(left.length, 1, 'www.reddit.com matches the bare domain');
  assert.match(decodeURIComponent(exc.calls[0].url), /-site:reddit\.com/);

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
  assert.deepEqual(eb.includeDomains, ['arxiv.org', 'x.com'], 'scheme, www and path stripped');
  assert.deepEqual(eb.excludeDomains, ['spam.io']);

  const tav = route({ 'api.tavily.com': TAVILY_BODY });
  await run(
    ['q', '--provider', 'tavily', '--include-domains', 'example.com', '--json'],
    { TAVILY_API_KEY: 'k' },
    tav
  );
  assert.deepEqual(JSON.parse(tav.calls[0].init.body).include_domains, ['example.com']);
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
  assert.equal(JSON.parse(r.stdout)[0].snippet, 'Free tier: 1 query/second, then $5 CPM.');
});

// ── output modes ─────────────────────────────────────────────────────────────

test('human mode prints a summary, never JSON', async () => {
  const r = await run(
    ['brave api pricing'],
    { BRAVE_API_KEY: 'k' },
    route({ 'api.search.brave.com': BRAVE_WEB })
  );
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /Brave Search API pricing/);
  assert.match(r.stdout, /https:\/\/brave\.com\/search\/api\//);
  assert.match(r.stdout, /via brave/);
  assert.ok(!r.stdout.trimStart().startsWith('['));
});

test('--debug logs to stderr only and leaks no key', async () => {
  const f = route({ 'api.search.brave.com': BRAVE_WEB });
  const r = await run(['q', '--json', '--debug'], { BRAVE_API_KEY: 'secretkey' }, f);
  assert.match(r.stderr, /chain=/);
  assert.match(r.stderr, /brave GET/);
  assert.ok(Array.isArray(JSON.parse(r.stdout)), 'stdout stays parseable JSON');
  assert.ok(!r.stderr.includes('secretkey'));
});
