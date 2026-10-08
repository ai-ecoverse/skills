# Confidence tiers

Every name ends in exactly one tier. The tier is computed by `scripts/classify.js` from whatever
evidence was gathered; the same inputs always give the same tier.

Vocabulary: in the brief "free" means **available (unregistered and registrable)**, not zero-dollar.
This skill says AVAILABLE and PREMIUM and never implies a domain costs $0.

| Tier | Produced by |
|---|---|
| `taken-reserved-blocked` | RDAP 200 · IDS `inuse`/`reserved`/`blocked` (any trust) · WHOIS `no` with registration data · DNS NS delegation |
| `available-high-confidence` | IDS `available` **and** `trust: high` (and the bulk endpoint does not say registered) |
| `unregistered-needs-confirmation` | IDS `available` at `medium`/`low` trust · RDAP 404 · WHOIS `yes` · DNS no-delegation |
| `inconclusive` | none of the above — no RDAP server, IDS `unsupported`/`missing`/error, all sources failed, time budget exhausted, or sources disagree |

**Precedence (first match wins; `scripts/classify.js`, pinned by tests):**
1. RDAP `registered` → taken (registry data beats an aggregator; flagged `conflict` if IDS said available).
2. IDS `inuse`/`reserved`/`blocked` → taken, even if RDAP says 404.
3. WHOIS `registered` / DNS `delegated` → taken — **unless IDS said available/high**, in which case the weaker source contradicts the primary one and the row is `inconclusive` + `conflict`.
4. IDS available/high → available (bulk `isRegistered: true` → `inconclusive` + `conflict`).
5. IDS available at lower trust → unregistered-needs-confirmation.
6. RDAP 404, then WHOIS `yes`, then DNS no-delegation → unregistered-needs-confirmation.
7. Otherwise inconclusive, with every source's status in `reason`.

## Why RDAP 404 is not "available"

An RDAP 404 only says the registry has no *domain object*. It cannot see registry reservations,
premium or "special" pricing, sunrise/landrush holds, trademark blocks, or names withheld by the
registrar. The 2026-09-24 scan found **249** names that were RDAP-404 yet could not be treated as
free. The same scan's `blocked`/`reserved` IDS answers show it: `live.art` (IDS `blocked`) and `live.auction`
(IDS `reserved`) were RDAP 404 on 2026-10-08 (a later re-run: the registry timed out on `live.auction`, IDS still `reserved`). So an RDAP 404 can only ever
produce `unregistered-needs-confirmation`. The gelatiere prompt line "treat 404 as available" is wrong.

## Premium is separate from the tier — and premium names QUALIFY

A premium name is registrable, so it stays `available-high-confidence` and counts as **available**.
Rows carry `available` (bool), `premium` (`true` / `false` / `null` when the bulk lookup did not run or
failed — standard price is never claimed without evidence) and `premiumUsd` (IDS `/services/bulk-check`,
`premium.usd_cents / 100`). The human view shows `✓` or `$` (PREMIUM), and `scan` computes the "all
labels available" intersection **including** premium cells, then splits it:
`allAvailable` ⊇ `allAvailableStandard` (every cell `premium:false`), `allAvailableButPremium` (≥1 premium
cell) and `allAvailableUnchecked` (no premium, ≥1 unknown). Measured 2026-10-08: of 10 fresh `page.*`
names IDS called `available/high`, 7 were premium ($66–$400); `live.zip` $999 and `page.tech` $1000 on
the verification re-run. The 2026-09-24 CSV did not record premium status. A premium price is
only the *premium* price: standard registration prices come from `--live-tlds` (`porkbunUsd`) or a registrar.

## Conflicts

- RDAP 200 against IDS `available` → `taken`, `conflict: true` (registry data beats an aggregator).
- IDS `available/high` against bulk `isRegistered: true` → `inconclusive`, `conflict: true`.
- IDS `available/high` against WHOIS `no` or DNS delegation → `inconclusive`, `conflict: true`.

Conflicts print their reason in the human view; the JSON/CSV `reason` column always says why.

## IDS trust is spent on the first ask  (measured 2026-10-08)

IDS marks `trust: high` only when it performs a fresh registry check. Evidence:

| Experiment | Result |
|---|---|
| 30 never-asked names | 29 `available/high`, 1 `reserved/high` |
| the same 30, reversed order (different request) | 29 `available/medium`, 1 `reserved/medium` |
| the first 100 names re-asked 35–60 min after their first ask | 98 `available/medium` |
| the same 15 names re-asked after 0 / 20 / 40 / 60 / 90 s | 0 high every time |
| fresh batch sizes 12, 13, 15, 20, 30, 50 | high count tracks the number of *new* names only |

So the first answer is the valuable one and a repeat cannot improve it. `domain-hoarding` therefore
(a) never sends a name twice in one run, (b) remembers a `high` answer for `--cache-ttl` minutes
(default 60; `0` or `--no-cache` disables) in `$TMPDIR/domain-hoarding/ids-answers.json` and reuses
it instead of re-asking, and (c) warns when fewer than half of the `available` answers were high.
The server-side window is longer than 60 minutes (not measured beyond ~60 min), so a cache expiry
followed by a re-ask will usually come back `medium` → `unregistered-needs-confirmation`; that is
the conservative direction.

A reused answer is flagged in JSON as `ids.cached: true, ids.ageSec: N` and in the human view as
"remembered Nm ago". Treat remembered answers as up to `--cache-ttl` minutes stale.

## What to say

- `✓` → "available at standard price (Instant Domain Search, trust high, at <time>); price is the registrar's."
- `$` → "available but PREMIUM, $N."
- `?` → "no registry record, but I can't promise it is registrable — confirm at a registrar."
- `~` → "couldn't determine" plus the `reason`.
- `✗` → "taken", with the RDAP expiry date when present (useful for watching a drop).
