# `printful` — command reference

Global conventions:

- `--json` on any command emits the raw API payload instead of the summary.
- `--token <tok>` overrides the stored token for one call and is not persisted.
- Flags need the **long form with a value** (`--variant-id 4017`). The runtime
  hands single-dash flags over as booleans, so short aliases are not offered.
- Store selection: `--store-id <id>` sends `X-PF-Store-Id` (needed for
  account-level tokens). Store-level tokens ignore it.

## Auth and identity

| Command | Flags | Notes |
|---|---|---|
| `printful auth login` | `--token <tok>`, `--name <n>`, `--days N` | Validates with `GET /stores`, then stores. Without `--token`, mints via dashboard GraphQL if a `www.printful.com` tab is logged in. `--days` (default 90) and `--name` apply only to minting. |
| `printful auth status` | `--json` | Masked token, source (`private-token` / `graphql-mint`), expiry, live validity. |
| `printful auth logout` | — | Clears the locally stored token. Does not delete it in the Developer Portal. |
| `printful whoami` | `--json` | `GET /stores` plus stored metadata. Token last-4 only. |
| `printful stores` | `--json` | `GET /stores` — id, name, type (`native`, `shopify`, …). |

`printful login` / `printful logout` are aliases of the `auth` forms.
`printful auth token` is **not** implemented: it would print a live credential.

## Files

| Command | Flags |
|---|---|
| `printful files list` | `--limit N`, `--offset N` |
| `printful files get <id>` | — |
| `printful files add` | `--url <https>`, `--path <vfs>`, `--filename <name>`, `--wait` |
| `printful files wait <id>` | `--timeout <seconds>` (default 60) |

`files add --url` POSTs `{url, filename}` to `/files`. `files add --path`
requires a public URL — the CLI `serve`s the parent directory with
`--ttl 1d --no-bridge` and POSTs that URL. `--wait` polls until `status=ok`
or `failed`. Printful GETs the URL from their network; a sandbox-only path
never leaves `waiting`.

## Catalog

| Command | Flags |
|---|---|
| `printful catalog product <id>` | `--json` |
| `printful catalog variants <product-id>` | `--color <name>`, `--size <S\|M\|L\|…>`, `--in-stock` |

`catalog product 71` is Bella + Canvas 3001. Variant ids are what
`--variant-id` wants on store products and orders (Black / M = `4017`,
measured 2026-08-25).

## Store products (sync)

| Command | Flags |
|---|---|
| `printful store products` | `--limit N`, `--offset N` |
| `printful store product get <id>` | — |
| `printful store product create` | `--name`, `--variant-id`, `--file-id` and/or `--file-url`, `--retail-price`, `--placement front\|back\|…`, `--confirm` |

Without `--confirm`, `store product create` prints the body it would POST and
exits 0. A created sync product is **not** a Design Maker template and will not
appear under Meine Produkte.

## Orders

| Command | Flags |
|---|---|
| `printful orders` | `--limit N`, `--offset N`, `--status` |
| `printful order get <id>` | — |
| `printful order create` | `--variant-id`, `--file-id` / `--file-url`, `--quantity N`, `--name`, `--address1`, `--address2`, `--city`, `--state`, `--country`, `--zip`, `--confirm` |
| `printful order confirm <id>` | `--confirm` |

`order create` without `--confirm` POSTs a **draft** (`?confirm=0` is the
API default) — no charge. `order confirm` is the paid step and is gated:
without `--confirm` it prints the order id and cost, then exits 0.

Recipient fields map to the API `recipient` object. `--country` is an ISO
code (`DE`, `US`). `--state` is required for US/CA/AU.

## Escape hatch

| Command | Flags |
|---|---|
| `printful api [METHOD] <path\|url> [--data <json>]` | `--store-id` |

`METHOD` defaults to `GET`. Path is rooted at `https://api.printful.com`.
Only `api.printful.com` is ever given the token.
