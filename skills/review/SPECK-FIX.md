# Speck Fix — element-level AI editing

Optional add-on to Pin Review. Lets the user run Speck's element-level AI editing layer on
**locally-served pages** (`chrome-extension://<id>/preview/...`). Hidden on remote http(s) pages,
which Speck can't inject into due to CSP. Pin Review works without any of this.

## How to enable — lazy auto-load on first use

Speck loads **on demand** the first time the user clicks **✨ Fix with Speck** (or the **Speck Fix**
toggle). The cone's `toggle-speck` / `inject-speck` handler runs the bootstrap below automatically;
the user does not perform any manual setup. See `SKILL.md` § Lazy auto-load on first use for the
handler contract.

Bootstrap steps (idempotent — the handler skips any already done):

1. Install the speck skill if missing: `upskill ai-ecoverse/skills --skill speck`
2. Ensure a `speck-worker` scoop exists with `/tmp/` write access, with standing duties (see the
   worker's `DUTIES.md` pattern) to handle the two webhooks below. Create it if missing.
3. Ensure two webhooks routed to that scoop exist (create any missing):
   - `speck-fix` — handles `inject-speck`
   - `speck-lick` — handles element-instruction events
4. Resolve `__SPECK_WEBHOOK_URL__` in `enter.resolved.js` from the **current** `speck-fix` webhook URL
   (read it live from `webhook list` — URLs regenerate across sessions), then re-inject the overlay.

Because the bootstrap is idempotent, the first click pays the load cost (and the cone tells the user
Speck is loading); every later click is instant. Verify the worker is reachable by clicking **✨ Fix
with Speck** on a local-preview marker and confirming the `speck-worker` scoop receives an
`inject-speck` event.

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
