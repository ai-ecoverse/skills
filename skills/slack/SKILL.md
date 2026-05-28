---
name: slack
description: Interact with Slack via its Web API — read messages, post to channels,
  search channels, read threads, look up users, view activity/notifications, and
  manage Slack support requests. Supports multiple workspaces with auto-detection
  from the active tab. Use when the user wants to check Slack messages, post a
  Slack message, search Slack channels, read Slack threads, get Slack user info,
  view Slack notifications or activity feed, or manage Slack support tickets and
  help requests. Triggers on mentions of Slack, channels, DMs, threads, messages,
  Slackbot, notifications, activity, support requests, or help requests.
allowed-tools: bash
---

# Slack

Drives Slack through the user's own logged-in browser session at `app.slack.com`.
Supports multiple workspaces — the active workspace is auto-detected from the
Slack tab URL, or can be specified explicitly with `--workspace`.

### Prerequisites — user actions, not agent actions

Before you can call `slack`, the **user** must:

1. Open https://app.slack.com in their own browser.
2. Sign in to the workspace(s) they want to access.
3. Keep the tab open while the skill is in use.

The agent must never bypass these steps, prompt the user for a password, or
attempt to log in on the user's behalf.

### How authentication works

All API calls run **inside the Slack page** via `playwright-cli eval`. The
workspace token is read from the page session and consumed by the API request
in the same evaluation block — it is never printed, stored, copied to the
agent's context, or written to disk. Only the API response payload leaves
the browser.

If no Slack tab is open, the script exits with a clear error directing the
user to sign in.

### Action safety

Read-only commands (`workspaces`, `activity`, `pending`, `history`, `channels`,
`thread`, `user`, `info`, `slackbot`, `monday`) are safe to run on the user's
behalf. Commands that send messages or take actions on behalf of the user
(`post`, `approve`, `deny`) should be confirmed with the user **before**
invocation — always present the target channel/message and the exact text or
action to the user and wait for explicit approval.

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
```

## Workspace resolution

Workspace resolution order:
1. `--workspace=<ID>` or `--ws=<ID>` flag if provided
2. Auto-detected from the active Slack tab URL (`/client/<ID>/...`)

Run `slack workspaces` to list all signed-in workspaces and their IDs. The
active workspace (from the tab URL) is marked with `*`.

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
