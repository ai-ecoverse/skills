---
name: slack
description: Interact with Slack via its Web API — read messages, post to channels,
  search channels, read threads, and look up users. Use when the user wants to check
  Slack messages, post a Slack message, search Slack channels, read Slack threads,
  get Slack user info, or automate any Slack task. Triggers on mentions of Slack,
  channels, DMs, threads, messages, or Slackbot.
allowed-tools: bash
---

# Slack

Direct API access to Slack via the browser session. Uses XHR from the Slack page
context (same-origin) with the user's `xoxc-*` token from `localStorage`.

## Quick start

```bash
# Read recent messages from a channel
slack history C087NCG774J

# Post a message to Slackbot (safe — never messages real people)
slack post D12AKTSDC "Hello from SLICC!"

# Search for channels
slack channels --search=one-aem

# Read a thread
slack thread C087NCG774J 1774539502.747989

# Look up a user
slack user W5BPKRLUA
```

## Authentication

The token is extracted automatically from `localStorage` key `localConfig_v2` in
the Slack browser tab. The enterprise ID is `E23RE8G4F` (Adobe). All API calls
execute via XHR from the Slack page context so cookies are included automatically.

Requires an open Slack tab at `app.slack.com`. If no Slack tab is found, the script
reports an error and asks the user to open Slack.

## Available commands

### slack history \<channel_id\> [--limit=N]

Fetch recent messages from a channel. Default limit is 20.

### slack post \<channel_id\> \<message\>

Post a message to a channel. The Slackbot DM channel is `D12AKTSDC`. For safety,
posting is restricted to the Slackbot DM only — attempts to post to other channels
are blocked unless `--force` is passed.

### slack channels [--search=term]

Search for channels by name. Uses `search.modules` API (the standard
`conversations.list` is restricted on enterprise grids). Returns channel ID, name,
member count, and purpose.

### slack thread \<channel_id\> \<thread_ts\> [--limit=N]

Read thread replies. Provide the channel ID and the thread's parent timestamp.
Default limit is 50.

### slack user \<user_id\>

Look up user information by user ID. Returns name, display name, title, timezone,
and status.

### slack info \<channel_id\>

Get channel metadata (name, purpose, topic, member count).

### slack slackbot

Opens/finds the Slackbot DM channel and prints its ID.

## Enterprise grid notes

Adobe's Slack is an Enterprise Grid. Some standard Web API methods like
`conversations.list` and `users.conversations` return `enterprise_is_restricted`.
The skill uses `search.modules` (module=channels) for channel discovery and
`conversations.open` for DM channel lookup instead.

## Endpoints reference

See `references/endpoints.md` for the full endpoint documentation.
