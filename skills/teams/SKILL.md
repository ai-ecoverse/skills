---
name: teams
description: >-
  Interact with Microsoft Teams via the Graph API — read messages, post to channels,
  search, read threads, look up users, view mentions/activity, and get channel info.
  Also transcribe the meeting you're currently in by turning on live captions and
  capturing them to a timestamped, speaker-attributed transcript file.
  Supports all teams and channels the user has access to, with auth via the live browser
  session. Use when the user wants to check Teams messages, post a Teams message, search
  Teams channels, read a thread, get user info, view mentions, transcribe or caption a
  live meeting, or automate any Teams task.
  Triggers on mentions of Teams, channels, messages, threads, mentions, activity, digest,
  transcribe, transcript, captions, or meeting notes.
allowed-tools: bash
---

# Teams

Direct API access to Microsoft Teams via the Microsoft Graph + Substrate
Search APIs. Every request runs **inside the Teams browser tab** through
`playwright-cli eval`: the MSAL delegated access token is read from
`localStorage` and consumed by `fetch()` in the same eval block — it never
leaves the page context, is never printed, and is never written to disk.

## Prerequisites

The user must log into Teams in their own browser first. The script will not
authenticate on the user's behalf; it only piggybacks on a tab the user has
already signed into.

1. Open https://teams.microsoft.com in the browser and sign in.
2. Wait until the Teams web client is fully loaded.
3. Then run any `teams` command — the script discovers the tab automatically
   via `playwright-cli tab-list`.

If no Teams tab is found, the script exits with a clear error asking the user
to open and sign in to Teams. No `teams auth` step exists — the page-context
model makes it unnecessary.

## Quick start

```bash
# List joined teams
teams teams

# List channels in a team (display-name partial match works)
teams channels "My Team"

# Search for channels by name (inside one team, or across all teams)
teams channels "My Team" --search=general
teams channels --search=release

# Read recent messages from a channel (default: last 24h)
teams history "My Team" "General"
teams history "My Team" "General" --since=7d --top=100

# Messages mentioning/involving me (default: last 24h)
teams activity
teams activity --since=7d

# Post a message to a channel
teams post "My Team" "General" "Hello from SLICC!"

# Reply in a thread (use the parent message id from `history`)
teams post "My Team" "General" "Got it" --reply-to=1712345678901

# Read replies to a message
teams thread "My Team" "General" 1712345678901

# Look up a user (by display name, UPN/email, or user ID)
teams user "Jane Doe"
teams user jane.doe@contoso.com

# Channel metadata
teams info "My Team" "General"

# Full-text search across Teams messages
teams search "deployment outage" --since=14d

# Messages with no replies (default: last 48h)
teams unanswered "My Team" "General"

# Cross-team activity digest (default: last 24h)
teams digest --since=7d

# Start transcribing the meeting you're currently in (turns on live captions)
teams transcribe
# ...then append new lines to the transcript file any time:
teams transcribe flush
# ...or stream it live (blocks until you Ctrl-C):
teams transcribe follow --out=standup.md
# ...and stop when the meeting ends:
teams transcribe stop
```

## Authentication

Authentication is implicit: every API call runs inside the open Teams tab via
`playwright-cli eval`. The MSAL access token is located in `localStorage`
(keys containing `accesstoken` + `graph.microsoft.com` for Graph, or
`accesstoken` + `substrate.office.com` for Substrate Search), the entry with
the highest `expiresOn` is picked, and its `secret` field is consumed by
`fetch()` in the same eval. The token value never crosses the process
boundary — the script process only sees the JSON response body.

If the Teams web client silently refreshes the token in the background, the
next command picks up the fresh one automatically. If you see
`401 Unauthorized` repeatedly, refresh the Teams tab in the browser and
retry.

> **Implementation note:** The Teams web client (v2, `teams.microsoft.com/v2/`)
> stores MSAL tokens in `localStorage`, not `sessionStorage`. A
> `sessionStorage` fallback exists for older Teams versions.

**Before running any command,** check for an existing Teams tab and only open
a new one if necessary:

```bash
# Check whether a Teams tab is already open
playwright-cli tab-list | grep teams.microsoft.com

# Only open a new tab if the above returns nothing
open https://teams.microsoft.com
```

Wait for the page to fully load before running any `teams` command.

## API Endpoint Note

Channel message reads use the **beta** Graph endpoint
(`https://graph.microsoft.com/beta/...`), not v1.0. The delegated token from
the Teams browser session does not include `ChannelMessage.Read.All`, so the
v1.0 messages endpoint returns 403. The beta endpoint works with the scopes
the Teams session actually provides. Team listing, channel listing, user
profile, and channel info calls use v1.0 as normal.

## Search Architecture

The `search` and `activity` commands use a cascading search strategy:

1. **Substrate Search** (`substrate.office.com/search/api/v2/query`) — The
   internal search engine that Teams v2 itself uses. Fastest and most
   comprehensive. Uses the substrate access token discovered in `localStorage`
   alongside the Graph token.
2. **Graph Search API** (`/search/query` with `chatMessage`) — The official
   public API. Often fails with delegated browser tokens (400/403) due to
   missing scopes.
3. **Channel scan fallback** — Iterates teams/channels and filters messages
   client-side. Slower but always works with the available token scopes.

For `activity`, the fallback additionally scans **1:1 and group chats** via
`/me/chats/{id}/messages` to catch DM mentions that channel scanning misses.

## Available commands

All commands output JSON to stdout (one top-level object or array per
invocation). Parse the output to answer the user's question.

### teams teams

List the teams the current user has joined. Returns `id`, `name`, and
`description` for each team.

### teams channels \<team\> [--search=term]

List channels in a team. `<team>` accepts a display-name partial match
(case-insensitive) or a team ID.

- `--search=<term>` — filter channels by name substring.
- If `--search` is provided **without** `<team>`, the command searches
  channels across **all** teams the user has joined (useful for finding a
  channel when you don't know which team owns it).

### teams history \<team\> \<channel\> [--since=DURATION] [--top=N]

Fetch recent top-level messages from a channel (replies are not inlined — use
`teams thread` for those). Default window is the last 24 hours.

- `--since=<duration>` — window, e.g. `30m`, `24h`, `7d`, `2w`.
- `--top=<n>` — page size (Graph caps at 50 per page; the command paginates
  up to 5 pages).

**Alias:** `teams messages` / `teams msgs` also route to `history`.

### teams activity [--since=DURATION] [--max-teams=N] [--concurrency=N]

Messages that mention or involve the current user. Default window is the last
24 hours. See the full description in the **Available commands** section below.

**Alias:** `teams mentions` also routes to `activity`.

### teams post \<team\> \<channel\> \<message\> [--reply-to=\<message-id\>]

Post a plain-text message to a channel, or reply in a thread when
`--reply-to` is given. Returns the created message's `id`, `date`, author,
body, `webUrl`, and (when applicable) `replyTo`.

```bash
# Post a top-level message
teams post "My Team" "General" "Deploy kicked off, expect 5m downtime"

# Reply in an existing thread
teams post "My Team" "General" "Got it, thanks" --reply-to=1712345678901
```

### teams thread \<team\> \<channel\> \<message-id\> [--top=N]

Read the replies to a parent message. `<message-id>` is the `id` of the
top-level message (as returned by `teams history` or `teams post`). Default
page size is 50.

### teams user \<user-id-or-name\>

Look up a user. Accepts:

- A user ID (GUID).
- A UPN / email (`jane.doe@contoso.com`).
- A display-name prefix — in which case the command searches
  `/users?$filter=startswith(displayName,'...')` and returns the first
  match (warning to stderr if more than one matched).

Returns `id`, `name`, `email`, `title`, `department`, and `office`.

### teams info \<team\> \<channel\>

Get channel metadata: `id`, `name`, `description`, `membershipType`
(`standard` / `private` / `shared`), `webUrl`, and the parent team's name
and ID.

### teams search \<query\> [--since=DURATION]

Full-text search across the user's accessible Teams messages via the Graph
Search API. Supports KQL-style queries. Returns summary snippets, authors,
dates, body previews, and `webUrl`.

### teams unanswered \<team\> \<channel\> [--since=DURATION]

List top-level messages in a channel that have zero replies. Default window
is the last 48 hours. Useful for surfacing forgotten questions.

### teams activity [--since=DURATION] [--max-teams=N] [--concurrency=N]

Messages that mention or involve the current user. Default window is the last
24 hours. Uses the Graph Search API (`/search/query`, beta) for speed. If
Search returns 403 (common with delegated browser tokens that lack the
`chatMessage` search scope), the command automatically falls back to scanning
the first `--max-teams` teams (default 10) × 3 channels each in parallel
(5 concurrent requests by default), with early exit once `--top` results are
found.

> **Large tenants:** The parallel fetch keeps most scans within 30s. If you
> still hit timeouts, lower `--max-teams` (e.g. `--max-teams=5`).

**Alias:** `teams mentions` also routes to `activity`.

### teams digest [--since=DURATION] [--max-teams=N] [--concurrency=N]

Cross-team / cross-channel activity digest. For each channel with recent
activity in the window (default 24h), returns:

- `messageCount`, `uniqueAuthors`, list of authors
- `hasAttachments` boolean
- reaction summary (reaction type → count)
- top 3 messages (author + date + preview)

Sorted by message count descending. Fetches channels and messages for all
teams in parallel (5 concurrent requests by default), then aggregates.
Scans up to `--max-teams` teams (default 10). Progress is printed to stderr.

> **Large tenants:** With the parallel fetch, 10 teams × N channels typically
> completes in under 15s. Use `--max-teams=20` if you want broader coverage
> and have headroom. Lower to `--max-teams=5` if you see timeouts.

### teams transcribe [start|flush|status|follow|stop] [--out=FILE]

Transcribe the meeting you're **currently in** by capturing live captions.
Aliases: `transcript`, `captions`.

Teams' official transcript/recording is reachable only through Microsoft Graph
scopes the delegated browser session does not have (`OnlineMeetingTranscript.Read.All`,
`OnlineMeetingRecording.Read.All`, `OnlineMeetings.Read` — all return `403`). So this
command captures the **live captions** instead, which need nothing beyond your own
in-meeting view.

| Subcommand | What it does |
|---|---|
| `start` (default) | Navigates the meeting menu (More → Language and speech → **Show live captions**) to turn captions on, then installs the in-page collector. |
| `flush` | Appends newly-finalized caption phrases to the transcript file since the last flush. |
| `status` | Reports whether captions are rendering, how many phrases are buffered, and the current in-progress line. |
| `follow` | Foreground loop: starts captions, then flushes + streams new lines to stdout every few seconds. **Blocks** — Ctrl-C to stop. `--interval=SEC` (default 5), `--max=MIN` (default 180), `--idle-stop=MIN` (default 30). |
| `stop` | Final flush, then clears the collector interval. (Captions stay toggled on in the UI; turn them off manually if desired.) |

Flags: `--out=FILE` sets the transcript path (default `teams-transcript.md`; a sidecar
`FILE.idx` tracks the flush position). Output is timestamped, speaker-attributed, and
de-duplicated Markdown:

```
**[15:04:16] Lars Trieloff:** Including Adobe. So I would say probably the majority is Adobe...
**[15:04:48] Dragos Dascalita Haut:** And where are you taking this now?
```

**How it works.** A 300 ms in-page poller watches the caption virtual-list
(`closed-caption-v2-virtual-list-content`) and commits each finalized phrase into a
`window` buffer that survives across evals — so nothing is lost even though Teams only
keeps ~3 caption rows visible at a time. A phrase is treated as final once the bottom
row stops being a growing prefix of the previous text (i.e. the speaker changed or a new
utterance began). Because the buffer lives in the page, you can `flush` on any cadence
(even a 1-minute cron) without losing lines; only a tab reload clears it.

> **Accuracy caveat:** captions are Teams' own speech-to-text, so names and jargon can be
> mangled (it renders "SLICC" as "Slick", "Concur" as "conqueror", etc.). Clean up in a
> post-pass if you need a verbatim record.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No Teams tab found` | First check if a tab is already open: `playwright-cli tab-list`. If no Teams URL appears, open one (`open https://teams.microsoft.com`) and sign in, then retry. |
| `No Graph access token in Teams localStorage` | Modern Teams (v2) stores tokens in `localStorage`, not `sessionStorage`. If extraction fails, reload the Teams tab and wait for it to fully render before retrying. |
| `401 Unauthorized` | Teams session expired. Refresh the Teams tab in the browser; the next command will pick up the new token automatically. |
| `403 Forbidden on message reads` | You're hitting the v1.0 `/messages` endpoint, which requires `ChannelMessage.Read.All` (a scope the delegated browser token lacks). The script already uses the beta endpoint; if you see this, confirm you're on an up-to-date version of `teams.jsh`. |
| `Team/channel not found` | Run `teams teams` or `teams channels <team>` to list the exact names/IDs available to the current token. |
| Search API returns empty / 403 | `teams activity` auto-falls back to a channel scan (delegated tokens often lack the chatMessage search scope). For `teams search`, ensure the token has `Chat.Read` scope. |
| `digest` or `activity` times out | Use `--max-teams=5` to limit the scan. The .jsh runner has a ~30s budget; large tenants need a smaller cap. |
| `transcribe` says "No active meeting found" | You must be *in* a meeting (the meeting stage must be the active view in the Teams tab). Join/rejoin the call, then retry. |
| `transcribe` can't find the caption toggle | Teams' menu labels/DOM can change. Turn on captions manually (More → Language and speech → Show live captions), then run `teams transcribe start` — the collector attaches to the existing caption panel. |
| `transcribe status` shows captions rendering but 0 buffered | No one has spoken a full phrase yet, or the tab was reloaded (which clears the in-page buffer). Re-run `teams transcribe start` after a reload. |
| 429 rate-limit errors | The script automatically retries with the `Retry-After` delay (up to 3 times). If you still see 429s, wait a minute and retry. |

## Endpoints reference

See [references/endpoints.md](references/endpoints.md) for per-endpoint
documentation, query parameters, response shapes, rate limiting, and error
codes.
