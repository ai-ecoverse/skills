# WIKI.md schema template

Use this as the default `WIKI.md` when creating a fresh wiki, unless the user
specifies otherwise. The directory layout matches the bundled `wiki.jsh` CLI and
the `wiki-ops` scoop, so `wiki list`, `wiki search`, and `wiki recent` work
without extra configuration.

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

## Changing the layout

If the user prefers a different layout, keep the tooling in sync so the bundled
CLI does not see an empty wiki:

- Update `wiki.jsh`'s `CATS` and `RAW_DIR` constants to match the new folders.
- Update `references/wiki-ops-brief.md` (the scoop brief) to list the same
  category folders.
