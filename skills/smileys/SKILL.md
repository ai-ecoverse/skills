---
name: smileys
description: >
  Interact with Smiley's Pizza (shop.smileys.de / smileys.de Lieferservice)
  via its shop API. Use when the user wants to browse the Smiley's menu,
  add pizzas to the cart, check delivery options, or automate a Potsdam
  Smiley's order without clicking the shop UI. Activate on "smileys",
  "Smiley's", "smileys.de", "Smiley's Pizza", "Pizza bestellen Potsdam".
  Cookie session from an open shop.smileys.de tab — no API key. Cart add
  is unguarded; checkout previews by default and writes only with --confirm.
  Payment (PayPal/Stripe wallet) is documented but not exposed as a command.
allowed-tools: bash
command: smileys
script: scripts/smileys.jsh
---

# Smiley's Pizza

Browser-session client for `https://shop.smileys.de`. Discovered from HAR
`rec-1790006577637-qkwv8m` (2026-09-21): login on mein.smileys.de, shop on
shop.smileys.de, PayPal at the end (tab closed — payment not automated).

## Auth

First-party cookies. Every call is issued from an open Smiley's tab so
cookies and Origin travel. **No cookie is logged or stored.**

Prerequisite: a `https://shop.smileys.de` tab open and logged in (sign in on
mein.smileys.de, then open the shop in that tab). Writes are same-origin
fetches from the shop tab. The store is the `/store/<slug>` page the shop tab
is on (e.g. `potsdam`); `--store <slug>` overrides it. There is no default.

## Usage

```
smileys stores
smileys autocomplete "potsdam rudolf"
smileys groups <productId>          # e.g. sp_eusIzlcHSil9
smileys add <productId> --size large [--option group:item] [--qty N]
smileys suggestions
smileys delivery
smileys checkout --firstname … --lastname … --email … \
  --phone … --street … --number … --zip … --city …      # preview, writes nothing
smileys checkout --confirm --firstname … …              # start checkout, save customer
smileys --help
```

`--json` on every command. Put `--confirm` last: a value after it is refused.
`--qty` is 1–20.

`add` POSTs to the live cart. `checkout` is a real order step:

1. Run it **without** `--confirm`. It prints the store, customer and address
   it would send, and writes nothing. Check them against what the user said.
2. If anything is wrong, fix the flags and preview again.
3. Run it again with `--confirm`: it starts checkout (POST) and saves the
   customer (PUT), in the order the shop's own client uses.
4. Verify with `smileys delivery`: it answers only once a checkout exists.
   If the customer save (PUT) failed after checkout started, fix the flags and
   re-run with `--resume --confirm`, which sends only the PUT. Do not re-run a
   plain `--confirm`: it would start a second checkout.

Address flags are always the user's; nothing is hardcoded. PayPal / Stripe
wallet endpoints exist (`references/endpoints.md`) and are **not** wired —
they charge money, and paying stays with the human in the shop tab.

## Requires

A logged-in tab on `https://shop.smileys.de`.
