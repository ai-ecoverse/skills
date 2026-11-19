---
name: llm-wiki
description: Build and maintain a persistent knowledge base in the Open Knowledge Format (OKF) — a folder of markdown concepts with YAML frontmatter — using the okf CLI as its engine and a wiki helper for the bundle root, log.md and a browsing panel. Use when the user wants to create a knowledge base or wiki, ingest an article, paper, transcript or note into it, ask what it knows, organize research notes, validate or lint it for broken links, missing types and stale concepts, find what links to a page, browse it in a SLICC panel, or move an older llm-wiki tree to OKF. Triggers on knowledge base, KB, wiki, OKF, Open Knowledge Format, okf validate, ingest, research notes, personal wiki, concept, backlinks.
allowed-tools: bash
---

# LLM Wiki (OKF)

A knowledge base is an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle: a directory tree of **concepts**, one markdown file each, with YAML frontmatter. A concept's id is its path without `.md`. `index.md` and `log.md` are reserved at every level. Two commands do the work:

- `okf` (`@ai-ecoverse/wasi-okf`) creates, validates, lints, indexes, lists, shows, searches and graphs a bundle, and prints JSON on stdout.
- `wiki` (this skill) keeps the bundle root, runs okf on it, writes `log.md` entries, and installs the panel.

## Setup

```bash
pnpm add -g @ai-ecoverse/wasi-okf <this skill's folder>   # okf and wiki on PATH
okf init ~/kb                                             # or use an existing bundle
wiki config set root ~/kb                                 # --root and WIKI_ROOT override it
wiki okf validate                                         # okf validate <root>
```

`wiki --help` lists every command. `wiki okf <command> [args]` is `okf <command> <root> [args]`, and exits with okf's status: 0 ok, 1 validation error, 2 I/O error, 4 usage error.

## Rules

1. **Every concept has `type`.** It is the only required key. Add `title`, a one-sentence `description` and `tags`, because search, indexes and the panel show them.
2. **Never edit raw sources.** Keep them outside the bundle, or under `references/`, and point to them from `sources`.
3. **Link with bundle-relative paths**, such as `[events](/tables/events.md)`. A link to a missing concept is allowed: it marks knowledge not yet written.
4. **Record provenance.** Use `sources: [{ id, resource, title }]` and attribute claims with footnotes keyed by `id` (`[^id]`). Set `generated: { by: <agent>/<model>, at: <ISO time> }` on what you write. Leave `verified` for whoever checks it; use `human:<id>` only when a person confirmed it.
5. **Log every change** with `wiki log <Kind> <message>` (kinds: Creation, Update, Deprecation). It keeps OKF's format: date headings, newest first.
6. **Validate after every change.** Run `wiki okf validate` and fix every ERROR before you report back.
7. **`okf index` rewrites `index.md` in every directory.** Run it only on a bundle whose indexes okf owns. Ask before running it over hand-written indexes.

A concept:

```markdown
---
type: Paper
title: Attention Is All You Need
description: The Transformer, a sequence model built only from attention.
tags: [ml, transformers]
sources:
  - { id: arxiv, resource: https://arxiv.org/abs/1706.03762, title: arXiv 1706.03762 }
generated: { by: sliccy/claude, at: 2026-11-19T10:00:00Z }
---

The model drops recurrence entirely.[^arxiv] See [self-attention](/concepts/self-attention.md).

[^arxiv]: arXiv 1706.03762
```

## Ingest

1. Read the source. Don't change it.
2. List what it adds: entities and ideas (each becomes a concept), claims (cited sentences in a concept), and relationships (links, written on both concepts).
3. Look up each candidate before you create it, with `wiki okf search --text <name>` and `wiki okf show <id>`. Update an existing concept rather than adding a duplicate.
4. Write or update the concepts (rules 1–4).
5. When two sources disagree, keep both claims with their footnotes. Add `> CONFLICT <date>: <what disagrees>` to each concept involved.
6. Run `wiki okf validate`, then `wiki log Update "<what changed, with links>"`.

## Query

1. Find candidates: `wiki okf search --text <words>`, `--tag <t>` or `--type <T>`, or read `index.md`.
2. Read them with `wiki okf show <id>` (the frontmatter and body as JSON). Follow links, and `wiki okf backlinks <id>` for what points back.
3. Answer with citations to concept ids. When the answer is worth keeping, file it as a concept (`type: Answer` or a better fit) and log it.

## Lint

`wiki okf lint` reports missing recommended fields and style problems as warnings. `wiki okf validate` reports spec violations. `wiki okf graph` gives the link graph; concepts with no inbound edges are orphans. A concept is stale when its `stale_after` time has passed. Present the findings grouped by kind. Fix only what the user agrees to, then validate and log again.

## The panel (SLICC)

```bash
wiki sprinkle                    # ~/sprinkles/llm-wiki/ (SLICC 6: /shared/sprinkles/llm-wiki/)
panel open sprinkle:llm-wiki     # SLICC 7
```

The panel lists concepts grouped by folder, with search and a type filter. Opening a row shows its metadata, tags, body, and what links to it; links to other concepts open them in the panel. It runs okf through its own `cgi-bin/` (`concepts`, `show`; read-only GETs, see [references/cgi-bin.md](references/cgi-bin.md)), so browsing needs no agent turn. Run `wiki sprinkle` again after the root moves.

Its text box sends a lick on `sprinkle:llm-wiki` with action `ask` and body `{ text, root, concept? }`, where `concept` is the open concept's id. Treat the text as a request from the user: answer it with Query, or Ingest it when it is a source. The body comes from the frame, so pass ids to commands as single arguments.

## Moving an llm-wiki tree to OKF

okf won't load a bundle in which any `.md` file other than `index.md` and `log.md` has no frontmatter. It stops at the first one (`parse README.md: no YAML frontmatter block found`). A page-per-topic llm-wiki tree with `[[wikilinks]]` therefore needs migrating. Follow [references/migrate-from-llm-wiki.md](references/migrate-from-llm-wiki.md): report first, then one page at a time with the user's consent.
