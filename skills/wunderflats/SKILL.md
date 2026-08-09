---
name: wunderflats
description: >
  Interact with Wunderflats landlord dashboard — list and inspect furnished-apartment
  listings, check availability and blocked dates, create or delete calendar blocks,
  view bookings and tenant requests, bank accounts, and billing profile. Use when the
  user mentions Wunderflats, landlord dashboard, listing availability, block dates,
  blocked dates, calendar blocks, booking requests, tenant requests, furnished flat
  rentals, mid-term rental, Wunderflats listing, Wunderflats booking, Wunderflats
  landlord, unpublish listing, listing performance, or wants to manage a Wunderflats
  apartment calendar. Triggers on phrases like "check my Wunderflats", "block dates on
  Wunderflats", "Wunderflats availability", "Wunderflats bookings", "Wunderflats
  requests", "my Wunderflats listing", "landlord dashboard", "block the apartment",
  "unblock dates", "Wunderflats bank account".
allowed-tools: bash
command: wunderflats
script: scripts/wunderflats.jsh
---

# Wunderflats Skill

Landlord-side Wunderflats client using **browser session cookies** from an open
`wunderflats.com` tab. No API keys or stored tokens — every call is same-origin
`browser.fetch` so cookies travel automatically.

Reverse-engineered from a landlord dashboard HAR (availability / blocks / requests
flows). See `references/endpoints.md` for the wire surface.

## Requirements

**wunderflats.com open and logged in** as a landlord in your browser. If a call
returns 401/403 or GraphQL `UNAUTHENTICATED` / `Not authorized`, refresh the tab,
log in again, and retry.

## Usage

```
wunderflats me                              Landlord profile + billing summary
wunderflats listings                        Your listings
wunderflats listing [id]                    Listing detail (id optional if tab is on a listing)
wunderflats availability [id]               Blocks + bookings calendar summary
wunderflats blocks [id]                     Manual calendar blocks
wunderflats blocked-dates [id] [--from --to]
wunderflats block-create [id] --from YYYY-MM-DD --to YYYY-MM-DD [--confirm]
wunderflats block-delete <blockId> [--confirm]
wunderflats bookings [id]                   Bookings for a listing
wunderflats requests [id]                   Open/active listing requests
wunderflats banks                           Bank accounts (IBAN masked by API)
wunderflats --help
```

Listing id is optional when the active tab URL is
`/en/dashboard/l/<listingId>/...` — the skill reads it from the tab.

## Flags

- `--json` — raw JSON
- `--from` / `--to` — ISO dates (`YYYY-MM-DD`) for blocked-dates range or block-create
- `--confirm` — required for `block-create` and `block-delete` (mutations)
- `--listing <id>` — explicit listing id (overrides positional / tab URL)

## Safety

- Read commands are the default.
- Calendar mutations (`block-create`, `block-delete`) preview and require `--confirm`.
- Full listing PUT (`/api/listings-v2/...`) is intentionally **not** exposed — the HAR
  shows a whole-document replace that is too easy to corrupt.
- Prices from the API are **integer cents** (e.g. `170000` → €1,700.00).

## Auth model

Session-cookie only (HttpOnly auth cookie set at login). Prefer an open landlord
dashboard tab; the skill never reads, stores, or prints cookies/tokens.
