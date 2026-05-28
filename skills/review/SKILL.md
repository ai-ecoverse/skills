---
name: review
description: "Track review items (publish/comment/defer) and annotate documents with text highlighting via a sprinkle dashboard. Use when the user has content to review, approve, or annotate — pages pending publish, PRs needing signoff, documents to mark up. Triggers on requests like 'review queue', 'what's pending', 'annotate this doc', 'mark up this file', 'review dashboard', 'publish queue'. Distinct from code review tools: this skill manages a persistent UI queue with in-flight publish tracking and inline text selection annotations."
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

### Handling licks (cone)

Forward lick events to the owning scoop using this pattern:

```
feed_scoop("review", "Lick event on YOUR sprinkle: { action: '<ACTION>', data: <DATA> }.
Execute the action, then push status update: sprinkle send review '{\"action\":\"update-status\",\"id\":\"<ID>\",\"status\":\"<STATUS>\"}'") 
```

A `publish` lick resolves to `"status":"published"`; `defer` resolves to `"status":"deferred"`; `comment` needs no status update.

### In-flight indicators and error recovery

`publish` and `defer` show a pulsing in-flight indicator and disable action buttons until the cone sends a matching `update-status`.

- **Success** — send `update-status` with `"published"` or `"deferred"` to clear the indicator.
- **Failure** — send `update-status` with `"status":"error"` and an optional `"message"`. The card surfaces the message and re-enables buttons for retry:
  ```bash
  sprinkle send review '{"action":"update-status","id":"page-1","status":"error","message":"Publish failed: upstream returned 503. Retry or check the deployment log."}'
  ```
- **Timeout** — if the scoop does not respond in time, push an error status to avoid a stuck UI (same `update-status` shape with `"status":"error"` and a timeout message).
