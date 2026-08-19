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

signal watch <name|id> --scoop=<name> [--every=<seconds>] [--force]
signal watches [--json]
signal unwatch <watch-id|all>
signal reinject                      # after a leader reload
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


### watch / watches / unwatch / reinject

Notify a scoop when a Signal chat changes — **and only when it changes**.

```bash
signal watch "Eclipse Chasers" --scoop=signal-inbox
signal watch "Eclipse Chasers" --scoop=signal-inbox --every=10 --force
signal watches
signal unwatch eclipse-chasers      # or: signal unwatch all
signal reinject                     # after the leader tab reloaded
```

**Options**

- `--scoop=<name>` — **(required)** scoop that receives the lick
- `--every=<seconds>` — check interval, default `20`, floor `5`
- `--force` — replace an existing watch on the same chat

**How it works**

Signal offers nothing to subscribe to: the socket is end-to-end encrypted, and
Redux / `ConversationController` / sqlcipher are not on `window`. New messages
are legible only in the rendered DOM, so something has to look. The design
question is what pays for the looking.

The detector runs in the **leader tab**, not in a scoop and not on a cron:

```
setInterval in the leader page (every --every seconds)
  └─ browser.withTab(signalTab, () => evaluate(FINGERPRINT))   ← one DOM query
     ├─ unchanged → return. Nothing is dispatched. No scoop wakes.
     └─ changed   → POST the scoop's webhook → one lick
```

An idle chat therefore costs a DOM read per interval and **zero** agent turns.
This is the whole point of the command: a `crontask` that licks a scoop every
N minutes would wake an LLM turn just to conclude "nothing happened".

Two constraints shaped this and are worth knowing before changing it:

- **The loop cannot live inside Signal.** Signal's renderer blocks all egress
  (`net::ERR_ACCESS_DENIED` — the same block that forces the CDP-over-CDP
  follower), so an interval there can detect a change but never deliver it.
  Verified: `fetch()` from the Signal page fails; the same call from the leader
  page returns 200.
- **A cron `--filter` cannot do the check.** `LickManager.runDueCronTask` calls
  the filter synchronously (`filterFn(null)`, not awaited), so it cannot await a
  DOM read. A filter returning a Promise silently becomes the payload.

`withTab` is used rather than a bare `attachToPage` because BrowserAPI
attachment is process-wide; `withTab` serializes on its lock so a tick cannot
steal the tab from a human or an agent mid-operation.

**Lick payload**

```json
{
  "source": "signal-watch",
  "watchId": "eclipse-chasers",
  "chat": "Eclipse Chasers",
  "messageCount": 87,
  "at": "2026-08-11T19:44:03.117Z",
  "hint": "New activity in Signal chat \"Eclipse Chasers\". Run: signal read \"Eclipse Chasers\""
}
```

The payload carries **metadata only** — a `messageCount` and the chat name, never
message bodies (nor the internal change fingerprint). The detector fingerprints
locally on message count + last author + absolute timestamp to decide *whether*
to fire; that fingerprint never leaves the leader page. A woken scoop calls
`signal read` if it wants content, so message text is never pushed into a lick.

**Durability.** The interval is page state, so a leader reload drops every
watcher. `signal watches` reports those as `DEAD (signal reinject)`; run
`signal reinject` to re-install them (it also re-resolves the Signal tab id,
which changes when Signal restarts). Same trade-off `slack reinject` exists for.

**Fingerprint.** Message count plus the last message's author, timestamp and
first 80 characters. Signal exposes no message id in the DOM and renders
relative timestamps ("42m") that drift between reads, so the text is part of
the key — a time-only key would re-fire on its own.

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
