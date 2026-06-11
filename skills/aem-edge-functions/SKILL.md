---
name: aem-edge-functions
description: |
  Use this when the user wants to list or purge AEM Edge Functions deployed on
  the Adobe Managed CDN for an AEM Cloud Service / Edge Delivery site. Trigger
  on requests like "list deployed edge functions", "show edge functions for
  program N", "purge the edge-function cache", or "mint an aem.cdn token".
  Uses the `aem-edge-functions` command with ADC OAuth Server-to-Server
  credentials and the CDN compute API served from the delivery domain.
allowed-tools: bash
---

# AEM Edge Functions (Managed CDN)

List and purge Edge Functions deployed on the Adobe Managed CDN. The companion
`aem-edge-functions` command mints scoped ADC tokens and calls the CDN compute
API directly.

## Workflow

1. Confirm the target:
   - Edge Delivery site: use `--site <delivery-domain>`.
   - Classic AEMaaCS environment: use `--program <id> --env <id>`; add
     `--stage` for the `-cmstg` host.
2. Confirm credentials include the `aem.cdn` scope. Prefer `--tab` from an open
   ADC OAuth Server-to-Server credential page, or pass `--client-id` and
   `--client-secret`.
3. List functions and verify the expected service name appears:
   ```bash
   aem-edge-functions list --site my.site.com --tab
   ```
4. If a purge is requested, rerun with the exact service name and one purge mode:
   ```bash
   aem-edge-functions purge --site my.site.com --service wknd-compute --all --tab
   aem-edge-functions purge --site my.site.com --service wknd-compute --surrogate-key key1 --soft --tab
   ```
5. Validate success by checking the command exits 0. For machine-readable output,
   add `--json`.

## Common Commands

```bash
# Edge Delivery site, credentials from an open ADC console tab
aem-edge-functions list --site phornig-wknd.testaemcloud.com --tab

# Explicit OAuth Server-to-Server credentials
aem-edge-functions list --site my.site.com \
  --client-id <id> --client-secret <secret> \
  --scopes openid,AdobeID,aem.cdn,additional_info.projectedProductContext

# Classic AEMaaCS environment instead of an EDS site
aem-edge-functions list --program 166706 --env 12345

# Mint a token for other tooling
aem-edge-functions token --site my.site.com --tab
```

## Targets

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

## Credentials

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

Use `references/api-auth.md` for IMS token and API contract details.

## Commands

| Command | Purpose |
|---------|---------|
| `aem-edge-functions list` | List deployed edge functions (table or `--json`) |
| `aem-edge-functions purge --service <name> --all` | Purge all cached content for one function |
| `aem-edge-functions purge --service <name> --surrogate-key <k>` | Purge by surrogate key (repeatable; add `--soft` for soft purge) |
| `aem-edge-functions token` | Mint and print a scoped CDN access token (use with other tooling) |

All commands accept the same target + credential flags. Add `--json` for raw output.

### Purge Modes

`purge` POSTs to `/edgeFunctions/<name>/purge`. Exactly one mode is required:

- `--all` → `{ "all": true }`
- `--surrogate-key <k>` (repeatable) → `{ "surrogateKey": "k" }` or `{ "surrogateKeys": [...] }`
- `--soft` adds `{ "soft": true }`

## Common errors

- **`401 Insufficient scopes`** — token lacks `aem.cdn`. You used a generic IMS
  token instead of an ADC S2S credential. Mint with the right scopes.
- **`client secret not visible on the ADC tab`** — on the OAuth S2S credential
  page, click "Retrieve client secret" before running with `--tab`.
- **Empty `items`** — no edge functions deployed, or the config pipeline hasn't
  run a successful deploy yet.

## References

- `references/api-auth.md` — token minting, endpoint details, purge body shape.
- `references/config-pipeline.md` — fallback cross-check from Managed CDN config.
