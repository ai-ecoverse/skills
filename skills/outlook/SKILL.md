---
name: outlook
description: >-
  Interact with Microsoft Outlook (Office 365) — read inbox, search mail, view
  calendar events, send email, and produce aggregated inbox items for the monday
  dispatcher. Uses the live Outlook browser session via MSAL token extraction
  from localStorage. Triggers on requests involving Outlook, email, inbox, calendar,
  meetings, sending mail, checking unread messages, or monday inbox aggregation that
  includes Outlook data.
allowed-tools: bash
---

# Outlook

Direct API access to Microsoft Outlook via Microsoft Graph. The CLI extracts an
MSAL token from an open `outlook.office.com` browser tab when available, and
falls back to a saved token file so commands keep working without a tab open.

## Quick start

```bash
# List recent inbox messages
outlook mail --limit 10

# Unread only
outlook mail --unread

# Search across all folders
outlook mail --search "quarterly report"

# Filter by age
outlook mail --date 3d --unread

# View calendar for the next 2 days
outlook calendar

# View calendar for the next week
outlook calendar --date 7d

# Full details for one event — invite body, Teams/Webex join info, recurrence
outlook event <event-id>
outlook event <event-id> --json

# Accept/decline calendar events by ID
outlook accept <event-id>
outlook decline <event-id> --comment "Conflict"

# Accept all pending events
outlook accept --all

# Decline all pending in the next week
outlook decline --all --date 7d

# View a single message
outlook view <message-id>

# Send an email
outlook send --to user@example.com --subject "Hello" --body "Message body"

# Monday aggregation (unread mail + upcoming calendar)
outlook monday --limit 20
```

## Commands

### outlook mail [options]

List inbox messages with sender, subject, and preview.

**Options:**
- `--limit N` — number of messages (default: 20)
- `--date PERIOD` — filter by age: `1d`, `7d`, `2w` (default: all)
- `--unread` — show only unread messages
- `--search QUERY` — full-text search across all mail folders
- `--json` — output raw JSON array

### outlook calendar [options]

List upcoming calendar events with time, organizer, location, response status, and event id.

Times are shown in the mailbox timezone, not UTC; the header names the zone.

**Options:**
- `--limit N` — number of events (default: 20)
- `--date PERIOD` — how far ahead to look (default: `2d`)
- `--details` — full details (invite body + parsed join info) for every event in the window
- `--timezone TZ` — override the display timezone (Windows zone name, e.g. `Pacific Standard Time`)
- `--json` — output raw JSON array (structured details objects with `--details`)

### outlook event \<event-id\> [options]

Show one event in full: time, organizer, location, your response, attendees,
`Type` (`SingleInstance`/`Occurrence`/`Exception`/`SeriesMaster`), the
`SeriesMasterId` and recurrence summary for series, a **Join info** block, and the
whole rendered invite body.

**Join info** lists whatever the invite carries: join URL, meeting ID, passcode,
video tenant key and video ID, dial-in number(s) and phone conference ID. Fields
that are absent are omitted, and an invite with no dial-in says so.

**Options:**
- `--series` — show the series master instead of this occurrence
- `--timezone TZ` — override the display timezone
- `--json` — structured JSON including the parsed conferencing fields

Get event ids from `outlook calendar --date 7d --json` (or the `id:` line of the
plain listing).

### outlook view \<message-id\>

View a single email message with full headers and body text. Mail only — calendar
event ids live in a different store; passing one reports that and points at
`outlook event <event-id>` instead of a bare `HTTP 404`.

### outlook attachments \<message-id\>

List a message's file attachments — name, content type, size, and attachment `id`. Add `--json` for machine-readable output.

### outlook download \<message-id\> [attachmentId] [--out=PATH]

Download attachments to disk (binary-safe, via the OWA `ContentBytes` payload). With an `id`, `--out` is the target file path; without one, all file attachments are written into the `--out` directory using their original names.

```bash
outlook attachments AAMk...=
outlook download AAMk...= --out=/tmp/etickets/       # all attachments
outlook download AAMk...= AAMk...att --out=/tmp/eticket.pdf
```

### outlook accept|decline|tentative \<event-id\> [...] [options]

Respond to one or more calendar events. Get event IDs from `outlook calendar --json`.

**Options:**
- `--comment TEXT` — optional message to the organizer
- `--silent` — don't send a response notification to the organizer
- `--all` — respond to all `NotResponded` events in the date range
- `--date PERIOD` — date range for `--all` (default: `2d`)
- `--series` — resolve occurrence/exception ids to their `SeriesMasterId` and respond to the whole series
- `--dry-run` — print the events that would be responded to and exit without sending anything

Always run `--dry-run` first when using `--all` or `--series`: both fan out to
events you did not name, and a real response emails the organizer.

```bash
# Accept a single event
outlook accept AAMkADQ...

# Decline multiple events
outlook decline AAMk...1 AAMk...2 --comment "Schedule conflict"

# Tentatively accept all pending
outlook tentative --all --date 7d

# Decline a whole recurring series from any occurrence id (check first)
outlook decline <occurrence-id> --series --dry-run
outlook decline <occurrence-id> --series
```

**Batch accept/decline workflow:**
1. List events in the window with a high enough limit: `outlook calendar --date 7d --limit 100 --json`.
2. Filter for items where `response` is `NotResponded` and collect their `id` values for the ones you actually want to act on.
3. Respond to those specific IDs: `outlook accept <id1> <id2> ...` (or `decline` / `tentative`). Only use `--all --date 7d` when every `NotResponded` event in the window should receive the same response.
4. Verify: `outlook calendar --date 7d --limit 100 --json` — confirm `response` updated for the targeted IDs.

### outlook send --to EMAIL --subject TEXT --body TEXT

Send an email. Multiple recipients can be comma-separated in `--to`.

### outlook monday [--limit N] [--date PERIOD] [--depth N]

Produce a JSON array of actionable items for the monday aggregator. Fetches:
- Unread inbox messages
- Calendar events for today and tomorrow (including meetings needing response)

Each item includes `source`, `type`, `id`, `title`, `body`, `url`, `from`, `date`,
and optional fields like `importance`, `location`, and `response`.

**Item types:**
- `email` — unread inbox message
- `calendar` — calendar event (already responded to)
- `meeting` — calendar event awaiting response
