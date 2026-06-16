# Navan (TripActions) API reference

Base: `https://app.navan.com`. All endpoints below are the app's own backend.

## Auth (required on every /api/ request)

```
Authorization: TripActions <JWT>
x-tripactions-locale: en-US
content-type: application/json
```

- The `<JWT>` is the Auth0 access token. In the Navan tab it lives in
  `localStorage` under a key beginning `@@auth0spajs@@...`, at
  `body.access_token`. It is a standard RS256 JWT
  (`iss: https://login.navan.com/`, aud includes `https://app.navan.com/`).
- The scheme word is literally `TripActions` (not `Bearer`).
- These headers cannot be sent from SLICC's own fetch (cookie/origin limits) —
  run all calls from the logged-in tab with `playwright-cli eval-file` using
  `fetch(url, { credentials:'include', headers:{...} })`.
- 401/403 → token expired; re-log-in in the browser.

## Identity

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/uaa/userinfo` | `{ sub, name, given_name, family_name, email, serverRegion }` |
| GET | `/api/liberty/user/me` | fuller profile |
| GET | `/api/user/passenger` | the traveler/passenger object used in booking payloads |
| GET | `/api/user/paymentMethods` | array of payment methods; each has `uuid`, `validForPurchase`, `creditCard` |

## Trips

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/user/trips` | array of trip summaries: `uuid, name, startDate, endDate, flightCount, hotelCount, carCount, railCount, personal` |
| GET | `/api/user/trips/active` | the currently-active trip summary |
| GET | `/api/user/trips/{tripId}` | trip summary + counts (segments NOT included here) |
| GET | `/api/user/trips/timeline?tripUuid={id}&tripItemMapIncluded=true` | full detail. Returns an array; `[0].tripItemsMap` maps tripItemUuid → booking. |

`/api/user/trips/timeline` **without** a `tripUuid` returns HTTP 500 — always
pass `tripUuid`.

### Trip item shapes (in `tripItemsMap`)

- Flight item: `bookingId`, `confirmationNumber`, `bookingStatus`
  (e.g. `TICKETED`), `totalPrice`, `departureFlight.flight.flightSegments[]`,
  `returnFlight.flight.flightSegments[]`. Each segment has `airlineCode`,
  `airlineName`, `flightNumber`, `departureAirportCode`, `arrivalAirportCode`,
  `departureDateAndTime`, `arrivalDateAndTime`.
- Hotel item: `bookingId`, `confirmationNumber`, `bookingStatus`
  (e.g. `CONFIRMED`), `totalPrice`, `hotel.name`, `startDate`, `endDate`,
  `hotelRoom`, `hotelPaymentDescription[]`.

## Autocomplete

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/user/autocomplete/cityAirports?input=<q>&includeClusters=true&radiusMiles=50&maxLargeAirportPerCity=3&maxCloseAirportPerCity=2` | `_embedded.cityAirportses[]`; each has `mainAirport.{iata,name}` or a `location` with `placeId`/`placeName` |
| GET | `/api/user/autocomplete/place?input=<q>&includeFavoriteHotels=true&addLocation=true` | `predictions[]`; each has `description`, `displayName`, `location.{placeId, placeName, geo.{latitude,longitude}, address}` — used to drive hotel search |

## Flights — search → outbound → return → contract → book

1. **Create search** (GET; all params in the query string; returns a `searchId`
   with empty `options`):

   ```
   GET /api/v1/trip/flight/searches?emptyData=true&loadAmenities=false
       &flexibleDepartureTime=true&includeTravelfusion=true&includeExpedia=true
       &smartSearch=true&disableBlacklistedAirlineFlights=true
       &appSupportsFareRefundPolicy=false&appSupportsFareExchangePolicy=false
       &originAirportCode=BER&includeNearbyOriginAirports=false
       &destinationAirportCode=BSL&includeNearbyDestinationAirports=false
       &departureDate=2026-06-22&departureFromTime=00:00:00.000
       &departureToTime=23:59:00.000&departureDaysBounds=SAME_DAY
       &cabinClass=ECONOMY&adults=1&maxStops=10&runWithRecommendedStops=false
       &includeDedupedFares=true
       [&returnDate=2026-06-26&returnFromTime=00:00:00.000
        &returnToTime=23:59:00.000&returnDaysBounds=SAME_DAY]
   ```

2. **Poll for outbound options** (POST, body `{}`; repeat until `options[]`
   is non-empty):

   ```
   POST /api/v1/trip/flight/searches/{searchId}?offset=0&limit=20&loadAmenities=true&displayOnlyAffiliateFlights=false
   body: {}
   ```

   Each `options[]` entry: `uuid` (the **departureId**), `selectedFareId`,
   `flight.flightSegments[]`, `startingPrice.{basePrice,tax,agencyCurrency}`,
   `providerStartingPrice.total.{amount,currency}`, `flightDuration`.

3. **Return options for a chosen outbound** (POST, body `{}`):

   ```
   POST /api/v1/trip/flight/searches/{searchId}/departures/{departureId}/returns?offset=0&limit=20&loadAmenities=true&displayOnlyAffiliateFlights=false
   body: {}
   ```

   Each option's `uuid` is the **returnId**; `selectedFareId` is its fare.

4. **Price a contract** (POST, body `{}`; fareIds in the query string):

   - Round trip:
     ```
     POST /api/v1/trip/flight/searches/{searchId}/departures/{departureId}/returns/{returnId}/contractV2?departureFareId={depFareId}&returnFareId={retFareId}&timestamp={ms}
     ```
   - One way:
     ```
     POST /api/v1/trip/flight/searches/{searchId}/departures/{departureId}/contractV2?departureFareId={depFareId}
     ```

   Success → `{ contract: {...}, duplicateBookingWarning }`. The contract has
   `uuid` (**contractId**), `requiresApproval`, `totalPriceAndFee`,
   `totalPriceWithCCFeeInAgencyCurrency.{amount,currency}`, `flightItinerary`.
   Failure (common) → `{ status:400, errorCode:"GE00026", error:"No fares found
   for booking class" }` or "flight is no longer available" — fares expire fast;
   re-search and re-price.

5. **Get a contract** (GET): `/api/v1/trip/flight/searches/{searchId}/contracts/{contractId}?currency=EUR`

6. **Book** (POST, streaming SSE response):

   ```
   POST /api/v1/trip/flight/searches/{searchId}/contracts/{contractId}/book/streaming
        ?paymentMethodUuid={pmUuid}&tripId=&tripUuid=&hold=false
        &tripName={name}&platedBooking=false&locale=en-US
   body: { passengerData:[ { airlineLoyaltyCards:{}, airlineDiscountCards:{},
                             passenger:{ uuid, givenName, familyName, fullName,
                                         birthdate, email, travelerType:"BUSINESS",
                                         passenger:<full /api/user/passenger object> } } ],
           customFieldValues:[], sendEmailToAll:true }
   ```

## Hotels — search → hotel → rooms → contract → book

1. **Resolve location**: `GET /api/user/autocomplete/place?input=<city>&includeFavoriteHotels=true&addLocation=true`
   → pick a prediction; use `location.placeId`, `location.geo.latitude/longitude`,
   and `description`.

2. **Create search** (GET; returns a `searchId`, poll `options[]`):

   ```
   GET /api/v1/trip/hotel/searches?includeSpecialRates=true&description=<desc>
       &checkInDate=2026-06-22&checkOutDate=2026-06-26&numberOfRooms=1
       &numberOfGuests=1&prefetchRooms=true&emptyData=false
       &placeId=<placeId>&latitude=<lat>&longitude=<lon>
   ```
   Then poll `GET /api/v1/trip/hotel/searches/{searchId}` until `options[]` is
   populated. Each option: `uuid`/`hotelId`, `name`, `hotelStarsRating`,
   `totalPriceAndFee`, `dailyRate`.

3. **Load rooms for a hotel** (POST, body is an array containing the hotelId):

   ```
   POST /api/v2/trip/hotel/searches/{searchId}/rooms
   body: ["<hotelId>"]
   ```
   Rooms are at `_embedded.hotels[0].rooms[]`; each has `uuid` (**roomId**),
   `displayName`, `priceInfo.{totalPriceAndFee,basePrice}`, `bookPolicy`.
   (The UI also issues `PATCH /api/v2/trip/hotel/searches/{searchId}/hotel/{hotelId}/rooms`
   with an array of room UUIDs to refine a specific room — usually unnecessary.)

4. **Price a contract** (POST, body `{}`):

   ```
   POST /api/v1/trip/hotel/searches/{searchId}/hotels/{hotelId}/rooms/{roomId}/contract
   ```
   → contract with `uuid` (**contractId**), `requiresApproval`,
   `totalPriceWithCCFeeInAgencyCurrency.{amount,currency}`.

5. **Get a contract** (GET): `/api/v1/trip/hotel/searches/{searchId}/contracts/{contractId}`

6. **Book** (POST, streaming SSE response):

   ```
   POST /api/v1/trip/hotel/searches/{searchId}/contracts/{contractId}/book/streaming
        ?paymentMethodUuid={pmUuid}&tripId={existingTripId?}&tripName={name}&locale=en-US
   body: { customFieldValues:[], sendEmailToAll:true,
           passengerData:[ { passenger:{ ... same shape as flights ... } } ] }
   ```

## Booking streaming response (SSE)

`book/streaming` returns Server-Sent Events, not JSON or NDJSON. Read the whole
response body and split on blank lines (`\n\n`). Each block has `event:` and one
or more `data:` lines (concatenate the `data:` lines, then `JSON.parse`).

- Progress events: `event: periodic-event-booking-completion-update` with
  `data: { percentageComplete, completed:false, bookResponses:null, bookingUuids:[] }`.
- Final success event has `data.completed == true` and
  `data.bookResponses[0]` = `{ tripId, bookingId, confirmationNumber,
  flightItinerary/... , status segments CONFIRMED }`.
- Error event: `event: error` with `data: { status:400, errorCode, message }`
  (e.g. `FB0547` OB-fee increase). On error with no final success, treat the
  booking as failed.

Parse the **last** `completed:true` event for
`{ status:"CONFIRMED", bookingId, confirmationNumber, tripId }`.

## Trip-fee quote (optional, used by the UI before booking)

```
POST /api/v2/trip/tripFee/searches/{searchId}/contracts/{contractId}/paymentMethodUuid/{pmUuid}?displayCurrency=EUR&agencyCurrency=EUR
```

## Reference booking (the recorded Berlin → Basel trip)

- tripId `8bc5c4e7-cf16-4147-85d8-87a8135532e8` ("Zurich Trip")
- Flight: BER→ZRH LX963 (2026-06-22 07:15→08:40), ZRH→BER LX4408
  (2026-06-26 20:15→21:40), Swiss; bookingId `2KX13T`, confirmation `YYWJXM`,
  ~€708.35, status TICKETED.
- Hotel: Mövenpick Hotel Basel, 2026-06-22→2026-06-26; bookingId `OVCCAZ`,
  confirmation `B4T3AFL0630`, ~€1326.21, status CONFIRMED.

## Invoices and push-to-expense (Concur)

All keyed by the booking's **`bookingUuid`** (the `expenseFromTravel` id, e.g.
`6693f5ab-7335-49e9-8c7a-a16221c7141c`) — this is the `bookingUuid` field on a
trip item from `/api/user/trips/timeline?tripUuid=...`, **not** the airline PNR
(`bookingId` like `2KX13T`). Same `TripActions` auth as everything else.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/expenseFromTravel/{bookingId}/isEligible` | `{ "eligible": true\|false }` — can this booking be pushed to expense (false can mean already expensed / not eligible) |
| GET | `/api/v1/expenseFromTravel/{bookingId}/wasBookedAfterBookingExpenseFeature` | `{ "bookedAfterBookingExpenseFeature": true\|false }` |
| GET | `/api/invoices/v2/sync_status/{bookingId}` | `{ provider_invoices, trip_fee_invoices, service_fee_invoices, chloe_bot_invoices }` — booleans for which invoices have synced/are available |
| GET | `/api/v1/invoicesinternal/download/{bookingId}?lng=en-US` | binary **PDF** of the invoice. Fetch as `arrayBuffer` and base64-encode in the page, then `base64 -d` to a file — do NOT use `response.text()` (corrupts binary). |
| PUT | `/api/user/bookings/{bookingId}/expense` | **Push** the booking + invoice to the expense system (Concur). **No request body** (content-type `application/json`). |

### PUT .../expense behaviour (from the capture)

- **No body** is sent. The first captured attempt returned **HTTP 400** with
  `exceptionClass: "EmailAccessRequiredException"`,
  `message: "Email access is required."`, `provider: "MICROSOFT"`, and an
  `authorizeUri` (Microsoft OAuth consent URL). This is a one-time email-access
  grant so Navan can email the invoice into expense — it is **not** a body-shape
  problem.
- After the user granted email access, the identical retry returned **HTTP 200**
  with the booking object (`uuid`, `instant`, `dateCreated`, `dateModified`,
  `user`, ...). Treat 200 as "pushed".
- Handle the 400 specially: surface the `provider` and `authorizeUri` and tell
  the user to grant email access once, then retry with `--confirm`.

### Example bookingUuids from the capture

- `6693f5ab-...` — Zurich Trip flight (isEligible false, no invoices yet — booked recently)
- `71286231-...` — Zurich Trip hotel
- `c293de48-...` — an older booking with `provider_invoices`/`trip_fee_invoices`
  available; PUT `.../expense` returned 400 (email access) then 200 on retry.
- `3cd81f92-...` — another booking (status checks only)
