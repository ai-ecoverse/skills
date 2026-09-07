# AEM auth — the login cookie, and why it works

This file is the durable record for `aem-ext auth login`. It complements
`references/api-keys.md` (which covers the admin-API-key credential in depth) with the
third credential: the `auth_token` **login cookie**, up to **24 hours**, no key
management required.

Everything marked **verified** was exercised live on **2026-09-07** against org
`ai-ecoverse`, site `slicc-website` (Helix 6, `api.aem.live`). All checks that touched
the live site were **read-only** (`GET /profile`, `GET source/<path>`, `GET
status/<path>`); no `PUT`/`POST`/`DELETE` was sent to that site while building this.

## The false claim this corrects

An earlier version of `aem-ext.jsh` (and this reference) said a cookie credential
"cannot be used" for `aem-ext`'s JSON/API routes, because:

> SLICC's `fetch()` goes through the browser Fetch API, which silently strips a
> caller-supplied `Cookie` header.

**That premise is true. The conclusion drawn from it was not.** `fetch()` does strip
`Cookie` — but **`curl` does not**, and `aem.jsh` / `aem-ext.jsh` already shell out to
`curl` for some operations (`cmdPut`'s byte-faithful upload, for one). So a cookie
credential is fully usable; it just has to go through `curl` instead of `fetch()`.
`aem-ext.jsh` now does that for every operation, not only `put`.

Verified live 2026-09-07, all against `https://api.aem.live/ai-ecoverse/sites/slicc-website`:

| Request | Transport | Result |
|---|---|---|
| `GET /profile` | `curl -H "Cookie: auth_token=<v>"` | **200** (`trieloff@adobe.com`) |
| `GET source/nav.html` | curl, same header | **200** |
| `GET /` (listing) | curl, same header | **200** |
| `GET status/nav` | curl, same header | **200** |
| any of the above | global `fetch()` with the same header | strips `Cookie` — unauthenticated (documented separately in `skills/secret-sauce/SKILL.md`) |

(`PUT source/<path>`, `POST preview/<path>`, `POST live/<path>` were verified with this
same cookie+curl combination during development, against scratch paths — not repeated
here since this file only documents read-only checks against the production site.)

## The login flow

`GET https://api.aem.live/login` answers **JSON, not HTML** (verified), with one link
per identity provider:

```json
{"links":{
  "login_google":"https://api.aem.live/auth/google",
  "login_google_sa":"https://api.aem.live/auth/google?selectAccount=true",
  "login_microsoft":"https://api.aem.live/auth/microsoft",
  "login_microsoft_sa":"https://api.aem.live/auth/microsoft?selectAccount=true",
  "login_adobe":"https://api.aem.live/auth/adobe",
  "login_adobe_sa":"https://api.aem.live/auth/adobe?selectAccount=true",
  "login_adobe-stage":"https://api.aem.live/auth/adobe-stg",
  "login_adobe-stage_sa":"https://api.aem.live/auth/adobe-stg?selectAccount=true"
}}
```

`_sa` variants append `?selectAccount=true`, forcing an account chooser
(`aem-ext auth login --select-account`).

`aem-ext auth login`:

1. Resolves the link for `--idp` (default `adobe`).
2. Opens it in a **foreground** browser tab: `playwright-cli tab-new <url>
   --foreground`. **Not** `require('sliccy:browser')`'s `ensureTab`/`createPage` —
   that bridge hardcodes `Target.createTarget({ background: true })` with no override
   (`realm-host.ts`), so it cannot foreground a tab at all. A background tab both
   hides an interactive login (password, MFA) from the user and throttles any
   JS-heavy IDP step ~117x (`skills/playwright-cli/SKILL.md`).
3. Polls `playwright-cli eval --tab=<id> '(()=>location.href)()'` every 2s until the
   tab reaches `<base>/profile`, or `--timeout` seconds elapse (default 120).
   Verified live: with an existing Adobe SSO session, this took **8-28 seconds** with
   zero interaction, across several runs.
4. Harvests the cookie: `playwright-cli cookie-get --tab=<id> auth_token`.
5. Decodes and validates it, then stores it, then closes the tab.

## Three traps (all handled in `aem-ext.jsh`)

### 1. `cookie-get`'s output is not the bare value

```
$ playwright-cli cookie-get --tab=<id> auth_token
auth_token=eyJhbGciOi...<jwt>...	Domain=api.aem.live	Path=/	Secure=true	HttpOnly=true	Expires=-1
```

That is `name=value` plus **tab-separated** metadata
(`Domain=`/`Path=`/`Secure=`/`HttpOnly=`/`Expires=`), confirmed by reading the
handler (`cookies.ts`'s `formatCookieLine`). Naively doing
`` Cookie: auth_token=$(cookie-get ...) `` produces
`Cookie: auth_token=auth_token=eyJ...` — a 401 that gives no hint what went wrong.
Fix: strip a leading `auth_token=`, then cut at the first tab/whitespace.

(The in-process `require('sliccy:browser')`'s `cookie(tab, name)` call returns the bare
value in this runtime, per `realm-host.ts`'s `getCookie()` — but `linkedin.jsh` records
a bridge revision that once returned the full pair instead, so the same defensive
stripping is applied regardless of which path harvests the cookie.)

### 2. `Buffer.from(x, 'base64url')` throws here

`TypeError: Unknown encoding: base64url` in this runtime. Decode a JWT payload with the
manual transform instead:

```js
let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
while (b64.length % 4) b64 += '=';
JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
```

`aem-ext.jsh`'s `decodeJwt()` already did this correctly before this PR (it predates
the login flow, from the API-key work) — reused as-is for the cookie.

### 3. An expired cookie is byte-identical to a fresh one

A cookie that expired 50 hours ago decodes exactly like a live one; the only
difference is `exp`. Using it produces a plain 401, indistinguishable from a wrong
credential. `aem-ext.jsh` decodes `exp` and compares it to "now" **before** storing a
freshly harvested cookie, and again every time a stored cookie is read back for
`credential()` resolution — a stale stored cookie is skipped (with a warning) rather
than handed to a request that is guaranteed to fail.

## Cookie payload shape (verified)

```json
{
  "email": "user@example.com", "name": "…", "user_id": "…", "imsToken": "…",
  "ownerOrg": "…@AdobeOrg", "dmaTenantId": "…", "imsGroups": ["…/admins"],
  "iat": 1788780284, "iss": "https://admin.hlx.page/", "sub": "*/*",
  "aud": "…", "exp": 1788866684
}
```

Measured lifetime: `exp - iat` = exactly **86400 seconds (24h)**, across multiple
fresh logins. `GET /profile` with this cookie returns the same `email`/`iat`/`exp` (as
`profile.exp`/`profile.iat`), which is why `aem-ext auth status` can still show a real
expiry when the cookie is sourced from a **masked** secret (see below) and cannot be
decoded locally.

## Storage

The harvested cookie is stored exactly the way `auth key create --save-secret` stores
an API key: `secret set aem.authcookie <value> --domain "api.aem.live,admin.hlx.page,admin.aem.live"`
— a **session** secret, no `--persist`. `credential()` resolves it the same way the
API key secret is resolved (`secret get`), so a masked value (the secrets manager hands
back a repeated-hex blob, unmasked server-side by the fetch/curl proxy) is handled
identically to a masked API key: not decodable locally, left to the live request.

Two things made this path worth guarding explicitly:

- **`secret set --persist` has been reported failing with "Failed to fetch"** in this
  environment. `auth login` never uses `--persist` (matching the existing API-key
  flow), so it doesn't hit that specific failure — but the secrets manager as a whole
  has also been observed to **hang** far past a normal request (one `secret set` call
  outlived a 600-second budget; a second attempt in the same session finished in under
  a minute). `auth login` therefore runs that call through a killable
  `exec.start()` handle with a bounded timeout, and falls back to `skill.config()`
  (this script's other pre-existing persistence path) if it doesn't finish in time —
  never design a step around waiting on an unbounded external call.
- If the secrets manager is unavailable for the whole session, `auth login` still
  works; it just says so (`stored: config` instead of `stored: secret`) rather than
  losing the credential.

## What this file does NOT claim

- The cookie was not tested against a genuinely **interactive** login (password entry,
  MFA) — every live run in this environment redirected straight to `/profile` because
  an Adobe SSO session already existed. The foreground tab and the polling loop exist
  specifically for the interactive case, but that path itself is inferred from the
  mechanism, not observed.
- The 24-hour lifetime is measured from `iat`/`exp` on several fresh cookies, not from
  watching a single cookie actually expire.
- `PUT`/`POST` with a cookie credential were exercised during development against
  scratch content, not against `ai-ecoverse/slicc-website`'s real pages — the
  read-only checks in the table above are what this PR's verification touched on that
  site.
