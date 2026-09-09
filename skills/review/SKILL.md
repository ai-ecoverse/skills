---
name: review
description: >
  Track review items (approve/publish/comment/defer), annotate documents, and leave
  location pins directly on a live web page via a sprinkle dashboard. Use when
  the user has content to review, approve, annotate, or mark up — pages pending
  publish, PRs needing signoff, documents, or a rendered web page they want to
  pin comments on. Supports HTML, Markdown, and Fountain in one iframe with element/text comments
  and explicit dispatch to the agent. Includes Pin Review (click-to-comment markers on the active
  tab, persistent and mark-as-done), Speck Fix (element-level AI editing on
  locally-served pages), and AEM Source (populate the backlog from an AEM
  preview/live tree diff via `review sweep`). Triggers on 'review queue',
  'what's pending', 'annotate this', 'mark up this page', 'pin a comment on
  the page', 'review dashboard', 'publish queue', 'AEM unpublished pages'.
  Distinct from code review tools: manages a persistent UI queue with in-flight
  publish tracking, inline annotations, and on-page location pins.
allowed-tools: bash
---

# Review

## Scope — save first, act only on an explicit request

Saving a comment records feedback; it does not authorize editing the asset.
**Send to agent** is the explicit request to apply the collected revisions.
Handle that `submit-revisions` batch as described below. A standalone pin or
`comment` event remains record-only. The external Speck Fix tool is also an
explicit editing path; it is separate from the preview's draft comments.

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

## Preview and annotate

Each queue card has one **Preview** button. It opens an iframe for local HTML,
Markdown, or Fountain. If a local file cannot be read and the card supplies a
preview/live URL, Review fetches that page through SLICC and displays a static
snapshot in the same iframe. Remote pages have an **Open source** link. Asset
scripts, forms, and navigation are inactive while reviewing.

1. Click **Preview**. HTML retains its styling; Markdown uses readable document
   typography. Fountain uses the Save the Cat renderer (install `save-the-cat`
   if Review reports that renderer is unavailable).
2. With **Annotate** on, click an element or select text. Keyboard reviewers can
   Tab to a block and press Enter. Type feedback and choose **Save comment**;
   Escape cancels. Toggle Annotate off to read without opening the composer.
3. Comments stay with the asset when switching cards, reloading, or reopening
   the panel. Clicking a comment's quote returns to the corresponding passage.
   If that passage changed, Review preserves the quote and reports the mismatch.
4. Choose **Send to agent** to dispatch draft comments. Previously sent comments
   are not sent again. The panel shows that the batch is awaiting the agent.

Read [INLINE-REVIEW.md](references/INLINE-REVIEW.md) when implementing a renderer,
handling review batches, or troubleshooting anchors and delivery.

## Scoop Workflow

One scoop named `review` owns the sprinkle. Follow the Quick-Start Workflow above to initialise it.

### Loading items

```bash
sprinkle send review '{"action":"load-items","items":[
  {"id":"page-1","title":"Security Page","path":"/shared/security.md","previewUrl":"https://preview.example.com/security","liveUrl":"https://www.example.com/security","status":"pending"},
  {"id":"pr-42","title":"PR #42 — Fix nav","path":"","previewUrl":"https://github.com/org/repo/pull/42","liveUrl":"","status":"pending"}
]}'
```

The primary button defaults to **Approve**. For a publication queue, set
`primaryActionLabel:"Publish"` on each item. AEM sources supply this automatically.
The same field works in `load-items`, `ensure-item`, and source contributions:

```bash
sprinkle send review '{"action":"ensure-item","id":"page-1","primaryActionLabel":"Publish"}'
review ingest --path /shared/draft.md --primary-action-label 'Approve'
```

`review ingest` and `review sweep` accept `--primary-action-label LABEL`; it
overrides the source label. Omitting the field in an upsert preserves the
existing label; sending `""` resets it to Approve. Labels are plain text.
This is presentation metadata: the existing `publish` lick and
`pending`/`published`/`deferred` status protocol remain unchanged. The owning
skill handles that primary action according to its workflow; a label alone
does not add publication behavior. See [the source protocol](references/SOURCE_PROTOCOL.md)
when implementing a producer.

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
the queue. Only the fields you send (`title`, `path`, `previewUrl`, `liveUrl`, `primaryActionLabel`) are
written — anything you omit keeps its current value, and the item's `status` is
never modified, so a published or deferred card does not silently revert to
pending. Existing comments on the card are preserved.

A card whose primary action/Defer lick is still in flight (awaiting `update-status`)
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
| `publish` | `{ id, path, url }` | User clicks the primary action (Approve by default, Publish for AEM) |
| `comment` | `{ id, path, url, comment }` | User submits a comment |
| `defer` | `{ id, path, url }` | User clicks Defer |
| `submit-revisions` | `{ id, path, url, format, batchId, revisions: [{ id, text, note, anchor }] }` | User explicitly sends saved comments to the agent |
| `toggle-review-mode` | `{ active:bool }` | User toggles the **Pin Review** button |
| `toggle-speck` | `{ active:bool }` | User toggles the **Speck Fix** button |
| `comment-done` | `{ num, done, itemId, cid }` | User clicks the ✓/✗ "done" button on a comment line (only fired for pin comments, which carry `num`) |
| `pins` | `{ url, pins:[...] }` | Reply to a `request-pins` message — the durable marker objects stored for `url` (used to seed the overlay on injection) |

The sprinkle accepts these inbound messages (`sprinkle send review`):

| Action | Payload | Effect |
|--------|---------|--------|
| `load-items` | `{ items:[...] }` | Replace the queue |
| `update-status` | `{ id, status }` | Set item status (pending/published/deferred) |
| `open-file` | `{ path, title, id? }` | Open the same iframe preview used by queue cards |
| `revisions-result` | `{ batchId, status: "applied" or "failed", message? }` | Acknowledge a batch; applied comments are retained, failed comments become retryable drafts |
| `add-comment` | `{ id, comment, num? }` | Append a comment to an item's log. A numeric `num` marks it as a *pin* comment (links to a page marker) |
| `ensure-item` | `{ id, title?, previewUrl?, liveUrl?, path?, primaryActionLabel? }` | Upsert only supplied fields; preserve status, comments, and other cards (see the upsert example above) |
| `set-comment-done` | `{ id, num, done }` | Set a comment line's done-state directly by `num` (crosses it off / un-crosses). Used to restore done-state when re-populating comment lines from the durable store; complements `comment-done` (the lick fired when the user clicks the ✗ button) |
| `add-pin` | `{ id, comment, num, pin }` | Append the comment and persist the positional marker by `pin.url`; use for page pins |
| `set-pin-done` | `{ url, num, done }` | Persist a pin's done-state in the durable store (echo this when handling a `comment-done` lick for a pin so the store stays in sync) |
| `request-pins` | `{ url }` | Ask the sprinkle to emit a `pins` lick with the durable markers stored for `url` (seed-back before injection) |
| `remove-pin` | `{ url, num }` | Delete a single pin from the durable store for `url` AND remove its comment line from the queue |
| `set-review-mode` | `{ active }` | Sync the Pin Review button state |
| `set-speck` | `{ active }` | Sync the Speck Fix button state |
| `clear-pins` | `{}` | Remove all pin comments (those with `num`, or text starting `📍 PIN #`) from every item, and empty the durable marker store |
| `add-findings` | `{ id, source, summary?, severity?, findings? }` | Attach one integration's result to a card (creates the card if missing). Re-running the same `source` replaces that block; other sources stay. See [Integrations](#integrations). |
| `clear-findings` | `{ id, source? }` | Drop one source's findings on a card, or every source if `source` is omitted. |

### Handling revision batches (cone)

For `submit-revisions`, deduplicate by `batchId`, verify each quote/anchor against
the current source, then carry out the requested changes. Edit `path`, never a
rendered HTML snapshot. For a URL-only asset, identify the editable source first;
if it is unavailable, return `failed` with an actionable explanation.

After applying the batch, send `revisions-result` with `status:"applied"`, then
reopen/reload the preview to verify the result. On failure, send `status:"failed"`
with a short `message`; the panel preserves the notes and enables retry. Do not
acknowledge success before checking the actual edited source. See
[the protocol and example](references/INLINE-REVIEW.md).

### Handling other licks (cone)

Forward lick events to the owning scoop using this pattern:

```
feed_scoop("review", "Lick event on YOUR sprinkle: { action: '<ACTION>', data: <DATA> }.
Execute the action, then push status update: sprinkle send review '{\"action\":\"update-status\",\"id\":\"<ID>\",\"status\":\"<STATUS>\"}'") 
```

A `publish` lick resolves to `"status":"published"`; `defer` resolves to `"status":"deferred"`; `comment` needs no status update.

## External browser pages

For an already-open live tab, expand **Tools for an external browser tab**.
Pin Review records location markers; Speck Fix applies explicitly requested
local-page edits. These tools do not control the queue's preview iframe.
Read [EXTERNAL-PAGES.md](references/EXTERNAL-PAGES.md) for setup, overlay
injection, persistence, and Speck bootstrap. The iframe workflow requires no
webhook, separate tab, or Speck worker. For missing or displaced external pins,
read [PIN-REVIEW-INTERNALS.md](references/PIN-REVIEW-INTERNALS.md); for external
page editing setup, read [SPECK-FIX.md](references/SPECK-FIX.md).

## In-flight indicators and failure recovery

`publish` and `defer` show a pulsing in-flight indicator and disable action buttons until the cone sends a matching `update-status`. The template supports three statuses: `pending`, `published`, `deferred`.

- **Success** — send `update-status` with `"published"` or `"deferred"` to clear the indicator.
- **Failure** — send `update-status` with `"status":"pending"` to revert the card so the user can retry. Report the failure detail to the user via the cone (not via the sprinkle message field, which is not rendered):
  ```bash
  sprinkle send review '{"action":"update-status","id":"page-1","status":"pending"}'
  ```
- **Timeout** — if the scoop does not respond in time, push `"status":"pending"` to avoid a stuck UI.

## Integrations

Other skills attach checks to the review backlog the same way monday sources attach inbox items: a `review` sub-command that writes one JSON object to stdout. The contract lives in [`references/SOURCE_PROTOCOL.md`](references/SOURCE_PROTOCOL.md).

```bash
review sources
review ingest --path /shared/page.md --id page-1
review ingest pangram --path /shared/page.md --dry-run
```

`review ingest` discovers `pangram` and `check-llm-cliches` on PATH (both optional; missing commands are skipped), runs `[cmd] review --path PATH`, then `ensure-item` + `add-findings` on the sprinkle. Findings render on the card. The queue works with zero integrations installed.

To add a source: implement `[cmd] review --path PATH [--id ID]`, then either name it (`review ingest mysource --path FILE`) or add it to `KNOWN_INTEGRATIONS` in `scripts/review.jsh`.

## AEM Source

Populate the review backlog from an AEM site by diffing the preview and live
content trees. Requires `aem-ext` (the `aem` skill) with a valid credential.

```bash
# Populate backlog with all unpublished and stale pages:
review sweep --org ai-ecoverse --site slicc-website

# Dry-run (print cards, don't touch the sprinkle):
review sweep --org ai-ecoverse --site slicc-website --dry-run

# Enrich a single selected card via the status endpoint:
review ingest aem-ext --path /drafts/wac-demo.md --org ai-ecoverse --site slicc-website
```

`review sweep` calls `aem-ext sweep`, which walks the `preview/` and `live/`
partition trees via the Admin API (O(folders) calls, not O(pages)), follows
`links.next` pagination to avoid the silent 100-item truncation trap, and diffs
the results. Each never-published or stale page becomes an `ensure-item` card
with `previewUrl` set. Binary assets (PDF, images, etc.) are excluded by
default; use `--include-assets` to include them.

For visual review of a card, use Pin Review on the card's `previewUrl` tab —
the only option that provides full rendered fidelity. See
[`references/AEM-SOURCE.md`](references/AEM-SOURCE.md) for the full design
including the renderer options analysis.
