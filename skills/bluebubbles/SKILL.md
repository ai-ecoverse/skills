---
name: bluebubbles
description: Sends and receives iMessages via the BlueBubbles REST API. Use when the user wants to send a text message, iMessage, or SMS, read or search message history, find contacts, list conversations, or interact with their iPhone messages from the desktop. Capabilities include sending direct messages and group chats, querying message history, finding contacts by name, searching existing chat threads, distinguishing direct vs group conversations, and verifying message delivery. Requires a running BlueBubbles server.
allowed-tools: bash
---

# BlueBubbles iMessage API

## First Time Setup

Before using this skill, you need the BlueBubbles server URL and password.

**Ask the user:**

1. "What is your BlueBubbles server URL?" (default: `http://localhost:1234`)
2. "What is your BlueBubbles password?"

**Store in memory** using `update_global_memory`:

```
bluebubbles_url: http://localhost:1234
bluebubbles_password: <user's password>
```

**Test the connection** (substitute `SERVER_URL` with the stored `bluebubbles_url` and `PASSWORD` with the stored `bluebubbles_password`):

```bash
curl -s "SERVER_URL/api/v1/server/info?password=PASSWORD" | jq '.status'
```

Returns `200` if the connection works.

## Authentication

All endpoints require `?password=PASSWORD` as a query parameter. Throughout this skill, `SERVER_URL` is the value of `bluebubbles_url` and `PASSWORD` is the value of `bluebubbles_password` from memory — substitute them in every curl command.

## IMPORTANT: Use POST /query endpoints

Most endpoints use POST with `/query` suffix. GET endpoints may return 404.

## Chat GUID Format

| Prefix | Meaning |
| --- | --- |
| `iMessage;-;` | Direct message — **use this to SEND** to a phone/email |
| `any;-;` | Existing 1:1 chat (returned by chat queries) |
| `any;+;` | **Group chat** — do NOT use for personal messages |

- Phone: `iMessage;-;+1234567890` (include country code)
- Email: `iMessage;-;user@example.com`

## Send a Message

**Use `--max-time 5`** — the API waits for delivery confirmation (can take 30+ seconds). A timeout does NOT mean failure; verify delivery afterward (see Verify section).

```bash
curl -s --max-time 5 -X POST "SERVER_URL/api/v1/message/text?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "chatGuid": "iMessage;-;+1234567890",
    "message": "Hello from slicc!",
    "tempGuid": "temp-123456"
  }' || echo '{"note": "Request timed out - message may still be sending"}'
```

**Required Parameters:**

- `chatGuid`: Chat identifier (see Chat GUID Format above)
- `message`: Text content to send
- `tempGuid`: A unique temporary ID — use `temp-$(date +%s)`

## Find a Contact by Name

```bash
curl -s "SERVER_URL/api/v1/contact?password=PASSWORD" \
  | jq '.data[] | select(.displayName != null) | select(.displayName | test("Name"; "i")) | {displayName, phoneNumbers, emails}'
```

## Find and Filter Chats with a Contact

Query all chats, then filter by address and participant count:

```bash
# All chats involving an address
curl -s -X POST "SERVER_URL/api/v1/chat/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 200}' | jq '.data[] | select(.participants[] | .address == "user@example.com") | {guid, participantCount: (.participants | length), participants: [.participants[] | .address]}'
```

**Filter to direct chats only** (1 participant) before sending a personal message:

```bash
curl -s -X POST "SERVER_URL/api/v1/chat/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 200}' | jq '.data[] | select(.participants | length == 1) | select(.participants[0].address == "user@example.com") | {guid, participant: .participants[0].address}'
```

- `participantCount == 1` → direct chat (safe to use)
- `participantCount > 1` → group chat — do NOT use for personal messages
- If no direct chat exists, send with `iMessage;-;address` format to create one.

## Get Recent Messages

```bash
curl -s -X POST "SERVER_URL/api/v1/message/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}' | jq '.data[] | {text, isFromMe, dateCreated, from: .handle.address}'
```

## Get Messages from a Specific Chat

For message queries, pass the exact `guid` string returned by `/chat/query` (the `.data[].guid` field). Do not hand-construct a GUID here — look it up first via the chat-filtering step above and copy the value verbatim.

```bash
curl -s -X POST "SERVER_URL/api/v1/message/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "chatGuid": "<guid from /chat/query>",
    "limit": 10
  }' | jq '.data[] | {text, isFromMe, dateCreated}'
```

## Verify Message Was Sent

After sending (even after a timeout), confirm the message appears in recent outbound messages:

```bash
curl -s -X POST "SERVER_URL/api/v1/message/query?password=PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{"limit": 5}' | jq '.data[] | select(.isFromMe == true) | {text, dateCreated}'
```

## Error Handling

- A 400 error means the message was NOT sent — check the error message
- A timeout is not an error — verify with the query above
- If you get connection errors, ask the user to verify the BlueBubbles server URL and password
