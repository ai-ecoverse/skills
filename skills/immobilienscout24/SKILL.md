---
name: immobilienscout24
description: >
  Interact with Immobilienscout24 (ImmoScout24 / IS24) — Germany's largest real-estate
  portal — as landlord or seeker. Use when the user mentions Immobilienscout24,
  ImmoScout24, ImmoScout, IS24, immobilienscout24.de, ScoutManager, Mein Konto,
  Angebotsliste, Nachrichten-Manager, Vermieter-Postfach, Bewerbermappe, Inserat,
  Exposé, or wants their IS24 profile, dashboard, unread messages, listing stats,
  landlord conversations, tenant inquiries, applicant documents, a reply to a
  prospect, a viewing invitation, apartment/house search in German cities, or
  geocodes. Triggers on "my ImmoScout listings", "IS24 messages", "unread IS24",
  "who messaged my listing", "nachrichten manager", "search Berlin Wohnung",
  "reply on IS24", "antworte auf die Anfrage", "Besichtigungstermin anbieten".
  Cookie auth from an open browser tab, no API key. Read paths are unguarded; the
  one write path (send, a thread reply) requires an explicit --confirm.
allowed-tools: bash
command: immobilienscout24
script: scripts/immobilienscout24.jsh
---

# Immobilienscout24 (ImmoScout24)

Landlord/seeker client using the **browser session cookies** from an open
`immobilienscout24.de` tab. No API keys, no stored tokens. Everything is read-only
except `send`, which replies in a message thread and requires `--confirm`.

## Auth model

IS24 authenticates with first-party session cookies across several subdomains
(`www.`, `sso.`, `api.header.`, `my-property.`, `tenant-network.`, …). Every call
is issued via `browser.fetch` from inside an open Immobilienscout24 tab so cookies
and `Origin` travel automatically. **No cookie or token is ever read, stored, or
printed.**

Prerequisite: be logged in at `https://www.immobilienscout24.de` (any Mein Konto /
ScoutManager / Nachrichten-Manager page works).

## Usage

```
immobilienscout24 me                         Profile (SSO + header + fullprofile)
immobilienscout24 dashboard                  Unread counts, listing + contract stats
immobilienscout24 listings [--limit N] [--q TEXT] [--archived]
                                             ScoutManager Angebotsliste (+ click/msg stats)
immobilienscout24 exposes [--limit N]        Listings known to Nachrichten-Manager
immobilienscout24 conversations <listingId> [--limit N] [--tag inbox]
                                             Inbox threads for one of your listings
immobilienscout24 messages <listingId> <conversationId>
                                             Full thread (best-effort; endpoint from SPA)
immobilienscout24 applicant <ssoId|base64SsoId>
                                             Bewerbermappe / rent-profile preview
immobilienscout24 send <listingId> <conversationId> "text" --confirm
immobilienscout24 send <listingId> <conversationId> --file <path> --confirm
                                             Reply in a thread. WRITE PATH —
                                             without --confirm it only previews
                                             the request and sends nothing.
immobilienscout24 search <location> [--type rent|buy|house-rent|house-buy|short-term]
                                             [--page N] [--pagesize N] [--price-max N]
                                             [--rooms-min N] [--area-min N]
immobilienscout24 geo <query>                Geoautocomplete (city/quarter/postcode/…)
immobilienscout24 --help
```

## Sending a reply (the only write path)

`send` is the one command that changes something on ImmoScout24, and there is a real
prospect on the other end of the thread. It is therefore **confirm-gated**:

```
# 1. preview — prints endpoint, conversation id, payload and the full body.
#    Makes NO network call and needs no open tab. Always do this first.
immobilienscout24 send 166323126 <conversationId> --file ./einladung.txt

# 2. deliver — same command plus --confirm
immobilienscout24 send 166323126 <conversationId> --file ./einladung.txt --confirm
```

- **Without `--confirm` nothing is sent.** The command prints the exact `POST` it
  would issue (URL, conversation id, JSON payload, full message text) and exits 0.
- **`--file <path>` is the reliable way to pass a multi-line body** (German viewing
  invitations usually are): the body is read from the file, CRLF is normalised and
  trailing whitespace trimmed. stdin is not readable in this runtime, so there is no
  pipe form. Inline text stays available for one-liners; passing both is an error.
- `--json` works in both modes: the preview returns `{ dryRun: true, method, url,
  payload, … }`, the confirmed send returns the API response.
- `--tags a,b` sets the `tags` array. Default is `replied,inbox`, the value in the
  captured real send; use `--tags inbox` for a thread you have not replied to yet, or
  `--tags none` for an empty array. The web UI copies the conversation's current tags
  there, and `send` prints a note when they differ from what it is about to send.
- Empty bodies, malformed listing/conversation ids and bodies over 100 000 characters
  (the reply box cap) are rejected before anything is sent. On `--confirm` the
  conversation is fetched first, so an unknown conversation id fails before the POST.
- Attachments, appointment objects and bulk messages are **not** implemented.

The wire contract is confirmed by a captured real send, not guessed:

```
POST /nachrichten-manager/api/references/<listingId>/conversations/<conversationId>/messages
{"message":"…\n…","conversationId":"…","tags":["replied","inbox"],"recommendedActionName":null}
→ 201 Created  {"id":"<messageId>", …, "userType":"REALTOR", "source":"API"}
```

On success the command prints the new message `id`, the server timestamp and the thread
deep link. Three CSRF tokens are required and the skill sources each the way the app does:
`X-XSRF-TOKEN` from the non-HttpOnly `XSRF-TOKEN` cookie, and
`x-xsrf-communication-mgr-token` / `x-xsrf-contact-prospects-token` from the response
headers of `/nachrichten-manager/api/feature-switches` and
`/contact-prospects/api/shared/feature-switches` — those two rotate on every response, so
`send` re-mints them immediately before the POST. Missing cookie or un-mintable token both
fail with an actionable message. **Token values are never printed**, not even in the dry
run. Details in `references/endpoints.md`.

## Flags

- `--json` — raw JSON (single payload, or a composed object when a command fans out)
- `--limit N` / `--pagesize N` — page size (clamped)
- `--q TEXT` — free-text filter on ScoutManager listings
- `--archived` — include archived listings only (ScoutManager `archived=true`)
- `--tag TAG` — conversation folder tag (`inbox` default; also `favourite`, `maybe`, …)
- `--type` — search real-estate type (see below)
- `--price-max`, `--rooms-min`, `--area-min`, `--page` — search filters
- `--confirm` — **`send` only.** Required to actually POST the message; without it
  `send` previews the request and makes no network call
- `--file <path>` — **`send` only.** Read the message body from a file (multi-line)
- `--tags a,b` — **`send` only.** Tags array to include in the payload

### Search `--type` values

| Flag value     | `realestatetype` param | Typical web path        |
|----------------|------------------------|-------------------------|
| `rent` (default) | `apartmentrent`      | wohnung-mieten          |
| `buy`            | `apartmentbuy`       | wohnung-kaufen          |
| `house-rent`     | `houserent`          | haus-mieten             |
| `house-buy`      | `housebuy`           | haus-kaufen             |
| `short-term`     | `shorttermaccommodationrent` | wohnen-auf-zeit |

## Requirements

**immobilienscout24.de open and logged in** in the browser. The skill finds any tab
whose URL matches `immobilienscout24.de`.

## Notes

- The only exposed mutation is `send` (reply in a thread), and it requires
  `--confirm`. Publish / archive / deactivate / bulk-message / attachment uploads
  exist in the SPA but are deliberately **not** exposed.
- `send` posts to
  `/nachrichten-manager/api/references/<listingId>/conversations/<conversationId>/messages`
  with `{ message, conversationId, tags, recommendedActionName }` and expects **201** with
  the new message `id` — confirmed by a captured live send, not inferred.
- **Deep-link trap:** a thread is
  `/nachrichten-manager/<listingId>/inbox/messages/<conversationId>`. Drop the `messages/`
  segment and the page renders the listing shell with no thread, which looks exactly like an
  empty conversation. `/inbox/navbar` is the folder view.
- Cross-subdomain calls (`sso.`, `api.header.`, `my-property.`, `api.rentprofile.`)
  ride the same browser session; if one 401s, re-login on www and retry.
- **Bewerbermappe:** `applicant <ssoId>` hits
  `api.rentprofile…/profile-preview?ownerSsoId=` (credentialed XHR). Returns income,
  employment, move-in, and document **types + dates** (IDENTIFICATION, INCOME,
  SCHUFA_SOLVENCY, SELF_REPORT). PDF blobs are **not** exposed to the landlord API —
  only metadata / green-check status. UI:
  `/meinkonto/dokumente/ansicht/<base64(ssoId)>`.
- **`schufaProvided` trap:** `messages` → `participantData.applicationDocuments.schufaProvided`
  is often `false` even when SCHUFA is hinterlegt. Prefer `applicant.documents` or the
  mappe strip on `messages`.
- Endpoint reference: `references/endpoints.md`.
