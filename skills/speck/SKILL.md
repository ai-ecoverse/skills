---
name: speck
description: |
  Use this when the user wants to annotate, inspect, or leave element-level
  feedback on a local HTML page served in a browser tab. Injects a hover-highlight
  + click-to-annotate interaction into the target page. Annotations are sent as
  licks to a scoop that applies the user's instructions as AI-driven edits to the
  HTML. Use when the user says "annotate this page", "let me mark up elements",
  "add speck", "inspect elements with notes", or "inject speck".
allowed-tools: bash
---

# speck

Inject an element-level annotation layer into any local HTML page currently open
in a browser tab. Once active, hovering highlights elements with a coloured
border; clicking locks the selection and opens a text input where the user can
type an instruction for that element. On submit, the instruction is sent as a
webhook lick to a `speck-worker` scoop that applies the edit to the underlying
HTML file, reloads the page, and re-injects speck for continuous editing.

## Setup (cone responsibilities)

Before speck can work end-to-end, the cone must ensure:

1. **A `speck-worker` scoop exists** with `/tmp/` write access:
   ```
   scoop_scoop("speck-worker", writablePaths=["/scoops/speck-worker-scoop/", "/shared/", "/tmp/"])
   ```
2. **The scoop has standing instructions** (via `feed_scoop`) to:
   - Read the target file
   - Locate the element by selector/snippet
   - Apply the user's instruction as an edit
   - Reload the tab via `playwright-cli goto <preview-url> --tab <tabId>`
   - Re-inject speck via `speck inject <tabId> --file <filePath>`
3. **A single webhook named `speck-lick`** routes to the scoop. The `speck inject`
   command creates this automatically if it doesn't exist.

## Commands

```bash
speck inject <tabId> [--file <path>]   # Inject + wire webhook for live edits
speck collect <tabId>                  # Retrieve annotations as JSON
speck remove <tabId>                   # Remove overlay + cleanup state
```

The `--file` flag tells the speck-worker scoop which HTML file to edit. Without
it, annotations are collected locally but not applied.

## How it works

1. **Hover**: elements receive an orange outline (3px solid #FF6B35) with a soft
   glow on mouseover.
2. **Click**: locks the highlight and shows a fixed-position dark input tooltip
   below the element.
3. **Enter**: submits the instruction — POSTs to the `speck-lick` webhook which
   routes to the `speck-worker` scoop. The tooltip flashes green to confirm.
4. **Escape**: dismisses without submitting. Click elsewhere also dismisses.
5. **Scoop execution**: the scoop edits the file, reloads the page, and
   re-injects speck so the user can keep annotating without interruption.

### Webhook payload shape

```json
{
  "action": "element-instruction",
  "data": {
    "instruction": "make this text larger",
    "element": {
      "tag": "h2",
      "class": "section-title",
      "text": "Latest News",
      "selector": "section:nth-of-type(3) > h2",
      "outerSnippet": "<h2 class=\"section-title\">Latest News</h2>"
    },
    "file": "/shared/stardust/prototype/index.html",
    "tabId": "1218556234",
    "timestamp": 1717300000000
  }
}
```

## Progress feedback

The cone sends a chat message when the speck-worker scoop completes each edit,
summarizing what was applied. This gives the user immediate feedback in the
conversation without needing a separate UI panel.

## Key design decisions

- **Single webhook**: `speck inject` reuses a single webhook named `speck-lick`
  rather than creating one per tab/injection. This prevents duplicate webhook
  accumulation.
- **Re-injection after edit**: the scoop MUST re-inject speck after reloading
  the page, otherwise the overlay is lost.
- **No sprinkle UI**: progress is shown via chat messages from the cone. A
  sprinkle panel was tried but the rail icon cannot show dynamic status, making
  it less useful than inline chat feedback.
- **Preview pages only**: the injection uses `playwright-cli eval` on the
  extension's preview service worker pages. Remote/third-party pages will block
  it via CSP.
- **`/tmp/` write access**: the scoop needs `/tmp/` to run `speck inject`
  (which writes a temp file for playwright-cli eval). Include it in
  `writablePaths` when creating the scoop.

## Cone workflow on scoop completion

When the cone receives `[@speck-worker-scoop completed]`:
1. Read the notification preview to see what was applied.
2. Send a short chat message to the user: "Speck applied: <summary>"

## Don't

- Don't inject into remote/third-party pages (CSP will block it). Use only on
  locally served or preview pages.
- Don't call `speck inject` twice on the same tab without `speck remove` first —
  you'll get duplicate listeners. (The script guards against this with an
  `already injected` check, but avoid it anyway.)
- Don't create multiple webhooks — `speck inject` looks for an existing
  `speck-lick` webhook before creating one.
- Don't use shift-reload on the preview page — it bypasses the service worker
  and gives ERR_FILE_NOT_FOUND. Use regular reload or `playwright-cli goto`.
- Don't create a sprinkle for speck progress — it was tried and removed because
  the rail icon can't show dynamic state.
