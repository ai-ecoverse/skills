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
  live meeting, or feed Microsoft Teams items into the SLICC `monday` start-of-day
  inbox digest (the monday aggregator skill — unrelated to the monday.com SaaS product).
  Triggers on mentions of Teams, Microsoft Teams, channels, messages, threads, mentions,
  activity, digest, transcribe, transcript, captions, or meeting notes.
allowed-tools: bash
---

# Teams

Direct API access to Microsoft Teams via the Microsoft Graph + Substrate
Search APIs. Every request runs **inside a Teams browser tab** through the
`sliccy:browser` bridge: the sign-in is minted and used by `fetch()` in the
page. No token is printed, written to disk or seen by the script process.

## Install

`teams` is a jsh command (`scripts/teams.jsh`, the `bin` of this folder's
`package.json`):

```bash
pnpm add -g /usr/share/skills/teams        # or wherever the skill is installed
```

## Prerequisites and tabs

Sign in to Teams at https://teams.cloud.microsoft in the browser once. The
script never signs in for you.

- **API commands** (`teams`, `channels`, `history`, `post`, `search`, `activity`,
  `digest`, `monday`, …) run in a **background tab of their own**, opened on first
  use and kept in `~/.local/state/teams/tab.json` (or `$TEAMS_STATE_DIR`,
  `$XDG_STATE_HOME/teams`). The first call reloads that tab once to catch the
  sign-in (below), so it takes a few seconds; later calls reuse it. Your own Teams
  tabs are never reloaded. `--tab=<targetId>` picks a tab instead.
- **Meeting commands** (`transcribe`, `post --live`) work in **your** meeting tab,
  which they read and click but never reload: `--tab=<targetId>`, else the Teams tab
  whose title names a meeting or call, else the first Teams tab.

## Authentication

Teams v2 encrypts its MSAL token cache, so nothing is read from storage. A
page-context hook records the refresh token the Teams client posts to the AAD
token endpoint (one per client id, preferring the Teams web client) and replays
it in the page for the Graph or Substrate scope. Teams makes those requests while
the page loads, which is why the first call reloads teams' own tab and installs
the hook in the new document at once. SLICC 7's request capture leaves
`login.microsoftonline.com` out, so the SLICC 6 path that read the token request
from the CDP request buffer is gone.

If you see `Could not obtain a Teams sign-in`, make sure you're signed in at
https://teams.cloud.microsoft, then retry; deleting `~/.local/state/teams/tab.json`
makes teams open a fresh tab.

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
   comprehensive. Uses a Substrate access token minted in the page
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

### teams monday [--limit N] [--depth N] [--date Nd]

`monday`-protocol inbox source (see the `monday` skill,
`references/SOURCE_PROTOCOL.md`). Prints a **single JSON array** to stdout and
nothing else; all progress/warnings go to stderr and the command always exits
`0` (an empty inbox is `[]`) — including when Teams itself is unavailable, e.g.
no signed-in tab, so the aggregator degrades instead of failing. Intended to be
called by `monday`, which merges
it with `gh`, `slack`, `outlook`, `gmail` and `servicenow`.

```bash
teams monday --limit 20 --depth 3 --date 7d
monday teams --limit 10 --date 21d       # via the aggregator
```

Items returned:

| Type | Source |
|---|---|
| `chat` / `group-chat` | Newest message from **someone else** in each 1:1 or group chat active in the window, plus `--depth` older messages as `context[]`. Paginates past your own replies, so a chat still appears when you sent the last several messages. |
| `channel-mention` / `chat-mention` / `channel-reply` | Entries from the Teams **activity feed** (`48:notifications`) — @mentions and thread replies aimed at you. |

Fields: `id` (`teams-msg-<messageId>` / `teams-activity-<activityId>`), `ts`
(ISO-8601), `source: "teams"`, `title`, `url` (deep link
`https://teams.microsoft.com/l/message/<threadId>/<messageId>`), `participants`,
`body` (HTML stripped), plus `from`, `chat`/`threadId`, `chatType`, `unread`,
`context[]`. `importance`/`urgency`/`summary` are intentionally **not** emitted —
`monday` adds those when rating.

Chats are read via the Teams chat service rather than Graph, and the command
falls back to a channel scan if the activity feed is unavailable. You do not
need to know either to use it — see
[`references/endpoints.md`](references/endpoints.md#monday-chat-retrieval) if
you are changing the implementation.

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

**How it works.** A `MutationObserver` on the caption virtual-list
(`closed-caption-v2-virtual-list-content`) captures changes event-driven (no poll gaps).
Each spoken utterance is its OWN `[data-tid="closed-caption-text"]` element whose text
grows as it is recognized, then finalizes when the next utterance's element appears — so
the collector keeps one buffer entry per element and **supersedes its text as it grows**,
delivering each utterance to the ntfy URL exactly once (when it finalizes, or after a
short debounce for the trailing one). The speaker name sits ~2 ancestors above the text
span (`"Name\n<text>"`). The `window` buffer survives across evals, so you can `flush` on
any cadence without losing lines; only a tab reload clears it.

> **Why DOM (not the network):** verified on the wire — Teams live captions arrive over
> the encrypted **WebRTC media channel** and materialize only in the client DOM; there is
> **no WebSocket/HTTP source** to tap (a HAR + WS-frame capture during active captioning
> showed zero caption traffic). Element-level DOM capture is therefore the complete and
> correct approach. Validated live: a 20-utterance test captured and delivered 20/20.
>
> **Common pitfall:** the virtual-list has a single wrapper child — iterate the
> `closed-caption-text` elements, NOT `list.children`, or you'll see one merged blob.

> **Accuracy caveat:** captions are Teams' own speech-to-text, so names and jargon can be
> mangled (it renders "SLICC" as "Slick", "Concur" as "conqueror", etc.). Clean up in a
> post-pass if you need a verbatim record.

#### Copilot mode — `--ntfy`, `follow --command`, `--snapshot`, and `teams post --live`

Turn the transcript into a live "meeting copilot" that surfaces context to everyone.
SLICC 7 delivers events over ntfy (the gateway at `ntfy.sliccy.ai`), not SLICC 6's
webhook command:

```bash
# Run a command for every finalized phrase, locally (no network):
teams transcribe follow --command 'agent send meeting-copilot "$TEAMS_AUTHOR: $TEAMS_TEXT"'

# Or POST each phrase to an ntfy.sliccy.ai hook, and subscribe where it's handled:
teams transcribe start --ntfy=https://ntfy.sliccy.ai/hook/<id>
ntfy sub https://ntfy.sliccy.ai/<topic> 'agent send cone --lick=webhook --source teams "$NTFY_RAW"'

# The handler flushes + grabs a deduped screen-share frame:
teams transcribe flush --snapshot            # only saves a shot if screen-sharing AND the frame changed

# ...then posts context straight into the live meeting chat (visible to all):
teams post --live "Context: OpTel is Adobe's Observability & Telemetry platform."

# Tear down (stops sending to the ntfy URL):
teams transcribe stop
```

- **`follow --command '<cmd>'`**: runs `sh -c '<cmd>'` once per finalized phrase, in
  order, with `$TEAMS_TEXT`, `$TEAMS_AUTHOR`, `$TEAMS_TS` and `$TEAMS_RAW` (JSON). The
  text is what someone said: use it quoted and never evaluate it.
- **`--ntfy=<url>`** (on `start`): the in-page collector `POST`s each finalized phrase
  as JSON to that https URL (fire-and-forget, `no-cors`). Use an `ntfy.sliccy.ai` hook
  URL (`https://ntfy.sliccy.ai/hook/<id>`, unguessable; create it with a token that has
  the `hooks` scope), since the gateway's topics need a token to publish. The captions
  leave the meeting for that URL, so use a hook only you can read. The URL is kept in
  `~/.local/state/teams/transcribe.json` until `stop`; `--scoop` (SLICC 6) is refused.
- **`--snapshot`** (a flag, composes with any subcommand — typically `flush`): if a screen share is active, captures **only the shared-screen preview** — it draws the largest shared `<video>` element to an in-page canvas and exports a PNG — and keeps it only if the shared content changed (a pixel-payload hash), into `--shots-dir` (default `~/.local/state/teams/copilot-shots/`). Scoping to the video means the dedupe ignores unrelated window churn (captions, chat, roster, clock). Falls back to a full-window screenshot if no capturable video is present.
- **`teams post --live <message>`**: posts into the **currently active meeting's chat**, visible to all participants. Uses **real CDP input** via `playwright-cli` (resolve the compose box + Send button from the accessibility snapshot, click → type → click Send) — Teams' CKEditor ignores in-page DOM edits, so genuine keystrokes are required.

> **Validated live** against a real meeting (Jul 2026, SLICC 6): phrase delivery, canvas
> snapshot + content-scoped dedupe, and `post --live` all confirmed working. The SLICC 7
> transport (`--ntfy`, `follow --command`) has not yet run in a live meeting. Selectors
> (caption list, meeting-chat compose/Send, share `<video>`) may still need updates if a
> future Teams build changes its DOM.

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not obtain a Teams sign-in` | Sign in at https://teams.cloud.microsoft, then retry. Deleting `~/.local/state/teams/tab.json` makes teams open a fresh tab of its own. |
| `No Teams meeting tab found` | Join the meeting in a Teams tab, or pass `--tab=<targetId>` (`playwright-cli tab-list`). |
| `401 Unauthorized` | The Teams session expired. Sign in again; delete `~/.local/state/teams/tab.json` so teams opens a fresh tab. |
| `403 Forbidden on message reads` | You're hitting the v1.0 `/messages` endpoint, which requires `ChannelMessage.Read.All` (a scope the delegated browser token lacks). The script already uses the beta endpoint; if you see this, confirm you're on an up-to-date version of `teams.jsh`. |
| `Team/channel not found` | Run `teams teams` or `teams channels <team>` to list the exact names/IDs available to the current token. |
| Search API returns empty / 403 | `teams activity` auto-falls back to a channel scan (delegated tokens often lack the chatMessage search scope). For `teams search`, ensure the token has `Chat.Read` scope. |
| `digest` or `activity` times out | Use `--max-teams=5` to limit the scan. |
| `transcribe` says "No active meeting found" | You must be *in* a meeting (the meeting stage must be the active view in the Teams tab). Join/rejoin the call, then retry. |
| `transcribe` can't find the caption toggle | Teams' menu labels/DOM can change. Turn on captions manually (More → Language and speech → Show live captions), then run `teams transcribe start` — the collector attaches to the existing caption panel. |
| `transcribe status` shows captions rendering but 0 buffered | No one has spoken a full phrase yet, or the tab was reloaded (which clears the in-page buffer). Re-run `teams transcribe start` after a reload. |
| 429 rate-limit errors | The script automatically retries with the `Retry-After` delay (up to 3 times). If you still see 429s, wait a minute and retry. |

## Endpoints reference

See [references/endpoints.md](references/endpoints.md) for per-endpoint
documentation, query parameters, response shapes, rate limiting, and error
codes.
