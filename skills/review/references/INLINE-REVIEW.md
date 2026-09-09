# Inline asset review

The queue's single Preview button and `open-file` message use the same iframe.
HTML keeps its document styles; Markdown is rendered as a document; `.fountain`
uses `fountain render <path> --json` from Save the Cat. A renderer returns
`{html, title, format, renderer, path}`. The source remains the edit target.

Review uses an iframe with `sandbox="allow-same-origin"` and no script permission.
It removes scripts, nested frames, event handlers, refresh directives, and unsafe
navigation, then attaches its own parent-side selection listeners. Local image
and stylesheet paths resolve relative to the source. Remote HTML is fetched
through SLICC with relative resources based on its URL. Script-driven state and
interactive embeds are not reproduced; use the external browser tools to review
those live states. The preview does not silently open another tab.

## Drafts and anchors

Comments are stored in `state.documents`, keyed by `path:<source path>` or
`url:<source URL>`. Legacy `state.annotations` migrates to its original document.
Switching cards never clears drafts. Initialization waits for saved state; older
standalone hosts that omit `sprinkle-init` hydrate from the same-origin host
store before enabling writes. An inaccessible or corrupt store is never
replaced with an empty queue. Each note contains a stable note ID, original
text, comment, and an anchor:

```json
{
  "selector": "#fountain-7",
  "quote": "Somebody is still out there.",
  "elementText": "Somebody is still out there.",
  "prefix": "",
  "suffix": "",
  "kind": "text",
  "tag": "p",
  "scene": "INT. OBSERVATORY - NIGHT",
  "token": "7"
}
```

HTML/Markdown anchors have empty scene/token fields. DOM paths are hints, not
proof: Review checks the element text before restoring a marker and only falls
back to a unique matching passage. After a changed or ambiguous passage, the
original quote remains in the comment. The agent must also verify source text
before editing. A generated DOM selector never authorizes editing a similarly
positioned element whose content no longer matches.

## Explicit dispatch

Saving notes emits no edit request. Clicking Send to agent emits:

```json
{
  "action": "submit-revisions",
  "data": {
    "id": "review:/shared/draft.fountain",
    "path": "/shared/draft.fountain",
    "url": "",
    "format": "fountain",
    "batchId": "unique-batch-id",
    "revisions": [{"id":"note-id","text":"Somebody is still out there.","note":"Make Mara sound less certain.","anchor":{}}]
  }
}
```

The panel marks these notes as sent before dispatch, disables duplicate sends,
and retains them across reloads. Additional drafts form a new batch. The owning
agent/scoop must record handled batch IDs so replayed events do not apply edits
twice. Acknowledge the batch after checking the source change:

```sh
sprinkle send review '{"action":"revisions-result","batchId":"unique-batch-id","status":"applied"}'
```

If the source cannot be changed, return a failure. The panel returns those notes
to draft state and displays the explanation so the user can retry:

```sh
sprinkle send review '{"action":"revisions-result","batchId":"unique-batch-id","status":"failed","message":"The source moved. Restore the file before retrying."}'
```

The source is re-read on Reload; no generated output or stale preview is written
back. For Fountain, edits always target `.fountain`, not an exported `.html`.
