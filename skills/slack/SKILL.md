---
name: slack
description: Interact with Slack via its Web API — read messages, post to channels,
  search channels, read threads, look up users, and watch channels for new messages
  in real time. Use when the user wants to check Slack messages, post a Slack message,
  search Slack channels, read Slack threads, get Slack user info, watch a channel for
  updates, or automate any Slack task. Triggers on mentions of Slack, channels, DMs,
  threads, messages, Slackbot, or watching/monitoring.
allowed-tools: bash
---

# Slack

Direct API access to Slack via the browser session. Uses XHR from the Slack page
context (same-origin) with the user's `xoxc-*` token from `localStorage`.

## Quick start

```bash
# Read recent messages from a channel
slack history C087NCG774J

# Post a message to Slackbot (safe — never messages real people)
slack post <slackbot_dm_id> "Hello from SLICC!"

# Search for channels
slack channels --search=one-aem

# Read a thread
slack thread C087NCG774J 1774539502.747989

# Look up a user
slack user W5BPKRLUA

# Watch a channel for new messages (real-time!)
slack watch C087NCG774J --scoop=my-monitor

# Watch a specific thread
slack watch C087NCG774J --scoop=my-monitor --thread=1774539502.747989

# List active watches
slack watches

# Stop watching
slack unwatch C087NCG774J
```

## Authentication

The token is extracted automatically from `localStorage` key `localConfig_v2` in
the Slack browser tab. The enterprise ID is `E23RE8G4F` (Adobe). All API calls
execute via XHR from the Slack page context so cookies are included automatically.

Requires an open Slack tab at `app.slack.com`. If no Slack tab is found, the script
reports an error and asks the user to open Slack.

## Available commands

### slack history \<channel_id\> [--limit=N]

Fetch recent messages from a channel. Default limit is 20.

### slack post \<channel_id\> \<message\>

Post a message to a channel. Use `slack slackbot` to find the Slackbot DM channel ID.
For safety, posting is restricted to the Slackbot DM only — attempts to post to other
channels are blocked unless `--force` is passed. The Slackbot DM ID is resolved
dynamically via the `conversations.open` API.

### slack channels [--search=term]

Search for channels by name. Uses `search.modules` API (the standard
`conversations.list` is restricted on enterprise grids). Returns channel ID, name,
member count, and purpose.

### slack thread \<channel_id\> \<thread_ts\> [--limit=N]

Read thread replies. Provide the channel ID and the thread's parent timestamp.
Default limit is 50.

### slack user \<user_id\>

Look up user information by user ID. Returns name, display name, title, timezone,
and status.

### slack info \<channel_id\>

Get channel metadata (name, purpose, topic, member count).

### slack slackbot

Opens/finds the Slackbot DM channel and prints its ID.

### slack watch \<channel_id\> --scoop=\<name\> [--thread=\<ts\>] [--force]

Watch a channel or thread for new messages **in real time**. Each new message is
delivered as a lick event to the specified scoop within seconds.

**Options:**
- `--scoop=<name>` — **(required)** the scoop that receives lick events
- `--thread=<thread_ts>` — watch a specific thread instead of the whole channel
- `--force` — replace an existing watch on the same target

**How it works:**
1. Creates a SLICC webhook routed to the target scoop
2. Injects a WebSocket interceptor into the Slack browser tab
3. Slack's existing `wss://wss-primary.slack.com/` connections carry all real-time
   events (messages, typing indicators, etc.)
4. The interceptor filters for `type: "message"` events matching the watched
   channel (and thread if specified)
5. Matching events are POSTed to the webhook → delivered as licks to the scoop

**Lick payload:**
```json
{
  "type": "slack-watch",
  "watchId": "C087NCG774J",
  "channel": "C087NCG774J",
  "thread_ts": null,
  "ts": "1776097845.451319",
  "user": "W5BPKRLUA",
  "text": "Hello world!",
  "subtype": null,
  "event": { /* full Slack WebSocket message event */ }
}
```

**Duplicate prevention:** The watch ID is deterministic from channel + thread.
You cannot create two watches on the same target without `--force`.

**Durability:** The interceptor lives in the Slack tab's page context. If the
page reloads, use `slack reinject` to re-attach the interceptor.

### slack unwatch \<channel_id\> [--thread=\<thread_ts\>]

Stop watching a channel or thread. Deletes the webhook and removes the watch state.

### slack watches

List all active Slack watches with their targets and scoops.

### slack reinject

Re-inject the WebSocket interceptor into the Slack tab. Use after a page reload
or if watches stop firing. This reads all active watch state files and re-installs
the interceptor with the full watch list.

## Watch architecture

The watch system taps directly into Slack's real-time WebSocket infrastructure:

```
Slack servers → wss://wss-primary.slack.com/ → Browser WebSocket
    ↓
Injected interceptor (filters for watched channels)
    ↓
fetch() POST to SLICC webhook URL
    ↓
SLICC delivers lick event to target scoop
```

**Key components:**
- **WebSocket interceptor** — patches `WebSocket.prototype.send` to discover
  existing connections, then wraps `onmessage` on each to filter events
- **SLICC webhook** — one per watch, routes events to the target scoop
- **State files** — at `/workspace/skills/slack/.watch-<id>.json`, track webhook
  IDs and watch configuration

**Why WebSocket interception?** Slack maintains persistent WebSocket connections
to `wss://wss-primary.slack.com/` (one per workspace/team). All real-time events
flow through these connections. By intercepting at the WebSocket level, we get
sub-second latency with zero additional API calls or polling.

**Connection discovery:** The interceptor patches `WebSocket.prototype.send`.
Since Slack sends `{"type":"ping"}` keepalives every ~10 seconds, existing
connections are discovered within one ping cycle.

## Enterprise grid notes

Adobe's Slack is an Enterprise Grid (enterprise ID `E23RE8G4F`). The gateway
WebSocket for the enterprise org is on `gateway_server=T23RE8G4F-*`. Some
standard Web API methods like `conversations.list` and `users.conversations`
return `enterprise_is_restricted`. The skill uses `search.modules`
(module=channels) for channel discovery and `conversations.open` for DM
channel lookup instead.

## Endpoints reference

See `references/endpoints.md` for the full endpoint documentation.
