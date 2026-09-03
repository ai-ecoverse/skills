# AEM admin API keys — endpoint and auth reference

Durable record of an under-documented API. Everything marked **verified** was exercised
live on **2026-09-03** against org `ai-ecoverse`, site `slicc-website`, which runs
**Helix 6** (`api.aem.live`, OpenAPI 1.76.0). Where this file disagrees with
<https://www.aem.live/docs/admin-apikeys>, the doc is wrong for Helix 6 — see
[The registration gotcha](#the-registration-gotcha-helix-6).

Used by `skills/aem/scripts/aem-ext.jsh` (`aem-ext`). `aem.jsh` (`aem`) is unaffected
and still uses IMS tokens only.

## 1. Two credential types, and the header rule

| Credential | How to get it | Header to send | Lifetime |
|---|---|---|---|
| Adobe IMS user token | `oauth-token adobe`, `skill.token('adobe')` | `Authorization: Bearer <token>` | **~20 min** in practice |
| Admin API key (a JWT) | minted per site, see §2 | `X-Auth-Token: <key>` **or** `Authorization: token <key>` | up to 365 days |
| Login cookie | browser IDP login, §5 | `Cookie: auth_token=<value>` | session |

**The schemes do not cross over.** All four combinations verified against
`GET https://api.aem.live/ai-ecoverse/sites/slicc-website/source/`:

| Credential | Header | Result |
|---|---|---|
| IMS user token | `Authorization: Bearer` | **200** |
| IMS user token | `X-Auth-Token` | **401** |
| IMS user token | `Authorization: token` | **401** |
| API key | `X-Auth-Token` | **200** |
| API key | `Authorization: token` | **200** |
| API key | `Authorization: Bearer` | **401** (`x-error: [AWS] Unauthorized`) |

This is the single most important detail: an API key sent as a Bearer token looks
exactly like an expired credential.

A minted key decodes (it is an unsigned-payload-readable JWT) to:

```json
{ "iss": "https://admin.hlx.page/", "sub": "<org>/<site>", "email": "helix@adobe.com",
  "name": "Helix Admin", "roles": ["admin"], "jti": "...", "iat": 0, "exp": 0 }
```

An IMS access token is **not** a JWT (single opaque segment) — it cannot be decoded
locally; read `GET /profile` for its `ttl` instead.

## 2. Minting a key

### Helix 6 (verified)

```
POST https://api.aem.live/<org>/sites/<site>/config/apiKeys.json
  Authorization: Bearer <IMS token>          # an API key cannot mint keys
  Content-Type: application/json
  {"description":"...","roles":["admin"]}
```

- 200 response: `{id, subject, description, roles, created, expiration, value}`.
- **`value` is the key and is returned exactly once.** `config.json` afterwards lists
  metadata only — there is no way to re-read it. Capture it on the spot.
- **Omit `expiresIn`.** Sending it returns **400** with an empty body and
  `x-error: [admin] Error updating config: /apiKeys/<id> must NOT have additional properties`
  (verified). Omitting it still yields a 1-year key.
- The Helix 5 dedicated helper (`operationId: createSiteApiKey`) has no equivalent
  under `api.aem.live`; this is the site-config property API instead.

### Helix 5, and the compat route that gives Helix 6 a custom expiry (verified)

```
POST https://admin.hlx.page/config/<org>/sites/<site>/apiKeys.json
  {"description":"...","roles":["admin"],"expiresIn":86400}   # seconds, 1..31536000, default 31536000
```

Verified surprise: **this Helix 5 route still answers for a migrated Helix 6 site.**
`GET` and `POST` both returned 200, with `link: <https://api.aem.live/>; rel="successor-version"`.
`expiresIn: 86400` produced `expiration = created + 24h`, the key appeared in the same
Helix 6 `config.json`, and after registration (§3) it worked on `api.aem.live`. This is
the only way observed today to get a non-1-year key on Helix 6, and it is what
`aem-ext auth key create --expires-in` uses there.

Helix 5 also exposes org- and profile-scoped variants:
`/config/{org}/apiKeys.json`, `/config/{org}/profiles/{profile}/apiKeys.json`.

### Roles

Helix 6 enum: `author`, `publish`, `develop`, `basic_author`, `basic_publish`,
`config`, `config_admin`, `admin`. Helix 5 additionally allows `view`.
(Verified: a key created with `roles: ["author","publish"]` reported exactly those in
`GET /profile` and could read the Source Bus.)

## 3. The registration gotcha (Helix 6)

<https://www.aem.live/docs/admin-apikeys> says a new key is "automatically enabled …
There is no need to manually add the API Key ID to the `access.admin.apiKeyId`
property". **True on Helix 5, false on Helix 6.** Verified twice with fresh keys:

| Request with a brand-new key | Result |
|---|---|
| `GET https://api.aem.live/profile` | **200** — full profile, looks healthy |
| `GET https://api.aem.live/<org>/sites/<site>/source/` | **401** |

So `/profile` is a **false positive** and must not be used as a key-validity probe.
Probe a real site resource.

The fix — add the key's `jti` to `access.admin.apiKeyId`:

```
POST https://api.aem.live/<org>/sites/<site>/config/access.json
  Authorization: Bearer <IMS token>
  Content-Type: application/json
  {"admin":{"role":{...existing...},"requireAuth":"false","apiKeyId":["<jti>","<existing jti>"]}}
```

**This is a whole-object overwrite.** `GET https://api.aem.live/<org>/sites/<site>/config.json`
first, take `access.admin` verbatim, add to `apiKeyId`, and re-send the whole object.
Posting only `apiKeyId` wipes the `role` map — the admin/author email lists — and locks
real people out. Preserve existing `apiKeyId` entries too. After the POST the key
answers 200 on `source/` and `config.json` within a few seconds (verified: 401 → 200).

## 4. Key CRUD (Helix 6 form, all verified)

| Operation | Request | Result |
|---|---|---|
| List | `GET /<org>/sites/<site>/config.json` → `.apiKeys` | 200, metadata only, keyed by URL-safe jti |
| Create | `POST /<org>/sites/<site>/config/apiKeys.json` | 200 with `value` (once) |
| Delete | `DELETE /<org>/sites/<site>/config/apiKeys/<urlsafe-jti>.json` | **204** |
| Register | `POST /<org>/sites/<site>/config/access.json` | 200 (whole-object) |

Helix 5 equivalents: `GET|POST /config/{org}/sites/{site}/apiKeys.json`,
`GET|DELETE /config/{org}/sites/{site}/apiKeys/{id}.json`.

### URL-safe jti transform

A raw `jti` can contain `+` and `/` (e.g. `AbCd1E+FgHi7jkL5MnOpQrStUvWxYz8/9v` — a real one seen live had both characters).

- `apiKeys` **object keys** and the **DELETE path** use the URL-safe spelling: `+`→`-`, `/`→`_`.
  Verified: DELETE with the raw jti → **404**; with the transform → **204**.
- `access.admin.apiKeyId` stores the **raw** jti.
- Therefore membership checks must accept both spellings. Each entry's `.id` field is
  the raw form even when its object key is URL-safe.

## 5. Login and the `auth_token` cookie

`GET https://api.aem.live/login` returns **JSON, not HTML** (verified):

```json
{"links":{"login_google":"https://api.aem.live/auth/google",
          "login_google_sa":"https://api.aem.live/auth/google?selectAccount=true",
          "login_microsoft":"https://api.aem.live/auth/microsoft",
          "login_adobe":"https://api.aem.live/auth/adobe",
          "login_adobe-stage":"https://api.aem.live/auth/adobe-stg", "...": "..."}}
```

`_sa` variants append `?selectAccount=true`. After the IDP flow the browser is
redirected to `/profile` and receives a session-scoped `auth_token` cookie (OpenAPI
security scheme `AuthCookie`, `in: cookie`, `name: auth_token`). Helix 5 has the same
shape on `https://admin.hlx.page`. Harvesting that cookie programmatically
(`browser.ensureTab` + `browser.cookie(tab, 'auth_token')`) is implemented in
`aem-ext auth login` but **was not verified live** — only the `/login` JSON and the
link resolution (`--print-url`) were.

## 6. Endpoints used by `aem-ext` (Helix 6)

| Path | Notes |
|---|---|
| `GET /<org>/sites/<site>/source/<path>` | document bytes |
| `GET /<org>/sites/<site>/source/<dir>/` | **trailing slash required** — without it, 404 |
| `PUT /<org>/sites/<site>/source/<path>` | raw body, `Content-Type: text/html`, **201** on create *and* overwrite |
| `DELETE /<org>/sites/<site>/source/<path>` | 204 (verified) |
| `GET /<org>/sites/<site>/status/<path>` | 200 with an API key (verified) |
| `POST /<org>/sites/<site>/preview/<path>` | 200 with an API key (verified) |
| `DELETE /<org>/sites/<site>/preview/<path>` | 204 (verified) |
| `POST /<org>/sites/<site>/live/<path>` | same shape as `preview`; **not exercised here** |
| `GET /<org>/sites/<site>/config.json` | full site config incl. `access` and `apiKeys` |
| `GET /profile` | whoami; works with both credential types — **not a site-access probe** |

`aem.jsh`'s guard calling Helix 6 `preview`/`live` "unverified design intent" is
obsolete for `preview` and `status` as of 2026-09-03.

Helix 5 hosts: `https://admin.hlx.page` (operations, config) and `https://admin.da.live`
(content). **Never read a migrated Helix 6 site through `admin.da.live`** — it answers
200 with a different project's content and no error.

## 7. Getting the OpenAPI spec out of the docs

`https://www.aem.live/docs/api.html` (Helix 6) and `https://www.aem.live/docs/admin.html`
(Helix 5) are Redoc pages. There is **no** `<script id="__redoc_state">` element: find
the literal string `const __redoc_state = ` and brace-match the JSON from there; the
spec lives at `.spec.data`.

## 8. Observations worth knowing

- `GET /profile` with an IMS token reports `expires_in: "86400000"` / `ttl ≈ 85600`
  (≈24 h) even though IMS tokens stop being accepted after ~20 minutes in practice.
  Do not trust that ttl for scheduling long jobs; that gap is the reason API keys exist.
- 4xx responses frequently have an **empty body**; the only human-readable message is in
  the `x-error` header (with `x-error-code`, e.g. `AEM_BACKEND_CONFIG_UPDATE`). Any
  client that only reads bodies will report a blank error.
- Responses carry `x-ratelimit-limit: 10` / `x-ratelimit-rate` — keep fan-out bounded.
- The `size` in a Source Bus listing can disagree with the byte length of a `GET` of the
  same document; treat it as informational.
