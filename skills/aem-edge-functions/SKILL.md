---
name: aem-edge-functions
description: |
  Use this when the user wants to list, inspect, or purge AEM Edge Functions
  deployed on the Adobe Managed CDN for an AEM Cloud Service / Edge Delivery
  site — e.g. "list all deployed edge functions", "show edge functions for
  program N", "purge the edge-function cache". Covers the experimental CDN
  compute API (served off the site domain), ADC OAuth Server-to-Server token
  minting, and the `aem-edge-functions` companion command. Mirrors
  @adobe/aio-cli-plugin-aem-edge-functions without needing the aio CLI.
allowed-tools: bash
---

# AEM Edge Functions (Managed CDN)

List / inspect / purge Edge Functions deployed on the Adobe Managed CDN, the same
operations the `aio aem edge-functions` plugin performs — but without the CLI.
Ships an `aem-edge-functions` command (`.jsh`) that handles auth and the API call.

## TL;DR

```bash
# Edge Delivery site, credentials from an open ADC console tab:
aem-edge-functions list --site phornig-wknd.testaemcloud.com --tab

# With explicit OAuth Server-to-Server credentials:
aem-edge-functions list --site my.site.com \
  --client-id <id> --client-secret <secret> \
  --scopes openid,AdobeID,aem.cdn,additional_info.projectedProductContext

# Classic AEMaaCS environment instead of an EDS site:
aem-edge-functions list --program 166706 --env 12345
```

## How it works

The CDN compute API is served **directly off the delivery domain**, not via
`cloudmanager.adobe.io`. The base path is:

| Target | Base URL |
|--------|----------|
| Edge Delivery site | `https://<site-domain>/adobe/experimental/compute-expires-20251231/cdn` |
| Classic AEMaaCS env | `https://author-p<program>-e<env>[-cmstg].adobeaemcloud.com/adobe/experimental/compute-expires-20251231/cdn` |

The list endpoint is `GET {base}/edgeFunctions`, sending only
`Authorization: Bearer <token>` + `accept: application/json`. Response shape:

```json
{ "items": [ { "edgeFunctionName": "...", "createdAt": "...", "updatedAt": "...", "activePackageId": "..." } ] }
```

`--stage` switches to the `-cmstg` Cloud Manager stage domain (classic env only).

## Auth — this is the part that bites

The API gates on the **`aem.cdn` scope**. A generic IMS token (e.g. the
Experience Cloud `exc_app` shell token) authenticates but returns
`401 {"error":"Insufficient scopes"}`. You need a token minted from an
**ADC OAuth Server-to-Server credential** whose scopes include `aem.cdn`.

The command mints that token via IMS (`POST ims-na1.adobelogin.com/ims/token/v3`,
`grant_type=client_credentials`) — exactly as the plugin's
`exchangeOAuthForToken` does. Set up the credential in the Adobe Developer
Console by adding the **AEM Content Delivery Network (CDN) API** to a project
with an OAuth Server-to-Server credential.

### Credential resolution order (first match wins)

1. `--token <jwt>` or `AEM_EDGE_FUNCTIONS_TOKEN` — use verbatim.
2. `--client-id` + `--client-secret` (+ `--scopes`), or the env vars
   `AEM_EDGE_FUNCTIONS_ADC_CLIENT_ID` / `_SECRET` / `_SCOPES` — mint via IMS.
3. `--adc-config <file.json>` — an ADC project JSON or credentials-only JSON
   (auto-detects `{project:…}` vs `{CLIENT_ID,…}`).
4. `--tab` — read the OAuth S2S credential (client ID, secret, scopes) from an
   **open `developer.adobe.com` console tab**. The credential page must show the
   secret (click "Retrieve client secret" first).

Default scopes if none supplied:
`openid,AdobeID,aem.cdn,additional_info.projectedProductContext`.

## Commands

| Command | Purpose |
|---------|---------|
| `aem-edge-functions list` | List deployed edge functions (table or `--json`) |
| `aem-edge-functions purge --service <name> --all` | Purge all cached content for one function |
| `aem-edge-functions purge --service <name> --surrogate-key <k>` | Purge by surrogate key (repeatable; add `--soft` for soft purge) |
| `aem-edge-functions token` | Mint and print a scoped CDN access token (use with other tooling) |

All commands accept the same target + credential flags. Add `--json` for raw output.

### Purge body contract

`purge` POSTs a JSON body to `/edgeFunctions/<name>/purge` (a bodyless POST returns
`400 Invalid JSON body`). Exactly one mode is required:

- `--all` → `{ "all": true }`
- `--surrogate-key <k>` (repeatable) → `{ "surrogateKey": "k" }` or `{ "surrogateKeys": [...] }`
- `--soft` adds `{ "soft": true }` (retain stale entries for revalidation; default is a hard purge)

## Cross-checking against the config pipeline

The deployed set is also determinable from the **Managed CDN config pipeline**
(type `CONFIG` in Cloud Manager), which builds `/config` from the customer repo.
`config/compute.yaml` declares the Edge Compute services and `config/cdn.yaml`
wires CDN routing (`selectAemOrigin` → `edgefunction-<name>`). If the live API is
unavailable, fetch those two files from the repo's deploy branch to enumerate the
functions. The live API is authoritative for `activePackageId` and timestamps.

## Common errors

- **`401 Insufficient scopes`** — token lacks `aem.cdn`. You used a generic IMS
  token instead of an ADC S2S credential. Mint with the right scopes.
- **`Failed to fetch` from a browser eval** — CORS. The CDN API is not callable
  cross-origin from `experience.adobe.com`; the `.jsh` calls it server-side via
  the proxied `fetch`, which has no CORS restriction. Don't route it through a
  page eval.
- **`client secret not visible on the ADC tab`** — on the OAuth S2S credential
  page, click "Retrieve client secret" before running with `--tab`.
- **Empty `items`** — no edge functions deployed, or the config pipeline hasn't
  run a successful deploy yet.
