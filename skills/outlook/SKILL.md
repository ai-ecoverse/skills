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

Direct API access to Microsoft Outlook. The CLI extracts an MSAL token from an open
`outlook.office.com` browser tab when available, and falls back to a saved token
file so commands keep working without a tab open. If a command reports it cannot
get a token, open Outlook in the browser and retry.

Full flag-by-flag reference: [references/COMMANDS.md](references/COMMANDS.md).
Implementation notes: [references/internals.md](references/internals.md).

## Quick start

```bash
# Inbox
outlook mail --limit 10
outlook mail --unread
outlook mail --search "quarterly report"
outlook view <message-id|conversation-id>
outlook thread <message-id|conversation-id>   # who is on this chain

# Calendar (times are shown in the mailbox timezone, named in the header)
outlook calendar
outlook calendar --date 7d
outlook calendar --date 7d --json          # ids for the commands below

# One event in full: invite body, Teams/Webex join info, recurrence
outlook event <event-id>
outlook event <event-id> --json

# Respond — always dry-run first, see "Responding to invitations" below
outlook decline <event-id> --dry-run
outlook decline <event-id> --comment "Conflict"

# Send mail
outlook send --to user@example.com --subject "Hello" --body "Message body"

# Monday aggregation (unread mail + upcoming calendar)
outlook monday --limit 20
```

## Who is on a thread

An Outlook web URL — `…/mail/inbox/id/<id>` — carries a **conversation id**, not a
message id. `view` and `thread` both accept either, so paste whichever you have.

`outlook thread` lists every message oldest-first with its own sender, **To** and
**Cc**. Recipients are per message, never merged — in a forwarded or re-Cc'd chain
they genuinely differ, which is usually the answer you want.

```bash
outlook thread <conversation-id>           # previews
outlook thread <message-id> --full         # complete bodies
outlook thread <conversation-id> --json    # from/to/cc/bcc, ts, ids per message
```

## Getting meeting join details

`outlook calendar` lists events and prints each event `id`. Feed that id to
`outlook event` for the whole invite plus a structured **Join info** block (join
URL, meeting ID, passcode, video tenant key and video ID, dial-in number and phone
conference ID — whichever the invite actually contains).

```bash
outlook calendar --date 7d                 # copy the id: line of the event
outlook event <event-id>                   # human-readable
outlook event <event-id> --json            # .conferencing has the parsed fields
outlook event <occurrence-id> --series     # the series, not this occurrence
```

`outlook view` is for mail only; given an event id it says so and points here.

## Responding to invitations

`accept`, `decline` and `tentative` **email the organizer**, and `--all` and
`--series` act on events you did not name individually. Always dry-run first:

1. **Dry-run.** Re-run your exact command with `--dry-run` added. Nothing is sent.
2. **Confirm the printed list** is what you intended — for `--series`, check the
   resolved series-master id; for `--all`, check every event listed.
3. **Re-run without `--dry-run`** only after that confirmation.
4. **Verify** with `outlook calendar --date 7d --limit 100 --json` that `response`
   changed for the intended events only.

```bash
# Whole recurring series, from any occurrence id
outlook decline <occurrence-id> --series --dry-run
outlook decline <occurrence-id> --series

# Everything still unanswered in a window
outlook tentative --all --date 7d --dry-run
outlook tentative --all --date 7d
```

Prefer naming explicit ids — `outlook accept <id1> <id2>` — over `--all` whenever
only some pending events should get the same response.
