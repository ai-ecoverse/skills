---
name: index-log-conventions
description: Parseable headings, index shape, and append-only log discipline for LLM-maintained wikis
---

# Index and log conventions

Paths and filenames come from the **wiki schema**. This document describes **behaviors** that work across layouts.

## Index (content catalog)

**Purpose:** Let the agent (and human) find pages without embedding search. At small-to-medium scale, reading the index first is often enough.

**Typical contents:**

- Grouping by category (entities, topics, sources, overviews)—exact names live in schema.
- Each entry: wiki link, one-line summary, optional metadata (date, source count) if the schema uses frontmatter or tables.

**Update rule:** After every ingest that adds or materially changes wiki pages, update the index so it stays a **complete catalog** of wiki pages the schema cares about.

## Log (append-only timeline)

**Purpose:** Chronological audit trail: what happened, when, and which files moved.

**Discipline:**

- **Append only.** Do not rewrite old entries to "clean up"; add a corrective entry if needed.
- **Stable heading pattern** so Unix tools and scripts can parse lines:

```text
## [YYYY-MM-DD] ingest | Short title
## [YYYY-MM-DD] query | Short label
## [YYYY-MM-DD] lint | Short label
```

**Body:** Bullets listing touched wiki paths, new sources referenced, or lint findings summary.

**Grep examples** (adjust path to schema):

```bash
grep '^## \[' wiki/log.md | tail -10
grep 'ingest' wiki/log.md
```

## Optional: YAML frontmatter on wiki pages

If the schema allows, use frontmatter for `date`, `tags`, `sources`—enables structured queries across wiki pages. Do not require it unless the schema says so.
