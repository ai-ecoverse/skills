---
name: review
description: Track review items (publish/comment/defer) and annotate documents with text highlighting. Use when the user has content to review, approve, or annotate — pages pending publish, PRs needing signoff, documents to mark up. Triggers on requests like "review queue", "what's pending", "annotate this doc", "mark up this file", "review dashboard", "publish queue".
allowed-tools: bash
---

# Review

A combined review queue and document annotation sprinkle. Default view shows a queue of items with publish/comment/defer actions. Opening a VFS file switches to a document view with text selection annotations.

## Architecture

Two views in one sprinkle:

1. **Queue view** — Cards with status dots (pending/published/deferred), preview/live links, action buttons. Comment expands inline.
2. **Document view** — Renders markdown or HTML files with text selection → annotation popup. Annotations collected at bottom in collapsible panel. "Submit Revisions" fires all annotations as a lick.

The sprinkle runs at ~400px sidebar width. No horizontal splits.

## Scoop Workflow

One scoop named `review` owns the sprinkle.

### Creating

```
scoop_scoop("review")
feed_scoop("review", "You own the 'review' sprinkle.
1. Copy template: cp /workspace/skills/review/templates/review.shtml /shared/sprinkles/review/review.shtml
2. Run: sprinkle refresh && sprinkle open review
3. Load initial items via: sprinkle send review '<json>'
4. Stay alive for lick events.")
```

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

Always forward lick events to the owning scoop:

```
feed_scoop("review", "Lick event on YOUR sprinkle: { action: 'publish', data: { id: 'page-1', path: '/shared/security.md', url: 'https://...' } }. 
Execute the publish action, then push status update: sprinkle send review '{\"action\":\"update-status\",\"id\":\"page-1\",\"status\":\"published\"}'")
```

**`publish` and `defer` show an in-flight indicator until the cone confirms.** When the user clicks one of those actions the card pulses with an "acting" state and the buttons disable. The scoop **must** push an `update-status` message (success → `published`/`deferred`, failure → back to `pending`) — otherwise the card stays stuck in flight. This protects against silently leaving the UI claiming a publish that never happened.

For `submit-revisions`, the scoop should apply the annotations (edit the file, open a PR, post a comment) and confirm back.

## Item Schema

```typescript
interface ReviewItem {
  id: string;        // Unique identifier
  title: string;     // Display title
  path?: string;     // VFS path for document review (enables "Review" link)
  previewUrl?: string; // Preview URL (shown as "Preview" link)
  liveUrl?: string;  // Live URL (shown as "Live" link)
  status: 'pending' | 'published' | 'deferred';
}
```

## State Persistence

The sprinkle persists via `slicc.setState`:
- Queue items and their statuses
- Current view (queue/document)
- Active document path
- In-progress annotations

State survives panel close/reopen. Annotations are preserved when re-opening the same document path; switching to a different path clears them.

## Document Sanitization

Both markdown and HTML documents are sanitized before rendering:

- **Markdown** is escape-first: raw HTML in source becomes inert text. Link URLs are protocol-whitelisted (`http(s):`, `mailto:`, `#`, `/`); other schemes (notably `javascript:`) render as plain labels.
- **HTML/HTM** files are parsed via `<template>` (inert — no images load, no scripts run) and walked to strip `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<style>`, `<base>`, all `on*` event handlers, `srcdoc`, and `javascript:` / `data:` / `vbscript:` URLs in `href`/`src`.

This protects the sprinkle context (which has VFS read/write through `slicc`) when reviewing untrusted documents.

## Template

The full sprinkle template is at `templates/review.shtml`. Copy it to `/shared/sprinkles/review/review.shtml` before opening.

## Design

Uses Spectrum 2 tokens exclusively. Status colors:
- Pending: `var(--s2-notice)` (amber)
- Published: `var(--s2-positive)` (green)
- Deferred: `var(--s2-fg)` at 35% (gray)

Annotations use `var(--s2-accent)` highlight tint. All buttons use pill radius. No emoji — Lucide icons only.
