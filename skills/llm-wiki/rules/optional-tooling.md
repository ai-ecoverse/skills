---
name: optional-tooling
description: Optional local search, Obsidian-adjacent tools, and git—never assumed by default
---

# Optional tooling

The core workflow uses **index + links + grep**. Add tooling when the wiki outgrows the index.

## Local search over markdown

When the index is no longer sufficient, use a **local** search tool (hybrid keyword + vector, or CLI + MCP). Example: [qmd](https://github.com/tobi/qmd)—on-device search with optional LLM re-ranking. Shell out from the agent or expose as MCP per user setup.

**Rule:** Search complements the index; it does not replace **updating the index** after ingests unless the user explicitly runs a search-only workflow.

## Obsidian (optional)

If the user uses Obsidian:

- **Graph view** surfaces hubs, orphans, and link structure—useful after large ingests or for lint.
- **Web Clipper** helps capture raw sources as markdown.
- **Marp** / **Dataview** plugins: useful when the schema includes slide decks or frontmatter queries.

**Do not assume** Obsidian unless the user says so—plain markdown in git is enough.

## Version control

Treat the wiki as a **git-tracked** tree when the user uses git: branching, history, and diffs for wiki changes. Do not init git or change remotes unless asked.
