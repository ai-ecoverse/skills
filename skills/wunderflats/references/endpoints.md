# Wunderflats landlord API (HAR-derived)

Source: `/recordings/rec-1786282427974-u69xjx/` (dashboard navigation + availability
blocks + requests). Captured 2026-08-09 against `https://wunderflats.com`.

## Auth

Session-cookie authenticated in the logged-in browser. HAR requests show only:

```
Accept: application/json, text/plain, */*
Content-Type: application/json   # on POST/PUT
Referer: https://wunderflats.com/en/dashboard/...
```

No `Authorization` header. Cookies are HttpOnly (not visible to `document.cookie`).
All skill calls use `sliccy:browser` `browser.fetch` inside a `wunderflats.com` tab.

On 401 REST / GraphQL `UNAUTHENTICATED` / nexus `Not authorized`: session expired —
reload/login the tab.

## REST

| Method | Path | Purpose | Body / notes |
|--------|------|---------|--------------|
| GET | `/api/listings/:id` | Full listing document | Public-ish GET also works unauthenticated for some fields; landlord session returns full doc. Wrapper: `{ listing }` |
| GET | `/api/listings/:id/blocks` | Manual blocks | `{ items: [{ _id, from, to, source, listing, groupId, landlordId, ... }] }` |
| GET | `/api/listings/:id/blocks?ics=true` | ICS-import blocks only | Usually empty when no external calendar |
| GET | `/api/listings/:id/blocked-dates?from&to` | Unified occupancy | `{ items: [{ from, to, type: "Block"\|"Booking", _id }] }`. `from`/`to` are `YYYY-MM-DD` |
| POST | `/api/listings/:id/blocks` | Create block | `{ "from":"YYYY-MM-DD", "to":"YYYY-MM-DD" }` → `{ block: { _id, from, to, ... } }`. Inclusive date range; server expands `to` to end-of-day |
| DELETE | `/api/blocks/:blockId` | Delete block | Empty `{}` body/response |
| GET | `/api/users/:userId/bank-accounts` | Bank accounts | `{ bankAccounts: [...] }` — IBAN partially masked |
| PUT | `/api/listings-v2/:id` | Replace listing | **Not exposed** — whole-document PUT of amenities/images/pricing; unsafe to partial-edit |

Money fields (`price`, `deposit`, `totalCost`, …) are **integer minor units** (EUR cents).

## GraphQL — `/api/graphql` and `/api/graphql/api/graphql`

Two paths appear in the HAR:

- `/api/graphql` — single operation object `{ query, variables }`
- `/api/graphql/api/graphql` — **batch array** `[{ query, variables }, ...]`

Both accept the same schema surface for landlord queries. Batch responses are a
JSON array parallel to the request array.

### Queries used by this skill

**landlordListings** (list; live-verified 2026-08-09 — not in original HAR list page):

```graphql
query {
  landlordListings {
    nodes {
      __typename
      ... on LandlordListing {
        _id apartmentName published price currency groupId landlord
        title { en de }
        address { street streetNumber zipCode city country }
      }
    }
  }
}
```

Union type is `LandlordGroupOrListing` — always use an inline fragment on
`LandlordListing` (and `LandlordGroup` if needed).

**landlordListingById** (HAR: `GetActiveListing`):

```graphql
query GetActiveListing($listingId: ObjectId) {
  activeListing: landlordListingById(_id: $listingId) {
    _id apartmentName published price currency landlord groupId
    title { en de }
    address { street streetNumber zipCode city country }
    # …many more fields in HAR
  }
}
```

**landlordBookingsByListingId** (HAR: `GetBookingsByListingId`) — on either graphql path.

**landlordListingRequests** (HAR: `GetListingRequestsForListing`) — filter enum list of
open/in-progress landlord statuses (see script).

### Metrics (HAR only; not all wired as commands)

- `getListingDetailsViewedMetrics` / `getListingRequestsForListingMetrics` /
  `listingPublishTimeline` — need `groupId` + date range + intervals.

## Nexus GraphQL — `POST /api/nexus`

Separate schema from `/api/graphql`. Used for `me { … }`:

- `GetUserDetails` — `generatingRevenueUnderDac7Since`, unpaid invoices, billing list
- `GetMyBillingDetails` — billing addresses / DAC7 compliance
- `minBookingDurationByRegion(zipCode:)` 
- `listingUnpublishReasons(state:, scope:)`

`productUser` on a billing details row is the landlord user id (Mongo ObjectId),
used for `/api/users/:id/bank-accounts`.

## IDs observed

| Kind | Example shape |
|------|----------------|
| Listing / user / block / booking | 24-char hex Mongo ObjectId |
| groupId | URL-safe string e.g. `ptbKazN3c-89bTZe1wyc3` |
| listingRequest.id | nanoid-like e.g. `hLgUTgPMYw9_EKafOQVFX` |
| userFriendlyId | `2407-DQE-9GI` |

## Dashboard URLs

```
/en/dashboard
/en/dashboard/l/:listingId/availability
/en/dashboard/l/:listingId/bookings
/en/dashboard/l/:listingId/requests
/en/dashboard/l/:listingId/edit
/en/dashboard/l/:listingId/performance
```
