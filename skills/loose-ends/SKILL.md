---
name: loose-ends
description: "A persistent to-do / follow-up list that lives in a sprinkle panel alongside the chat. Use when the user wants to track loose ends, open follow-ups, waiting-on-others items, or 'things I still need to do' across sessions — a durable backlog the cone maintains and resurfaces. Each item has a title and a rich context blob (why it's open, what to do, links). The panel offers two actions per row: 'Do' (hand the item to the cone to work on now) and 'Done' (remove it). Triggers on 'loose ends', 'my to-do list', 'open follow-ups', 'things I still need to do', 'track this for later', 'add a loose end', 'what's still open'."
allowed-tools: bash
---

# Loose ends

A durable, cross-session to-do list rendered as a sprinkle panel. Unlike the
`monday` triage (which rates a live feed) or `review` (which tracks
publish/annotate state), loose-ends is a hand-curated backlog of open threads
the user wants kept in view until they're truly done.

Each task carries a **title** and a free-form **context** blob — the "why it's
open / what to do next / links" — so a future session (or a future you) can pick
it up cold. The panel shows the title, an expandable context preview, and two
buttons: **Do** and **Done**.

## Architecture — who owns what

Two owners, one authoritative file. Keep them separate:

- **Store — cone-owned.** `/shared/loose-ends.json` is the single source of
  truth. **Only the cone writes it.** It survives scoop restarts and session
  reloads, so task truth never depends on the (disposable) UI scoop being alive.
- **Sprinkle — scoop-owned.** One scoop named `loose-ends` owns the panel at
  `/shared/sprinkles/loose-ends/loose-ends.shtml`. Per the SLICC sprinkle rule,
  **the cone MUST NOT write the `.shtml` or run `sprinkle`** — it delegates every
  panel operation (open, reload, `sprinkle send`) to that scoop via `feed_scoop`.

The scoop is a puppet: the store is what matters. If the scoop dies, recreate it
and reseed from the store (see [Resurrecting](#resurrecting-in-a-new-session)).

### Store schema

```json
{
  "updated": "2026-07-30T17:22:24.862Z",
  "tasks": [
    {
      "id": "le-example",
      "title": "Short imperative title",
      "context": "The full why/what/links blob. Can be long — the panel truncates a preview and expands on click.",
      "created": "2026-07-30T17:15:00Z"
    }
  ]
}
```

- `id` — stable, unique, kebab-case (e.g. `le-<slug>`). Upserts key on it.
- `title` — one-line imperative summary shown in bold.
- `context` — optional rich text; the panel shows a ~140-char preview with a
  "more" toggle.
- `created` — ISO timestamp (informational).
- Bump the top-level `updated` on every store write.

## Quick-start / bootstrap

The skill ships a helper (`loose-ends`) that the **owning scoop** runs to install
the template, open the panel, and reseed it from the store in one step:

1. **Create the scoop:** `scoop_scoop("loose-ends")`.
2. **Bootstrap + reseed in one step** (delegate to the scoop):
   ```
   feed_scoop("loose-ends", "Run: loose-ends bootstrap
   That copies the template into /shared/sprinkles/loose-ends/, refreshes the VFS, opens the panel, and loads all tasks from /shared/loose-ends.json. Confirm the panel is visible, then STAY ALIVE for lick events — do NOT finish.")
   ```
3. That's it — the panel is now live and seeded. The cone handles licks and store
   writes from here.

> If the store doesn't exist yet, `loose-ends bootstrap` opens an empty panel
> (the cone creates `/shared/loose-ends.json` on the first `add-item`).

### The `loose-ends` helper (scoop-side, read-only on the store)

```
loose-ends bootstrap   # copy template → sprinkle refresh → sprinkle open → reseed from store
loose-ends reseed      # just re-send load-items from the store to an open panel
```

Options (all `--long` form): `--name <n>` (default `loose-ends`),
`--store <path>` (default `/shared/loose-ends.json`),
`--template <path>` (default the skill's `templates/loose-ends.shtml`).

The helper only **reads** the store — it never writes tasks (that stays the
cone's job). Run it from the owning scoop; it drives `sprinkle`.

## Adding, updating, and removing tasks

The cone owns the store, so it does two things per change: **write the JSON**
(direct file edit) **and** tell the scoop to update the panel.

**Add / update a task (upsert by `id`):**
1. Cone appends/replaces the task in `/shared/loose-ends.json` and bumps `updated`.
2. Cone → scoop:
   ```
   feed_scoop("loose-ends", "sprinkle send loose-ends '{\"action\":\"add-item\",\"task\":{\"id\":\"le-foo\",\"title\":\"...\",\"context\":\"...\",\"created\":\"2026-07-30T00:00:00Z\"}}'")
   ```
   `add-item` upserts: an existing `id` is replaced in place; a new `id` is
   appended.

**Remove a task:**
1. Cone deletes it from the store and bumps `updated`.
2. Cone → scoop: `sprinkle send loose-ends '{"action":"remove-item","id":"le-foo"}'`.

**Replace the whole list** (e.g. after a bulk edit) — reseed:
`sprinkle send loose-ends '{"action":"load-items","tasks":[ ... ]}'` (or just
`loose-ends reseed`).

## Lick events (panel → cone)

The panel fires these licks back to the cone as `[Sprinkle Event: loose-ends]`:

| Action | Data | When | Cone handler |
|--------|------|------|--------------|
| `do`   | `{ id, title, context }` | User clicks **Do** | Start working the task now, using `context` as the brief. The row stays in the list (a "Do" is not a completion). |
| `done` | `{ id, title }` | User clicks **Done** | The panel already removed the row optimistically. Remove that `id` from `/shared/loose-ends.json` and bump `updated`. No panel round-trip needed. |

> **`done` is optimistic in the panel.** The row disappears the instant the user
> clicks, then the lick fires. The cone's only job is to make the store match by
> deleting the task. Do not re-send `remove-item` for a `done` (the row is
> already gone) unless you're reconciling a mismatch.

## Inbound messages (cone → panel, via `sprinkle send loose-ends`)

| Action | Payload | Effect |
|--------|---------|--------|
| `load-items` | `{ tasks:[...] }` | Replace the entire list (full reseed). |
| `add-item` | `{ task:{id,title,context,created} }` | Upsert one task by `id` (replace if present, else append). |
| `remove-item` | `{ id }` | Remove one task by `id`. |

## Resurrecting in a new session

Session/page reloads close all tabs and drop the running scoop, but the store
persists. To bring the panel back exactly as it was:

1. `scoop_scoop("loose-ends")` (recreate the owning scoop).
2. `feed_scoop("loose-ends", "Run: loose-ends bootstrap — then stay alive for lick events, do NOT finish.")`

`bootstrap` re-copies the template, reopens the panel, and reseeds every task
from `/shared/loose-ends.json`. The cone resumes handling `do`/`done` licks and
store writes.

## Notes

- **Reloading after template edits:** `sprinkle refresh` only re-scans the VFS —
  it does not reload an open panel. To pick up template changes, close then
  reopen from the scoop: `sprinkle close loose-ends && sprinkle refresh && sprinkle open loose-ends`,
  then `loose-ends reseed`.
- **No emojis in the UI** — the panel uses Lucide icons (`list-checks`, `check`,
  `arrow-right`), per the SLICC style guide.
- **Template:** `templates/loose-ends.shtml` (full-document mode). It persists
  its own view via `slicc.setState`/`getState`, but the store is authoritative —
  always reseed from `/shared/loose-ends.json` on bootstrap.
