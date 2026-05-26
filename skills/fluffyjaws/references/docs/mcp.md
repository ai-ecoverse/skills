Advanced Integration
3 quick links
MCP Guide

Connect FluffyJaws to Codex, Claude Desktop, Cursor, and other MCP clients.

API Guide
Python Examples
Start with FluffyJaws

DOCS HELPER

Step-by-step setup

Start with the CLI setup first. That local path works for Codex and for Claude clients that can launch a command on your machine. Use the Cursor remote section only if you specifically want the browser-session-based HTTP flow.

1. CLI setup for Codex and Claude

This is the recommended default. Install the FluffyJaws CLI, sign in once in your terminal, then connect your IDE to the local fj-mcp process.

Step 1: install the FluffyJaws app

Run this in your terminal. It installs both fj and fj-mcp.

INSTALL COMMAND
Copy install command

Step 2: sign in once

Run this after install. A browser window opens so you can sign in with Adobe Okta.

LOGIN COMMAND
Copy login command

Step 3a: connect Codex

Run this in your terminal after the login step. Codex will register the local MCP server for you.

CODEX SETUP
Copy Codex setup

Step 3b: connect Claude Desktop or another local client

Paste this JSON into the MCP settings for any client that launches a local command.

LOCAL MCP CONFIG
Copy local MCP config

If you are not sure which path to use, stop here and use this CLI-based setup. It is the most reliable option for non-technical users.

2. Cursor remote MCP

Use this only in Cursor. It generates a session-backed HTTP config that targets the FluffyJaws MCP endpoint directly.

This exports a reusable credential tied to your active web session. Treat the copied config like a password. Logging out invalidates it. Lifetime is up to 30 days.

I understand this reveals a reusable credential outside the browser.
Generate Cursor config
Copy Cursor config

Confirm the warning above before revealing the Cursor config.

Use MCP when you want another client to call FluffyJaws directly. In most cases, the local CLI path is the right choice.

Use the MCP action panel above as a guided checklist.

Choose the right MCP path
Use local MCP when your client can launch a command on your machine. This is the recommended default for Codex and Claude Desktop.
Use remote HTTP MCP only when your client already expects an HTTP MCP endpoint and you are comfortable managing session or auth details.
Local MCP with fj

This path installs the FluffyJaws CLI, saves your login once, and lets your MCP client connect to a local fj-mcp process.

1. Install the FluffyJaws app

macOS or Linux:

Copy
API_BASE=https://api.fluffyjaws.adobe.com
if curl -fsSL "$API_BASE/" -o /dev/null 2>/dev/null; then
  curl -fsSL "$API_BASE/api/cli/install.sh" | bash
else
  echo "VPN required. Connect to VPN and retry." >&2
  false
fi


Windows PowerShell:

Copy
$ApiBase = "https://api.fluffyjaws.adobe.com"
Invoke-RestMethod "$ApiBase/api/cli/install.ps1" | Invoke-Expression


The macOS/Linux installer creates fj and fj-mcp. The Windows installer creates fj.cmd and fj-mcp.cmd, adds its bin directory to your user PATH, and those commands are available as fj and fj-mcp in new terminals.

2. Sign in once

After install finishes, run:

Copy
fj login --api https://api.fluffyjaws.adobe.com


This opens a browser window so you can complete Adobe Okta sign-in.

Use the same API host here that you pass to fj mcp --api in your MCP client config so the saved session matches the endpoint the CLI will call.

On macOS and Linux, fj stores sessions in ~/.config/fj/session.json (or $XDG_CONFIG_HOME/fj/session.json). The Windows installer stores them in %APPDATA%\\fj\\session.json. In either case, the same login is shared across fj, fj-mcp, and repo checkouts for the same user. Sessions are keyed by API host, so keep the login host and MCP host aligned.

3. Connect your client

If your IDE accepts MCP JSON, paste this:

Copy
{
  "mcpServers": {
    "fluffyjaws": {
      "command": "fj-mcp",
      "args": ["--api", "https://api.fluffyjaws.adobe.com"]
    }
  }
}


If you use Codex in the terminal, run this instead:

Copy
fj login --api https://api.fluffyjaws.adobe.com

codex mcp add fluffyjaws -- fj-mcp --api https://api.fluffyjaws.adobe.com

codex mcp list


Claude Desktop and other local MCP clients can use the same fj-mcp JSON config shown above. The important part is to install the CLI first and to run fj login --api https://api.fluffyjaws.adobe.com before opening the IDE.

For production CLI-backed MCP, log in against https://api.fluffyjaws.adobe.com, not the UI host. If an IDE session is already running and hits an auth error, rerun fj login --api https://api.fluffyjaws.adobe.com and retry the tool call so the MCP process can reload the saved session.

Remote MCP over HTTP
Copy
POST /api/v1/mcp


Use this only when your MCP client already supports HTTP MCP and you want FluffyJaws to be the remote endpoint directly.

If you are signed in to the FluffyJaws web app, the panel above can generate a copy-ready HTTP MCP client block that uses your current fjv3_session. Logging out invalidates that generated config, and the session lifetime is up to 30 days.

This session-backed remote config is currently practical for Cursor. For Codex and Claude, the local CLI-based setup is the safer and more reliable path.

For fluffyjaws_chat, omit the optional model argument unless your client intentionally needs a per-call override.

Initialize a session

Use this first. Result: the response includes an Mcp-Session-Id header for later calls.

Copy
curl -i -X POST \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"initialize",
    "params":{
      "protocolVersion":"2025-11-05",
      "clientInfo":{"name":"external-client","version":"0.1.0"}
    }
  }' \
  https://api.fluffyjaws.adobe.com/api/v1/mcp

List tools

Use this after initialize to confirm the session is working and to see the available tool names.

Copy
curl -X POST \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Mcp-Session-Id: <session-id>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/list"
  }' \
  https://api.fluffyjaws.adobe.com/api/v1/mcp

Call a tool

Use this when you are ready to execute a tool through MCP. Result: FluffyJaws returns the tool result and can stream progress when the client accepts SSE.

Copy
curl -N -X POST \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Mcp-Session-Id: <session-id>" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{
      "name":"google_web_search",
      "arguments":{"query":"latest Adobe Experience Manager release notes"}
    }
  }' \
  https://api.fluffyjaws.adobe.com/api/v1/mcp

HTTP MCP reference

Use this reference when you are implementing an HTTP MCP client directly instead of relying on the CLI wrapper.

Request envelope

Every MCP request is JSON-RPC:

jsonrpc: required string, always 2.0
id: required for request-response calls; omit it only for notifications
method: required string
params: optional object
Headers and session lifecycle
send your normal FluffyJaws auth header, such as Authorization: Bearer $SERVICE_TOKEN
call initialize first without an Mcp-Session-Id header
store the returned Mcp-Session-Id header and send it on later requests
sessions currently expire 30 minutes after initialize
sending an unknown or expired Mcp-Session-Id returns a JSON-RPC error with HTTP 404
if the client sends Accept: text/event-stream on tools/call, FluffyJaws streams progress notifications before the final JSON-RPC result
Supported methods
initialize

Use this first to negotiate the protocol and create the MCP session.

Params:

protocolVersion: optional string; FluffyJaws currently accepts 2025-11-25 and 2024-11-05
clientInfo.name: recommended string
clientInfo.version: recommended string

Result object:

protocolVersion: negotiated protocol version
capabilities: current server capabilities object
serverInfo.name: FluffyJaws
serverInfo.version: current server version string
tools/list

Use this after initialize to discover callable tool names and schemas.

Params:

no params are required

Result object:

tools: array of MCP tool definitions

Each tool definition includes:

name: tool name to pass to tools/call
description: what the tool does
inputSchema or equivalent parameter schema fields exposed by the tool registry
tools/call

Use this to execute one tool.

Params:

name: required tool name
arguments: optional object with the tool arguments
_meta.progressToken: optional value for clients that want progress correlation

JSON response result:

content: array of output parts; FluffyJaws currently returns text blocks
isError: optional boolean set when tool execution failed

SSE response shape when Accept: text/event-stream is present:

zero or more notifications/progress JSON-RPC notifications
one final JSON-RPC response carrying the same content and optional isError
ping and shutdown

Use ping as a lightweight health check after initialize. Use shutdown when the client wants to end the MCP session cleanly.

Default MCP rate limits
MCP_RATE_LIMIT_ENABLED=true by default
MCP_RATE_LIMIT_MAX=30
MCP_RATE_LIMIT_WINDOW_SECONDS=60
AUTH_RATE_LIMIT_* is scoped to LLM stream endpoints and does not apply to MCP
