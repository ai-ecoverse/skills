# Knowledge base

This directory is where the sprinkle's **local-context** knowledge-base
mode (`kb_mode=local`) looks for source material by default
(`/shared/sprinkles/interview-me/kb/`, once installed). It ships empty —
drop your own `.md`/`.txt` files here.

## Two knowledge-base modes

### Local (default, no credentials needed)

Set `kb_mode=local` (the default for a fresh install) and put `.md`/`.txt`
files in this directory (or point `kb_path` at any other readable VFS
folder). The sprinkle loads every file directly from the VFS, chunks it
(~900 chars, 150 char overlap), and ranks the chunks against the interview
topic with a small dependency-free BM25 implementation (`lib/ranker.js`).
The top-scoring excerpts (capped at ~12,000 characters) get injected into
the model's `instructions` under a `## Source material` heading, and the
agent can pull more mid-interview via a `lookup_documents` function tool.

This is the right choice for a handful of short-to-medium notes (a few KB
each) — it re-sends the injected excerpts as part of `instructions` on
every `session.update`, so it doesn't scale to a large corpus.

### Collection (xAI Collections, semantic search)

For a larger or more precise knowledge base, create an xAI Collection (a
standard API key is enough — no Management key needed) and ingest
documents into it:

```
interview-me collections create my-notes
interview-me collections ingest /path/to/your/notes my-notes
interview-me set collection=<collection_id>
```

This switches the sprinkle to real semantic search (`file_search`) against
the collection instead of the local BM25 ranker, and scales to far more
material. No default collection is provided by this skill — you always
create your own.

## Choosing what goes here

The ranker doesn't care about subject matter — pick documents that would
help an interviewer ask you specific, informed questions: project notes,
a personal wiki, README files, a braindump of what you've been working on,
etc. Markdown or plain text only.
