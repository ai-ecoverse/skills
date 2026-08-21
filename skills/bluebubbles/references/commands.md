# BlueBubbles CLI reference

Full command and flag surface of `bluebubbles` (`scripts/bluebubbles.jsh`).
The Quick start lives in `SKILL.md`; endpoint map in `references/endpoints.md`.

## Commands

| Command | Purpose |
| --- | --- |
| `status` / `ping` | Server version, private_api/helper flags, message/chat counts |
| `chats` / `inbox` | Recent threads (`--limit`, `--search`, `--direct`, `--group`) |
| `messages <target>` | History for a chatGuid or address (`--limit`) |
| `send <target> <text>` | Fire-once send; group guids need `--confirm`. 5xx/timeout = soft (verify thread). Identical text ≤5 min refused unless `--force` |
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
| `--force` | `send` | Bypass the 5-minute identical-text duplicate guard |
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

## Failure semantics worth relying on

**`send` is fire-once, then check.** One `POST /message/text` as
`iMessage;-;<address>` (never `any;-;` on the wire — AppleScript rejects
service type `any`). jsh has no working timers/abort, so the CLI **detaches**
the POST after ~25s wall clock (macrotask yields via `MessageChannel`, never an
awaited same-host ping) and verifies delivery on a **companion** host — the
config `urlLocal` only when it is known to be the same server as the selected
`url` (ignored under `--url` / `BLUEBUBBLES_URL`). Each verify fetch is itself
bounded (~5s). Outcomes:

| `status` (also in `--json`) | Meaning | Resend? |
| --- | --- | --- |
| `delivered` | Outbound text visible in-thread | No |
| `accepted_unverified` | HTTP 2xx but not yet visible | Check `messages` first |
| `soft_5xx_unverified` | HTTP 5xx — common with `private_api:false` after the iMessage already left | Check `messages` first |
| `timeout_unverified` | Detached after deadline; message may still land | Check `messages` first |
| `duplicate` | Same outbound text already in-thread within 5 minutes; **no POST issued** | Only with `--force` or different text |

HTTP 400 is still a hard failure. Agents must **never** re-run `send` solely
because of 5xx, timeout, or a hung shell — that is how the 2026-08-21 Anni
quadruple-send happened.


**`messages <address>` when the server rejects the chat guid.** An address with no
existing thread resolves to a synthetic `iMessage;-;<address>` guid, which some
1.9.x builds refuse for `message/query`. The CLI then retries with a broad
recent-message scan and filters it client-side to the requested conversation.
That filter is unconditional: if nothing in the scan belongs to the address, the
result is **empty**, never the unfiltered list. Human output says
`No messages found for <address>` and points at
`bluebubbles chats --search=<address>`; `--json` returns
`{ chatGuid, messages: [], note }`. A non-empty `messages` array therefore only
ever contains messages from the requested thread.

**`watch --force` is create-then-retire.** The replacement pair is registered and
written to the state file *before* the superseded SLICC and BlueBubbles webhooks
are deleted, so a failure anywhere in the create path leaves the old watch
forwarding and still listed by `watches`. The trade is a brief window where both
pairs are live, in which one message can lick twice. Retired ids are reported as
`replaced:` in the human output and `state.replaced` in `--json`.

**A failed state write rolls the new webhooks back.** The two ids are only
discoverable through the state file, so if the write fails (unwritable home, full
disk) both freshly created webhooks are deleted before the error surfaces, and
the message names them. If a deletion also fails, the error lists the exact
cleanup commands (`webhook delete <id>`, `DELETE /api/v1/webhook/<id>`) instead of
silently leaking a forwarder. Errors pass through `safeErrorText()` like every
other message, so no password appears in any of these paths.
