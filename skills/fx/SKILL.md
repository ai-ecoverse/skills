---
name: fx
description: >
  Run Vercel's fx coding agent (fx.sh) inside SLICC, in-process on its WebAssembly build
  (fx-core.wasm via the libfx npm package). fx's shell tool executes in the SLICC shell against
  the VFS, model traffic goes to Vercel AI Gateway through SLICC's fetch, and sessions persist
  under /workspace/.fx/. Use when the user mentions fx, fx.sh, Vercel's coding agent, libfx,
  "run fx", "ask fx", "delegate this to fx", "try this with fx", "compare fx with the cone",
  Vercel AI Gateway models (anthropic/claude-*, zai/glm-*, openai/gpt-*) through fx, or wants a
  second, independent coding agent to take a pass at a task in the workspace.
allowed-tools: bash
command: fx
script: scripts/fx.jsh
---

# fx

`fx` hosts the headless [fx](https://fx.sh) agent (`fx-core.wasm`, Zig → `wasm32-wasi`, JSPI)
from the `libfx` npm package inside a `.jsh` realm. Nothing leaves SLICC's sandbox: fx's
`workspace.exec` is wired to `require('sliccy:exec')`, so every command fx runs is an ordinary
SLICC shell command on the VFS — the same boundary as the cone's own `bash` tool.

## Setup (once)

```bash
ipk add esbuild-wasm@0.28.2   # libfx ships ESM; the realm transpiles it with the ipk-installed esbuild
ipk add libfx@0.0.4           # ~36 MB tarball; only fx-core.wasm (2.3 MB) + fx-sdk.js are used
```

## Credentials

fx talks to Vercel AI Gateway only. Add a **Vercel AI Gateway** account in SLICC's provider
settings and select one of its models — SLICC then seeds `AI_GATEWAY_API_KEY` into realm
scripts automatically (SLICC ≥ the release that includes `shell/provider-env-seed.ts`). To use
a different key for one run:

```bash
AI_GATEWAY_API_KEY=vck_… fx "…"
```

`fx` exits 1 with guidance when no key is available. A Gateway account without a payment
method answers `HTTP 403 … requires a valid credit card on file` — that is a Vercel-side
account setting.

## Usage

```bash
fx "Summarize the files in this workspace."
fx --model anthropic/claude-sonnet-4.5 "Add a README to /workspace/demo"
fx --models                      # models the Gateway offers; * marks the current one
fx --sessions                    # stored sessions (under /workspace/.fx/sessions/)
fx --session <id> "continue…"    # resume a stored session
fx --json "…"                    # raw ACP session updates, one JSON object per line
```

Output: the agent's text streams to stdout; tool calls are announced on stderr as
`[tool] <title>`; a non-`end_turn` stop reason (e.g. `refused`) is reported on stderr.

## Limits

- Requires WebAssembly JSPI (Chrome 137+); SLICC's kernel realm has it.
- fx's workspace is `/workspace` only, non-git, `allow-sandboxed`: fx runs commands without
  asking because SLICC's sandbox is the boundary.
- The WASM build of fx has no MCP, subagents, web search, or clipboard.
- One turn per invocation; use `--session` to continue a conversation.
