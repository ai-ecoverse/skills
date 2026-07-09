---
name: navan
description: >-
  Automate Navan (formerly TripActions) corporate travel by replaying its REST
  API — search and book flights and hotels, price itineraries, view trips, and
  pull invoices for past bookings and push them to the expense system (Concur).
  Use whenever the user mentions Navan, TripActions, booking a flight, booking a
  hotel, corporate travel, a business trip, a travel itinerary, trip details, an
  airport/city lookup for travel, a travel invoice, expensing a flight or hotel,
  pushing a booking to Concur, or wants to check or manage their Navan trips
  without clicking through app.navan.com. Triggers: "Navan", "TripActions",
  "book a flight", "book a hotel", "search flights", "search hotels", "my
  trips", "business trip", "itinerary", "corporate travel", "travel booking",
  "travel invoice", "expense this flight/hotel", "push to Concur", "expense
  report from travel".
allowed-tools: bash
---

# Navan (TripActions) travel automation

Search flights & hotels, price itineraries, view trips, and book — by calling
Navan's own backend API (`https://app.navan.com/api/...`) from the logged-in
Navan browser tab.

## Command

The script is `scripts/navan.jsh`; the shell command is `navan`.

```
navan whoami                       Logged-in user (name, email, user id)
navan trips [--json]               List trips (name, dates, item counts, tripId)
navan trip <tripId> [--json]       Trip detail: flights + hotels with bookingId / confirmation
navan airports <query> [--json]    Airport/city autocomplete (code, name)

navan flights search --from=BER --to=BSL --depart=YYYY-MM-DD [--return=YYYY-MM-DD] [--pax=1] [--cabin=ECONOMY]
navan flights returns --search=<id> --departure=<departureId>
navan flights price   --search=<id> --departure=<departureId> [--return=<returnId>]

navan hotels search --city=Basel --checkin=YYYY-MM-DD --checkout=YYYY-MM-DD [--guests=1] [--rooms=1]
navan hotels rooms  --search=<id> --hotel=<hotelId>
navan hotels price  --search=<id> --hotel=<hotelId> --room=<roomId>

navan book <flight|hotel> --search=<id> --contract=<id> [--confirm]
navan help
```

```
navan invoice <bookingId> [--download=<path>] [--json]   Invoice sync status + expense eligibility; optionally save the PDF
navan push-expense <bookingId> [--confirm]                Push the booking + invoice to expense (Concur); gated
```

Add `--json` to any read command for machine-readable output.

The `<bookingId>` used by `invoice` and `push-expense` is the **`bookingUuid`**
shown by `navan trip <tripId>` (e.g. `6693f5ab-...`), not the airline PNR.

## Authentication model (important)

Navan's `/api/` endpoints are **not** plain cookie auth. Every request needs:

- `Authorization: TripActions <JWT>`  — the literal scheme word `TripActions`,
  a space, then a JWT.
- `x-tripactions-locale: en-US`

SLICC's own `fetch()` cannot carry these headers and uses a `localhost` origin,
so **all calls run inside the logged-in Navan browser tab** via
`playwright-cli eval-file`. The script:

1. Finds the open `app.navan.com` tab (`playwright-cli tab-list`).
2. Reads the JWT from the tab's `localStorage` — the Auth0 SPA cache key that
   starts with `@@auth0spajs@@` holds `body.access_token`. (Fallback: any
   localStorage value with an `access_token`, or a token captured off the app's
   own XHR/fetch `Authorization` header.)
3. Runs `fetch(url, { credentials:'include', headers:{ Authorization:'TripActions '+tok, 'x-tripactions-locale':'en-US' }})`
   from the page context.

If there is no Navan tab, open `https://app.navan.com` and log in. On **401/403**
the token expired — open Navan, log in, and retry. Keep the Navan tab open.

## Booking confirmation gate (spends real money)

`navan book` is the only command that can spend money, and it is gated:

- **Without `--confirm`** it fetches the priced contract, prints the itinerary
  and total price, prints a message that nothing was booked, and **exits without
  booking**.
- **With `--confirm`** it assembles the passenger + payment data and POSTs to
  the streaming booking endpoint, then prints `{status, bookingId,
  confirmationNumber, tripId}` parsed from the final stream event.

Always run `navan book ...` once **without** `--confirm` first, show the user the
itinerary and total, and only re-run with `--confirm` after explicit approval.

`navan push-expense` is gated the same way — it MUTATES your expense system
(Concur). Without `--confirm` it prints eligibility and what would be pushed and
stops; with `--confirm` it performs the `PUT .../expense`. If the push returns
`EmailAccessRequiredException` (HTTP 400), Navan needs one-time email
(Outlook/Gmail) access to send the invoice — grant it in the Navan UI, then
retry.

## End-to-end workflows

### View trips
1. `navan trips` — find the trip and its `tripId`.
2. `navan trip <tripId>` — see flight route/times/airline + hotel name/dates and
   each booking's `bookingId` / `confirmationNumber`.
   - Checkpoint: confirmation numbers and a `[TICKETED]`/`[CONFIRMED]` status
     mean the booking is live.

### Book a flight
1. `navan airports <city>` — resolve IATA codes if needed (e.g. Basel → BSL).
2. `navan flights search --from=BER --to=BSL --depart=YYYY-MM-DD [--return=YYYY-MM-DD]`
   — copy the chosen `departureId` (and, for round trips, run
   `navan flights returns --search=<id> --departure=<departureId>` and copy a
   `returnId`).
   - Checkpoint: each option shows price, times, airline, flight number.
3. `navan flights price --search=<id> --departure=<departureId> [--return=<returnId>]`
   — get a `contractId` and total.
   - Checkpoint: a `contractId` is returned. Flight fares expire quickly; if you
     get "flight is no longer available" or "No fares found", re-run search →
     price promptly.
4. `navan book flight --search=<id> --contract=<contractId>` — review the
   preview + total (NOT booked).
5. After approval: `navan book flight --search=<id> --contract=<contractId> --confirm`
   — prints `{status, bookingId, confirmationNumber, tripId}`.
6. `navan trip <tripId>` — verify the new booking appears.

### Book a hotel
1. `navan hotels search --city=Basel --checkin=YYYY-MM-DD --checkout=YYYY-MM-DD`
   — copy the chosen `hotelId`.
   - Checkpoint: options show name, stars, total price.
2. `navan hotels rooms --search=<id> --hotel=<hotelId>` — copy a `roomId`.
3. `navan hotels price --search=<id> --hotel=<hotelId> --room=<roomId>` — get a
   `contractId` and total.
   - Checkpoint: a `contractId` is returned.
4. `navan book hotel --search=<id> --contract=<contractId>` — review the preview
   + total (NOT booked).
5. After approval: `navan book hotel --search=<id> --contract=<contractId> --confirm`.
6. `navan trip <tripId>` — verify.

### Get an invoice and push a past booking to expense (Concur)
1. `navan trips` → `navan trip <tripId>` — find the booking and copy its
   **`bookingUuid`** (printed under each flight/hotel).
2. `navan invoice <bookingUuid>` — check eligibility and invoice availability.
   - Checkpoint: `provider_invoices` / `trip_fee_invoices` show `available`.
     If everything shows `no`, the invoice has not synced yet — retry later.
3. `navan invoice <bookingUuid> --download=<path>` — save the invoice PDF (the
   download endpoint returns a binary PDF).
4. `navan push-expense <bookingUuid>` — review eligibility + what would be pushed
   (NOT pushed).
5. After approval: `navan push-expense <bookingUuid> --confirm` — performs the
   `PUT .../expense` and reports the result.
   - Checkpoint: HTTP 200 = pushed. HTTP 400 `EmailAccessRequiredException` =
     grant Navan email access once in the UI, then retry.

## Notes

- `searchId`s and priced contracts are short-lived (minutes). Re-search if a
  later step reports an expired/unavailable error.
- See `references/endpoints.md` for the full endpoint, payload, and response
  documentation captured from a real Berlin → Basel booking.
