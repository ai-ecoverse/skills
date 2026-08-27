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

# Activity feed (notifications): all, admin-only, unread mentions, app DMs
slack activity
slack --ws=E06V3987PMY activity --type=admin
slack activity --type=mentions --unread
slack activity --type=apps

# Pending approval requests, then approve or deny one by timestamp
slack --ws=E06V3987PMY pending
slack --ws=E06V3987PMY approve 1774846849.585479
slack --ws=E06V3987PMY deny 1770698762.931619

# Read a channel (active workspace), or pick the workspace explicitly
slack history C087NCG774J
slack --workspace=T06DUTYDQ channels --search=helix
slack --ws=T06DUTYDQ history C06ABC123

# Post — prints the new message's ts, auto-signs with :icecream:,
# auto-watches replies for 1h → back to the cone that posted
slack post C087NCG774J "Hello from SLICC!"
slack post C087NCG774J "and part 2" --thread_ts=1787334522.567869   # reply in thread
slack post C087NCG774J "quiet post" --no-sign --no-watch
slack post W5BPKRLUA "Hey, quick question..."   # user ID → DM opened automatically

# Search for channels
slack channels --search=one-aem

# Read a thread (file/image attachments are shown with their [F...] id)
slack thread C087NCG774J 1774539502.747989

# Download a file shared in a thread (e.g. a screenshot) to view it locally
slack download F0BK6BADTKK --out=/tmp/shot.png

# Upload a file to a channel/DM/thread (optionally with a comment)
slack upload C087NCG774J /tmp/clip.mp3 --thread_ts=1774539502.747989 --comment="voice note"

# Find a user by name (or email) → user ID; or look one up by ID
slack find "Dragos Dascalita"
slack user W5BPKRLUA

# Watch a channel or a single thread in real time; list watches; stop watching
slack watch C087NCG774J                 # → this cone (needs SLICC_LICK_TARGET)
slack watch C087NCG774J --scoop=my-monitor
slack watch C087NCG774J --scoop=my-monitor --thread=1774539502.747989
slack watches
slack unwatch C087NCG774J
```

## Authentication

The token is extracted automatically from `localStorage` key `localConfig_v2` in
the Slack browser tab, whose `.teams` object maps workspace IDs — enterprise
(`E...`) or team (`T...`) — to `{ name, domain, url, token }`. All calls execute
via XHR from the Slack page context, so cookies are included automatically. This
requires an open Slack tab at `app.slack.com`; without one the script errors and
asks the user to open Slack.

Workspace resolution order:
1. `--workspace=<ID>` or `--ws=<ID>` flag if provided
2. Auto-detected from the active Slack tab URL (`/client/<ID>/...`)

## Global flags

### --workspace=\<ID\>, --ws=\<ID\>

Which workspace to use, by team or enterprise ID. `slack workspaces` lists the
available IDs. The flag can appear before or after the command name:

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

Click the Approve button on an interactive message (e.g. Slack Connect invite
request, workspace invite) via the `chat.attachmentAction` API. The `message_ts` is
the timestamp of the Slackbot notification message carrying the Approve/Deny
buttons. Defaults to the Slackbot DM channel; use `--channel` to override.

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

### slack history \<channel_id\> [--limit=N] [--json]

Fetch recent messages from a channel. Default limit is 20.

Every line carries the message timestamp as `[ts=<ts>]` — this is the handle for
`slack thread <channel> <ts>` and for `slack post ... --thread_ts=<ts>`. The reply
count is appended when the message has replies: `[ts=1774539502.747989 · 3 replies]`.

`--json` prints the raw `conversations.history` `messages` array (newest first,
exactly as the API returns it) instead of the formatted lines, so `jq` can consume it:

```bash
slack history C087NCG774J --limit=1 --json | jq -r '.[0].ts'
slack history C087NCG774J | grep -o 'ts=[0-9.]*'
```

### slack post \<channel_or_user_id\> \<message\>

Post a message to a channel, DM, or user. Accepts channel IDs (`C...`, `D...`, `G...`) directly,
or user IDs (`U...`, `W...`) — in which case a DM is opened automatically.

```bash
slack post C087NCG774J "Hello channel!"
slack post W5BPKRLUA "Hey, quick question..."   # DM, opened automatically
slack post C087NCG774J "Got it" --thread_ts=1774539502.747989   # threaded reply
```

**Output.** A successful post prints the new message's timestamp and a ready-to-run
reply hint, so a thread can be built without looking the `ts` up anywhere else:

```
Message sent to C087NCG774J at 2026-08-21 17:48:42 UTC
Text: Hello channel!
ts: 1787334522.567869
reply with: slack post C087NCG774J "..." --thread_ts=1787334522.567869
Signed with :icecream:
```

**Posting a thread (two steps):**

```bash
# 1. post the root and capture its ts
ts=$(slack post C087NCG774J "Write-up, part 1 :thread:" | sed -n 's/^ts: //p')

# 2. reply into that thread
slack post C087NCG774J "part 2" --thread_ts="$ts"
slack post C087NCG774J "part 3" --thread_ts=last   # same thread, no bookkeeping
```

**Post flags:**

- `--thread_ts=<ts>` — post as a threaded reply to the message with that timestamp.
- `--thread_ts=last` — reply into the thread root of the most recent message this
  CLI posted in that channel (remembered in a per-workspace-and-channel
  `.last-post-<workspace>-<channel>.json` state file, alongside the `.watch-*.json`
  files). Errors if nothing has been posted there yet, or if the remembered post
  was made by a *different* cone — it prints that timestamp so you can pass
  `--thread_ts=<ts>` deliberately instead of threading under someone else's message.
- `--sign[=<emoji>]` / `--no-sign` — control the auto-sign reaction (see below).
- `--no-watch` — skip the auto reply-watch (see below).
- `--watch-scoop=<name>` — override the scoop the reply-watch routes to (default:
  the cone that posted, from `SLICC_LICK_TARGET`).

Emoji shortcodes in the message are converted to Unicode before sending; a
shortcode that resolves to nothing is refused, so the message never posts with a
literal `:name:` in it. Digits between colons inside a time or ratio
(`09:41:16`, `16:9:1`) are not treated as shortcodes.

#### Auto-sign (default-on)

After a **successful** post the message is signed with an emoji reaction —
`:icecream:` (🍦) by default, via `reactions.add`. Identical for channel posts,
DMs, and threaded replies. Non-fatal: if Slack rejects the reaction
(`already_reacted`, `invalid_name`, permission errors, etc.) the post still
succeeds (exit 0) and a warning goes to stderr.

```bash
# Default: signs with :icecream:
slack post C087NCG774J "Deploy is green"        # → "Signed with :icecream:"
# Custom emoji (colons optional — ":robot_face:" or "robot_face" both work)
slack post C087NCG774J "Bot did it" --sign=robot_face
slack post C087NCG774J "Bot did it" --sign :robot_face:
# Opt out entirely
slack post C087NCG774J "no sticker please" --no-sign
```

#### Auto-watch for replies, 1 hour (default-on)

After a successful post, replies are watched for **one hour**, then the watch
tears itself down. It is silent when idle: a notification arrives only on a
genuine new reply — never a tick, never a poll.

- **Where replies go** — **back to the cone that posted**, so they surface in the
  chat that sent the message. The target is the posting cone's own
  `SLICC_LICK_TARGET` (set by the runtime for every cone that is not the default
  root); with it unset the lick is left untargeted and the runtime picks the
  default root. `--watch-scoop=<name>` routes them to another scoop instead.
- **One watch per channel, and every cone shares them.** The state files live in
  the shared `/workspace/skills/slack/`, so if another cone is already watching
  that channel the post extends that watch and warns you whose it is, printing the
  `slack watch … --force` command to take it over. `slack watches` names the owner.
- **Scope** — channels with **more than 100 members** are watched **thread-only**
  (the thread you replied into, or the new message's own). Everything smaller,
  and every DM, is watched **whole-channel** — which also catches thread replies.
- **Your own messages never notify.** Posting again into a live watch silently
  **extends the hour**.
- `--no-watch` opts out.

```bash
# Default: signs + watches for replies for 1h, routing back to this cone
slack post C087NCG774J "Anyone around to review PR 42?"
#   Signed with :icecream:
#   Watching channel+thread for replies for 1h (routes to cone-helix)
#   (default root, SLICC_LICK_TARGET unset → "routes to the default root cone")
# Route replies to a specific scoop instead of this cone
slack post C087NCG774J "ping" --watch-scoop=my-monitor
# Post without watching
slack post C087NCG774J "fire and forget" --no-watch
```

Internals: `references/watch-architecture.md`.

### slack channels [--search=term]

Search for channels by name. Uses `search.modules` API (the standard
`conversations.list` is restricted on enterprise grids). Returns channel ID, name,
member count, and purpose.

### slack thread \<channel_id\> \<thread_ts\> [--limit=N] [--json]

Read thread replies. Takes the channel ID and the thread's parent timestamp
(from `slack post` output or the `[ts=...]` in `slack history`); default limit 50.
`--json` prints the raw `conversations.replies` `messages` array instead of the
formatted lines. Messages carrying files/images get an extra line per attachment
with name, type, dimensions and file id, plus a ready-to-run
`slack download <file_id>` hint.

### slack download \<file_id\> [--out=\<path\>]

Download a file (e.g. a screenshot shared in a thread) to a local path so you can
view it. Get the `<file_id>` from `slack thread` / `slack history` output (shown as
`[F...]`), or pass `--url=<url_private>` directly. Resolves via `files.info`, then
fetches the bytes authenticated inside the Slack tab (`files.slack.com` needs the
session cookie). Without `--out` the file lands in `/tmp/<original-name>`.

### slack upload \<channel_id\> \<file\> [--thread_ts=TS] [--comment="..."] [--title="..."]

Upload a local file to a channel, DM, or thread. Accepts a conversation ID or a
user ID (`U.../W...` opens a DM automatically), and uses Slack's 3-step external
upload flow (`files.getUploadURLExternal` → raw bytes →
`files.completeUploadExternal`). `--comment` becomes the message text, `--title`
the file title, `--thread_ts` posts it as a threaded reply.

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
tell duplicates apart. Slack has no `users.search` method and `users.list` is
restricted on enterprise grids, so this uses the edge users cache
(`edgeapi.slack.com/cache/<team>/users/search`) behind Slack's own quick switcher:
cross-origin, but `browser.fetch` runs in the Slack tab and the shared
`.slack.com` cookie authenticates the xoxc token — no extra auth step.

### slack user \<user_id\>

Look up user information by user ID. Returns name, display name, title, timezone,
and status.

### slack info \<channel_id\>

Get channel metadata (name, purpose, topic, member count).

### slack slackbot

Opens/finds the Slackbot DM channel and prints its ID.

### slack watch \<channel_id\> [--scoop=\<name\>] [--thread=\<ts\>] [--filter=\<js\>] [--force]

Watch a channel or thread for new messages **in real time**. Each new message is
delivered as a lick event to the target scoop within seconds.

**Options:**
- `--scoop=<name>` — the scoop that receives lick events. Defaults to the calling
  cone (`SLICC_LICK_TARGET`), so plain `slack watch <channel>` wakes whoever ran
  it. **Required** when that variable is unset (the default root), because
  `webhook create` needs a concrete scoop and guessing one could route silently
  wrong.
- `--thread=<thread_ts>` — watch a specific thread instead of the whole channel
- `--filter=<js>` — a JS filter (`(event) => …`, `event.body` is the Slack message
  frame) evaluated per forwarded message; a falsy result drops it *before it wakes
  the scoop*, so the scoop only wakes on messages worth waking for. Example:
  `--filter='(e)=>/deploy failed/i.test(JSON.stringify(e.body))'`
- `--force` — replace an existing watch on the same target

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
The watched channel/thread is implicit, and the complete Slack frame is delivered
(any additional Slack fields are preserved).

**Duplicate prevention:** the watch ID is deterministic from channel + thread, so
you cannot create two watches on the same target without `--force`. Watch state is
shared by every cone in the workspace, so the refusal names the owning cone and
warns when replacing the watch would cut off *another* cone's replies.

Each watch keeps one SLICC webhook plus a state file at
`/workspace/skills/slack/.watch-<id>.json`. Delivery depends on the Slack tab: if
the page reloads, run `slack reinject`. Internals:
`references/watch-architecture.md`.

### slack unwatch \<channel_id\> [--thread=\<thread_ts\>]

Stop watching a channel or thread. Deletes the webhook (which is what stops
delivery), the `+1h` teardown task if present, and the watch state.

### slack watches

List all active Slack watches with their targets, scoops, webhook, and expiry —
across every cone in the workspace, with `[owner: <cone>]` when the owning cone
differs from the webhook's scoop.

### slack reinject

Re-register the WebSocket observers on the Slack tab for all active watches. Use
after a page reload, or if watches stop firing.

### slack monday [--limit=N] [--depth=N] [--date=Nd]

Monday protocol: dump the Slack inbox as a single JSON array for triage. Merges
unread mentions, unread DMs, and unread thread replies, deduplicates them and
sorts newest first. Each item is
`{ id, source, type: mention|dm|thread, title, subtitle, url, ts, body,
participants, meta: { channel, thread_ts, msg_ts } }`, where `body` is the thread
(or DM tail) fetched to `--depth` messages. Every source is non-fatal — a failing
one is skipped rather than aborting the run.

**Flags:**
- `--limit=N` — items per source, and the cap on the final array (default 50)
- `--depth=N` — messages of thread/DM context per item (default 5; `0` skips
  thread fetching, leaving `body` empty for mentions and thread items)
- `--date=Nd` — how far back to look: `Nh`, `Nd` or `Nw` (default `7d`)

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
# List all help requests, or only the open ones
slack-support list
slack-support list --status=open
# View a specific request with its comment thread
slack-support view 6750592
# Reply to a request
slack-support reply 6750592 "Thanks, that fixed it."
# Create a new request
slack-support create --topic=slack-connect --title="Connect issue" "Cannot invite external user"
# Resolve a request
slack-support resolve 6750592
```

### Available commands

- `slack-support list [--status=open|closed|all]` — request ID, status, title and
  last-updated date. Default `all`.
- `slack-support view <id>` — details plus the comment thread.
- `slack-support reply <id> <message>` — add a reply to an existing request.
- `slack-support create --topic=<topic> --title=<title> <message>` — open a new
  request. Topics: `audio-video`, `billing-plans`, `connection-trouble`,
  `managing-channels`, `managing-members`, `notifications`, `signing-in`,
  `slack-connect`, `workflow-builder`, `workspace-migration`.
- `slack-support resolve <id>` — mark a request resolved.

Auth is the existing browser session cookie at
`adobe-dx-support.enterprise.slack.com` — no separate token, since the
`playwright-cli` commands run in the tab context.

## References

- `references/endpoints.md` — full Slack Web API endpoint documentation.
- `references/watch-architecture.md` — internals of `slack watch` and of
  `slack post`'s reply auto-watch (observer, filter, TTL teardown, state files).
