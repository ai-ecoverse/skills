---
name: slack
description: Interact with Slack via its Web API — read messages, post to channels,
  search channels, read threads, look up users, view activity/notifications, and watch
  channels for new messages in real time. Supports multiple workspaces with auto-detection
  from the active tab. Use when the user wants to check Slack messages, post a Slack
  message, search Slack channels, read Slack threads, get Slack user info, view Slack
  notifications or activity feed, watch a channel for updates, or automate any Slack task.
  Triggers on mentions of Slack, channels, DMs, threads, messages, Slackbot,
  notifications, activity, or watching/monitoring.
allowed-tools: bash
---

# Slack

Direct API access to Slack via the browser session. Uses XHR from the Slack page
context (same-origin) with the user's `xoxc-*` token from `localStorage`. Supports
multiple workspaces — the active workspace is auto-detected from the Slack tab URL,
or can be specified explicitly with `--workspace`.

## Quick start

```bash
# List available workspaces
slack workspaces

# View activity feed (notifications)
slack activity

# Admin notifications only (channel archiving, etc.)
slack --ws=E06V3987PMY activity --type=admin

# Unread mentions
slack activity --type=mentions --unread

# App DMs (invite requests, Google Drive, etc.)
slack activity --type=apps

# List pending approval requests
slack --ws=E06V3987PMY pending

# Approve or deny a request by timestamp
slack --ws=E06V3987PMY approve 1774846849.585479
slack --ws=E06V3987PMY deny 1770698762.931619

# Read recent messages from a channel (uses active workspace)
slack history C087NCG774J

# Use a specific workspace
slack --workspace=T06DUTYDQ channels --search=helix

# Shorthand
slack --ws=T06DUTYDQ history C06ABC123

# Post a message to a channel
slack post C087NCG774J "Hello from SLICC!"

# DM a user directly (opens DM automatically)
slack post W5BPKRLUA "Hey, quick question..."

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
the Slack browser tab. The workspace ID (team or enterprise ID) determines which
token to use. The `localConfig_v2.teams` object maps workspace IDs to
`{ name, domain, url, token }` — keys are either enterprise IDs (`E...`) or
team IDs (`T...`).

Workspace resolution order:
1. `--workspace=<ID>` or `--ws=<ID>` flag if provided
2. Auto-detected from the active Slack tab URL (`/client/<ID>/...`)

All API calls execute via XHR from the Slack page context so cookies are included
automatically. Requires an open Slack tab at `app.slack.com`. If no Slack tab is
found, the script reports an error and asks the user to open Slack.

## Global flags

### --workspace=\<ID\>, --ws=\<ID\>

Specify which workspace to use by team or enterprise ID. If omitted, the workspace
is auto-detected from the currently active Slack tab URL. Run `slack workspaces` to
see all available IDs. The flag can appear before or after the command name:

```bash
slack --ws=E23RE8G4F history C087NCG774J
slack history C087NCG774J --workspace=E23RE8G4F
```

## Available commands

### slack workspaces

List all workspaces the user is signed into. Shows the workspace ID, name, and
domain. The currently active workspace (from the tab URL) is marked with `*`.

### slack activity [--type=TYPE] [--unread] [--limit=N] [--cursor=CURSOR]

View the activity feed (notifications). Resolves user and channel names inline.
For app DM bundles (invite requests, Google Drive, etc.), fetches the latest
messages from the DM channel to show actual content.

**Type filters:**
- `all` (default) — everything
- `admin` — system alerts (channel archived, workspace changes)
- `mentions` — @user, @usergroup, @channel, @everyone, unjoined channel mentions
- `threads` — thread replies
- `reactions` — emoji reactions on your messages
- `invites` — channel invitations (internal and Slack Connect)
- `apps` — bot/app DM bundles (invite requests, Google Drive, etc.)

**Flags:**
- `--unread` — show only unread items
- `--limit=N` — number of items (default 20)
- `--cursor=CURSOR` — pagination cursor for next page

**Output format:**
```
[2026-04-15 16:19:41 UTC] ADMIN: Amol Anand archived the channel #aem-volvo-redesign *
[2026-04-15 15:54:02 UTC] App DM (5 unread): slackbot: Request to join a Slack Connect channel... *
[2026-04-13 16:24:47 UTC] @mention by Stefan Guggisberg in #mpdm-roman-...
```

Items marked with `*` are unread.

### slack pending [--pages=N] [--json] [--channel=\<id\>]

List pending approval requests (Slack Connect invites, workspace invites) that have
live Approve/Deny action buttons. Pages through the Slackbot DM history, filters
out already-processed requests, and shows a formatted table with timestamps you can
pass directly to `slack approve` or `slack deny`.

**Flags:**
- `--pages=N` — max pages to search (default 10, each page is 100 messages)
- `--json` — output raw JSON instead of a table
- `--channel=<id>` — override the Slackbot DM channel (auto-detected by default)

### slack approve \<message_ts\> [--channel=\<id\>]

Approve an interactive message action (e.g. Slack Connect invite request, workspace
invite). The `message_ts` is the timestamp of the Slackbot notification message
containing the Approve/Deny buttons. Defaults to the Slackbot DM channel; use
`--channel` to override.

Uses the `chat.attachmentAction` API to programmatically click the Approve button.

### slack deny \<message_ts\> [--channel=\<id\>]

Deny an interactive message action. Same as `approve` but clicks the Deny button.

### slack history \<channel_id\> [--limit=N]

Fetch recent messages from a channel. Default limit is 20.

### slack post \<channel_or_user_id\> \<message\>

Post a message to a channel, DM, or user. Accepts channel IDs (`C...`, `D...`) directly,
or user IDs (`U...`, `W...`) — in which case a DM is opened automatically.

```bash
# Post to a channel
slack post C087NCG774J "Hello channel!"

# DM a user by user ID (opens DM automatically)
slack post W5BPKRLUA "Hey, quick question..."

# Reply in a thread
slack post C087NCG774J "Got it" --thread_ts=1774539502.747989
```

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

Some Slack workspaces use Enterprise Grid (e.g. Adobe's `E23RE8G4F`). Some
standard Web API methods like `conversations.list` and `users.conversations`
return `enterprise_is_restricted` on these workspaces. The skill uses
`search.modules` (module=channels) for channel discovery and `conversations.open`
for DM channel lookup instead.

## Endpoints reference

See `references/endpoints.md` for the full endpoint documentation.
