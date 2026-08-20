# Cosmos private API (HAR-derived, live-rechecked)

Host: `https://cosmos.augmentcode.com`. Captured with the `secret-sauce` skill on
2026-08-17 from two HARs (a boot plus session-page load, and a full create-session
flow), then re-checked against a logged-in tab the same day. Nothing here is from
public documentation; Cosmos has none for this surface.

## Transport

Connect / gRPC-web style JSON over HTTP:

```
POST /rpc/<package>.<Service>/<Method>
Content-Type: application/json

{ ...request message... }
```

Response is a JSON object, HTTP 200 on success. Services in use:

| Package.Service | Purpose |
|---|---|
| `web_rpc_proxy.PoseidonProxyService` | sessions ("agents") and environments |
| `web_rpc_proxy.ExpertProxyService` | expert presets, create session from expert |
| `web_rpc_proxy.WebappBootService` | boot config, auth check |
| `web_rpc_proxy.PoseidonImagesProxyService` | base images (superset of environments) |
| `public_api.Augment` | completion models, GitHub integration state |

### GET vs POST on WebappBootService

The web app issues `GetBootConfig` and `IsAuthenticated` as Connect **GET**s. A bare
`GET /rpc/web_rpc_proxy.WebappBootService/GetBootConfig` answers **415**; the query
string is required:

```
GET /rpc/web_rpc_proxy.WebappBootService/GetBootConfig?connect=v1&encoding=json&message=%7B%7D
```

`?encoding=json&message=%7B%7D` alone also works, and so does a plain `POST` with a
`{}` body, which returns byte-identical output (verified live 2026-08-17). The skill
POSTs everything so there is one request path to reason about.

### Unknown fields are ignored, not rejected

`{"pageSize": 2}` on `ListAgents` returns the default 100 rows rather than a 400. A
request that silently does nothing is therefore indistinguishable from a wrong field
name unless you check the response size. Both spellings of a field work
(`pageToken` and `page_token` both paginate), because protojson accepts the proto
field name and its json_name.

## Auth

There is **no** Authorization header, no bearer token and no API key anywhere in
either capture. Requests carry only `Content-Type`, `Referer`, `sec-ch-ua*`,
`User-Agent` and Sentry trace headers. Auth is the **session cookie**.

Consequences for SLICC:

- The realm `fetch()` strips cookie headers and cannot set Origin, so it cannot
  authenticate to this API at all.
- Every call must be issued from the page context of an open Cosmos tab:
  `browser.findTab({ urlMatch: /cosmos\.augmentcode\.com/i })` then
  `browser.fetch(tab, url, ...)`, same as `skills/wunderflats`.
- 401/403, or an HTML body where JSON was expected, means the session expired.

HAR reading note, since it costs an hour every time it is forgotten: in a HAR,
`request.headers` and `response.headers` are arrays of `{name, value}` objects, not
maps. `headers['content-type']` is always `undefined`, so a filter written that way
drops every entry and `stop-recording` leaves an empty directory. Resolve header
lookups through a helper that walks the array case-insensitively.

## Read methods

### `PoseidonProxyService/ListAgents`

Request: `{}`, or `{"limit": 20}`, or `{"limit": 20, "pageToken": "<token>"}`.

- `limit` is real and caps the rows returned. Without it the server returns **100**
  agents, which was **1.2 MB** on a real account. Always send a limit.
- `offset` is not a field (it is ignored). Pagination is `nextPageToken` →
  `pageToken`, verified by comparing the ids of page 1 and page 2.

Response:

```json
{
  "agents": [ { ...agent... } ],
  "totalCount": 285,
  "hasMore": true,
  "nextPageToken": "Chow…"
}
```

Agent object, as seen live:

| Field | Notes |
|---|---|
| `agentId` | 26-char ULID-shaped id, e.g. `01M07QQF8ZPWVGG1TWEWCK9S9W` |
| `agentName` | session title |
| `status`, `detailedStatus` | `AGENT_STATUS_STARTING` / `_PROCESSING` / `_IDLE` |
| `capabilities[]` | `AGENT_CAPABILITY_WEB_ACCESS`, `_GITHUB`, `_GITHUB_APP`, `_LINEAR_APP` |
| `createdAt`, `updatedAt` | RFC 3339, nanosecond precision |
| `createdByUserId` | uuid |
| `capabilityInstanceIds[]` | uuids of attached capability instances (VMs) |
| `tags[]` | includes `expert:<expertId>` |
| `sessionConfig` | `{ model, includeDefaultSystemPrompt, systemPrompt, visibility }` |
| `effectiveRole` | `owner` for the caller's own sessions |
| `expertId`, `environmentId` | the preset and environment the session came from |
| `rootAgentId` | equals `agentId` for a top-level session |
| `workspaceFolders[]` | repo checkouts inside the VM |
| `cliConnected`, `cliVersion`, `pendingMessageCount` | runtime state |

`sessionConfig.systemPrompt` can contain `kb://` includes; it is not secret but it is
long, so the skill does not print it.

### `PoseidonProxyService/BatchGetAgents`

Request `{"agentIds": ["01M07…", "01M07…"]}` → `{"agents": [ ... ]}`, same agent
shape. Verified live. The skill does not use it (one `GetAgent` per id is enough for
the current commands), it is recorded here so a future batch command does not have to
rediscover it.

### `PoseidonProxyService/GetAgent`

Request `{"agentId": "01M07…"}` →
`{"agent": { ...agent... }, "vmErrorInfo": {"vmStatus": "RUNNING"}}`.

The detail response adds `pendingMessageCount`, `hasMcpConfigIds` and
`workspaceFoldersVmId` on top of the list shape. Unwrap defensively: read
`data.agent || data`.

### `PoseidonProxyService/GetMessages`

Request `{"agentId": "01M07…"}` or `{"agentId": "…", "limit": 10}`.

`limit` counts **exchanges**, not messages: `limit: 1` returned 2 messages,
`limit: 3` returned 6, `limit: 10` returned 20, always one `user` and one `assistant`
per unit. The window is the **newest** messages; `hasMore: true` means older ones
exist. An unbounded call returned 100 messages and **304 KB**.

Response:

```json
{
  "messages": [ { "id", "role", "createdAt", "content": [ ... ], "metadata": { ... } } ],
  "hasMore": true,
  "firstMessageId": "…-user",
  "lastMessageId": "…-assistant",
  "agentStatus": "AGENT_STATUS_IDLE",
  "oldestTimestamp": "2026-08-17T10:22:44.738806Z",
  "newestTimestamp": "2026-08-17T11:03:20.342209Z"
}
```

- `role` is `user` or `assistant`. Tool results come back as `user` messages, which is
  why a naive render looks like the human pasted build logs.
- `id` is `<requestId>-user` / `<requestId>-assistant`.
- `content[]` parts are single-key objects naming the part kind. Observed kinds:
  - `{"text": …}`
  - `{"thinking": {"content": "…"}}`
  - `{"toolUse": {"id": "call_…", "name": "read", "input": "<JSON string>"}}`
  - `{"toolResult": {"toolUseId": "call_…", "content": "…", "isError": false}}`
  The inner shape of `text` was never observed on its own, so the skill accepts a bare
  string or a `{content}` / `{text}` wrapper.
- `metadata` carries `requestId`, `turnRequestId`, `isPartial`,
  `persistedThroughEventSeq`, a `tokenUsage` block, and `billingMetadata[]` with
  `costUsd` and `effectiveModelName`. Useful for a future cost command.

### `PoseidonProxyService/ListEnvironments`

Request `{}` →

```json
{ "environments": [ { "id", "kind", "displayName", "description", "visibility",
                      "createdAt", "updatedAt", "createdByUserId",
                      "currentVersion", "status", "poolStatus" } ],
  "totalCount": 3 }
```

`kind` is `ENVIRONMENT_KIND_BASE_IMAGE` or `ENVIRONMENT_KIND_DAEMON_POOL`. Only a
base-image environment id is usable as `override_vm_config.base_image_id`; a
daemon-pool id belongs in `routingTarget.poolId` instead, which this skill does not
expose. `status` is `IMAGE_STATUS_ACTIVE`; pool entries have `poolStatus` instead.

### `ExpertProxyService/ListExpertsWithUsage`

Request `{}`. The response groups experts into **three** arrays, not one:

```json
{ "recentlyUsed": [ { "expert": { … }, "lastUsedAt": "…" } ],
  "popular":      [ { "expert": { … } } ],
  "other":        [ { "expert": { … } } ] }
```

The same expert can appear in more than one group, so flatten and de-duplicate by
`expertId`. Expert object:

| Field | Notes |
|---|---|
| `expertId` | uuid |
| `scope` | `EXPERT_SCOPE_TENANT` |
| `slug` | unique and human-readable, e.g. `pr-author-github-2z4hvjvghl` |
| `config.name` | **not unique**: four experts named "PR Author (GitHub)" existed live |
| `config.description` | one-liner |
| `config.builtinCapabilities[]` | `AGENT_CAPABILITY_*` names |
| `config.sessionConfig.model` | the session model id: `gpt-5-6-sol`, `claude-opus-5`, `claude-opus-4-7` |
| `config.vmConfig` | `{ installGitCredentials, installUserSecrets, baseImageId, resources }` |
| `config.workerExpertIds[]` | experts this one dispatches to |
| `config.userInstructions`, `config.placeholderText` | UI copy, describes what the prompt should be |
| `createdAt`, `updatedAt`, `createdBy`, `resourceVersion`, `origin`, `effectiveRole` | metadata |

Because names collide, name resolution has to fail loudly on ambiguity. The skill
resolves in stages (id, then slug, then exact name, then unique substring) and errors
with the candidate list when a stage matches more than one.

### `ExpertProxyService/GetExpert`

Request `{"expertId": "<uuid>"}` → `{"expert": { … }}`, same object plus
`config.capabilityNames[]` (the short forms, `WEB_ACCESS`, `GITHUB`, …). Responses run
to 70 KB because the full system prompt is inlined. The skill does not use it; recorded
for completeness.

### `PoseidonImagesProxyService/ListBaseImages`

Request `{}` → `{"images": [ { "id", "displayName", "description", "source",
"currentVersion", "lastBuilt", "status", "retentionVersions", "tenantId",
"createdAt", "updatedAt", "modalImageId", "createdByUserId" } ]}`. A superset of
`ListEnvironments` for base-image environments, with build provenance. Not used by the
skill.

### `public_api.Augment/GetModels`

Request `{}` →

```json
{ "default_model": "9c199f09…",
  "models": [ { "name": "45c2c5c9…", "max_memorize_size_bytes": 131072,
                "suggested_prefix_char_count": 4608,
                "suggested_suffix_char_count": 4608, "is_default": true } ] }
```

Note the snake_case response fields. 119 models live, and every `name` is an opaque
64-hex hash. **These are not session model ids.** `override_model` on
`CreateAgentFromExpert` wants `gpt-5-6-sol` style ids, which appear only in
`config.sessionConfig.model` on experts and `sessionConfig.model` on agents. Do not
try to map one to the other.

### Integration probes

Cheap booleans the UI polls at boot. All `{}` requests:

| Method | Response |
|---|---|
| `public_api.Augment/IsUserGithubConfigured` | `{"is_configured": true}` |
| `web_rpc_proxy.LinearProxyService/IsConfigured` | `{}` when not configured |
| `web_rpc_proxy.AtlassianProxyService/IsConfigured` | `{}` when not configured |
| `web_rpc_proxy.SettingsProxyService/GetMcpUserSettings` | `{"settings": {}, "version": "<uuid>"}` |
| `web_rpc_proxy.SettingsProxyService/ListUserSecrets` | user secret names, deliberately never called by this skill |

An absent-but-false boolean serialises as `{}` (proto3 drops default values), so treat
a missing field as false rather than "unknown".

### `WebappBootService/IsAuthenticated`, `WebappBootService/GetBootConfig`

```
IsAuthenticated → {"authenticated": true, "homeCosmosHostname": "cosmos.augmentcode.com"}
GetBootConfig   → {"segment": {"writeKey": "…", "scriptUrl": "…", "cdn": "…"},
                   "authCentralBaseUrl": "https://auth.augmentcode.com"}
```

`segment.writeKey` is a credential-shaped value. The skill redacts it in both human
and `--json` output, since everything a `.jsh` prints lands in an agent transcript.

## Write method: `ExpertProxyService/CreateAgentFromExpert`

This is the delegation primitive. Exactly as the web client sent it:

```json
{
  "expertId": "87db6bd0-4fbc-4620-94e9-0da28169183b",
  "agentName": "<first ~100 chars of the message>",
  "idempotency_key": "<client-generated uuid>",
  "initial_message": "<the full prompt>",
  "override_model": "gpt-5-6-sol",
  "override_visibility": "SESSION_VISIBILITY_SHARED",
  "override_builtin_capabilities": [1, 7, 12, 13],
  "has_override_builtin_capabilities": true,
  "override_vm_config": {
    "base_image_id": "e6117b1e-a264-4537-8e87-f7dd3a524a5c",
    "resources": { "cpuCores": 0.125, "memoryMib": 2048 }
  },
  "override_capability_instance_ids": [],
  "has_override_capability_instance_ids": true,
  "initial_message_request_id": "<client-generated uuid>"
}
```

Response:

```json
{ "agent": { "agentId": "01M07…", "agentName": "…",
             "status": "AGENT_STATUS_STARTING",
             "capabilities": ["AGENT_CAPABILITY_WEB_ACCESS", "AGENT_CAPABILITY_GITHUB",
                              "AGENT_CAPABILITY_GITHUB_APP", "AGENT_CAPABILITY_LINEAR_APP"],
             "createdAt": "…", "updatedAt": "…", "createdByUserId": "…",
             "capabilityInstanceIds": ["…"], "tags": ["expert:<expertId>"] } }
```

Then navigate to `/session?agentId=<agentId>`.

### Field naming is inconsistent, and that is fine

`expertId` and `agentName` are camelCase while `idempotency_key`, `initial_message`,
`override_model` and friends are snake_case, in the same body. That is what the client
sends, so the skill reproduces it rather than normalising. protojson accepts either
spelling for any field, so both would work; matching the capture keeps the request
indistinguishable from the UI's and avoids a debugging detour if the server ever
tightens.

The full request field set, read out of the web app's own bundle
(`sagaRpcClient().createAgentFromExpert({…})`) rather than guessed:

```
expertId, agentName, userRenamed, initialMessage, initialContextMessage,
overrideModel, overrideReasoningEffort, overrideVisibility,
overrideBuiltinCapabilities, overrideVmConfig{baseImageId, resources},
overrideCapabilityInstanceIds, routingTarget{poolId|daemonVmId}, useWorktree,
mcpConfigIds, initialMessageAttachments, initialMessageFileAttachments,
idempotencyKey, initialMessageRequestId, spaceId, vfsFileReferences,
mcpToolReferences
```

`override_visibility` accepts `SESSION_VISIBILITY_SHARED` and
`SESSION_VISIBILITY_PRIVATE` (both strings appear in the bundle's visibility toggle).

### Idempotency

`idempotency_key` and `initial_message_request_id` are both client-generated UUIDs, so
creation is safely retryable: a request that fails after the server committed will not
create a second session when retried with the same keys. The skill mints both per
invocation.

### Why the skill does not send the capability overrides

The paired `has_override_*` booleans prove the server distinguishes "not overriding"
from "overriding with an empty list". Omitting both the array and its flag therefore
means "use the expert's own capabilities", which is what a caller delegating to a
preset wants.

`override_builtin_capabilities: [1, 7, 12, 13]` is the picker state of the UI at
capture time, expressed as enum numbers. The response's `capabilities[]` came back as
`WEB_ACCESS, GITHUB, GITHUB_APP, LINEAR_APP`, in that order, which suggests
1=WEB_ACCESS, 7=GITHUB, 12=GITHUB_APP, 13=LINEAR_APP, but the mapping is an inference
from ordering, not something read from a descriptor: protobuf-es v2 embeds the enum
names in a base64 file descriptor, so they are not greppable in the bundle. Sending
guessed enum numbers for an arbitrary expert could silently grant or drop
capabilities, which is worse than not overriding at all.

Same reasoning for `override_capability_instance_ids`: an instance id points at a
concrete VM, and reusing one from a capture would attach a new session to somebody
else's machine.

`override_vm_config.resources` is likewise omitted unless `--cpu` / `--memory` are
given; the captured values (0.125 cores, 2048 MiB) were the UI's slider state, not a
server default worth freezing into a skill.

## Known gap: message streaming is not HTTP

Neither HAR contains a single `text/event-stream` response or a gRPC streaming frame,
and no long-poll of `GetMessages` shows up while a session is producing output. Live
message updates are therefore almost certainly delivered over a **WebSocket**, which
HAR does not record.

A `watch` command would need one of:

1. **Poll `GetMessages`** with a small `limit` and diff on `lastMessageId` /
   `newestTimestamp`. Simple, works today, costs one request per interval.
2. **Observe the WebSocket** the way `skills/slack` does:
   `browser.websocket.on(tab, { urlMatch }).filter({ parseAs, where, project })
   .forward({ sink: 'webhook', … })`. Filters are declarative JSON only, the observer
   must be idempotent (`if (window.__slicc_observer) return;`), and the webhook has to
   be torn down with the observer or it leaks events across sessions.

Neither is built here. Capture the WebSocket frames first (HAR will not do it) before
committing to a schema.

## Ids seen live, for reference

- expert `87db6bd0-4fbc-4620-94e9-0da28169183b`: "PR Author (GitHub)", model
  `gpt-5-6-sol`, slug `pr-author-github-2z4hvjvghl`
- environment `e6117b1e-a264-4537-8e87-f7dd3a524a5c`: "AI Ecoverse", base image
- agent `01M07QQF8ZPWVGG1TWEWCK9S9W`, agent `01M07GA2SCC1PJ8S7ABGJ6H4VN`

These are one tenant's ids. Resolve them at runtime from the list endpoints; never
hardcode them into a code path, and never fall back to them as a default identity.
