---
name: signal
description: >
  Interact with Signal Desktop (Electron) via CDP/DOM automation — list
  conversations, search chats, open a chat, read recent messages, and send
  messages with an explicit --yes gate. Use when the user wants to check
  Signal messages, read a Signal chat, list Signal conversations, search
  Signal contacts/groups, draft or send a Signal message, or automate Signal
  Desktop without clicking the UI. Activate on mentions of Signal, Signal
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

Register the CLI once per session:

```bash
touch /usr/bin/signal; hash -r
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
