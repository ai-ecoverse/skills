# Speck Fix — element-level AI editing

Optional add-on to Pin Review. Lets the user run Speck's element-level AI editing layer on
**locally-served pages** (`chrome-extension://<id>/preview/...`). Hidden on remote http(s) pages,
which Speck can't inject into due to CSP. Pin Review works without any of this.

## How to enable (quick reference)

1. Install the speck skill: `upskill ai-ecoverse/skills --skill speck`
2. Create a `speck-worker` scoop with `/tmp/` write access, with standing duties (see the worker's
   `DUTIES.md` pattern) to handle the two webhooks below.
3. Create two webhooks routed to that scoop:
   - `speck-fix` — handles `inject-speck`
   - `speck-lick` — handles element-instruction events
4. `sed` the `speck-fix` URL into `enter.resolved.js` for the `__SPECK_WEBHOOK_URL__` placeholder.

Verify the worker is reachable: drop a pin on a local preview, click **✨ Fix with Speck** in its
tooltip, and confirm the `speck-worker` scoop receives an `inject-speck` event.

## Architecture

Two entry points POST `{action:'inject-speck', url}` to the `speck-fix` webhook (routed to the
`speck-worker` scoop):

- The sprinkle's **Speck Fix** toggle button (top bar, next to Pin Review).
- Each marker's hover tooltip **✨ Fix with Speck** button (local previews only).

On `inject-speck` the worker:
1. Finds the matching tab and maps the preview URL → VFS file path.
2. Runs `speck inject <tab> --file <path>` (turns on Speck's annotation layer only — no
   fetch/copy/redesign).
3. **Re-injects the review display overlay** (`enter.resolved.js`, `wantAdd=false`) so pins stay
   visible — Speck reloads the page, which wipes the overlay.
4. Syncs the sprinkle: `set-speck active:true`, `set-review-mode active:false`.

Element instructions flow through the `speck-lick` webhook to the worker, which applies the edit,
reloads, re-injects Speck, and re-injects the pin display overlay each time.

## Toggle off

`toggle-speck active:false` (or remove via the cone): run `speck remove <tab>`. Markers stay.

## Mutual exclusivity with Pin Review

Pin Review and Speck Fix both capture page clicks, so they are **mutually exclusive** — enabling one
disables the other. Keep both sprinkle buttons synced via `set-review-mode` / `set-speck`. When
enabling Pin Review, first remove any Speck layer and sync `set-speck active:false`.
