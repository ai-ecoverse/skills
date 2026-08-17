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
  "what does the internet say about…", "ground this claim", "research X".
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
clear error; `auto` mode uses whatever keys are present.

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
