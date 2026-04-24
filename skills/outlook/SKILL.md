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

Direct API access to Microsoft Outlook via the browser session. Extracts an MSAL
access token from the Outlook tab's localStorage and calls the Outlook REST API v2
(`outlook.office.com/api/v2.0`). Requires an open Outlook tab at
`outlook.office.com`.

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

# View a single message
outlook view <message-id>

# Send an email
outlook send --to user@example.com --subject "Hello" --body "Message body"

# Monday aggregation (unread mail + upcoming calendar)
outlook monday --limit 20
```

## Authentication

The token is extracted automatically from `localStorage` in the Outlook browser tab.
The script looks for MSAL access tokens (keys containing `accesstoken` and
`outlook.office.com`) and selects the one with the most scopes (which includes
`mail.readwrite`, `calendars.readwrite`, `mail.send`, etc.).

If no browser tab is found, the script falls back to a saved token at
`/shared/.outlook-token`.

Token refresh is automatic — every invocation re-extracts the freshest token from
the browser. MSAL tokens typically expire after ~1 hour but are refreshed silently
by the Outlook web app.

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

## API reference

Uses the Outlook REST API v2 at `https://outlook.office.com/api/v2.0`:

| Endpoint | Description |
|----------|-------------|
| `GET /me/mailFolders/inbox/messages` | Inbox messages |
| `GET /me/messages` | All messages (with `$search`) |
| `GET /me/messages/{id}` | Single message |
| `GET /me/calendarview` | Calendar events in range |
| `POST /me/sendMail` | Send email |

## Error handling

If the token cannot be extracted (no Outlook tab open, expired session), the script
prints: `Could not extract Outlook token. Open Outlook at https://outlook.office.com
in your browser and try again.` and exits with code 1.

API errors include the HTTP status and error message from Microsoft.
