---
name: signal
description: >
  Interact with Signal Desktop (Electron) via CDP/DOM automation — list
  conversations, search chats, open a chat, read recent messages, and send
  messages with an explicit --yes gate, and watch a chat so a scoop is
  notified only when it actually changes. Use when the user wants to check
  Signal messages, read a Signal chat, list Signal conversations, search
  Signal contacts/groups, draft or send a Signal message, watch/monitor a
  Signal chat for new messages, or automate Signal Desktop without clicking
  the UI. Activate on mentions of Signal, Signal
  Desktop, Signal chat, Signal message, Signal group, or related messaging
  workflows. Requires a live Signal Desktop CDP tab on a tray remote (no
  public third-party HTTP API for personal Signal Desktop).
allowed-tools: bash
---

# Signal Desktop

Automate **Signal Desktop** (Electron) from SLICC. There is no public
third-party HTTP API for personal Signal Desktop. This skill drives the live
app tab over CDP using `playwright-cli` (DOM + accessibility tree).

Signal appears as a **tray remote** target:

```
[runtimeId:pageId] file:///Applications/Signal.app/Contents/Resources/app.asar/background.html "Signal (N)" [remote:runtimeId]
```

## Setup

The CLI **auto-registers**. SLICC discovers every `.jsh` under
`/workspace/skills/` as a command named after its basename, so
`scripts/signal.jsh` becomes the `signal` command as soon as the skill is in
place — no registration step.

> **Do _not_ `touch /usr/bin/signal`.** That creates an empty, non-executable
> file that _shadows_ the discovered command (`command not found`). If you did,
> `rm -f /usr/bin/signal`.

If `signal` is not found immediately after the skill is created (the command
catalog is cached and only refreshes when a skill file is written), touch the
script to force a re-scan, then run it in the next command:

```bash
touch /workspace/skills/signal/scripts/signal.jsh
signal tabs
```

Signal Desktop must be open on the host machine so the tray remote exposes its
CDP target. Confirm with:

```bash
signal tabs
# or
playwright-cli tab-list | rg -i 'signal|background\.html'
```

If the tab dies mid-session, re-run `signal tabs` — the composite
`runtimeId:pageId` changes across app restarts.

**Skill location:** shipped at `/shared/skills/signal/` (promote into
`/workspace/skills/signal/` when writable so every scoop discovers it).

## Safety

- Default is **read-only** (`tabs`, `chats`, `search`, `open`, `read`).
- `signal send` **refuses** unless `--yes` is passed.
- Prefer `--draft` to fill the composer without sending (validates the path).
- Never send messages to humans without explicit user intent.
- Do not dump full message history into scoop notifications — summarize.
- Do not change Signal account settings, link/unlink devices, or touch
  privacy controls.

## Commands

```bash
signal tabs | status                 # find live Signal CDP tab, print targetId
signal chats | list [--json] [--unread]
signal search <query> [--json]
signal open <name|id>
signal read [name|id] [--limit=N] [--json]
signal send <name|id> <text> --yes   # real send
signal send <name|id> <text> --draft # composer only

signal watch <name|id> --scoop=<name> [--every=<minutes>] [--force]
signal watches [--json]
signal unwatch <watch-id|all>
signal watch-poll [--json]           # one poll pass (run by the poller scoop)
signal reinject                      # re-ensure the poll crontask
signal help
```

### tabs / status

```bash
signal tabs
```

Prints composite target id, url, title, remote runtime id, and a liveness
probe (`document.title`).

### chats / list

```bash
signal chats
signal chats --unread
signal chats --json
```

Lists conversations currently rendered in the left pane (virtualized — typically
the most recent ~15–30). Columns: unread count, relative time, name, preview.

Each row exposes:

| Field | Source |
| --- | --- |
| `id` | `data-id` on the conversation button (UUID) |
| `serviceId` | `data-testid` (stable conversation service id / base64) |
| `name` | contact/group display name |
| `unread` | parsed from `aria-label` ("N new messages") |
| `time` | relative timestamp in the row |
| `preview` | last-message preview text |

### search

```bash
signal search "Book Club"
signal search alice --json
```

Client-side filter over the visible chat list (name, preview, ids). Does not
drive Signal's own search box yet.

### open

```bash
signal open "Weekend Hikers"
signal open 019a1b2c-3d4e-7f80-9abc-def012345678
```

Clicks the matching conversation row. Match order: exact `id` / `serviceId`,
exact name (case-insensitive), then unique substring. Ambiguous substring
matches error out with candidates.

### read

```bash
signal read "Weekend Hikers" --limit=20
signal read --limit=10            # currently open chat
signal read "Book Club" --json
```

Opens the chat if a name/id is given, then scrapes rendered timeline messages:

| Field | Meaning |
| --- | --- |
| `direction` | `in` / `out` |
| `author` | sender display name (or `You`) |
| `text` | message body (cleaned of bidi isolates) |
| `time` | ISO datetime when present on the bubble |
| `attachment` | true if an attachment container is present |

Only messages currently mounted in the virtualized timeline are returned
(recent history visible without scrolling up).

### send

```bash
# Dry-run — fills composer, does NOT press Enter
signal send "Weekend Hikers" "hello from slicc" --draft

# Real send — requires explicit gate
signal send "Weekend Hikers" "hello from slicc" --yes
```

Implementation:

1. Open the chat.
2. Focus the Quill composer (`.ql-editor`).
3. Clear any leftover draft.
4. Type via CDP `Input` (`playwright-cli type`) — DOM `execCommand` alone does
   not update React/Quill state.
5. On `--yes`, press `Enter` (Signal Desktop has no stable separate Send button;
   the mic/send control toggles and Enter is the reliable path).
6. Verify the composer cleared.

**Never omit `--yes` for a real send.** Agents must not pass `--yes` unless the
user explicitly asked to send that message.


### watch / watches / unwatch / watch-poll / reinject

Notify a scoop when a Signal chat changes — **and only when it changes** —
without attaching to the tray remote or switching the visible conversation.

```bash
signal watch "Eclipse Chasers" --scoop=signal-inbox            # poll every 2 min
signal watch "Eclipse Chasers" --scoop=signal-inbox --every=5  # minutes
signal watches
signal unwatch eclipse-chasers-<hash>   # id from `signal watches`; or: all
signal reinject                          # re-ensure the poll crontask
```

**Options**

- `--scoop=<name>` — **(required)** scoop that receives the lick on change
- `--every=<minutes>` — poll interval in minutes, default `2`, floor `1`
- `--force` — replace an existing watch on the same chat

**How it works — a CLI-bridge poller**

Signal offers nothing to subscribe to (E2E socket; Redux / sqlcipher off
`window`), so change must be polled from the DOM. This skill polls the
**left-pane chat list** through the reliable browser bridge — the same path
`signal chats` uses — which needs no CDP attach to the tray remote and never
switches the open conversation:

```
crontask "signal-watch-poll" (every --every min)
  └─ licks the poller scoop "signal-watch"
       └─ runs `signal watch-poll`   ← one `signal chats` read
            ├─ a watched chat's row unchanged → nothing
            └─ changed → curl POST that watch's webhook → one lick on its scoop
```

Cost: one cheap scoop tick per interval; the target scoop is woken only on
change. Reading the list (not the open timeline) means a watch observes its
chat regardless of which conversation is on screen, and a chat with new activity
surfaces to the top of the list.

An earlier design ran a `setInterval` in the leader tab that used
`browser.withTab` to read Signal directly. That is retired: the tray remote
permits a single page-level CDP session, so the leader's repeated attach
contended with any CLI `signal` call and wedged on `Runtime.enable`. The CLI
bridge (`signal chats`) has no such problem, at the cost of one scoop tick per
interval instead of zero.

**Setup (once).** A shell command cannot spawn a scoop, so a persistent scoop
named **`signal-watch`** must exist whose standing job is to run
`signal watch-poll` on each `signal-watch-poll` cron lick. Create it once; then
`signal watch` creates each per-watch webhook and the shared crontask
automatically. The poller scoop needs write access to `/.playwright` (browser
bridge) and `/shared` (watch state) — the latter is in a scoop's default
sandbox; grant `/.playwright` once.

**Identity & fingerprint.** Each watch is keyed by the conversation's stable id
(`data-id`) plus a slug, so distinct chats never collide. The change
fingerprint is the row's `unread` count + last-message preview: drift-free (no
relative timestamp), and the preview (message text) stays **local** in the state
file under `/shared/signal-watch/`. It is seeded on the first poll so the
existing backlog is never reported.

**Lick payload**

```json
{
  "source": "signal-watch",
  "watchId": "eclipse-chasers-1a2b3c",
  "chat": "Eclipse Chasers",
  "unread": 2,
  "at": "2026-08-20T07:31:07.667Z",
  "hint": "New activity in Signal chat \"Eclipse Chasers\". Run: signal read \"Eclipse Chasers\""
}
```

**Metadata only** — `unread` count and chat name, never message text and never
the local fingerprint. A woken scoop calls `signal read` if it wants content.
Delivery uses `curl` and commits state only on a confirmed 2xx, so a failed
webhook is retried on the next poll rather than silently dropped.

**Durability.** Watch state lives in files under `/shared/signal-watch/`, so it
survives reloads. `signal reinject` re-ensures the poll crontask exists for the
stored watches. `signal watch-poll` is the per-tick worker the poller scoop
invokes; you can also run it by hand to poll once.

## How the tab is found

```bash
playwright-cli tab-list | rg -i 'Signal\.app|background\.html|^.*Signal'
```

The CLI parses composite ids (`runtimeId:pageId`) and always passes
`--tab=<composite>` to `playwright-cli`. Remote CDP sometimes times out on
`Runtime.enable`; the CLI retries automatically.

Pass the tab explicitly when calling playwright by hand:

```bash
TAB=$(signal tabs 2>/dev/null | head -1)
playwright-cli eval --tab="$TAB" 'document.title'
```

## API surface (what we found)

| Approach | Result |
| --- | --- |
| `window.Signal` / `SignalContext` / `reduxStore` / `ConversationController` / `textsecure` / `Whisper` | **Not exposed** on the background page |
| React fiber keys on DOM nodes | **Not readable** from the CDP eval realm (property names stripped / isolated) |
| IndexedDB / Cache Storage from page | Empty at `file://` origin from this context |
| Network to `chat.signal.org` from page | Not required; UI scrape is sufficient for read paths |
| DOM conversation list | **Works** — `button.module-conversation-list__item--contact-or-conversation` with `data-id`, `data-testid`, rich `aria-label` |
| DOM timeline | **Works** — `.module-message` bubbles with author/text/time |
| Composer | **Works** — `.ql-editor` contenteditable; type via CDP, send via Enter |
| Accessibility snapshot | **Works** — full chat list + messages in a11y tree |

Conclusion: this skill is **UI-scraped + CDP input**, not an internal API client.
That is durable across Signal Desktop builds as long as class names /
`data-testid`s remain stable (they are part of Signal's own test surface).

## Limitations

1. **Virtualized lists** — only mounted rows/messages are visible. Older chats
   require scrolling the left pane in the real UI (or future scroll automation).
2. **No headless Signal** — the real desktop app must be running and linked.
3. **Remote CDP flakiness** — occasional `Runtime.enable` timeouts; CLI retries.
4. **Send is Enter-based** — multi-line messages need further work (Shift+Enter
   for newline, then Enter to send is not yet exposed as a flag).
5. **Attachments / voice / stickers** — read path flags attachments; sending
   attachments is not implemented.
6. **SLICC overlay** — Signal blocks embedded SLICC panels; drive from the
   leader window via this CLI.
7. **No sqlcipher / key access** — by design; we never touch the local DB.
8. **Watch costs one scoop tick per interval** — the CLI-bridge poller wakes
   its poller scoop every `--every` minutes to run one `signal chats` read.
   Cheap, but not the zero-turn idle cost of the retired leader interval; the
   trade is reliability (no tray-remote attach) for that tick.
9. **Watch change-detection is heuristic** — Signal exposes no message id in
   the DOM. The fingerprint is the chat's list row (unread + last-message
   preview), so two identical consecutive messages, or a change that does not
   alter the visible preview, can be missed; a chat scrolled out of the
   virtualized list is only re-observed once new activity surfaces it to the top.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No Signal Desktop tab found` | Open Signal.app on the tray host; `playwright-cli tab-list \| rg -i signal` |
| `Remote CDP request timed out` | Retry; the CLI already retries 5x. If persistent, focus/restart Signal |
| `Chat not found` | Name must match a **visible** left-pane row; try `signal chats` first |
| `Ambiguous match` | Use a longer substring or the `id` from `signal chats --json` |
| Composer did not accept text | CDP type failed; retry `signal send ... --draft` |
| Send may have failed | Composer still held text after Enter — check focus and retry with `--yes` |
| Wrong tab targeted | Always use composite id from `signal tabs`; never bare page id alone on remotes |

## Examples

```bash
# What's unread?
signal chats --unread

# Read a group chat
signal read "Book Club" --limit=15

# Draft a reply without sending
signal send "Weekend Hikers" "on my way, running late" --draft

# User explicitly asked to send:
signal send "Weekend Hikers" "on my way, running late" --yes
```
