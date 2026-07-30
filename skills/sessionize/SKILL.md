---
name: sessionize
description: Interact with Sessionize.com — the speaker/CFP platform — from the command line. Use when the user wants to automate Sessionize, submit a talk to a Sessionize call-for-papers (CFP), build or auto-save a Sessionize submission draft, list the CFPs/events they can submit to, list their Sessionize sessions, or otherwise avoid clicking through sessionize.com. Activate on mentions of Sessionize, CFP, call for papers, call for speakers, submit a talk/session, speaker profile, conference submission, or "submit to <conference> on Sessionize".
allowed-tools: bash
---

# Sessionize

Automate Sessionize.com speaker / CFP workflows: list CFPs, list your
sessions, and build + POST a talk submission (or just auto-save it as a
draft). Reverse-engineered from a captured CFP submission — see
`references/endpoints.md` for the full endpoint + field/GUID reference.

## Auth model — read this first

Sessionize has **no API key / token / PAT**. It authenticates purely with the
**session cookie in your logged-in browser**. This skill therefore issues
every call **same-origin from inside an open `sessionize.com` browser tab**
(exactly like the `slack` skill's `browser.fetch` to relative `/…` paths, with
`credentials` included). Cookies and the correct `Origin` travel
automatically. **No cookie or token is ever read, stored, or forwarded.**

Prerequisite: be logged in to `https://sessionize.com` in your browser. If a
call comes back as an auth/login redirect, log in and retry.

## Commands

```
sessionize sessions                 # list your speaker sessions      (best-effort, not HAR-validated)
sessionize events                   # a.k.a. `cfps` — list CFPs you can submit to (see caveat)
sessionize cfps                     # alias of events
sessionize show <event-slug>        # scrape a CFP form: tokens, custom fields, tag options
sessionize submit <event-slug> [flags]   # build the submission payload and POST it
```

### `submit` flags

```
--title "..."            Session.Title
--description "..."       Session.Description (the abstract)
--session-type "..."      maps to the Session Type custom field (tag)
--primary-track "..."     Primary Track (tag)
--secondary-track "..."   Secondary Track (tag)   [optional]
--level "..."             Level (tag)
--takeaways "..."         Key-takeaways long text
--video "..."             Video URL
--tags "a,b,c"            Tags / technologies (free-tag field)
--company "..."           Company
--role "..."              Role
--consent                 set the acceptance checkbox to true (boolean, single-dash-safe)
--draft                   only POST to /submission-draft (auto-save), do NOT submit for real
--field <guid>=<value>    override/set a custom field's text Value by GUID (repeatable)
--tag <guid>=<label|id>   set a Tag custom field by GUID (repeatable)
--json                    print the raw JSON response
```

Tag flags (`--session-type`, `--primary-track`, `--level`, …) accept the
**human label** as shown on the form; the skill resolves it to the event's
`ValueTagIds` by scraping the form's `<option>` list. If a label can't be
resolved it errors and lists the valid options — pass the id directly with
`--tag <guid>=<id>` in that case.

### How `submit` works

1. GETs the CFP form page `https://sessionize.com/<event-slug>/`
   (same-origin, in your tab) and scrapes: `__RequestVerificationToken`,
   `formex-verification`, `Event.Id`, and for every custom field its GUID,
   `Id`, `Signature`, `FieldType`, and (for Tag fields) the label→id options.
2. Merges those with your flags into the exact
   `application/x-www-form-urlencoded` payload shape Sessionize expects.
3. POSTs to `/submission-draft` (with `--draft`) or `/submission/<event-slug>`
   with headers `X-FormEx: 1`, `X-Requested-With: XMLHttpRequest`.
4. Prints `ValidationErrors` (if any) or the success/redirect payload.

## ⚠️ `submit` needs live verification

The source recording was an **in-progress submission that never completed** —
it was blocked on (1) a bio under 300 chars, (2) a speaker photo smaller than
1000×1000, and (3) a free-tag field sent as comma-joined text instead of valid
tag ids. So the submit **endpoint, headers, and payload shape are confirmed**,
but a **clean, accepted end-to-end submit was never observed in the
recording**. Treat `sessionize submit` (without `--draft`) as **experimental /
needs live verification**: run it once interactively, read the returned
`ValidationErrors`, and fix profile/photo/tag issues before relying on it.
Prefer `--draft` first to validate the payload safely.

Also note:
- Custom-field GUIDs, `Id`s, `Signature`s and tag ids are **event-specific**;
  never hardcode the values from the reference doc — they are scraped live.
- `sessions` / `events` hit `/app/speaker/*` pages that were **not** in the
  recording; they are best-effort and may need adjustment. `cfps`/`events`
  has no confirmed JSON list endpoint (see reference doc).

## Files

- `scripts/sessionize.jsh` — the CLI (command name: `sessionize`).
- `references/endpoints.md` — full extracted endpoint + field/GUID reference.
