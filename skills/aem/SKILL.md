---
name: aem
description: AEM Edge Delivery Services (EDS) skill for reading, writing, previewing, and publishing EDS pages via the `aem` CLI. Use when the user asks about AEM Edge Delivery Services, EDS pages, Franklin, Helix, AEM EDS, edge delivery content, document-based authoring, or needs to list, get, put, preview, publish, or upload content in AEM EDS. Supports the full get→edit→put→preview→publish pipeline, on both Helix 5 (admin.hlx.page, admin.da.live) and Helix 6 (api.aem.live Source Bus) sites. Also provides `aem-ext` for long-lived authentication: minting, listing, registering and revoking AEM admin API keys (365-day, `X-Auth-Token`) so long content jobs survive the ~20-minute Adobe IMS token expiry. Use `aem-ext` when the user mentions API keys, admin keys, apiKeys, token expiry, "authentication keeps expiring", 401 from AEM, `access.admin.apiKeyId`, or wants a non-interactive/long-running AEM job.
allowed-tools: bash
---

# AEM (Edge Delivery Services)

Shell command for AEM Edge Delivery Services. Manages EDS page content.

## Authentication

Two commands, two credential styles:

- `aem` — Adobe IMS user token only. Run `oauth-token adobe` (auto-triggered on first
  use). No manual configuration needed. **In practice that token stops working after
  ~20 minutes**, which breaks long content jobs.
- `aem-ext` — the same content verbs plus AEM **admin API keys**, which last up to
  **365 days**. Use it for long or unattended jobs. See
  [Long-lived API keys (`aem-ext`)](#long-lived-api-keys-aem-ext) and
  `references/api-keys.md`.

### The header rule (verified live 2026-09-03)

The two credential types use different auth schemes and **do not cross over**:

| Credential | Header | Lifetime |
|---|---|---|
| Adobe IMS user token | `Authorization: Bearer <token>` | ~20 minutes in practice |
| Admin API key (a JWT) | `X-Auth-Token: <key>` (or `Authorization: token <key>`) | up to 365 days |
| `auth login` cookie | `Cookie: auth_token=<value>` | session (curl paths only — see note) |

Sending `Bearer <api-key>` returns 401, and so does `X-Auth-Token: <ims-token>`. An API
key sent with the wrong scheme looks exactly like an expired credential.

### Credential resolution order (`aem-ext`)

1. `--api-key <value>`, or the `AEM_API_KEY` environment variable
2. the `aem.apikey` secret (or `--secret-name <name>`), via the `secret` command
3. an `auth_token` cookie stored by `aem-ext auth login` — **limited**: SLICC's `fetch()`
   silently strips `Cookie` headers, so this credential is refused with an actionable error
   on the JSON/API routes. Prefer a long-lived API key.
4. the Adobe IMS user token from `skill.token('adobe')`

`--ims` skips 1–3 and forces the IMS token. Minting, registering and revoking keys
always require the IMS token — an API key cannot write site config.

## Usage

```
aem <command> <eds-url-or-path> [options]
aem-ext <command> [<eds-url-or-path>] [options]     # same verbs + API-key auth
```

Run `aem-ext --help` for the full flag list.

All commands accept full EDS URLs: `https://main--repo--org.aem.page/path`
Or use `--org`/`--repo` flags with a plain path.

## Commands

- `aem list <url>` — List pages in a directory
- `aem get <url> [--output <vfs-path>]` — Get page HTML
- `aem put <url> <vfs-file>` — Write HTML from a VFS file
- `aem preview <url>` — Trigger AEM preview
- `aem publish <url>` — Trigger AEM publish
- `aem upload <vfs-file> <url>` — Upload a media file
- `aem help` — Show usage

`aem-ext` mirrors the content verbs on the new credential resolution and adds key
management:

- `aem-ext auth status [--org <o> --site <s>] [--json]` — which credential wins, its
  type, subject/roles/expiry, and whether it really has access to the site
- `aem-ext auth login [--idp google|microsoft|adobe] [--print-url]` — IDP login,
  harvesting the `auth_token` cookie (browser flow unverified; `--print-url` verified)
- `aem-ext auth key create --org <o> --site <s> [--roles admin] [--description <d>] [--expires-in <s>] [--register] [--save-secret [name]]` — mint a key
- `aem-ext auth key list --org <o> --site <s>` — keys with their registration state
- `aem-ext auth key register --org <o> --site <s> --id <jti>` — the Helix 6 registration step
- `aem-ext auth key delete --org <o> --site <s> --id <jti> --confirm` — revoke
- `aem-ext list|get|put|status|preview|publish` — content verbs on the resolved credential

## Architecture version: Helix 5 and Helix 6

Sites run on one of two API generations, and the CLI handles both.

| | Helix 5 | Helix 6 |
|---|---|---|
| Content (author source) | `https://admin.da.live/source/<org>/<site>/<path>` | `https://api.aem.live/<org>/sites/<site>/source/<path>` |
| Operations | `https://admin.hlx.page/<verb>/<org>/<site>/<ref>/<path>` | `https://api.aem.live/<org>/sites/<site>/<verb>/<path>` |
| `ref` in the path | yes | dropped where it never mattered |

Helix 6 is in early access. Which generation a site uses is detected per site and
cached for the run, so no flag is normally needed:

- `--hlx6` forces the Helix 6 API.
- `--hlx5` forces the Helix 5 API.
- `--api <host>` points at a different Helix 6 host and implies `--hlx6`.
- `--site <name>` is an alias for `--repo`, matching Helix 6 vocabulary.

Detection probes the Helix 6 source listing for the site. A Helix 5 site has no
such route and answers 404; a 401 or 403 is reported as an authentication
problem rather than swallowed as "not Helix 6".

### Why detection matters

**A site that has been upgraded to Helix 6 is no longer readable through
`admin.da.live`, and the old endpoint does not say so.** It answers 200 with
content from an unrelated project. Any code that assumes `admin.da.live` for
every site will read the wrong document without an error, and a write will land
in a store nobody is looking at. That is the failure this detection exists to
prevent, so avoid hardcoding either backend.

## The Source Bus (Helix 6 content)

On Helix 6 the author content lives behind `/<org>/sites/<site>/source/<path>`,
which the team calls the Source Bus. It is a plain HTTP resource:

- `GET .../source/<path>` returns the document HTML.
- `PUT .../source/<path>` with `Content-Type: text/html` and the file as the
  request body creates or overwrites it, answering **201** in both cases. No
  multipart wrapper is involved, unlike Helix 5.
- `GET .../source/<path>/` lists a folder. **The trailing slash is what makes
  it a listing**; without it the same path returns 404. Entries look like
  `{"name":"my-post.html","size":4595,"content-type":"text/html","last-modified":"..."}`,
  and folders like `{"name":"blog/","content-type":"application/folder"}`. The
  reported `size` has been observed to disagree with the byte length returned by
  `GET`, so treat it as informational.
- Everything requires `Authorization: Bearer <IMS access token>`; without one the
  answer is 401.

Keep request headers minimal. Adding headers such as `Cache-Control` triggers a
CORS preflight that the endpoint rejects.

The wider Helix 6 surface, from the architecture design notes, is
`/<org>/sites/<site>/` plus `status`, `preview`, `live`, `config`, `source`,
`snapshots`, `jobs`, `log`, with `/<org>/config`, `/<org>/profiles`,
`/<org>/sites` at organisation level and `/login`, `/logout`, `/profile`,
`/auth`, `/register`, `/discover` at the root.

### What is verified and what is not

`list`, `get`, `put` and `upload` were exercised by hand against a live Helix 6
site. The `preview` and `live` routes are taken from the design notes and have
not been verified, so on a site detected as Helix 6 those two commands stop and
ask for an explicit `--hlx6` rather than POSTing to a guessed route on a
production site. Binary media through the Source Bus uses the same raw `PUT` as
HTML and is untested, so `upload` reports the HTTP status it received instead of
claiming success.

**Update 2026-09-03:** Helix 6 `POST .../preview/<path>` and `GET .../status/<path>`
were verified live (200 with an admin API key), so `aem-ext` treats them as supported.
The `aem` command still requires the explicit `--hlx6` for `preview`/`publish`;
relaxing it for `preview` is a safe follow-up. Helix 6 `live` (publish) is still
unexercised.

## Long-lived API keys (`aem-ext`)

`aem-ext` exists because a 20-minute credential cannot carry a long content job. It is a
separate script; `aem` is unchanged.

```bash
# one-time: mint a 365-day key, enable it, and store it in the secrets manager
aem-ext auth key create --org myorg --site mysite --roles admin --register --save-secret

# from then on, every command resolves that key automatically
aem-ext auth status --org myorg --site mysite
aem-ext list /blog --org myorg --site mysite
aem-ext get /blog/my-post --org myorg --site mysite --output /shared/post.html
aem-ext put /blog/my-post --org myorg --site mysite /shared/post.html
aem-ext preview /blog/my-post --org myorg --site mysite
aem-ext publish /blog/my-post --org myorg --site mysite
```

Without `--save-secret` the key value is printed **once**, because the API returns it
exactly once and never again (`config.json` lists metadata only). Prefer
`--save-secret`, which keeps it out of the transcript; the secrets manager masks the
value locally and the fetch proxy unmasks it server-side, so `aem-ext` never needs to
see it.

### On Helix 6 a new key returns 401 until it is registered

<https://www.aem.live/docs/admin-apikeys> states that a new key is "automatically
enabled … There is no need to manually add the API Key ID to the
`access.admin.apiKeyId` property". **That is true on Helix 5 and false on Helix 6**
(verified live 2026-09-03): a freshly minted key returned 401 on every
`/<org>/sites/<site>/…` resource while `GET /profile` returned 200 for the same key —
a false positive that makes a dead key look healthy. That is why
`aem-ext auth status --org <o> --site <s>` probes `source/` rather than `/profile`.

Fix it with `--register` at create time, or afterwards:

```bash
aem-ext auth key register --org myorg --site mysite --id '<jti>'
```

Registration writes `access.admin.apiKeyId`, and **that POST is a whole-object
overwrite**: `aem-ext` always reads `config.json` first and merges, preserving the
existing `role` map (the site's admin/author email lists) and any other registered key
ids. Sending just `apiKeyId` would lock real people out. `aem-ext` reports the role map
before and after so the merge is visible.

### Other sharp edges

- **`--expires-in`**: the Helix 6 property API rejects `expiresIn` with 400
  (`must NOT have additional properties`). The Helix 5 create helper on
  `admin.hlx.page` still answers for migrated Helix 6 sites and does honour it, so
  `aem-ext` mints through that route when the flag is used and warns that it did.
  Without the flag every key lasts a year.
- **URL-safe jti**: a raw `jti` can contain `+` and `/`. The `apiKeys` object key and
  the DELETE path use `+`→`-`, `/`→`_`; `access.admin.apiKeyId` stores the raw form.
  `aem-ext` accepts either spelling.
- **Revoking is immediate**: `auth key delete` shows a preview and exits non-zero unless
  `--confirm` is passed, then also removes the id from `access.admin.apiKeyId`.
- Helix 6 `preview` and `status` are now verified with an API key (200 on both), so
  `aem-ext` does not gate them behind a flag the way `aem` still does.

Full endpoint/auth reference, including everything that was and was not verified:
`references/api-keys.md`.

## Typical Workflow

For editing a page, follow this sequence:

1. **Get** — Fetch the current page HTML:
   ```bash
   aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
   ```
2. **Edit** — Modify `/workspace/page.html` as needed.
3. **Put** — Write the updated HTML back. Verify the command exits successfully (exit code 0) before continuing:
   ```bash
   aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
   ```
4. **Preview** — Trigger a preview and confirm the response indicates success:
   ```bash
   aem preview https://main--myrepo--myorg.aem.page/page
   ```
5. **Verify** — Optionally re-fetch the page (`aem get`) or inspect the preview URL to confirm the changes appear correctly.
6. **Publish** — Once the preview looks correct, publish:
   ```bash
   aem publish https://main--myrepo--myorg.aem.page/page
   ```

**Error guidance:**
- If `aem put` fails, check that the VFS file path is correct and the file is valid HTML before retrying.
- If `aem preview` or `aem publish` fails, re-run the command — transient network issues are common. If it continues to fail, verify authentication with `oauth-token adobe`.
- Always confirm `aem put` succeeds before running `aem preview` to avoid publishing stale content.

## Examples

```bash
aem list https://main--myrepo--myorg.aem.page/
aem get https://main--myrepo--myorg.aem.page/products/overview
aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
aem preview https://main--myrepo--myorg.aem.page/page
aem publish https://main--myrepo--myorg.aem.page/page
aem upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png

# Helix 6 site: same commands, backend detected automatically
aem list https://main--aem-website--adobe.aem.page/blog
aem get https://main--aem-website--adobe.aem.page/blog/my-post --output /shared/post.html
aem put https://main--aem-website--adobe.aem.page/blog/my-post /shared/post.html

# Long-lived auth: mint once, then run for a year without re-authenticating
aem-ext auth key create --org myorg --site mysite --register --save-secret
aem-ext auth status --org myorg --site mysite
aem-ext auth key list --org myorg --site mysite --json
aem-ext put /blog/my-post --org myorg --site mysite /shared/post.html
aem-ext auth key delete --org myorg --site mysite --id '<jti>' --confirm

# Force a backend, or use Helix 6 vocabulary with plain paths
aem list /blog --org adobe --site aem-website --hlx6
aem get /blog/my-post --org myorg --repo myrepo --hlx5
```
