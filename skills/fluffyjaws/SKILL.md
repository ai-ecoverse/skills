---
name: fluffyjaws
description: Interact with Adobe FluffyJaws (Mr. FluffyJaws) — Adobe's internal AI assistant — via its public API. Use when the user mentions FluffyJaws, fj, FluffyPacks, the Adobe internal AI chatbot, the FluffyJaws CLI, fj-mcp, or wants to ask questions, stream chat completions, list/inspect FluffyPacks, list conversations, or talk to the FluffyJaws MCP endpoint without clicking through https://fluffyjaws.adobe.com. Activate on mentions of "fluffyjaws", "fluffy jaws", "fluffypack", "fluffypacks", "fj ask", "fj chat", "fj mcp", "ask FluffyJaws", "internal Adobe ChatGPT", or related Adobe internal AI workflows.
allowed-tools: bash
---

# FluffyJaws

Direct API access to Adobe FluffyJaws (a.k.a. Mr. FluffyJaws) — Adobe's internal AI assistant
that ships streaming chat over Server-Sent Events, FluffyPacks (curated AI agents
with tool/source bundles), and a JSON-RPC MCP endpoint.

Use the bundled `fj` shell command instead of opening
[https://fluffyjaws.adobe.com](https://fluffyjaws.adobe.com).

## Quick start

```bash
# Confirm you are signed in (uses the existing fluffyjaws.adobe.com browser tab).
fj me

# One-shot question. Streams to stdout, prints final answer + responseId.
fj ask "Summarize the last AEM Cloud Service release notes."

# Continue the same model thread with previousResponseId.
fj ask --continue resp_0fa5f24d3c... "Now turn that into three bullets."

# Use a specific FluffyPack (use `fj packs` to discover UUIDs).
fj ask --pack 2a0c713c-0767-4514-83af-93c9373f2f0a "What changed in Express last week?"

# Browse FluffyPacks.
fj packs --scope recommended
fj packs --q "incident" --scope discover --limit 10
fj pack 2a0c713c-0767-4514-83af-93c9373f2f0a

# Conversations.
fj convs --limit 20
fj conv <uuid>
fj search "release notes"

# Talk to the FluffyJaws MCP endpoint (JSON-RPC over HTTP).
fj mcp init
fj mcp tools
fj mcp call google_web_search '{"query":"AEM release notes"}'

# Local cached docs (no network).
fj docs            # list pages
fj docs api        # show full API doc
```

## Authentication

FluffyJaws is gated by Adobe Okta SSO. The public API also supports Okta
client_credentials service tokens, but for an interactive SLICC session the
**browser session** path is what works without any extra setup.

**How `fj` authenticates**: it finds (or opens) a tab on
`https://fluffyjaws.adobe.com` and runs every API call from that page's context
via `playwright-cli eval`, so the request carries the user's `fjv3_session`
cookie automatically.

Why not direct fetch from the SLICC sandbox?

- The browser-fetch in SLICC always sends `Origin: http://localhost:...`.
- FluffyJaws's `api.fluffyjaws.adobe.com` host enforces CORS against registered
  origins; localhost is rejected.
- The same-origin UI host (`fluffyjaws.adobe.com`) accepts the cookie session.
- So `fj` always proxies through a `fluffyjaws.adobe.com` tab.

If the session is expired you will see a redirect to `adobe.okta.com`. In that
case re-sign-in once in the FluffyJaws tab (in the foreground browser) and
retry.

## Available commands

All commands print structured output. JSON commands print pretty-printed JSON;
streaming commands print incremental text and a final summary line.

### `fj me`
Prints the signed-in identity from `/api/auth/me`.

### `fj ask <prompt> [options]`
Stream a single chat turn. Prints assistant text as it arrives, then prints a
final line `responseId=resp_...` you can pass back as `--continue` later.

Options:
- `--model <id>` — model to use (default `gpt-5.4`)
- `--pack <uuid>` — route through a FluffyPack
- `--continue <responseId>` — continue an earlier response (multi-turn)
- `--reasoning <low|medium|high>` — reasoning effort
- `--no-search` — disable webSearchEnabled
- `--no-canvas` — disable canvasMode
- `--raw` — print raw SSE events instead of pretty text
- `--json` — emit one JSON line per SSE event

### `fj chat <prompt> [options]`
Alias for `fj ask`.

### `fj packs [options]`
List FluffyPacks via `/api/v1/fluffypack/list`.

Options:
- `--scope <all|builtin|discover|mine|recent|recommended>` (default `all`)
- `--q <query>`
- `--limit <1-100>` (default 24)
- `--offset <n>` (default 0)
- `--json` — full response JSON instead of compact one-line summary

### `fj pack <uuid>`
Fetch a pack's detail document via `/api/v1/fluffypack/:uuid`.

### `fj explore [--q <query>]`
Returns the four grouped pack lists (`recommended`, `recent`, `builtin`,
`discover`) the UI uses for the picker.

### `fj convs [--limit <n>] [--offset <n>]`
List conversations.

### `fj conv <uuid>`
Get a conversation envelope.

### `fj search <query> [--limit <n>]`
Search conversations.

### `fj mcp <subcommand>`
Direct JSON-RPC client for `/api/v1/mcp`. Stores the negotiated
`Mcp-Session-Id` in `~/.config/fj/mcp-session.txt` so subcommands chain.

Subcommands:
- `fj mcp init` — call `initialize`, store session id
- `fj mcp ping` — call `ping`
- `fj mcp tools` — call `tools/list`
- `fj mcp call <name> <args-json>` — call a tool, prints JSON result
- `fj mcp shutdown` — end the MCP session
- `fj mcp session` — print the stored session id

### `fj docs [page]`
Print the bundled, locally cached FluffyJaws documentation (no network).

Pages: `index`, `api`, `mcp`, `python`, `register-app`, `fluffypacks`,
`fluffypack-builder`, `slack-channels`. With no argument, lists the available
pages.

## Streaming output format

`fj ask` reads the SSE stream and renders friendly output by default:

- Each `response.output_text.delta` event is written to stdout as the delta.
- Tool lifecycle events (`tool_executing`, `tool_complete`) print a single
  status line to stderr, e.g. `[tool] full_documentation_search …`.
- On `response.completed`, a trailing `\n` and `responseId=resp_...` line are
  printed to stderr.
- On `response.failed` or `error`, the error is printed to stderr and `fj`
  exits with status 1.

`--raw` skips parsing and dumps every SSE line. `--json` emits one parsed JSON
event per line for piping into `jq`.

## Endpoints reference

For the full endpoint catalog with request/response schemas, see
`references/endpoints.md`.

## Caveats

- The skill calls every endpoint via the same-origin **UI host**
  (`https://fluffyjaws.adobe.com`), not `api.fluffyjaws.adobe.com`. Both serve
  the same `/api/v1/*` contract, but only the UI host accepts the cookie
  session you already have.
- Inline file uploads (`input_file`) and reusable `fileIds` are not currently
  exposed by `fj ask`. Add them when you need them.
- The public `/api/v1/conversation/*` surface intentionally exposes only
  metadata reads and `create`. There is **no public message-save** route, so
  streamed turns done via `fj ask` are not persisted in the FluffyJaws web UI's
  conversation history. If you need durable history, store the
  `responseId` chain yourself.
- Service-token / on-behalf-of-user auth is documented in
  `references/endpoints.md` but is not exercised by `fj` because the SLICC
  fetch sandbox cannot present the right Origin to `api.fluffyjaws.adobe.com`.
