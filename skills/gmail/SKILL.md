---
name: gmail
description: >-
  Interact with Gmail — read inbox, search messages, view full message bodies,
  send email, reply to threads, and produce aggregated inbox items for the monday
  dispatcher. Authenticates via OAuth2 refresh token — either GWS_* env vars or
  credentials persisted by `gmail login`. Triggers on requests involving Gmail,
  Google email, inbox, sending mail, checking unread messages, signing in to
  Gmail, or monday inbox aggregation that includes Gmail data.
allowed-tools: bash
---

# Gmail

Direct API access to Gmail via OAuth2 refresh token flow. Credentials come from
either the `GWS_*` environment variables or from credentials persisted by
`gmail login`; see [Authentication](#authentication) for the precedence rules.

## Quick start

```bash
# List recent inbox messages
gmail mail --limit 10

# Unread only
gmail mail --unread

# Search inbox
gmail mail --search "quarterly report"

# Filter by age
gmail mail --date 3d --unread

# View a single message (full body)
gmail view <message-id>

# Send an email
gmail send --to user@example.com --subject "Hello" --body "Message body"

# Send HTML email with CC
gmail send --to user@example.com --subject "Update" --body "<h1>Hi</h1>" --html --cc manager@example.com

# Reply to a message
gmail reply --id MESSAGE_ID --body "Thanks, got it."

# Monday aggregation (unread inbox, last 24 hours)
gmail monday --limit 20 --date 1d
```

## Authentication

Credentials are resolved in a fixed order, first match wins:

1. **Environment variables** — used only if `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`
   and `GWS_REFRESH_TOKEN` are *all* set. Takes precedence over stored config.
2. **Persisted skill config** — written by `gmail login`. Survives across
   sessions, so you authenticate once.

If neither is present, every command fails with a message naming both options.
An access token is minted on demand from the refresh token and cached until it
expires, so tokens are never stored long-term by the caller.

| Variable | Description |
|----------|-------------|
| `GWS_CLIENT_ID` | OAuth2 client ID |
| `GWS_CLIENT_SECRET` | OAuth2 client secret |
| `GWS_REFRESH_TOKEN` | Long-lived refresh token |
| `GWS_TYPE` | Literal `authorized_user` (not used by the script) |

If your organization already has a Google Cloud OAuth client and has provisioned
these three as real secrets, set them and skip the rest of this section.

Run `gmail auth` at any time to see which source is active. It prints the
account, scope and credential source, and never prints secret values.

> **Scope warning:** the tested scope is `https://mail.google.com/` — full
> read, send *and delete* access to the mailbox. Treat stored credentials
> accordingly, and prefer a dedicated account over a personal mailbox where
> that distinction matters.

### Obtaining credentials inside SLICC

If you don't already have `GWS_*` values provisioned, you can bootstrap them
yourself from inside a SLICC session using `oauth-token`'s intercept mode
(either the `--from-file <path>` form or the equivalent `--intercept
--authorize-url ... --redirect-pattern ...` flag form — both build the same
underlying `InterceptOAuthConfig` and run the identical mechanism, see
`oauth-token --help`) together with a well-known, publicly-documented OAuth
client (no new Google Cloud project or app-review needed). See
[`references/oauth-bootstrap.md`](references/oauth-bootstrap.md) for the
full, tested walkthrough — including the exact intercept config, the
token-exchange command, a curl gotcha you'll likely hit if you improvise it
yourself, and a security note on the risk of the authorization code being
exposed before exchange.

## Commands

### gmail login [--from-file PATH]

Authenticate and persist credentials so later runs need no env vars.

With no arguments, runs the interactive browser consent flow and stores the
resulting refresh token in the skill config. A human must complete the Google
consent screen — this step is inherently interactive.

With `--from-file PATH`, imports credentials from a JSON file instead of running
consent. Required fields: `client_id`, `client_secret`, `refresh_token` — all
three, because a refresh token only works with the client that issued it.
Optional: `token_uri`, `scope`, `account`.

The imported credentials are validated against Google *before* anything is
persisted, so a rejected or incomplete import fails with a non-zero exit and
leaves existing stored credentials untouched.

```bash
gmail login                              # browser consent
gmail login --from-file ./creds.json     # import existing credentials
```

The consent flow captures the redirect with a bounded timeout. If it expires
before you finish, the authorization code is lost and you must re-run `login` —
re-arm it *first*, then complete the consent screen.

### gmail auth

Show which credential source is active (`env` or `config`), the account, and the
scope. Prints no secret values. `gmail whoami` is an alias.

### gmail logout [--no-revoke]

Clear the persisted credentials. By default it also attempts to revoke the
refresh token with Google first; that revocation is best-effort, so the local
credentials are cleared even if the network call fails.

Pass `--no-revoke` to clear locally without contacting Google — use this when
the same refresh token is still needed elsewhere.

Env-var credentials are unaffected — unset those separately.

### gmail mail [options]

List inbox messages with sender, subject, date, and snippet.

**Options:**
- `--limit N` — number of messages (default: 20)
- `--date PERIOD` — filter by age: `1d`, `7d`, `2w`, `1m` (default: all)
- `--unread` — show only unread messages
- `--search QUERY` — Gmail search query (maps to the `q` API parameter)
- `--json` — output raw JSON array

### gmail view \<message-id\>

View a single email message with full headers and decoded body text.

### gmail attachments \<message-id\>

List a message's file attachments — name, MIME type, size, and `attachmentId`. Add `--json` for machine-readable output.

### gmail download \<message-id\> [attachmentId] [--out=PATH]

Download attachments to disk (binary-safe). With an `attachmentId`, `--out` is the target file path; without one, all attachments are written into the `--out` directory using their original filenames.

```bash
gmail attachments 19f0298dd5234642
gmail download 19f0298dd5234642 --out=/tmp/receipts/            # all attachments
gmail download 19f0298dd5234642 ANGjd... --out=/tmp/folio.pdf   # one attachment
```

### gmail send --to EMAIL --subject TEXT --body TEXT [--html]

Send an email to one or more recipients.

**Options:**
- `--to EMAIL` — recipient(s), comma-separated (required)
- `--subject TEXT` — email subject (required)
- `--body TEXT` — email body (required)
- `--html` — send as `text/html` instead of `text/plain`
- `--cc EMAIL` — CC recipients, comma-separated
- `--bcc EMAIL` — BCC recipients, comma-separated

### gmail reply --id MESSAGE\_ID --body TEXT [--html]

Reply to a message, threading it correctly in Gmail.

**Options:**
- `--id MESSAGE_ID` — message to reply to (required)
- `--body TEXT` — reply body (required)
- `--html` — send reply as HTML

### gmail monday [options]

Monday protocol aggregation. Fetches unread inbox messages and outputs a JSON
array to stdout (no other output on stdout).

**Options:**
- `--limit N` — max messages (default: 20)
- `--date PERIOD` — date range (default: `1d`)
- `--depth N` — if > 0, fetch full body for each message (default: 0, snippet only)

**Output shape:**
```json
{
  "id": "gmail-MESSAGE_ID",
  "source": "gmail",
  "type": "email",
  "title": "Subject line",
  "subtitle": "From: sender@example.com",
  "url": "https://mail.google.com/mail/u/0/#inbox/MESSAGE_ID",
  "ts": "2025-01-15T10:30:00.000Z",
  "body": "snippet or first 500 chars",
  "participants": ["sender@example.com"],
  "meta": {
    "unread": true,
    "labels": ["INBOX", "UNREAD"],
    "threadId": "THREAD_ID"
  }
}
```

## Common workflows

### Search, review, then reply

```bash
# 1. Search for messages on a topic
gmail mail --search "project proposal" --limit 10

# 2. View the most relevant message to confirm it's the right one
gmail view MESSAGE_ID

# 3. Confirm subject and sender before replying, then reply
gmail reply --id MESSAGE_ID --body "Thanks for the proposal, I'll review it shortly."
```

### Check unread, read, then follow up

```bash
# 1. List unread messages from the last day
gmail mail --unread --date 1d

# 2. View the full body of a message before acting on it
gmail view MESSAGE_ID

# 3. Send a follow-up if needed — verify recipient and subject before sending
gmail send --to sender@example.com --subject "Re: Topic" --body "Following up on this."
```

> **Tip:** When replying to or following up on an existing thread, run
> `gmail view MESSAGE_ID` first to confirm the recipient, subject, and context.
> For brand-new outbound mail (no prior message), use `gmail send` directly.

## Error handling

If `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`, or `GWS_REFRESH_TOKEN` are missing, the
script prints a diagnostic message and exits with code 1. API errors include the
HTTP status and error message from Google.
