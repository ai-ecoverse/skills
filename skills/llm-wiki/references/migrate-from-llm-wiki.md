# Moving an llm-wiki tree to OKF

An llm-wiki tree is markdown pages without frontmatter, `[[wikilinks]]`, a
hand-written `index.md` and an append-only `log.md` with lines like
`## [YYYY-MM-DD] ingest | title`. To okf, every `.md` file other than
`index.md` and `log.md` is a concept, and okf won't load the bundle while any
of them lacks frontmatter. So the tree can't be validated until it is
migrated.

## 1. Report, change nothing

Work on a copy or a git branch. Count the pages and group them by folder,
then list what each page needs:

- **Frontmatter:** at least `type`. Derive it from the folder (`people/` →
  `Person`, `projects/` → `Project`, `places/` → `Place`), and ask the user
  when a folder doesn't say.
- **Title and description:** the first heading becomes `title`, the first
  sentence `description`.
- **Links:** each `[[name]]` becomes `[name](/<folder>/<name>.md)`. List the
  wikilinks that match no page; they stay as links to missing concepts.
- **Non-concept files:** `README.md`, `WIKI.md` and similar either get
  frontmatter (`type: Reference`) or move out of the bundle.
- **Raw sources** (`_raw/` and the like): leave them as they are, outside the
  bundle or under `references/`, and point to them from `sources`.

Show the user the report and the proposed type for each folder before
changing anything.

## 2. One page, then the rest

Migrate a single page, run `okf show <root> <id>` on it, and show the user
the result. Then go folder by folder, with the user's go-ahead for each
batch. Before each batch, check that the files are tracked in git, or back
them up.

## 3. Index and log

- **index.md:** OKF's index lists a directory's concepts with their
  descriptions (OKF §8). A hand-written orientation `index.md` can stay as it
  is. Don't run `okf index` over it unless the user wants okf to own the
  indexes from then on.
- **log.md:** keep the old log as it is. New entries go in through
  `wiki log`, which writes OKF's format (`## YYYY-MM-DD` groups, newest
  first) at the top of `log.md`. If the old log's format must not mix with
  OKF's, the user can move it to `references/llm-wiki-log.md` first.

## 4. Validate

`okf validate <root>` must report 0 errors. Then run `okf lint <root>` and
show the warnings. Only fix them with the user's consent.
