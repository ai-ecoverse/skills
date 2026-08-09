# Immobilienscout24 endpoints

Extracted from `/recordings/rec-1786282613280-yexubu/` (2026-08-09 session:
home → Berlin search → meinkonto dashboard → scoutmanager angebotsliste →
publish flow → nachrichten-manager). `chromewebdata` error chunks ignored.

## Auth model

IS24 is **cookie-session authenticated**. No bearer/API key in the HAR for the
landlord/seeker UI paths below. The browser holds shared cookies on
`.immobilienscout24.de` and the SPA calls multiple subdomains from `www`:

| Host | Role |
|------|------|
| `www.immobilienscout24.de` | Main app, search, meinkonto, scoutmanager, nachrichten-manager |
| `sso.immobilienscout24.de` | SSO identity (`/sso/me`, `/sso/t`) |
| `api.header.immobilienscout24.de` | Orange-header user chip (`/api/v1/getByCookie`) |
| `my-property.immobilienscout24.de` | Property portfolio / shortlist |
| `geoservices.immobilienscout24.de` | Map shapes |
| `tenant-network.immobilienscout24.de` | Tenant-network eligibility |
| `api.consumer-entitlements.immobilienscout24.de` | Active products |

Skill rule: issue every call via `browser.fetch` from an open
`*immobilienscout24.de` tab. Never print cookies or the Iterable JWT from
`/nachrichten-manager/api/iterable/token`.

## Profile / identity

| Method | URL | Notes |
|--------|-----|-------|
| GET | `https://sso.immobilienscout24.de/sso/me` | `{ username, email, ssoId }` — Accept `application/json` |
| GET | `https://api.header.immobilienscout24.de/api/v1/getByCookie` | `{ isProfessional, email, firstname, surname, customerNumber, avatarImageUrl, membershipEdition }` |
| GET | `https://www.immobilienscout24.de/meinkonto/endpoint/fullprofile/v2` | Seeker/landlord profile (address, segment, docs flags) |
| GET | `https://www.immobilienscout24.de/meinkonto/endpoint/appPackageStatus` | Application-package document status |
| GET | `https://www.immobilienscout24.de/anbieten/private-anbieter/inserieren/api/user` | Private-landlord contact (publish flow) |

## Dashboard (meinkonto)

Base: `https://www.immobilienscout24.de/meinkonto/dashboard-backend/`

| Method | Path | Response (captured) |
|--------|------|---------------------|
| GET | `/unread-messages` | `{ totalUnreadMessageCount, seekerUnreadMessageCount, homeOwnerUnreadMessageCount }` |
| GET | `/publication-statistics` | `{ ssoId, numberOfListings, numberOfActiveListings, numberOfDeactivatedListings, numberOfArchivedListings }` |
| GET | `/active-contract/count` | `{ activeContractCount }` |
| GET | `/feature-switches` | feature flags array |

Related:

| Method | URL |
|--------|-----|
| GET | `https://www.immobilienscout24.de/savedsearch/overviewwidget/recent/2` |
| GET | `https://my-property.immobilienscout24.de/real-estate-objects/count` → `{ buildingCount, standaloneUnits }` |
| GET | `https://my-property.immobilienscout24.de/v2/shortlist?pageSize=1&offset=0&sortBy=CREATED_DESC` |
| GET | `https://api.consumer-entitlements.immobilienscout24.de/v2/active-products/my` |

## ScoutManager — Angebotsliste

Base: `https://www.immobilienscout24.de/scoutmanager/angebotsliste/api`

| Method | Path | Body / notes |
|--------|------|--------------|
| GET | `/realtorData` | SSO id, contacts, permissions |
| GET | `/waitinglist/eligibility` | boolean |
| POST | `/query` | Listing search (see body below) |
| POST | `/realestate-stats` | body: `[realEstateId, …]` → `[{ realEstateId, clickCount }]` |
| POST | `/communication-stats` | body: `[realEstateId, …]` → `[{ realEstateId, newMessages }]` |

### POST `/query` body (captured)

```json
{
  "freeTextSearch": "",
  "pageRequest": { "from": 0, "size": 20 },
  "orderBy": "ALTERATION_DATE",
  "publishedOnIS24": true,
  "publishedOnHomepage": true,
  "publishedOnMarkets": [],
  "published": true,
  "deactivated": true,
  "archived": false
}
```

Response: `{ searchHits: [...], totalHits, facetResults }`. Each hit includes
`id`, `title`, `type`, `typeName`, `price`, `priceType`, `area`, `rooms`,
`completeAddress`, `publishedOnIs24`, `archived`, dates, `titlePictureUrl`.

Headers: `Accept: application/json`, `Content-Type: application/json`.

## Nachrichten-Manager

Base: `https://www.immobilienscout24.de/nachrichten-manager/api`

| Method | Path | Notes |
|--------|------|-------|
| GET | `/expose?page=0&size=6&sort=desc` | Listings with conversation stats |
| GET | `/references/:id` | Listing card for a reference |
| GET | `/references/:id/statistics` | Per-tag unread/total |
| POST | `/references/:id/conversations?tags=inbox&size=10&plusUserPriority=true` | body `{"copilotConversations":[]}` |
| GET | `/references/:id/conversations/:conversationId` | Conversation detail (SPA route; not exercised in HAR) |
| GET | `/references/:id/conversations/:conversationId/messages` | Message list (SPA route; not exercised in HAR) |
| GET | `/realtor/metadata` | `{ isInternalUser, isDeactivatedInTat, ssoId }` |
| GET | `/metadata/professional` | boolean |
| GET | `/feature-switches` | flags |
| GET | `/iterable/token` | **JWT — do not print** |

Conversation list item fields (captured): `conversationId`, `participantName`,
`salutation`, `lastUpdateDateTime`, `previewMessage`, `read`, `status`,
`participantSsoId`, `participantPlus`, `tags`, `conversationStage`,
`shortDetails`.

Also: `GET /contact-prospects/api/shared/statistics?exposeIds=:id`.

## Search / geo

| Method | URL | Notes |
|--------|-----|-------|
| GET | `/geoautocomplete/v4.0/DEU?i={q}&lpt=5&t=country,region,city,…&f=shapeAvailable&dataset=nextgen` | Suggestions `[{ entity: { type, id, label, geopath } }]` |
| GET | `/geoautocomplete/v4.0/DEU/entity/{id}?g=GeoId&pos=0` | Resolve one entity |
| POST | `/Suche/controller/oneStepSearch` | form `type=SEARCH_URL&location=/region?realestatetype=…&geocodes=…` (empty JSON body; drives client nav) |
| GET | `/Suche/region?realestatetype=apartmentrent&exclusioncriteria=swapflat&geocodes={id}&pagesize=20&pagenumber=1` | Result list — SPA uses `Accept: application/json` (`updateResults` in reactApp.js). Pretty URLs like `/Suche/de/berlin/berlin/wohnung-mieten` are equivalent entry points. |
| POST | `/Suche/controller/filtersuggestions` | body `{ apiUrl, totalHits, searchId }` |
| GET | `/Suche/controller/shortlist/list` | saved shortlist ids |
| GET | `/home/api/immogpt/?count=3&language=de&locationType=CITY&locationLabel=Berlin` | marketing suggestions |

`realestatetype` values seen/used: `apartmentrent`, `apartmentbuy`, `houserent`,
`housebuy`, `shorttermaccommodationrent`.

## Publish flow (captured, not exposed as mutations)

| Method | URL |
|--------|-----|
| GET | `/anbieten/private-anbieter/inserieren/api/configurations?category=SHORT_TERM_ACCOMMODATION&transaction=RENT&segmentation=PROPERTY_OWNER` |
| GET | `/anbieten/private-anbieter/inserieren/api/realEstate/{uuid}` |
| GET | `/anbieten/private-anbieter/inserieren/api/geo/geoCode?street=…&houseNumber=…&postcode=…&city=…` |
| PUT | `/anbieten/private-anbieter/inserieren/api/realEstate/offer-api/{uuid}?updateObject=true&requestSource=clf` |

These are intentionally **not** wired into the CLI (destructive / incomplete
without the full multi-step wizard).

## Headers commonly sent by the SPA

```
Accept: application/json, text/plain, */*
Content-Type: application/json   (on POST)
X-Requested-With: XMLHttpRequest  (some paths)
Referer: https://www.immobilienscout24.de/...
```
