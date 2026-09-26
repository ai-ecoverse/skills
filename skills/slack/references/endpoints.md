# Slack Web API Endpoints

Base URL: `/api/` (same-origin XHR from `app.slack.com`)
Auth: `xoxc-*` token from `localStorage` key `localConfig_v2` → `.teams[<workspaceId>].token`
Transport: XHR with `Content-Type: application/x-www-form-urlencoded` and `withCredentials: true`

## Contents

- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [POST /api/conversations.history](#post-apiconversationshistory)
  - [POST /api/conversations.replies](#post-apiconversationsreplies)
  - [POST /api/chat.postMessage](#post-apichatpostmessage)
  - [POST /api/reactions.add](#post-apireactionsadd)
  - [POST /api/conversations.open](#post-apiconversationsopen)
  - [POST /api/conversations.info](#post-apiconversationsinfo)
  - [POST /api/auth.test](#post-apiauthtest)
  - [POST /api/users.info](#post-apiusersinfo)
  - [POST /api/search.modules](#post-apisearchmodules)
  - [POST /api/chat.attachmentAction](#post-apichatattachmentaction)
- [Enterprise Grid Restrictions](#enterprise-grid-restrictions)
  - [POST /api/activity.feed](#post-apiactivityfeed)
- [Error Handling](#error-handling)
- [Admin User-Management Methods (`users.admin.*`)](#admin-user-management-methods-usersadmin)
  - [POST /api/users.admin.setUltraRestricted](#post-apiusersadminsetultrarestricted)
  - [POST /api/users.admin.setRestricted](#post-apiusersadminsetrestricted)
  - [POST /api/users.admin.setRegular](#post-apiusersadminsetregular)
  - [POST /api/conversations.invite (for guest channel management)](#post-apiconversationsinvite-for-guest-channel-management)
  - [POST /api/conversations.kick (for guest channel management)](#post-apiconversationskick-for-guest-channel-management)
- [Enterprise Grid channel search (`admin.conversations.search`)](#enterprise-grid-channel-search-adminconversationssearch)
  - [POST /api/admin.conversations.search](#post-apiadminconversationssearch)
- [App Manifest API (`apps.manifest.*`, `tooling.tokens.rotate`)](#app-manifest-api-appsmanifest-toolingtokensrotate)
  - [POST /api/apps.manifest.export](#post-apiappsmanifestexport)
  - [POST /api/apps.manifest.validate](#post-apiappsmanifestvalidate)
  - [POST /api/apps.manifest.update](#post-apiappsmanifestupdate)
  - [POST /api/tooling.tokens.rotate](#post-apitoolingtokensrotate)
  - [POST /api/apps.manifest.create, POST /api/apps.manifest.delete — never wired up](#post-apiappsmanifestcreate-post-apiappsmanifestdelete--never-wired-up)
  - [Probing a method name without a credential](#probing-a-method-name-without-a-credential)

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
| oldest | no | Unix timestamp — only replies after this |
| inclusive | no | `false` to exclude the `oldest` message itself |
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

### POST /api/reactions.add

Add an emoji reaction to a message. Used by `slack post`'s auto-sign feature to
"sign" the just-posted message (default `icecream` → 🍦).

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel/DM ID the message is in (the RESOLVED channel — for a DM, the `D…` id) |
| timestamp | yes | The message `ts` to react to (e.g. the `ts` returned by `chat.postMessage`) |
| name | yes | Emoji shortcode **without** colons (e.g. `icecream`, `robot_face`) |

**Response:**
```json
{ "ok": true }
```

**Common non-fatal errors** (`slack post` warns but still exits 0):
- `already_reacted` — the reaction is already present on the message.
- `invalid_name` — no emoji with that name exists in the workspace.
- `no_reaction` / permission-style errors — cannot react in this context.

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

**`num_members` usage:** `slack post`'s auto-watch reads `channel.num_members`
to decide watch scope — **> 100 members** → watch the thread only (observer
selector adds `thread_ts`); **≤ 100 / DM / missing** → watch the whole channel.
DMs and some conversation types omit `num_members`; a missing value is treated
as "small" (whole-channel watch).


### POST /api/auth.test

Identify the authenticated user behind the current token. Used by `slack post`'s
auto-watch to learn **our own** user id, so the reply-watch webhook filter can
drop every message we post ourselves (not just the one that created the watch)
and your own posts never produce a notification.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |

**Response:**
```json
{
  "ok": true,
  "url": "https://adobe.enterprise.slack.com/",
  "team": "Adobe",
  "user": "trieloff",
  "team_id": "T06DUTYDQ",
  "user_id": "W5BPKRLUA"
}
```

**`user_id` usage:** the auto-watch reads `user_id` once, at watch-creation time,
and inlines it into the webhook filter (`m.user === "<user_id>"` → drop). The call
is non-fatal: if it fails or returns no `user_id`, the filter falls back to
dropping only the originating message's `ts`, and posting still succeeds.

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

### POST /api/chat.attachmentAction

Execute an interactive message button action (approve/deny). This is the internal
API that Slack calls when a user clicks an action button in an attachment.

**Parameters (FormData, not URL-encoded):**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| payload | yes | JSON string (see below) |
| service_id | yes | `B01` (Slack's internal bot service) |
| bot_user_id | yes | `USLACKBOT` |
| client_token | no | `web-{timestamp}` (dedup token) |

**Payload JSON structure:**
```json
{
  "actions": [
    {
      "id": "1",
      "name": "approve",
      "text": "Approve",
      "type": "button",
      "value": "",
      "style": "primary"
    }
  ],
  "attachment_id": "2",
  "callback_id": "sharedchannelinviterequests_Ir0AP9AV1A8M_T0AKE3C1LAX",
  "channel_id": "D06V5UBEZML",
  "message_ts": "1774846849.585479",
  "prompt_app_install": false
}
```

**Key fields:**
- `actions` — array with one action object matching the button clicked
- `callback_id` — from the message attachment (identifies the handler)
- `attachment_id` — the attachment id from the message attachment object's `id` field
- `channel_id` — channel where the message lives
- `message_ts` — timestamp of the message

**Response:** `{"ok": true}` on success. Note: expired actions may return `ok: true`
but show an error in the UI as a follow-up message.

**Common callback_id patterns:**
- `sharedchannelinviterequests_<invite_id>_<team_id>` — Slack Connect invite
- Workspace invite requests use different callback IDs with `value` containing the invite request ID

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

## Admin User-Management Methods (`users.admin.*`)

These are **undocumented legacy methods** used by `slack-ext`. They are NOT
the same as the documented `admin.users.*` namespace (those return
`not_allowed_token_type` for xoxc session tokens and need an org-level app
token with `admin.users:write`).

**Verification method (no credentials needed):** `POST https://slack.com/api/<method>`
returns `{"ok":false,"error":"not_authed"}` for real methods and
`{"ok":false,"error":"unknown_method"}` for nonexistent ones. All methods
below were verified real on 2026-09-18.

**Token requirement:** these methods reject bot tokens (`xoxb`) with
`not_allowed_token_type`. They work only with an xoxc admin user token.
The `xoxc` token MUST travel with Slack's `d` session cookie;
`slack-ext.jsh` uses `browser.fetch` (same-origin XHR) which sends cookies
automatically.

**Audit note:** calls are attributed in Slack's audit log to the admin user
whose token is in use, not to an app.

### POST /api/users.admin.setUltraRestricted

Convert a user to a **single-channel guest** (ultra-restricted).

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc admin user token |
| user | yes | User ID (e.g. `W5BPKRLUA`) |
| team_id | yes | Workspace team ID (e.g. `T06DUTYDQ`) |
| channel | yes | **Singular** — the one channel the guest may access |

**GOTCHA — `channel` vs `channels`:** the parameter is `channel` (singular).
Passing `channels` (plural) returns `invalid_arguments`. Verified both ways
2026-09-18. The `slack-ext.jsh` code and its tests enforce this.

**Response on success:** `{"ok": true}`

**Verification probe (no auth needed):**
```
POST https://slack.com/api/users.admin.setUltraRestricted  →  not_authed  (method exists)
POST https://slack.com/api/admin.users.setUltraRestricted  →  unknown_method  (DOES NOT EXIST)
```

**Test with bogus user:** `user=U000000BOGUS0` returns `user_not_found`,
confirming auth, permissions, and parameter shape without changing anyone.

### POST /api/users.admin.setRestricted

Convert a user to a **multi-channel guest** (restricted).

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc admin user token |
| user | yes | User ID |
| team_id | yes | Workspace team ID |

No `channel` parameter. After converting, use `conversations.invite` to
grant channel access.

**Response on success:** `{"ok": true}`

**Verification probe:**
```
POST https://slack.com/api/users.admin.setRestricted   →  not_authed  (real)
POST https://slack.com/api/admin.users.setRestricted   →  unknown_method  (DOES NOT EXIST)
```

### POST /api/users.admin.setRegular

Promote a guest back to a **regular member**. The inverse of
`setRestricted` and `setUltraRestricted`.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc admin user token |
| user | yes | User ID |
| team_id | yes | Workspace team ID |

**Response on success:** `{"ok": true}`

### POST /api/conversations.invite (for guest channel management)

Invite a user (including a multi-channel guest) to a channel. Used by
`slack-ext add-channel`.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel ID |
| users | yes | Comma-separated user IDs |

**Common errors:**
- `already_in_channel` — user is already a member (treated as no-op)
- `cant_invite_self` — cannot invite the token owner

### POST /api/conversations.kick (for guest channel management)

Remove a user from a channel. Used by `slack-ext remove-channel`.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| token | yes | xoxc token |
| channel | yes | Channel ID |
| user | yes | User ID (singular) |

**Common errors:**
- `not_in_channel` — user is not in the channel (treated as no-op)
- `cant_kick_self` — cannot kick the token owner
- `cant_kick_from_general` — some workspaces protect #general

## Enterprise Grid channel search (`admin.conversations.search`)

Endpoint contract used by `slack-ext channel-search` and by `channel-archive` / `channel-unarchive`.
The archive and unarchive methods, the wire facts measured on this method (the `query=<channel id>`
lookup, microsecond timestamps, `member_count: -1`, the index lag) and how `slack-ext` uses them:
`references/enterprise-grid.md`, "Enterprise Grid Channel Admin".

### POST /api/admin.conversations.search

Org-wide channel search; the only state read that sees private channels the
admin is not in (`conversations.info` answers `channel_not_found` for those).

| Param | Required | Description |
|-------|----------|-------------|
| token | yes | org-level xoxc token |
| query | yes | May be empty. `query=<channel id>` finds that channel (see `references/enterprise-grid.md`) |
| limit | yes | **1 to 20.** `limit=21` answers `invalid_arguments`. `slack-ext channel-search` defaults to 50 and so fails unless `--limit=20` is passed |
| search_channel_types | yes | `all`, `exclude_archived`, `private`, `private_exclude`, `archived`. `private_archive` answers `invalid_search_channel_type` |
| sort | yes | `name`, `member_count`, `created` (`last_activity_ts` answers `invalid_sort`) |
| sort_dir | yes | `asc` / `desc` |
| cursor | yes | Empty for the first page; then `next_cursor` |

Response: `{ok, conversations: [...], next_cursor}`. Fields used by
`channel-archive`: `id`, `name`, `is_private`, `is_archived`, `member_count`,
`external_user_count`, `is_ext_shared`, `is_pending_ext_shared`,
`is_org_shared`, `conversation_host_id`, `last_activity_ts`.

## App Manifest API (`apps.manifest.*`, `tooling.tokens.rotate`)

A different API surface from everything above: `https://slack.com/api/` over
plain HTTPS (not same-origin XHR), authenticated with an **app configuration
token** (`xoxe.xoxp-...`) in an `Authorization: Bearer` header. This is a third
credential — not the `xoxb` bot token, not the `xoxc` session token used by every
other endpoint in this document. Used by `slack-ext app`.

Transport: `Content-Type: application/x-www-form-urlencoded`. A JSON request body
is rejected with `invalid_arguments`. The `manifest` parameter is a JSON
**string**, not a nested object.

**Failure is signalled in the body, not the status.** Every failure observed
returned **HTTP 200** with `{"ok":false,"error":"..."}` — a bogus bearer token
gave `invalid_auth`, a bad app id gave `invalid_app_id`. Check `body.ok`.

Getting the first token is a manual browser step and cannot be automated:
`api.slack.com/apps` → "Your App Configuration Tokens" → Generate Token → pick a
workspace → Generate. (The workspace picker is a Slack Kit `.c-basic-select`
that ignores synthetic events entirely.)

### POST /api/apps.manifest.export

Fetch the live manifest of an app. Used by `slack-ext app export`, `app show`
and `app diff`.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| app_id | yes | App ID (e.g. `A0123456789`) |

**Returns:** `{ok: true, manifest: {...}}`. A real manifest is small: the app used
to verify this had **14 leaf fields / 709 bytes** — `display_information`
(`name`, `description`, `background_color`), `features.bot_user`
(`display_name`, `always_online`), `oauth_config` (`scopes.bot[]`,
`pkce_enabled`), and `settings` (`event_subscriptions.request_url`,
`event_subscriptions.bot_events[]`, `org_deploy_enabled`,
`socket_mode_enabled`, `token_rotation_enabled`,
`app_level_token_rotation_enabled`, `is_mcp_enabled`).

**Common errors:** `invalid_auth` (bad/expired config token), `invalid_app_id`,
`app_not_found`.

### POST /api/apps.manifest.validate

Validate a candidate manifest without changing anything. Used by
`slack-ext app validate`.

**Parameters:**
| Param | Required | Description |
|-------|----------|-------------|
| manifest | yes | The manifest as a JSON string |
| app_id | no | Validate against an existing app |

**Returns:** `{ok: true, errors: []}` when valid. When invalid:
`{ok: false, error: "invalid_manifest", errors: [...]}`, where each error carries
a **JSON pointer** — captured live:

```json
{"ok":false,"error":"invalid_manifest","errors":[{"code":"illegal_bot_scopes",
"message":"Illegal bot scopes found `this:is:not:a:real:scope`",
"pointer":"/oauth_config/scopes/bot"}]}
```

**A PASS DOES NOT MEAN SAFE.** A `display_information`-only payload returns
`ok:true, errors: []` (confirmed live), even though applying it would strip the
bot user, every scope and every event subscription. Validation catches only some
incoherence (omitting `oauth_config` fails with
`requires_a_bot_scope@/features/bot_user` and
`target_component_is_null@/settings/event_subscriptions`), which is worse than
blanket rejection: the dangerous payloads are the ones that pass. Use
`slack-ext app diff` before applying a manifest.

### POST /api/apps.manifest.update

Parameters `app_id` + `manifest` (a JSON string); returns
`{ok, permissions_updated}`. Used by `slack-ext app set-scopes`, `set-events`,
`set-request-url` and `apply` — all of which route through one internal helper
that exports the live manifest first and sends the complete result.

Measured semantics, which every write path must respect:

- **No merge semantics: an omitted field is DELETED** (omitting
  `display_information.description` removed it).
- **Arrays are REPLACED WHOLESALE** (`bot_events: ["channel_created"]` removed
  `team_join`).
- The single exception measured was `display_information.background_color`, which
  survived omission because it can never be null. One field, not a pattern.
- **`permissions_updated: true` means a REINSTALL is required**: a scope added to
  the configuration does not reach the live bot token until the app is
  reinstalled.

So a write must always export the live manifest, modify that object, and send the
complete result. `slack-ext` enforces that structurally: `updateFromLiveManifest`
is the only call site for this method, it refuses to proceed when the export
failed or returned no manifest, and it blocks any deletion the command was not
explicitly asked to make unless `--allow-deletions` is passed on top of
`--confirm`.

`permissions_updated` is surfaced on every write. When it is `true` the operator
is told to reinstall the app at
`api.slack.com/apps/<app_id>/install-on-team`, because the previously issued bot
token does not carry the new scope until it is reissued.

### POST /api/tooling.tokens.rotate

Rotates an app configuration token; used by `slack-ext app token-rotate`.
Returns `{ok, token, refresh_token, team_id, user_id, iat, exp}`.
Authenticates **by argument, not header**:
`refresh_token=<bogus>` returns `invalid_refresh_token` (param name confirmed),
`token=<bogus>` returns `invalid_auth`, and no params returns `invalid_arguments`
with `missing required field: refresh_token`. Sending an `Authorization: Bearer`
header alongside a bogus `refresh_token` returned `invalid_auth`, so the header
takes precedence — a rotate call should be made without one.

Hazard: **a rotate invalidates the old refresh token.** If the process dies
between rotating and persisting, the credential is lost permanently and only a
human can mint a replacement. `slack-ext app token-rotate` therefore requires
`--confirm` (never rotate speculatively — only on demand or after a 401), writes
the new pair to the skill config **before anything else happens with it**, and
falls back to printing the pair on stdout if that write fails: the old refresh
token is already dead by then, so surfacing the credential beats losing it. A
response that is `ok` but missing either half of the pair is refused rather than
treated as a successful rotation.

### POST /api/apps.manifest.create, POST /api/apps.manifest.delete — never wired up

Both are real methods (`not_authed` on an unauthenticated probe). `slack-ext`
refuses both by name before any request is made: deleting a Slack app is
unrecoverable and there is no reason for a CLI to offer it. Use
`api.slack.com/apps` if you really mean it.

### Probing a method name without a credential

`curl -s -X POST https://slack.com/api/<method>` with no auth distinguishes real
from imaginary methods: a real method answers `{"ok":false,"error":"not_authed"}`,
a nonexistent one answers `{"ok":false,"error":"unknown_method"}`. No credential,
no side effects. All five `apps.manifest.*` methods answer `not_authed`;
`apps.manifest.nonexistent` answers `unknown_method`.
