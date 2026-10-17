# loose-ends panel protocol

What the sprinkle panel and the cone send each other, and how the panel hydrates. The CLI does all of this for you; read this when handling licks, reseeding by hand, or triaging a panel that will not hydrate.

## Lick events (panel → cone)

The panel fires these licks back to the cone as `[Sprinkle Event: loose-ends]`.
Every lick has the transport shape `{ action, data, target? }`: the SLICC
runtime forwards only those three keys from a sprinkle lick and silently drops
any other top-level key. The **Data** column below is the `data` object, so an
owner reads its fields from `data` (e.g. `data.instanceId`), never from the top
level of the event.

| Action | Data | When | Cone handler |
|--------|------|------|--------------|
| `do`   | `{ id, title, summary, detail, skills, url }` (`url` is `''` when the task has none) | User clicks **Do**. When the task has `cone`, the lick also carries `target` set to that filing cone. | Start working the task now, using `detail` as the agent brief (`summary` gives the human framing). If `url` is present (or a clear primary link is in the brief), open it with `open <url>` as the first step so the human sees the artifact immediately. The row stays in the list (a "Do" is not a completion). **When the work is finished, do NOT auto-remove it — report the result and ask the user whether to tie it up** (they may have more to add). See "Always confirm before tying up a loose end". |
| *(panel-local)* | View / Map button | User clicks **View** or **Map** | Handled inside the sprinkle via `slicc.exec('open …')` — **no lick, no cone turn**. |
| `done` | `{ id, title }` | User clicks **Done** | The panel already removed the row optimistically. Remove that `id` from `/shared/loose-ends.json` and bump `updated`. No panel round-trip needed. |
| `open-session` | `{ id, file, at }` | User clicks the **"from &lt;date&gt;"** provenance link. When the task has `cone`, the lick also carries `target` set to that filing cone. | Open the originating transcript at `/sessions/<file>` (e.g. `read_file`) and surface it to the user — the conversation this loose end came from. |
| `snooze` | `{ id, title, until }` | User picks a snooze preset (Tomorrow / Next Monday / Next week / Pick a date) | The panel already moved the row to the snoozed section optimistically. Set that task's `snoozedUntil = until` (ISO) in `/shared/loose-ends.json` and bump `updated`. No panel round-trip needed. |
| `unsnooze` | `{ id, title }` | User clicks **Wake now** on a snoozed row | The panel already moved the row back to active optimistically. Clear (delete or `null`) that task's `snoozedUntil` in the store and bump `updated`. |
| `request-load` | `{ instanceId, reason, detail, mountedAt }` — e.g. `{"action":"request-load","data":{"instanceId":"a1b2c3d4","reason":"store-unreachable","detail":"exec-timeout","mountedAt":"2026-08-18T16:20:00.000Z"}}` | Panel `init` when it could **not** hydrate from the store itself (neither `slicc.readFile` nor `slicc.exec` worked in the sandbox, or the store was unusable) | Reseed the panel from the store: `sprinkle send loose-ends '{"action":"load-items","tasks":[ ...store tasks... ]}'` (delegate to the scoop). This is the safety net behind self-hydration. The diagnostics ride inside `data`, so owners keying only on `action` are unaffected. Use `data.instanceId` to triage repeats: **different** `instanceId` values mean repeated *mounts* (normal on multi-runtime setups, where a follower panel's VFS bridges are not backed by the leader's storage, so every mount legitimately asks for a push), while repeats with the **same** `instanceId` mean a real loop in one panel. `reason` is `store-unreachable` \| `store-corrupt` \| `no-bridge`; `detail` is the finer cause (`exec-timeout`, `exec-nonzero`, `exec-threw`, `readfile-timeout`, `readfile-empty`, `readfile-threw`, `no-bridge`, or `null`). The panel rate-limits itself (one ask per 5s, doubling to at most one per minute while unanswered, reset by the next `load-items`) — it is a floor, not a cap, so an instance that never gets data keeps asking slowly rather than going silent. |
| `load-ack` | `{ instanceId, count, at }` — e.g. `{"action":"load-ack","data":{"instanceId":"a1b2c3d4","count":7,"at":"2026-08-18T16:20:01.000Z"}}` | The panel finished applying a `load-items` push (after `tasks` is replaced and rendered) | Confirmation of delivery, not a request — nothing to do. Match `data.instanceId` against the `data.instanceId` of the `request-load` you were answering to prove the push reached **that** instance and not another one: `sprinkle send` addresses a panel by name and cannot target a runtime, and a panel on a follower cannot read the leader's store. `data.count` is the number of tasks the panel now holds. No ack within a few seconds of a push means it did not land. Owners keying only on `action` are unaffected. |

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
| `load-items` | `{ tasks:[...] }` | Replace the entire list (full reseed). The panel answers with a `load-ack` lick — see the lick table. |
| `add-item` | `{ task:{id,title,context,created} }` | Upsert one task by `id` (replace if present, else append). |
| `remove-item` | `{ id }` | Remove one task by `id`. |

`load-items` / `add-item` task objects may carry `snoozedUntil` — the panel honors
it in rendering (no separate inbound action needed).

## Notes

- **Reloading after template edits:** `sprinkle refresh` only re-scans the VFS —
  it does not reload an open panel. To pick up template changes, close then
  reopen from the scoop: `sprinkle close loose-ends && sprinkle refresh && sprinkle open loose-ends`,
  then `loose-ends reseed`.
- **No emojis in the UI** — the panel uses Lucide icons (`list-checks`, `check`,
  `arrow-right`), per the SLICC style guide.
- **Template:** the skill ships [`templates/loose-ends.shtml`](../templates/loose-ends.shtml)
  (full-document mode); bootstrap installs it under `/shared/sprinkles/loose-ends/`.
  On open it **self-hydrates from the store** so closing + reopening never loses
  the list. Its `init` reads `STORE_PATH` (default `/shared/loose-ends.json`) —
  trying `slicc.readFile()` first, then `slicc.exec('cat …')` — and renders from
  that. If **neither** works in the sandbox, it fires a `request-load` lick and
  the cone reseeds (see the lick table). `slicc.setState`/`getState` is only a
  same-session cache and does **not** survive a full close+reopen — that was the
  original "empty after reopen" bug. **Test hydration with `sprinkle close` +
  `sprinkle open`, not `sprinkle reload`** (reload keeps the state cache and
  masks the problem). If your store lives elsewhere, change the `STORE_PATH`
  constant near the top of the template.
- **`request-load` diagnostics:** `reason` / `detail` / `instanceId` / rate limits /
  `load-ack` ride inside the lick's `data` — see the lick table when triageing a
  mount that cannot self-hydrate.
  **The panel-side floor cannot stop a remount storm.** It lives inside one
  document, so it only protects against an instance that asks repeatedly. If the
  host recreates the panel document on a timer — observed at roughly 30-second
  intervals on a `slicc-standalone` follower, where each fresh `init` fails its
  store read and asks once — every ask comes from a document with a brand-new
  `instanceId`, and no client-side gap applies. Owners must therefore dedupe on
  their own side: group by `data.instanceId`, and read many distinct
  `instanceId` values with `mountedAt` values marching forward as a remount loop
  in the host, not a panel defect. Nothing in the template can suppress that.
