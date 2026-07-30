# Sessionize endpoints & field reference

All facts below were extracted from `/shared/sessionize-recording/submit.har`
(an in-progress CFP submission to the event **ai-native-devcon-nyc-2026**,
Event.Id `25004`). Nothing here is guessed — where the recording did not
contain a piece of information it is called out explicitly.

## Auth model

Sessionize is **session-cookie authenticated in the user's logged-in
browser**. There is no bearer token, API key, or PAT. Every call in the HAR is
a same-origin request from `https://sessionize.com/...` and relies on the
`.AspNet...` session cookie already present in the tab.

Therefore this skill issues all calls **same-origin from inside an open
`sessionize.com` browser tab** (`browser.fetch(tab, '/relative/path', …)`,
which carries cookies + correct Origin automatically). Do **not** store or
forward cookies/tokens.

## Discovered endpoints

| Method | Path | Purpose | Status seen |
|--------|------|---------|-------------|
| POST | `/submission-draft` | Auto-save the in-progress draft. Fires repeatedly as the user edits the form. Body = the full form payload (see below). | 200 (valid) / 500 (server-side, see notes) |
| POST | `/submission/<event-slug>` | **The actual submit.** `<event-slug>` is the path segment, e.g. `ai-native-devcon-nyc-2026`. Body = same full form payload. Returns JSON. | 200 |
| POST | `/submission/helper/<eventId>.js` | Helper ping, returns `{"ok":true}`. Not needed for submitting. | 200 |
| POST | `/app/playbook/menu` | Returned empty (`{"html":"\r\n\r\n","links":{}}`). No useful data. | 200 |

The CFP form page itself is `https://sessionize.com/<event-slug>/`
(seen as the `Referer` on the submit request). This GET page is **not** in
the HAR, but it is where the anti-forgery tokens and per-field metadata
(Id / Signature / tag options) originate — the skill scrapes it live.

### Request headers required on submit / draft

```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-FormEx: 1
X-Requested-With: XMLHttpRequest
Accept: */*
Referer: https://sessionize.com/<event-slug>/
```

### Submit response shape (JSON)

```json
{
  "Error": null, "Data": null, "Success": null,
  "RedirectTo": null, "ConfirmationMessages": null,
  "ValidationErrors": { "<field>": "<message>", ... },
  "Empty": false, "ReloadPage": false
}
```

A clean success is expected to carry `Success`/`RedirectTo`/
`ConfirmationMessages`. In the recording every `/submission/<slug>` response
was a **validation failure** (see "Live-verification gap" below).

## Form payload structure (application/x-www-form-urlencoded)

Note: `/submission-draft` wraps the same fields inside a single
`data=<url-encoded-json>` parameter, whereas `/submission/<slug>` posts the
fields **directly** as urlencoded form pairs. This skill posts the direct
form-pair shape to both, which matched the 200 draft/submit calls.

### Top-level fields

| Field | Example value | Notes |
|-------|---------------|-------|
| `__RequestVerificationToken` | `kokwUOul…` | Anti-forgery token. Scraped from form page. |
| `formex-verification` | `YTdkYWJj…` (base64) | FormEx anti-forgery. Scraped from form page. |
| `formex-submit-button-value` | `` | empty |
| `formex-confirmation-value` | `` | empty |
| `Event.Id` | `25004` | Numeric event id. Scraped from form page. |
| `SubmissionExceptionSignature` | `` | empty |
| `SessionType` | `New` | `New` for a brand-new session. |
| `Selected_SameSessionIdentifier` | `` | empty |
| `Session.Title` | `AI Ecoverse: …` | The talk title. |
| `Session.Description` | `Last time in London…` | The abstract. |
| `SpeakerMode` | `View` | |
| `User.TagLine` | `Principal at Adobe` | Speaker tagline (from profile). |
| `User.Bio` | `Lars Trieloff has…` | Bio. **Must be ≥ 300 chars** (validation). |
| `User.ProfilePicture` | `55c25d11-…jpg` | Existing profile photo id. |
| `User.ProfilePicturePreview` | `https://cdn.sessionize.com/image/…` | |
| `SpeakerLinks[n].Type` / `.Url` | `Twitter`,`LinkedIn`,`Blog`,`Company_Website` | Repeated block. |
| `ImpersonatedUser.*`, `ImpersonatedSpeakerLinks[n].*` | empty | Only used when submitting on behalf of another speaker. |
| `ExtraSpeakerInviteEmails[n].Email` | empty | Co-speaker invites. |
| `ConsentImpersonation` | `false` | |
| `Consent` | `false` | Acceptance checkbox. **Was `false` in the recording — a `true` here is almost certainly required for a real submit.** |

### Custom fields (keyed by GUID)

Each custom field emits this group of params (ASP.NET model-binding shape):

```
Fields.CustomFields.index=<GUID>                       (repeated, one per field, defines order)
Fields.CustomFields[<GUID>].Id=<numeric field id>
Fields.CustomFields[<GUID>].Signature=<opaque signature>
Fields.CustomFields[<GUID>].FieldType=<Tag|Short_Text|Checkbox|...>
# then ONE of:
Fields.CustomFields[<GUID>].ValueTagIds=<tagId>        (FieldType=Tag)
Fields.CustomFields[<GUID>].Value=<text|true|false>    (FieldType=Short_Text / Checkbox)
```

`Id`, `Signature`, and the valid tag-option ids are **event-specific** and are
scraped live from the form page — they are NOT stable across events.

#### Exact custom fields captured for ai-native-devcon-nyc-2026 (Event.Id 25004)

| GUID | Meaning (per task ground-truth) | Id | Signature | FieldType | Value seen |
|------|-------------------------------|----|-----------|-----------|------------|
| `2a2c2a76-0798-4177-966e-a82c6429fb07` | **Session Type** | 136888 | igpacwez | Tag | ValueTagIds `496087` |
| `67e7454b-cde2-47a4-83aa-d9b111669f68` | **Primary Track** | 136889 | ipwahwet | Tag | ValueTagIds `496123` |
| `f04e9b6f-e3bd-4aef-a1b5-e935efd9f61a` | **Secondary Track** | 136894 | gcacteu | Tag | ValueTagIds `496111` |
| `91d73ba0-10d9-4512-974f-c04f806ff4f5` | **Level** | 136893 | ixdaxu | Tag | ValueTagIds `496106` |
| `e41b8ee4-8490-4611-bc7d-906eab63919f` | **Key takeaways** (long free text) | 136890 | iltaohfe | Short_Text | "1. Why an agent… 2. How… 3. What breaks…" |
| `d677b6e1-0021-46c2-8a46-5a71edacb185` | Short text (empty in recording; purpose unknown) | 136891 | ifbalweq | Short_Text | `` |
| `510277b2-bdca-40ab-ba17-4b190c9a285a` | **Video URL** | 136892 | kooxwa | Short_Text | `https://www.youtube.com/watch?v=Uo-Y7AtPlas` |
| `e4e23b6d-dcd8-4a85-ae23-c11f65e87c78` | Checkbox (purpose unknown) | 136897 | iqtantex | Checkbox | `false` |
| `e361764f-d666-4c5d-b9e9-27cc0eca29fe` | **Tags / technologies** (free-tag) | 136898 | iuvmalze | Tag | ValueTagIds `WASM` |
| `71c50e00-a300-4e30-99ef-31b090bba27c` | **In-person consent** | 136899 | iotlap | Checkbox | `false` |
| `d7228853-525a-4715-bc81-bb4f7faa1ecb` | **Company** | 136895 | ifmalo | Short_Text | `Adobe` |
| `3d4df803-e071-4629-9906-86ac59cf7ccc` | **Role** | 136896 | dnaxfet | Short_Text | `Principal` |

The GUID→meaning column comes from the task's ground-truth; the Id/Signature/
FieldType/Value columns are extracted verbatim from the HAR.

## Live-verification gap (important)

The recording was an **in-progress submission that never completed**. Every
`/submission/<slug>` call returned `ValidationErrors`:

```json
"ValidationErrors": {
  "User.Bio": "Biography must have at least 300 characters.",
  "User.ProfilePicture": "Your photo is 512x512 pixels. Please upload one that’s at least 1000×1000 pixels.",
  "Fields.CustomFields[e361764f-…].ValueTagIds":
      "The value 'AI agents,browser-native agents,…' is not valid for ValueTagIds."
}
```

So the recording proves the endpoint, headers, and payload shape, but a
**clean end-to-end accepted submit was never observed**. Blockers were:
1. Bio under 300 chars.
2. Speaker photo too small (needs ≥ 1000×1000).
3. The free-tag "Tags" field was sent comma-joined labels; `ValueTagIds`
   expects **existing tag ids**, not arbitrary text — each tag value must be a
   valid option id (or a pre-created tag).

Treat `submit` as **needing live verification**.

## Read APIs (not found)

- No JSON list-CFPs / list-events endpoint appears in the HAR.
  `/app/playbook/menu` returned empty.
- The speaker area lives under `https://sessionize.com/app/speaker/...`
  (e.g. `/app/speaker/sessions`, `/app/speaker/session/profile/edit/<id>`),
  but **no** `/app/speaker/*` request is present in this recording, so their
  response shapes are unknown. The skill's `sessions`/`events` commands are
  best-effort HTML fetches of those pages and are **not** HAR-validated.
