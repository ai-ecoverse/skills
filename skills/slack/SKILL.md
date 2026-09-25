---
name: slack
description: Slack Web API client — read Slack messages, post to Slack channels, search
  Slack message text and channels, read Slack threads, find and look up Slack users by
  name, username, or email, view Slack activity and notifications, manage Slack support
  requests, and watch Slack channels for new messages in real time. Multi-workspace,
  auto-detected from the active tab. Use when the user wants to check, post, or search
  Slack messages or message text, search Slack channels, read Slack threads, get Slack
  user info, view Slack notifications or activity feed, manage Slack support
  tickets/help requests, watch a Slack channel for updates, or automate any Slack task.
  Triggers on mentions of Slack, Slack channels, DMs, threads, or messages, Slackbot,
  Slack notifications, Slack channel activity, Slack support or help requests,
  watching/monitoring a Slack channel, or searching Slack message text. Also provides
  slack-ext for admin user-management (guest conversion, guest channels) and Slack app
  manifest reads and diffs.
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

After a successful post, replies are watched for **one hour** and routed back to the cone that
posted (`--watch-scoop=<name>` routes elsewhere, `--no-watch` opts out); your own messages never
notify. Scope, sharing and routing rules: `references/watch-architecture.md`, "Auto-watch for replies".

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

`slack-support` lists, views, replies to, creates and resolves help requests on Adobe's Slack
Support Portal by scraping it in an open browser tab. Commands and topics: `references/support-portal.md`.

## Admin user management (`slack-ext`)

`slack-ext` exposes Slack's legacy `users.admin.*` namespace for converting
users between account types and managing guest channel access. It is a
separate command from `slack` because it uses admin-only API methods that
require a different usage pattern and carry stronger safety requirements.

**Important caveats before using:**

- **Audit attribution**: these calls are **indistinguishable from the human's own direct
  actions** in Slack's channel event history. Read "CRITICAL: audit attribution" below first.
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

`slack-ext app` reads and changes Slack app configuration (App Manifest API, separate app configuration token); every write needs `--confirm`.
Updates have no merge semantics (omitted fields are deleted), so writes export-modify-update, deletions need `--allow-deletions`,
and `permissions_updated: true` means reinstall. Commands, credential and wire facts: `references/app-manifest.md`.

## References

- `references/endpoints.md` — full Slack Web API endpoint documentation,
  including the `users.admin.*` admin methods and the `apps.manifest.*` App
  Manifest API (wire format, update semantics, and the methods deliberately left
  unwired).
- `references/app-manifest.md` — `slack-ext app`: the export-modify-update rule, the
  `--allow-deletions` gate, reinstall on `permissions_updated`, the app configuration token, and
  every `app` subcommand.
- `references/enterprise-grid.md` — the Enterprise Grid admin commands (`eg-*`, `channel-*`,
  `approvals`, `admin-app`): authentication, per-command APIs and parameters, wire facts, and
  what remains unverified.
- `references/watch-architecture.md` — internals of `slack watch` and of
  `slack post`'s reply auto-watch (observer, filter, TTL teardown, state files).
- `references/support-portal.md` — `slack-support` commands and help-request topics.

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

### Commands

Every write is a dry run unless `--confirm` is given. Full per-command reference (APIs, parameters,
wire facts, authentication, what remains unverified): `references/enterprise-grid.md`.

- `eg-status <user_id> [--json]` — read-only: the user's type, org and workspaces; no `--confirm`.
- `eg-set-restricted <user_id> [--confirm]` — full member → multi-channel guest; reads the state back.
- `eg-set-regular <user_id> [--confirm]` — guest → full member; reads the state back.
- `eg-deactivate <user_id> [--confirm]` — deactivate (reversible); the wire value `status=delete` does not delete.
- `eg-forget <user_id> [--confirm]` — GDPR identity scrub, **IRREVERSIBLE**; never a flag, never in an unattended loop.
- `eg-bulk-guest [<user_id>...] [--file=<path>] [--confirm]` — many members → multi-channel guests, per-user read-back.
- `eg-set-ultra-restricted <user_id> [--confirm]` — **UNVERIFIED**; do not use in production.
- `channel-search [--query=<q>] [--types=<t>] [--limit=<n>] [--json]` — read-only channel enumeration, filtered locally.
- `channel-to-public <channel_id> [--confirm]` — private → public.
- `channel-to-private <channel_id> [--confirm]` — public → private; the channel then looks deleted to non-members.
- `approvals [--query=<q>] [--all] [--json]` — read-only list of Slack Connect invite approvals.
- `admin-app approve <app_id|request_id> [--confirm]` — approve an app; a `request_id` is single-use.
- `admin-app restrict <app_id|request_id> [--confirm]` — restrict an app; same single-use `request_id` caveat.
- `admin-app clear <app_id> [--confirm]` — clear an app's approval or restriction.
- `admin-app permissions <app_id> --type=<no_one|everyone|named_entities> [--confirm]` — install policy.
- `admin-app list [--restricted] [--json]` — read-only list of approved or restricted apps.
