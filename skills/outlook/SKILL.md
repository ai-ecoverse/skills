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

Direct API access to Microsoft Outlook via the browser session. Requires an open
Outlook tab at `outlook.office.com` — the token is extracted automatically.

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

List upcoming calendar events with time, organizer, location, and response status.

**Options:**
- `--limit N` — number of events (default: 20)
- `--date PERIOD` — how far ahead to look (default: `2d`)
- `--json` — output raw JSON array

### outlook view \<message-id\>

View a single email message with full headers and body text.

### outlook accept|decline|tentative \<event-id\> [...] [options]

Respond to one or more calendar events. Get event IDs from `outlook calendar --json`.

**Options:**
- `--comment TEXT` — optional message to the organizer
- `--silent` — don't send a response notification to the organizer
- `--all` — respond to all `NotResponded` events in the date range
- `--date PERIOD` — date range for `--all` (default: `2d`)

```bash
# Accept a single event
outlook accept AAMkADQ...

# Decline multiple events
outlook decline AAMk...1 AAMk...2 --comment "Schedule conflict"

# Tentatively accept all pending
outlook tentative --all --date 7d
```

**Batch accept/decline workflow:**
1. List pending events and review: `outlook calendar --date 7d --json`
2. Identify `NotResponded` events by ID.
3. Respond: `outlook accept --all --date 7d` (or target specific IDs).
4. Verify: `outlook calendar --date 7d --json` — confirm response status updated.

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
