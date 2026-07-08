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

`oauth-token --intercept` can drive an arbitrary OAuth authorization-code flow
— it opens a real browser tab at an `authorizeUrl` you supply, a human
completes the consent screen, and it captures the redirect URL (containing the
`code`) once it matches a `redirectUriPattern`. It doesn't require the OAuth
client to be pre-registered with SLICC; you just need a client ID/secret pair
that Google has already approved for the scope you want.

Rather than registering a new Google Cloud OAuth app (which requires app
verification for sensitive Gmail scopes), this uses the OAuth client ID and
secret that Mozilla Thunderbird ships for its "Sign in with Google" flow.
These are public by design — desktop/native-app OAuth clients are not
confidential clients, and Google secures them via PKCE and redirect-URI
matching rather than secrecy of the "secret." They are checked into Mozilla's
own public source tree:

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
