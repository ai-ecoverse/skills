# BlueBubbles REST map

Base: `{url}/api/v1`. Auth: query param `password` on every request (not Bearer).
Envelope: `{ "status": 200, "message": "…", "data": … }`. Verified against server **1.9.9**.

## Health / server

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/ping` | `data: "pong"` |
| GET | `/server/info` | `server_version`, `os_version`, `private_api`, `helper_connected`, `detected_icloud`, `detected_imessage` |
| GET | `/server/statistics/totals` | `{ handles, messages, chats, attachments }` |
| GET | `/server/statistics/media` | media counters |

## Chats

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/chat/query` | `{ limit, offset, with, sort }` | `with: ["lastMessage","participants"]`; `sort: "lastmessage"` works |
| GET | `/chat/:guid/message` | — | GUID must be URL-encoded; some proxies return non-JSON — prefer `message/query` |

Chat object highlights: `guid`, `displayName`, `style`, `participants[].address`, `lastMessage`.

GUID shapes:

- `any;-;<address>` — existing 1:1
- `any;+;<id>` — group
- `iMessage;-;<address>` — send target (service-qualified)

## Messages

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/message/query` | `{ limit, offset, chatGuid?, with, sort, where? }` | Primary read API. `with: ["handle","chats","attachment"]`. `sort: "DESC"`. |
| POST | `/message/text` | `{ chatGuid, message, tempGuid }` | Send. CLI fires once, detaches after ~25s, verifies via `message/query` on `urlLocal` first. Use `iMessage;-;` not `any;-;` on the wire. 5xx/timeout = soft. |
| GET | `/message/count` | — | `{ total }` |

Message highlights: `text`, `isFromMe`, `dateCreated` (ms epoch), `handle.address`, `chats[].guid`, `guid`, attachments.

`where` (TypeORM-style) exists but is **unreliable** on some 1.9.x builds (returns unrelated rows). The CLI searches by scanning recent pages client-side.

## Contacts / handles

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/contact` | — | Full address book array (`displayName`, `phoneNumbers[]`, `emails[]`, …) |
| POST | `/contact/query` | `{ limit, … }` | Alternate; may return same full set |
| POST | `/handle/query` | `{ limit, offset }` | **`offset` required** (numeric) — omitting it → 500 `"Provided skip value is not a number"` on 1.9.9 |

## Errors

| Status | Meaning |
| --- | --- |
| 401 | Bad/missing password |
| 400 | Send/validation rejected — message not sent |
| 500 on send | Common with `private_api:false` **after** the iMessage left — soft; verify thread, do not resend |
| 500 on query | Often bad query shape (see handle `offset`); degrade gracefully |
| timeout on send | Not decisive — re-query recent outbound messages; CLI reports `timeout_unverified` |

## CLI coverage

| CLI | Endpoints |
| --- | --- |
| `status` / `ping` | `server/info`, `server/statistics/totals`, `ping` |
| `chats` / `inbox` | `chat/query` |
| `messages` | `message/query` (+ chat resolve via `chat/query`) |
| `send` | `message/text` |
| `search` | `message/query` pages / `chat/query` / `contact` |
| `contacts` | `contact` (fallback `contact/query`) |
| `handles` | `handle/query` with `offset: 0` |
| `watch` / `unwatch` / `watches` | SLICC `webhook` + BB `/webhook` |
