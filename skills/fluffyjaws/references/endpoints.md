# FluffyJaws API Endpoints

**UI base URL:** `https://fluffyjaws.adobe.com`
**Public API base URL:** `https://api.fluffyjaws.adobe.com`
**Local full-stack base URL:** `http://localhost:3000`

The `fj` script always uses the **UI host** (`https://fluffyjaws.adobe.com`)
because the public host enforces CORS against registered origins and the SLICC
browser fetch sandbox always uses `Origin: http://localhost:...`. Both hosts
serve the same `/api/v1/*` contract.

## Auth

FluffyJaws accepts four auth flavours on the public API:

| Auth | How | Where supported |
|------|-----|-----------------|
| Browser session (cookie `fjv3_session`) | Sign in at `https://fluffyjaws.adobe.com/api/auth/login` (Adobe Okta) | Same-origin requests from the UI host. **This is what `fj` uses.** |
| Bearer user token | Okta authorization-code + PKCE flow against the FluffyJaws-bound OIDC issuer; scope `openid profile email [offline_access]` | All `/api/v1/*` |
| Service token | Okta `client_credentials` against a registered Okta service app; scope `fluffyjaws` | Subset of `/api/v1/*` (see below). The Okta client must also be registered in FluffyJaws first. |
| Service token + `X-User-Token: Bearer <user>` (OBO) | Service token in `Authorization`, user token in `X-User-Token` | All endpoints that allow service tokens |

On `/api/v1/*`, an explicit `Authorization` header takes precedence over the
ambient `fjv3_session` cookie.

Public responses include:

- `X-FluffyJaws-Api-Version: v1`
- `X-FluffyJaws-Api-Stability: public`

CORS on registered origins allows `GET, POST, OPTIONS` and the headers
`Authorization, Content-Type, X-User-Token`. Wildcard subdomains
(`https://*.example.com`) are supported; bare apex wildcards are normalized to
`https://`.

### Pure service tokens (no `X-User-Token`) work on this subset:

- `GET /api/v1`
- `POST /api/v1/mcp`
- `POST /api/v1/stream` for standard chat without `agentId`
- `GET /api/v1/conversation/list`
- `POST /api/v1/conversation/create`
- `GET /api/v1/conversation/:uuid`
- `GET /api/v1/feedback/agent/:agentId` (if allowlisted)
- `GET /api/v1/fluffypack/list`
- `GET /api/v1/fluffypack/:uuid`

Sending `agentId` with a service token requires `X-User-Token`. App
registration / ownership management is human-only (browser session or bearer
user token).

## Public chat

### `POST /api/v1/stream`

Live streaming chat over Server-Sent Events. The main public chat endpoint.

**Required headers:**
- `Accept: text/event-stream`
- `Content-Type: application/json`

**Request body:**

| Field | Type | Notes |
|-------|------|-------|
| `model` | string (required) | e.g. `gpt-5.4` |
| `messages` | array (required) | `[{ role: 'user'|'assistant', content: string | content-item[] }]` |
| `previousResponseId` | string | continue an earlier model thread |
| `canvasMode` | boolean | default `true` |
| `webSearchEnabled` | boolean | default `true` |
| `reasoningEffort` | `low\|medium\|high` | optional |
| `agentId` | string | route to an A2A agent (requires `X-User-Token` if service-token auth) |
| `a2aContextId` | string | continue an A2A thread |
| `a2aUserTokenOverride` | string | dev-only |
| `fileIds` | string[] | already-uploaded reusable files |
| `fluffyPackUuid` | string | scope the turn to a FluffyPack the caller has access to |

**Advanced content items inside `messages[].content`:**

- `{ "type": "input_text", "text": "..." }`
- `{ "type": "input_file", "filename": "report.csv", "file_data": "<base64>", "mime_type": "text/csv" }`
  - 20 MB per file, 30 MB decoded total per request
  - user messages only
  - **not** allowed when `agentId` is set
  - `data:...;base64,...` URLs are accepted in `file_data`

**SSE events:**

- `response.created` — assigned response id; payload `{ response: { id, ... } }`
- `response.output_text.delta` — incremental text in `delta` (may include
  `renderMode: "instant"` for big tables that should append without typewriter)
- `response.output_text.done` — final text block in `text`
- `response.content_part.done` — completed content part with annotations / citations
- `response.completed` — terminal success; final `response.id`
- `response.failed` — terminal failure with `error`
- `error` — backend-raised error
- `tool_executing` / `tool_complete` — tool lifecycle
- `response.function_call_output` — tool output payload
- `a2a.context` — A2A routing context id for later turns
- `[DONE]` — sentinel after the terminal event

Reuse `response.id` as `previousResponseId` to continue. With
`previousResponseId`, you only need to send the latest user turn.

### `GET /api/v1/conversation/list?limit=&offset=`
Paginated list. Public surface exposes metadata only.

### `POST /api/v1/conversation/create`
Create a metadata envelope. Body accepts `{ title?: string }` (and other
optional fields). The public API does **not** expose a message-save endpoint
for streamed turns — store the response-id chain yourself for durable history.

### `GET /api/v1/conversation/:uuid`
Conversation envelope.

### `GET /api/v1/feedback/agent/:agentId`
Feedback export — only enabled for allowlisted service clients.

## FluffyPacks

### `GET /api/v1/fluffypack/list`

| Query | Type | Notes |
|-------|------|-------|
| `scope` | `all`\|`builtin`\|`discover`\|`mine`\|`recent`\|`recommended` | default `all` |
| `q` | string | search query |
| `limit` | int 1–100 | default 24 |
| `offset` | int | default 0 |

Response:

```jsonc
{
  "fluffyPacks": [/* summaries */],
  "hasMore": true,
  "totalCount": 123,
  "limit": 24,
  "offset": 0
}
```

Each summary: `uuid`, `name`, `description`, `systemPrompt`, `icon`,
`iconColor`, `uiConfig`, `lastUsedDate`, `isBuiltIn`, `ownerUsername`,
`ownerDisplayName`, `authorized`, `canManage`, `integrations`, `createdDate`,
`modifiedDate`. Recommended summaries can also include `recommendation.{reasonCode,reasonLabel,reasonDetails,score}`.

### `GET /api/v1/fluffypack/explore?q=`

Returns the four grouped lists the UI uses for the picker:

```jsonc
{
  "recommended": <list-response>,
  "recent":      <list-response>,
  "builtin":     <list-response>,
  "discover":    <list-response>
}
```

### `GET /api/v1/fluffypack/:uuid`

Pack detail. Top-level fields: `uuid`, `name`, `description`, `systemPrompt`,
`icon`, `iconColor`, `uiConfig`, `isBuiltIn`, `ownerUsername`,
`ownerDisplayName`, `authorized`, `canManage`, `createdDate`, `modifiedDate`,
plus configuration blocks: `tools`, `accessRules`, `admins`, `configDataSources`,
`configInterpretableFiles`, `slackIntegration`.

### `GET /api/fluffypack/:uuid/insights?days=7|30|90`

(Browser session only — for pack owners / admins.)

Returns `{ pack, windowDays, summary, dailyUsage, topUsers, recentActivity }`.

## MCP — `POST /api/v1/mcp`

JSON-RPC 2.0 transport for the FluffyJaws Model Context Protocol server.

**Headers:**
- `Authorization: Bearer ...` (or browser session)
- `Content-Type: application/json`
- `Accept: application/json` for plain JSON-RPC responses
- `Accept: application/json, text/event-stream` to receive `notifications/progress` before the final response on `tools/call`
- `Mcp-Session-Id: <id>` on every call after `initialize`

**Session lifecycle:**

- Call `initialize` first **without** an `Mcp-Session-Id`.
- Read `Mcp-Session-Id` from the response headers; reuse on subsequent calls.
- Sessions expire 30 minutes after `initialize`.
- Unknown / expired session ids return a JSON-RPC error with HTTP 404.

**Methods:**

| Method | Params | Result |
|--------|--------|--------|
| `initialize` | `{ protocolVersion?, clientInfo?: {name,version} }` | `{ protocolVersion, capabilities, serverInfo }`. Server accepts `2025-11-25` and `2024-11-05`. |
| `tools/list` | (none) | `{ tools: [{ name, description, inputSchema }] }` |
| `tools/call` | `{ name, arguments?, _meta?: { progressToken? } }` | `{ content: [parts], isError? }` |
| `ping` | (none) | health check |
| `shutdown` | (none) | end session cleanly |

**Default rate limits:**
- MCP: `MCP_RATE_LIMIT_MAX=30` per `MCP_RATE_LIMIT_WINDOW_SECONDS=60` per identity (enabled by default)
- LLM stream: `AUTH_RATE_LIMIT_*` (disabled by default; user 20/60s, service 30/60s when enabled). Applies to `POST /api/stream` and `POST /api/v1/stream`.

## Internal / private routes (browser session only)

The SPA also calls these unversioned routes; they are **not** part of the
public contract and may change. Use `fj` for the public surface; reach for
these only when no public equivalent exists.

```
GET    /api/auth/me
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/active-users
POST   /api/auth/impersonation/start
POST   /api/auth/impersonation/stop
GET    /api/auth/impersonation/users?query=

GET    /api/conversation/list?limit=&offset=
POST   /api/conversation/create
GET    /api/conversation/:uuid
PATCH  /api/conversation/:uuid
DELETE /api/conversation/:uuid
GET    /api/conversation/search?q=&limit=
POST   /api/conversation/reorder
POST   /api/conversation/pin/reorder
POST   /api/conversation/:uuid/pin
POST   /api/conversation/:uuid/share
GET    /api/conversation/shared/:uuid
GET    /api/conversation/shared/:uuid/file/:fileId/download
POST   /api/conversation/:uuid/folder
POST   /api/conversation/:uuid/message
GET    /api/conversation/:uuid/message/:msgId
PATCH  /api/conversation/:uuid/message/:msgId
DELETE /api/conversation/:uuid/message/:msgId
POST   /api/conversation/:uuid/message/:msgId/feedback
GET    /api/conversation/:uuid/message/:msgId/files?fileType=
POST   /api/conversation/:uuid/message/:msgId/file
POST   /api/conversation/:uuid/message/:msgId/media
GET    /api/conversation/:uuid/file/:fileId/download
POST   /api/conversation/:uuid/file/:fileId/reupload

POST   /api/folder/create
GET    /api/folder/list
GET    /api/folder/:uuid
POST   /api/folder/reorder

POST   /api/fluffypack/create
GET    /api/fluffypack/list
GET    /api/fluffypack/explore
GET    /api/fluffypack/native-tools
GET    /api/fluffypack/marketplace/agents/search
GET    /api/fluffypack/iam-group/search
GET    /api/fluffypack/user/search
GET    /api/fluffypack/:uuid
PATCH  /api/fluffypack/:uuid
PATCH  /api/fluffypack/:uuid/prepare
GET    /api/fluffypack/:uuid/insights?days=

POST   /api/integration/app/register
GET    /api/integration/app/list
GET    /api/integration/app/admin/list
GET    /api/integration/app/:uuid
PATCH  /api/integration/app/:uuid/cors-origins
PATCH  /api/integration/app/:uuid/owners
GET    /api/integration/app/:uuid/usage?
GET    /api/integration/slack/channel/list
POST   /api/integration/slack/channel
DELETE /api/integration/slack/channel/:id

GET    /api/governance/capabilities
GET    /api/governance/capabilities/:id
GET    /api/governance/capability-changes

POST   /api/subject/generate
POST   /api/speech
POST   /api/error/report
GET    /api/status/openai-swedencentral
GET    /api/stats/feedback/...

# Knowledge-source helpers (used by FluffyPack builder):
GET    /api/wiki/space/check
GET    /api/wiki/page/check
GET    /api/wiki/page/resolve
GET    /api/sharepoint/site/search
GET    /api/sharepoint/path/browse
GET    /api/sharepoint/path/check
GET    /api/sharepoint/validate/file
GET    /api/sharepoint/validate/folder
GET    /api/sharepoint/validate/interpretable-file
GET    /api/sharepoint/validate/site-pages
GET    /api/github/repository/search
GET    /api/github/repository/validate
GET    /api/github/path/browse
GET    /api/jira/project/check
GET    /api/slack/channel/search
GET    /api/aem-live/count
GET    /api/experience-league/count
GET    /api/experience-league/search
GET    /api/helpx/count
GET    /api/helpx/search
GET    /api/developer/count
GET    /api/developer/search
GET    /api/field-readiness/item/search

POST   /api/blog/article/list?limit=&offset=
POST   /api/blog/article/mark-all-read
GET    /api/blog/article/:id
POST   /api/blog/article/:id/kudo
POST   /api/blog/article/:id/read
GET    /api/blog/article/:id/view
GET    /api/blog/article/:id/viewers
```

## Local cached docs

The official docs from `https://fluffyjaws.adobe.com/docs` (8 pages) are
captured in `docs/`:

| File | Source route |
|------|--------------|
| `docs/index.md` | `/docs` |
| `docs/fluffypacks.md` | `/docs/fluffypacks` |
| `docs/api.md` | `/docs/api` |
| `docs/mcp.md` | `/docs/mcp` |
| `docs/python.md` | `/docs/python` |
| `docs/register-app.md` | `/docs/register-app` |
| `docs/fluffypack-builder.md` | `/docs/fluffypack-builder` |
| `docs/slack-channels.md` | `/docs/slack-channels` |

Run `fj docs <page>` to print one without a network call.
