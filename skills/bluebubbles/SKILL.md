---
name: bluebubbles
description: |
  Send and read iMessage/SMS via a BlueBubbles server REST API (password auth, not
  browser session). Use when the user wants to text someone, send an iMessage or SMS,
  check iPhone messages from the desktop, list conversations/inbox, read a thread,
  search message history, look up contacts or handles, or verify that a message was
  delivered. Triggers on BlueBubbles, iMessage, SMS, text message, chat guid,
  iMessage;-;, Messages.app, or "text <person>". Not Slack, not Signal, not Teams.
allowed-tools: bash
command: bluebubbles
script: scripts/bluebubbles.jsh
---

# BlueBubbles

CLI over a running [BlueBubbles](https://bluebubbles.app) server. All calls are
REST with `?password=` — credentials stay in env / a local config file; the CLI
never prints the password.

## Quick start

```bash
bluebubbles status                          # ping + server info + db totals
bluebubbles chats --limit 20               # recent conversations (inbox)
bluebubbles chats --direct --search=+49    # 1:1 only, filter participants
bluebubbles messages any;-;+15551234567    # recent messages in a chat
bluebubbles messages user@example.com      # resolve address → chat
bluebubbles send +15551234567 "Hello!"     # send iMessage/SMS
bluebubbles search "dinner" --limit 10     # scan recent message text
bluebubbles search "mila" --in chats       # find threads by participant
bluebubbles contacts "Gunnar"              # address book filter
bluebubbles handles --limit 20             # known handles (degrades if API 500s)

# Real-time watch (BB webhook → SLICC webhook → scoop)
bluebubbles watch --scoop=imsg-inbox
bluebubbles watch --scoop=tenant-dm --chat='any;-;+49160…'
bluebubbles watches
bluebubbles unwatch all

bluebubbles status --json                  # machine-readable
bluebubbles chats --local                  # prefer config urlLocal (LAN)
```

## Config / auth

Resolution order:

| What | Order |
| --- | --- |
| **URL** | `--url` → `BLUEBUBBLES_URL` → `--local` ? `urlLocal` : `url` in config → `urlLocal` → `http://localhost:1234` |
| **Password** | `BLUEBUBBLES_PASSWORD` → `--password-file` / `BLUEBUBBLES_PASSWORD_FILE` → `passwordFile` from config |
| **Config file** | `BLUEBUBBLES_CONFIG` → `~/.bluebubbles.json` → `/home/lars/.bluebubbles.json` |

Example `~/.bluebubbles.json` (no secrets inline):

```json
{
  "url": "https://<tunnel>.trycloudflare.com",
  "urlLocal": "http://localhost:4321",
  "passwordFile": "/home/lars/.bluebubbles-password"
}
```

Password file is a single line. **Do not** commit it, paste it into chat logs, or
put it in this skill.

## Commands

| Command | Purpose |
| --- | --- |
| `status` / `ping` | Server version, private_api/helper flags, message/chat counts |
| `chats` / `inbox` | Recent threads (`--limit`, `--search`, `--direct`, `--group`) |
| `messages <target>` | History for a chatGuid or address (`--limit`) |
| `send <target> <text>` | Send; group guids need `--confirm`. Timeouts ≠ failure — re-check with `messages` |
| `search <query>` | `--in messages` (default, scans recent), `chats`, or `contacts` |
| `contacts [query]` | macOS address book entries exposed by the server |
| `handles [query]` | Handle/query; some builds 500 without `offset` — CLI sends it and degrades gracefully |
| `watch --scoop=…` | Register BB `POST /webhook` → SLICC webhook → scoop. Optional `--chat=<guid>`, `--events=…`, `--force` |
| `watches` | List local watch state (`~/.bluebubbles-watches/`) |
| `unwatch [id\|all]` | Delete SLICC + BB webhooks and state |

Every command accepts `--json`.

### Watch architecture

```
BlueBubbles (new-message, …)
  → POST to SLICC webhook URL
  → optional --filter (chatGuid substring)
  → lick on target scoop
```

- Kill-switch: `bluebubbles unwatch …` (or `webhook delete <sliccId>`).
- State files hold webhook IDs only — never the server password.
- Scoop name must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}---
name: bluebubbles
description: |
  Send and read iMessage/SMS via a BlueBubbles server REST API (password auth, not
  browser session). Use when the user wants to text someone, send an iMessage or SMS,
  check iPhone messages from the desktop, list conversations/inbox, read a thread,
  search message history, look up contacts or handles, or verify that a message was
  delivered. Triggers on BlueBubbles, iMessage, SMS, text message, chat guid,
  iMessage;-;, Messages.app, or "text <person>". Not Slack, not Signal, not Teams.
allowed-tools: bash
command: bluebubbles
script: scripts/bluebubbles.jsh
---

# BlueBubbles

CLI over a running [BlueBubbles](https://bluebubbles.app) server. All calls are
REST with `?password=` — credentials stay in env / a local config file; the CLI
never prints the password.

## Quick start

```bash
bluebubbles status                          # ping + server info + db totals
bluebubbles chats --limit 20               # recent conversations (inbox)
bluebubbles chats --direct --search=+49    # 1:1 only, filter participants
bluebubbles messages any;-;+15551234567    # recent messages in a chat
bluebubbles messages user@example.com      # resolve address → chat
bluebubbles send +15551234567 "Hello!"     # send iMessage/SMS
bluebubbles search "dinner" --limit 10     # scan recent message text
bluebubbles search "mila" --in chats       # find threads by participant
bluebubbles contacts "Gunnar"              # address book filter
bluebubbles handles --limit 20             # known handles (degrades if API 500s)

# Real-time watch (BB webhook → SLICC webhook → scoop)
bluebubbles watch --scoop=imsg-inbox
bluebubbles watch --scoop=tenant-dm --chat='any;-;+49160…'
bluebubbles watches
bluebubbles unwatch all

bluebubbles status --json                  # machine-readable
bluebubbles chats --local                  # prefer config urlLocal (LAN)
```

## Config / auth

Resolution order:

| What | Order |
| --- | --- |
| **URL** | `--url` → `BLUEBUBBLES_URL` → `--local` ? `urlLocal` : `url` in config → `urlLocal` → `http://localhost:1234` |
| **Password** | `BLUEBUBBLES_PASSWORD` → `--password-file` / `BLUEBUBBLES_PASSWORD_FILE` → `passwordFile` from config |
| **Config file** | `BLUEBUBBLES_CONFIG` → `~/.bluebubbles.json` → `/home/lars/.bluebubbles.json` |

Example `~/.bluebubbles.json` (no secrets inline):

```json
{
  "url": "https://<tunnel>.trycloudflare.com",
  "urlLocal": "http://localhost:4321",
  "passwordFile": "/home/lars/.bluebubbles-password"
}
```

Password file is a single line. **Do not** commit it, paste it into chat logs, or
put it in this skill.

## Commands

| Command | Purpose |
| --- | --- |
| `status` / `ping` | Server version, private_api/helper flags, message/chat counts |
| `chats` / `inbox` | Recent threads (`--limit`, `--search`, `--direct`, `--group`) |
| `messages <target>` | History for a chatGuid or address (`--limit`) |
| `send <target> <text>` | Send; group guids need `--confirm`. Timeouts ≠ failure — re-check with `messages` |
| `search <query>` | `--in messages` (default, scans recent), `chats`, or `contacts` |
| `contacts [query]` | macOS address book entries exposed by the server |
.

## Chat GUIDs

| Prefix | Meaning |
| --- | --- |
| `iMessage;-;+…` / `iMessage;-;user@…` | Direct send target (creates thread if needed) |
| `any;-;…` | Existing 1:1 chat from `chats` — prefer for `messages` |
| `any;+;…` | Group chat — do **not** use for personal DMs; `send` requires `--confirm` |

Prefer guids returned by `chats` / `messages` over hand-built ones when reading history.

## Agent notes

- Prefer `bluebubbles …` over raw `curl`. Never echo the password; prefer `--json` when chaining.
- After `send`, a short HTTP timeout is normal (server waits on delivery). Run `messages` on the same target to verify.
- `private_api: false` / helper disconnected still allows send/read of normal texts; advanced features may be missing.
- Message text search is a recent-history scan (server-side `WHERE` is flaky on some 1.9.x builds). Narrow with `--in chats` or open a specific thread via `messages`.
- Endpoint map: `references/endpoints.md`.

## Examples

```bash
# Inbox snapshot for the agent
bluebubbles chats --limit 15 --json

# Read a thread then reply
bluebubbles messages any;-;friend@example.com --limit 10
bluebubbles send friend@example.com "On my way"

# Find someone, then text the number from contacts
bluebubbles contacts "Ada" --json
bluebubbles send +1555… "Hi!"
```
