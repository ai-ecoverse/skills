---
name: bb
description: |
  Control a bb instance (the agentic IDE at getbb.app / get-bb/bb) over its HTTP
  API from SLICC. Use this whenever the user mentions bb, "my bb", bb threads,
  bb projects, getbb.app, `<handle>.getbb.app`, a bb thread id (`thr_…`), a bb
  project id (`proj_…`), or asks to list/inspect/steer/spawn coding-agent
  threads, read a thread's log or final output, send a follow-up prompt to an
  agent thread, stop a running thread, wait for a thread to go idle, or pair
  SLICC with a bb server ("pair with bb", "connect to my bb", "bb machine
  code"). Mirrors the official `bb` CLI: `bb thread list|show|log|output|tell|
  spawn|stop|wait|search`, `bb project list|show`, `bb status`, plus
  `bb pair`/`bb unpair` for credential setup.
allowed-tools: bash
command: bb
script: scripts/bb.jsh
---

# bb — drive a bb server from SLICC

`bb` talks to a bb server's public HTTP API (`/api/v1/*`, defined in
[get-bb/bb](https://github.com/get-bb/bb)). Command names and flags follow the
official `bb` CLI so anything you know from a bb terminal transfers directly.

Requests run **inside a browser tab parked on the bb origin**, opened on demand.
bb's server answers `forbidden_origin` to anything carrying a foreign browser
Origin, and both the realm's `fetch` and the sandbox's `curl` leave the SLICC
origin attached — a page-origin request is the only shape it accepts. No bb
session cookie is needed in that tab; the machine credential rides on each
request and satisfies the bb connect gate.

## Pairing (do this once)

bb servers reachable through bb connect (`https://<handle>.getbb.app`) gate
`/api/v1` behind a **connect machine credential**. The owner mints a one-time
machine code on the bb server itself:

```bash
# run on the machine that owns the bb server (its own shell, not SLICC)
curl -s -X POST -H 'content-type: application/json' -d 'null' \
  http://127.0.0.1:38886/api/v1/plugins/connect/rpc/createMachineCode
# → {"ok":true,"result":{"code":"<code>","expiresAt":…,"serverUrl":"https://<handle>.getbb.app"}}
```

Then, in SLICC:

```bash
bb pair --code <code> --server https://<handle>.getbb.app
```

`pair` redeems the code at `https://getbb.app/api/connect/redeem-machine` and
persists the resulting durable credential in skill config. Codes are one-time
and short-lived — if `pair` reports `already_used` or `expired_code`, mint a
fresh one. The credential is never printed; `bb status` only reports whether one
is stored.

A bb server the sandbox browser can reach directly (same machine as the SLICC
runtime) needs no credential — only an origin:

```bash
bb pair --server http://127.0.0.1:38886
```

`BB_SERVER_URL` and the global `--server <url>` flag override the stored server
for a single call.

## Commands

```
bb status [--json]                      Connection, server version, thread counts
bb pair --code <c> [--server <url>]     Redeem a connect machine code
bb unpair                               Forget the stored credential and server
bb self [<thread-id>]                   Show or set the default thread for --self

bb project list [--json]
bb project show <id> [--json]

bb thread list [--project <id>] [--parent-thread <id>] [--archived]
               [--include-hidden] [--limit <n>] [--json]
bb thread show [<id>] [--self] [--json]
bb thread log [<id>] [--self] [--limit <n>] [--after-seq <n>] [--json]
bb thread output [<id>] [--self] [--json]
bb thread tell <id> <message…> [--self] [--mode steer|queue|auto]
               [--model <m>] [--reasoning-level <l>] [--permission-mode <m>] [--json]
bb thread spawn --project <id> [--prompt <p>] [--provider <id>] [--model <m>]
               [--title <t>] [--environment <id>] [--new-environment worktree]
               [--host <id>] [--base-branch <b>] [--parent-thread <id>]
               [--visibility visible|hidden] [--json]
bb thread stop [<id>] [--self] [--json]
bb thread wait <id> [--status <status>] [--timeout <seconds>]
               [--poll-interval <ms>] [--json]
bb thread search <query> [--limit <n>] [--json]
bb thread queue list [<id>] [--self] [--json]
```

Every command takes `--json` and prints the raw API response. `--self` targets
the thread stored by `bb self <id>` (or `BB_THREAD_ID` when the runtime sets it).

## Notes

- `tell` starts real agent work on a real thread and costs provider tokens.
  Default `--mode steer` interrupts a busy thread; `--mode queue` appends
  instead. Confirm the target id before sending.
- `--mode steer|queue|auto` are the CLI names; the script maps them onto the
  wire values (`steer-if-active`, `queue-if-active`, `auto`), which the API
  requires.
- Deleting threads, projects, or environments is deliberately not implemented.
- `bb project show proj_personal` answers 404: the personal project is not a
  row in the projects table. Its threads still list via
  `bb thread list --project proj_personal`.
- A machine credential cannot manage bb hosts — the connect gate rejects host
  mutations regardless of what the API allows locally.
- Recursion works: `bb thread tell <own-thread-id> "…"` prompts the very thread
  driving SLICC. Use `--mode queue` there, otherwise the message interrupts the
  turn that sent it.
