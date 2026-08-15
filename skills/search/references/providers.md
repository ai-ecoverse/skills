# Provider reference

Wire-level detail for the four backends behind `search`. The CLI normalizes all
of them onto `{ title, url, snippet, source, published? }`; this file records
what each provider actually sends so the mapping can be re-derived when an API
drifts.

## Brave — `BRAVE_API_KEY`

An independent crawl (not a Google/Bing reseller), low latency, permissive terms.
The default for general grounding.

| | |
|---|---|
| Web | `GET https://api.search.brave.com/res/v1/web/search?q=&count=` |
| News | `GET https://api.search.brave.com/res/v1/news/search?q=&count=` |
| Auth | `X-Subscription-Token: <key>` |
| Max results | 20 per request |
| Keys | https://api-dashboard.search.brave.com |

Web responses nest under `web.results[]`; news responses are a flat `results[]`.
Per result: `title`, `url`, `description` (contains `<strong>` markup and HTML
entities — the CLI strips both), and a date in `page_age` (ISO-ish) or `age`
(relative, e.g. `"3 days ago"`). Only `page_age` parses; `age` is dropped rather
than guessed at, so `published` is simply absent.

No structured domain filter — `--include-domains` / `--exclude-domains` are
appended to the query as `site:` / `-site:` operators.

## Exa — `EXA_API_KEY`

Neural/semantic retrieval. Best for research, discovery, and "find me things
arguing X" — questions where keyword overlap is the wrong signal.

| | |
|---|---|
| Endpoint | `POST https://api.exa.ai/search` |
| Auth | `x-api-key: <key>` |
| Keys | https://dashboard.exa.ai |

Request body:

```json
{
  "query": "…",
  "numResults": 8,
  "type": "auto",
  "contents": { "text": { "maxCharacters": 800 },
                "highlights": { "numSentences": 2, "highlightsPerUrl": 2 } },
  "category": "news",
  "includeDomains": ["a.com"],
  "excludeDomains": ["b.com"]
}
```

`category` is set only for `--type news`. Highlights are requested because they
are the token-efficient snippet: the CLI prefers `highlights[]` (joined with
`…`) and falls back to `text` when a page yields none. Dates arrive as ISO 8601
in `publishedDate`. Domain filters are native and server-side.

## Tavily — `TAVILY_API_KEY`

A re-ranking/extraction layer over other indexes, tuned for RAG: the cleanest
snippets of the four, with the least post-processing needed.

| | |
|---|---|
| Endpoint | `POST https://api.tavily.com/search` |
| Auth | `Authorization: Bearer <key>` |
| Keys | https://app.tavily.com |

Request body uses snake_case: `max_results`, `search_depth: "basic"`,
`topic: "general" | "news"` (the `--type news` knob), `include_domains`,
`exclude_domains`. `include_answer` and `include_raw_content` are explicitly
disabled — this is a search command, not a summarizer.

Per result: `title`, `url`, `content` (the snippet), `score`, and
`published_date` in RFC 1123 form (`"Mon, 03 Mar 2026 00:00:00 GMT"`), which the
CLI converts to ISO. `published_date` is generally only populated for
`topic: "news"`.

## Kagi — `KAGI_API_KEY`

Premium, human-quality results. Billed per search, which is why it sits **last**
in the `auto` order — reached only when nothing else is configured — and is
otherwise opted into with `--provider kagi`.

| | |
|---|---|
| Endpoint | `GET https://kagi.com/api/v0/search?q=&limit=` |
| Auth | `Authorization: Bot <key>` |
| Keys | https://kagi.com/settings?p=api |

The payload is a **heterogeneous** `data[]` discriminated by `t`:

```json
{ "meta": { "id": "…", "api_balance": 4.99 },
  "data": [ { "t": 0, "rank": 1, "url": "…", "title": "…", "snippet": "…",
              "published": "2026-02-10T00:00:00Z" },
            { "t": 1, "list": ["related search", "…"] } ] }
```

Only `t === 0` entries are results — `t: 1` is the related-searches block, and
filtering by position instead of by `t` would turn it into a bogus result.
Errors come back as `error: [{ code, msg }]` (an **array**, unlike the other
three), so error rendering unwraps it to show the real message.

There is no news vertical and no structured domain filter. `--type news` is
therefore skipped in `auto` and refused under `--provider kagi`, rather than
answering a news query with web results; domains ride along as `site:` /
`-site:` operators.

## Cross-provider behaviour

- **`auto` order** — Brave → Exa → Tavily → Kagi. The first provider with a key
  runs; a provider that *errors* falls through to the next. An empty result set
  is a success, not a reason to fall through, and an explicit `--provider` never
  falls back at all, so a result's `source` is always the provider that was asked.
- **Domain filters** — native on Exa and Tavily, `site:`/`-site:` query operators
  on Brave and Kagi, and a client-side host check on every provider afterwards.
  The client-side pass is authoritative and is what makes the flags behave the
  same everywhere; it matches a bare domain against both the host and its
  subdomains (`reddit.com` excludes `www.reddit.com`).
- **Dates** — `published` is emitted only when the provider's value parses to a
  real date, always as ISO 8601. Relative strings are dropped, never guessed.
- **Transport** — 20s abort timeout; one retry on 429/502/503/504 honouring
  `Retry-After` (capped at 10s). Failures exit non-zero even under `--json`.
- **Keys** never appear in output, including `--debug`, which logs only the
  provider chain and request URLs.

## Tests

`node --test skills/search/tests/search.test.js` drives the real `search.jsh`
through a stub of the `.jsh` runtime, covering each provider's request shape and
response mapping, the fallback chain, and the failure modes above.
