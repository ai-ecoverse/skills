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
Directory layout is defined by the user's schema (e.g. `WIKI.md`). This skill defines
**behaviors**, not fixed paths — always read the schema first.

## Non-negotiables

1. **Read the wiki schema before editing.** If none exists, ask whether to create a minimal one.
2. **Never modify raw sources.** All synthesis lives in the wiki layer only.
3. **On every ingest:** Integrate into wiki pages, cross-links, update **index**, append to **log**.
4. **Flag contradictions explicitly.** Update pages and record conflicts with dates.
5. **On query:** Read `index.md` first to discover pages. Synthesize with citations. File the answer as a durable wiki page.
6. **On lint:** Find stale claims, orphan pages, missing pages, broken links, gaps.
7. **Log keywords are exactly `ingest`, `query`, or `lint`** — never synonyms. Format: `## [YYYY-MM-DD] ingest | <title>`

## Setup

When the user asks to set up an LLM wiki, or when this skill is first activated:

### 1. Locate or create the wiki root
Ask the user where their knowledge base lives (e.g. `/mnt/kb`). If they have an existing wiki, use it. If starting fresh, create `<root>/WIKI.md` (schema), `<root>/index.md` (empty catalog), and `<root>/log.md` (empty log).

### 2. Install the SLICC sprinkle (optional, when running under SLICC)
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
Routes `query-submit`, `ingest-submit`, and `lint-wiki` licks straight to wiki-ops.

### 5. Update cone memory
Add to the cone's CLAUDE.md: the `wiki-ops` scoop handles query / ingest / lint events; the `wiki` CLI (`wiki.jsh`) is available for quick lookups; the cone must perform `log.md` appends because scoops cannot write to mounted paths.

### Minimal WIKI.md schema template

When creating a fresh wiki, use this as the default `WIKI.md` unless the user specifies otherwise. The directory layout matches the bundled `wiki.jsh` CLI and `wiki-ops` scoop so commands like `wiki list`, `wiki search`, and `wiki recent` work without configuration:

```markdown
# Wiki Schema

## Root
<absolute or relative path to wiki root, e.g. `/mnt/kb`>

## Directory Layout
- `index.md` — master catalog of all pages (one-line blurbs, categories, links)
- `log.md` — append-only operation log (ingest / query / lint entries)
- `people/`, `work/`, `creative/`, `tech/`, `taste/`, `life/`, `events/`, `places/` — topic pages by category (one concept per file)
- `_raw/` — raw sources (read-only; never edited by the wiki layer)

## Conventions
- Wikilinks: `[[page-name]]`
- Citations: `([source: filename])` inline, pointing to a file in `_raw/`
- Contradiction marker: `> ⚠ CONFLICT [YYYY-MM-DD]: <description>`
- Categories: comma-separated tags in index blurbs, e.g. `(ML, architecture)`
```

If the user prefers a different layout, update `wiki.jsh`'s `CATS` / `RAW_DIR` constants and `wiki-ops-brief.md` to match — otherwise the bundled tooling will see an empty wiki.

## Wikilink Validation

Apply whenever wiki pages are created or updated (ingest and query):

- Verify every `[[wikilink]]` in created/updated pages resolves to an existing page in `index.md`.
- For any that do not, either create a stub page or flag as a missing page in the log.
- Record missing page count in the log entry.

## Ingest

1. Locate the new source. Read it (do not edit).
2. Extract entities, claims, relationships; map to existing wiki pages.
3. Create or update affected wiki pages with outbound and inbound links.
4. Update the **index** (one-line blurbs, categories, links).
5. Validate wikilinks per [Wikilink Validation](#wikilink-validation).
6. Append to **log** with keyword `ingest`.

### Example log entry after ingest

```markdown
## [2024-06-10] ingest | Attention Is All You Need (Vaswani et al. 2017)
Pages created: transformer-attention. Pages updated: bert, self-attention. New links: 3. Missing pages flagged: 0.
```

### Example wiki page (condensed)

`tech/transformer-attention.md`:
```markdown
# Transformer Attention

Scaled dot-product attention computes Q·Kᵀ/√d_k before softmax. Multi-head
attention runs h parallel heads then concatenates. ([source: vaswani-2017.pdf])

## Related
- [[self-attention]] — single-sequence variant
- [[bert]] — applies bidirectional self-attention for masked-LM pretraining
```

`index.md` entry:
```markdown
- [transformer-attention](tech/transformer-attention.md) — scaled dot-product & multi-head attention mechanism (ML, architecture)
```

## Query

1. **Read `index.md` first** — discover which pages exist.
2. Read relevant topic pages; follow cross-links.
3. Synthesize with **wiki-backed citations** (page paths or section anchors).
4. **File the answer as a wiki page.** Update index. Produce standalone output if also requested.
5. Validate wikilinks per [Wikilink Validation](#wikilink-validation).
6. Append to **log** with keyword `query`.

### Example log entry after query

```markdown
## [2024-06-11] query | How does BERT use attention?
Pages read: bert, transformer-attention, self-attention. Pages created: tech/bert-attention-usage. Citations: 2. Missing pages flagged: 0.
```

### Example query page (condensed)

`tech/bert-attention-usage.md`:
```markdown
# How Does BERT Use Attention?

BERT uses **bidirectional self-attention**: every token attends to every other
token in the sequence (subject only to padding masks). During masked-LM
pretraining, ~15% of input tokens are replaced with `[MASK]` and the encoder
must predict them from the surrounding bidirectional context. It inherits the
multi-head mechanism from the Transformer encoder
([transformer-attention](transformer-attention.md)), running 12 heads in the
base model. ([source: bert.md, transformer-attention.md])

## Related
- [[transformer-attention]] — underlying attention mechanism
- [[self-attention]] — single-sequence variant BERT specialises
```

## Lint

1. Scan for contradictions, stale claims, orphan pages, missing pages, broken links.
2. Identify interesting connections and suggest further questions.
3. Present findings or apply fixes per user instruction.
4. Append to **log** with keyword `lint`.
