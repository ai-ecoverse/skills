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

### POST /api/activity.feed

Get the activity feed (notifications). This is an undocumented internal API used
by Slack's Activity tab.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| types | yes | Comma-separated activity types (see below) |
| mode | yes | `chrono_reads_and_unreads` or `priority_reads_and_unreads_v1` |
| limit | no | Number of items (default 20) |
| unread_only | no | `true` or `false` (default `false`) |
| archive_only | no | `true` or `false` (default `false`) |
| priority_only | no | `true` or `false` (default `false`) |
| cursor | no | Pagination cursor from `response_metadata.next_cursor` |

**Activity types:**
- `generic_system_alert` — admin events (channel archived, workspace changes)
- `bot_dm_bundle` — grouped bot/app DMs (invite requests, Google Drive, etc.)
- `at_user` — direct @mention
- `at_user_group` — @usergroup mention
- `at_channel` — @channel mention
- `at_everyone` — @everyone mention
- `unjoined_channel_mention` — @mention in a channel you haven't joined
- `thread_v2` — thread reply
- `message_reaction` — emoji reaction on your message
- `internal_channel_invite` — invited to a channel
- `external_channel_invite` — Slack Connect invite
- `list_record_edited`, `list_record_assigned`, `list_user_mentioned` — list items
- `list_todo_notification`, `list_approval_request`, `list_approval_reviewed` — list workflows

**Response:**
```json
{
  "ok": true,
  "items": [
    {
      "is_unread": true,
      "feed_ts": "1776269981.932928",
      "key": "generic_system_alert.1776269981932928",
      "item": {
        "type": "generic_system_alert",
        "generic_system_alert_payload": {
          "category": "CHANNEL",
          "blocks": [{ "type": "rich_text", "elements": [...] }],
          "click_target_id": "C05JRAM3A1H"
        }
      }
    }
  ],
  "response_metadata": {
    "next_cursor": "YWN0aXZpdHk6..."
  }
}
```

**Item type shapes:**
- `generic_system_alert` → `.item.generic_system_alert_payload.{category, blocks[], reason, click_target_id}`
- `bot_dm_bundle` → `.item.bundle_info.{unread_count, payload.message.{ts, channel}}`
- `at_user` → `.item.message.{ts, channel, author_user_id, is_broadcast}`
- `internal_channel_invite` → `.item.invite_info.{channel_id, inviter_user_id}`

**Notes:**
- This endpoint works cross-workspace: use the target workspace's token even if the
  active Slack tab is on a different workspace.
- The `mode` parameter determines sort order. `chrono_reads_and_unreads` returns items
  in reverse chronological order. `priority_reads_and_unreads_v1` uses Slack's priority
  ranking (used by the "All" tab).

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
