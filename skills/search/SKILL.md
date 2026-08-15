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
| `--type web\|news` | Result type where supported (default `web`; Kagi has no news endpoint) |
| `--include-domains a,b` | Restrict to domains (native on Exa/Tavily, `site:` on Brave/Kagi, always enforced client-side) |
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

| Provider | Strength | Env var | `--type news` |
|---|---|---|---|
| **Brave** | Independent index (not Google/Bing), low latency, privacy. Best default for general grounding. | `BRAVE_API_KEY` | yes |
| **Exa** | Neural/semantic. Best for research, discovery, "find things arguing X". Token-efficient highlights. | `EXA_API_KEY` | yes |
| **Tavily** | LLM-optimized snippets; the practical choice for RAG with minimal post-processing. | `TAVILY_API_KEY` | yes |
| **Kagi** | Premium human-quality results, billed per search. | `KAGI_API_KEY` | no |

`auto` walks Brave → Exa → Tavily → Kagi: it takes the first provider that has a
key and moves on when one errors. Kagi is last because it bills per search — name
it with `--provider kagi` when the quality is worth the cost. An explicit
`--provider` never falls back, so a result's `source` is always the provider that
was asked. Kagi has no news vertical, so `--type news` skips it in `auto` and is
refused under `--provider kagi` rather than answering with web results.

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

## When not to use this skill

Use browser tools instead for authenticated or interactive work inside a specific
web app; this skill only reaches the open web.

## Implementation notes

The command lives at `scripts/search.jsh` (SLICC `.jsh` runtime: `process`,
`fetch`, normalized error handling). It is read-only: one request per
invocation, nothing persisted. Extend it carefully so the JSON schema stays
stable for agents that already depend on it, and keep `--help`,
`references/providers.md` and this file in lockstep with the code.
