---
name: oryx
description: Interact with the ZSA Oryx keyboard configurator (oryx.zsa.io,
  configure.zsa.io) via its GraphQL API — list, inspect, edit, and compile
  layouts for ZSA Voyager, Moonlander, and ErgoDox EZ keyboards. Use when
  the user wants to automate ZSA / Oryx, dump a keyboard layout, edit
  layers or keys without clicking through the configurator UI, fork a
  revision, change layout privacy, set tags, trigger a firmware compile,
  download .bin / .zip firmware bundles, manage combos, or run any GraphQL
  query against the Oryx backend. Activate on mentions of zsa, oryx,
  voyager, moonlander, ergodox, keyboard layout, keymap, qmk, layer,
  combo, key code (KC_*), firmware compile, hex file, or related
  workflows.
allowed-tools: bash
---

# ZSA Oryx (`oryx`)

Direct GraphQL access to the ZSA Oryx keyboard configurator at
`oryx.zsa.io`. Use the bundled `oryx` command instead of clicking through
the configurator UI.

## Quick start

```bash
oryx whoami                          # who am I logged in as
oryx layouts                         # list my layouts (with revision history)
oryx get vqyGO                       # summary of layout vqyGO at latest revision
oryx layers vqyGO                    # list layers in vqyGO
oryx keys vqyGO --layer=0            # compact keymap for layer 0
oryx combos vqyGO --rev=ZPKlzJ       # combos in revision ZPKlzJ
oryx download vqyGO --type=zip       # download QMK source zip
oryx download vqyGO --type=hex -o fw.hex   # download flashable firmware
```

## Authentication

Oryx uses a JWT Bearer token. The skill resolves it in this order:

1. **Config file** at `/workspace/skills/oryx/.config`:
   ```json
   { "jwtToken": "eyJ..." }
   ```
2. **Browser** — `localStorage.jwtToken` on any open `oryx.zsa.io` /
   `configure.zsa.io` tab (preferred) or any other `*.zsa.io` tab.

The Oryx API does **not** validate `Origin`, so direct `fetch()` from the
SLICC runtime works once a token is in hand — no `playwright-cli eval`
detour is needed.

When a request fails with 401/403, the script tells you to log into
<https://oryx.zsa.io> in the browser and retry. To make the JWT durable
across browser sessions, copy it into `.config`.

## Identifiers

Most resources are addressed by short hash IDs:

| Resource   | Example     | Where you see it                          |
|------------|-------------|-------------------------------------------|
| `User`     | `v6bjL`     | `oryx whoami`                             |
| `Layout`   | `vqyGO`     | URL: `configure.zsa.io/<geom>/layouts/<id>/...` |
| `Revision` | `ZPKlzJ`    | `oryx layouts` (per-layout list)          |
| `Layer`    | `Oy7Jzg`    | `oryx layers <layoutId>`                  |
| `Tag`      | `VYj`       | `oryx tags`                               |

`<rev>` arguments accept either a real revision hash or the literal string
`latest`. Geometry is one of `voyager`, `moonlander`, `ergodox_ez`, etc.

## Coordinates

Refer to keys by side / row-relative-to-home / finger instead of opaque
position numbers (Voyager only for now):

```
oryx grid                       # print the position grid + finger map
oryx where 16                   # pos → coord  (16 → L.home.idx)
oryx where L.home.idx           # coord → pos  (= 16)
```

Coord syntax: `<side>.<row>.<finger>`

| field   | values                                                   |
|---------|----------------------------------------------------------|
| side    | `L` \| `R`                                               |
| row     | `top` \| `upper` \| `home` \| `lower` \| `thumb`         |
| finger  | `pky-out` \| `pky` \| `rng` \| `mid` \| `idx` \| `idx-in` |
|         | `in` \| `out` (thumb keys)                               |

Most commands that take `--pos=N` also accept `--at=<coord>`:

```bash
oryx key-update <layerHashId> --at=L.upper.pky --json='{...}'
oryx key-update <layerHashId> --at=R.thumb.in --json='{...}'
```

`oryx keys --layer=N` decorates every key with its coord, so you never
have to count.

## Read commands

```bash
oryx whoami
oryx layouts
oryx search [--tags=t1,t2] [--geom=voyager] [--start=0] [--limit=20]
oryx tags  [--filter=foo]   [--limit=100]

oryx get      <hashId> [--rev=latest] [--geom=voyager]   # summary + layer headers
oryx full     <hashId> [--rev=latest] [--geom=voyager]   # full layout (config, keys, combos)
oryx layers   <hashId> [--rev=latest]
oryx keys     <hashId> --layer=N [--rev=latest] [--raw]  # compact, or raw JSON
oryx combos   <hashId> [--rev=latest]
oryx download <hashId> [--rev=latest] [--type=hex|zip] [-o file]
```

## Mutations

```bash
oryx fork          <revisionHashId>                  # create an editable fork of a revision
oryx clone         <revisionHashId> --title=...      # create a new layout from a parent
oryx privacy       <hashId> public|private
oryx title         <hashId> <new title…>
oryx layout-tags   <hashId> <tagId1,tagId2,...>
oryx compile       <revisionHashId>                  # build firmware (.bin/.zip)
oryx delete-layout <hashId>

oryx layer-update  <layerHashId> [--title=...] [--color=#hex] [--pos=N]
oryx layer-color   <layerHashId> <#hex>
oryx layer-delete  <layerHashId>
oryx layer-restore <layerHashId>
oryx layer-add     <revisionHashId> --pos=N [--title=...] [--keys='[…]']

oryx key-update    <layerHashId> --pos=N --json='{...key blob...}'
oryx swap-keys     <srcLayerId> <dstLayerId> [--src-pos=A] [--dst-pos=B]

oryx combo-add     <revisionHashId> --layer=I --indices=1,2,3 --name=Foo --trigger='{...}'
oryx combo-delete  <revisionHashId> --idx=N
```

The shape of `--json=` (key data) and `--trigger=` (combo trigger) mirrors
the JSON Oryx returns. The easiest way to construct one is:

```bash
oryx keys <layoutHashId> --layer=N --raw \
  | jq '.[42]'                                      # take key 42
```

…then edit and pass it back via `oryx key-update`.

## Escape hatches

```bash
oryx gql '<query>' [--vars='<json>']                  # raw GraphQL query / mutation
oryx schema [--type=Query|Mutation|<TypeName>]        # introspect a type
```

## What's where

- `scripts/oryx.jsh` — the CLI itself (auto-registered as `/usr/bin/oryx`).
- `references/endpoints.md` — full GraphQL endpoint catalog with examples.
- `assets/schema.json` — cached introspection result for offline reference.
- `.config.example` — template for `.config`.
- `.config` (gitignored via `skills/oryx/.config`) — `{"jwtToken":"..."}`
  if you want to bypass the browser dependency.

## Notes

- The Oryx GraphQL endpoint is `https://oryx.zsa.io/graphql`. There are
  no known rate limits, but be polite with mutations.
- Compiled firmware lives behind signed `rails/active_storage` redirects.
  `oryx download` follows the redirects automatically (`curl -L`).
- After `oryx compile`, give the build a few seconds before downloading —
  the response includes the new `hexUrl`/`zipUrl` directly when the build
  is ready.
- The `keys` Json blob per layer is an *array* indexed by physical key
  position. Length equals the keyboard's key count (52 for Voyager,
  76 for Moonlander, 80 for ErgoDox EZ).
- **Layer hashes rotate** whenever Oryx creates a new draft revision,
  which it does on any auto-save (e.g. when the configurator tab is
  open and you click around). Always re-fetch the current layer hash
  with `oryx layers <hashId>` immediately before any mutation —
  stale layer hashes return `Unauthorized`, not `Not Found`.
