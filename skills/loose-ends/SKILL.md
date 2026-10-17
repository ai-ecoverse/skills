---
name: loose-ends
description: "Persistent to-do / follow-up list in a sprinkle panel. Use when the user wants to track loose ends, open follow-ups, waiting-on-others items, or things still to do across sessions. Each item has a title plus context; the panel offers Do (hand to the cone now), Snooze (hide until Tomorrow / Next Monday / Next week / a date), and Done. Triggers on 'loose ends', 'my to-do list', 'open follow-ups', 'things I still need to do', 'track this for later', 'add a loose end', 'snooze this until', 'mute until Monday', 'what's still open'."
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

Implemented by the bundled [`scripts/loose-ends.jsh`](scripts/loose-ends.jsh).
Flags below are the full reference. The store's fields are in [references/store.md](references/store.md).

```bash
loose-ends list                     # active + snoozed, human-readable
loose-ends list --snoozed --json    # filter/format
loose-ends create --title "Ping Marta re: Code Europe slot" \
  --summary "Waiting on her reply to the abstract" \
  --detail "Full brief: contacts, links, next steps…" \
  --skills gmail,outlook [--id le-custom] [--snooze monday] [--cone cone-adobe]
loose-ends done   <id>              # remove
loose-ends snooze <id> <tomorrow|monday|week|YYYY-MM-DD>   # hide until (09:00 local)
loose-ends unsnooze <id>            # wake now
```

`create` upserts when `--id` matches an existing task. Every mutating command
writes the store atomically (bumps `updated`) then best-effort `sprinkle send`s
the matching panel message; a failed/absent send prints a note and is non-fatal
(the panel self-hydrates on next open, or `loose-ends reseed` catches up).


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
`--template <path>` (default the skill-bundled [`templates/loose-ends.shtml`](templates/loose-ends.shtml),
copied into `/shared/sprinkles/loose-ends/` on bootstrap).

`bootstrap`/`reseed` drive `sprinkle` lifecycle — run them from the owning scoop.
The mutation commands (`create`/`done`/`snooze`/`unsnooze`) and `list`/`monday`
can run from either process (they write the store atomically and only *message*
the panel).

## Adding, updating, and removing tasks

**Prefer the CLI** ([flags above](#cli--the-mutation--reporting-api)): one atomic command writes the store *and* syncs the panel.

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

## Panel events (licks) — what the cone does

The panel's licks arrive as `[Sprinkle Event: loose-ends]` with `{ action, data, target? }`; read fields from `data`. Full payloads, the inbound `sprinkle send` messages, hydration and `request-load` diagnostics are in [references/panel-protocol.md](references/panel-protocol.md).

| Lick | The cone |
|------|----------|
| `do` | Work the task now from `data.detail` (open `data.url` first if set). Keep the row: when done, report and **ask** before tying it up. |
| `done` | Delete that `id` from the store (the panel already removed the row). |
| `snooze` / `unsnooze` | Set / clear `snoozedUntil` in the store (the panel already moved the row). |
| `open-session` | Open `/sessions/<data.file>` and show it to the user. |
| `request-load` | Reseed: `loose-ends reseed` (from the owning scoop). |
| `load-ack` | Nothing: it confirms a `load-items` push reached `data.instanceId`. |

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

## Monday and other references

- `loose-ends monday` is a monday source; its item format is in [references/store.md](references/store.md#monday-integration-source-protocol).
- Template reload, hydration and remount-storm notes: [references/panel-protocol.md](references/panel-protocol.md#notes).
