# Bootstrapping Gmail OAuth credentials inside SLICC

`gmail.jsh` needs `GWS_CLIENT_ID`, `GWS_CLIENT_SECRET`, and `GWS_REFRESH_TOKEN`
(see the table in `SKILL.md`). If your org already has a real Google Cloud OAuth
client with these provisioned as secrets, use those and ignore this document —
it exists only for the case where you're starting from nothing and need to
obtain a working set of credentials from inside a SLICC session, where there's
no way to pre-provision arbitrary env vars and no browser session of your own
outside SLICC's `oauth-token` command.

This is **one option**, not the only way to get Gmail OAuth credentials. It
trades "no Google Cloud project needed" for "depends on a public client ID
whose consent screen you don't control."

## The technique: a well-known public OAuth client

`oauth-token`'s intercept mode can drive an arbitrary OAuth authorization-code
flow — it opens a real browser tab at an `authorizeUrl` you supply, a human
completes the consent screen, and it captures the redirect URL (containing the
`code`) once it matches a `redirectUriPattern`. It doesn't require the OAuth
client to be pre-registered with SLICC; you just need a client ID/secret pair
that Google has already approved for the scope you want.

There are two equivalent ways to invoke intercept mode — `--intercept
--authorize-url ... --redirect-pattern ...` builds the config from CLI flags,
while `--from-file <path>` reads the identical `InterceptOAuthConfig` shape
(`{ authorizeUrl, redirectUriPattern, rewrite?, onCapture?, timeoutMs? }`)
from a JSON file on disk. They are the same underlying mechanism; `--from-file`
is not a different or alternate flow, it's just config-from-file instead of
config-from-flags (see `oauth-token --help`). This walkthrough uses the
`--from-file` form throughout, because the authorize URL below has enough
query parameters that passing it as a single `--authorize-url` flag value
would be unwieldy. If you'd rather pass flags directly, the equivalent
`--intercept --authorize-url '<the authorizeUrl below>' --redirect-pattern
'http://127.0.0.1:56121/*'` invocation works identically.

Rather than registering a new Google Cloud OAuth app (which requires app
verification for sensitive Gmail scopes), this uses the OAuth client ID and
secret that Mozilla Thunderbird ships for its "Sign in with Google" flow.
These are public by design — desktop/native-app OAuth clients are not
confidential clients, and Google relies on redirect-URI matching (and, where
the client implements it, PKCE) rather than secrecy of the "secret" to
protect them. **The flow documented in this file does not use PKCE** — see
the [Security note](#security-note-authorization-code-exposure) below for why,
and what that means in practice. They are checked into Mozilla's own public
source tree:

- Source: `https://hg.mozilla.org/comm-central/raw-file/tip/mailnews/base/src/OAuth2Providers.sys.mjs`,
  under the `kIssuers` map, key `"accounts.google.com"`.
- `clientId: "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com"`
- `clientSecret: "kSmqreRr0qwBWJgbf5Y-PjSU"`
- `authorizationEndpoint: "https://accounts.google.com/o/oauth2/auth"`
- `tokenEndpoint: "https://www.googleapis.com/oauth2/v3/token"`

If Google ever revokes or rotates this specific client, re-check that source
file for the current values — Thunderbird actively maintains it.

Note: `https://www.googleapis.com/oauth2/v3/token` (used below for the
authorization-code exchange) and `https://oauth2.googleapis.com/token` (what
`gmail.jsh` itself uses for the refresh-token grant) are both Google's token
endpoint — v3 path vs. the newer canonical alias. Not a discrepancy; either
works for either grant type.

## Step by step

### 1. Build an intercept config

```json
{
  "authorizeUrl": "https://accounts.google.com/o/oauth2/auth?client_id=406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A56121&response_type=code&access_type=offline&prompt=consent&scope=https%3A%2F%2Fmail.google.com%2F",
  "redirectUriPattern": "http://127.0.0.1:56121/*",
  "timeoutMs": 120000
}
```

Save it to a file in the VFS, e.g. `/tmp/gmail-intercept.json`.

Key query parameters and why they're there:

- `access_type=offline` — required to get a `refresh_token` back at all; without
  it you only get a short-lived access token.
- `prompt=consent` — forces the consent screen even for a Google account that's
  already logged in / previously authorized this client, which is needed to
  reliably get a *fresh* refresh token on repeat runs.
- `scope=https://mail.google.com/` — the full-access (IMAP-equivalent) Gmail
  scope, matching what the Thunderbird client is pre-approved for. This is the
  only scope that's actually been tested with this client. A narrower scope
  such as `gmail.readonly` might work but hasn't been verified — don't assume it
  does.

### 2. Run the intercept

```bash
oauth-token --from-file /tmp/gmail-intercept.json
```

(Equivalent flag-based form, if you'd rather not write a file:
`oauth-token --intercept --authorize-url '<the authorizeUrl above>'
--redirect-pattern 'http://127.0.0.1:56121/*'`. Both invoke the same intercept
mechanism — `--from-file` just reads the config from disk instead of from
flags.)

This opens a real browser tab at the authorize URL. A human must complete the
Google consent screen (this step is inherently interactive — there's no way
around it for a brand-new grant). On success, it prints the captured redirect
URL to stdout, e.g.:

```
http://127.0.0.1:56121/?iss=https://accounts.google.com&code=4/0AdkVLPwb...&scope=https://mail.google.com/
```

Extract the `code` query parameter from that URL.

### 3. Exchange the code for tokens

```bash
curl -s -X POST "https://www.googleapis.com/oauth2/v3/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com" \
  --data-urlencode "client_secret=kSmqreRr0qwBWJgbf5Y-PjSU" \
  --data-urlencode "code=<the captured code>" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "redirect_uri=http://127.0.0.1:56121"
```

On success this returns a `200` with a JSON body containing `access_token`,
`refresh_token`, `expires_in`, `scope`, and `token_type`.

**Gotcha:** passing the same fields as multiple separate `-d` flags (the
"naive curl example" you'll see in most online OAuth walkthroughs) fails in
the SLICC sandbox shell with a `400 INVALID_ARGUMENT` / "Invalid JSON payload"
error from Google's endpoint — something about how multiple `-d` args get
concatenated or interpreted goes wrong here. Using `--data-urlencode` for
every field, as shown above, avoids this and returns a clean response.

### 4. Set the env vars

The response's `refresh_token`, together with the same `client_id` and
`client_secret` used above, are exactly the three values `gmail.jsh` needs:

| From the token response / request | Maps to |
|---|---|
| `client_id` used in the exchange | `GWS_CLIENT_ID` |
| `client_secret` used in the exchange | `GWS_CLIENT_SECRET` |
| `refresh_token` field in the response | `GWS_REFRESH_TOKEN` |

Set those three as environment variables and `gmail.jsh` works immediately —
no code changes needed. This has been verified live: `gmail mail --limit 3`
and `gmail mail --search "older_than:30d"` both returned real message data
using credentials obtained this way.

## Security note: authorization code exposure

This walkthrough does **not** use PKCE (`code_challenge`/`code_verifier`).
That's worth calling out explicitly rather than leaving it implicit, because
this is a public-client flow — anyone holding the same client ID/secret pair
(they're checked into Mozilla's public source tree; see above) can exchange
a valid, unexpired authorization `code` for tokens themselves. Normally PKCE
closes this gap by binding the `code` to a per-flow secret (`code_verifier`)
that only the party who initiated the flow holds, so an intercepted `code`
alone isn't enough to redeem it.

We looked into adding PKCE to this documented flow before writing this note.
Doing it correctly would require: generating a random `code_verifier`,
deriving `code_challenge = base64url(sha256(code_verifier))`, getting
`code_challenge` (+ `code_challenge_method=S256`) onto the actual outgoing
request to Google's authorize endpoint, and then supplying the *original*
`code_verifier` (not the challenge) in the Step 3 token exchange. We tested
whether `oauth-token`'s `--rewrite <match=key=val>` flag (or the equivalent
`rewrite` field in `InterceptOAuthConfig`) could inject `code_challenge` into
the authorize request live, using several config variants against both a
local (zero-network-flakiness) target and an httpbin.org redirect chain,
repeated multiple times for confidence. In every run, the injected parameter
did not appear in the captured redirect URL. Whatever `--rewrite` is for
(the help text describes it only as appending a query param to "any request
whose URL contains `<match>`"), it did not observably affect the top-level
navigation to the authorize URL that `oauth-token` captures, which is what
would need to happen for PKCE to work here. We also did not find any way for
`oauth-token`'s intercept mode to keep a `code_verifier` in scope between the
Step 2 intercept call and a separate Step 3 curl invocation short of writing
it to a file ourselves — workable, but it doesn't change the more fundamental
problem that the authorize-side `code_challenge` injection isn't achievable
with the current flags. Given that, we're documenting the real risk instead
of a fix we couldn't actually verify:

- **The real risk:** the `code` from Step 2 is printed to stdout in plain
  text, and you then manually copy it into the Step 3 command. During that
  window — between capture and exchange — anyone with access to that output
  (shell history, session logs, a recorded terminal, screen-sharing, a
  shared/logged SLICC session, etc.) has everything they need (the `code`,
  plus the public `client_id`/`client_secret` documented above) to redeem the
  grant themselves and obtain a Gmail refresh token for the account that just
  went through the consent screen.
- **Mitigations you can actually apply today, even without PKCE support:**
  - Don't run Steps 2 and 3 as two separate commands with a human
    copy-pasting the code in between. Wrap them in a single script (e.g. a
    `.jsh` script, or a one-line shell function) that captures
    `oauth-token`'s stdout, extracts `code` with a regex, and immediately
    pipes it into the `curl` token-exchange call — so the code is never
    displayed to a human or left sitting in scrollback. This doesn't add
    PKCE's cryptographic binding, but it minimizes the exposure window to
    whatever a script takes to run, instead of "however long the human takes
    to select-and-paste."
  - Treat any terminal session where you ran this as sensitive until the
    exchange in Step 3 has completed successfully — don't share screen output
    or logs from that window.
  - If you have any reason to suspect the code or the resulting tokens were
    exposed, revoke the grant: via
    [`https://myaccount.google.com/permissions`](https://myaccount.google.com/permissions)
    (find the Thunderbird client and remove access), or by calling
    `https://oauth2.googleapis.com/revoke` with the `refresh_token` or
    `access_token` (`curl -s -X POST https://oauth2.googleapis.com/revoke
    --data-urlencode "token=<refresh_token>"`). Then re-run this walkthrough
    to get a fresh grant.

If `oauth-token` gains a documented way to inject authorize-side query
parameters that actually reaches the top-level navigation (or a way to run a
full custom script across both the intercept and exchange steps), revisit
this section — a real PKCE fix would be strictly better than the mitigations
above.
