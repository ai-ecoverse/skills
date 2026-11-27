---
name: gmail
description: >-
  Interact with Gmail — read inbox, search messages, view full message bodies,
  send email, reply to threads, and produce aggregated inbox items for the monday
  dispatcher. Signs in through jerk (`gmail login` runs `jerk gmail create`) or
  uses GWS_* env vars. Triggers on requests involving Gmail, Google email,
  inbox, sending mail, checking unread messages, signing in to Gmail, or monday
  inbox aggregation that includes Gmail data.
allowed-tools: bash
---

# Gmail

Direct API access to Gmail. Sign in once with `gmail login`, which hands the
OAuth flow to [jerk](https://github.com/ai-ecoverse/slicc-jerk); the `GWS_*`
environment variables and credentials persisted by an older `gmail login` still
work. See [Authentication](#authentication) for the precedence rules.

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

A token is resolved in a fixed order, first match wins:

1. **Environment variables** — used only if `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`
   and `GWS_REFRESH_TOKEN` are *all* set. An access token is minted from the
   refresh token on demand.
2. **jerk** — `jerk gmail get --reveal`, from the grant that `gmail login` made.
   jerk refreshes it. In SLICC 7 jerk keeps the grant in the vault and prints a
   placeholder that the vault fills in when the request goes to Google; natively
   it uses the OS keyring.
3. **Persisted config** — credentials stored by an earlier `gmail login` (or
   `gmail login --from-file`), in `~/.local/state/gmail/config.json` (or
   `$GMAIL_STATE_DIR`, `$XDG_STATE_HOME/gmail`), 0600. A copy an older version
   kept in the skill folder (`scripts/.config`) is still read and moves over on
   the next save. Never written by the jerk flow.

With none of them, every command exits 1 with a message that names
`gmail login` and, when jerk isn't on `PATH`, `npm i -g @ai-ecoverse/slicc-jerk`.
`gmail auth` shows which source is active, never a secret.

| Variable | Description |
|----------|-------------|
| `GWS_CLIENT_ID` | OAuth2 client ID |
| `GWS_CLIENT_SECRET` | OAuth2 client secret |
| `GWS_REFRESH_TOKEN` | Long-lived refresh token |

> **Scope warning:** the scope is `https://mail.google.com/` — full read, send
> *and delete* access to the mailbox. Treat the grant accordingly, and prefer a
> dedicated account over a personal mailbox where that distinction matters.

jerk's `gmail` provider uses Mozilla Thunderbird's public Google client with
loopback PKCE. See [`references/oauth-bootstrap.md`](references/oauth-bootstrap.md)
for the sign-in, the exit codes and the legacy paths.

## On a host

`gmail` also runs on macOS and Linux under
[slicc-jsh](https://github.com/ai-ecoverse/slicc-jsh). It makes no browser
connection of its own, so there is no `SLICC_CDP_URL` to set for it; only
`jerk gmail create` needs a browser. See
[`references/jsh-host.md`](references/jsh-host.md).

## Commands

### gmail login [--force] [--from-file PATH]

Sign in. With no file it runs `jerk gmail create` and passes jerk's exit code
through: **3** means a sign-in is needed that can't happen here, **4** means
jerk isn't available (not installed, no browser, no linked slicc CLI). A human
completes Google's consent screen; this step is inherently interactive.
`--force` asks jerk to sign in again.

`--from-file PATH` is the legacy import: it validates `client_id`,
`client_secret` and `refresh_token` (all three, since a refresh token only
works with the client that issued it) against Google, then stores them in the
skill config. A rejected or incomplete import exits non-zero and leaves stored
credentials untouched.

```bash
gmail login                              # jerk gmail create
gmail login --from-file ./creds.json     # legacy: import existing credentials
```

### gmail auth

Show which credential source is active (`env`, `jerk` or `config`), the account, and the
scope. Prints no secret values. `gmail whoami` is an alias.

### gmail logout [--no-revoke]

Clear the legacy persisted credentials. A jerk grant is separate: remove it with `jerk gmail drop`. By default it also attempts to revoke the
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

### gmail view \<message-id\> [--json]

View a single email message with full headers and decoded body text. The text view truncates the body at 5000 characters; `--json` returns it in full, plus label ids, the snippet and the attachment list (so you can pipe straight into `gmail download`).

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

With no credential source the script prints a diagnostic that names `gmail login`
and exits with code 1. API errors include the HTTP status and error message from
Google.