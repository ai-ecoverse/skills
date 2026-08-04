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

### Scope gate — why `aud` alone is not enough

OWA mints several tokens for the **same** audience (`https://outlook.office.com`)
with very different privileges. Alongside the full mailbox token (74 scopes, ~85 min)
the SPA emits single-purpose short-lived ones whenever it lazily loads an
attachment — observed live: `scp: "OwaAttachments.Read"`, 300 s lifetime. Those pass
an `aud`/`exp` check but answer `403 Access is denied` on `/me/messages` and
`/me/calendarview`.

That is what made `outlook monday` intermittently print `[]` with two 403 warnings:
the capture hook had latched the attachment token, and it stayed the one the SPA was
re-sending for tens of seconds. So `isFreshBearerCandidate()` also requires a scope
that actually grants mailbox access (`Mail.*`, `Calendars.*`,
`OWA/EAS/OutlookService.AccessAsUser*`, `.default`, `full_access_as_user`). A token
with **no** `scp` claim is still accepted — there is nothing to judge it by, and
rejecting it would break the legacy plaintext-cache path.

### Retry on 401/403

Even with the scope gate a token can stop being usable mid-command, because Outlook
rotates it. `owaGet`/`owaPost` therefore share `withAuthRetry()`: on **401 or 403
only**, the failing token is added to an in-process reject set, blanked from
`/shared/.outlook-token` so a later run cannot pick it up, re-extracted once from the
browser, and the request is replayed **exactly once**. Never a loop.

- If re-extraction yields the *same* token, `reacquireToken()` returns `null` and the
  original HTTP error is surfaced — replaying with a token that just failed is
  pointless, and a permanently unauthorised session must still fail loudly.
- `effectiveToken()` routes the remaining calls of a multi-request command straight
  to the replacement, so only the first one pays for the retry.
- Replaying a POST is safe: 401/403 means the request was rejected before it was
  processed, so no mail was sent and no invitation was answered.
- Other statuses (400, 404, 5xx) are never retried.

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
