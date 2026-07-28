# Outlook skill — implementation notes (maintainers)

Not needed to use the CLI. Kept here so the behaviour is documented somewhere
other than the source comments.

## Authentication

`outlook.jsh` calls the Outlook REST API at `https://outlook.office.com/api/v2.0`.
The bearer token is scraped from an open Outlook tab: first the legacy plaintext
MSAL cache, then — for clients with an encrypted cache — a live capture of the
SPA's own `Authorization` header. Captured tokens are revalidated (`aud`, `exp`
plus a safety margin) before use and cached in `/shared/.outlook-token`. See the
comment block at the top of `scripts/outlook.jsh` for the stale-token bug this
guards against; don't simplify it.

## Timezone handling

Calendar and event requests send `Prefer: outlook.timezone="<zone>"`, so OWA
returns `Start`/`End` as wall-clock times in that zone rather than UTC. The zone
comes from `GET /me/MailboxSettings` → `TimeZone` and is cached in
`/shared/.outlook-timezone` as `{ mailbox, timeZone, cachedAt }` — keyed on the
mailbox identity from the token's own claims, with a 24h TTL, so switching accounts
or changing the zone in Outlook re-reads it. `--timezone` overrides.

Because those timestamps carry no offset, they must not be re-parsed as UTC (doing
so is what made an 11:30 local meeting print as `09:30 UTC`).
`Recurrence.Range.RecurrenceTimeZone` is the series' *authoring* zone and is
reported separately from the display zone.

## Invite body and join info

Event details fetch `Body` rather than `BodyPreview`, which truncates mid-invite.
The HTML is converted to text in-script (no external dependency): raw newlines are
treated as HTML whitespace first, `<br>`/block-close tags become newlines, tags are
stripped, named and numeric entities are decoded, blank lines dropped.

Join info is parsed from that text. Teams emits a label and its value in separate
tags, so labels match either inline or on the following line, in English and German,
and older invite layouts (`Video Conference ID`, an unlabelled `…@m.webex.com`
tenant key) are handled. The join URL falls back
`OnlineMeeting.JoinUrl` → `OnlineMeetingUrl` → the invite's join anchor
(`originalsrc`, i.e. the un-Safelinked URL) → a bare Teams/Zoom/Meet/Webex URL,
because `OnlineMeetingUrl` is frequently `null` even for Teams meetings.

## Known inconsistency

`outlook view <message-id>` still prints its `Date:` header in UTC, while the
calendar and event paths render in the mailbox timezone.
