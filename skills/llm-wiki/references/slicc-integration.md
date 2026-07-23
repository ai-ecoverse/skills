# SLICC integration (optional)

Only relevant when running this skill under [SLICC](https://github.com/ai-ecoverse/slicc).
Plain markdown in a git tree needs none of this — the core ingest / query / lint
behaviors work without any framework wiring.

## Companion files bundled with this skill

- `references/wiki-ops-brief.md` — system prompt for the `wiki-ops` scoop (the
  dedicated agent that handles query / ingest / lint events).
- `wiki.jsh` — a small CLI for quick lookups (`wiki list`, `wiki search`,
  `wiki read`, `wiki stats`, `wiki orphans`, `wiki links`, `wiki recent`,
  `wiki log`). It reads the wiki root defined by its `WIKI_ROOT` constant.
- `llm-wiki.shtml` — a sprinkle browser (sidebar nav, search, wikilinks, and
  query / ingest dialogs).

## Wiring the sprinkle and scoop

1. **Install the sprinkle:**
   ```
   sprinkle open llm-wiki
   ```

2. **Create the wiki-ops scoop** and feed it the brief:
   ```
   scoop_scoop("wiki-ops")
   feed_scoop("wiki-ops", <contents of references/wiki-ops-brief.md, with WIKI_ROOT replaced>)
   ```

3. **Route sprinkle events to the scoop:**
   ```
   sprinkle route llm-wiki --scoop wiki-ops
   ```
   This routes the `query-submit`, `ingest-submit`, and `lint-wiki` licks
   straight to `wiki-ops`.

4. **Update cone memory.** Add to the cone's `CLAUDE.md`:
   - the `wiki-ops` scoop handles query / ingest / lint events;
   - the `wiki` CLI (`wiki.jsh`) is available for quick lookups;
   - the cone must perform `log.md` appends, because scoops cannot write to
     mounted paths.
