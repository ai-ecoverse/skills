---
name: cloudflare
description: >-
  Manage and query Cloudflare with `cf`, Cloudflare's own agentic CLI that
  mirrors the entire Cloudflare API (3,000+ operations: zones, DNS records,
  cache purge, WAF and rulesets, Workers, KV, D1, R2, Queues, Access and Zero
  Trust, API tokens, accounts and members, analytics), with JSON output by
  default and `cf cli search` to find the right command. Covers building cf
  for SLICC, logging in with the OAuth device flow, and moving to a vault-sealed
  API token through fnox so no Cloudflare credential sits on disk. Also
  `cf-ext billing` for what the API cannot reach: invoice history, invoice
  PDFs, per-month and per-year spend, contract numbers and Workers
  excess-usage overage, from a logged-in `dash.cloudflare.com` tab. Use when
  the user mentions Cloudflare, cf, wrangler, zones, DNS on Cloudflare, purge
  the Cloudflare cache, Cloudflare API token, Workers, R2, D1, KV, WAF rules,
  "cloudflare traffic", "list my Cloudflare zones", "cloudflare invoice",
  "cloudflare bill", "how much are we spending on Cloudflare", "Workers
  overage" or "cloudflare contract". Not Fastly, not AWS CloudFront, not Akamai.
allowed-tools: bash
---

# Cloudflare: `cf` for the API, `cf-ext billing` for invoices

- **`cf`** is Cloudflare's CLI ([cloudflare/cf](https://github.com/cloudflare/cf),
  [launch post](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)). Its
  commands are generated from the OpenAPI schema, so it covers the whole API.
  It prints JSON by default and replaces Wrangler for anything that isn't an
  existing Wrangler project.
- **`cf-ext billing`** reads invoices, spend and contract numbers from a logged-in
  `dash.cloudflare.com` tab. The public API has no invoices (`cf billing` covers
  profiles, rate plans, spend policies and usage only), so this is the one place
  in the skill that needs a browser tab.

## Find the command, don't guess it

```bash
cf cli search "purge cache by url"     # natural-language search over every operation
cf dns records --help                  # flags of a group or command
cf schema dns records list             # the exact API request a command sends
cf zones list --dry-run                # show the request without sending it
```

`cf` command names differ from Wrangler's: search rather than recall.

## Output

JSON goes to **stdout**; paging info (`result_info: {...}`) goes to **stderr**.
Lists are paged at 20.

```bash
cf zones list 2>/dev/null | jq -r '.[] | "\(.name)\t\(.status)\t\(.account.name)"'
cf zones list --name aem.live 2>/dev/null | jq -r '.[0].id'
cf auth whoami | jq '{authenticated, authSource, email, accounts: [.accounts[].name]}'
```

## 1. Install cf (build from source)

`pnpm add -g cf` installs, but the published bundle doesn't run on slicc-jsh yet:

- [ai-ecoverse/slicc-jsh#1269](https://github.com/ai-ecoverse/slicc-jsh/issues/1269):
  minified `for (let e of …)` and `(...e)` bindings resolve to a same-named
  import, so `cf` crashes on load (`reading 'toUpperCase'`).
- [ai-ecoverse/slicc-jsh#1270](https://github.com/ai-ecoverse/slicc-jsh/issues/1270):
  undici's `fetch` over https exits the process mid-body (exit 13, "unsettled
  top-level await"), which kills `cf auth login` in its poll loop.

[`assets/cf-slicc/build.sh`](assets/cf-slicc/build.sh) builds it from source. It
clones `cloudflare/cf` to `~/src/cf`, installs its dependencies (about 5 minutes),
and bundles it with `@ai-ecoverse/wasi-esbuild`. That bundle avoids the first
bug. It also aliases `undici` to
[`undici-shim.mjs`](assets/cf-slicc/undici-shim.mjs), which avoids the second:
cf's dependencies only take `fetch`, `Headers`, `Response` and `FormData` from
undici, and the shim hands those to the runtime's global `fetch`.

```bash
sh <skill>/assets/cf-slicc/build.sh      # asks for sudo once; rerun after `git -C ~/src/cf pull`
cf --version
```

The script installs a root-owned copy in `/usr/local/lib/cf-slicc` and a `cf`
wrapper in `/usr/local/bin`. It has to be root-owned because the vault grant in
step 3 names that path, and the vault refuses programs a non-root user could
change. Once both issues are fixed, `pnpm add -g cf` should be enough, but the
vault grant still needs a root-owned path.

## 2. Log in (OAuth device flow)

```bash
cf auth login --no-browser --no-use-keyring
```

It prints `https://dash.cloudflare.com/oauth2/device/verify` and a code. The user
approves it in their browser within 5 minutes. Run it in the background and show
the user the code, because the command blocks until approval. The OAuth token and
refresh token are then stored in plain text in
`~/.config/cloudflare/config/default.json`, since SLICC has no OS keychain. That
file is why step 3 exists.

## 3. Move to a vault-sealed token (no secret on disk)

[`assets/cf-slicc/seal-token.sh`](assets/cf-slicc/seal-token.sh) uses the
logged-in `cf` to do five things:

1. Mint a **read-only** user token: every `… Read` permission group across
   every account, zone and the user, expiring in 90 days (`--days N`).
2. Pipe the token value straight from `cf user tokens create` into
   `sudo fnox set CLOUDFLARE_API_TOKEN --global`. It is never printed or written
   to a file.
3. Add an `[exec]` grant to `/etc/slicc/secrets-policy.toml`, so the vault hands
   the real value only to this exact argv:

   ```toml
   [exec]
   CLOUDFLARE_API_TOKEN = { argv = [["/usr/bin/node", "/usr/local/lib/cf-slicc/bin/cf"]] }
   ```
4. Run `cf auth logout`, which deletes the on-disk OAuth tokens.
5. Check the result with `cf auth whoami`.

```bash
sh <skill>/assets/cf-slicc/seal-token.sh --dry-run   # shows the token request and the grant
sh <skill>/assets/cf-slicc/seal-token.sh             # sudo approvals: fnox set, policy edit
```

From then on the `cf` wrapper runs `fnox exec -- /usr/bin/node
/usr/local/lib/cf-slicc/bin/cf …`. Any other program, curl and `node -e`
included, gets only the placeholder: fnox prints `CLOUDFLARE_API_TOKEN keeps its
placeholder: seven's policy does not hand it to this command`.

For write access, mint a second token with the narrowest permission groups the
task needs (`cf user tokens permission-groups list`), and seal it under its own
name with its own grant. Don't widen the read-only one.

### Why `[exec]` and not a `[[proxy.rules]]` header rule

A header rule in `/etc/fnox/config.toml`
(`domain = "api.cloudflare.com"`, `header = "authorization"`) would keep the
token out of every program. But when `api.cloudflare.com` is routed through a
**linked device**, the vault refuses it with
`refused (exit-link): this host goes through a linked device, which carries no
credentialed request yet`, and curl gets 403. The header rule works only after
the user sends that host through this computer under **Settings › Network**.
`[exec]` works on either route. The trade-off is that the cf process holds the
real token in its environment, while its output is still scrubbed back to the
placeholder before the model sees it.

### Gotchas

- **The vault hands out a token at most 10 times a minute by default.** Each
  `cf` call takes one hand-out, so a loop of 11 calls fails with
  `materialize: EAGAIN: materialize limit for CLOUDFLARE_API_TOKEN (10/min)`. Use
  one call with a bigger `--per-page`, sleep between calls, or have the user raise
  `[limits] materialize_per_minute` in `/etc/slicc/secrets-policy.toml`.
- **`#!/usr/bin/env node` is refused** as an `[exec]` program, because `env` is a
  wrapper. That's why the grant names `/usr/bin/node` and the script path.
- **`export CLOUDFLARE_API_TOKEN=fnox_proxy_…` doesn't stick** in an agent shell,
  because the placeholder is scrubbed from the command. The wrapper doesn't need it.
- **When the token expires**, cf answers 401. Run `cf auth login` and
  `seal-token.sh` again. `fnox set` keeps the same placeholder, so nothing else
  changes. Then revoke the old token with `cf user tokens delete <id>`.

## Not verified on SLICC

- `cf deploy`, `cf init`, `cf migrate` and any write operation (the sealed token
  is read-only).
- `cf dev` and `--local` need workerd (miniflare) and are not expected to run in
  the browser.
- Zone traffic analytics: `cf sql query` needs schema-qualified dataset names
  (`events.…`, `logs.…`, `states.…`) that weren't found yet. The GraphQL
  Analytics API (`/client/v4/graphql`) has no `cf` command.

## `cf-ext billing`: invoices, spend, contracts

```bash
cf-ext billing contracts --year 2026        # ← start here on a shared account
cf-ext billing invoices --limit 10          # newest first, with the uuid for `pdf`
cf-ext billing summary --year 2026          # per-month + per-year totals, unpaid list
cf-ext billing pdf IN706358 --out ./inv.pdf # verifies the %PDF magic bytes
cf-ext billing lineitems IN706358           # contract #, order type, service period
cf-ext billing usage IN702618               # excess-usage cap vs actual, per metric
cf-ext billing subscriptions                # products (price is 0 on enterprise)
```

It needs a `dash.cloudflare.com` tab that is open and signed in
(`playwright-cli tab-new https://dash.cloudflare.com`, then the user signs in),
and account billing access. Its calls are same-origin from that tab. No API token
scope reaches `/billing/history`, so the sealed token doesn't help here.

Flags: `--year YYYY`, `--limit N`, `--pdf-limit N`, `--no-pdf`, `--out PATH`,
`--account <32-hex>`, `--tab <id>`, `--json`, `--fixture <file>` (replay a saved
`billing/history` dump offline). Every command takes either the `receipt_id`
(`IN706358`) or the 36-character record uuid.

- `invoices` lists **credits separately**. Credits have `type: "credit"` and
  negative amounts, so a blind sum nets them against spend.
- `summary` names every invoice not marked paid, with the reason per row.
- `lineitems` and `usage` read the PDF, which is where contract numbers and
  excess-usage caps live.

### Contract attribution: read before quoting a spend figure

On a shared enterprise account, one Cloudflare account serves many teams, and
`billing/history` mixes the parent org's renewals with yours. The **contract
number** (`IC-######`) on each invoice PDF is the only reliable way to tell them
apart. On one real account the 2026 year-to-date total was **$3,146,348.73**,
while the responsible team's share was **~$159k–421k**. `billing contracts`
groups invoices by contract number and flags excess-usage invoices as your own
metered overage. Attribute each contract number to its owner before publishing a
total. Worked example: [references/BILLING.md](references/BILLING.md).

### Billing limitations

- **`per_page` on `billing/history` is silently capped at 50.** Paginate on
  `result_info.next_page`.
- **`status: OPEN` doesn't mean unpaid.** Enterprise invoices stay `OPEN` with
  `amount_remaining: 0` long after they're paid.
- **Invoice PDFs use CID-encoded fonts.** `pdftk dump_data_utf8` reads them, with
  a fallback to `pdftotext -layout` over `ssh`; see
  [references/pdf-extraction.md](references/pdf-extraction.md).

## Don't

- Don't fall back to Wrangler (`npx wrangler`) when a `cf` command fails in a
  project without a `wrangler.toml`/`wrangler.json(c)`. Report the failure.
- Don't put a Cloudflare token in a file, in `~/.profile` or in the chat. Seal it
  (step 3), or ask with `fnox set NAME --ask` if the user wants to paste one.
- Don't drop `?doctype=invoice&isLegacy=false` from the invoice PDF URL (400, code 1196).
