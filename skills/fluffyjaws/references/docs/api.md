Advanced Integration
3 quick links
API Guide

Call FluffyJaws over HTTPS when you need automation, integrations, or app-owned workflows.

Register an Integration
Python Examples
MCP Guide

Use the API when your service, script, or backend workflow needs to stream responses, continue turns, or work with FluffyPacks over HTTPS.

Before you begin

For integrations, use the versioned public routes under /api/v1.

Production API base URL: https://api.fluffyjaws.adobe.com
Production UI base URL: https://fluffyjaws.adobe.com
Local full-stack base URL: http://localhost:3000

Browser CORS access is managed on each external app registration. Owners and admins can register exact HTTPS origins such as https://app.example.com, or wildcard subdomain origins such as https://*.entapp.adproto.com. Bare wildcard domains such as *.entapp.adproto.com are normalized to https://*.entapp.adproto.com.

CORS applies only to public /api/v1/* routes. It allows GET, POST, and OPTIONS; accepts Authorization, Content-Type, and X-User-Token; and exposes X-FluffyJaws-Api-Version and X-FluffyJaws-Api-Stability. Registered origins receive Access-Control-Allow-Credentials: true, so browser-hosted clients may request credentialed CORS when their auth library or fetch wrapper uses credentials: 'include'. Browser integrations should normally authenticate with Authorization: Bearer <Okta access token> from a registered service or OBO flow; on /api/v1/*, an explicit Authorization header takes precedence over any ambient fjv3_session cookie. Cookie delivery is still controlled separately by browser cookie policy.

Choose the auth path that matches your workflow:

Browser session for one-off manual testing as a human
Service token for app-owned automation
Service + X-User-Token when your service needs to act for a specific user
Bearer user token only when you specifically need a raw user token
Recommended order for a new service integration

Follow this order if you are setting up a production integration for the first time:

Create a new Okta service app, or choose an existing Okta app that can request client_credentials tokens.
Register that client in FluffyJaws so ownership and production access are tracked correctly.
Request a service token with the fluffyjaws scope.
Make your first API call.
Add X-User-Token only if the service must act for a specific user.
Core public routes
POST /api/v1/stream
GET /api/v1/conversation/list
POST /api/v1/conversation/create
GET /api/v1/conversation/:uuid
GET /api/v1/feedback/agent/:agentId
GET /api/v1/fluffypack/list
GET /api/v1/fluffypack/explore
GET /api/v1/fluffypack/:uuid
POST /api/v1/mcp

Public responses also include X-FluffyJaws-Api-Version: v1 and X-FluffyJaws-Api-Stability: public.

Public chat model

For external integrations, the public API is stream-first.

Use this mental model:

Send the current turn to POST /api/v1/stream.
Read the response ID from the SSE events.
Send that value back as previousResponseId on the next turn.
Store your own transcript if your application needs conversation history.

The public /api/v1/conversation/* routes are intentionally not the main path documented below. They expose limited metadata and history reads, but the public /api/v1 surface does not currently expose public message-save routes for persisting streamed turns automatically.

Fastest path for manual testing: browser session

Use this when you are a human testing the API once or twice and do not need your own Okta app. Result: you call the API with the same signed-in session the FluffyJaws web app uses.

Copy
export FJ_BASE_URL="\${FJ_BASE_URL:-http://localhost:3000}"

# Open this URL in a browser and sign in with your Adobe Okta account:
$FJ_BASE_URL/api/auth/login

# Then copy the fjv3_session cookie value from your browser
export FJ_SESSION="<paste-fjv3_session_cookie>"

curl \
  -H "Cookie: fjv3_session=$FJ_SESSION" \
  "$FJ_BASE_URL/api/v1/fluffypack/list?scope=discover&limit=10&offset=0"


FluffyJaws expects the fluffyjaws scope on service tokens. If the command succeeds, keep the returned value in $SERVICE_TOKEN and use it in the examples below.

Pure registered service tokens work on the public v1 subset:

GET /api/v1
POST /api/v1/mcp
POST /api/v1/stream for standard chat requests without agentId
GET /api/v1/conversation/list
POST /api/v1/conversation/create
GET /api/v1/conversation/:uuid
GET /api/v1/feedback/agent/:agentId when the registered service client id is temporarily allowlisted for feedback export
GET /api/v1/fluffypack/list
GET /api/v1/fluffypack/:uuid

Those requests run as the registered app owner unless you also send X-User-Token.

On the public /api/v1/* contract, an explicit Authorization header takes precedence over any ambient fjv3_session cookie. That keeps browser-backed API tools from accidentally using a stale FluffyJaws web session instead of the bearer token you meant to test.

If you do not already have an Okta app for this integration, start at https://oss.corp.adobe.com/okta/. The simplest setup is an OpenID Connect service app that can request the fluffyjaws scope, but any Okta app that can mint client_credentials tokens for that scope can work.

Before you request tokens in production:

create or choose the Okta app
register the integration in FluffyJaws
keep the client ID and client secret available for token requests
Copy
export OKTA_PROD_TOKEN_URL="https://adobe.okta.com/oauth2/aus1gan31wnmCPyB60h8/v1/token"
export OKTA_STAGE_TOKEN_URL="https://adobe-stage.okta.com/oauth2/aus1exw340qLpDruL1d8/v1/token"
export OKTA_TOKEN_URL="\${OKTA_TOKEN_URL:-$OKTA_STAGE_TOKEN_URL}"
export OKTA_CLIENT_ID="<your-client-id>"
export OKTA_CLIENT_SECRET="<your-client-secret>"

export SERVICE_TOKEN="$(
  curl -s -X POST "$OKTA_TOKEN_URL" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" \
    -d "client_id=$OKTA_CLIENT_ID" \
    -d "client_secret=$OKTA_CLIENT_SECRET" \
    -d "scope=fluffyjaws" | jq -r '.access_token'
)"

printf '%s\n' "$SERVICE_TOKEN"


If you want the same browser-based login flow without manually copying cookies, use:

Copy
fj login --api https://api.fluffyjaws.adobe.com


Register your app before relying on long-lived service credentials in production. The registration guide below explains both how to create the Okta app and how to register it in FluffyJaws.

Raw user token when you need it

Use this only when you specifically need a bearer user token, such as an on-behalf-of-user flow from your own service. Result: you get an access_token and, if requested, a refresh token.

Bearer user auth uses the Authorization Code + PKCE flow. Request openid profile email, and add offline_access when you need a refresh token.

Use the same Okta issuer for both the authorize step and the token exchange. Your redirect URI must already be registered on the Okta app. A Native OIDC app is the recommended shape for this flow. In production Adobe Okta, localhost redirect URIs may be disallowed, so use an HTTPS redirect URI you control.

1. Build the authorize URL
Copy
export OKTA_ISSUER="https://<your-okta-domain>/oauth2"
export OKTA_CLIENT_ID="<your-user-app-client-id>"
export REDIRECT_URI="https://<your-https-redirect-host>/callback"
export OKTA_SCOPES="openid profile email offline_access"

export CODE_VERIFIER="$(python3 -c 'import secrets; print(secrets.token_urlsafe(64))')"
export CODE_CHALLENGE="$(
  printf '%s' "$CODE_VERIFIER" |
    openssl dgst -binary -sha256 |
    openssl base64 |
    tr '+/' '-_' |
    tr -d '='
)"
export STATE="$(openssl rand -hex 16)"

python3 - <<'PY'
import os
from urllib.parse import urlencode

authorize_url = (
    f'{os.environ["OKTA_ISSUER"]}/v1/authorize?'
    + urlencode(
        {
            "client_id": os.environ["OKTA_CLIENT_ID"],
            "response_type": "code",
            "response_mode": "query",
            "scope": os.environ["OKTA_SCOPES"],
            "redirect_uri": os.environ["REDIRECT_URI"],
            "state": os.environ["STATE"],
            "code_challenge_method": "S256",
            "code_challenge": os.environ["CODE_CHALLENGE"],
        }
    )
)
print(authorize_url)
PY


Open the printed URL in a browser, sign in, and copy the code query parameter from the callback URL. Result: you have the authorization code needed for the token exchange.

2. Exchange the authorization code for tokens
Copy
export AUTHORIZATION_CODE="<paste-the-code-query-param-from-your-callback>"

curl -s -X POST "$OKTA_ISSUER/v1/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "client_id=$OKTA_CLIENT_ID" \
  -d "redirect_uri=$REDIRECT_URI" \
  -d "code_verifier=$CODE_VERIFIER" \
  -d "code=$AUTHORIZATION_CODE"


Use the returned access_token as Authorization: Bearer .... If you requested offline_access, keep the returned refresh_token and refresh it against the same $OKTA_ISSUER/v1/token endpoint.

For simple human testing, the browser-session path above is easier.

Stream a first turn
Copy
curl -N \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.4",
    "messages":[{"role":"user","content":"Summarize the last deployment."}],
    "canvasMode":true,
    "webSearchEnabled":false
  }' \
  https://api.fluffyjaws.adobe.com/api/v1/stream


Use this when you want a live response stream. Result: the server sends SSE events until the response is complete.

Watch the SSE payload for response.created or response.completed, then keep the returned response.id. That is the value you reuse as previousResponseId on the next turn.

Continue the same public thread

Use this when you want multi-turn continuity without relying on server-managed conversation state. Once previousResponseId is present, FluffyJaws can continue the same model thread and only the latest turn needs to be sent.

Copy
curl -N \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.4",
    "previousResponseId":"resp_123456789",
    "messages":[{"role":"user","content":"Now turn that into three bullets."}]
  }' \
  https://api.fluffyjaws.adobe.com/api/v1/stream

Stream a response with an inline attachment

Inline attachments extend the current /api/v1/stream request body. Send an input_file content item in the same user message and FluffyJaws uploads it before invoking the model.

Copy
FILE_B64="$(base64 < ./report.csv | tr -d '\n')"

curl -N \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\":\"gpt-5.4\",
    \"messages\":[
      {
        \"role\":\"user\",
        \"content\":[
          {\"type\":\"input_text\",\"text\":\"Analyze the attached CSV and summarize anomalies.\"},
          {\"type\":\"input_file\",\"filename\":\"report.csv\",\"mime_type\":\"text/csv\",\"file_data\":\"$FILE_B64\"}
        ]
      }
    ]
  }" \
  https://api.fluffyjaws.adobe.com/api/v1/stream


Notes:

input_file is only supported on user messages
mime_type is optional, but recommended; it is required when the filename has no supported extension
data URLs such as data:text/csv;base64,... are accepted in file_data
inline attachments are limited to 20 MB per file
inline attachments are limited to 30 MB total decoded file bytes per request
top-level fileIds still works for already-uploaded reusable files
inline attachments are not supported when agentId is present
Service on behalf of user
Copy
curl -N \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "X-User-Token: Bearer $USER_TOKEN" \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"gpt-5.4",
    "messages":[{"role":"user","content":"Summarize the last deployment."}]
  }' \
  https://api.fluffyjaws.adobe.com/api/v1/stream


Use this when your service needs to act for a specific person. Result: the request runs with the service identity plus the delegated user context.

Reference for core public routes

Use the examples above for the quickest working calls. Use the reference below when you need the exact params, request fields, or response objects for the public routes that matter for external integrations.

POST /api/v1/stream

Use this when you want a live assistant response over Server-Sent Events. This is the main public chat endpoint.

Required headers:

Accept: text/event-stream
Content-Type: application/json

Auth accepted:

browser session
bearer user token
registered service token
registered service token plus X-User-Token when you need delegated user context

Request body:

model: required string
messages: required array of chat messages
previousResponseId: optional string; continue the same FluffyJaws model thread
canvasMode: optional boolean, default true
webSearchEnabled: optional boolean, default true
reasoningEffort: optional low, medium, or high
agentId: optional string; routes the turn to an A2A agent
a2aContextId: optional string; continue an earlier A2A thread
a2aUserTokenOverride: optional development-only local browser testing token override
fileIds: optional string array; use already-uploaded reusable files
fluffyPackUuid: optional string; the caller must have access to that pack

Each messages[] item includes:

role: required user or assistant
content: required string for the simple case, or an array of content items for advanced input

Supported content item shapes for advanced input:

{"type":"input_text","text":"..."}
{"type":"input_file","filename":"report.csv","file_data":"<base64>","mime_type":"text/csv"}

Common SSE events:

response.created: response accepted and assigned an ID
response.output_text.delta: incremental assistant text in delta
response.output_text.delta may include renderMode: "instant" for large table blocks that clients should append without a typewriter delay
response.output_text.done: final text block in text
response.content_part.done: completed content part, including annotations such as citations
response.completed: terminal success event
response.failed: terminal failure with an error object
error: backend-raised error with a message
tool_executing and tool_complete: tool lifecycle helpers
response.function_call_output: tool output payload returned to the client
a2a.context: agent routing context ID for later turns
[DONE]: stream sentinel after the terminal event

Use response.id from response.created or response.completed as the next previousResponseId.

Notes:

if you send agentId with a service token, also send X-User-Token
a2aUserTokenOverride is accepted only by a backend running with ENVIRONMENT=development
if previousResponseId is present, you can send only the latest user turn instead of replaying the full transcript
inline input_file attachments are only supported on user messages
inline input_file attachments are not supported when agentId is present
GET /api/v1/fluffypack/list

Use this when you need a paginated list of accessible FluffyPacks.

Auth accepted:

browser session
bearer user token
registered service token

Query params:

scope: optional string: all, builtin, discover, mine, recent, or recommended; default all
q: optional string search query
limit: optional integer from 1 to 100, default 24
offset: optional integer, default 0

Response object:

fluffyPacks: array of FluffyPack summaries
hasMore: boolean
totalCount: total matching packs
limit: applied page size
offset: applied page offset
recommended summaries can include recommendation.reasonCode, reasonLabel, reasonDetails, and score; this scope returns at most the top five packs prioritized by same-team usage, usage below you in the org, usage near your manager chain, adjacent-team usage, and packs maintained near your org

Each FluffyPack summary includes:

uuid, name, description
systemPrompt, icon, iconColor, uiConfig
lastUsedDate, isBuiltIn
ownerUsername, ownerDisplayName
authorized, canManage
integrations: lightweight configured integration summaries, including selected Marketplace agents when present
createdDate, modifiedDate
GET /api/v1/fluffypack/explore

Use this when you want the same grouped discovery data the UI uses for the FluffyPack picker.

Query params:

q: optional string search query applied to every group

Response object:

recommended: a FluffyPack list response for the top five packs used by nearby peers
recent: a FluffyPack list response for the caller's recently used packs
builtin: a FluffyPack list response for built-in packs
discover: a FluffyPack list response for non-built-in packs

Explore responses are optimized for picker rendering. Section totalCount reflects the loaded card count, while hasMore tells the UI whether it can request another page from /fluffypack/list.

GET /api/v1/fluffypack/:uuid

Use this when you need a pack's detail object, metadata, tools, and configuration blocks.

Path params:

uuid: required FluffyPack UUID

Top-level response fields:

uuid, name, description, systemPrompt
icon, iconColor, uiConfig, isBuiltIn
ownerUsername, ownerDisplayName
authorized, canManage
createdDate, modifiedDate
tools: enabled tool definitions with grouped datasource summaries
accessRules: sharing rules
admins: pack admins
configDataSources: configured search and datasource entries
configInterpretableFiles: configured interpretable file definitions
slackIntegration: Slack reply-channel configuration when enabled

For most integrations, /fluffypack/list is enough. Use /fluffypack/:uuid when you need the full pack shape for rendering or management workflows.

GET /api/fluffypack/:uuid/insights

Use this browser-session route for the FluffyPack Insights dashboard. The caller must be able to manage the pack: owner, configured FluffyPack admin, or global admin.

Query params:

days: optional integer: 7, 30, or 90; default 30

Response object:

pack: pack UUID and name
windowDays: applied time range
summary: conversation count, message count, active people, and last-used date
dailyUsage: daily conversation, message, and active-people counts
topUsers: top people by recent activity
recentActivity: latest activity rows without message text or transcripts
Local validation profile

When you want to validate against the local full stack, keep FluffyJaws local and use the stage Okta issuer for bearer tokens:

Copy
export FJ_BASE_URL="http://localhost:3000"
export OKTA_TOKEN_URL="https://adobe-stage.okta.com/oauth2/aus1exw340qLpDruL1d8/v1/token"

Default rate limits
LLM stream rate limiting is disabled unless AUTH_RATE_LIMIT_ENABLED=true
when enabled, the user bucket defaults to 20 requests per 60 seconds
when enabled, the service bucket defaults to 30 requests per 60 seconds
stream limits apply to POST /api/stream and POST /api/v1/stream
MCP rate limiting is enabled by default at 30 requests per 60 seconds per identity
