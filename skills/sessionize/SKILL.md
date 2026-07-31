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
sessionize photo <image> [--profile] [--dry-run] [--json]  # upload + set your speaker photo
```

### `submit` flags

```
--title "..."            Session.Title
--description "..."       Session.Description (the abstract)
--session-type "..."      maps to the Session Type custom field (tag)  [reference event only]
--primary-track "..."     Primary Track (tag)                          [reference event only]
--secondary-track "..."   Secondary Track (tag)                        [reference event only]
--level "..."             Level (tag)                                  [reference event only]
--takeaways "..."         Key-takeaways long text                      [reference event only]
--video "..."             Video URL                                    [reference event only]
--tags "a,b,c"            Tags / technologies (free-tag field)         [reference event only]
--company "..."           Company                                      [reference event only]
--role "..."              Role                                         [reference event only]
--consent                 set the acceptance checkbox to true (boolean, single-dash-safe)
--draft                   only POST to /submission-draft (auto-save)  [see caveat: currently 404s]
--dry-run                 build + print the payload, do NOT post (safe preview)
--field <guid>=<value>    set a text custom field by GUID (repeatable)
--tag <guid>=<label|id>   set a Tag custom field by GUID (repeatable)
--field-id <Id>=<value>   set a text field by its STABLE numeric Id (repeatable, PREFERRED)
--tag-id <Id>=<label|id,...>  set a Tag field by its STABLE numeric Id (repeatable, PREFERRED)
--json                    print the raw JSON response
```

> ⚠️ **Custom-field GUIDs are per-render nonces** — Sessionize regenerates them
> on *every* form load, so a GUID from an earlier `show` will not match the next
> render, and the named convenience flags (`--session-type`, `--primary-track`,
> …) only resolve on the original reference event. **Target fields by their
> stable numeric `Id`** (shown by `show`) with `--field-id` / `--tag-id`. The
> submit re-scrapes the live form and maps the Id to that render's GUID.

Tag flags accept the **human label** as shown on the form (case-insensitive);
the skill resolves it to the event's tag ids by reading the form's option list
(including selectize.js widgets). Comma-separate multiple selections. **A value
that matches no option and isn't already a numeric tag id is a hard error** with
the valid options listed — this prevents the server-side "not valid for
ValueTagIds" rejection you get when free-form text leaks into a tag field.

### How `submit` works

1. Navigates your logged-in Sessionize tab to the CFP form and **serializes the
   ENTIRE live form** (via the DOM, one consistent render): all anti-forgery
   tokens, the full speaker profile (`User.Bio`, `SpeakerLinks[…]`,
   `SpeakerMode`, `ProfilePicture`), the `Impersonated*` blocks, and every
   custom field's `Id`/`Signature`/`FieldType` plus its tag options.
2. **Overlays only the fields you set** (title, description, custom values,
   consent) onto that round-tripped payload, resolving tag labels → numeric ids.
3. POSTs the `application/x-www-form-urlencoded` body to `/submission/<slug>`
   with headers `X-FormEx: 1`, `X-Requested-With: XMLHttpRequest`.
4. Prints `ValidationErrors` (if any) or the success/redirect payload. A clean
   accept returns `RedirectTo: "/<slug>/"` with `ValidationErrors: null`.

Round-tripping the whole form is essential: omitting the profile/hidden fields
makes the server model-binder **500**. Preview safely first with `--dry-run`.

### UTF-8 / encoding

The payload always includes a `_charset_=utf-8` field. Sessionize's ASP.NET
backend decodes `x-www-form-urlencoded` bodies using the charset named in that
field; when it is missing/empty the server falls back to **Latin-1** and
corrupts multibyte characters (an em-dash `—` was stored as `â€"` /
`U+00E2 U+0080 U+0094`). `buildPayload` guarantees exactly one `_charset_=utf-8`
pair (overwriting the form's own value if present), and the body stays UTF-8
percent-encoded (`—` → `%E2%80%94`). See `references/endpoints.md` for details.

## `photo` — speaker photo upload/set

`sessionize photo <local-image-path> [--profile] [--dry-run] [--json]` sets your
speaker photo. Default target is your **profile** photo. It is a **two-step**
flow (reverse-engineered from `/shared/sessionize-photo-recording/`):

1. **Upload the image bytes** → `POST /fileUpload` (same-origin, inside your
   logged-in tab). Multipart `form-data` with ONE field named `file`; headers
   `X-Requested-With: XMLHttpRequest`, `Accept: application/json`. Response:
   `{"filename":"<serverId>.png"}`. (`browser.fetch` can't carry a `Blob`, so
   this runs in-page via `evalAsync` with the base64 bytes baked in — the same
   pattern the `concur` receipt upload uses.)
2. **Persist it onto the profile** → `POST /app/speaker/profile`. The skill
   serializes the ENTIRE live `/app/speaker/profile` form (all ~115 params) the
   same way `submit` round-trips the CFP form, then overlays only:
   - `User.ProfilePicture=<serverId>.png` (from step 1),
   - `User.ProfilePicturePreview=<original basename>` (what the UI shows),
   - `formex-submit-button-value=save+preview` (the save action; `FormData`
     omits submit buttons, so we re-add it),
   - `_charset_=utf-8` (same UTF-8 fix as `submit`).
   Headers: `Content-Type: …; charset=UTF-8`, `X-FormEx: 1`,
   `X-Requested-With: XMLHttpRequest`, `Referer: …/app/speaker/profile`.

Why the round-trip POST (not DOM clicks): setting `.value` programmatically or
firing Dropzone's `emit('success')` does **not** persist through an interactive
save — formex ignores those. Posting the round-tripped urlencoded body directly
is what actually persists the photo.

`--dry-run` uploads the image (harmless — `/fileUpload` only *stages* a file),
serializes + overlays the profile form, and prints the param count and the
overlaid `User.ProfilePicture` / `User.ProfilePicturePreview` values **without**
POSTing the save. Note: a profile-photo change does **not** propagate to
already-submitted sessions; the per-event speaker photo uses the analogous form
at `/app/speaker/events/speaker/edit/<eventId>/<speakerGuid>` (same round-trip +
`User.ProfilePicture` overlay — see `references/endpoints.md`; not yet wired to a
flag).

## `submit` — LIVE-VERIFIED (Jul 31, 2026)

A clean end-to-end submit was confirmed on the live **aienyc2026** CFP: the POST
returned `{"RedirectTo":"/aienyc2026/","ValidationErrors":null}` and the session
appeared in the speaker's "Sessions you've submitted" list. Notes:

- The full-form round-trip (step 1 above) is what makes it work; the earlier
  hand-picked payload 500'd on missing profile fields.
- `--draft` (`/submission-draft`) currently returns **404** — Sessionize changed
  that endpoint since the source recording. Use `--dry-run` to validate the
  payload locally instead; the real `/submission/<slug>` is self-validating
  (returns `ValidationErrors` without committing when the payload is incomplete).
- Custom-field GUIDs, `Id`s, `Signature`s, and tag ids are **event-specific and
  per-render** — never hardcode them; they are scraped live each run.

## Files

- `scripts/sessionize.jsh` — the CLI (command name: `sessionize`).
- `references/endpoints.md` — full extracted endpoint + field/GUID reference.
