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

1. **Locate or create the wiki root.** Ask where the knowledge base lives (e.g. `/mnt/kb`).
   Use an existing wiki if there is one. If starting fresh, create `<root>/WIKI.md`
   (schema), `<root>/index.md` (empty catalog), and `<root>/log.md` (empty log).
2. **Write the schema.** Use the default in [`references/wiki-schema.md`](references/wiki-schema.md)
   unless the user wants a different layout (that file also lists the constants to
   keep in sync with the bundled CLI).

Running under SLICC? See [`references/slicc-integration.md`](references/slicc-integration.md)
to wire the sprinkle browser, the `wiki-ops` scoop, and the `wiki.jsh` CLI. None of
that is required for plain-markdown use.

## Wikilink validation

Apply whenever wiki pages are created or updated (ingest and query):

- Verify every `[[wikilink]]` in created/updated pages resolves to an existing page in `index.md`.
- For any that do not, either create a stub page or flag it as a missing page in the log.
- Record the missing-page count in the log entry.

## Ingest

1. Locate the new source. Read it (do not edit).
2. **Extract entities, claims, and relationships; map each to a wiki page.** Work
   concretely — turn the source into a small mapping table before writing anything:

   | Extracted | Type | Maps to |
   |-----------|------|---------|
   | RAII | entity | `tech/raii.md` (new page) |
   | "RAII binds resource lifetime to object scope" | claim | a sentence in `tech/raii.md`, with `([source: …])` |
   | RAII → destructors | relationship | `[[destructors]]` link, added on both pages |

   Entities become page files, claims become cited sentences in the page body, and
   relationships become `[[wikilinks]]` written on **both** endpoints.
3. Create or update the affected pages with outbound and inbound links.
4. Update the **index** (one-line blurbs, categories, links).
5. Validate wikilinks per [Wikilink validation](#wikilink-validation).
6. Append to the **log** with keyword `ingest`.

See [`references/examples.md`](references/examples.md) for a full worked ingest —
log entry, wiki page, and matching index entry.

## Query

1. **Read `index.md` first** — discover which pages exist.
2. Read the relevant topic pages; follow cross-links.
3. Synthesize with **wiki-backed citations** (page paths or section anchors).
4. **File the answer as a wiki page.** Update the index. Produce standalone output if also requested.
5. Validate wikilinks per [Wikilink validation](#wikilink-validation).
6. Append to the **log** with keyword `query`.

See [`references/examples.md`](references/examples.md) for a worked query — log entry
and filed answer page.

## Lint

1. **Scan** the index and category folders for: broken wikilinks, missing pages,
   orphan pages (no inbound links), stale claims, and contradictions.
2. **Remediate by finding type** (apply fixes only with user consent; otherwise present them):

   | Finding | Fix |
   |---------|-----|
   | Broken wikilink | Repoint to the correct page, or create a stub, or flag as missing in the log. |
   | Missing page | Create a stub page and add it to the index, or record it in the log. |
   | Orphan page | Add inbound `[[links]]` from related pages, or flag for archival. |
   | Stale claim | Date it and, if newer sources disagree, add a contradiction marker. |
   | Contradiction | Add `> ⚠ CONFLICT [YYYY-MM-DD]: <description>` to **both** pages. |

3. **Re-validate after fixing:** rerun step 1 to confirm no fix introduced a new
   broken link or orphan. Repeat until the scan is clean.
4. **Error recovery:** if a page cannot be read or a fix cannot be applied, skip it,
   keep going, and record the failure in the log — never leave the index or log
   half-updated. If interrupted mid-fix, append a corrective log entry rather than
   rewriting an earlier one.
5. Suggest interesting connections and further questions surfaced by the scan.
6. Append to the **log** with keyword `lint`, including counts per finding type.

## References

- [`references/wiki-schema.md`](references/wiki-schema.md) — default `WIKI.md` schema template.
- [`references/examples.md`](references/examples.md) — worked ingest and query outputs.
- [`references/slicc-integration.md`](references/slicc-integration.md) — optional SLICC sprinkle / scoop / CLI wiring.
- [`references/wiki-ops-brief.md`](references/wiki-ops-brief.md) — system prompt for the `wiki-ops` scoop.
