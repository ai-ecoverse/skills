# ARM authentication by harvesting the portal tab

There is no `az` binary in SLICC, no service principal, and no way to run
`az login`'s device-code flow unattended. This skill instead borrows the
credential a signed-in **`portal.azure.com`** tab already holds.

## Why this works

The Azure portal SPA is an **MSAL** (Microsoft Authentication Library) client.
MSAL caches its tokens in the tab's **`sessionStorage`**, one entry per
`(clientId, tenant, audience)` triple. One of those audiences is Azure Resource
Manager. Read that entry's `secret` and you hold a normal ARM bearer token with
the signed-in user's own RBAC — nothing is escalated and nothing is minted.

Unlike the Cloudflare and GCP-console skills, the *request* does not have to run
in the page. ARM accepts a cross-origin request carrying
`Authorization: Bearer <token>`, so only the **harvest** needs the browser:

```
portal tab  ──browser.evalAsync──▶  sessionStorage scan  ──▶  token
                                                              │
realm fetch  ──Authorization: Bearer──▶  https://management.azure.com
```

That matters for the cost commands, because a Cost Management response is far
too large to survive a CDP eval round trip intact (see "Size caps" below).

## The sessionStorage entry shape

Keys look like this — the shape is *not* load-bearing, do not parse it:

```
msal.3|<clientId>.<tenantId>|login.windows.net|<something>
msal.token.keys.<clientId>
```

Values that matter are JSON objects:

```json
{
  "credentialType": "AccessToken",
  "secret": "eyJ0eXAiOiJKV1Qi…",
  "target": "https://management.core.windows.net//user_impersonation",
  "realm": "fa7b1b5a-7b34-4387-94ae-d2c178decee1",
  "clientId": "c44b4083-3bb0-49c1-b47d-974e53cbdf3c",
  "expiresOn": 1787838086
}
```

| Field | Meaning |
|---|---|
| `credentialType` | Must be `AccessToken`. `RefreshToken` / `IdToken` entries also exist and must be skipped. |
| `secret` | The bearer token itself. |
| `target` | The **audience + scopes**. This is the selector. |
| `realm` | The tenant id. |
| `expiresOn` | Epoch **seconds**. |

## Audience selection is the whole trick

**A live portal tab holds many access tokens at once.** Measured on one tab:
**10 `AccessToken` entries**, of which only 2 were for ARM. The others were
Microsoft Graph and opaque first-party resource ids such as
`c44b4083-3bb0-49c1-b47d-974e53cbdf3c` and `7000789f-…`. Picking any of those
yields a bare **401** from ARM with no hint about why.

Select on `target` containing **`management.core.windows.net`**:

```js
let secret = null;
for (let i = 0; i < sessionStorage.length; i++) {
  const v = sessionStorage.getItem(sessionStorage.key(i)) || '';
  if (!v.startsWith('{')) continue;          // most keys are not JSON
  let o; try { o = JSON.parse(v); } catch (e) { continue; }
  if (o && o.credentialType === 'AccessToken' && o.secret &&
      /management\.core\.windows\.net/.test(o.target || '')) { secret = o.secret; break; }
}
```

Note the audience is `management.core.**windows**.net` (the legacy resource id
that ARM still issues tokens for) while the API host is
`management.**azure**.com`. They differ; do not "fix" one to match the other.

`az.jsh` collects **all** ARM candidates and takes the longest-lived one, because
a tab that has been open for a while accumulates several with different
expiries.

## An idle tab can hold an ALREADY-EXPIRED token

Measured, and the most likely thing to trip you up: **MSAL refreshes lazily, on
demand — not on a timer.** A portal tab left sitting on one blade will happily
serve you a token that expired minutes ago. Storing it guarantees a confusing
401 later.

`az login --from-tab` therefore rejects a token with under 60 s of life and says
so, with the remedy: **interact with the tab** (open Subscriptions, or Cost
Management → Cost analysis) so the SPA requests a fresh ARM token.
`--wait <seconds>` polls the tab while you do that:

```bash
az login --from-tab --wait 60
```

Measured example of the failure and the recovery:

```
az: The portal tab's ARM token expired 4m ago (253s), so it was
not stored. MSAL refreshes tokens lazily — an idle portal tab keeps a stale one.
Interact with the tab (click Subscriptions, or Cost Management → Cost analysis, or
just reload it) so a fresh ARM token is minted, then re-run:
  az login --from-tab            # or: az login --from-tab --wait 60
```

…then, after navigating the tab to a blade that needs ARM:

```
  ✓ ARM token harvested from the portal tab (never printed).
  account   trieloff@adobe.com
  tenant    fa7b1b5a-7b34-4387-94ae-d2c178decee1
  audience  https://management.core.windows.net/
  expires   in 1h00m (7150 chars)
  ignored   9 non-ARM token(s) in the same tab (Graph et al.)
```

## Expiry handling

- Portal ARM tokens live about **60 minutes** (measured: 7150-char JWT,
  `expires in 1h00m`).
- The token is stored with its `expiresOn`. A **120 s skew guard** means a token
  inside its last two minutes is treated as absent, so a multi-chunk cost query
  cannot expire mid-flight.
- Any ARM `401` triggers **exactly one** silent re-harvest, then the request is
  retried. A second 401 is reported, because at that point the cause is
  permissions, not staleness.
- `az-ext` never harvests. When its stored token is unusable it shells out to
  `az login --from-tab`, so the sessionStorage logic exists in exactly one place.

## Size caps — why the request does not run in the page

CDP `Runtime.evaluate` results are size-capped, and a ~6000-character return
value was observed **truncated mid-JSON**. A token cut in transit would look
plausible and fail later as a 401, so the harvest validates locally before
storing:

1. three non-empty base64url segments;
2. the payload segment decodes as JSON;
3. the payload carries an `aud` claim;
4. total length ≥ 400 chars (real ARM tokens measured at ~7150).

**Honest boundary:** truncation that removes only part of the *signature* leaves
a complete, decodable payload and is **not** locally detectable. That case falls
through to the 401-then-re-harvest path by design.

Also note CDP `Runtime.evaluate` times out at about **30 s**. Never put a
retry-with-sleep loop inside one in-page script; `az.jsh --wait` issues a
*separate* `evalAsync` per poll for exactly this reason.

## Never print the token

The harvested token is a bearer credential for every subscription the user can
reach. The rules, enforced in `az.jsh`:

- It is **never** written to stdout or stderr, never included in `--json`
  output, and never passed as a command-line argument (argv is visible to `ps`).
- Only its **length**, **expiry**, **tenant** and **audience** are ever printed.
- It is stored in the skill config (`scripts/.config`), not in an env var.
- `az logout` clears the local copy. It does **not** revoke anything
  server-side — the portal tab still holds its own session. Sign out in the
  portal to actually revoke.
- A token that fails local validation is **not stored**.

## Verified ARM calls

```
GET  /subscriptions?api-version=2022-12-01
POST /subscriptions/<subId>/providers/Microsoft.CostManagement/query?api-version=2023-11-01
```

`GET /subscriptions` is the cheap validation probe `az login --from-tab` uses to
prove the token works before storing it, and it is **not** part of the throttled
Cost Management surface.

## What this approach cannot do

- **No unattended operation.** A human must be signed into the portal, and the
  token dies in an hour. This is a *reader* credential for interactive analysis,
  not a substitute for a service principal in CI.
- **No scope beyond the user's RBAC.** Cost Management queries additionally need
  *Cost Management Reader* (or Reader) on the subscription; a 403 there means
  missing role assignment, not a broken token.
- **No management-plane writes are wrapped.** `az rest` will happily issue a
  `PUT`/`DELETE` if you ask it to, but nothing in this skill does so on your
  behalf.
