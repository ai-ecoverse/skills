---
name: immobilienscout24
description: >
  Interact with Immobilienscout24 (ImmoScout24 / IS24) — Germany's largest real-estate
  portal for landlords and seekers. Use when the user mentions Immobilienscout24,
  ImmoScout24, ImmoScout, IS24, immobilienscout24.de, ScoutManager, Mein Konto,
  Angebotsliste, Nachrichten-Manager, Vermieter-Postfach, Wohnung mieten, Wohnung
  suchen, Kleinanzeige, Inserat, Exposé, Geoautocomplete, or wants to check their
  IS24 profile, dashboard unread messages, listing stats, landlord conversations,
  tenant inquiries, search apartments/houses for rent or sale in German cities
  (Berlin, München, Hamburg, Köln, Frankfurt, Potsdam, …), or look up geocodes.
  Triggers on phrases like "my ImmoScout listings", "IS24 messages", "ScoutManager
  angebote", "unread IS24", "search Berlin Wohnung", "Immobilienscout dashboard",
  "nachrichten manager", "meinkonto", "who messaged my listing", "listing click
  stats". Private-landlord and seeker read paths reverse-engineered from a live
  browser session — cookie auth only, no API key.
allowed-tools: bash
command: immobilienscout24
script: scripts/immobilienscout24.jsh
---

# Immobilienscout24 (ImmoScout24)

Read-oriented landlord/seeker client using the **browser session cookies** from an
open `immobilienscout24.de` tab. No API keys, no stored tokens.

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
immobilienscout24 search <location> [--type rent|buy|house-rent|house-buy|short-term]
                                             [--page N] [--pagesize N] [--price-max N]
                                             [--rooms-min N] [--area-min N]
immobilienscout24 geo <query>                Geoautocomplete (city/quarter/postcode/…)
immobilienscout24 --help
```

## Flags

- `--json` — raw JSON (single payload, or a composed object when a command fans out)
- `--limit N` / `--pagesize N` — page size (clamped)
- `--q TEXT` — free-text filter on ScoutManager listings
- `--archived` — include archived listings only (ScoutManager `archived=true`)
- `--tag TAG` — conversation folder tag (`inbox` default; also `favourite`, `maybe`, …)
- `--type` — search real-estate type (see below)
- `--price-max`, `--rooms-min`, `--area-min`, `--page` — search filters

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

- Mutations (publish / reply / archive / deactivate) were partially captured in the
  source HAR but are **not** exposed — only safe read paths.
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
