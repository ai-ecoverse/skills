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

## Decision Tree: Choosing Your Approach

```
Target → Is it a single static HTML file?
    ├─ Yes → Open it directly with `playwright-cli open file:///workspace/page.html`
    │         (No server needed. Snapshot to identify elements.)
    │
    └─ No (multi-file app or dev server) → Is the server already running?
        ├─ No → Start it with `serve <dir>` (static) or run the app's dev
        │        command (e.g. `npm run dev`) in the background, then
        │        `playwright-cli open <url>`.
        │
        └─ Yes → Reconnaissance-then-action:
            1. `playwright-cli open <url>` — capture the targetId
            2. `playwright-cli snapshot --tab=<id>` — read accessibility tree
            3. Identify element refs (e5, e12, ...) from the snapshot
            4. Drive with `click` / `fill` / etc., re-snapshotting between actions
```

## Serving Local Files

Use `serve` for static content; use the app's own dev command for dynamic apps.

```bash
# Static files (read-only preview, shown to the human)
serve /workspace/app

# Driveable preview — every visitor tab becomes a live target you can automate
serve --bridge /workspace/app
```

`serve` and `serve --bridge` open a browser tab for the human. To drive that tab from the agent, use `playwright-cli tab-list` to find the targetId, then operate on it with `--tab=<id>`. For a dev server (Vite, Next, etc.), start it in the background from bash and then `playwright-cli open <url>` — capture the returned targetId.

## Reconnaissance-Then-Action Pattern

`playwright-cli` uses accessibility-tree refs (`e5`, `e12`, ...) instead of CSS/text selectors. Refs are assigned by `snapshot` and are invalidated by any state-changing command, so the loop is always: **snapshot → act → re-snapshot**.

```bash
# 1. Open and capture targetId
playwright-cli open http://localhost:5173
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

## Screenshots

Screenshots are for cases where visual output actually matters (layout regression, render fidelity). For "does this element exist / say the right thing", use `snapshot` instead — it costs a fraction of the tokens.

```bash
playwright-cli screenshot --tab=<id> --filename=/tmp/shot.png
playwright-cli screenshot --tab=<id> --fullPage --filename=/tmp/full.png
playwright-cli screenshot --tab=<id> e5 --filename=/tmp/element.png

# View it yourself (last resort — images eat context)
open --view /tmp/shot.png
```

Delegate visual inspection to a scoop when possible so the cone's context stays clean.

## Common Pitfalls

- ❌ Using stale refs after `click` / `fill` / `goto`. ✅ Always re-snapshot before the next interaction.
- ❌ Forgetting `--tab=<id>` — every tab-operating command requires it. There is no implicit "current tab".
- ❌ Screenshotting to check for text. ✅ `snapshot` + `grep` is faster and cheaper.
- ❌ Closing tabs you didn't open — other agents and the user share the tab namespace. Only close tabs whose targetId you captured yourself.

## Common Workflows

### Verify a static HTML page renders correctly

```bash
playwright-cli open file:///workspace/index.html
# targetId: ABC123
playwright-cli snapshot --tab=ABC123
playwright-cli console --tab=ABC123 error   # any JS errors?
```

### Fill and submit a form

```bash
playwright-cli open http://localhost:3000/login
# targetId: DEF456
playwright-cli snapshot --tab=DEF456
playwright-cli fill --tab=DEF456 e3 "user@example.com"
playwright-cli fill --tab=DEF456 e5 "password" --submit
playwright-cli snapshot --tab=DEF456   # confirm redirect / success state
```

### Verify an XHR response

```bash
playwright-cli open http://localhost:3000/dashboard
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
playwright-cli open http://localhost:3000
playwright-cli state-load --tab=<id> /tmp/auth.json
playwright-cli reload --tab=<id>
```

### Clean up

Close every tab you opened when the test is done:

```bash
playwright-cli tab-close --tab=<id>
```

## Reference

- SLICC `playwright-cli` skill — full command surface, tab rules, multi-agent behavior.
- `serve --help` — flags for the built-in server (`--bridge`, `--max-tabs`, `--quiet`, `--no-bridge`, `--stop`).
- Upstream inspiration: [anthropics/skills · webapp-testing](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) (Python Playwright variant).
