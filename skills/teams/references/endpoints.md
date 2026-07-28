# Teams â Graph API Endpoints Reference

Per-endpoint documentation for the `teams` skill. All calls use an OAuth 2
bearer token extracted from the user's Teams browser session.

## Authentication

The skill extracts the delegated access token from the MSAL cache in the
Teams web client's **`localStorage`** (Teams v2, `teams.microsoft.com/v2/`).
Older Teams versions that use `sessionStorage` are covered by a fallback.

### MSAL token cache structure

MSAL v2 stores tokens under composite keys of the form:

```
<homeAccountId>-<environment>-accesstoken-<clientId>-<realm>-<scopes>
```

Each value is JSON along the lines of:

```json
{
  "credential_type": "AccessToken",
  "secret": "<the actual bearer token>",
  "home_account_id": "...",
  "environment": "login.microsoftonline.com",
  "client_id": "...",
  "target": "openid profile User.Read ...",
  "realm": "<tenant-id>",
  "token_type": "Bearer",
  "expires_on": "1713200000",
  "extended_expires_on": "1713203600"
}
```

The page-context fetch searches for keys containing both `accesstoken` and
`graph.microsoft.com`, picks the entry with the highest `expiresOn` /
`expires_on`, and uses the `secret` field as the bearer token. Substrate
Search calls use the same lookup against `substrate.office.com`. All of this
runs inside the Teams tab via `playwright-cli eval`; the token value never
leaves the browser context.

### Required scopes

The Teams web app requests broad scopes. This skill uses:

| Scope | Used by |
|---|---|
| `User.Read` | `activity` (resolve `/me`), `user` |
| `User.ReadBasic.All` | `user` (lookup by name / UPN) |
| `Team.ReadBasic.All` | `teams`, name â ID resolution |
| `Channel.ReadBasic.All` | `channels`, `info`, channel name â ID resolution |
| `ChannelMessage.Read.Group` / `ChannelMessage.Read.All` (beta) | `history`, `unanswered`, `digest`, `thread` |
| `ChannelMessage.Send` | `post` |
| `Chat.Read` | `search`, `activity` (via Search API) |

If the token lacks a scope, Graph returns `403`. The user may need to
consent via the Azure portal or re-open Teams after a tenant policy change.

### Token lifetime

Tokens typically expire after 60â90 minutes. The Teams web app silently
refreshes them. When a token expires:

1. `teams` commands fail with `401 Unauthorized`.
2. Refresh the Teams tab in the browser. The next command picks up the new
   token automatically â there is no separate auth step to run.

## Graph API base URLs

- `GRAPH_BASE`  = `https://graph.microsoft.com/v1.0`
- `GRAPH_BETA`  = `https://graph.microsoft.com/beta`

Channel message reads and POSTs go through **beta**; team/channel/user
metadata uses **v1.0**.

## Endpoints

### User profile

```
GET https://graph.microsoft.com/v1.0/me
```

Returns `displayName`, `mail`, `userPrincipalName`, `id`. Used by
`teams activity` to resolve the current user for mention matching.

### List joined teams

```
GET https://graph.microsoft.com/v1.0/me/joinedTeams
```

Returns an array (under `value`) with `id`, `displayName`, `description`.

### List channels

```
GET https://graph.microsoft.com/v1.0/teams/{team-id}/channels
```

Each channel has `id`, `displayName`, `description`, `membershipType`
(`standard` / `private` / `shared`).

### Get channel info

```
GET https://graph.microsoft.com/v1.0/teams/{team-id}/channels/{channel-id}
```

Returns `id`, `displayName`, `description`, `membershipType`, `webUrl`.

### List channel messages

```
GET https://graph.microsoft.com/beta/teams/{team-id}/channels/{channel-id}/messages
```

Returns top-level messages (not replies). Key query parameters:

| Parameter | Example | Notes |
|---|---|---|
| `$top` | `$top=50` | Max 50 per page |
| `$expand` | `$expand=replies($top=1)` | Inline a cheap reply probe (used by `unanswered`) |
| `$filter` | `$filter=lastModifiedDateTime gt 2024-01-01T00:00:00Z` | Time filter (limited support on beta) |
| `$orderby` | `$orderby=createdDateTime desc` | Sort order |

**Pagination:** responses include `@odata.nextLink` (a full URL) when more
results exist. Follow it until it is absent.

Each message is shaped like:

```json
{
  "id": "...",
  "messageType": "message",
  "createdDateTime": "2024-03-15T10:30:00Z",
  "from": { "user": { "displayName": "Jane Doe", "id": "..." } },
  "body": { "contentType": "html", "content": "<p>Hello</p>" },
  "importance": "normal",
  "mentions": [
    { "id": 0, "mentionText": "John", "mentioned": { "user": { "id": "...", "displayName": "John" } } }
  ],
  "reactions": [
    { "reactionType": "like", "user": { "displayName": "Bob" } }
  ],
  "attachments": [],
  "replies": []
}
```

### Post a message to a channel

```
POST https://graph.microsoft.com/beta/teams/{team-id}/channels/{channel-id}/messages
Authorization: Bearer {token}
Content-Type: application/json

{
  "body": { "contentType": "text", "content": "Hello!" }
}
```

Returns the created message resource (same shape as the list-messages
response). Use `contentType: "html"` for formatted content (mentions,
bold, links, etc.).

### Reply in a thread

```
POST https://graph.microsoft.com/beta/teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies
Authorization: Bearer {token}
Content-Type: application/json

{
  "body": { "contentType": "text", "content": "Got it!" }
}
```

`{message-id}` is the `id` of the top-level parent message. The response is
a reply message resource â structurally identical to a channel message.

### Get message replies (thread read)

```
GET https://graph.microsoft.com/beta/teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies
```

Supports `$top` (max 50) and `@odata.nextLink` pagination. Same response
shape as channel messages.

### Look up a user

```
GET https://graph.microsoft.com/v1.0/users/{user-id-or-upn}
GET https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'Name')&$top=5&$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation
```

The skill picks the direct lookup when the input is a GUID or contains `@`;
otherwise it uses `$filter=startswith(displayName,'...')`. Response fields:
`id`, `displayName`, `mail`, `userPrincipalName`, `jobTitle`, `department`,
`officeLocation`.

### Search messages (Search API)

```
POST https://graph.microsoft.com/beta/search/query
Content-Type: application/json

{
  "requests": [
    {
      "entityTypes": ["chatMessage"],
      "query": { "queryString": "deployment issue" },
      "from": 0,
      "size": 25
    }
  ]
}
```

Response contains `value[0].hitsContainers[0].hits[]`. Each hit has a
`resource` (the chatMessage) and `summary` (highlighted snippet). Supports
KQL-style operators in the query string. Used by `teams search` and the
primary path of `teams activity`.

### Get all messages across channels (application-only)

```
GET https://graph.microsoft.com/v1.0/teams/{team-id}/channels/getAllMessages
```

Requires application permissions (`ChannelMessage.Read.All`) â **not
available** with delegated tokens from the browser session. Mentioned here
only for reference.

## Rate limiting

Microsoft Graph applies per-app and per-tenant throttling. When throttled:

- Response status: `429 Too Many Requests`
- `Retry-After` header indicates seconds to wait

The skill paginates conservatively (`maxPages` 2â5 per call) to stay within
limits. If you hit throttling, wait per the `Retry-After` header and retry.

## Common error codes

| Status | Meaning | Resolution |
|---|---|---|
| 401 | Token expired or invalid | Refresh the Teams tab in the browser; next command auto-picks up the new token |
| 403 | Insufficient permissions | Token lacks a required scope. Confirm you're on the **beta** endpoint for message reads. |
| 404 | Resource not found | Team / channel / message ID is wrong |
| 429 | Throttled | Wait per `Retry-After` header |
| 503 | Service unavailable | Transient â retry after a few seconds |

## monday chat retrieval

`teams monday` cannot read chats through Graph: the delegated browser token
carries no `Chat.ReadBasic` / `Chat.Read` / `Chat.ReadWrite` scope, so
`/me/chats` answers `403`. (This is the same cause as the
`Chat scan unavailable (403)` warning from `teams activity`.)

It therefore uses the Teams chat service (IC3) that the web client itself uses:

1. `POST teams.microsoft.com/api/authsvc/v1.0/authz` â obtained in-page with an
   `api.spaces.skype.com` token â returns a `skypeToken`.
2. That token is used against
   `<regionGtms.chatService>/v1/users/ME/conversations[/â¦/messages]`.

Tokens are minted and consumed inside the Teams tab, exactly like every other
subcommand; nothing is persisted. If the activity feed is unavailable, `monday`
falls back to the Graph beta channel scan used by `teams activity`.

## live caption capture

**How it works.** A `MutationObserver` on the caption virtual-list
(`closed-caption-v2-virtual-list-content`) captures changes event-driven (no poll gaps).
Each spoken utterance is its OWN `[data-tid="closed-caption-text"]` element whose text
grows as it is recognized, then finalizes when the next utterance's element appears  so
the collector keeps one buffer entry per element and **supersedes its text as it grows**,
delivering each utterance to the webhook exactly once (when it finalizes, or after a
short debounce for the trailing one). The speaker name sits ~2 ancestors above the text
span (`"Name\n<text>"`). The `window` buffer survives across evals, so you can `flush` on
any cadence without losing lines; only a tab reload clears it.

> **Why DOM (not the network):** verified on the wire  Teams live captions arrive over
> the encrypted **WebRTC media channel** and materialize only in the client DOM; there is
> **no WebSocket/HTTP source** to tap (a HAR + WS-frame capture during active captioning
> showed zero caption traffic). Element-level DOM capture is therefore the complete and
> correct approach. Validated live: a 20-utterance test captured and delivered 20/20.
>

## copilot mode wiring

Typical wiring: `teams transcribe start --scoop meeting-copilot`  the `meeting-copilot` scoop receives a lick per phrase, calls `teams transcribe flush --snapshot` for the latest text + a shared-screen frame, decides whether additional context is warranted, and if so calls `teams post --live "..."`.

> **Validated live** against a real meeting (Jul 2026): webhooklick delivery, canvas
> snapshot + content-scoped dedupe, and `post --live` all confirmed working. Selectors
> (caption list, meeting-chat compose/Send, share `<video>`) may still need updates if a
> future Teams build changes its DOM.

