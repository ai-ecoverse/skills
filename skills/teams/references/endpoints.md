# Teams — Graph API Endpoints Reference

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

`teams auth` searches for keys containing both `accesstoken` and
`graph.microsoft.com`, picks the entry with the highest `expiresOn` /
`expires_on`, and extracts the `secret` field.

### Required scopes

The Teams web app requests broad scopes. This skill uses:

| Scope | Used by |
|---|---|
| `User.Read` | `auth` (verify token via `/me`), `user` |
| `User.ReadBasic.All` | `user` (lookup by name / UPN) |
| `Team.ReadBasic.All` | `teams`, name → ID resolution |
| `Channel.ReadBasic.All` | `channels`, `info`, channel name → ID resolution |
| `ChannelMessage.Read.Group` / `ChannelMessage.Read.All` (beta) | `history`, `unanswered`, `digest`, `thread` |
| `ChannelMessage.Send` | `post` |
| `Chat.Read` | `search`, `activity` (via Search API) |

If the token lacks a scope, Graph returns `403`. The user may need to
consent via the Azure portal or re-open Teams after a tenant policy change.

### Token lifetime

Tokens typically expire after 60–90 minutes. The Teams web app silently
refreshes them. When a token expires:

1. `teams` commands fail with `401 Unauthorized`.
2. Re-run `teams auth` — the browser cache will already hold a fresh token.

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

Returns `displayName`, `mail`, `userPrincipalName`, `id`. Used by `teams auth`
to verify the token.

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
a reply message resource — structurally identical to a channel message.

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

Requires application permissions (`ChannelMessage.Read.All`) — **not
available** with delegated tokens from the browser session. Mentioned here
only for reference.

## Rate limiting

Microsoft Graph applies per-app and per-tenant throttling. When throttled:

- Response status: `429 Too Many Requests`
- `Retry-After` header indicates seconds to wait

The skill paginates conservatively (`maxPages` 2–5 per call) to stay within
limits. If you hit throttling, wait per the `Retry-After` header and retry.

## Common error codes

| Status | Meaning | Resolution |
|---|---|---|
| 401 | Token expired or invalid | Run `teams auth` |
| 403 | Insufficient permissions | Token lacks a required scope. Confirm you're on the **beta** endpoint for message reads. |
| 404 | Resource not found | Team / channel / message ID is wrong |
| 429 | Throttled | Wait per `Retry-After` header |
| 503 | Service unavailable | Transient — retry after a few seconds |
