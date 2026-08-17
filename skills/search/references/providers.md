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
  "contents": { "text": { "maxCharacters": 800 }, "highlights": true },
  "category": "news",
  "includeDomains": ["a.com"],
  "excludeDomains": ["b.com"]
}
```

`category` is set only for `--type news`. Highlights are requested because they
are the token-efficient snippet: the CLI prefers `highlights[]` (joined with
`…`) and falls back to `text` when a page yields none. `highlights: true` is the
current form — the `{ numSentences, highlightsPerUrl }` object is deprecated per
Exa's [coding-agent guide](https://docs.exa.ai/reference/search-api-guide-for-coding-agents).
Dates arrive as ISO 8601 in `publishedDate`. Domain filters are native and
server-side.

`type` is left at `"auto"`. Exa also exposes `fast`, `instant`, `deep-lite`,
`deep` and `deep-reasoning`, plus `outputSchema` for structured grounded output —
unused here, a reasonable follow-up.

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
| Endpoint | `POST https://kagi.com/api/v1/search` |
| Auth | `Authorization: Bearer <key>` |
| Keys | https://kagi.com/api/keys |
| Spec | https://kagi.com/api/docs/_spec/openapi.yaml |

**This is API v1.** The v0 beta (`GET api/v0/search?q=`, `Authorization: Bot`) is
being sunset and returns 401 for keys issued by the current portal, so v0 is not
a fallback — everything below changed with it: method, path, auth scheme, request
encoding, response shape, and the date field.

Request body:

```json
{
  "query": "…",
  "workflow": "search",
  "limit": 8,
  "lens": { "sites_included": ["a.com"], "sites_excluded": ["b.com"] }
}
```

- `workflow` — `search | images | videos | news | podcasts`. `--type news` sends
  `news`; Kagi **does** have a news vertical.
- `limit` — 1..1024. Per the spec it caps what is *returned*, not what is
  searched, so it is a ceiling rather than a page size.
- `lens` — native domain filtering, so no `site:` operators are needed. The spec
  notes lens options take precedence over operators written into the query text.
  `lens_id` (a saved/shareable lens) and the other lens facets — `keywords_included`,
  `keywords_excluded`, `file_type`, `time_after`, `time_before`, `time_relative`,
  `search_region` — are available but unused here.

Responses split results into **named arrays by type** under `data` —
`data.search[]`, `data.news[]`, `data.image[]`, `data.video[]`,
`data.related_search[]`, `data.interesting_news[]`, and more. There is no `t`
discriminator (that was v0). The CLI reads the bucket matching the requested
workflow, falling back `news → interesting_news → search` for a news query.

Every bucket holds the same `searchResult`: `url` and `title` (both required),
`snippet`, `time` (**the date field — v0 called it `published`**), plus optional
`image` and an open-ended `props`.

Errors are an **array**, unlike the other three. The spec documents
`error: [{ code, url, message, location }]`, but **live responses use `errors`
(plural)** — both keys are read, plural first, and `msg` as well as `message`
since v0 used the shorter name. A bad token arrives as:

```
HTTP 400 Bad Request
{"errors": [{"code": "general.invalid_token", "message": "Token signature failed to verify…"}]}
```

so it is 400 rather than 401, and is recognised by the code (captured live
2026-08-17, PR #285).

## Cross-provider behaviour

- **`auto` order** — Brave → Exa → Tavily → Kagi. The first provider with a key
  runs; a provider that *errors* falls through to the next. An empty result set
  is a success, not a reason to fall through, and an explicit `--provider` never
  falls back at all, so a result's `source` is always the provider that was asked.
- **`--type news`** — served by all four, each through its own knob: Brave a
  separate endpoint, Exa `category`, Tavily `topic`, Kagi `workflow`.
- **Domain filters** — native on Exa, Tavily and Kagi (the last via a `lens`),
  `site:`/`-site:` query operators on Brave, and a client-side host check on every
  provider afterwards.
  The client-side pass is authoritative and is what makes the flags behave the
  same everywhere; it matches a bare domain against both the host and its
  subdomains (`reddit.com` excludes `www.reddit.com`).
- **Dates** — `published` is emitted only when the provider's value parses to a
  real date, always as ISO 8601. Relative strings are dropped, never guessed.
- **Transport** — a 20s abort timeout that stays armed until the response body
  has been read (a provider can stall after sending headers); one retry on
  429/502/503/504 honouring `Retry-After` (capped at 10s, and outside the timeout
  budget). Failures exit non-zero even under `--json`. A run is therefore **not**
  one request: up to two per provider tried, eight with all four keys set — worth
  knowing where searches are metered.
- **Auth failures** — 401 and 403 are the obvious ones, but a provider may signal
  a bad credential with another status: Kagi answers a rotated or v0-era token
  with **HTTP 400** and error code `general.invalid_token` (captured live
  2026-08-17). Detection therefore keys off the error code as well as the status,
  so the "check your key" hint fires either way.
- **Keys** never appear in output, including `--debug`, which logs only the
  provider chain and request URLs.

## Tests

`node --test skills/search/tests/search.test.js` drives the real `search.jsh`
through a stub of the `.jsh` runtime, covering each provider's request shape and
response mapping, the fallback chain, and the failure modes above.
