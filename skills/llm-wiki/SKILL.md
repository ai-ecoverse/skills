---
name: llm-wiki
description: Build and maintain a persistent, interlinked markdown wiki knowledge base
  from raw sources. Use when the user wants to create a knowledge base, build a wiki,
  ingest articles or papers into a KB, query accumulated knowledge, organize research
  notes, or lint a wiki for broken links and orphan pages. Triggers on mentions of
  knowledge base, wiki, KB, ingest, research notes, or personal wiki.
---

# LLM Wiki

Persistent markdown wiki that sits between curated **raw sources** and **questions**.
Compile source material into wiki pages — summaries, entity pages, cross-links — so
knowledge compounds instead of being rediscovered every query.

Directory layout is defined by the user's schema (e.g. `WIKI.md`). This skill defines
**behaviors**, not fixed paths — always read the schema first.

**Companion rules:** [index-log conventions](./rules/index-log-conventions.md), [optional tooling](./rules/optional-tooling.md).

## Setup

When the user asks to set up an LLM wiki, or when this skill is first activated:

### 1. Locate or create the wiki root
Ask the user where their knowledge base lives (e.g. `/mnt/kb`). If they have an existing wiki, use it. If starting fresh, create `<root>/WIKI.md` (schema), `<root>/index.md` (empty catalog), and `<root>/log.md` (empty log).

### 2. Install the sprinkle
```
sprinkle open llm-wiki
```

### 3. Create the wiki-ops scoop
```
scoop_scoop("wiki-ops")
feed_scoop("wiki-ops", <contents of wiki-ops-brief.md, with WIKI_ROOT replaced>)
```

### 4. Wire the sprinkle route
```
sprinkle route llm-wiki --scoop wiki-ops
```
This bypasses the cone — queries and ingests go straight to wiki-ops.

### 5. Update cone memory
Add to the cone's CLAUDE.md:
- wiki-ops scoop handles query-submit, ingest-submit, lint-wiki events
- The wiki CLI is available as `wiki` (from wiki.jsh)
- Scoops cannot write to mounted paths — the cone must handle log.md appends

## Non-negotiables

1. **Read the wiki schema before editing.** If none exists, ask whether to create a minimal one.
2. **Never modify raw sources.** All synthesis lives in the wiki layer only.
3. **On every ingest:** Integrate into wiki pages, cross-links, update **index**, append to **log**.
4. **Flag contradictions explicitly.** Update pages and record conflicts with dates.
5. **On query:** Read `index.md` first to discover pages. Synthesize with citations. File the answer as a durable wiki page.
6. **On lint:** Find stale claims, orphan pages, missing pages, broken links, gaps.
7. **Log keywords are exactly `ingest`, `query`, or `lint`** — never synonyms. Format: `## [YYYY-MM-DD] ingest | <title>`

## The three layers

| Layer | Role | Who edits |
|-------|------|-----------|
| **Raw sources** | Articles, papers, repos, datasets — evidence | Human curates; agent reads only |
| **Wiki** | Summaries, entity/topic pages, synthesis, backlinks | Agent writes; human reviews |
| **Schema** | Where things live, naming, categories, workflows | Human and agent co-evolve |

## Ingest

1. Locate the new source. Read it (do not edit).
2. Extract entities, claims, relationships; map to existing wiki pages.
3. Create or update affected wiki pages with outbound and inbound links.
4. Update the **index** (one-line blurbs, categories, links).
5. Append to **log** with keyword `ingest`.

## Query

1. **Read `index.md` first** — discover which pages exist.
2. Read relevant topic pages; follow cross-links.
3. Synthesize with **wiki-backed citations** (page paths or section anchors).
4. **File the answer as a wiki page.** Update index. Produce standalone output if also requested.
5. Append to **log** with keyword `query`.

## Lint

1. Scan for contradictions, stale claims, orphan pages, missing pages, broken links.
2. Identify interesting connections and suggest further questions.
3. Present findings or apply fixes per user instruction.
4. Append to **log** with keyword `lint`.

## Anti-patterns

- **RAG-only mindset:** Retrieving chunks without updating the wiki — knowledge does not compound.
- **Editing raw sources** to "fix" typos — violates the evidence layer.
- **Skipping index or log** after ingest — breaks navigation and history.
- **Chat-only answers** with no durable wiki page when building a knowledge base.
- **Silent merges:** Hiding contradictions instead of surfacing them.
- **Schema blindness:** Creating paths that contradict the user's wiki config.

## SLICC integration

### Sprinkle
The `llm-wiki.shtml` sprinkle provides a visual wiki browser with sidebar navigation, markdown rendering with clickable wikilinks, search across note titles, Query Wiki dialog (sends `query-submit` lick), and Ingest Source dialog (sends `ingest-submit` lick). It reads files via `slicc.readDir()` and `slicc.readFile()` which return `{name, type}` objects and strings respectively.

### CLI
The `wiki.jsh` command provides: search, list, read, stats, links, orphans, recent, log, help.

### Architecture
- **llm-wiki sprinkle** → (lick events) → **wiki-ops scoop** (via `sprinkle route`)
- **wiki-ops scoop** reads wiki pages, synthesizes answers, pushes results back via `sprinkle send`
- **Cone** handles log.md writes (scoops cannot write to mounted paths)
- **wiki.jsh** CLI available to all agents for quick lookups
