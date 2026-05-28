---
name: icloud
description: >-
  Interact with iCloud Calendar and Notes from a signed-in iCloud browser tab.
  Use when the user asks about their calendar, upcoming events, schedule, or
  wants to read/search their Apple Notes. Triggers on phrases like "what's on my
  calendar", "upcoming events", "my notes", "search notes", "read note",
  "iCloud calendar", "iCloud notes".
allowed-tools: bash
---

# iCloud

Access iCloud Calendar and Notes via the iCloud web APIs. Requires an open,
authenticated browser tab at `https://www.icloud.com/`.

## Prerequisites

- An iCloud tab must be open and signed in
- The tab is detected automatically via `playwright-cli tab-list`

## Commands

```
icloud calendar [--date 2d|7d|14d|30d] [--json]
icloud notes [--search "query"] [--json]
icloud notes read <note-id> [--json]
icloud --help
```

### Calendar

Lists upcoming events from all calendars. Default range is 7 days.

```bash
icloud calendar              # Next 7 days
icloud calendar --date 1d    # Today only
icloud calendar --date 30d   # Next 30 days
icloud calendar --json       # Raw JSON output
```

Output includes: date, time range, title, location. Events are sorted
chronologically. All-day events show "all-day" in the time column.

### Notes

Lists recent notes with title and snippet, sorted by last modified.

```bash
icloud notes                          # List recent notes
icloud notes --search "meeting"       # Filter by title/snippet
icloud notes read <note-id>           # Read full note content
icloud notes --json                   # Raw JSON output
```

Note content is stored as gzip-compressed protobuf; the `read` command
decompresses and extracts readable text. Some formatting may be lost.

## Architecture

- Uses `playwright-cli eval` to execute `fetch()` in the iCloud page context
- Authentication is handled by the browser session cookies (no tokens needed)
- Session info (dsid, API URLs) discovered via `/setup/ws/1/validate`
- Calendar API: `pXX-calendarws.icloud.com/ca/events`
- Notes API: `pXX-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private/changes/zone`
- Notes titles/snippets are base64-encoded UTF-8
- Notes body is gzip-compressed protobuf (text extracted heuristically)

## Limitations

- Requires active iCloud session in browser (re-authenticate if session expires)
- Notes content extraction is best-effort from protobuf binary
- Calendar timezone is hardcoded to Europe/Berlin (matches user preference)
- Notes pagination limited to 10 iterations (~500 notes max)
