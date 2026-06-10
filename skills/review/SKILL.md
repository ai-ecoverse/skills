---
name: review
description: "Track review items (publish/comment/defer), annotate documents, and leave location pins directly on a live web page via a sprinkle dashboard. Use when the user has content to review, approve, annotate, or mark up — pages pending publish, PRs needing signoff, documents, or a rendered web page they want to pin comments on. Includes 'Pin Review' (click-to-comment markers on the active tab, persistent and mark-as-done) and 'Speck Fix' (toggle the Speck element-level AI editing layer on locally-served pages). Triggers on 'review queue', 'what's pending', 'annotate this', 'mark up this page', 'pin a comment on the page', 'review dashboard', 'publish queue'. Distinct from code review tools: manages a persistent UI queue with in-flight publish tracking, inline annotations, and on-page location pins."
allowed-tools: bash
---

# Review

## Quick-Start Workflow

1. **Create the scoop** — `scoop_scoop("review")`
2. **Copy and open the template:**
   ```
   feed_scoop("review", "Copy template: cp /workspace/skills/review/templates/review.shtml /shared/sprinkles/review/review.shtml\nRun: sprinkle refresh && sprinkle open review\nConfirm the sprinkle panel is visible before proceeding.")
   ```
3. **Verify the sprinkle opened** — wait for the scoop to confirm the panel is active before sending items.
4. **Instruct the scoop to stay alive** for lick events:
   ```
   feed_scoop("review", "Stay alive for lick events.")
   ```
5. **Load items** — send a `load-items` payload (see [Loading items](#loading-items)).
6. **Handle lick events** — forward each lick to the scoop and push a matching `update-status` response.

> **Template file:** The sprinkle HTML template lives at `/workspace/skills/review/templates/review.shtml`. Inspect that file directly for markup structure, CSS variables, and advanced configuration options.

> **Reloading after edits:** `sprinkle refresh` only re-scans the VFS — it does NOT reload an already-open panel. To pick up template changes, **close then reopen**: `sprinkle close review && sprinkle refresh && sprinkle open review`, then re-send `load-items`. When editing the template from a scoop, prefer `sed`/shell edits over `edit_file` (the latter has had sync issues on the shared sprinkle path) and verify with `grep` afterwards.

## Scoop Workflow

One scoop named `review` owns the sprinkle. Follow the Quick-Start Workflow above to initialise it.

### Loading items

```bash
sprinkle send review '{"action":"load-items","items":[
  {"id":"page-1","title":"Security Page","path":"/shared/security.md","previewUrl":"https://preview.example.com/security","liveUrl":"https://www.example.com/security","status":"pending"},
  {"id":"pr-42","title":"PR #42 — Fix nav","path":"","previewUrl":"https://github.com/org/repo/pull/42","liveUrl":"","status":"pending"}
]}'
```

### Opening a document for annotation

```bash
sprinkle send review '{"action":"open-file","path":"/shared/document.md","title":"Document Title"}'
```

### Updating a single item's status

```bash
sprinkle send review '{"action":"update-status","id":"page-1","status":"published"}'
```

## Lick Events

The sprinkle fires these licks back to the cone:

| Action | Data | When |
|--------|------|------|
| `publish` | `{ id, path, url }` | User clicks Publish |
| `comment` | `{ id, path, url, comment }` | User submits a comment |
| `defer` | `{ id, path, url }` | User clicks Defer |
| `submit-revisions` | `{ path, revisions: [{ text, note }] }` | User submits annotations |
| `toggle-review-mode` | `{ active:bool }` | User toggles the **Pin Review** button |
| `toggle-speck` | `{ active:bool }` | User toggles the **Speck Fix** button |
| `comment-done` | `{ num, done, itemId, cid }` | User clicks the ✓/✗ "done" button on a comment line (only fired for pin comments, which carry `num`) |
| `pins` | `{ url, pins:[...] }` | Reply to a `request-pins` message — the durable marker objects stored for `url` (used to seed the overlay on injection) |

The sprinkle accepts these inbound messages (`sprinkle send review`):

| Action | Payload | Effect |
|--------|---------|--------|
| `load-items` | `{ items:[...] }` | Replace the queue |
| `update-status` | `{ id, status }` | Set item status (pending/published/deferred) |
| `open-file` | `{ path, title }` | Open a document for annotation |
| `add-comment` | `{ id, comment, num? }` | Append a comment to an item's log. A numeric `num` marks it as a *pin* comment (links to a page marker) |
| `ensure-item` | `{ id, title, previewUrl?, liveUrl?, path? }` | Upsert a queue item by id — creates the card if missing, leaves others untouched (unlike `load-items` which replaces the whole queue). Used by the webhook handler to auto-create a per-page review entry on the first pin |
| `set-comment-done` | `{ id, num, done }` | Set a comment line's done-state directly by `num` (crosses it off / un-crosses). Used to restore done-state when re-populating comment lines from the durable store; complements `comment-done` (the lick fired when the user clicks the ✗ button) |
| `add-pin` | `{ id, comment, num, pin }` | Like `add-comment`, **plus** stores the full positional marker `pin` (`{num, comment, pageX, pageY, selector, url, ts}`) in the durable slicc-backed store keyed by `pin.url`. Use this (not `add-comment`) for pin clicks |
| `set-pin-done` | `{ url, num, done }` | Persist a pin's done-state in the durable store (echo this when handling a `comment-done` lick for a pin so the store stays in sync) |
| `request-pins` | `{ url }` | Ask the sprinkle to emit a `pins` lick with the durable markers stored for `url` (seed-back before injection) |
| `remove-pin` | `{ url, num }` | Delete a single pin from the durable store for `url` AND remove its comment line from the queue |
| `set-review-mode` | `{ active }` | Sync the Pin Review button state |
| `set-speck` | `{ active }` | Sync the Speck Fix button state |
| `clear-pins` | `{}` | Remove all pin comments (those with `num`, or text starting `📍 PIN #`) from every item, and empty the durable marker store |

### Handling licks (cone)

Forward lick events to the owning scoop using this pattern:

```
feed_scoop("review", "Lick event on YOUR sprinkle: { action: '<ACTION>', data: <DATA> }.
Execute the action, then push status update: sprinkle send review '{\"action\":\"update-status\",\"id\":\"<ID>\",\"status\":\"<STATUS>\"}'") 
```

A `publish` lick resolves to `"status":"published"`; `defer` resolves to `"status":"deferred"`; `comment` needs no status update.

## Pin Review (click-to-comment on a live page)

The sprinkle top bar has a **Pin Review** toggle that controls *adding* location pins to the active
tab. Markers are always visible once the display overlay is injected; the toggle only turns the
add-mode crosshair on/off. There is no in-page banner.

> **Architecture** — dual-store persistence, overlay versioning, element positioning, and the
> `__sliccReviewAll`/`sessionStorage` precedence rules live in **PIN-REVIEW-INTERNALS.md**. Read it
> when pins go missing, duplicate, or land in the wrong spot.

### Overlay assets (`overlay/`)
- `enter.js` — the full overlay. Resolve TWO placeholders before injecting: `__WEBHOOK_URL__`
  (comment webhook) and `__SPECK_WEBHOOK_URL__` (speck-fix webhook). `sed` both into a resolved copy
  `enter.resolved.js`.
- `exit.js` — turns OFF add mode (removes crosshair + open popups). Keeps markers visible.
- `remove-marker.js` — hide/restore one marker. Reads `window.__rvRemoveNum` + `window.__rvRemoveDone`
  set just before eval.
- `drain.js` / `reset.js` — poll committed comments / clear all marker state.

### Setup
1. Create a webhook routed to the `review` scoop: `webhook create --scoop review --name review-marker`.
2. `sed` its URL into `enter.resolved.js` for `__WEBHOOK_URL__`.
3. After any session resume, rebuild `enter.resolved.js` from `webhook list` — the URL regenerates
   across sessions. (Stale-URL symptom: pins POST opaquely but never arrive; `state.pins` stays empty.)

### Inject the overlay
Set `window.__sliccWantAdd` (true = add mode, false = display-only) in an inline eval **before**
eval-ing `enter.resolved.js`:
```bash
printf '(function(){window.__sliccWantAdd=false;})();' > /tmp/wantNoAdd.js
playwright-cli eval-file /tmp/wantNoAdd.js --tab <id>
playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
```
**Checkpoint** — the inject eval returns `{status:"active",...}` on first inject or
`{status:"reinjected",...}` on a refresh, with `markers`/`existing` equal to the expected pin count.
Confirm the version:
```bash
playwright-cli eval --tab <id> "window.__sliccOverlayVersion"   # must return 4
```

### Seed from durable state (fresh tab / after restart)
When a tab's `sessionStorage` may be empty (new tab, restarted browser, different machine), prime the
overlay from slicc state first: send `request-pins {url}`, await the `pins` lick, then write its array
into `window.__sliccReviewAll` in the same inline eval that sets `__sliccWantAdd`:
```bash
# PINS_JSON is the `pins` array from the request-pins → pins lick
printf '(function(){window.__sliccWantAdd=false;window.__sliccReviewAll=%s;})();' "$PINS_JSON" > /tmp/seed.js
playwright-cli eval-file /tmp/seed.js --tab <id>
playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
```
**Only seed with the real durable array — never an empty/stale one.** A non-empty `__sliccReviewAll`
wins over `sessionStorage` and clobbers visible pins (see PIN-REVIEW-INTERNALS.md). On a same-session
reload, skip seeding and let the cache serve.

**Checkpoint** — after seeding, the marker count must equal `PINS_JSON` length:
```bash
playwright-cli eval --tab <id> "(window.__sliccReviewAll||[]).length"
```
If it's 0 after a seed, you seeded an empty array — set `window.__sliccReviewAll=[]` and re-inject to
fall back to sessionStorage.

### `toggle-review-mode` lick handler (cone)
- `active:true` → set `__sliccWantAdd=true`, eval `enter.resolved.js` (markers + crosshair). First
  remove any Speck layer and sync `set-speck active:false` (mutually exclusive — see SPECK-FIX.md).
- `active:false` → eval `exit.js` (add mode off, crosshair off, markers stay).

Always keep the display overlay (`wantAdd=false`) injected on a pinned page so pins stay visible even
with Pin Review off — including after Speck reloads.

### Comment / pin flow
Each pin click opens a popup; on save it drops a numbered marker AND POSTs the full marker object to
the webhook. The `review` scoop pushes it into the sprinkle via **`add-pin`** with: a plain-text
display string `PIN #<num>: <comment>` (ASCII only — the sprinkle renders the icon itself), the
top-level numeric `num`, and the whole payload as `pin`. Use `add-comment` only for non-pin comments.
```bash
sprinkle send review '{"action":"add-pin","id":"page-1","num":3,
  "comment":"PIN #3: tighten the hero copy",
  "pin":{"num":3,"comment":"tighten the hero copy","pageX":420,"pageY":680,
         "selector":".hero h1","relX":0.5,"relY":0.5,"url":"https://preview.example.com/x","ts":1733400000000}}'
```

### Auto-created per-page entries
Dropping a pin on ANY page auto-creates that page's review entry. The webhook handler derives a stable
item id from the pin's `url`, sends `ensure-item` to create the card if missing, then `add-pin` to that
id. Never hardcode a single target id.

### Remote pages
Pin Review works on remote http(s) sites too — the overlay POSTs with `mode:'no-cors'`. Only
**Fix with Speck** is local-only (see SPECK-FIX.md).

### Mark done (✗ per comment line)
Toggling a pin comment's done button fires `comment-done {num,done,itemId,cid}`. Cone handler: set
`window.__rvRemoveNum=<num>; window.__rvRemoveDone=<bool>`, eval `remove-marker.js` (re-renders
markers, hiding done pins), then echo to durable storage so a re-seed reflects it:
```bash
sprinkle send review '{"action":"set-pin-done","url":"https://preview.example.com/security","num":3,"done":true}'
```

## Speck Fix (element-level AI editing)

Optional add-on: run Speck's element-level AI editing on locally-served preview pages. The sprinkle
has a **Speck Fix** toggle, and each marker tooltip shows a "✨ Fix with Speck" button (local previews
only). Pin Review and Speck Fix are mutually exclusive.

To enable: install the speck skill, create a `speck-worker` scoop, and wire two webhooks.
**Full setup steps and architecture → SPECK-FIX.md.**

## In-flight indicators and failure recovery

`publish` and `defer` show a pulsing in-flight indicator and disable action buttons until the cone sends a matching `update-status`. The template supports three statuses: `pending`, `published`, `deferred`.

- **Success** — send `update-status` with `"published"` or `"deferred"` to clear the indicator.
- **Failure** — send `update-status` with `"status":"pending"` to revert the card so the user can retry. Report the failure detail to the user via the cone (not via the sprinkle message field, which is not rendered):
  ```bash
  sprinkle send review '{"action":"update-status","id":"page-1","status":"pending"}'
  ```
- **Timeout** — if the scoop does not respond in time, push `"status":"pending"` to avoid a stuck UI.
