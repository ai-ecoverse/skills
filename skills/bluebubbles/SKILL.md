---
name: bluebubbles
description: |
  Send and read iMessage/SMS via a BlueBubbles server REST API (password auth, not
  browser session). Use when the user wants to text someone, send an iMessage or SMS,
  check iPhone messages from the desktop, list conversations/inbox, read a thread,
  search message history, look up contacts or handles, or verify that a message was
  delivered. On SLICC 7, `bluebubbles login <url>` seals the password in the
  vault, grants it to this CLI only and pins the server in a root-owned file.
  Triggers on BlueBubbles, iMessage,
  SMS, text message, chat guid, iMessage;-;, Messages.app, fnox, or "text <person>".
  Not Slack, not Signal, not Teams.
allowed-tools: bash
command: bluebubbles
script: scripts/bluebubbles
---

# BlueBubbles

CLI over a running [BlueBubbles](https://bluebubbles.app) server. All calls are
REST with `?password=` — credentials stay in env / a local config file; the CLI
never prints the password. Every error string is pushed through a single
redactor (`safeErrorText`) before it reaches the terminal, so `password=…`,
a `"password"` field in a server JSON body and the literal secret are masked as
`***` even when the HTTP layer embeds the full request URL in its own message.

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
| **URL, pinned** | `/etc/bluebubbles/config.json` (root-owned, written by `login`): `--local` ? `urlLocal` : `url`. Nothing else is read. |
| **URL, not pinned** | `BLUEBUBBLES_URL` → `--local` ? `urlLocal` : `url` in config → `urlLocal` → `http://localhost:1234` |
| **Password, pinned** | usable `BLUEBUBBLES_PASSWORD` → `--password-file` / `BLUEBUBBLES_PASSWORD_FILE` → one `fnox exec --only BLUEBUBBLES_PASSWORD` retry |
| **Password, not pinned** | `--password-file` / `BLUEBUBBLES_PASSWORD_FILE` → `passwordFile` from config. `BLUEBUBBLES_PASSWORD` is not used. |
| **Config file** | `BLUEBUBBLES_CONFIG` → `~/.bluebubbles.json` → `/home/lars/.bluebubbles.json` (not pinned only) |

There is no `--url` flag.

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

### SLICC 7 / fnox: `bluebubbles login`

```bash
bluebubbles login https://bb.example.com            # one-time setup
bluebubbles login https://bb.example.com --url-local http://10.0.0.2:1234
bluebubbles login https://bb.example.com --dry-run  # show what it would write
```

The server only accepts the password as `?password=`, and seven never fills a
secret into a URL, so the vault hands the real value to this CLI as an
environment variable instead. `login`:

1. asks for the password in the vault dialog (`sealed ask BLUEBUBBLES_PASSWORD`;
   it keeps an existing one unless `--replace`);
2. writes, each with `sudo install` (one approval per file):
   - `/etc/bluebubbles/config.json`, the pinned server: `{ "url", "urlLocal"? }`;
   - the `[secrets.BLUEBUBBLES_PASSWORD]` placeholder in `/etc/fnox/config.toml`;
   - the grant in `/etc/slicc/secrets-policy.toml`, to the installed script alone:
     `BLUEBUBBLES_PASSWORD = { argv = [["/usr/share/skills/bluebubbles/scripts/bluebubbles"]] }`;
3. runs `bluebubbles status` to check.

The script must be root-owned and not writable by others (`sudo install -m 755`),
or the grant does not match and `login` refuses. With the pin present, the
password is only ever sent to the pinned server: `BLUEBUBBLES_URL`,
`BLUEBUBBLES_CONFIG` and `~/.bluebubbles.json` are ignored, and a pin that is
not root-only is refused. Without the pin, `BLUEBUBBLES_PASSWORD` is not used at
all. Never grant it with `{ shell = true }`: that hands the password to every
command the agent runs. A password file still works when there is no vault.

## Commands

`status`/`ping`, `chats`/`inbox`, `messages`, `send`, `search`, `contacts`,
`handles`, `watch`, `watches`, `unwatch` — every command accepts `--json`.
`login` sets up the vault password and the pinned server (above).
Full subcommand/flag reference and per-command caveats: `references/commands.md`.

### Watch architecture

```
BlueBubbles (new-message, …)
  → POST to SLICC webhook URL
  → optional --filter (chatGuid substring)
  → lick on target scoop
```

- Kill-switch: `bluebubbles unwatch …` (or `webhook delete <sliccId>`).
- State files hold webhook IDs only — never the server password.
- Scoop name must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` — letters, digits, `_`
  and `-`, first char alphanumeric, 64 chars max. An invalid name is rejected
  before any webhook is created.
- Checkpoint: confirm the watch registered. `watch` echoes `scoop`, `events`,
  `chat`, `slicc wh:` (SLICC webhook id), `bb wh:` (BlueBubbles webhook id) and
  the state file path. Then run `bluebubbles watches`: the watch must be listed
  under "Active BlueBubbles watches (n)" as `<watchId>  ->  scoop <name>` with
  non-empty `bb:` and `slicc:` ids. If the list prints "None." nothing was
  registered — re-run `watch` (add `--force` to replace a stale watch with the
  same id). `bluebubbles watches --json` returns the same state for scripting.

## Chat GUIDs

| Prefix | Meaning |
| --- | --- |
| `iMessage;-;+…` / `iMessage;-;user@…` | Direct send target (creates thread if needed) |
| `any;-;…` | Existing 1:1 chat from `chats` — prefer for `messages` |
| `any;+;…` | Group chat — do **not** use for personal DMs; `send` requires `--confirm` |

Prefer guids returned by `chats` / `messages` over hand-built ones when reading history.

## Agent notes

- Prefer `bluebubbles …` over raw `curl`. Never echo the password; prefer `--json` when chaining.
- Do not put `BLUEBUBBLES_PASSWORD` in the request URL yourself. On SLICC 7 that value is a placeholder until the vault's grant for this CLI materializes it, and the kernel refuses the placeholder in a URL.
- **`send` is fire-once, then check.** One POST, detached after ~25s wall clock (jsh has no working `setTimeout`/`AbortController`; an awaited hang would pin the HTTP/1 connection). `private_api: false` often returns **HTTP 5xx after the iMessage already left the Mac**, or never returns at all — both are soft. The CLI verifies the thread (companion `urlLocal` only when it matches the selected server, so verify is not starved by the in-flight POST; each verify fetch is bounded) and prints `delivered` / `soft_5xx_unverified` / `timeout_unverified` / `duplicate`.
- **Send GUID:** wire as `iMessage;-;<address>`. The real thread guid `any;-;<address>` breaks Messages.app AppleScript (`Can't make any into type constant`).
- **Never re-run `send` because of 5xx, timeout, or a hung shell.** Read the thread first: `bluebubbles messages <target> --limit 5`. Identical text inside 5 minutes is refused unless `--force`.
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
