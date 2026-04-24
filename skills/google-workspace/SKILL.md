---
name: google-workspace
description: >-
  Install and authenticate the official Google Workspace CLI (`gws`) and make its
  OAuth credentials available to SLICC's fetch proxy as `GWS_`-prefixed secrets.
  Use this skill when the user wants to call Google APIs (Drive, Gmail, Calendar,
  Sheets, Docs, Chat, Admin) from the agent or shell, or asks to "set up gws",
  "connect Google Workspace", "store Google credentials in SLICC", or "import gws
  auth into the keychain". Covers both the macOS Keychain route (swift-server) and
  the `~/.slicc/secrets.env` route (node-server).
allowed-tools: bash
---

# Google Workspace (`gws`)

This skill wires Google's official `gws` CLI into SLICC. It does two things:

1. Points at the upstream installer and auth flow: **https://github.com/googleworkspace/cli**
2. Explains how to move the resulting OAuth credentials into SLICC's secret stores
   (macOS Keychain or `~/.slicc/secrets.env`) so the fetch proxy can inject them
   into requests to `*.googleapis.com`.

`gws` itself is a fully-featured CLI; this skill does **not** re-wrap it. Call
`gws <service> <verb>` directly from the shell once the credentials are wired.

## 1. Install `gws`

Follow the upstream instructions — they change more often than this skill will:

- **Repo**: https://github.com/googleworkspace/cli
- **Install options**: pre-built binary from [GitHub Releases](https://github.com/googleworkspace/cli/releases), `npm i -g @googleworkspace/cli`, or `cargo install`.

Verify:

```bash
gws --version
```

## 2. Authenticate `gws`

The fastest path (requires the `gcloud` CLI):

```bash
gws auth setup    # one-time: creates a GCP project, enables APIs, runs OAuth
gws auth login    # subsequent scope changes / re-login
```

No `gcloud`? Follow the [manual OAuth setup](https://github.com/googleworkspace/cli#manual-oauth-setup-google-cloud-console)
in the upstream README — create a **Desktop app** OAuth client in the Cloud
Console, download the JSON, then either:

- set `GOOGLE_WORKSPACE_CLI_CLIENT_ID` / `GOOGLE_WORKSPACE_CLI_CLIENT_SECRET` and run `gws auth login`, or
- set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/client_secret.json` and call `gws` directly.

After `gws auth login`, `gws` stores encrypted credentials under `~/.config/gws/`.

## 3. Inspect the credentials

```bash
gws auth export --unmasked
```

The output is a JSON object with four keys:

```json
{
  "client_id":     "<google oauth client id>.apps.googleusercontent.com",
  "client_secret": "<google oauth client secret>",
  "refresh_token": "<long-lived refresh token>",
  "type":          "authorized_user"
}
```

**Do not paste the values into chat or commit them.** The recipes below read the
JSON into a tool and pipe it straight into the secret store — values never hit
stdout.

## 4. Put the credentials into SLICC

SLICC has two secret stores. Pick one based on which float you run:

| Float           | Store                       | Source of truth                    |
| --------------- | --------------------------- | ---------------------------------- |
| `swift-server`  | macOS Keychain              | service `ai.sliccy.slicc`          |
| `node-server`   | Env file                    | `~/.slicc/secrets.env` (mode 0600) |

Both stores require a comma-separated **domain allowlist** per secret. The fetch
proxy will only inject a secret into a request whose hostname matches one of the
listed patterns.

**Recommended allowlist for Google Workspace APIs:**

```
oauth2.googleapis.com,accounts.google.com,*.googleapis.com,www.googleapis.com
```

Naming convention used by this skill: uppercase, `GWS_` prefix.

- `GWS_CLIENT_ID`
- `GWS_CLIENT_SECRET`
- `GWS_REFRESH_TOKEN`
- `GWS_TYPE` (optional — value is the literal string `authorized_user` and is not sensitive)

### 4a. macOS Keychain (swift-server)

Export credentials to a temp file, import each entry without echoing the value,
then delete the temp file.

```bash
TMP=$(mktemp)
gws auth export --unmasked > "$TMP"
python3 - "$TMP" <<'PY'
import json, subprocess, sys
path = sys.argv[1]
d = json.load(open(path))
domains = "oauth2.googleapis.com,accounts.google.com,*.googleapis.com,www.googleapis.com"
for k, v in d.items():
    name = f"GWS_{k.upper()}"
    subprocess.run([
        "security", "add-generic-password",
        "-s", "ai.sliccy.slicc",
        "-a", name,
        "-w", v,
        "-U",
        "-C", "note",
        "-j", domains,
    ], check=True)
    print(f"added {name}")
PY
rm -f "$TMP"
```

Verify (names + domains only — values stay in the Keychain):

```bash
for n in GWS_CLIENT_ID GWS_CLIENT_SECRET GWS_REFRESH_TOKEN GWS_TYPE; do
  security find-generic-password -s ai.sliccy.slicc -a "$n" 2>&1 \
    | grep -E '"acct"|"icmt"' | sed "s/^/$n  /"
done
```

Remove a single entry:

```bash
security delete-generic-password -s ai.sliccy.slicc -a GWS_REFRESH_TOKEN
```

**Reload requirement:** swift-server's `SecretInjector` loads all secrets into a
session cache at startup and generates deterministic masked values once. Adding
or deleting entries while the server is running will not take effect until the
process is restarted. Stop and relaunch `slicc-server` after every change.

### 4b. Env file (node-server)

Each secret needs two lines: `NAME=<value>` and `NAME_DOMAINS=<comma-separated>`.
Generate the block directly from `gws auth export` — again without echoing
values:

```bash
TMP=$(mktemp)
gws auth export --unmasked > "$TMP"
mkdir -p ~/.slicc
touch ~/.slicc/secrets.env
chmod 600 ~/.slicc/secrets.env
python3 - "$TMP" <<'PY' >> ~/.slicc/secrets.env
import json, sys
path = sys.argv[1]
d = json.load(open(path))
domains = "oauth2.googleapis.com,accounts.google.com,*.googleapis.com,www.googleapis.com"
for k, v in d.items():
    name = f"GWS_{k.upper()}"
    print(f"{name}={v}")
    print(f"{name}_DOMAINS={domains}")
PY
rm -f "$TMP"
```

Override the file location with `SLICC_SECRETS_FILE=/absolute/path` if you need
a non-default path.

**Reload requirement:** node-server reads the env file once at startup. Restart
`slicc` / `npm run dev` after editing it.

## 5. How the agent sees the secret

Once secrets are registered and the server has been restarted:

- `GET /api/secrets/masked` returns `[{ name, maskedValue, domains }]` for the
  current session. The shell populates env vars with the masked values.
- Scripts can refer to `$GWS_REFRESH_TOKEN` etc. — what they hold is a
  deterministic session-scoped **mask**, not the real value.
- When the mask appears in a request header or body sent through `fetch` / the
  `/api/fetch-proxy`, the proxy checks the request hostname against
  `GWS_REFRESH_TOKEN_DOMAINS` and substitutes the real value only if a domain
  pattern matches. Response bodies are scrubbed on the way back.

This means the agent can freely log or pass around `$GWS_REFRESH_TOKEN` — only
outbound requests to `*.googleapis.com` (or whichever domains you allowed) ever
see the real secret.

## 6. Using `gws` from the agent

Once authenticated, call `gws` directly. Examples:

```bash
gws drive files list --params '{"pageSize": 5}'
gws gmail users.messages list --params '{"userId": "me", "maxResults": 10}'
gws calendar events list --params '{"calendarId": "primary"}'
gws sheets spreadsheets.values get --params '{"spreadsheetId": "<id>", "range": "A1:C10"}'
```

`gws` re-uses its own encrypted credential store and does not read the SLICC
secrets directly. The SLICC secrets are there so **other** tools (curl, fetch,
browser sessions, custom scripts) can call Google APIs with the same refresh
token without re-running OAuth.

To drive an HTTP call from the shell that benefits from the SLICC fetch proxy
injection, pass the mask through as a normal env var. Set the form
content-type explicitly — the just-bash `curl` shim does not auto-add it
the way real curl does for `-d`:

```bash
curl -sS -X POST https://oauth2.googleapis.com/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=$GWS_CLIENT_ID" \
  -d "client_secret=$GWS_CLIENT_SECRET" \
  -d "refresh_token=$GWS_REFRESH_TOKEN" \
  -d "grant_type=refresh_token"
```

The proxy unmasks each `$GWS_*` variable because the request hostname
(`oauth2.googleapis.com`) is in every entry's domain allowlist.

Sanity-check what masked values the shell actually holds (the masked
hex changes whenever the server is restarted):

```bash
curl -sS http://localhost:${SLICC_PORT:-5710}/api/secrets/masked \
  | jq '.[] | select(.name|startswith("GWS_")) | {name, domains}'
```

If `$GWS_CLIENT_ID` printed in the shell does not match the
`maskedValue` for `GWS_CLIENT_ID` in that response, the shell env is
stale — reload the page so `fetchSecretEnvVars()` repopulates.

## 7. Rotating / revoking

- **Rotate the refresh token**: re-run `gws auth login` to force a new OAuth
  exchange, then repeat step 4 to re-import.
- **Revoke entirely**: remove the OAuth grant at
  https://myaccount.google.com/permissions, delete the SLICC entries
  (`security delete-generic-password ...` or strip the lines from
  `secrets.env`), and restart the server.

## Troubleshooting

- **`gws auth export --unmasked` returns asterisks anyway** — the binary is old.
  Upgrade `gws` (`npm i -g @googleworkspace/cli@latest` or re-download the
  release).
- **Secret shows up in `GET /api/secrets` but isn't injected** — you added it
  while the server was running. Restart swift-server / node-server, _then
  reload the webapp_ so the shell repopulates `$GWS_*` with the new masks
  (the values are session-scoped HMACs and change on every server start).
- **Google replies `400 invalid_client` / "The OAuth client was not found."**
  — the credentials reaching Google are still the masked hex, i.e. the proxy
  did not unmask them. Causes, in order of likelihood:
    1. Stale shell env (added/changed secrets after the page loaded). Reload.
    2. `_DOMAINS` doesn't cover the host. Use
       `oauth2.googleapis.com,accounts.google.com,*.googleapis.com,www.googleapis.com`.
       Note that `*.googleapis.com` matches `oauth2.googleapis.com` but not
       the bare `googleapis.com`.
    3. The credentials really are wrong (re-run `gws auth login`).
  Compare `echo "$GWS_CLIENT_ID"` to the `maskedValue` returned by
  `/api/secrets/masked` — they must match before the proxy can find anything
  to substitute.
- **`curl: (1) [object Object]`** — pre-fix slicc bug: the SecureFetch in
  `wasm-shell.ts` (and friends) treated upstream 4xx as a proxy
  infrastructure failure and stringified an object-shaped error field.
  Update slicc to a build that includes the
  [`X-Proxy-Error` marker fix](https://github.com/ai-ecoverse/slicc/pull/487)
  — the curl shim will then surface Google's real error body verbatim.
- **`domainBlocked` in fetch proxy logs** — the request hostname isn't in the
  secret's `_DOMAINS` list. Either expand the allowlist or point the request at
  an allowed host.
- **403 `accessNotConfigured`** — the specific Google API (Gmail, Calendar, etc.)
  isn't enabled for the GCP project behind your OAuth client. Follow the
  `enable_url` in the error body or rerun `gws auth setup`.
