# llm-wiki

A persistent knowledge base skill for [SLICC](https://github.com/ai-ecoverse/slicc), stored in the [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) (OKF): a folder of markdown concepts with YAML frontmatter. The agent compiles sources into concepts so knowledge compounds instead of being rediscovered on every query ([Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)).

| File | Purpose |
|------|---------|
| `SKILL.md` | Setup, rules, ingest / query / lint with okf, the panel, moving an old tree |
| `scripts/wiki.jsh` | The `wiki` command: bundle root, `wiki okf`, `wiki log`, `wiki sprinkle`, the panel's CGI |
| `templates/llm-wiki.shtml` | The SLICC panel: search, type filter, concepts by folder, backlinks, an ask box |
| `references/` | The panel's cgi-bin protocol, and moving an llm-wiki tree to OKF |
| `tests/` | `tst` suites, with a stand-in okf |

okf itself is [okfcli/okf](https://github.com/okfcli/okf), built for SLICC as `@ai-ecoverse/wasi-okf`.

Version 2 replaces the SLICC 6 version: `wiki.jsh` with its own page scanner, the single-file `llm-wiki.shtml` browser, and the `wiki-ops` scoop wiring.

## Attribution

Based on the [llm-wiki skill](https://github.com/kvokov/oh-my-ai) by DK, inspired by [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## License

This skill is licensed under the MIT License — see [LICENSE](LICENSE). The rest of the `ai-ecoverse/skills` repository is Apache 2.0.
