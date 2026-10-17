# loose-ends store

The store `/shared/loose-ends.json` is the source of truth; mutate it through the `loose-ends` CLI (see [SKILL.md](../SKILL.md)).

## Schema

```json
{
  "updated": "2026-07-30T18:08:00.000Z",
  "tasks": [
    {
      "id": "le-example",
      "title": "Short imperative title",
      "summary": "Human-facing: what this is and why it's still open, in a sentence or two. Always visible on the card.",
      "detail": "Agent-facing: the full working brief — exact next actions, addresses, file paths, links, GUIDs. Collapsed behind an \"Agent brief\" toggle.",
      "created": "2026-07-30T17:15:00Z",
      "skills": ["sessionize", "gmail"],
      "snoozedUntil": null,
      "cone": "cone-adobe",
      "session": {
        "id": "c20ed555-454d-4bc1-925c-2d11f7e2074d",
        "file": "2026-07-30T17-23-30-891Z-slicc-speaking-talks-and-loose-ends.md",
        "at": "2026-07-30T17:23:30.891Z"
      }
    }
  ]
}
```

- `id` — stable, unique, kebab-case (e.g. `le-<slug>`). Upserts key on it.
- `title` — one-line imperative summary shown in bold.
- **`summary` — human-facing.** The at-a-glance "what & why", always visible. Keep it short and readable.
- **`detail` — agent-facing.** The full brief the cone acts on: concrete steps, contacts, paths, links. Shown collapsed under an "Agent brief" toggle; can be long.
- **`url` — optional primary link.** When set, the card shows a **View** button (or **Map** for Google/Apple Maps URLs) that opens the link in a new browser tab via `open`, entirely inside the sprinkle — no cone round-trip. Bare `http(s)://` URLs inside `summary`/`detail` are also linkified. If `url` is omitted the panel falls back to the first maps URL (then any URL) found in the text.
- `created` — ISO timestamp (informational; rendered on the card).
- `skills` — optional `string[]` of the SLICC skills involved (e.g. `["sessionize","gmail"]`). Rendered as tag chips on the card and passed through to the monday item.
- `snoozedUntil` — optional ISO timestamp. When set to a **future** time the task is *snoozed*: the panel renders it, greyed and compact, in a collapsed "Snoozed (N)" section at the **bottom** of the list, and it is **excluded** from `loose-ends monday` output (it isn't "open now"). Absent, `null`, or a **past** timestamp = active (a passed snooze auto-resurfaces to the active list). See [Snooze](../SKILL.md#snooze).
- `cone` — filing cone folder stamped at `create` from `$TMPDIR` (`/tmp/<cone>` or `/tmp/<cone>/<scoop>`). Cone-bound panel actions (`do`, `open-session`) pass it as Layer-B `slicc.lick({ target })` so a weeks-old panel still delivers to the filer. Scoop-local actions (`snooze`, `unsnooze`, `done`, `request-load`) omit `target`. Override with `--cone <folder>`. Optional on legacy rows.
- `session` — provenance into `/sessions/`: `{ id, file, at }` linking the task back to the conversation that spawned it (see [Session provenance](#session-provenance)). Optional.
- Bump the top-level `updated` on every store write.

> **Back-compat.** Older tasks used a single `context` field (== the agent
> `detail`) with no `summary`/`session`. The template still reads `context` as a
> fallback for `detail`, and if there's no `summary` it shows the detail (when
> short) or hides it behind the brief toggle. Prefer `summary` + `detail` for new
> tasks.

## Session provenance

Every task can point back to the `/sessions/` transcript it came from. Each
session file is named `<ISO-ts>-<slug>.md` and indexed in `/sessions/index.json`
as `{ filename, title, frozenAt, sessionId, ... }`.

- **Resolve a task's origin session by time:** a task `created` at time *T*
  belongs to the session whose `frozenAt` is the smallest value `>= T` (sessions
  are sequential; the one frozen just after the task was created was the active
  one). Populate `session` = `{ id: sessionId, file: filename, at: frozenAt }`.
- The **live** (unfrozen) session isn't in `index.json` yet, so a task created
  mid-session may not resolve until that session is frozen — set what you know
  (`at` = now) and reconcile later with the same rule.
- On the card, the provenance renders as a **"from &lt;date&gt;"** link; clicking
  it fires an `open-session` lick (see below).

## Monday integration (source protocol)

Loose ends are open follow-ups, so they belong in the daily `monday` triage. The
helper exposes a monday-compatible source command:

```bash
loose-ends monday --limit N --depth N --date Nd   # prints a JSON array to stdout
```

It reads the store and emits one monday item per task. Notes:

- Each item = `{ id, ts, source:"loose-ends", title, body:<summary>, detail, skills, session, rating_hint }`.
  `id` is the task id (already stable/unique), `ts` is `created`, `body` is the
  human summary, and `rating_hint` tells the rater these are user-curated
  follow-ups carrying real intent (actionable unless the summary says they're
  waiting on someone else).
- **`--date` is intentionally ignored** — a loose end from weeks ago is still
  open, so the whole backlog surfaces (bounded by `--limit`). `--depth` is
  accepted and ignored.
- Include it in a run positionally — `monday loose-ends gh gmail` — or add
  `loose-ends` to `KNOWN_COMMANDS` in `monday/scripts/monday.jsh` for
  auto-discovery. See `monday/references/SOURCE_PROTOCOL.md`.

