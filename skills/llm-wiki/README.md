# llm-wiki

A persistent, interlinked markdown wiki knowledge base skill for [SLICC](https://github.com/ai-ecoverse/slicc). Implements the [Karpathy LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the agent compiles source material into wiki pages so knowledge compounds instead of being rediscovered every query.

## What's included

| File | Purpose |
|------|---------|
| `SKILL.md` | Skill definition — setup, processes (ingest/query/lint), constraints |
| `llm-wiki.shtml` | Sprinkle browser with sidebar nav, search, wikilinks, query/ingest dialogs |
| `wiki.jsh` | CLI: search, list, read, stats, links, orphans, recent, log |
| `wiki-ops-brief.md` | Ops scoop system prompt |
| `rules/` | Index/log conventions and optional tooling guidance |

## Attribution

Based on the [llm-wiki skill](https://github.com/kvokov/oh-my-ai) by DK, inspired by [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Extended with SLICC sprinkle browser, wiki CLI, and ops scoop architecture.

## License

This skill is licensed under the MIT License — see [LICENSE](LICENSE). The rest of the `ai-ecoverse/skills` repository is Apache 2.0.
