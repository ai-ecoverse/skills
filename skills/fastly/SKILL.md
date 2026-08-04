---
name: fastly
description: Manage Fastly CDN from the command line, mirroring the official `fastly` CLI (github.com/fastly/cli) against the Fastly API — `whoami`, `service list/describe/search`, service versions, `domain list`, `service purge` (URL, surrogate key, or purge-all), `stats` (historical, aggregate, usage, regions), `pops`, `ip-list`, plus `fastly api` as an authenticated raw passthrough to any endpoint (VCL, ACLs, TLS, KV stores, Compute, products). Authenticates with a long-lived Fastly API token, or by harvesting the session token from a logged-in `manage.fastly.com` tab. Billing does NOT live here — the upstream CLI has no billing command group, so invoices, month-to-date spend, unpaid-invoice checks and a backtested month-end forecast live in the sibling binary `fastly-ext billing`. Use when the user mentions Fastly, Fastly CLI, CDN cache purge/invalidation, surrogate keys, edge/POPs, VCL services, Fastly stats or bandwidth, `manage.fastly.com`, or a Fastly invoice or bill. Not Cloudflare, not AWS CloudFront.
allowed-tools: bash
command: fastly
script: scripts/fastly.jsh
---

# Fastly

Two binaries. **`fastly`** mirrors the official Fastly CLI — same command names,
same flag names (`fastly service list`, `--service-id`, `--per-page`, `--by`) —
implemented directly against `https://api.fastly.com`, so copied docs and muscle
memory transfer. **`fastly-ext`** holds the one thing upstream does not have:
billing.

## Quick start

```bash
fastly auth login --token <token>   # once; token from manage.fastly.com → Personal API tokens
fastly whoami                       # login, name, role, customer id, token scope + expiry

fastly service list --per-page 20               # your services, newest first
fastly service describe <service-id>            # domains, backends, active version
fastly service domain list --service-id <id>    # domains on the active version
fastly stats aggregate --from 2026-08-01 --by day
fastly pops                                     # 179 POPs grouped by region
fastly api /service/<id>/version/67/vcl         # anything not wrapped above

fastly-ext billing mtd                          # month-to-date, fixed vs usage
fastly-ext billing forecast                     # month-end estimate + error band
```

## Authentication

Preferred: a **long-lived personal API token** from
<https://manage.fastly.com/account/personal/tokens> (scope `global`, or
read-only if you only query), stored with `fastly auth login --token <tok>`. It
is validated against `GET /tokens/self` before being stored and never reaches
stdout — `fastly auth status` prints only the last four characters.

Fallback: with no token stored, the skill reads the `global`-scope API token the
`manage.fastly.com` SPA keeps in `sessionStorage`, and warns you. That token
**expires ~12 hours after login**, so it is a convenience, not a setup; on a 401
the skill re-harvests once before failing. `fastly auth logout` clears local
state only — revoke server-side in the UI. `fastly-ext` shares the same stored
token because every request it makes goes through `fastly api`.

## Commands

| Command | What it does |
|---|---|
| `fastly whoami` | Authenticated user + token scope/expiry (`/current_user`, `/tokens/self`) |
| `fastly auth login [--token T]` | Validate and store a token; harvests the browser session if `--token` is omitted |
| `fastly auth status` / `auth logout` | Show stored-token state and validity / forget it |
| `fastly service list` | Services (`--page`, `--per-page`, `--sort`, `--direction`) |
| `fastly service describe [<id>]` | Details: domains, backends, version count, active version |
| `fastly service search --name <n>` | Resolve a service by exact name |
| `fastly service version list --service-id <id>` | Versions, newest first, active/locked/draft |
| `fastly service domain list --service-id <id>` | Domains on `--version active\|latest\|staged\|N` (default `active`) |
| `fastly service purge …` | Invalidate cache by `--url`, `--key`, `--file`, or `--all`; `--soft` marks stale |
| `fastly domain list` | Domain Management v1 (`--fqdn`, `--limit`, `--cursor`, `--service-id`) |
| `fastly domain describe <domain-id>` | One managed domain: activation + verification state |
| `fastly stats [historical]` | Per-service or account-wide (`--service-id`, `--from`, `--to`, `--by`, `--region`, `--field`) |
| `fastly stats aggregate` | Account-wide totals per period (`/stats/aggregate`) |
| `fastly stats usage` / `stats regions` | Bandwidth + requests per billing region / valid `--region` values |
| `fastly pops` / `fastly ip-list` | POPs grouped by region / Fastly's public IPv4+IPv6 ranges |
| `fastly version` | Skill version, API base, auth state |
| `fastly api [METHOD] <path\|url> [--data <json>]` | Authenticated raw call — the escape hatch |
| `fastly-ext billing invoices \| invoice \| mtd \| forecast \| summary` | See the billing section |

Add `--json` to any command for the raw API payload. **Use long flags with
values** (`--service-id X`, `--by day`): this runtime hands single-dash flags
over as booleans, so short aliases are deliberately not offered. Full
per-command flag reference: [`references/COMMANDS.md`](references/COMMANDS.md).

## Purging is gated

`fastly service purge` prints a preview and does nothing without `--confirm`:

```bash
fastly service purge --url https://www.example.com/page             # preview only
fastly service purge --url https://www.example.com/page --confirm
fastly service purge --service-id <id> --key nav --soft --confirm   # mark stale, don't evict
fastly service purge --service-id <id> --all --confirm              # purge everything
```

URL purges go through `POST /purge/{host}{path}` on `api.fastly.com` rather than
sending your token to an arbitrary edge host. Only `api.fastly.com` and
`rt.fastly.com` are ever given the token, including via `fastly api`.

## Stats: summarised by default

`/stats` for a month is ~2 MB, so the formatted view aggregates requests,
bandwidth, hit ratio, 4xx/5xx and errors; `--json` dumps everything. A `n/a` hit
ratio is normal for Compute services (no hits and no misses).

```bash
fastly stats --service-id <id> --from 2026-08-01 --to 2026-08-04 --by hour
fastly stats --from 2026-08-01 --by day            # all services, ranked by requests
fastly stats usage --from 2026-07-01 --to 2026-07-31
```

## fastly-ext: billing (not in the upstream CLI)

The official CLI's 32 command groups contain no billing group. To keep `fastly`
command-compatible with the upstream tool, that capability lives in a separate
binary, **`fastly-ext`** (`scripts/fastly-ext.jsh`), backed by the Billing v3 API.

```bash
fastly-ext billing invoices --limit 12        # newest first, fixed/usage split, payment status
fastly-ext billing invoice INV-375119         # by product_group + top line items
fastly-ext billing invoice month-to-date
fastly-ext billing mtd                        # month-to-date with the run-rate warning
fastly-ext billing forecast                   # point estimate + backtested error band
fastly-ext billing summary --year 2026        # per-month totals, annual sums, unpaid invoices
```

Two things dominate correctness here. First, **month-to-date is not a run
rate**: fixed subscriptions (Enterprise Support, TLS certificates) are billed in
full on day 1, so `mtd` splits fixed from usage and refuses to imply otherwise.
Second, the **forecast interval is measured, not invented** — usage is the prior
month's usage rescaled by day-of-week-weighted month size, and the band is the
10th–90th percentile of that same estimator's *out-of-sample* one-month-ahead
errors over the last 12 invoices, inverted onto the prediction. It is an
empirical error band, not a confidence interval, and `--help` says so. Endpoint
shapes, the confirmed-404 endpoints, and the forecast maths:
[`references/billing-api.md`](references/billing-api.md).

## Maintaining this skill

Which endpoint backs which command, the token-harvest mechanism, host
allow-listing, pagination quirks and the flag-parsing constraints are in
[`references/internals.md`](references/internals.md).
