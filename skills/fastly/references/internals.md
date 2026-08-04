# Maintainer notes

Two scripts, one shared credential:

- `scripts/fastly.jsh` → the `fastly` command. Mirrors the upstream CLI surface.
- `scripts/fastly-ext.jsh` → the `fastly-ext` command. Billing only.

`fastly-ext` issues **every** HTTP call by shelling out to `fastly api <path>`
and parsing stdout. That is deliberate: token resolution, host allow-listing,
401 re-harvest and error formatting exist in exactly one place. The wrapper
strips the child's ANSI colouring and its `fastly:` prefix before re-emitting an
error so messages are not double-labelled.

## Endpoint map

| Command | Endpoint |
|---|---|
| `whoami` | `GET /current_user`, `GET /tokens/self` |
| `auth login` / `auth status` | `GET /tokens/self` (validation only) |
| `service list` | `GET /service?page&per_page&sort&direction` |
| `service describe` | `GET /service/{id}/details` |
| `service search` | `GET /service/search?name=` |
| `service version list` | `GET /service/{id}/version` |
| `service domain list` | `GET /service/{id}/version/{v}/domain` (+ `/version/active` to resolve `active`) |
| `service purge --all` | `POST /service/{id}/purge_all` |
| `service purge --key` | `POST /service/{id}/purge/{key}` |
| `service purge --file` | `POST /service/{id}/purge` with `{ surrogate_keys: [...] }` |
| `service purge --url` | `POST /purge/{host}{path}` |
| `domain list` / `describe` | `GET /domains/v1`, `GET /domains/v1/{id}` |
| `stats` (service) | `GET /stats/service/{id}` or `/stats/service/{id}/field/{f}` |
| `stats` (account) | `GET /stats` or `/stats/field/{f}` — response is a map keyed by service id |
| `stats aggregate` | `GET /stats/aggregate` — response is an array of periods |
| `stats usage` / `regions` | `GET /stats/usage`, `GET /stats/regions` |
| `pops` / `ip-list` | `GET /datacenters`, `GET /public-ip-list` |
| `fastly-ext billing *` | `GET /billing/v3/invoices[...]` — see [`billing-api.md`](billing-api.md) |

Auth header is `Fastly-Key: <token>` (`Fastly-Token` also works) plus
`Accept: application/json`.

## Token handling

Resolution order: `--token` flag → stored config → one-shot browser harvest.

The `manage.fastly.com` SPA keeps a real `global`-scope API token in
`sessionStorage` under `fastly-auth__session__active-token`:

```json
{ "customerId": "…", "createdAt": "…", "id": "…", "accessToken": "<32 chars>",
  "userId": "…", "name": "…", "expiresAt": "…", "saml": … }
```

`GET /tokens/self` on it reports `name: "manage.fastly.com browser session"`,
`scope: "global"`, and `expires_at` about 12 hours after login. Two traps:

- **`browser.eval` opportunistically JSON-parses page results**, so the
  `sessionStorage.getItem` string can arrive already parsed as an object. The
  harvester accepts both.
- **CORS blocks calling `api.fastly.com` from inside the page context**
  (`TypeError: Failed to fetch`). Harvest the token and call the API from the
  shell. Also note `manage.fastly.com/<anything>` returns the SPA's index.html
  with HTTP 200 — that is not an API response.

Tokens are persisted with `skill.config()` into `scripts/.config`, which must
never be committed. Nothing prints a token: `auth status` and `whoami` show only
the last four characters, and `whoami --json` returns `/tokens/self` metadata,
which does not include the secret.

## Host allow-list

Only `api.fastly.com` and `rt.fastly.com` (realtime stats) ever receive the
token. `resolveUrl()` enforces this for the built-in commands *and* the raw
`fastly api` passthrough, so `fastly api https://attacker.example/` is refused
before any header is attached. URL purges use the `POST /purge/{host}{path}` API
form rather than sending `Fastly-Key` to an arbitrary edge host, for the same
reason.

## Status codes worth special-casing

- **401** — the credential is bad. If the stored token came from the browser
  session, re-harvest once and retry, then fail with a re-login hint.
- **403** — Fastly returns 403, not 404, for resources outside your customer
  account. `fastly stats --service-id doesnotexist` therefore 403s. The message
  says "check the id / token scope", *not* "log in again", which would send the
  user down the wrong path.
- **404** — real "not found"; Fastly's body is `{"msg","detail"}` for most
  endpoints and `{"title","status"}` under `/billing/v3`. The error formatter
  handles `msg`, `title`, `detail` and a JSON:API-style `errors[]` array.

## Payload sizes

- `GET /service` embeds every version of every service: ~4.8 MB for 26 services.
  `--per-page` is honoured and is the cheap way to page.
- `GET /service/{id}/details` is ~1.4 MB for a service with 5,000 versions.
- `GET /stats?by=day` is ~2.2 MB for 33 days; `/stats/aggregate` over ~2.5 years
  is ~5.4 MB. Both are summarised unless `--json` is passed.

## Runtime constraints this code works around

- `skill.config()` returns a **Promise**; it must be awaited *before* any `|| {}`
  fallback, or the fallback never fires and property reads throw.
- `parseFlags()` hands single-dash short flags and value-less long flags over as
  boolean `true`. Every flag read goes through `str()` / `num()` so `true` can
  never leak into a URL, a header or the stored config.
- Second-level subcommands are routed manually from `positional[0]` /
  `positional[1]`; `parseFlags().subcommand` only populates the first positional.
- `cli.die` throws a `NodeExitError`, which the top-level `catch` must re-throw.

## Upstream reference

Command and flag names come from
<https://www.fastly.com/documentation/reference/cli/>. Append `.md` to any docs
URL for a clean markdown version, e.g.
<https://www.fastly.com/documentation/reference/cli/service/purge.md>. Source of
truth for the CLI itself: <https://github.com/fastly/cli>.

Upstream has **32 command groups** and none of them is `billing` — that is the
whole reason `fastly-ext` exists. Note also that purging is `fastly service
purge` upstream, not a top-level `fastly purge`.
