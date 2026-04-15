# Slack Web API Endpoints

Base URL: `/api/` (same-origin XHR from `app.slack.com`)
Auth: `xoxc-*` token from `localStorage` key `localConfig_v2` → `.teams[<workspaceId>].token`
Transport: XHR with `Content-Type: application/x-www-form-urlencoded` and `withCredentials: true`

## Authentication

All requests include:
- `token` parameter in the POST body (URL-encoded)
- Browser cookies (automatic via `withCredentials: true`)

Token extraction (workspace ID determined dynamically):
```javascript
const cfg = JSON.parse(localStorage.getItem('localConfig_v2'));
const token = cfg.teams[workspaceId].token;  // xoxc-…
```

The workspace ID (team or enterprise ID, e.g. `E23RE8G4F`, `T06DUTYDQ`) is resolved
in this order:
1. `--workspace=<ID>` or `--ws=<ID>` flag if provided
2. Auto-detected from the active Slack tab URL: `https://app.slack.com/client/<ID>/...`

The `localConfig_v2.teams` object maps workspace IDs to `{ name, domain, url, token }`.
Keys are either enterprise IDs (`E...`) or team IDs (`T...`).

## Endpoints

### POST /api/conversations.history

Get messages from a channel.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel ID (e.g. `C087NCG774J`) |
| limit | no | Number of messages (default 100, max 1000) |
| cursor | no | Pagination cursor from `response_metadata.next_cursor` |
| oldest | no | Unix timestamp — only messages after this |
| latest | no | Unix timestamp — only messages before this |

**Response:**
```json
{
  "ok": true,
  "messages": [
    {
      "user": "W4SGK7ZL7",
      "type": "message",
      "ts": "1775686836.598519",
      "text": "Message text here",
      "thread_ts": "1775686836.598519",
      "reply_count": 1,
      "user_profile": {
        "real_name": "Name",
        "display_name": "handle"
      }
    }
  ],
  "has_more": true,
  "response_metadata": {
    "next_cursor": "bmV4dF90czox..."
  }
}
```

### POST /api/conversations.replies

Get thread replies.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel ID |
| ts | yes | Thread parent timestamp |
| limit | no | Number of replies (default 100) |
| cursor | no | Pagination cursor |

**Response:** Same structure as `conversations.history`. First message is the thread parent.

### POST /api/chat.postMessage

Post a message to a channel or DM.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel ID or DM ID |
| text | yes | Message text (supports mrkdwn) |
| thread_ts | no | Reply in thread |
| unfurl_links | no | Enable link unfurling (default true) |

**Response:**
```json
{
  "ok": true,
  "channel": "D12AKTSDC",
  "ts": "1775731256.517439",
  "message": {
    "text": "Hello from SLICC!",
    "type": "message",
    "user": "W5BPKRLUA",
    "ts": "1775731256.517439"
  }
}
```

### POST /api/conversations.open

Open or find a DM channel with a user.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| users | yes | Comma-separated user IDs (e.g. `USLACKBOT`) |
| return_im | no | Return full IM object |

**Response:**
```json
{
  "ok": true,
  "channel": {
    "id": "D12AKTSDC",
    "is_im": true,
    "user": "USLACKBOT"
  }
}
```

**Known DM channels:**
- Slackbot: `USLACKBOT` → DM channel `D12AKTSDC`

### POST /api/conversations.info

Get channel metadata.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel ID |

**Response:**
```json
{
  "ok": true,
  "channel": {
    "id": "C087NCG774J",
    "name": "one-aem-leadership",
    "purpose": { "value": "..." },
    "topic": { "value": "..." },
    "num_members": 42
  }
}
```

### POST /api/users.info

Get user profile information.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| user | yes | User ID (e.g. `W5BPKRLUA`) |

**Response:**
```json
{
  "ok": true,
  "user": {
    "id": "W5BPKRLUA",
    "name": "trieloff",
    "real_name": "Lars Trieloff",
    "is_bot": false,
    "tz": "Europe/Amsterdam",
    "profile": {
      "display_name": "trieloff",
      "title": "...",
      "status_text": "...",
      "status_emoji": "..."
    }
  }
}
```

### POST /api/search.modules

Search for channels by name. Replaces `conversations.list` which is blocked on Enterprise Grid.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| query | yes | Search query string |
| module | yes | `channels` for channel search |
| count | no | Results per page (default 20) |
| page | no | Page number (1-based) |

**Response:**
```json
{
  "ok": true,
  "pagination": {
    "total_count": 9,
    "page": 1,
    "per_page": 5,
    "page_count": 2
  },
  "items": [
    {
      "id": "C087NCG774J",
      "name": "one-aem-leadership",
      "member_count": 42,
      "is_member": true,
      "purpose": { "value": "..." }
    }
  ]
}
```

## Enterprise Grid Restrictions

Some Slack workspaces use Enterprise Grid. The following standard Web API methods
return `enterprise_is_restricted` on those workspaces:

- `conversations.list`
- `users.conversations`

Use these alternatives:
- Channel discovery: `search.modules` with `module=channels`
- DM channel lookup: `conversations.open` with target user IDs
- Channel info: `conversations.info` with a known channel ID

## Error Handling

All responses include `"ok": true|false`. On error:
```json
{
  "ok": false,
  "error": "channel_not_found"
}
```

Common errors:
- `channel_not_found` — Invalid channel ID
- `not_in_channel` — User is not a member of the channel
- `enterprise_is_restricted` — Method blocked on Enterprise Grid
- `invalid_auth` — Token expired or invalid
- `token_not_found` — No token found for the specified workspace ID
- `ratelimited` — Rate limited; check `Retry-After` header
