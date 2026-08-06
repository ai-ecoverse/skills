---
name: slack
description: Interact with Slack via its Web API — read messages, post to channels,
  search channels, read threads, find and look up users by name or email, view activity/notifications, manage
  Slack support requests, and watch channels for new messages in real time. Supports
  multiple workspaces with auto-detection from the active tab. Use when the user wants
  to check Slack messages, post a Slack message, search Slack channels, read Slack
  threads, get Slack user info, view Slack notifications or activity feed, manage Slack
  support tickets/help requests, watch a channel for updates, or automate any Slack task.
  Triggers on mentions of Slack, channels, DMs, threads, messages, Slackbot,
  notifications, activity, support requests, help requests, or watching/monitoring.
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
# (auto-signs with :icecream: and auto-watches for replies for 1h → cone)
slack post C087NCG774J "Hello from SLICC!"

# Post without the auto sign/watch
slack post C087NCG774J "quiet post" --no-sign --no-watch

# DM a user directly (opens DM automatically)
slack post W5BPKRLUA "Hey, quick question..."

# Search for channels
slack channels --search=one-aem

# Read a thread (file/image attachments are shown with their [F...] id)
slack thread C087NCG774J 1774539502.747989

# Download a file shared in a thread (e.g. a screenshot) to view it locally
slack download F0BK6BADTKK --out=/tmp/shot.png

# Upload a file to a channel/DM/thread (optionally with a comment)
slack upload C087NCG774J /tmp/clip.mp3 --thread_ts=1774539502.747989 --comment="voice note"

# Find a user by name (or email) → get their user ID
slack find "Dragos Dascalita"

# Look up a user by ID
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

### Approve/deny workflow

Action buttons expire (often within minutes to hours) and expired clicks may
silently no-op. Always verify by re-listing pending requests after acting:

```bash
# 1. List pending requests — note the timestamp of the target
slack --ws=E06V3987PMY pending

# 2. Approve by timestamp
slack --ws=E06V3987PMY approve 1774846849.585479

# 2b. Or deny by timestamp (use the full command form, not just `deny <ts>`)
slack --ws=E06V3987PMY deny 1770698762.931619

# 3. Verify — the entry should no longer appear in pending
slack --ws=E06V3987PMY pending
```

If step 3 still shows the same entry, the action button has expired. Re-trigger
the request from the original source (e.g. ask the inviter to resend) rather
than retrying the same `message_ts`.

### slack history \<channel_id\> [--limit=N]

Fetch recent messages from a channel. Default limit is 20.

### slack post \<channel_or_user_id\> \<message\>

Post a message to a channel, DM, or user. Accepts channel IDs (`C...`, `D...`, `G...`) directly,
or user IDs (`U...`, `W...`) — in which case a DM is opened automatically.

```bash
# Post to a channel
slack post C087NCG774J "Hello channel!"

# DM a user by user ID (opens DM automatically)
slack post W5BPKRLUA "Hey, quick question..."

# Reply in a thread
slack post C087NCG774J "Got it" --thread_ts=1774539502.747989
```

**Post flags:**

- `--thread_ts=<ts>` — post as a threaded reply to the message with that timestamp.
- `--sign[=<emoji>]` / `--no-sign` — control the auto-sign reaction (see below).
- `--no-watch` — skip the auto reply-watch (see below).
- `--watch-scoop=<name>` — override the scoop the reply-watch routes to (default: the cone).

#### Auto-sign (default-on)

After a **successful** post, the message is automatically signed with an emoji
reaction — `:icecream:` (🍦) by default. This is non-fatal: if Slack rejects the
reaction (`already_reacted`, `invalid_name`, permission errors, etc.) the post
still succeeds (exit 0) and a warning is printed to stderr.

```bash
# Default: signs with :icecream:
slack post C087NCG774J "Deploy is green"        # → "Signed with :icecream:"

# Custom emoji (colons optional — ":robot_face:" or "robot_face" both work)
slack post C087NCG774J "Bot did it" --sign=robot_face
slack post C087NCG774J "Bot did it" --sign :robot_face:

# Opt out entirely
slack post C087NCG774J "no sticker please" --no-sign
```

Works identically for channel posts, DMs, and threaded replies. Uses the
`reactions.add` Web API method (`{ channel, timestamp, name }`, `name` without
colons).

#### Auto-watch for replies, 1 hour (default-on)

After a successful post (and the reaction), a reply-watch is started that
**self-tears-down after one hour**. It reuses the same `slack watch` machinery
(webhook + WebSocket observer + `--filter`). Opt out with `--no-watch`.

- **Thread root** = the `--thread_ts` you replied into, or (for a fresh
  top-level message) the new message's own `ts`.
- **Scope by channel size** — looked up via `conversations.info` `num_members`
  on the resolved channel:
  - **> 100 members** → watch the **thread only** (a `--thread` watch whose
    filter matches messages with `thread_ts === <threadRoot>`), to avoid a
    firehose on a big channel.
  - **≤ 100 members, or a DM / unknown count** → watch the **whole channel**
    (a channel message watch already receives thread-reply events, which carry
    `thread_ts`, so this covers both channel messages and thread replies). The
    filter drops the echo of the just-sent message and subtype/system events.
- **Routing** — replies route to the **cone** by default (`--scoop cone`), so
  they surface directly to you. If the runtime ever rejects the cone as a
  webhook target, it falls back to a standing relay scoop `slack-reply-watch`
  (auto-created if missing). Override with `--watch-scoop=<name>`.
- **1-hour TTL / self-teardown** — `expiresAt` (now + 3600s) and the teardown
  task id are stored in the watch state file
  (`/workspace/skills/slack/.watch-<watchId>.json`). A one-shot `crontask`
  named `slack-autowatch-teardown-<watchId>` is scheduled ~60 min out (cron
  minute/hour computed from **local** time, since the scheduler uses local tz
  while bash `date` is UTC). When it fires it delivers a self-describing lick to
  the watch scoop instructing it to run `slack unwatch <target>` and then
  `crontask delete <itself>` — so the watch is torn down and the task removes
  itself (fires once, no recurrence).
- **Re-posting extends the TTL** — if you post again into a channel/thread that
  is already under an active auto-watch, the existing watch's expiry is
  **extended** (the teardown is rescheduled) instead of erroring or duplicating.

```bash
# Default: signs + watches for replies for 1h, routing to the cone
slack post C087NCG774J "Anyone around to review PR 42?"
#   Signed with :icecream:
#   Watching channel+thread for replies for 1h (routes to cone)

# Route replies to a specific scoop instead of the cone
slack post C087NCG774J "ping" --watch-scoop=my-monitor

# Post without watching
slack post C087NCG774J "fire and forget" --no-watch
```


### slack channels [--search=term]

Search for channels by name. Uses `search.modules` API (the standard
`conversations.list` is restricted on enterprise grids). Returns channel ID, name,
member count, and purpose.

### slack thread \<channel_id\> \<thread_ts\> [--limit=N]

Read thread replies. Provide the channel ID and the thread's parent timestamp.
Default limit is 50. Messages that carry files/images show an extra line per
attachment with its name, type, dimensions, and file id, plus a ready-to-run
`slack download <file_id>` hint — so screenshots shared in a thread are visible
and fetchable.

### slack download \<file_id\> [--out=\<path\>]

Download a file (e.g. a screenshot shared in a thread) to a local path so you can
view it. Resolves the file via `files.info`, then fetches the bytes authenticated
inside the Slack tab (`files.slack.com` needs the session cookie) and writes them
to disk. Get the `<file_id>` from `slack thread` / `slack history` output (shown as
`[F...]`). Alternatively pass `--url=<url_private>` directly. Defaults the output to
`/tmp/<original-name>` when `--out` is omitted.

### slack upload \<channel_id\> \<file\> [--thread_ts=TS] [--comment="..."] [--title="..."]

Upload a local file to a channel, DM, or thread. Accepts a conversation ID or a
user ID (`U.../W...` opens a DM automatically). Uses Slack's 3-step external upload
flow: `files.getUploadURLExternal` → POST the raw bytes (via `curl --data-binary`) →
`files.completeUploadExternal`. `--comment` becomes the message text; `--thread_ts`
posts it as a threaded reply.

```bash
slack upload C087NCG774J /tmp/report.pdf --comment="Q3 numbers"
slack upload C087NCG774J /tmp/voice.mp3 --thread_ts=1774539502.747989 --comment="voice note"
```

### slack find \<name or email\> [--limit=N]

Search for users by name, display name, or email and print their user IDs — the
fastest way to get an ID for `slack post` or `slack user`. Aliases: `users`,
`find-user`. Default limit is 10.

```bash
slack find "Dragos Dascalita"
#   W57QU2CLV  Dragos Dascalita Haut @ddascal — Principal Scientist
slack post W57QU2CLV "Hey, quick question..."
```

Deactivated and bot accounts are labelled (`[deactivated]`, `[bot]`) so you can
tell duplicates apart. Slack has no `users.search` Web API method and
`users.list` is restricted on enterprise grids, so this uses the same edge users
cache (`edgeapi.slack.com/cache/<team>/users/search`) that powers Slack's own
quick switcher. The request is cross-origin, but `browser.fetch` runs in the
Slack tab and the shared `.slack.com` session cookie authenticates the xoxc
token — no extra auth step.

### slack user \<user_id\>

Look up user information by user ID. Returns name, display name, title, timezone,
and status.

### slack info \<channel_id\>

Get channel metadata (name, purpose, topic, member count).

### slack slackbot

Opens/finds the Slackbot DM channel and prints its ID.

### slack watch \<channel_id\> --scoop=\<name\> [--thread=\<ts\>] [--filter=\<js\>] [--force]

Watch a channel or thread for new messages **in real time**. Each new message is
delivered as a lick event to the specified scoop within seconds.

**Options:**
- `--scoop=<name>` — **(required)** the scoop that receives lick events
- `--thread=<thread_ts>` — watch a specific thread instead of the whole channel
- `--filter=<js>` — a JS filter passed to the underlying webhook; it is evaluated
  per forwarded message (`(event) => …`, where `event.body` is the Slack message
  frame) and a falsy result drops the event *before it wakes the scoop*. Use this
  to wake the scoop only on messages you care about (e.g. alerts/escalations)
  instead of every message in the channel. Example:
  `--filter='(e)=>/deploy failed/i.test(JSON.stringify(e.body))'`
- `--force` — replace an existing watch on the same target

**How it works:**
1. Creates a SLICC webhook routed to the target scoop
2. Registers a declarative WebSocket observer on the Slack browser tab via the
   sanctioned `browser.websocket` runtime API (no page-context code injection,
   no prototype patching)
3. Slack's `wss://*.slack.com/` connections carry all real-time events
   (messages, typing indicators, etc.)
4. The observer filters for `type: "message"` frames matching the watched
   channel (and thread if specified)
5. Matching frames are forwarded to the webhook → delivered as licks to the scoop

**Lick payload:** the raw Slack `message` frame that matched the filter, e.g.:
```json
{
  "type": "message",
  "channel": "C087NCG774J",
  "thread_ts": null,
  "ts": "1776097845.451319",
  "user": "W5BPKRLUA",
  "text": "Hello world!",
  "subtype": null
}
```
The watched channel/thread is implicit in the subscription, and the complete
Slack frame is delivered (any additional Slack fields are preserved).

**Duplicate prevention:** The watch ID is deterministic from channel + thread.
You cannot create two watches on the same target without `--force`.

**Durability:** The observer lives in the Slack tab. If the page reloads, use
`slack reinject` to re-register the observers for all active watches.

### slack unwatch \<channel_id\> [--thread=\<thread_ts\>]

Stop watching a channel or thread. Deletes the webhook and removes the watch state.

### slack watches

List all active Slack watches with their targets and scoops.

### slack reinject

Re-register the WebSocket observers on the Slack tab. Use after a page reload
or if watches stop firing. This reads all active watch state files and
re-registers an observer for each.

## Watch architecture

```
Slack servers → wss://*.slack.com/ → Browser WebSocket
    ↓
Runtime WebSocket observer (declarative filter: type=message + channel/thread)
    ↓
forward → SLICC webhook (closed-enum sink)
    ↓
SLICC delivers lick event to target scoop
```

**Operational notes:**
- State files: `/workspace/skills/slack/.watch-<id>.json` (webhook IDs + config)
- One SLICC webhook per watch routes events to the target scoop
- After a page reload, run `slack reinject` to re-register the observers

## Enterprise grid notes

Some Slack workspaces use Enterprise Grid (e.g. Adobe's `E23RE8G4F`). Some
standard Web API methods like `conversations.list` and `users.conversations`
return `enterprise_is_restricted` on these workspaces. The skill uses
`search.modules` (module=channels) for channel discovery and `conversations.open`
for DM channel lookup instead.

## Slack Support Portal

The `slack-support` script manages help requests on Adobe's Slack Support Portal
(`adobe-dx-support.enterprise.slack.com`). It scrapes the server-rendered portal
using `playwright-cli` — no REST API is available. Requires an open browser tab
at the support portal domain.

### Quick start

```bash
# List all help requests
slack-support list

# List only open requests
slack-support list --status=open

# View a specific request with comments
slack-support view 6750592

# Reply to a request
slack-support reply 6750592 "Thanks, that fixed it."

# Create a new request
slack-support create --topic=slack-connect --title="Connect issue" "Cannot invite external user"

# Resolve a request
slack-support resolve 6750592
```

### Available commands

#### slack-support list [--status=open|closed|all]

List help requests. Default shows all. Displays request ID, status, title,
and last updated date.

#### slack-support view \<id\>

View a request's details and comment thread.

#### slack-support reply \<id\> \<message\>

Add a reply to an existing request.

#### slack-support create --topic=\<topic\> --title=\<title\> \<message\>

Create a new help request. Available topics: `audio-video`, `billing-plans`,
`connection-trouble`, `managing-channels`, `managing-members`, `notifications`,
`signing-in`, `slack-connect`, `workflow-builder`, `workspace-migration`.

#### slack-support resolve \<id\>

Mark a request as resolved.

### Authentication

Uses cookie-based auth via the existing browser session at
`adobe-dx-support.enterprise.slack.com`. No separate token is needed — the
`playwright-cli` commands execute in the browser tab context.

## Endpoints reference

See `references/endpoints.md` for the full endpoint documentation.
