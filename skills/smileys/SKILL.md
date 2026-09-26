---
name: smileys
description: >
  Interact with Smiley's Pizza (shop.smileys.de / smileys.de Lieferservice)
  via its shop API. Use when the user wants to browse the Smiley's menu,
  add pizzas to the cart, check delivery options, or automate a Potsdam
  Smiley's order without clicking the shop UI. Activate on "smileys",
  "Smiley's", "smileys.de", "Smiley's Pizza", "Pizza bestellen Potsdam".
  Cookie session from an open shop.smileys.de tab — no API key. Cart add
  is unguarded; checkout requires --confirm. Payment (PayPal/Stripe wallet)
  is documented but not exposed as a command.
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

Prerequisite: `https://shop.smileys.de` (or mein.smileys.de) open and
logged in. Default store slug **potsdam** (override `--store`).

## Usage

```
smileys stores
smileys autocomplete "potsdam rudolf"
smileys groups <productId>          # e.g. sp_eusIzlcHSil9
smileys add <productId> --size large [--option group:item] [--qty N]
smileys suggestions
smileys delivery
smileys checkout --confirm --firstname … --lastname … --email … \
  --phone … --street … --number … --zip … --city …
smileys --help
```

`--json` on every command. `--store <slug>` defaults to `potsdam`.

`add` POSTs to the live cart. `checkout` is a real order step and
requires `--confirm` plus the address flags (never hardcoded). PayPal /
Stripe wallet endpoints exist (`references/endpoints.md`) and are **not**
wired — they charge money.

## Requires

Open logged-in tab matching `smileys.de`.
