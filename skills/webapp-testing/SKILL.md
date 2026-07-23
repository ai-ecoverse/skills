---
name: webapp-testing
description: >-
  Testing and verifying local web applications in SLICC using `playwright-cli`
  (CDP-based) and `serve`. Use when the user asks to test a webapp, verify
  frontend behavior, drive a UI, inspect page state, capture screenshots, or
  debug JavaScript in a page — whether the target is a static HTML file, a dev
  server, or a `serve --bridge` preview.
allowed-tools: bash
---

# Web Application Testing (SLICC)

Test local web applications using SLICC's built-in `playwright-cli` (also aliased as `playwright` and `puppeteer`) and the `serve` command. This skill translates the standard webapp-testing patterns — navigation, interaction, assertion, screenshots — to the CDP-based `playwright-cli` surface.

Before running browser automation, read the `playwright-cli` skill for the full command reference, tab-namespace rules, and multi-agent behavior. This skill focuses on the *testing workflow*: how to combine `serve` + `playwright-cli` to verify a webapp.

## SLICC has no real filesystem for the browser

There is **no OS filesystem behind the VFS**, so `file:///…` URLs do **not** work — `playwright-cli open file:///workspace/page.html` lands on `ERR_FILE_NOT_FOUND`. Local content must be **served over HTTP** through the built-in `serve` command (a worker-hosted preview), then opened by its `https://…sliccy.now/…` URL. This applies even to a single static HTML file.

## Decision Tree: Choosing Your Approach

```
Target → Static content (single HTML file OR multi-file app on disk)?
    ├─ Yes → `serve <dir>` (serves the directory over HTTP and opens a tab).
    │         It prints the preview URL AND the targetId directly — capture
    │         the targetId. Use `--entry <file>` if the entry isn't index.html.
    │
    └─ No (needs a dev server: Vite, Next, etc.) → start the dev command in
        the background from bash, then `playwright-cli open <url>` and capture
        the returned targetId.

Then, for either path: bring the tab to the FRONT (see "Foreground" below),
snapshot → act → re-snapshot.
```

## Serving Local Files

`serve` mints a worker-hosted preview URL for a VFS directory, opens it in a browser tab, and **prints the tab's targetId** so you can drive it immediately — no `tab-list` lookup needed.

```bash
# Static files (read-only preview, also shown to the human)
serve /workspace/app
# Output: Preview URL: https://<hash>.sliccy.now/index.html (targetId: 85343EA7...)

# Non-default entry file
serve --entry app.html /workspace/app

# Driveable preview — every visitor tab becomes a live target you can automate
serve --bridge /workspace/app
```

For a dev server (Vite, Next, etc.), start it in the background from bash and then `playwright-cli open <url>` — capture the returned targetId. When done, revoke previews with `serve --stop <token>` (list active ones with `serve --list`).

## Foreground the tab before interacting (important)

**CDP mouse and keyboard input (`click`, `dblclick`, `hover`, `check`, `uncheck`, `drag`, `press`, `type`) silently no-ops on a tab that is not in the foreground.** The command still prints `Clicked e5` / `Checked e5`, but nothing actually happens on the page — a common cause of "my clicks don't register." DOM-based commands (`fill`, `eval`, `snapshot`, `screenshot`, `console`, `requests`) work regardless of foreground state.

So, before driving a tab with mouse/keyboard actions, bring it to the front once:

- New tab → `playwright-cli open <url> --foreground` (or `tab-new <url> --fg`).
- Existing tab → `playwright-cli tab-select <index>` (1-based index from `tab-list`).

Once a tab has been foregrounded, input events land reliably even if it later moves to the background.

## Reconnaissance-Then-Action Pattern

`playwright-cli` uses accessibility-tree refs (`e5`, `e12`, ...) instead of CSS/text selectors. Refs are assigned by `snapshot` and are invalidated by any state-changing command, so the loop is always: **snapshot → act → re-snapshot**.

```bash
# 1. Open in the foreground and capture targetId
playwright-cli open http://localhost:5173 --foreground
# Output: Opened http://localhost:5173 in new tab [targetId: E9A3F...]

# 2. Snapshot to see structure and get refs
playwright-cli snapshot --tab=E9A3F

# 3. Act on refs from the snapshot
playwright-cli fill --tab=E9A3F e12 "search term"
playwright-cli click --tab=E9A3F e5

# 4. Re-snapshot — the previous refs are stale
playwright-cli snapshot --tab=E9A3F
```

## Assertions

Prefer text/DOM assertions over screenshots — they are cheaper and more reliable than pixel comparisons.

- **Text presence / structure** — `playwright-cli snapshot --tab=<id>` returns the full accessibility tree; grep it for expected labels, roles, values.
- **Specific DOM values** — `playwright-cli eval --tab=<id> "document.title"` (or any expression, incl. top-level `await`/`return`). Save large results with `--filename=path`.
- **Network responses** — `playwright-cli requests --tab=<id>` + `response-body --tab=<id> <index>` to verify XHR/fetch payloads.
- **Console errors** — `playwright-cli console --tab=<id> error` to check for JS errors after an interaction.

Example assertion pattern:

```bash
# After clicking "Submit", verify the success message appears
playwright-cli click --tab=E9A3F e8
playwright-cli snapshot --tab=E9A3F | grep -q "Order confirmed" \
  && echo "PASS" || echo "FAIL"
```

**Console capture starts at CDP attach.** Messages logged during the *initial* page load (before the tab was attached) may not appear — if you need load-time console output, `reload --tab=<id>` and then read `console`.

## Screenshots

Screenshots are for cases where visual output actually matters (layout regression, render fidelity). For "does this element exist / say the right thing", use `snapshot` instead — it costs a fraction of the tokens.

```bash
playwright-cli screenshot --tab=<id> --filename=/tmp/shot.png
playwright-cli screenshot --tab=<id> --fullPage --filename=/tmp/full.png   # alias: --full-page
playwright-cli screenshot --tab=<id> e5 --filename=/tmp/element.png        # element screenshot
playwright-cli screenshot --tab=<id> --max-width=800 --filename=/tmp/small.png  # downscale

# View it yourself (last resort — images eat context)
open --view /tmp/shot.png
```

Delegate visual inspection to a scoop when possible so the cone's context stays clean.

## Common Pitfalls

- ❌ `file:///…` URLs — they fail (`ERR_FILE_NOT_FOUND`). ✅ Serve over HTTP with `serve <dir>`.
- ❌ Clicking/typing on a background tab — the command reports success but nothing happens. ✅ Foreground the tab first (`--foreground` / `tab-select`).
- ❌ Using stale refs after `click` / `fill` / `goto`. ✅ Always re-snapshot before the next interaction.
- ❌ Forgetting `--tab=<id>` — every tab-operating command requires it. There is no implicit "current tab".
- ❌ Screenshotting to check for text. ✅ `snapshot` + `grep` is faster and cheaper.
- ❌ Closing tabs you didn't open — other agents and the user share the tab namespace. Only close tabs whose targetId you captured yourself.

## Common Workflows

### Verify a static HTML page renders correctly

```bash
serve /workspace/app                       # Preview URL: https://…/index.html (targetId: ABC123)
playwright-cli tab-select <index>          # bring it to the front (index from tab-list)
playwright-cli snapshot --tab=ABC123
playwright-cli console --tab=ABC123 error  # any JS errors?
```

### Fill and submit a form

```bash
serve /workspace/app                       # targetId: DEF456
playwright-cli tab-select <index>          # foreground before interacting
playwright-cli snapshot --tab=DEF456
playwright-cli fill --tab=DEF456 e3 "user@example.com"
playwright-cli fill --tab=DEF456 e5 "password" --submit
playwright-cli snapshot --tab=DEF456       # confirm redirect / success state
```

### Verify an XHR response

```bash
playwright-cli open http://localhost:3000/dashboard --foreground
# targetId: GHI789
playwright-cli requests --tab=GHI789 --filter="/api/"
playwright-cli response-body --tab=GHI789 2 --filename=/tmp/api-response.json
cat /tmp/api-response.json | jq '.status'
```

### Persist auth state between runs

```bash
# After logging in
playwright-cli state-save --tab=<id> --filename=/tmp/auth.json

# Later — restore cookies + localStorage
playwright-cli open http://localhost:3000 --foreground
playwright-cli state-load --tab=<id> /tmp/auth.json
playwright-cli reload --tab=<id>
```

### Clean up

Close every tab you opened and revoke any previews you minted when the test is done:

```bash
playwright-cli tab-close --tab=<id>
serve --stop <token>    # token/list via `serve --list`
```

## Reference

- SLICC `playwright-cli` skill — full command surface, tab rules, multi-agent behavior.
- `serve --help` — flags for the built-in server (`--entry`, `--bridge`, `--no-bridge`, `--max-tabs`, `--quiet`, `--stop`, `--list`).
- Upstream inspiration: [anthropics/skills · webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) (Python Playwright variant).
