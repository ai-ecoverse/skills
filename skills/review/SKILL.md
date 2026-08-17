---
name: review
description: "Track review items (publish/comment/defer), annotate documents, and leave location pins directly on a live web page via a sprinkle dashboard. Use when the user has content to review, approve, annotate, or mark up — pages pending publish, PRs needing signoff, documents, or a rendered web page they want to pin comments on. Includes 'Pin Review' (click-to-comment markers on the active tab, persistent and mark-as-done) and 'Speck Fix' (toggle the Speck element-level AI editing layer on locally-served pages). Triggers on 'review queue', 'what's pending', 'annotate this', 'mark up this page', 'pin a comment on the page', 'review dashboard', 'publish queue'. Distinct from code review tools: manages a persistent UI queue with in-flight publish tracking, inline annotations, and on-page location pins."
allowed-tools: bash
---

# Review

## Scope — record only, never auto-apply

The review skill **records reviews**: it captures pins, comments, and
publish/defer status into a persistent queue, and surfaces them to the user.
It does **not** act on the feedback. A pin that says "this image is dull" or
"swap these two elements" is an *annotation to record*, not an instruction to
execute.

**Never silently edit the reviewed artifact (the page, document, or PR) in
response to a pin or comment.** Applying a change is always the user's
decision. The user acts on recorded feedback themselves — explicitly, or via
the **Speck Fix** layer (element-level AI editing on local previews; see
SPECK-FIX.md), which is user-driven by design.

When a pin or comment arrives, the only correct actions are: store it
(`add-pin` / `add-comment`), keep its marker/queue state in sync, and report
it to the user. If the user then wants the change made, they will say so or
reach for Speck — at which point editing happens through that explicit path,
not as an implicit consequence of the review.

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

### Creating or updating a single item (upsert)

`ensure-item` is a true upsert: it creates the card when the `id` is new and
updates it in place when the `id` already exists, without disturbing the rest of
the queue. Only the fields you send (`title`, `path`, `previewUrl`, `liveUrl`) are
written — anything you omit keeps its current value, and the item's `status` is
never modified, so a published or deferred card does not silently revert to
pending. Existing comments on the card are preserved.

A card whose Publish/Defer lick is still in flight (awaiting `update-status`)
stays disabled across the re-render, so an `ensure-item` cannot re-enable its
buttons and invite a duplicate lick.

```bash
# Repoint an existing card at a readable path, leaving title/status/comments alone
sprinkle send review '{"action":"ensure-item","id":"page-1","path":"/shared/review/security.md"}'
```

Use this instead of re-sending `load-items` when you only need to fix one card.

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
| `ensure-item` | `{ id, title?, previewUrl?, liveUrl?, path? }` | Upsert a queue item by id — creates the card if missing, updates it in place if it already exists, and leaves every other item untouched (unlike `load-items`, which replaces the whole queue). Only the fields present in the message are written; unsupplied fields keep their current values, and `status` is **never** modified by `ensure-item` (publish/defer state is owned by the panel and only changed via `update-status`). Comments already attached to the card survive the update. Used by the webhook handler to auto-create a per-page review entry on the first pin, and to repoint an existing card at a new `path`/`previewUrl` |
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
- `enter.js` — the full overlay. Has TWO placeholders, `sed` into a resolved copy `enter.resolved.js`:
  - `__WEBHOOK_URL__` (comment/pin webhook) — **required** at setup. Resolve from the live
    `review-marker` webhook URL.
  - `__SPECK_WEBHOOK_URL__` (speck-fix webhook) — **optional / lazy**. Resolve it to an empty string
    at first setup if Speck isn't wired yet; the Speck Fix lazy-load bootstrap (§ Lazy auto-load on
    first use) fills it in and re-injects the overlay the first time the user clicks **✨ Fix with
    Speck**. An empty value just means the Speck button is inert until that first click — Pin Review
    works fully without it.
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

### Keep pins visible across reloads (mandatory while review is active)

Pins live in the durable store, but the on-page **markers are erased whenever the
tab reloads or navigates** — a reload clears the injected overlay (`window.__sliccOverlayVersion`
goes back to `none`). While the review skill is active on a page, the cone is responsible for
**re-painting the markers after every reload/navigation** so the user always sees their pins.

The rule: **always keep the display overlay (`wantAdd=false`) injected on a pinned page** so pins
stay visible even with Pin Review off — including after Speck reloads, manual reloads, and
re-opening the page in a new tab.

Re-paint procedure (run whenever the page may have reloaded, or whenever the user reports pins
missing):

1. Check the tab's overlay state: `playwright-cli eval --tab <id> "window.__sliccOverlayVersion || 'none'"`.
   `none` (or a version below the expected `4`) means the overlay was cleared and must be re-injected.
2. Ask the sprinkle for the authoritative pins: `sprinkle send review '{"action":"request-pins","url":"<url>"}'`,
   then await the `pins` lick.
3. Seed the real array and inject the **display** overlay in the same step:
   ```bash
   printf '(function(){window.__sliccWantAdd=false;window.__sliccReviewAll=%s;})();' "$PINS_JSON" > /tmp/seed.js
   playwright-cli eval-file /tmp/seed.js --tab <id>
   playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
   ```
   (Use `__sliccWantAdd=true` instead only if add-mode should also be on — e.g. Pin Review toggled on.)
4. Verify: `(window.__sliccReviewAll||[]).length` equals the pin count and `window.__sliccOverlayVersion` is `4`.

Never seed an empty/stale array over a non-empty store (it clobbers visible pins — see
PIN-REVIEW-INTERNALS.md). On a *same-session* reload where `sessionStorage` still holds the markers,
re-injecting the overlay alone is enough and seeding can be skipped; when in doubt, seed from the
durable `request-pins` array.

### Comment / pin flow
Each pin click opens a popup; on save it drops a numbered marker AND POSTs the full marker object to
the webhook. The `review` scoop pushes it into the sprinkle via **`add-pin`** with: a plain-text
display string `PIN #<num>: <comment>` (ASCII only — the sprinkle renders the icon itself), the
top-level numeric `num`, and the whole payload as `pin`. Use `add-comment` only for non-pin comments.

> **Record only.** Storing the pin is the *complete* handling of a pin click. Do **not** go on to edit
> the page/artifact to satisfy the pin's request (see § Scope). The change is the user's call, made
> explicitly or through Speck Fix.
```bash
sprinkle send review '{"action":"add-pin","id":"page-1","num":3,
  "comment":"PIN #3: tighten the hero copy",
  "pin":{"num":3,"comment":"tighten the hero copy","pageX":420,"pageY":680,
         "selector":".hero h1","relX":0.5,"relY":0.5,"url":"https://preview.example.com/x","ts":1733400000000}}'
```

### Auto-created per-page entries
Dropping a pin on ANY page auto-creates that page's review entry. The webhook handler derives a stable
item id from the pin's `url`, sends `ensure-item` to create or refresh the card, then `add-pin` to that
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

### Lazy auto-load on first use (cone handler for `toggle-speck` / "Fix with Speck")

Speck is **loaded on demand**, not as a manual prerequisite. The user should be able to click
**✨ Fix with Speck** (or the **Speck Fix** toggle) and have it just work — the click is what triggers
the skill to load. When the cone receives a `toggle-speck {active:true}` lick (or an `inject-speck`
event) and Speck is **not yet set up**, the handler must bootstrap it automatically before proceeding,
then carry out the original request. Do not silently no-op on an unresolved `__SPECK_WEBHOOK_URL__`.

Bootstrap procedure (idempotent — skip any step already done):

1. **Install the skill if missing:** check for `speck` on disk; if absent, run
   `upskill ai-ecoverse/skills --skill speck`.
2. **Ensure the `speck-worker` scoop exists** (with `/tmp/` write access and the standing duties to
   handle the two webhooks — see SPECK-FIX.md). Create it if missing.
3. **Ensure the two webhooks exist and are routed to `speck-worker`:** `speck-fix` (handles
   `inject-speck`) and `speck-lick` (element-instruction events). Create any that are missing.
4. **Resolve `__SPECK_WEBHOOK_URL__`:** re-build `enter.resolved.js` from the *current* `speck-fix`
   webhook URL (webhook URLs regenerate across sessions — always read the live URL from
   `webhook list`, never reuse a cached one), then re-inject the overlay so the tooltip button POSTs
   to a live endpoint.
5. **Proceed with the original request** — inject Speck on the active tab and sync the sprinkle
   (`set-speck active:true`, `set-review-mode active:false`).

Tell the user briefly that Speck is loading on first use; subsequent clicks are instant because the
bootstrap is idempotent.

**Full setup steps and architecture → SPECK-FIX.md.**

## In-flight indicators and failure recovery

`publish` and `defer` show a pulsing in-flight indicator and disable action buttons until the cone sends a matching `update-status`. The template supports three statuses: `pending`, `published`, `deferred`.

- **Success** — send `update-status` with `"published"` or `"deferred"` to clear the indicator.
- **Failure** — send `update-status` with `"status":"pending"` to revert the card so the user can retry. Report the failure detail to the user via the cone (not via the sprinkle message field, which is not rendered):
  ```bash
  sprinkle send review '{"action":"update-status","id":"page-1","status":"pending"}'
  ```
- **Timeout** — if the scoop does not respond in time, push `"status":"pending"` to avoid a stuck UI.
