---
name: cosmos
description: >
  Drive Augment Code's Cosmos web app (cosmos.augmentcode.com) from the shell: list expert
  presets and environments, list and read agent sessions and their message transcripts, and
  delegate a new coding session to an expert. Use when the user mentions Cosmos, Augment,
  Augment Code, augmentcode, an Augment agent, an agent session, a Cosmos session, a Cosmos
  expert, PR Author, Deep Code Reviewer, a Cosmos folder or environment, or session messages.
  Triggers on phrases like "delegate this issue", "delegate this to an agent", "hand this to
  Cosmos", "spin up an agent session", "what are my Cosmos sessions", "what is the agent
  doing", "show the agent transcript", "read the session messages", "which experts do I
  have", "list my Cosmos environments", "create a session from the PR Author expert".
allowed-tools: bash
command: cosmos
script: scripts/cosmos.jsh
---

# Cosmos Skill

Client for Augment Code's Cosmos app. In Cosmos a **session** (called an "agent" on
the wire) is a coding agent created from an **expert** preset such as "PR Author
(GitHub)", running inside an **environment** (also shown as a folder) such as "AI
Ecoverse". This skill reads that state and can delegate a new session, so an agent
does not have to click through the UI.

Wire format was captured with the `secret-sauce` skill (HAR) and re-checked against a
logged-in tab. The durable record, including request and response fields, is
`references/api.md`.

## Requirements

**A `https://cosmos.augmentcode.com` tab open and logged in.** Cosmos sends no
Authorization header and no API key: auth is the session cookie. SLICC's realm
`fetch()` strips cookie headers and cannot set Origin, so every request runs inside
the page context of that tab through `sliccy:browser`. No token is read, stored or
printed. If a call comes back 401/403, or an HTML login wall arrives where JSON was
expected, the script says to reload and log in.

## Usage

```
cosmos me                                  Auth state + boot config
cosmos experts                             Expert presets you can delegate to
cosmos environments                        Environments / folders (alias: folders)
cosmos agents [--limit N]                  Recent sessions, newest first
cosmos agent <agentId>                     One session in detail
cosmos messages <agentId> [--limit N]      Transcript, tool results summarised
cosmos models                              Completion model catalogue
cosmos delegate "<prompt>" --expert <name|id> [--confirm]
```

Flags: `--json` (raw API response), `--limit N`, `--full` (messages: no
summarising), `--expert`, `--env`, `--model`, `--visibility shared|private`, `--cpu`,
`--memory`, `--confirm`, `-h/--help`. `--help` works per command
(`cosmos delegate --help`) and never issues a request.

## delegate is gated behind --confirm

Creating a session spends real compute on the user's Augment account, so `delegate`
is a dry run by default. Without `--confirm` it resolves the expert and the
environment, prints the exact JSON body it would POST, and exits 0. With `--confirm`
it issues exactly one request.

```
cosmos delegate "Fix the flaky VFS test in packages/webapp" --expert "PR Author"
cosmos delegate "Fix slicc issue 2137" --expert pr-author-github-2z4hvjvghl \
  --env "AI Ecoverse" --confirm
```

Two client-generated UUIDs (`idempotency_key`, `initial_message_request_id`) go out
with every call, so retrying a request that failed mid-flight cannot produce a second
session. The session name is the first line of the prompt, capped at 100 characters,
which is what the web UI does.

`--expert` and `--env` accept an id, a slug, an exact name or a unique substring.
Expert names are **not** unique on a real account (several experts are called "PR
Author (GitHub)"), so an ambiguous match is an error that lists the candidates with
their ids instead of guessing.

Capabilities are deliberately not overridden, so the expert's own capability set
applies. `references/api.md` explains why the web UI's `override_builtin_capabilities`
payload is not reproduced.

## Notes

- `--limit` on `agents` defaults to 20 because an unbounded `ListAgents` returned 100
  sessions in one 1.2 MB response on a real account.
- `--limit` on `messages` counts exchanges, not messages: the server returns one user
  and one assistant message per unit. Transcripts reach 300 KB, so thinking blocks,
  tool calls and tool results are summarised unless `--full` is passed.
- `cosmos models` lists the completion-model catalogue, whose names are opaque 64-hex
  hashes. The session model ids `--model` expects (`gpt-5-6-sol`, `claude-opus-5`)
  come from `cosmos experts`.
- Live message updates are not available over HTTP. See the streaming gap in
  `references/api.md`; there is no `watch` command.

## Files

- `scripts/cosmos.jsh`: the client
- `references/api.md`: endpoint and wire-format record, plus known gaps
- `tests/cosmos.test.js`: behaviour tests against a stubbed runtime
