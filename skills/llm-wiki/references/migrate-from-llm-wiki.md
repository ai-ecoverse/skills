# Moving an llm-wiki tree to OKF

An llm-wiki tree is markdown pages without frontmatter, `[[wikilinks]]`, a
hand-written `index.md` and an append-only `log.md` with headings like
`## [YYYY-MM-DD] ingest | title`. okf loads every `.md` file in the bundle
that isn't under a dot-directory (such as `.raw/`), and treats each one other
than `index.md` and `log.md` as a concept. It won't load the bundle while any
of them lacks frontmatter, and `okf validate` reports every old log heading as
an ERROR (`okf/reserved/log-date-heading`). So the tree can't be validated
until it is migrated.

## 1. Report, change nothing

Work on a copy or a git branch. Count the pages and group them by folder,
then list what each page needs:

- **Frontmatter:** at least `type`. Derive it from the folder (`people/` →
  `Person`, `projects/` → `Project`, `places/` → `Place`), and ask the user
  when a folder doesn't say.
- **Title and description:** the first heading becomes `title`, the first
  sentence `description`.
- **Links:** how many `[[wikilinks]]` resolve, and which are ambiguous or
  missing (see step 3).
- **Non-concept files:** `README.md`, `WIKI.md` and similar either get
  frontmatter (`type: Reference`) or move out of the bundle.
- **Raw sources** (`_raw/` and the like): they must leave the bundle root,
  since okf would load them as concepts. Move them outside the bundle, or
  into a dot-directory such as `.raw/`, and point to them from `sources`.
  Don't edit them.
- **The log:** how many old entries it has, and which have a bracket that
  isn't a single date (step 4).

Show the user the report and the proposed type for each folder before
changing anything.

## 2. One page, then the rest

Migrate a single page, run `okf show <root> <id>` on it, and show the user
the result. Then go folder by folder, with the user's go-ahead for each
batch. Before each batch, check that the files are tracked in git, or back
them up.

## 3. Wikilinks

Rewrite each `[[name]]` (or `[[name|label]]`) as `[label](/<path>.md)`:

- Match `name` against the pages' file names without `.md`, ignoring case
  and Unicode normalization (NFC and NFD match). When more than one page
  matches, prefer the one in the linking page's folder.
- Write the target's path exactly as it is on disk. okf resolves links
  byte for byte, so `/People/Ada.md` doesn't reach `people/ada.md`. Keep
  spaces as they are: okf 0.5 reads neither `%20` nor `<…>` in a link.
- Leave an ambiguous or missing target as `[[name]]` and list it for the
  user. okf ignores `[[…]]`, so it doesn't fail validation, but the panel
  shows it as plain text.

## 4. Index and log

- **index.md:** OKF's index lists a directory's concepts with their
  descriptions (OKF §8). A hand-written orientation `index.md` can stay as it
  is. Don't run `okf index` over it unless the user wants okf to own the
  indexes from then on.
- **log.md:** convert it, or the bundle won't validate. Keep the `# ` title,
  then group the entries under `## YYYY-MM-DD` headings, newest first. Each
  old entry becomes `* **Kind**: title` (`ingest` → `Ingest`), with its body
  lines unchanged below it. When an entry's bracket isn't a single date (a
  range, or text), file it under the previous entry's date and keep the
  bracket text at the start of the title. Moving the old log into the bundle
  instead (as `references/llm-wiki-log.md`, say) makes it a concept that
  needs frontmatter. New entries go in through `wiki log`, which adds today's
  group at the top, below the title.

## 5. Validate

`okf validate <root>` must report 0 errors. Then run `okf lint <root>` and
show the warnings. Only fix them with the user's consent.
