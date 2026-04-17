---
name: teams
description: >-
  Interact with Microsoft Teams via the Graph API — read messages, post to channels,
  search, read threads, look up users, view mentions/activity, and get channel info.
  Supports all teams and channels the user has access to, with auth via the live browser
  session. Use when the user wants to check Teams messages, post a Teams message, search
  Teams channels, read a thread, get user info, view mentions, or automate any Teams task.
  Triggers on mentions of Teams, channels, messages, threads, mentions, activity, or digest.
allowed-tools: bash
---

# Teams

Direct API access to Microsoft Teams via the Microsoft Graph API. Uses the
user's live Teams browser session to extract a delegated access token from
MSAL's `localStorage` cache. No client credentials, no secrets — auth is
zero-config as long as Teams is open in the browser.

## Quick start

```bash
# Extract a fresh token from the open Teams tab
teams auth

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

# Messages mentioning/involving me (default: last 7 days)
teams activity
teams activity --since=30d

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
```

## Authentication

Run `teams auth` to extract and store a Graph API bearer token from the open
Teams browser tab. The command:

1. Finds the Teams tab via `playwright-cli tab-list`
2. Reads the MSAL token cache from **`localStorage`** via `playwright-cli eval`
3. Stores the token at `/workspace/.teams-token`
4. Prints the authenticated user's name, email, and ID

If the token expires (you see `401 Unauthorized`), re-run `teams auth`. The
Teams web client silently refreshes the token in the background, so a fresh
extraction is usually all you need.

> **Implementation note:** The Teams web client (v2, `teams.microsoft.com/v2/`)
> stores MSAL tokens in `localStorage`, not `sessionStorage`. The auth command
> searches `localStorage` for the key containing both `accesstoken` and
> `graph.microsoft.com`, picks the entry with the highest `expiresOn`, and
> extracts its `secret` field. A `sessionStorage` fallback exists for older
> Teams versions.

**Prerequisite:** Teams must be open and loaded in the browser. Check for an existing tab
before opening a new one to avoid duplicates:

```bash
# Check whether a Teams tab is already open
playwright-cli tab-list | grep teams.microsoft.com

# Only open a new tab if the above returns nothing
open https://teams.microsoft.com
```

Wait for the page to fully load before running `teams auth`.

## API Endpoint Note

Channel message reads use the **beta** Graph endpoint
(`https://graph.microsoft.com/beta/...`), not v1.0. The delegated token from
the Teams browser session does not include `ChannelMessage.Read.All`, so the
v1.0 messages endpoint returns 403. The beta endpoint works with the scopes
the Teams session actually provides. Team listing, channel listing, user
profile, and channel info calls use v1.0 as normal.

## Available commands

All commands output JSON to stdout (one top-level object or array per
invocation). Parse the output to answer the user's question.

### teams auth

Extract and store a Graph API token from the open Teams browser tab. Prints
the authenticated user's `displayName`, `email`, `id`, and the token's
`expiresOn` timestamp.

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

### teams activity [--since=DURATION] [--max-teams=N]

Messages that mention or involve the current user. Default window is the last
7 days. See the full description in the **Available commands** section below.

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

### teams activity [--since=DURATION] [--max-teams=N]

Messages that mention or involve the current user. Default window is the last
24 hours. Uses the Graph Search API (`/search/query`, beta) for speed. If
Search returns 403 (common with delegated browser tokens that lack the
`chatMessage` search scope), the command automatically falls back to scanning
recent messages across the first `--max-teams` teams (default 5) × 3 channels
each, with early exit once `--top` results are found.

> **Large tenants:** With 100+ teams the fallback scan can exceed the 30s
> runner timeout. Use `--max-teams=3` to cap the scan to the first 3 teams.

**Alias:** `teams mentions` also routes to `activity`.

### teams digest [--since=DURATION] [--max-teams=N]

Cross-team / cross-channel activity digest. For each channel with recent
activity in the window (default 24h), returns:

- `messageCount`, `uniqueAuthors`, list of authors
- `hasAttachments` boolean
- reaction summary (reaction type → count)
- top 3 messages (author + date + preview)

Sorted by message count descending. Scans up to `--max-teams` teams (default
20). Progress is printed to stderr so you can see which team is being scanned.

> **Large tenants:** With 175+ teams the default cap of 20 keeps the scan
> within the 30s runner budget. Lower it further with `--max-teams=5` if
> needed.

## Troubleshooting

| Problem | Fix |
|---|---|
| `No Teams tab found` | First check if a tab is already open: `playwright-cli tab-list`. If a Teams URL appears, run `teams auth` directly. Only open a new tab (`open https://teams.microsoft.com`) if nothing is listed. |
| `No MSAL token found` | Modern Teams (v2) stores tokens in `localStorage`, not `sessionStorage`. If extraction fails, reload the Teams tab and wait for it to fully render before retrying. |
| `401 Unauthorized` | Token expired. Run `teams auth` again — the Teams web app will have already refreshed the token silently. |
| `403 Forbidden on message reads` | You're hitting the v1.0 `/messages` endpoint, which requires `ChannelMessage.Read.All` (a scope the delegated browser token lacks). The script already uses the beta endpoint; if you see this, confirm you're on an up-to-date version of `teams.jsh`. |
| `Team/channel not found` | Run `teams teams` or `teams channels <team>` to list the exact names/IDs available to the current token. |
| Search API returns empty / 403 | `teams activity` auto-falls back to a channel scan (delegated tokens often lack the chatMessage search scope). For `teams search`, ensure the token has `Chat.Read` scope. |
| `digest` or `activity` times out | Use `--max-teams=5` to limit the scan. The .jsh runner has a ~30s budget; large tenants need a smaller cap. |
| 429 rate-limit errors | The script automatically retries with the `Retry-After` delay (up to 3 times). If you still see 429s, wait a minute and retry. |

## Endpoints reference

See [references/endpoints.md](references/endpoints.md) for per-endpoint
documentation, query parameters, response shapes, rate limiting, and error
codes.
