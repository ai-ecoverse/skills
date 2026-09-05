---
name: printful
description: >
  Print-on-demand via the Printful REST API (api.printful.com) — private-token
  auth, file-library uploads, catalog lookup, store/sync products, and draft or
  confirmed orders. Use when the user mentions Printful, print-on-demand, POD
  tees/hoodies, Bella+Canvas, DTG, mockups, Printful file library, sync products,
  or wants to upload artwork and order merch without clicking through
  printful.com. Triggers on "printful", "print on demand", "POD order", "upload
  a print file", "Bella Canvas 3001", "draft a Printful order". Not Printify,
  not Gelato, not Spreadshirt — those are different vendors.
allowed-tools: bash
command: printful
script: scripts/printful.jsh
---

# Printful

Talk to [Printful's REST API](https://developers.printful.com/docs/) from the
shell. Skip the Design Maker UI — its file-library drop zone does not accept
automated uploads (measured 2026-08-25). Auth is a **private token**; API calls
go from the sandbox, never from a `printful.com` tab (CORS).

## Quick start

```bash
printful auth login --token <tok>     # once; mint at developers.printful.com/tokens
printful whoami                       # customer + store (token last-4 only)
printful stores                       # native / shopify / … including "Personal orders"

printful files add --url https://example.com/art.png --filename art.png
printful files get 1044863309         # poll until status=ok (width/height/hash)

printful catalog product 71           # Bella + Canvas 3001
printful catalog variants 71 --color Black --size M

printful store product create --name "My tee" --variant-id 4017 --file-id 1044863309 --confirm
printful order create --variant-id 4017 --file-id 1044863309 \
  --name "Lars Trieloff" --address1 "…" --city Berlin --country DE --zip 10115
printful order confirm 123 --confirm  # CHARGES the account — preview without this flag
```

`--json` on any command dumps the raw payload. Mutations that create store
products or charge money need `--confirm`; without it they print the request
and exit 0.

## Authentication

Preferred: a **store-level private token** from
<https://developers.printful.com/tokens> (scopes `orders`, `file_library`,
`sync_products`), stored with `printful auth login --token <tok>`. The token is
validated against `GET /stores` before being saved and **never printed** —
`printful auth status` shows only the last four characters.

Fallback, if a logged-in `www.printful.com` dashboard tab is open:
`printful auth login` (no `--token`) mints a store token via the dashboard
GraphQL (`devPortalCreateTokenMutation`) and stores it. That still needs the
human to have signed in to Printful once.

`product_templates` is **Account-only** — a store token with that scope is
rejected. Pass `X-PF-Store-Id` only for account-level tokens; store tokens
already have a store baked in.

CORS: `fetch('https://api.printful.com/…')` from a Printful tab throws
`TypeError: Failed to fetch`. Always call the API from this CLI.

## Files must be publicly fetchable

`POST /files` takes a URL. Printful's servers GET it; a `file://` or
sandbox-only path will sit in `status: waiting` forever. Host the PNG first
(`serve --ttl 1d --no-bridge <dir>`) or pass an already-public `--url`.
`printful files add --path ./art.png` does the serve step for you.

Poll `GET /files/{id}` until `status` is `ok` or `failed`. A 3000×4800 RGBA PNG
is plenty for a DTG chest print (Printful asks ≥1500×3000 @ 150 dpi).

## Orders vs store products vs templates

| Surface | What it is | Where it shows |
|---|---|---|
| File library | Print files, hashed, reusable | API `GET /files` |
| Sync / store product | Named SKU + variant + file, no charge | API `GET /store/products` — **not** "Meine Produkte" |
| Product template | Design Maker save | Dashboard → Meine Produkte |
| Order | A shipment. Draft = no charge; confirm = pay | Dashboard → Bestellungen |

Creating a sync product does **not** put it in "Meine Produkte". That list is
templates. Personal-orders (native) stores also don't appear as a connected
Shopify/Etsy shop on the Stores page.

## Don't

- Don't drive the Design Maker file-library with `playwright-cli drop` /
  hidden `<input type=file>` — the Vue handler never fires (2026-08-25).
- Don't confirm an order without an explicit user "yes, charge me".
- Don't print the private token. Don't embed a customer or store id as a
  fallback — resolve from `GET /stores`.
- Don't call `api.printful.com` from page context.

Per-command flags: [`references/COMMANDS.md`](references/COMMANDS.md).
Endpoint map, GraphQL mint, CORS, and the UI traps:
[`references/internals.md`](references/internals.md).
