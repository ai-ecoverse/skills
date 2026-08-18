---
name: loose-ends
description: "A persistent to-do / follow-up list that lives in a sprinkle panel alongside the chat. Use when the user wants to track loose ends, open follow-ups, waiting-on-others items, or 'things I still need to do' across sessions — a durable backlog the cone maintains and resurfaces. Each item has a title and a rich context blob (why it's open, what to do, links). The panel offers three actions per row: 'Do' (hand the item to the cone to work on now), 'Snooze' (hide it until Tomorrow / Next Monday / Next week / a picked date, then auto-resurface), and 'Done' (remove it). Triggers on 'loose ends', 'my to-do list', 'open follow-ups', 'things I still need to do', 'track this for later', 'add a loose end', 'snooze this until', 'mute until Monday', 'what's still open'."
allowed-tools: bash
---

# Loose ends

A durable, cross-session to-do list rendered as a sprinkle panel. Unlike the
`monday` triage (which rates a live feed) or `review` (which tracks
publish/annotate state), loose-ends is a hand-curated backlog of open threads
the user wants kept in view until they're truly done.

Each task carries a **title**, a human-facing **summary** (the at-a-glance what &
why), and an agent-facing **detail** brief (the full "what to do next / links"),
plus a **created** timestamp and optional **session** provenance linking it back
to the `/sessions/` transcript it came from — so a future session (or a future
you) can pick it up cold. The panel shows the title and summary, a collapsible
"Agent brief", a created date, a "from &lt;date&gt;" link to the origin session,
and two buttons: **Do** and **Done**.

## Architecture — who owns what

Two concerns, one authoritative file. Keep the *lifecycle* concerns separate,
but mutate through one API:

- **Store — the source of truth.** `/shared/loose-ends.json` survives scoop
  restarts and session reloads, so task truth never depends on the (disposable)
  UI scoop being alive. **Mutate it through the `loose-ends` CLI**
  (`create` / `done` / `snooze` / `unsnooze`), which does an atomic full rewrite
  *and* best-effort syncs an open panel in one step. Prefer the CLI over
  hand-editing the JSON (fewer footguns, keeps the panel in step).
- **Sprinkle lifecycle — scoop-owned.** One scoop named `loose-ends` owns the
  panel at `/shared/sprinkles/loose-ends/loose-ends.shtml`. Per the SLICC sprinkle
  rule, **the cone MUST NOT author the `.shtml` or run the panel-lifecycle
  commands** (`sprinkle refresh` / `open` / `reload` / `close`) — it delegates
  those to that scoop via `feed_scoop`. (Lightweight `sprinkle send` messaging is
  what the mutation CLI does internally and is fine from either process.)

The scoop is a puppet: the store is what matters. If the scoop dies, recreate it
and reseed from the store (see [Resurrecting](#resurrecting-in-a-new-session)).

### CLI — the mutation & reporting API

```bash
loose-ends list                     # active + snoozed, human-readable
loose-ends list --snoozed --json    # filter/format
loose-ends create --title "Ping Marta re: Code Europe slot" \
  --summary "Waiting on her reply to the abstract" \
  --detail "Full brief: contacts, links, next steps…" \
  --skills gmail,outlook [--id le-custom] [--snooze monday]
loose-ends done   <id>              # remove
loose-ends snooze <id> <tomorrow|monday|week|YYYY-MM-DD>   # hide until (09:00 local)
loose-ends unsnooze <id>            # wake now
```

`create` upserts when `--id` matches an existing task. Every mutating command
writes the store atomically (bumps `updated`) then best-effort `sprinkle send`s
the matching panel message; a failed/absent send prints a note and is non-fatal
(the panel self-hydrates on next open, or `loose-ends reseed` catches up).


### Store schema

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
- `snoozedUntil` — optional ISO timestamp. When set to a **future** time the task is *snoozed*: the panel renders it, greyed and compact, in a collapsed "Snoozed (N)" section at the **bottom** of the list, and it is **excluded** from `loose-ends monday` output (it isn't "open now"). Absent, `null`, or a **past** timestamp = active (a passed snooze auto-resurfaces to the active list). See [Snooze](#snooze).
- `session` — provenance into `/sessions/`: `{ id, file, at }` linking the task back to the conversation that spawned it (see [Session provenance](#session-provenance)). Optional.
- Bump the top-level `updated` on every store write.

> **Back-compat.** Older tasks used a single `context` field (== the agent
> `detail`) with no `summary`/`session`. The template still reads `context` as a
> fallback for `detail`, and if there's no `summary` it shows the detail (when
> short) or hides it behind the brief toggle. Prefer `summary` + `detail` for new
> tasks.

### Session provenance

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

`bootstrap`/`reseed` drive `sprinkle` lifecycle — run them from the owning scoop.
The mutation commands (`create`/`done`/`snooze`/`unsnooze`) and `list`/`monday`
can run from either process (they write the store atomically and only *message*
the panel).

## Adding, updating, and removing tasks

**Prefer the CLI** — one atomic command writes the store *and* syncs the panel:

```bash
loose-ends create --title "…" --summary "human what & why" \
  --detail "agent brief: steps, contacts, paths, links" --skills gmail,outlook
loose-ends done   le-foo          # remove
loose-ends snooze le-foo monday   # hide until (tomorrow|monday|week|YYYY-MM-DD)
loose-ends unsnooze le-foo        # wake now
```

`create` upserts by `--id` (auto-generated `le-<slug>` when omitted) and accepts
`--snooze <when>`, `--session-file`/`--session-id`/`--session-at`.

<details><summary>Manual flow (fallback / advanced)</summary>

If you must edit the JSON by hand, do both halves yourself: write
`/shared/loose-ends.json` (bump `updated`) **and** message the panel via the scoop:

- Add/update (upsert by `id`):
  `feed_scoop("loose-ends", "sprinkle send loose-ends '{\"action\":\"add-item\",\"task\":{\"id\":\"le-foo\", … }}'")`
- Remove: `sprinkle send loose-ends '{"action":"remove-item","id":"le-foo"}'`
</details>

> ### ⚠️ Always confirm before tying up a loose end
> **The cone must NOT unilaterally remove or "mark done" a loose end** — even
> after it has finished the underlying work. A loose end is the user's thread;
> only the user decides it's truly closed. They may still have comments, edits,
> or follow-ups to add before it's tied up.
>
> - When the cone completes work on an item (e.g. after a **Do**), it should
>   **report what it did and ASK** something like *"Shall I tie up `<title>`, or
>   do you have more to add?"* — and only `remove-item` after the user says yes.
> - The **only** self-service closure is the user clicking **Done** on the card:
>   that click *is* the confirmation, so the cone just makes the store match (see
>   the `done` lick). Do not pre-empt it.
> - When in doubt, keep the item and offer to close it — never the reverse. It's
>   cheap to leave an item open; it's costly to silently drop one the user still
>   cared about.

**Replace the whole list** (e.g. after a bulk edit) — reseed:
`sprinkle send loose-ends '{"action":"load-items","tasks":[ ... ]}'` (or just
`loose-ends reseed`).

## Lick events (panel → cone)

The panel fires these licks back to the cone as `[Sprinkle Event: loose-ends]`:

| Action | Data | When | Cone handler |
|--------|------|------|--------------|
| `do`   | `{ id, title, summary, detail, url? }` | User clicks **Do** | Start working the task now, using `detail` as the agent brief (`summary` gives the human framing). If `url` is present (or a clear primary link is in the brief), open it with `open <url>` as the first step so the human sees the artifact immediately. The row stays in the list (a "Do" is not a completion). **When the work is finished, do NOT auto-remove it — report the result and ask the user whether to tie it up** (they may have more to add). See "Always confirm before tying up a loose end". |
| *(panel-local)* | View / Map button | User clicks **View** or **Map** | Handled inside the sprinkle via `slicc.exec('open …')` — **no lick, no cone turn**. |
| `done` | `{ id, title }` | User clicks **Done** | The panel already removed the row optimistically. Remove that `id` from `/shared/loose-ends.json` and bump `updated`. No panel round-trip needed. |
| `open-session` | `{ id, file, at }` | User clicks the **"from &lt;date&gt;"** provenance link | Open the originating transcript at `/sessions/<file>` (e.g. `read_file`) and surface it to the user — the conversation this loose end came from. |
| `snooze` | `{ id, title, until }` | User picks a snooze preset (Tomorrow / Next Monday / Next week / Pick a date) | The panel already moved the row to the snoozed section optimistically. Set that task's `snoozedUntil = until` (ISO) in `/shared/loose-ends.json` and bump `updated`. No panel round-trip needed. |
| `unsnooze` | `{ id, title }` | User clicks **Wake now** on a snoozed row | The panel already moved the row back to active optimistically. Clear (delete or `null`) that task's `snoozedUntil` in the store and bump `updated`. |
| `request-load` | `{ instanceId, reason, detail, mountedAt }` — e.g. `{"action":"request-load","instanceId":"a1b2c3d4","reason":"store-unreachable","detail":"exec-timeout","mountedAt":"2026-08-18T16:20:00.000Z"}` | Panel `init` when it could **not** hydrate from the store itself (neither `slicc.readFile` nor `slicc.exec` worked in the sandbox, or the store was unusable) | Reseed the panel from the store: `sprinkle send loose-ends '{"action":"load-items","tasks":[ ...store tasks... ]}'` (delegate to the scoop). This is the safety net behind self-hydration. The payload is **additive** — `action` is still the first key and owners keying only on it are unaffected. Use `instanceId` to triage repeats: **different** `instanceId` values mean repeated *mounts* (normal on multi-runtime setups, where a follower panel's VFS bridges are not backed by the leader's storage, so every mount legitimately asks for a push), while repeats with the **same** `instanceId` mean a real loop in one panel. `reason` is `store-unreachable` \| `store-corrupt` \| `no-bridge`; `detail` is the finer cause (`exec-timeout`, `exec-nonzero`, `exec-threw`, `readfile-timeout`, `readfile-empty`, `readfile-threw`, `no-bridge`, or `null`). |

> **`snooze`/`unsnooze` are optimistic in the panel** (like `done`): the row moves
> the instant the user acts, then the lick fires. The cone's only job is to make
> the store match (`snoozedUntil` set/cleared + bump `updated`). No `add-item`
> round-trip needed. A snooze whose time has passed auto-resurfaces in the panel,
> so a stale future `snoozedUntil` is harmless.

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

`load-items` / `add-item` task objects may carry `snoozedUntil` — the panel honors
it in rendering (no separate inbound action needed).

## Snooze

Each active row has a **Snooze** control (next to Do/Done) offering presets —
**Tomorrow**, **Next Monday**, **Next week**, and **Pick a date…** — each resolving
to 09:00 local on the target day. Picking one optimistically moves the row into a
collapsed **"Snoozed (N)"** section at the bottom (greyed, compact, with a **Wake
now** button) and fires a `snooze` lick; the cone persists `snoozedUntil` to the
store. **Wake now** fires `unsnooze` and returns the row to the active list.

- The top-bar count badge counts **active** rows only; snoozed rows are not counted.
- A snoozed task auto-resurfaces (moves back to active) once `snoozedUntil` passes —
  the panel re-checks on a timer, so no reopen is needed.
- Snoozed tasks are **excluded** from `loose-ends monday` (they aren't open *now*).
- The cone can also snooze a task directly (e.g. "mute this until Monday") by
  writing a future `snoozedUntil` into the store and re-sending it via `add-item`
  (upsert) or a full `load-items`.

## Resurrecting in a new session

Session/page reloads close all tabs and drop the running scoop, but the store
persists. To bring the panel back exactly as it was:

1. `scoop_scoop("loose-ends")` (recreate the owning scoop).
2. `feed_scoop("loose-ends", "Run: loose-ends bootstrap — then stay alive for lick events, do NOT finish.")`

`bootstrap` re-copies the template, reopens the panel, and reseeds every task
from `/shared/loose-ends.json`. The cone resumes handling `do`/`done` licks and
store writes.

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

## Notes

- **Reloading after template edits:** `sprinkle refresh` only re-scans the VFS —
  it does not reload an open panel. To pick up template changes, close then
  reopen from the scoop: `sprinkle close loose-ends && sprinkle refresh && sprinkle open loose-ends`,
  then `loose-ends reseed`.
- **No emojis in the UI** — the panel uses Lucide icons (`list-checks`, `check`,
  `arrow-right`), per the SLICC style guide.
- **Template:** `templates/loose-ends.shtml` (full-document mode). On open it
  **self-hydrates from the store** so closing + reopening never loses the list.
  Its `init` reads `STORE_PATH` (default `/shared/loose-ends.json`) — trying
  `slicc.readFile()` first, then `slicc.exec('cat …')` — and renders from that.
  If **neither** works in the sandbox, it fires a `request-load` lick and the
  cone reseeds (see the lick table). `slicc.setState`/`getState` is only a
  same-session cache and does **not** survive a full close+reopen — that was the
  original "empty after reopen" bug. **Test hydration with `sprinkle close` +
  `sprinkle open`, not `sprinkle reload`** (reload keeps the state cache and
  masks the problem). If your store lives elsewhere, change the `STORE_PATH`
  constant near the top of the script.
- **`request-load` diagnostics:** when that safety net fires, the lick says why.
  `reason` is `store-unreachable` (the store could not be read), `store-corrupt`
  (read, but the JSON was broken or had no `tasks` array) or `no-bridge`
  (neither `slicc.exec` nor `slicc.readFile` exists in this sandbox); `detail`
  narrows a failed read to `exec-timeout`, `exec-nonzero`, `exec-threw`,
  `readfile-timeout`, `readfile-empty` or `readfile-threw`. A per-mount
  `instanceId` plus `mountedAt` separate repeated mounts from a repeating panel,
  and the panel emits at most 3 asks per mount, 5s apart — a fresh mount always
  gets its one request, a loop gets capped.
