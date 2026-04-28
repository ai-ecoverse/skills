---
name: gmail
description: >-
  Interact with Gmail — read inbox, search messages, view full message bodies,
  send email, reply to threads, and produce aggregated inbox items for the monday
  dispatcher. Uses OAuth2 refresh token flow via GWS_* env vars. Triggers on
  requests involving Gmail, Google email, inbox, sending mail, checking unread
  messages, or monday inbox aggregation that includes Gmail data.
allowed-tools: bash
---

# Gmail

Direct API access to Gmail via OAuth2 refresh token flow. Uses the `GWS_CLIENT_ID`,
`GWS_CLIENT_SECRET`, and `GWS_REFRESH_TOKEN` environment variables to obtain a
fresh access token from `https://oauth2.googleapis.com/token`. No browser tab needed.

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

The script uses three environment variables injected by SLICC's fetch proxy:

| Variable | Description |
|----------|-------------|
| `GWS_CLIENT_ID` | OAuth2 client ID |
| `GWS_CLIENT_SECRET` | OAuth2 client secret |
| `GWS_REFRESH_TOKEN` | Long-lived refresh token |
| `GWS_TYPE` | Literal `authorized_user` (not used by the script) |

On every invocation the script POSTs to `https://oauth2.googleapis.com/token` with
`grant_type=refresh_token` to obtain a fresh access token. The token is cached
in-process for the duration of the command. No browser, no MSAL, no `gws` binary
needed.

## Commands

### gmail mail [options]

List inbox messages with sender, subject, date, and snippet.

**Options:**
- `--limit N` — number of messages (default: 20)
- `--date PERIOD` — filter by age: `1d`, `7d`, `2w`, `1m` (default: all)
- `--unread` — show only unread messages
- `--search QUERY` — Gmail search query (maps to the `q` API parameter)
- `--json` — output raw JSON array

### gmail view \<message-id\>

View a single email message with full headers and decoded body text. Decodes
base64url MIME parts, preferring text/plain and falling back to text/html with
tag stripping. Recurses into multipart/* structures.

### gmail send --to EMAIL --subject TEXT --body TEXT [--html]

Send an email. Builds an RFC 5322 message, base64url-encodes it, and POSTs to
the Gmail send endpoint.

**Options:**
- `--to EMAIL` — recipient(s), comma-separated (required)
- `--subject TEXT` — email subject (required)
- `--body TEXT` — email body (required)
- `--html` — send as `text/html` instead of `text/plain`
- `--cc EMAIL` — CC recipients, comma-separated
- `--bcc EMAIL` — BCC recipients, comma-separated

### gmail reply --id MESSAGE\_ID --body TEXT [--html]

Reply to a message. Fetches the original to set `In-Reply-To`, `References`,
and `threadId` so the reply threads correctly in Gmail.

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

## Gmail API endpoints

Base URL: `https://gmail.googleapis.com/gmail/v1/users/me`

| Endpoint | Description |
|----------|-------------|
| `GET /messages?maxResults=N&q=QUERY` | List messages matching search query |
| `GET /messages/{id}?format=full` | Get message with full MIME body |
| `GET /messages/{id}?format=metadata` | Get message with headers and snippet |
| `POST /messages/send` | Send message (`{ raw: base64url }`) |

Message web URL: `https://mail.google.com/mail/u/0/#inbox/{id}`

## Error handling

If `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`, or `GWS_REFRESH_TOKEN` are missing, the
script prints a diagnostic message and exits with code 1. API errors include the
HTTP status and error message from Google.
