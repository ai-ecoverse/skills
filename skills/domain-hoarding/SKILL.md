---
name: domain-hoarding
description: |
  Use this when the user asks whether a domain name is free, available, unregistered, taken or registrable, or which TLDs have ALL of several names available at once ("is live.page free?", "which extensions are open for live, page and preview?", "check these domains", "find a TLD where all my names are available", "domain hoarding", "is it premium?"). "Free" means available to register, not zero-cost. Checks Instant Domain Search first, then RDAP via the IANA bootstrap, then a conservative WHOIS-over-HTTP fallback, then DNS, and grades every answer into a confidence tier — an RDAP 404 is never reported as registrable. Outputs a human summary, JSON or CSV. Not DNS record lookup (A/MX/TXT/NS records of a live site) — use `dns`/`dig` for that. Not buying or registering a domain, not Cloudflare/Fastly zone management, not WHOIS-history or trademark search.
allowed-tools: bash
---

# domain-hoarding

`domain-hoarding` answers two questions without rebuilding the lookup pipeline each time:
**"is this name available?"** and **"on which TLDs are ALL of these names available?"**.
In this skill "free" means *available/unregistered* — never *costs $0*. A premium name is
available too; it is just priced above standard registration and is labelled PREMIUM.
It never buys anything and only writes to its cache directory (and `--out`).

```bash
domain-hoarding check live.zip page.dev google.com            # verdict + evidence per domain
domain-hoarding check --from names.txt --json                 # .txt (one per line) or .csv with a 'domain' column
domain-hoarding scan live page preview --tlds com,net,io,dev  # matrix + TLDs available for every label
domain-hoarding scan live page preview --all --csv --out scan.csv   # 636-suffix universe
domain-hoarding tlds [--live-tlds]                            # list the TLD universe
```

Run `domain-hoarding --help` for every flag. Output is human by default (`--no-color` for plain text);
`--json` and `--csv` print only machine output on stdout (`--out FILE` writes it to a file and prints
the human report instead). Notes and warnings go to stderr.

## How to read a verdict — the four tiers

| Tier | Glyph | Meaning | Say it as |
|---|---|---|---|
| `available-high-confidence` | `✓` / `$` | Instant Domain Search answered `available` with `trust: high` | "available" (`✓`), or "available but PREMIUM $N" (`$`) |
| `unregistered-needs-confirmation` | `?` | RDAP 404 / WHOIS "yes" / DNS empty / IDS `available` at lower trust | "no registry record — confirm at a registrar" |
| `inconclusive` | `~` | No source could decide (no RDAP server, IDS silent, errors, sources disagree) | "could not tell" |
| `taken-reserved-blocked` | `✗` | In use, registry-reserved, blocked, or an RDAP/WHOIS/DNS record exists | "taken" |

**An RDAP 404 means "no registry record", not "you can register it".** In the 2026-09-24 scan 249
names were RDAP-unregistered yet needed checkout confirmation (reserved, premium, blocked). Never
upgrade `?` to "available". **Premium names DO qualify as available**: the headline line of `scan`
("AVAILABLE for ALL n label(s)") includes them, then splits out which TLDs are standard-price,
which contain a PREMIUM label, and which have unchecked premium status. JSON: `available`, `premium`
(true/false/null = not checked), `premiumUsd`. Rule table: [references/confidence-tiers.md](references/confidence-tiers.md).

## Workflow

1. **Ask once per name.** Instant Domain Search grades `trust: high` only the *first* time a name is
   asked in its cache window; later asks return `medium`. The command remembers high-trust answers
   for 60 minutes (`--cache-ttl`, `--no-cache`) — do not loop `check` on the same names or retry hoping for `high`.
2. **Pick the mode.** One or a few full domains → `check` (also RDAP-checks every name, shows expiry of
   taken ones). Several labels × many TLDs → `scan` (RDAP only for names IDS did not settle; `--verify` forces it).
3. **Choose the TLD scope.** `--tlds com,net,co.uk` for a shortlist; no flag uses 18 popular TLDs;
   `--all` uses the shipped 636-suffix snapshot (Porkbun bulk-search selector, 2026-09-24);
   `--all --live-tlds` fetches Porkbun's public pricing list (~900 TLDs, adds prices, cached 24 h).
4. **Report in tiers.** Lead with `✓`/`$` names (state the PREMIUM price), mention `?` as "unconfirmed",
   say how many were `~`. For `scan`, quote the "AVAILABLE for ALL n label(s)" line and its premium split.
5. **Read the stderr line and warnings.** A warning that IDS graded few answers `high` means names were
   asked before (results are already tiered conservatively); a WHOIS warning lists the names disclosed.

## Source order, politeness and latency

- IDS → RDAP (IANA bootstrap + proven overrides) → **WHOIS over HTTP** → DNS NS via `dig`. WHOIS runs
  *only* for names IDS left unsettled AND RDAP had no server for or could not answer. `api.whois.vu` is a
  **third party**: the names sent to it are printed on stderr and recorded in `stats.whois.namesSent`.
  `yes` can only reach `?`; `no` reaches `✗` only with registration data in its text. Opt out with
  `--no-whois`; `--whois-max N` (25) bounds disclosure. Port-43 WHOIS is unreachable from SLICC.
- Defaults: 6 concurrent requests, 2 in flight and 200 ms spacing per registry host, WHOIS strictly
  sequential at 1 s spacing, 100 names per IDS call, circuit breakers, a hard cap per lookup
  (`--timeout`, 10 s ×1.5 incl. retries; 5 s when IDS already settled the name) and a run-wide
  `--budget` for RDAP/WHOIS/DNS (45 s + 0.25 s per name beyond 60). A throttled source leaves names
  `inconclusive` with the reason — it does not stall the run.
- Exit codes: `0` ran; `1` usage error or unreadable input; `2` ran but **no** source answered.
- `check` rejects bare labels and `scan` rejects dotted labels (each message names the right command);
  unknown flags are errors. Details: [references/sources-and-limits.md](references/sources-and-limits.md).

## Don't

- Don't answer "yes, available" from `--no-premium` runs without saying premium status is unchecked.
- Don't treat `medium`-trust "available" as available; re-asking cannot upgrade it, so confirm at a registrar.
- Don't say a domain costs nothing; only a registrar checkout states the price.
- Don't scan thousands of names in a tight loop; one `scan --all` per question is plenty.

## References

- [references/confidence-tiers.md](references/confidence-tiers.md) — tier rules, precedence, premium handling, conflicts, trust-degrades-on-re-ask.
- [references/sources-and-limits.md](references/sources-and-limits.md) — wire formats, WHOIS fallback evidence, RDAP overrides, TLD universe, caches, limits, unverified areas.
- [references/output-formats.md](references/output-formats.md) — JSON shape, CSV columns, exit codes.
