# BlueBubbles CLI reference

Full command and flag surface of `bluebubbles` (`scripts/bluebubbles.jsh`).
The Quick start lives in `SKILL.md`; endpoint map in `references/endpoints.md`.

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
| `watches` / `watch-list` | List local watch state (`~/.bluebubbles-watches/`) |
| `unwatch [id\|all]` | Delete SLICC + BB webhooks and state |

Every command accepts `--json`.

## Flags

| Flag | Applies to | Meaning |
| --- | --- | --- |
| `--json` | all | Raw JSON instead of the formatted view |
| `--limit N` | list/search | Max rows (default varies by command) |
| `--url <url>` | all | Override server URL |
| `--local` | all | Prefer `urlLocal` from config (LAN) |
| `--password-file P` | all | Read password from file (single line) |
| `--direct` / `--group` | `chats` | Only 1:1 or only group threads |
| `--search Q` | `chats` | Filter by participant / display name |
| `--in <scope>` | `search` | `messages` (default), `chats`, `contacts` |
| `--confirm` | `send` | Required for group (`any;+;…`) targets |
| `--scoop <name>` | `watch` | Target scoop for the licks; `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` |
| `--chat <guid>` | `watch` | Only events for this chatGuid |
| `--events <list>` | `watch` | BB event names (default: `new-message`) |
| `--force` | `watch` | Replace an existing watch with the same id |
| `--name <name>` | `watch` | SLICC webhook display name |
| `--id <watchId>` | `unwatch` | Alternative to the positional target |

## Config

- Env: `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`, `BLUEBUBBLES_PASSWORD_FILE`, `BLUEBUBBLES_CONFIG`
- File: `~/.bluebubbles.json` (also `/home/lars/.bluebubbles.json`) — `{ "url", "urlLocal", "passwordFile" }`
- Watch state: `~/.bluebubbles-watches/*.json` — webhook ids only, never the password
- The password is never echoed or written by this CLI; every error string is
  redacted by `safeErrorText()` first.
