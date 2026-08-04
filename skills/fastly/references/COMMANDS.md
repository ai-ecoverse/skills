# `fastly` / `fastly-ext` — full command reference

Command and flag names deliberately match the official Fastly CLI
(<https://www.fastly.com/documentation/reference/cli/>). Every docs page has a
markdown twin — append `.md` to the URL, e.g.
<https://www.fastly.com/documentation/reference/cli/service/list.md> — which is
the source used to check flag names here.

Global conventions:

- `--json` on any command emits the raw API payload instead of the summary.
- `--token <tok>` overrides the stored token for one call and is not persisted.
- Flags need the **long form with a value** (`--service-id X`). The runtime hands
  single-dash flags to the script as boolean `true`, so short aliases are not offered.
- Service selection: `--service-id <id>` (upstream name), `--service <id>`
  (alias), or `--service-name <name>` (resolved via `/service/search`).

## Auth and identity

| Command | Flags | Notes |
|---|---|---|
| `fastly auth login` | `--token <tok>` | Validates with `GET /tokens/self`, then stores. Without `--token`, prints how to create one and harvests the `manage.fastly.com` session token. |
| `fastly auth status` | `--json` | Masked token, source (`api-token` / `browser-session`), name, scope, expiry, live validity. |
| `fastly auth logout` | — | Clears the locally stored token. Does not revoke it at Fastly. |
| `fastly whoami` | `--json` | `GET /current_user` + `GET /tokens/self`: login, name, role, user id, customer id, 2FA, token scope and expiry. |

`fastly login` / `fastly logout` are accepted as aliases of the `auth` forms.
`fastly auth token` is intentionally **not** implemented: it would print a live
credential to stdout.

## Services

| Command | Flags |
|---|---|
| `fastly service list` | `--page N`, `--per-page N`, `--sort <field>`, `--direction ascend\|descend` |
| `fastly service describe [<id>]` | `--service-id`, `--service-name` |
| `fastly service search` | `--name <exact name>` (required) |
| `fastly service version list` | `--service-id` / `--service-name` |
| `fastly service domain list` | `--service-id`, `--version active\|latest\|staged\|N` |
| `fastly service purge` | `--all`, `--url <url>`, `--key <surrogate-key>`, `--file <path>`, `--soft`, `--confirm` |

`service describe` accepts the id positionally as well as via `--service-id`.
`--version` defaults to `active` (upstream requires it explicitly); `active`
costs one small request, while `latest` and `staged` must pull the whole version
list, which is large on services with thousands of versions.

`service purge` requires exactly one of `--all` / `--url` / `--key` / `--file`,
and without `--confirm` prints the target and the exact request it would make.
`--file` takes a newline-delimited list of surrogate keys (blank lines ignored)
and submits them in one batch. `--soft` adds `Fastly-Soft-Purge: 1`, which marks
objects stale instead of evicting them.

## Domains

| Command | Flags |
|---|---|
| `fastly domain list` | `--service-id`, `--fqdn <partial>`, `--limit N`, `--cursor <c>`, `--sort <field>` |
| `fastly domain describe <domain-id>` | — |

`fastly domain list` is the account-wide **Domain Management v1** API
(`/domains/v1`), which is a different resource from the version-scoped domains on
a service. Passing `--version` routes the call to `fastly service domain list`
instead, so both spellings work. `--fqdn` is a fuzzy/partial match. When
`meta.next_cursor` is present the summary prints the `--cursor` value to pass for
the next page. Note that domains registered through Domain Management can have
`service_id: null`, in which case `--service-id` legitimately returns nothing.

## Stats

| Command | Flags |
|---|---|
| `fastly stats [historical]` | `--service-id`, `--from`, `--to`, `--by minute\|hour\|day`, `--region`, `--field <name>` |
| `fastly stats aggregate` | `--from`, `--to`, `--by`, `--region` |
| `fastly stats usage` | `--from`, `--to` |
| `fastly stats regions` | — |

`--by` defaults to `day`. Omitting `--from`/`--to` lets the API pick its own
window (about the last month); the resolved range is echoed in the header from
`meta.from` / `meta.to`. `--from` accepts anything the historical-stats endpoint
accepts, including relative forms.

- **With `--service-id`** the call is per-service and the rows are time periods.
- **Without it** the call is account-wide and the rows are services, ranked by
  requests (top 20 shown; `--json` for all).
- `stats aggregate` is the account-level rollup, not the per-service list.
- `--field requests` (or `bandwidth`, …) narrows the output to one metric.
- `realtime`, `domain-inspector` and `origin-inspector` are not wrapped — reach
  them with `fastly api` (realtime lives on `rt.fastly.com`, which is
  allow-listed).

## Platform

| Command | Notes |
|---|---|
| `fastly pops` | `GET /datacenters`, grouped by `group` and sorted by POP code. |
| `fastly ip-list` | `GET /public-ip-list`: IPv4 and IPv6 ranges. |
| `fastly version` | Skill version, API base, auth state. This is a SLICC reimplementation, not the Go binary, so there is no Go build info to report. |

## Raw API passthrough

```bash
fastly api /current_user
fastly api GET /service/<id>/version/67/vcl
fastly api /tls/configurations
fastly api POST /service/<id>/version/67/clone
fastly api PUT /service/<id>/version/67/domain/<name> --data '{"comment":"updated"}'
```

`<path-or-url>` may be a bare path (prefixed with `https://api.fastly.com`) or a
full URL. Only `api.fastly.com` and `rt.fastly.com` are accepted; anything else
is refused before the token is attached. `--data` is parsed as JSON when
possible and sent verbatim otherwise. This is the intended route for the 25-odd
upstream command groups this subset does not wrap: `apisecurity`, `compute`,
`config-store`, `dashboard`, `dns`, `kv-store`, `log-tail`, `ngwaf`,
`object-storage`, `products`, `secret-store`, `tls-*`, `user`, and the
`service acl` / `backend` / `dictionary` / `healthcheck` / `logging` / `vcl`
subtrees.

## `fastly-ext billing`

| Command | Flags |
|---|---|
| `fastly-ext billing invoices` | `--limit N` (default 12), `--json` |
| `fastly-ext billing invoice <INV-id\|month-to-date>` | `--json` |
| `fastly-ext billing mtd` | `--json` |
| `fastly-ext billing forecast` | `--window N` (backtest months, default 12), `--json` |
| `fastly-ext billing summary` | `--year YYYY`, `--json` |

`--limit` and `--window` must be 1 or greater; a non-positive value is rejected
rather than quietly falling back to a page of data (`slice(-0)` in particular
would otherwise widen the backtest to the entire invoice history).

`invoices` and `summary` paginate with the API's cursor automatically.
`summary` without `--year` shows per-month detail for the current calendar year
plus annual sums for the whole history; unpaid invoices
(`payment_status != "paid"`) are always listed separately, since that is the
operationally important part. Invoice ids are not all `INV-`-prefixed — invoices
before roughly 2025 use bare numeric statement numbers, and both forms work as
the `<id>` argument.

See [`billing-api.md`](billing-api.md) for endpoint shapes and the forecast
model.
