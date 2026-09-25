---
name: slack
description: Interact with Slack via its Web API — read messages, post to channels,
  search message text, search channels, read threads, find and look up users by name, username, or email, view activity/notifications, manage
  Slack support requests, and watch channels for new messages in real time. Supports
  multiple workspaces with auto-detection from the active tab. Use when the user wants
  to check Slack messages, post a Slack message, search Slack messages or message text,
  search Slack channels, read Slack threads, get Slack user info, view Slack notifications
  or activity feed, manage Slack support tickets/help requests, watch a channel for
  updates, or automate any Slack task. Triggers on mentions of Slack, channels, DMs,
  threads, messages, Slackbot, notifications, activity, support requests, help requests,
  watching/monitoring, or searching message text. Also provides slack-ext for admin
  user-management (guest conversion, guest channels) and Slack app manifest
  reads and diffs.
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

# Search message text (not users -- use "slack find" for users)
slack search "deploy failed"
slack search '"AdobeSkills/1.0"' --ws=T06DUTYDQ   # exact phrase

# Read a thread (file/image attachments are shown with their [F...] id)
slack thread C087NCG774J 1774539502.747989

# Download a file shared in a thread (e.g. a screenshot) to view it locally
slack download F0BK6BADTKK --out=/tmp/shot.png

# Upload a file to a channel/DM/thread (optionally with a comment)
slack upload C087NCG774J /tmp/clip.mp3 --thread_ts=1774539502.747989 --comment="voice note"

# Find a user by username (@handle), real name, or email → user ID
slack find tripod
slack find @rofe
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

Authors print as `Real Name (@username, ID)` whenever Slack returned those
fields. User mentions (`<@U…>` / `<@W…>`) expand to the same triple; channel
mentions (`<#C…>` / `<#C…|name>`) expand to `#name (C…)`. Lookups are batched
(edge `users/info`, then `users.info`) so a long thread does not N+1.

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
  Ownership is the posting cone itself, so using `--watch-scoop` on an earlier post
  does not stop you chaining onto it.
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

### slack search \<query\> [--limit=N] [--page=N] [--sort=timestamp|score] [--json]

Search message text across the workspace using Slack's `search.messages` API.
Returns matching messages with timestamps, channels, authors, text snippets, and
permalinks. Default limit is 20, sorted by `timestamp` (newest first). Results are
scoped to the token's workspace, so `--ws=<ID>` selects which workspace is searched.

**This searches messages.** To search users, use `slack find`. To search channels,
use `slack channels --search`.

**Flags:**
- `--limit=N` -- number of results per page (default 20)
- `--page=N` -- page number, 1-based (default 1)
- `--sort=timestamp|score` -- sort order (default `timestamp`)
- `--json` -- dump the raw API response

**Exact-phrase matching.** Slack tokenizes unquoted terms and matches loosely. For
example, searching `AdobeSkills` returned 678 hits because it also matched
`adobe/skills`. Wrapping the term in double quotes makes it an exact phrase:
`"AdobeSkills/1.0"` returned 0 hits. When hunting an exact string, always quote it.

```bash
# Search for messages mentioning a topic
slack search "deploy failed"

# Exact phrase -- the double quotes are part of the query
slack search '"AdobeSkills/1.0"' --ws=T06DUTYDQ

# Page through results sorted by relevance
slack search "incident postmortem" --sort=score --page=2

# Raw JSON for scripting
slack search "outage" --limit=5 --json | jq '.messages.matches[].permalink'
```

### slack thread \<channel_id\> \<thread_ts\> [--limit=N] [--json]

Read thread replies. Takes the channel ID and the thread's parent timestamp
(from `slack post` output or the `[ts=...]` in `slack history`); default limit 50.
Human output uses the same author triple and mention/channel expansion as
`slack history`. `--json` prints the raw `conversations.replies` `messages`
array instead of the formatted lines. Messages carrying files/images get an extra
line per attachment with name, type, dimensions and file id, plus a ready-to-run
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

### slack find \<name, username, or email\> [--limit=N]

Search for users by **username** (`@handle`, with or without the `@`), real name,
display name, or email and print their user IDs — the fastest way to get an ID
for `slack post` or `slack user`. Aliases: `users`, `find-user`. Default limit is 10.

Each hit prints **id**, **@username**, and **full/real name**, plus title when
present:

```bash
slack find tripod
#   W4R5LUW5P  Tobias Bocanegra @tripod — Senior Principal Scientist
slack find rofe
#   W4RPXRGKD  Raphael Wegmueller @rofe — Director of Engineering
slack find uncled
#   W4RPL6X6X  David Nuescheler @uncled — Fellow & VP, Developer Platform & Ecosystem
slack find "Dragos Dascalita"
#   W57QU2CLV  Dragos Dascalita Haut @ddascal — Principal Scientist
slack post W57QU2CLV "Hey, quick question..."
```

A short username like `rofe` also matches many real names (`Robert …`) in the
edge cache, so handle-shaped queries run both the bare token and `@token` and
rank an exact username match first.

Deactivated and bot accounts are labelled (`[deactivated]`, `[bot]`) so you can
tell duplicates apart. Slack has no `users.search` method and `users.list` is
restricted on enterprise grids, so this uses the edge users cache
(`edgeapi.slack.com/cache/<team>/users/search`) behind Slack's own quick switcher:
cross-origin, but `browser.fetch` runs in the Slack tab and the shared
`.slack.com` cookie authenticates the xoxc token — no extra auth step. Do not
add a `users.list` crawl.

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
- `--force` — replace an existing watch on the same target, deleting its webhook
  and its `+1h` teardown task (leaving that task alive would tear the replacement
  down an hour later)

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

## Admin user management (`slack-ext`)

`slack-ext` exposes Slack's legacy `users.admin.*` namespace for converting
users between account types and managing guest channel access. It is a
separate command from `slack` because it uses admin-only API methods that
require a different usage pattern and carry stronger safety requirements.

**Important caveats before using:**

- **Audit attribution**: these calls use the `xoxc` browser session token and
  are **indistinguishable from the human's own direct actions** in Slack's
  channel event history. A concrete case: `#aem-fedex` (`C0C2CUUDWLE`) was
  archived by Zapier at 2026-09-17T00:17:04Z; the channel event log records
  Lars Trieloff as the actor because Zapier ran on his user OAuth token — no
  bot identity visible. These commands do the same thing. The Enterprise Audit
  Logs API (`auditlogs:read`) would record the acting app, but `admin.audit.*`
  methods return `unknown_method` (six variants probed). Operators must
  understand this before using these commands.
- **Token restriction**: bot tokens (`xoxb`) are rejected with
  `not_allowed_token_type`. Only the `xoxc` browser session token works.
- **Undocumented legacy endpoints**: these methods live in the
  `users.admin.*` namespace, which is separate from the documented
  `admin.users.*` namespace. They are not in Slack's public API docs and
  could change without notice.
- **Dry-run by default**: every mutating command prints what would happen
  and exits without making any API call unless `--confirm` is supplied.

### Quick start

```bash
# Check a user's current type and guest channels
slack-ext --ws=T06DUTYDQ status W5BPKRLUA

# Convert a member to a single-channel guest (dry run first)
slack-ext --ws=T06DUTYDQ set-single W5BPKRLUA --channel=C0899S7HV0E
slack-ext --ws=T06DUTYDQ set-single W5BPKRLUA --channel=C0899S7HV0E --confirm

# Convert a member to a multi-channel guest
slack-ext --ws=T06DUTYDQ set-multi W5BPKRLUA --confirm

# Promote a guest back to regular member (inverse of set-single / set-multi)
slack-ext --ws=T06DUTYDQ set-member W5BPKRLUA --confirm

# Add or remove a channel on a multi-channel guest
slack-ext --ws=T06DUTYDQ add-channel W5BPKRLUA --channel=C0899S7HV0E --confirm
slack-ext --ws=T06DUTYDQ remove-channel W5BPKRLUA --channel=C0899S7HV0E --confirm
```

### Available commands

#### slack-ext status \<user_id\>

Show the user's current account type and, for guests, the channels they
have access to. Read-only; no `--confirm` needed.

Output includes: real name, username, display name, account type
(regular / multi-channel guest / single-channel guest / bot / deactivated),
and a channel list for guests.

```bash
slack-ext --ws=T06DUTYDQ status W5BPKRLUA
slack-ext --ws=T06DUTYDQ status W5BPKRLUA --json   # include raw users.info object
```

#### slack-ext set-single \<user_id\> --channel=\<ID\> [--confirm]

Convert a member to a **single-channel guest** (Slack API:
`users.admin.setUltraRestricted`). The user loses access to all channels
except the specified one. Requires `--ws` and `--channel`. Without
`--confirm`, shows what would happen and exits without changing anything.

The API parameter is `channel` (singular) — passing `channels` returns
`invalid_arguments`. This is a known gotcha; the code and tests enforce it.

#### slack-ext set-multi \<user_id\> [--confirm]

Convert a member to a **multi-channel guest** (API: `users.admin.setRestricted`).
After converting, use `add-channel` to grant channel access. Requires `--ws`.

#### slack-ext set-member \<user_id\> [--confirm]

Promote a guest back to a **regular member** (API: `users.admin.setRegular`).
This is the inverse of `set-single` and `set-multi`. Requires `--ws`.

#### slack-ext add-channel \<user_id\> --channel=\<ID\> [--confirm]

Invite a multi-channel guest to an additional channel (`conversations.invite`).
Requires `--ws` and `--channel`. Already-in-channel returns a no-op message.

#### slack-ext remove-channel \<user_id\> --channel=\<ID\> [--confirm]

Remove a guest from a channel (`conversations.kick`). Requires `--ws` and
`--channel`. Not-in-channel returns a no-op message.

### Safety policy

Every mutating command enforces four checks before touching Slack:

1. **Explicit confirmation** — `--confirm` is required. Without it the
   command prints a full dry-run summary and exits 0.
2. **User resolution** — the target user's real name, handle, and current
   account type are displayed before any change.
3. **Bot refusal** — bot users are always rejected. Bot account types are
   owned by their app; forcing them to guest status would be destructive.
4. **Already-in-state** — if the user is already in the requested state
   the command says so and exits without calling Slack.

### Workspace ID (`--ws`)

All commands accept `--ws=<TEAM_ID>` (or `--workspace=<TEAM_ID>`). For
mutating commands it is required, because `team_id` is a required API
parameter and silently defaulting to the wrong workspace could affect the
wrong person. For `status` it falls back to auto-detection from the Slack
tab URL.

Run `slack workspaces` to list available workspace IDs.

### Verifying without side effects

To confirm that auth, permissions, and parameter shape are all correct
without changing a real user, use a deliberately invalid user id such as
`U000000BOGUS0`. A correctly formed call returns `user_not_found`, which
proves the token and method are working. This was used to verify all three
`users.admin.*` methods before filing the PR that added this feature.

## App manifest management (`slack-ext app`)

`slack-ext app` wraps Slack's **App Manifest API** so app configuration (name,
bot scopes, event subscriptions) can be read, reviewed and changed from the CLI
instead of the app-settings web UI. Reads — `export`, `show`, `validate`, `diff`.
Writes (all requiring `--confirm`) — `set-scopes`, `set-events`,
`set-request-url`, `apply`, `token-rotate`.

Why an API and not the web UI: `api.slack.com/apps/<id>/oauth` now 302s into
`app.slack.com/app-settings/...`, part of the Slack client SPA. In a fresh tab
it renders zero controls and takes 30+ seconds when it renders at all, and its
workspace picker is a Slack Kit `.c-basic-select` that ignores every synthetic
event (clicks on the placeholder and on `.c-select_button`, Enter/Space/ArrowDown
KeyboardEvents, and a full pointerdown/mousedown/pointerup/mouseup/click
sequence all leave `aria-expanded="false"`). Verified 2026-09-18. There is
deliberately no browser automation in these commands.

### The export-modify-update rule

`apps.manifest.update` has **no merge semantics**. Measured live, 2026-09-18:

- **Omitting a field DELETES it.** Omitting `display_information.description`
  removed it from the live app.
- **Arrays are REPLACED WHOLESALE.** Sending `bot_events: ["channel_created"]`
  removed `team_join` outright.
- **A partial manifest VALIDATES `ok=true`.** A `display_information`-only
  payload passes `apps.manifest.validate` (re-confirmed live with a real app
  configuration token), so the API will accept a payload that silently strips
  the bot user, every scope and every event subscription. The validator catches
  only *some* incoherence, which is worse than blanket rejection: the dangerous
  payloads are the ones that pass.

Therefore **every write exports the live manifest, modifies that object, and
sends the complete result** — never a hand-written partial. This is enforced
structurally: all five write commands go through one internal helper
(`updateFromLiveManifest`) that exports first, refuses to continue if the export
failed or carried no manifest, mutates a clone of it, and is the only call site
for `apps.manifest.update` in the file.

One measured exception: `display_information.background_color` survived being
omitted, because it can never be null. That is one field, **not** merge
semantics — generalising from it is exactly the wrong conclusion.

### The `--allow-deletions` gate

Before any write, the command prints the same leaf-by-leaf diff `app diff`
produces, and then classifies the deletions:

- **Requested** deletions — what `set-scopes --remove` / `set-events --remove`
  were explicitly asked to drop — proceed with `--confirm` alone.
- **Unrequested** deletions — anything outside the field the command owns, and
  every omission in an `app apply` file — are a **hard stop even with
  `--confirm`**. The refusal names each one by JSON pointer and nothing is sent.
  Re-run with `--allow-deletions` once every named deletion is intended.

`app apply` has a second layer: without `--allow-deletions` its payload is the
file **overlaid on a fresh live export**, so a field the file omits is preserved
rather than deleted, while the diff shown is still live-vs-FILE so the operator
sees every omission. With `--allow-deletions` the file is sent as the complete
manifest and the deletions really happen. The gate and the overlay are
independent, so a bug in one does not silently wipe an app.

### `permissions_updated` means REINSTALL

`permissions_updated: true` in the update response means the app must be
**reinstalled** before a newly added scope reaches the live bot token — adding a
scope to the configuration alone does not grant it, and calls with the old token
keep failing on `missing_scope` until it is reissued. Every write command surfaces
this prominently; `--json` reports it as `permissions_updated` and
`reinstall_required`.

`apps.manifest.create` and `apps.manifest.delete` are real methods and are
**deliberately never wired up**. Deleting a Slack app is unrecoverable, and
there is no reason for a CLI to offer it; a guard in the script refuses those
two method names before any request is made.

### Authentication (a third, separate credential)

These commands use an **app configuration token** (`xoxe.xoxp-...`) sent as
`Authorization: Bearer <token>`. It is **not** the bot `xoxb` token and **not**
the `xoxc` session token every other command in this skill uses. There is no
fallback between them: `xoxb-` and `xoxc-` values are rejected with an
explanatory error rather than being tried.

Resolution order: `--token=<tok>` → `$SLACK_APP_CONFIG_TOKEN` → skill config key
`appConfigToken`.

Minting the first token is a **human step in the browser and cannot be
automated** (the workspace picker is the unautomatable Slack Kit control
described above):

1. Open `api.slack.com/apps`.
2. Scroll to **Your App Configuration Tokens**.
3. **Generate Token** → pick a workspace → **Generate**.

These tokens are short-lived and are rotated with `slack-ext app token-rotate`
(see below). A SLICC masked secret works: a session secret named
`SLACK_APP_CONFIG_TOKEN` scoped to `slack.com` is unmasked by the kernel at
request time. The script therefore does **not** shape-check the token value
beyond rejecting `xoxb-`/`xoxc-`, because a masked secret is opaque hex inside
the script.

### Quick start

```bash
# Human summary of the live app configuration
slack-ext app show A0123456789

# Save the live manifest, edit it, then see exactly what an update would change
slack-ext app export A0123456789 --out=./manifest.json
slack-ext app diff A0123456789 --manifest=./manifest.json

# Ask Slack whether a candidate manifest is well-formed
slack-ext app validate A0123456789 --manifest=./manifest.json

# Writes: dry run first (prints the diff, changes nothing), then --confirm
slack-ext app set-scopes A0123456789 --add=reactions:read
slack-ext app set-scopes A0123456789 --add=reactions:read --confirm
slack-ext app set-events A0123456789 --remove=team_join --confirm
slack-ext app set-request-url A0123456789 https://relay.example.com/slack --confirm
slack-ext app apply A0123456789 --manifest=./manifest.json --confirm

# Rotate the configuration token pair (invalidates the old refresh token)
slack-ext app token-rotate --confirm
```

### Available commands

#### slack-ext app export \<app_id\> [--out=\<file\>] [--json]

Fetch the live manifest (`apps.manifest.export`) and pretty-print it, or write
it to `--out=<file>`. The file form also reports the leaf-field count and prints
the matching `app diff` command. A real manifest is small — the app used to
verify this feature has 14 leaf fields / 709 bytes.

#### slack-ext app show \<app_id\> [--json]

Human summary of the live manifest: app name, description and colour, bot user
display name and always-online flag, every bot scope, the event-subscription
request URL and each subscribed bot event, plus the notable booleans
(socket mode, org deploy, token rotation, app-level token rotation, MCP, PKCE).

#### slack-ext app validate \<app_id\> --manifest=\<file\> [--json]

Validate a candidate manifest file (`apps.manifest.validate`). Each error is
rendered with its **JSON pointer** into the manifest, e.g.

```text
✗ [illegal_bot_scopes] Illegal bot scopes found `this:is:not:a:real:scope`
  pointer: /oauth_config/scopes/bot
```

Exits non-zero when the manifest is rejected. **A pass does not mean safe** — a
partial manifest validates `ok=true`, so the command tells you to run `app diff`
before applying anything.

#### slack-ext app diff \<app_id\> --manifest=\<file\> [--json]

Compare a candidate manifest against a fresh live export, leaf field by leaf
field, and report three separate buckets:

- **DELETIONS** — present live, absent in the candidate. Printed first, in red,
  with a warning that these fields would be removed and an explanation that
  arrays are replaced wholesale. Array entries count individually: `bot_events`
  going from `["channel_created","team_join"]` to `["channel_created"]` is
  reported as a deletion of `team_join`, not as a modification.
- **Modifications** — `pointer  old -> new`.
- **Additions** — fields and array entries the candidate adds.

An identical candidate prints "No changes". `--json` emits
`{deletions, additions, modifications, changed}` with a JSON pointer on every
entry. This is the command to run before any manual manifest edit is applied.

#### slack-ext app set-scopes \<app_id\> [--add=a,b] [--remove=c,d] [--confirm]

Add and/or remove bot scopes (`/oauth_config/scopes/bot`). Exports the live
manifest, adjusts that one array, and updates with the complete result; every
other field of the manifest travels back unchanged. Additions are appended in
order and duplicates are ignored; a `--remove` of a scope that is not present is
reported and changes nothing. At least one of `--add` / `--remove` is required,
and names are validated (`channels:read`-style) before anything is sent.

```bash
slack-ext app set-scopes A0123456789 --add=reactions:read            # dry run
slack-ext app set-scopes A0123456789 --add=reactions:read --confirm
slack-ext app set-scopes A0123456789 --remove=users:read.email --confirm
```

A removal you asked for does **not** need `--allow-deletions`. If the diff shows
any deletion outside `/oauth_config/scopes/bot`, the command refuses.

Almost always reports `permissions_updated: true` — **reinstall the app** before
expecting the new scope to work.

#### slack-ext app set-events \<app_id\> [--add=a,b] [--remove=c,d] [--confirm]

Same shape for subscribed bot events
(`/settings/event_subscriptions/bot_events`). Touches nothing else — in
particular not the scopes array, which is the failure this command's tests pin
down (`bot_events` and `scopes.bot` are both arrays that Slack replaces
wholesale). If the manifest has no `event_subscriptions` block yet, the path is
created and its siblings are left alone.

```bash
slack-ext app set-events A0123456789 --add=app_mention --confirm
slack-ext app set-events A0123456789 --remove=team_join --confirm
```

#### slack-ext app set-request-url \<app_id\> \<https url\> [--confirm]

Set `/settings/event_subscriptions/request_url`. Requires an `https://` URL.

**Slack verifies the URL immediately on save**: it posts a `url_verification`
challenge and rejects the update unless the endpoint echoes the `challenge` value
back. The endpoint must already be deployed and answering before this command is
run, otherwise the update fails and nothing changes.

#### slack-ext app apply \<app_id\> --manifest=\<file\> [--allow-deletions] [--confirm]

Apply a manifest file — the round trip for `app export --out=...`, edit, apply.

The diff shown is live-vs-FILE, so every field the file omits appears as a
deletion. Without `--allow-deletions` the command refuses when there is any, and
its payload is the file overlaid on a fresh export (so it could not delete
anything even if the gate were bypassed). With `--allow-deletions` the file is
sent as the complete manifest and the deletions take effect.

```bash
slack-ext app export A0123456789 --out=./manifest.json
$EDITOR ./manifest.json
slack-ext app diff  A0123456789 --manifest=./manifest.json     # review first
slack-ext app apply A0123456789 --manifest=./manifest.json --confirm
```

#### slack-ext app token-rotate [--refresh-token=\<tok\>] [--confirm] [--json]

Rotate the app configuration token pair via `tooling.tokens.rotate`. The refresh
token is read from `--refresh-token`, `$SLACK_APP_REFRESH_TOKEN`, or the skill
config key `appRefreshToken`.

**A rotate INVALIDATES the refresh token it consumes.** Consequences designed
around:

- `--confirm` is required even though nothing about the app changes, because a
  speculative rotate throws away a working credential. Rotate on demand, or in
  response to a `401`/`invalid_auth` — never "just in case".
- The new pair is written to the skill config (`appConfigToken`,
  `appRefreshToken`) **before anything else happens with it**. Between the API
  response and that write, the process holds the only usable copy of the
  credential: if it died there, only a human could mint a replacement.
- **If persisting fails, the new pair is printed to stdout.** Printing a secret
  is normally forbidden because output lands in the agent transcript, but the old
  refresh token is already dead at that point, so surfacing beats losing it. On
  the success path only masked forms are shown.
- `invalid_refresh_token` is reported with the single-use explanation: if the
  token was already rotated, the pair from *that* rotation is the live one.
- A response that is `ok` but missing either half of the pair is refused rather
  than treated as a rotation, so a partial response cannot make the CLI discard
  a still-valid credential.

### App manifest wire facts (verified live 2026-09-18)

- Requests are **form-encoded** (`application/x-www-form-urlencoded`); a JSON
  body is rejected with `invalid_arguments`. The `manifest` parameter is a JSON
  **string**.
- **Slack answers HTTP 200 with `ok:false` on failure** — a bogus bearer token
  returned HTTP 200 + `invalid_auth`, and a bad app id returned HTTP 200 +
  `invalid_app_id`. `body.ok` is the only verdict; reading the HTTP status would
  report every error as a success.
- `apps.manifest.export` and `apps.manifest.validate` both answer `not_authed`
  to an unauthenticated probe (a nonexistent method answers `unknown_method`),
  which is how the method names were confirmed without a credential.
- Sending `; charset=utf-8` on the content-type makes Slack add
  `warning: "superfluous_charset"` to the response body. Harmless.

## References

- `references/endpoints.md` — full Slack Web API endpoint documentation,
  including the `users.admin.*` admin methods and the `apps.manifest.*` App
  Manifest API (wire format, update semantics, and the methods deliberately left
  unwired).
- `references/watch-architecture.md` — internals of `slack watch` and of
  `slack post`'s reply auto-watch (observer, filter, TTL teardown, state files).

## Enterprise Grid admin commands (`slack-ext eg-*`, `channel-*`, `approvals`, `admin-app`)

These commands use Slack's internal admin API namespaces — `enterprise.users.admin.*`,
`admin.conversations.*`, `conversations.sharedApprovals.list`, and `admin.apps.*` — all
observed returning `{"ok":true}` in a live browser session (2026-09-22). They operate at
the **org level** (`E06V3987PMY`, "Adobe Enterprise Support") rather than the workspace level.

### CRITICAL: audit attribution

Session-token (`xoxc`) calls are **indistinguishable from the human's own direct actions**
in Slack's channel event history. A concrete, verified case: `#aem-fedex` (`C0C2CUUDWLE`)
was archived by Zapier at 2026-09-17T00:17:04Z — the channel event log records Lars Trieloff
as the actor, not Zapier, because Zapier's Slack action ran on his user OAuth token and
carries no bot identity. Running `eg-deactivate`, `eg-set-restricted`, `channel-to-private`,
or any other write command in this skill looks identical to the human performing the action
themselves in the Slack UI.

The Enterprise Audit Logs API (`auditlogs:read` scope) **would** record the acting app and
distinguish automation from a human click — but `admin.audit.*` methods all return
`unknown_method` (six variants probed on 2026-09-22; none exist). There is currently no
working API call that distinguishes an `xoxc`-based script from a human in the channel
event log. Do not document these calls as "attributed to the human in the audit log" —
they ARE the human as far as any observable Slack record is concerned.

### Authentication

Enterprise Grid commands use the org-level `xoxc` token from the browser's `localStorage`,
at key `teams['E06V3987PMY'].token`. The `xoxc` token is only valid together with the
browser's `d` session cookie, so calls **must** go through the browser tab via
`browser.fetch` (same-origin XHR). `SLICC`'s own `fetch()` strips cookies and would
silently fail. This is the same mechanism as every other `slack-ext` command.

### Dry-run default

Every mutating command defaults to dry-run and requires `--confirm` to act. The dry-run
output shows exactly which API method would be called and with which parameters.

---

### Enterprise user lifecycle

#### `eg-set-restricted <user_id> [--confirm]`

Make a full member a **multi-channel guest** at the org level.

- API: `enterprise.users.admin.setRestricted`
- Parameter: `user` (just the user ID — no `team_id`)
- Verified: `{"ok":true}` observed from the UI. Bogus-user probe → `user_not_found`.
- Reads back `users.info` after the call. `{"ok":true}` alone is not treated as evidence.
- Observed `_x_reason=enterprise-set-multi-channel-guest` from the UI.

#### `eg-set-regular <user_id> [--confirm]`

Promote a guest back to a **full member** at the org level.

- API: `enterprise.users.admin.setRegular`
- Parameter: `user`
- Verified: `{"ok":true}` observed. Bogus-user probe → `user_not_found`.
- Reads back `users.info` after the call.
- Observed `_x_reason=OrgMembers_setToMember`.

#### `eg-deactivate <user_id> [--confirm]`

**Deactivate** a user account (reversible).

- API: `enterprise.users.admin.setStatus` with `status=delete`
- **THE STATUS=DELETE TRAP:** `status=delete` means **deactivate** (the user is disabled
  and cannot sign in). It does NOT permanently delete the account. The account is
  recoverable. The value `"delete"` is the wire string observed from the live UI;
  changing it to `"inactive"`, `"disabled"`, or anything else calls a different operation.
- The reactivation `status` value is **NOT KNOWN**. Do not guess it.
- Verified: `{"ok":true}` observed. Bogus-user probe → `invalid_user` (different from
  `user_not_found` — this endpoint validates the user field differently).
- Observed `_x_reason=deactivateMembers`.

#### `eg-forget <user_id> [--confirm]`

**GDPR-style permanent identity scrub. IRREVERSIBLE.**

- API: `users.admin.profileDeidentify` (workspace-level namespace, org-wide effect)
- Effect: `real_name` → `"Deactivated User"`, handle → `"deactivateduser<N>"`,
  guest flags cleared. The user's messages remain but lose author attribution.
- **CANNOT BE UNDONE.** There is no support ticket that restores it.
- Design decision: this is its own command and **must never be a flag on `eg-deactivate`**
  and **must never run inside an unattended bulk loop without per-user confirmation.**
  The `--confirm` flag is the confirmation; the dry-run output names the user explicitly.
- Verified: `{"ok":true}` observed. Bogus-user probe → `user_not_found`.
- Observed `_x_reason=forget-user`.

#### `eg-bulk-guest [<user_id>...] [--file=<path>] [--confirm]`

Convert a list of full members to multi-channel guests. The primary motivating use case is
converting 14 vendor accounts that are currently full members.

- API: `enterprise.users.admin.setRestricted` called once per user
- Input: space-separated user IDs as positional arguments, or `--file=<path>` (one ID per
  line; lines starting with `#` are comments).
- Per-user read-back: each user's type is confirmed via `users.info` after the call.
  `{"ok":true}` alone is not accepted as evidence.
- Already-guests are no-ops. Bots are skipped with a warning. Errors are collected and
  reported in the final summary; the command continues to the next user rather than aborting.

Example:

```bash
# Dry run first
slack-ext eg-bulk-guest U12345 U67890 UABCDE --org=E06V3987PMY

# With a file
echo "U12345\nU67890\nUABCDE" > vendors.txt
slack-ext eg-bulk-guest --file=vendors.txt

# Confirm
slack-ext eg-bulk-guest --file=vendors.txt --confirm
```

#### `eg-set-ultra-restricted <user_id> [--confirm]`  — **UNVERIFIED**

Make a single-channel guest at the org level.

- API: `enterprise.users.admin.setUltraRestricted`
- **UNVERIFIED:** The endpoint is real (bogus-user probe → `user_not_found`, not
  `unknown_method`), but `{"ok":true}` was **never observed** from a live admin UI session.
  The parameter shape (just `user`, no `channel`) is a best-effort inference from the
  method naming pattern.
- **Do not use in production** until the method has been confirmed to produce the expected
  state change against a real account.
- Clearly marked in code comments and in the command output.

---

### Channel management

#### `channel-search [--query=<q>] [--limit=<n>] [--max=<n>] [--types=<t>] [--sort=<s>] [--sort-dir=<d>] [--json]`

Enumerate channels using `admin.conversations.search`.

**Observed parameters (2026-09-22):**

| Parameter | Values | Notes |
|-----------|--------|-------|
| `search_channel_types` | `exclude_archived` \| `all` \| `private` \| `private_exclude` \| `archived` | Materially changes results: `all` → 2072, `exclude_archived` → 1515. Default: `exclude_archived`. Lars Trieloff observed omitting this returns `invalid_arguments` in the UI path; the API appears to default internally but the param should always be included explicitly. |
| `sort` | `name` \| `member_count` \| `created` | `last_activity_ts` and `num_members` return `invalid_sort` (probed live). |
| `sort_dir` | `asc` \| `desc` | |
| `query` | any string, including empty | |
| `cursor` | any string, including empty | |

**`--types` shorthand in this command:** `--types=all`, `--types=private`, `--types=archived`, etc.

**Measured defect: `channel_ids` parameter is silently ignored.** Passing
`channel_ids=C0634KMGW2G` (bare string) and `channel_ids=["C0634KMGW2G"]` (JSON array) both
returned `{"ok":true}` with the **unfiltered full list** starting at `#general`. The
command never passes `channel_ids`; it enumerates with cursor pagination and filters locally.

**`archived` search_channel_types caveat:** Lars observed `archived` returning 0 results for
a query that both `all` and `exclude_archived` matched. A probe on 2026-09-22 showed `archived`
returning 1 result for the same query (a genuinely archived channel). The discrepancy may be
query-specific. Do not treat a 0-result `archived` response as proof a channel was never archived.

Response fields per channel: `id`, `name`, `purpose`, `member_count`, `external_user_count`,
`channel_manager_count`, `created`, `creator_id`, `is_private`, `is_archived`, `is_general`,
`last_activity_ts`.

#### `channel-to-public <channel_id> [--confirm]`

Convert a private channel to public.

- API: `admin.conversations.convertToPublic`
- Parameter: `channel_id` (verified live 2026-09-22; bogus ID → `channel_not_found`)

#### `channel-to-private <channel_id> [--confirm]`

Convert a public channel to private.

- API: `admin.conversations.convertToPrivate`
- Parameter: `channel_id`
- **PRIVATE CHANNEL INVISIBILITY:** after converting to private, the channel becomes
  invisible to any caller who is not a member:
  - `conversations.info` returns `channel_not_found`
  - `conversations.genericInfo` returns `{"ok":true}` with an **empty array**
  - The edge cache returns the channel id under `failed_ids`
  
  This is **expected behaviour**, not a sign that the channel was deleted. The command warns
  about this and suggests using `channel-search` to confirm the channel still exists.

#### `channel-archive` / `channel-unarchive`

- `channel-archive <channel_id> [--confirm] [--max-members=N] [--min-idle-days=N] [--allow-shared]`: dry run by default; Slack Connect channels need `--allow-shared`.
- `channel-unarchive <channel_id> [--confirm]`: dry run by default.
- Guards, refusals, exit codes and wire facts: `references/endpoints.md`, "Enterprise Grid Channel Admin".

---

### Slack Connect approvals

#### `approvals [--query=<q>] [--limit=<n>] [--all] [--json]`

List Slack Connect shared channel invite approvals.

- API: `conversations.sharedApprovals.list`
- Sort: `date_expire` descending (most-recently-expiring first)
- Paginates automatically via `response_metadata.next_cursor`
- Response per approval: `id` (e.g. `I0C3EKRE3S5`), `connecting_team{id,name,icon}`,
  `channel{name}`, `status`, `date_expire`
- Verified live: 977 total approvals in the org at time of measurement.
- `--all` removes the default 200-item cap. Use with care on large orgs.

---

### App governance

#### `admin-app approve <app_id|request_id> [--confirm]`

Approve an app for the org.

- API: `admin.apps.approve`
- Accepts a pending install `request_id` (starts with `I`) **or** an `app_id` (starts with
  `A`) + the org's `enterprise_id`.
- **SINGLE-USE `request_id`:** a `request_id` can only be resolved **once**. Approving an
  already-resolved `request_id` returns `{"ok":false,"error":"request_already_resolved"}`.
  The command surfaces this error rather than swallowing it. To reverse a resolution, use
  the `app_id` form.

#### `admin-app restrict <app_id|request_id> [--confirm]`

Restrict an app for the org. Same single-use `request_id` caveat applies.

- API: `admin.apps.restrict`
- `request_already_resolved` is surfaced explicitly with instructions to use `app_id` instead.

#### `admin-app clear <app_id> [--confirm]`

Clear the current approval or restriction decision for an app.

- API: `admin.apps.clearResolution`
- Parameters: `app_id` + `enterprise_id`

#### `admin-app permissions <app_id> --type=<no_one|everyone|named_entities> [--confirm]`

Set the install-permission policy for an app.

- API: `admin.apps.permissions.set`
- Observed valid `permission_type` values: `no_one`, `everyone`, `named_entities`
- Response echoes `{ok, permission_type, channel_restriction_mode}`

#### `admin-app list [--restricted] [--json]`

List approved or restricted apps.

- API: `admin.apps.approved.list` (default) or `admin.apps.restricted.list` (with `--restricted`)
- Parameter: `enterprise_id` + `limit`
- Entry shape: `{app:{id,name,…}, scopes, date_updated, last_resolved_by, domains}`
- Paginates automatically.

---

### What remains unverified

| Item | Status | Reason |
|------|--------|--------|
| `enterprise.users.admin.setUltraRestricted` | Endpoint real, behaviour unverified | Probe returns `user_not_found` (not `unknown_method`), but `{"ok":true}` was never observed from the UI. Parameter shape unknown. |
| `enterprise.users.admin.setStatus` reactivation value | Unknown | The deactivation value `"delete"` was observed. The reactivation value was not. Do not guess. |
| `admin.apps.permissions.set` with `named_entities` entity list | Partial | The method and three `permission_type` values are verified. The additional parameters for specifying named entities in `named_entities` mode were not observed. |

