---
name: icloud
description: >-
  Interact with iCloud Calendar and Notes from a signed-in iCloud Calendar
  browser tab. Use when the user asks about their calendar, upcoming events,
  schedule, creating calendar events, listing calendars, or wants to
  read/search their Apple Notes. Triggers on phrases like "what's on my
  calendar", "upcoming events", "create an event", "add to my calendar",
  "block time", "my notes", "search notes", "read note", "iCloud calendar",
  "iCloud notes".
allowed-tools: bash
---

# iCloud

Access iCloud Calendar and Notes via the iCloud web APIs. Requires an open,
authenticated browser tab at `https://www.icloud.com/calendar/` — the Calendar
app, not the iCloud marketing/home page. Session validate returns 421 from a
signed-out landing page.

## Prerequisites

- A signed-in tab at `https://www.icloud.com/calendar/`
- The tab is detected automatically via `playwright-cli` / `sliccy:browser`

## Commands

```
icloud calendars [--json]
icloud calendar [--date Nd] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--json]
icloud calendar create --title "..." --start "..." --end "..." --calendar "..." [options]
icloud calendar create --from-json [FILE] --calendar "..."
icloud notes [--search "query"] [--json]
icloud notes read <note-id> [--json]
icloud --help
```

### Calendars

Lists every collection from `/ca/allcollections`: title, guid, readOnly,
isDefault, isFamily.

```bash
icloud calendars           # table
icloud calendars --json    # JSON array of those fields
```

Use a title or guid from this list as `--calendar` when creating.

### Calendar

Lists events. Default range is the next 7 days from today. There is no 30-day
cap on `--date`. Use `--start` / `--end` for far windows (2027, multi-year).

```bash
icloud calendar                            # Next 7 days
icloud calendar --date 1d                  # Today only
icloud calendar --date 400d                # Long relative window
icloud calendar --start 2027-07-01 --end 2027-08-31
icloud calendar --json                     # Shared-schema JSON
icloud calendar --raw-json                 # Raw iCloud API JSON
```

`--json` start/end are ISO (`YYYY-MM-DDTHH:MM:00`). The 7th element of an
iCloud date array is minutes-from-midnight, not seconds.

Output includes: date, time range, title, location. Events are sorted
chronologically. All-day events show "all-day" in the time column.

### Calendar create

`--calendar` is required. Resolution order: exact title, then unique
substring, then guid. Errors on no match or ambiguity. Never defaults to
`work` / Arbeit.

```bash
# Timed event
icloud calendar create \
  --title "Review" \
  --start 2026-05-28T15:00 \
  --end 2026-05-28T16:00 \
  --calendar Familie

# All-day multi-day. --end is exclusive (day after last blocked day).
# Same-day start/end is stored as 1 day. tz is null; duration = days × 1440.
icloud calendar create \
  --title "Away" \
  --start 2027-07-31 \
  --end 2027-08-09 \
  --all-day \
  --calendar Familie \
  --dry-run

# Print payload + URL; do not POST
icloud calendar create --title "…" --start … --end … --calendar Familie --dry-run

# Pipe from another calendar CLI
outlook calendar --json | icloud calendar create --from-json --calendar Familie
```

Flags:

| Flag | Role |
| --- | --- |
| `--title` | Event title |
| `--start` | `YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` with `--all-day` |
| `--end` | Same shapes. All-day end is exclusive |
| `--calendar` | Required. Exact title, unique substring, or guid |
| `--all-day` | All-day event (`tz: null`, `duration = days × 1440`) |
| `--location` | Optional location |
| `--block` | Privacy mode: title becomes `Blocked` |
| `--from-json` | Shared-schema events from stdin or a file |
| `--dry-run` | Print the create payload and URL; do not POST |

`--dry-run` is the only safe way to inspect a write. Do not POST a calendar
event unless the user asked to create one.

## Architecture

- Uses `playwright-cli eval` / `sliccy:browser` to execute `fetch()` in the
  iCloud page context
- Authentication is handled by the browser session cookies (no tokens needed)
- Session info (dsid, API URLs) discovered via `/setup/ws/1/validate`
- Calendar API: `pXX-calendarws.icloud.com/ca/events`
- Calendar list: `pXX-calendarws.icloud.com/ca/allcollections`
- Notes API: `pXX-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private/changes/zone`
- Notes titles/snippets are base64-encoded UTF-8
- Notes body is gzip-compressed protobuf (text extracted heuristically)
- All page-context fetches use `Content-Type: text/plain`. `application/json`
  triggers a CORS preflight the calendar host does not satisfy, so the request
  never leaves the browser.

See [references/api-notes.md](references/api-notes.md) for the date-array
layout, all-day exclusive-end contract, and the 2026-08-24 Familie write.

## Limitations

- Requires an active signed-in Calendar tab (re-authenticate if the session expires)
- Notes content extraction is best-effort from protobuf binary
- Calendar timezone for timed events is Europe/Berlin (matches user preference)
- Notes pagination limited to 10 iterations (~500 notes max)
