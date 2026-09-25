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
  `bb pair`/`bb unpair` for credential setup. Also lists every thread with
  `bb thread list --all` (paged by offset) and calls any plugin RPC with
  `bb rpc <plugin> <method>`, such as the github plugin's issue/PR-to-thread
  links or the pull request of a thread's worktree.
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
`/api/v1` behind a **connect machine credential**.

### The short way: `bb attach`

If the human is already signed in to the bb server in this browser, no code
needs to change hands at all:

```bash
bb attach --server https://<handle>.getbb.app
```

`attach` mints a machine code **in the page** and redeems it in the same step.
It works because `createMachineCode` is served on the bb server's public origin
as well as over loopback, and there the owner's session cookie authorises it —
and every bb request already runs inside a tab parked on that origin. So the
credential is obtained without a shell on the machine that owns the server,
which is the case SLICC is normally in.

Sign in to the bb server in the browser first. If the tab is signed out, bb
declines to mint and `attach` says so instead of failing obscurely.

### The manual way: `bb pair --code`

Needed when nobody is signed in to that origin in this browser — for example a
headless runtime. The owner mints a one-time machine code on the bb server
itself:

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
bb attach [--server <url>]              Pair with no code, via your signed-in bb tab
bb pair --code <c> [--server <url>]     Redeem a connect machine code
bb unpair                               Forget the stored credential and server
bb self [<thread-id>]                   Show or set the default thread for --self

bb host list [--json]                   Enrolled hosts, with connection status

bb project list [--json]
bb project show <id> [--json]

bb thread list [--project <id>] [--parent-thread <id>] [--archived]
               [--include-hidden] [--limit <n>] [--offset <n>] [--all] [--json]
bb thread show [<id>] [--self] [--json]
bb thread log [<id>] [--self] [--limit <n>] [--after-seq <n>] [--json]
bb thread output [<id>] [--self] [--json]
bb thread tell <id> <message…> [--self] [--mode steer|queue|auto]
               [--model <m>] [--reasoning-level <l>] [--permission-mode <m>] [--json]
bb thread spawn --project <id> [--prompt <p>] [--provider <id>] [--model <m>]
               [--title <t>] [--environment <id>] [--new-environment worktree]
               [--host <name-or-id>] [--base-branch <b>] [--parent-thread <id>]
               [--visibility visible|hidden] [--json]
bb thread stop [<id>] [--self] [--json]
bb thread wait <id> [--status <status>] [--timeout <seconds>]
               [--poll-interval <ms>] [--json]
bb thread search <query> [--limit <n>] [--json]
bb thread queue list [<id>] [--self] [--json]

bb rpc <plugin> <method> [<json> | -] [--json]   Call a plugin RPC
```

Every command takes `--json` and prints the raw API response. `--self` targets
the thread stored by `bb self <id>` (or `BB_THREAD_ID` when the runtime sets it).

## Paging thread lists

`GET /api/v1/threads` returns rows and never a total, so `bb thread list` shows
one page: `--limit` rows (default 20) starting at `--offset` (default 0). The
limit goes to the server as given; there is no client-side ceiling.

- A page that comes back full may not be the end. `thread list` then prints a
  note on stderr naming the next `--offset` and `--all`; stdout, and so `--json`,
  is unchanged.
- `--all` reads 200-row pages until a short page and prints every thread,
  `--json` included (one merged array). Filters apply to every page, and
  `--offset` sets where it starts. `--all` with `--limit` is refused.
- The list is ordered live. A thread created while you page pushes rows down, so
  one can come back on two pages; `--all` keeps the first copy of each id.
  Paging is not a snapshot: a thread created mid-run at a position already read
  is missed, and one archived mid-run can shift another past the reader.

```bash
bb thread list --project <project-id> --all --json
bb thread list --limit 50 --offset 100
```

## Plugin RPCs

bb plugins expose RPC methods at `POST /api/v1/plugins/<plugin>/rpc/<method>`
with a JSON body (the method's input, `null` when it takes none). `bb rpc` calls
one through the same authenticated request path as every other command:

- The body is the `<json>` argument, stdin with `-`, or `null` when omitted.
- It prints the `result`; `--json` prints the raw `{"ok":true,"result":…}` envelope.
- Plugin and method names must match `^[a-z0-9][a-z0-9-]*$` and
  `^[A-Za-z_][A-Za-z0-9_]*$` (64 characters at most), so a name cannot add path
  segments or a query string.

Examples, from the github plugin:

```bash
# issue/PR-to-thread links: {"links":{"pr:<owner>/<repo>#<n>":[{"threadId":…}]}}
bb rpc github listLinks

# the pull request of a thread's worktree environment: {"pull":{"repo":…,"number":…,"environmentId":…}}
# pull is null when none resolves, which is the usual answer for an archived thread
bb rpc github pullForThread '{"threadId":"<thread-id>"}'
echo '{"threadId":"<thread-id>"}' | bb rpc github pullForThread -
```

RPCs are not all read-only: github's `createIssue`, `commentPull` and
`startWork` write to GitHub or start agent work. Confirm before calling one that
mutates.

`bb rpc connect createMachineCode` is refused. Its result is a one-time pairing
code that anyone can redeem for a durable machine credential, so printing it
would leak a secret into the transcript. `bb attach` mints and redeems one
without showing it.

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
  mutations regardless of what the API allows locally. Listing them with
  `bb host list` is read-only and does work.
- `--new-environment worktree` builds the worktree **on a host**, so it needs one.
  `--host` takes a **name or an id** (an exact id wins, then a case-insensitive
  name), matching the upstream bb CLI's own `--host <name-or-id>` resolution.
  With `--host` omitted:
  - exactly one enrolled host → used automatically, if it is connected;
  - that one host disconnected → refused, since it cannot build a worktree;
  - several enrolled → listed with their connection status so you can choose.

  Ambiguity is judged on the **enrolled** set, never on which hosts happen to be
  online: narrowing to connected hosts first would silently run the agent on a
  fallback machine whenever the intended host was briefly offline. An explicit
  `--host` is taken at its word and is not connectivity-checked, so it doubles as
  the override when the automatic path refuses.
- A managed worktree keeps the agent out of the user's real checkout: it works in
  `~/.bb/worktrees/<env-id>/<repo>` instead of the project source path.
- Recursion works: `bb thread tell <own-thread-id> "…"` prompts the very thread
  driving SLICC. Use `--mode queue` there, otherwise the message interrupts the
  turn that sent it.
