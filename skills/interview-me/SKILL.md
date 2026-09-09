---
name: interview-me
description: >
  Runs a spoken, recorded voice interview about the user (or their work,
  project, product, or research) using xAI's Grok realtime Speech-to-Speech
  API, grounded in a knowledge base and live web/X search. Use this skill
  whenever the user asks to "interview me", start a "voice interview",
  "practice interview", "record and transcribe a conversation", have "an
  AI interview me about X", set up a "spoken Q&A session", rehearse
  answers out loud, capture a "verbal braindump" as a structured
  transcript, or otherwise wants a short (1-10 minute), voice-driven,
  agent-led conversation that ends with a transcript, audio/video
  recording, and markdown summary. Also use it for follow-ups: change the
  interview briefing/topic, pick a different voice, ingest documents into
  a knowledge base the interviewer should ask informed questions from,
  adjust session length, or install/reinstall the interview sprinkle
  itself. Two parts: a CLI (`scripts/interview-me.jsh`) and the browser
  sprinkle it installs, which runs the session.
allowed-tools: bash
---

# interview-me

A voice-interview app: a human talks to an AI interviewer over live audio
(optionally video), grounded in a knowledge base (an xAI Collection or a
local folder of `.md`/`.txt` notes) plus web/X search, for a short,
configurable session (default 5 minutes). The session is recorded,
transcribed with timestamps, and saved as a reviewable artifact
(`transcript.json`/`transcript.md`, `session.json`, `diagnostics.json`,
and the recordings). Every connected camera is recorded at once — the hero
as `human.webm`, any extra angles as `video/angleN.webm`, and the agent's
voice as `agent.webm` — kept in sync via `sync.json`. See
`references/multi-camera-recording.md` for the sync model and camera-open
reliability behavior.

This skill has two parts:

1. **The CLI** (`scripts/interview-me.jsh`) — installs the sprinkle,
   manages the prefilled configuration (briefing text, voice, knowledge
   base mode, session length, search settings), and manages an xAI
   Collections knowledge base (create/list/delete collections, ingest
   documents, test search).
2. **The sprinkle** (`assets/sprinkle/interview-me.shtml` + `assets/sprinkle/lib/`)
   — the actual browser UI that runs a live interview: device setup,
   camera/mic preview, the live countdown + waveforms + transcript, and a
   review screen with recordings and downloads. The CLI's `install`
   command copies this into `/shared/sprinkles/interview-me/`, which is
   where SLICC discovers sprinkles from (not this skill's own directory).

## Setup (first time)

1. **Auth**: this skill uses the `xai-grok` skill's OAuth token
   (`skill.token('xai-grok')`) for all xAI API calls (realtime voice
   session + Collections). Set up the `xai-grok` skill's own auth flow
   first if it isn't already connected.
2. **Install the sprinkle**:
   ```
   interview-me install
   ```
   Copies the sprinkle into `/shared/sprinkles/interview-me/` and creates
   the default knowledge-base folder `/shared/sprinkles/interview-me/kb/`
   (empty — the bundled notes about it are installed next to it as
   `KB-README.md`, deliberately outside `kb/` so they never become
   interview source material). Safe to re-run after a skill upgrade to pick
   up fixes — it refreshes `interview-me.shtml`/`lib/*.js` every time but
   never overwrites an existing `config.json`, and never touches your own
   `kb/` files or recorded `sessions/`.
3. **Set a briefing** — what the interviewer should ask about:
   ```
   interview-me brief "Ask me about the project I'm currently building and what's been hardest about it"
   ```
4. **Knowledge base** (optional but recommended for informed questions).
   Two modes:
   - **Local** (default, no extra setup): point at a VFS folder of
     `.md`/`.txt` files —
     `interview-me set kb_mode=local kb_path=/shared/sprinkles/interview-me/kb/`
   - **Collection** (xAI Collections, semantic search, needs a one-time
     create+ingest):
     ```
     interview-me collections create my-notes
     interview-me collections ingest /path/to/notes my-notes
     interview-me set collection=<collection_id>
     ```
     (`collections create`/`ingest` both print the id and the exact next
     `set collection=...` command to run.)
5. **Run it**: `sprinkle open interview-me`. The Setup screen is prefilled
   from whatever was configured above; everything can also be adjusted
   there directly (Advanced tab) for a one-off session without touching
   config.

## Everyday usage

- Change the topic: `interview-me brief "..."` or `interview-me brief --file <path>`
- Change voice/search/session length:
  `interview-me set voice=eve web_search=true x_search=false session_minutes=3`
- Add more source material: `interview-me collections ingest <dir> <collection_id>`
- Check current config: `interview-me config`
- Start fresh: `interview-me reset`
- Full command reference: `interview-me --help`

Every `brief`/`set`/`reset` best-effort pushes a live-reload notice to an
already-open sprinkle (no need to close and reopen it after a config
change) — pass `--no-notify` to skip this for scripted use.

### Checkpoints for destructive / batch commands

These commands change or overwrite state without an interactive prompt, so
validate around them:

- **Before `reset`** — it overwrites `config.json` with defaults immediately
  (no confirmation, no automatic backup). Capture the current settings first
  so you can restore them:
  ```
  interview-me config                # print current settings, or back up the file:
  cp /shared/sprinkles/interview-me/config.json /shared/sprinkles/interview-me/config.backup.json
  ```
  Afterwards, restore a saved briefing with `interview-me brief --file <path>`.
- **After `collections ingest`** — it uploads/attaches each `.md`/`.txt` and
  reports `Ingested N file(s)`. Confirm the documents are actually retrievable
  before relying on them:
  ```
  interview-me collections docs <collection_id>     # per file: STATUS + CHUNKS
  interview-me collections search <collection_id> "a question your notes answer"
  ```
  A non-empty `search` result confirms the collection is grounded and ready.

## Requirements

- SLICC **>= 6.113.0** (uses `FormData`/`Blob` request bodies in `fetch`
  for document upload; older runtimes reject FormData bodies outright).
- A working `xai-grok` skill connection (OAuth token).
- A microphone (and, optionally, one or more cameras — every connected
  camera is recorded as its own synchronized angle) in the browser session
  that opens the sprinkle — there is no way to run a real interview
  headlessly.

## What this is not

The realtime voice session, wrap-up logic, transcript merging, and UI live
in the sprinkle's own code (`assets/sprinkle/`), which the CLI installs
verbatim — not in the CLI itself. To understand *how* the session behaves
(tool calls, wrap-up timing, transcription semantics), read `references/`:
those findings came from empirical testing against the live API, not the
published docs.

## Directory layout

```
SKILL.md
config.example.json             example of the config shape, with placeholders
scripts/interview-me.jsh        CLI (install, config, collections)

assets/sprinkle/                the sprinkle installed by `interview-me install`
  interview-me.shtml
  lib/*.js
assets/kb/README.md             notes on preparing a local knowledge-base folder

references/                     empirical findings about the realtime API
  server-side-tool-calls.md
  transcription-semantics.md
  realtime-connection.md
  steering-mid-session.md
  sprinkle-module-loading.md
  multi-camera-recording.md
```
