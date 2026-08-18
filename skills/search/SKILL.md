---
name: search
description: >
  Web search for SLICC agents via a multi-provider CLI (search.jsh).
  Supports Brave (independent index, low-latency, privacy), Exa (neural/semantic),
  Tavily (RAG-optimized) and Kagi (premium, human-quality). Use when the agent
  needs current web information, research, grounding, or verification instead of
  (or in addition to) browser automation. Prefer this for open-web queries; use
  browser tools for authenticated or interactive page work.
  Trigger on requests like "search the web for…", "find recent info on…",
  "what does the internet say about…", "ground this claim", "research X",
  "deep research on X", "compare X across sources" — multi-source research jobs
  belong in parallel scoops, one per question; see "Delegating research".
allowed-tools: bash
---

# search — Multi-provider web search for SLICC agents

`search` is a shell command that queries one or more web search APIs and returns
normalized results. It is designed for agent use: clean flags, structured JSON
output, and graceful fallbacks.

## Authentication

Set API keys as environment variables (or via SLICC secrets):

```bash
export BRAVE_API_KEY=...     # recommended primary
export EXA_API_KEY=...       # recommended for semantic/research
export TAVILY_API_KEY=...    # recommended for RAG-style snippets
export KAGI_API_KEY=...      # optional: premium quality, billed per search
```

Keys are read from `process.env`. Missing keys for a requested provider produce a
clear error; `auto` mode uses whatever keys are present. When a scoop does the
searching, hand it the path of the env file holding the keys, never the values —
see "Delegating research".

## Usage

```
search "query" [options]
```

### Options

| Flag | Description |
|---|---|
| `--provider brave\|exa\|tavily\|kagi\|auto` | Backend to use (default: `auto`) |
| `-n, --num <N>` | Number of results (default 8) |
| `--json` | Emit machine-readable JSON instead of human summary |
| `--type web\|news` | Result type (default `web`); all four providers serve it |
| `--include-domains a,b` | Restrict to domains (native on Exa/Tavily/Kagi, `site:` on Brave, always enforced client-side) |
| `--exclude-domains a,b` | Exclude domains (same mechanism) |

### Examples

```bash
# Default (auto picks available providers)
search "Brave Search API pricing 2026"

# Force Brave (independent index, good latency/privacy)
search "current status of Microsoft Bing Search API" --provider brave -n 5

# Semantic / research style
search "papers arguing RAG is obsolete" --provider exa --json

# RAG-friendly clean snippets
search "best practices for LLM grounding" --provider tavily --json

# Premium quality, when it is worth the per-search cost
search "the best essays on typography" --provider kagi -n 5
```

## Provider guidance

| Provider | Env var | Strength |
|---|---|---|
| **Brave** | `BRAVE_API_KEY` | Independent index (not Google/Bing), low latency, privacy. Best default for general grounding. |
| **Exa** | `EXA_API_KEY` | Neural/semantic. Best for research, discovery, "find things arguing X". Token-efficient highlights. |
| **Tavily** | `TAVILY_API_KEY` | LLM-optimized snippets; the practical choice for RAG with minimal post-processing. |
| **Kagi** | `KAGI_API_KEY` | Premium human-quality results, billed per search. |

All four serve `--type news`. `auto` takes the first provider that has a key, in
that order, and moves on when one errors; Kagi is last because it bills per
search, so name it with `--provider kagi` when the quality is worth the cost. An
explicit `--provider` never falls back, so a result's `source` is always the
provider that was asked.

Endpoints, request/response field mappings, and per-provider quirks:
[references/providers.md](references/providers.md).

## Output

Without `--json` the command prints a short human summary (title + URL + snippet).

With `--json` it emits a stable array of objects:

```json
[
  {
    "title": "…",
    "url": "https://…",
    "snippet": "…",
    "source": "brave|exa|tavily|kagi",
    "published": "2026-…"
  }
]
```

Agents should prefer `--json` when they need to reason over or cite results.

## When a search comes up short

- **`[]`, or "No results found"** — a successful search that matched nothing, not
  an error. Broaden the query (drop quoted phrases and rare terms), drop
  `--include-domains`, or switch index: `--provider exa` reaches semantically
  phrased questions, `--provider brave` favours keyword coverage. Re-running the
  identical query will not help.
- **Non-zero exit** — the message names the cause and the fix. A rejected key
  names its env var; in `auto` mode each provider tried is listed, so a single
  failure there means every configured provider failed. Rate limits (429) are
  already retried once internally, so a repeat run is only worth it after a wait.
- **Results look out of date** — add `--type news`.

## Delegating research

Search-heavy research belongs in scoops, not inline in the cone. Raw HTML, PDFs
and legal text should be fetched, cached and distilled inside a scoop, with only
a short summary returned. `man delegation` covers the primitives (scoop shaping,
parallel orchestration, cost); this section covers what is specific to search work.

### One scoop per question

Fan out one scoop per question, `scoop_wait` on all of them, synthesise in the
next turn.

```
scoop_scoop({ name: "tos-research", prompt: "<self-contained brief>" })
scoop_scoop({ name: "copilot-research", prompt: "<self-contained brief>" })
scoop_scoop({ name: "cloud-research", prompt: "<self-contained brief>" })
scoop_wait({ scoop_names: ["tos-research", "copilot-research", "cloud-research"], timeout_ms: 1800000 })
```

Each prompt stands alone: the question, where the keys are, where the report goes,
the citation rules. Order of magnitude from three parallel research scoops over
vendor terms of service, product docs, cloud docs and academic papers — roughly $5
and 10 to 20 minutes each. `cost` reports per-scoop spend.

### Share keys by path, never by value

Keys live in a shared env file (on this machine `/shared/.search-keys.env`). Name
the file in the brief and let the scoop load it:

```
prompt: "Load the search keys with `set -a; . /shared/.search-keys.env; set +a`, then search …"
```

Never paste a key value into a prompt: prompts are persisted, to the transcript
and to `/shared/scoop-notifications/*.md`. A scoop's default `writablePaths`
include `/shared/`, so a key file there is already readable; if you narrow the
sandbox, keep its directory visible or `search` fails with a missing-key error
naming the env var.

### Pre-approve paths at creation time

A scoop that drives a browser writes to the playwright profile area, and every
unapproved path raises a separate sudo request that stalls the run and interrupts
the cone. One research run produced four consecutive prompts: `/.playwright`,
`/.playwright/snapshots`, `/.playwright/screenshots`, `/.playwright/session.md`.
Grant them at creation:

```
scoop_scoop({
  name: "tos-research",
  writablePaths: ["/shared/research/tos/", "/.playwright/",
    "/.playwright/snapshots/", "/.playwright/screenshots/", "/.playwright/session.md"],
  prompt: "<self-contained brief>"
})
```

Grant the profile root deliberately and narrowly — it holds live authenticated
browser state. The artefact paths (`snapshots`, `screenshots`, `session.md`) are
inert, and are the ones worth persisting as standing approvals.

### `curl` first, browser when the page is a shell

`curl` plus `html-to-markdown` is right for text-heavy documentation and legal
pages, and stays the default. Switch to `playwright-cli` when:

| Symptom | Observed |
|---|---|
| Body arrives empty or as a JS shell | A vendor trust portal served `curl` an empty shell; the decisive PDF was two clicks away in a real tab. |
| Numbers are rendered client-side | A benchmark site's per-task dollar figures and another vendor's chart were unreachable any other way. |
| A table's meaning lives in per-cell markup | `html-to-markdown` flattened per-plan checkmark tables — exactly the information being researched. |

The productive hybrid is a tab for the DOM and `curl` for the asset:

```bash
playwright-cli tab-list          # re-read before every --tab use; ids are shared across agents
playwright-cli eval --tab=<id> "Array.from(document.querySelectorAll('a[href$=\".pdf\"]')).map(a => a.href)"
curl -sL "<href from the DOM>" -o /shared/research/tos/src/terms.pdf
```

That is how a gated-looking document turned out to need no login: the href
carried its own token. Tab rules, including re-reading `tab-list` before `--tab`,
are in `man playwright-cli`.

### Demand a citable artefact

Research that cannot be re-checked is not research, and measured figures move: a
third-party cost-per-task metric shifted 13 to 14 percent inside a week, and a
two-model ranking reversed inside a quarter. Instruct the scoop to write its
report to a file under `/shared/`, print only a short summary to stdout, and
include:

- a URL and a short verbatim quote per factual claim;
- the effective or last-updated date wherever the source is a living document;
- which sources are primary, which vendor-published, which SEO-grade;
- a closing **Gaps** section listing what could not be verified.

Cache the raw sources next to the report (for example `src/`) so claims can be
re-verified without re-fetching, and so the cone can grep the original text
instead of trusting a paraphrase.

Verify the artefact exists. A scoop reported its report written when the file was
absent, and the work had to be re-requested. Tell scoops to confirm with `ls -l`
and `wc -l` and to print the path; check the file before acting on a summary.

### What delegation does not fix

Delegation buys parallelism and context, not recall: an empty result set stays
empty until the query changes — see "When a search comes up short" above. And
this skill only reaches the open web, per the next section.

## When not to use this skill

Use browser tools instead for authenticated or interactive work inside a specific
web app; this skill only reaches the open web.

## Implementation notes

`scripts/search.jsh` (SLICC `.jsh` runtime) is read-only and persists nothing.
It is **not** one request per run: a transient status (429/502/503/504) is
retried once, and in `auto` a failing provider hands off to the next one holding
a key — so a run can issue up to two requests per provider tried, eight with all
four keys set. That matters where searches are metered, and Kagi bills per
search.

Keep the JSON schema stable for agents that already depend on it, and `--help`,
`references/providers.md` and this file in lockstep with the code.
