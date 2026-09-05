# Maintainer notes

`scripts/printful.jsh` is the only HTTP client. Token resolution, host
allow-listing, 401 handling and error formatting exist in exactly one place.

Verified live against Lars Trieloff's account on **2026-08-25** (Printful
customer `15477720`, environment `15376040`, native store `18658067`
"Personal orders").

## Endpoint map

| Command | Endpoint |
|---|---|
| `whoami` / `stores` | `GET /stores` |
| `auth login --token` | `GET /stores` (validation only) |
| `files list` | `GET /files?limit&offset` |
| `files get` / `files wait` | `GET /files/{id}` |
| `files add` | `POST /files` `{url, filename}` |
| `catalog product` | `GET /products/{id}` |
| `catalog variants` | `GET /products/{id}` then filter `result.variants` |
| `store products` | `GET /store/products` |
| `store product get` | `GET /store/products/{id}` |
| `store product create` | `POST /store/products` |
| `orders` | `GET /orders` |
| `order get` | `GET /orders/{id}` |
| `order create` | `POST /orders` (draft unless `?confirm=1`) |
| `order confirm` | `POST /orders/{id}/confirm` |
| GraphQL mint | `POST https://www.printful.com/graphql` from a dashboard tab |

Auth header is `Authorization: Bearer <private_token>` plus
`Accept: application/json`. Account-level tokens also need
`X-PF-Store-Id: <store_id>`.

Docs: <https://developers.printful.com/docs/>
(`#tag/File-Library-API-examples`, `#tag/Orders-API-examples`,
`#tag/Using-Private-Token`).

## Token handling

Resolution order: `--token` flag → stored config → GraphQL mint from a
logged-in dashboard tab (only on `auth login` without `--token`).

Private tokens are minted in the Developer Portal
(<https://developers.printful.com/tokens>) **or** via dashboard GraphQL.
The portal itself is a Nuxt app on `developers.printful.com` that talks to
`https://www.printful.com/graphql` after an OAuth bounce
(`/oauth/authorize?client_id=printful-dev-portal`).

Mint mutation (captured 2026-08-25 from `_nuxt/cc18ace.js`):

```
mutation devPortalCreateTokenMutation($input: DevPortalTokenInput!) {
  devPortal {
    devPortalCreateToken(input: $input) {
      id tokenId name email createdAt expiresAt lastAccess rawAccessToken
      scopes { scope title }
    }
  }
}
```

`DevPortalTokenInput`: `{ name, email, expiresAt (ISO8601 Zulu string — a
unix timestamp is rejected), tokenType: "store"|"environment", storeId
(required for store), scopes: [String!] }`.

Valid **store** scopes: `orders`, `orders/read`, `sync_products`,
`sync_products/read`, `file_library`, `file_library/read`, `webhooks`,
`webhooks/read`. `product_templates` is Account-only — sending it on a
store token returns
`Scope "product_templates" is not valid for type "store"`.

CSRF for the GraphQL POST comes from
`PF.Config.PUSHER_CONFIG.CSRF_TOKEN` (or `<meta name="csrf-token">`) on
`www.printful.com`. `api.printful.com` is CORS-blocked from that origin
(`TypeError: Failed to fetch`) — harvest/mint the token in page context,
then call REST from the sandbox.

`browser.eval` opportunistically JSON-parses page results; accept both a
string and an already-parsed object when reading `PF.Customer`.

## Files

`POST /files` is URL-only. Printful's workers GET the URL; there is no
multipart upload on this endpoint. A freshly created file has
`status: "waiting"`, `size: 0`, `width: null` until processing finishes,
then `status: "ok"` with hash / mime / pixel size. Failed fetches stay
`waiting` or flip to `failed`.

Live example (2026-08-25): 2996×4778 RGBA PNG, 694026 bytes → file id
`1044863309`, hash `bf4dce1a5bf7c4925e93b3b6bba03105`, processed in <3s
from a `serve --ttl 1d` URL.

## Store products vs templates vs the dashboard

`POST /store/products` creates a **sync product** on the token's store.
On a native "Personal orders" store (`type: "native"`):

- It does **not** appear under Dashboard → Meine Produkte (that list is
  Design Maker **templates**).
- Dashboard → Stores still shows the "connect a shop" empty state,
  because a native store is not a Shopify/Etsy integration.

The mockup file (`type: "preview"`) is generated asynchronously after
create; `GET /store/products/{id}` includes it once ready.

Bella + Canvas 3001 is catalog product **71**. Black / M is variant
**4017** (in stock for DE, 2026-08-25). Front placement file type is
`front` on create and comes back as `default` on read.

## Design Maker UI (do not automate)

Measured 2026-08-25 on `/dashboard/order/update` with product 71:

- The Design Maker file-library dialog (`Dateibibliothek`) has a hidden
  `<input type=file>` (`#file-library-upload-*`) plus a Vue drop zone.
- `playwright-cli upload` / `drop` / setting `input.files` + dispatching
  `change` never produces a network request. Terms checkbox
  (`#file-library-copyright`) also does not stay checked via DOM.
- "Mit dem Designen beginnen" on the catalog PDP is a Vue submit that
  does not navigate; the working entry is
  `/dashboard/order/update` → search → pick product.
- DTFlex upsell overlay intercepts clicks until dismissed.

Use the File Library API instead. Leave the UI for humans.

## Host allow-list

Only `api.printful.com` receives the Bearer token. GraphQL minting uses
the dashboard tab's cookies, not the token. `printful api` rejects any
other host.
