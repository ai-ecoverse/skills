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

The sprinkle top bar has a **Pin Review** toggle button. It controls *adding* location pins to
the currently active tab. There is **no in-page banner** — Pin Review state is shown only by the
sprinkle button.

### Overlay assets (`overlay/`)
- `enter.js` — the full overlay (display layer + add mode). Has TWO placeholders to resolve:
  `__WEBHOOK_URL__` (comment webhook) and `__SPECK_WEBHOOK_URL__` (speck-fix webhook). `sed` both
  into a resolved copy (`enter.resolved.js`) before injecting.
- `exit.js` — turns OFF add mode (removes crosshair + open popups). **Keeps markers visible.**
- `remove-marker.js` — hide/restore a single marker (used by the `comment-done` handler). Reads
  `window.__rvRemoveNum` + `window.__rvRemoveDone` set just before eval.
- `drain.js` / `reset.js` — poll committed comments / clear all marker state.

### Two concerns (IMPORTANT design)
1. **Display layer** — markers + hover tooltips + the "Fix with Speck" button. Once injected it is
   **always visible**, regardless of Pin Review mode. Done pins are skipped. The overlay exposes
   `window.__sliccRenderMarkers()` to re-render from state.

### Pin persistence (dual-store)
Pins live in two places, and the second is what makes them durable:
- **`sessionStorage` (key `__sliccReviewMarkers`)** — fast, page-local cache. Survives reloads but is
  scoped to that tab's session; lost on tab close / browser restart.
- **Durable slicc state (`state.pins`, keyed by page url)** — the sprinkle persists every pin's full
  marker object (`{num, comment, pageX, pageY, selector, url, ts, done}`) through `slicc.setState()`.
  Survives panel reloads and browser restarts, and can be re-seeded onto any tab pointed at the same
  url. This is populated by `add-pin` and read back via `request-pins` → `pins` lick.

The overlay restores markers from a pre-populated `window.__sliccReviewAll` if present, otherwise from
`sessionStorage`. So the seed-back path (below) lets durable slicc state win on a fresh tab/session.
2. **Add mode** (`window.__sliccAddMode`) — the crosshair + click-to-place-new-pin behavior. This
   is the ONLY thing the Pin Review button toggles.

### Element-anchored positioning
Each pin stores its target element's `selector` plus the click's fractional offset within that
element (`relX`/`relY`), with absolute `pageX`/`pageY` as a fallback. Markers are positioned
relative to the live element's bounding rect, so they stay attached to the right spot on resize /
reflow (not pinned to absolute page coords). The overlay binds `window.__sliccDoReposition` and
listens for `resize`/`scroll` (rAF-throttled) to reposition all markers. The overlay is versioned
(`__sliccOverlayVersion`, currently 4) — a higher version forces a full re-init on injection; a
click-gen token (`__sliccClickGen`) makes superseded listeners inert so upgrades never double-handle.

### Injection contract
Set `window.__sliccWantAdd` (true = add mode, false = display-only) via a tiny inline eval
**before** eval-ing `enter.resolved.js`. Re-running `enter.resolved.js` when the display layer
already exists just refreshes markers + add-mode (it does **not** duplicate listeners). Example:
```bash
printf '(function(){window.__sliccWantAdd=false;})();' > /tmp/wantNoAdd.js
playwright-cli eval-file /tmp/wantNoAdd.js --tab <id>
playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
```

**Seeding from durable state (fresh tab / after restart).** When injecting into a tab whose
`sessionStorage` may be empty (new tab, restarted browser, different machine), prime the overlay from
slicc state first: send `request-pins {url}`, await the `pins` lick, then write its array into
`window.__sliccReviewAll` in the same inline eval that sets `__sliccWantAdd`, e.g.
```bash
# PINS_JSON is the `pins` array from the request-pins → pins lick
printf '(function(){window.__sliccWantAdd=false;window.__sliccReviewAll=%s;})();' "$PINS_JSON" > /tmp/seed.js
playwright-cli eval-file /tmp/seed.js --tab <id>
playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
```
Precedence (not merge): a pre-populated `__sliccReviewAll` **wins outright**; the overlay only falls
back to the `sessionStorage` cache when `__sliccReviewAll` is empty (enter.js:31–33). So seeding makes
durable slicc state authoritative — only do it when you want that (fresh tab / restart, or to repair a
stale cache). When `sessionStorage` already holds the pins (same-session reload), skip the round-trip
and let the cache serve. Since `state.pins` is appended on every `add-pin`, slicc is a superset of the
cache, so seeding won't drop pins.

### Cone lick handler for `toggle-review-mode`
- `active:true` → set `__sliccWantAdd=true`, eval `enter.resolved.js` (markers shown + crosshair).
  First remove any Speck layer and sync `set-speck active:false` (Pin Review and Speck Fix are
  mutually exclusive — both capture clicks).
- `active:false` → eval `exit.js` (add mode off, crosshair off, **markers stay**).

Always keep the display overlay (wantAdd=false) injected on a pinned page so pins stay visible
even with Pin Review off — including after Speck reloads (the `speck-worker` re-injects it).

### Comment flow + setup
- Create a webhook routed to the `review` scoop: `webhook create --scoop review --name review-marker`,
  then `sed` its URL into `enter.resolved.js` for `__WEBHOOK_URL__`.
- Each pin click opens a popup; on save it drops a numbered marker AND POSTs the **full marker
  object** to the webhook — `{num, comment, pageX, pageY, selector, relX, relY, url, ts}`. The
  `review` scoop pushes it into the sprinkle via **`add-pin`**, passing a **plain-text** display
  string `PIN #<num>: <comment>` (NO emoji — see note below), the top-level numeric `num` (so the
  comment line links back to the page marker), and the whole payload as `pin` (durable position).
  Use `add-comment` only for non-pin item comments. Example:
  ```bash
  sprinkle send review '{"action":"add-pin","id":"page-1","num":3,
    "comment":"PIN #3: tighten the hero copy",
    "pin":{"num":3,"comment":"tighten the hero copy","pageX":420,"pageY":680,
           "selector":".hero h1","relX":0.5,"relY":0.5,"url":"https://preview.example.com/x","ts":1733400000000}}'
  ```
- **Pin icon — do NOT send the 📍 emoji through the webhook.** Passing the emoji through the
  scoop's jq/shell pipeline double-encodes it (mojibake — renders like an Icelandic `ð`). Instead
  the **sprinkle renders the pin icon itself**: `renderCommentEntry` detects a pin (numeric `num`),
  draws a clean Lucide `map-pin` icon, and strips any leading emoji/mojibake/`PIN #n:` prefix from
  the display text. So always send plain ASCII comment text.

### Mark done (✗ button per comment line)
Each comment line in the queue has a done toggle. Toggling fires `comment-done {num,done,itemId,cid}`
for pin comments. Cone handler: set `window.__rvRemoveNum=<num>; window.__rvRemoveDone=<bool>` then
eval `remove-marker.js` on the page — it re-renders markers from state (`__sliccRenderMarkers`), so
done pins are hidden and un-done pins restored. Done state persists in `sessionStorage`, so the
overlay's `renderMarker` skips done pins on every (re)injection.

Also echo the done-state into durable storage so a re-seed from slicc state reflects it — send
`set-pin-done {url, num, done}` to the sprinkle in the same handler:
```bash
sprinkle send review '{"action":"set-pin-done","url":"https://preview.example.com/security","num":3,"done":true}'
```

## Speck Fix (element-level AI editing)

The sprinkle top bar has a **Speck Fix** toggle button (next to Pin Review), and each marker's
hover tooltip shows a "✨ Fix with Speck" button (visible **only on locally-served pages** —
`chrome-extension://<id>/preview/...`; hidden on remote http(s) pages, which Speck can't inject
into due to CSP).

Both entry points POST `{action:'inject-speck', url}` to the `speck-fix` webhook routed to a
`speck-worker` scoop. The worker finds the matching tab, maps the preview URL → VFS file path, runs
`speck inject <tab> --file <path>` (just turns on Speck's annotation layer — no fetch/copy/redesign),
**re-injects the review display overlay** so pins stay visible, then **syncs the sprinkle**
(`set-speck active:true`, `set-review-mode active:false`). Element instructions flow through the
`speck-lick` webhook to the worker, which applies edits, reloads, re-injects Speck, and re-injects
the pin display overlay each time.

- Toggle `toggle-speck active:false` (or remove via the cone): run `speck remove <tab>`. Markers stay.
- Pin Review and Speck Fix are **mutually exclusive** — enabling one disables the other; keep both
  sprinkle buttons synced via `set-review-mode` / `set-speck`.

### Setup

> **Prerequisites for Speck Fix.** Pin Review works without any of this; Speck Fix needs all three:
> 1. **The speck skill installed** — `upskill ai-ecoverse/skills --skill speck` (same repo this skill ships from).
> 2. **A `speck-worker` scoop** with `/tmp/` write access, given standing duties (see the worker's `DUTIES.md` pattern) to handle the two webhooks below.
> 3. **Two webhooks routed to that scoop** — `speck-fix` (inject-speck) and `speck-lick` (element-instruction).

Install the speck skill (`upskill ai-ecoverse/skills --skill speck`) and create the `speck-worker`
scoop with `/tmp/` write access. Give it standing duties (see the worker's `DUTIES.md` pattern):
handle `speck-fix` (inject-speck) and `speck-lick` (element-instruction) webhook events.

### In-flight indicators and failure recovery

`publish` and `defer` show a pulsing in-flight indicator and disable action buttons until the cone sends a matching `update-status`. The template supports three statuses: `pending`, `published`, `deferred`.

- **Success** — send `update-status` with `"published"` or `"deferred"` to clear the indicator.
- **Failure** — send `update-status` with `"status":"pending"` to revert the card so the user can retry. Report the failure detail to the user via the cone (not via the sprinkle message field, which is not rendered):
  ```bash
  sprinkle send review '{"action":"update-status","id":"page-1","status":"pending"}'
  ```
- **Timeout** — if the scoop does not respond in time, push `"status":"pending"` to avoid a stuck UI.
