# Outlook CLI — full command reference

Every command accepts `--json` unless noted. Run `outlook help` for the built-in
summary.

## outlook mail [options]

List inbox messages with sender, subject, and preview.

- `--limit N` — number of messages (default: 20)
- `--date PERIOD` — filter by age: `1d`, `7d`, `2w` (default: all)
- `--unread` — show only unread messages
- `--search QUERY` — full-text search across all mail folders
- `--json` — output raw JSON array

```bash
outlook mail --limit 10
outlook mail --unread
outlook mail --search "quarterly report"
outlook mail --date 3d --unread
```

## outlook calendar [options]

List upcoming calendar events with time, organizer, location, response status, and
event id. Times are shown in the mailbox timezone, not UTC; the header names the
zone.

- `--limit N` — number of events (default: 20)
- `--date PERIOD` — how far ahead to look (default: `2d`)
- `--details` — full details (invite body + join info) for every event in the window
- `--timezone TZ` — display timezone, a Windows zone name (e.g. `Pacific Standard Time`)
- `--json` — raw JSON array; structured detail objects with `--details`

```bash
outlook calendar
outlook calendar --date 7d
outlook calendar --date 7d --limit 100 --json
outlook calendar --date 1d --details
outlook calendar --timezone "Pacific Standard Time"
```

## outlook event \<event-id\> [options]

Show one event in full: time, organizer, location, your response, attendees,
`Type` (`SingleInstance`/`Occurrence`/`Exception`/`SeriesMaster`), the
`SeriesMasterId` and a recurrence summary for series, a **Join info** block, and
the complete rendered invite body.

**Join info** lists whatever the invite carries: join URL, meeting ID, passcode,
video tenant key and video ID, dial-in number(s) and phone conference ID. Absent
fields are omitted, and an invite with no dial-in says so.

- `--series` — show the series master instead of this occurrence
- `--timezone TZ` — display timezone
- `--json` — structured JSON, including the parsed `conferencing` fields

```bash
outlook event <event-id>
outlook event <event-id> --json
outlook event <occurrence-id> --series
```

Get event ids from `outlook calendar --date 7d --json`, or from the `id:` line of
the plain listing.

## outlook view \<message-id\>

View a single email message with full headers and body text. Mail only — calendar
event ids live in a different store, so passing one reports that and points at
`outlook event <event-id>`.

## outlook attachments \<message-id\>

List a message's file attachments — name, content type, size, and attachment `id`.

## outlook download \<message-id\> [attachmentId] [--out=PATH]

Download attachments to disk (binary-safe). With an attachment `id`, `--out` is the
target file path; without one, all file attachments are written into the `--out`
directory under their original names.

```bash
outlook attachments AAMk...=
outlook download AAMk...= --out=/tmp/etickets/          # all attachments
outlook download AAMk...= AAMk...att --out=/tmp/eticket.pdf
```

## outlook accept|decline|tentative \<event-id\> [...] [options]

Respond to one or more calendar events. **These commands email the organizer.**

- `--dry-run` — print the events that would be responded to and exit, sending nothing
- `--comment TEXT` — message to the organizer
- `--silent` — don't send a response notification to the organizer
- `--all` — respond to every `NotResponded` event in the date range
- `--date PERIOD` — date range for `--all` (default: `2d`)
- `--series` — resolve occurrence/exception ids to their `SeriesMasterId` and respond
  to the whole series

Run `--dry-run` first for anything beyond an explicit single id. See the
[safe-response workflow](../SKILL.md#responding-to-invitations) in `SKILL.md`.

```bash
# Single event, named explicitly
outlook accept AAMkADQ...
outlook decline AAMk...1 AAMk...2 --comment "Schedule conflict"

# Whole series — dry run first, confirm the resolved series-master id, then send
outlook decline <occurrence-id> --series --dry-run
outlook decline <occurrence-id> --series

# Everything pending in a window — dry run first, confirm the list, then send
outlook tentative --all --date 7d --dry-run
outlook tentative --all --date 7d
```

## outlook send --to EMAIL --subject TEXT --body TEXT

Send an email. Multiple recipients can be comma-separated in `--to`.

```bash
outlook send --to user@example.com --subject "Hello" --body "Message body"
```

## outlook monday [--limit N] [--date PERIOD] [--depth N]

Produce a JSON array of actionable items for the monday aggregator: unread inbox
messages plus calendar events for today and tomorrow (including meetings needing a
response).

Each item includes `source`, `type`, `id`, `title`, `body`, `url`, `from`, `date`,
and optional `importance`, `location`, `response`.

Item types:
- `email` — unread inbox message
- `calendar` — calendar event already responded to
- `meeting` — calendar event awaiting response
