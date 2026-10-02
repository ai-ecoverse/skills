# Slack app manifest management (`slack-ext app`)

Reference for the `slack-ext app` commands summarised in SKILL.md ("App manifest management").
Wire-level details of the `apps.manifest.*` methods: `references/endpoints.md`.

`slack-ext app` wraps Slack's **App Manifest API** so app configuration (name,
bot scopes, event subscriptions) can be read, reviewed and changed from the CLI
instead of the app-settings web UI. Reads — `export`, `show`, `validate`, `diff`.
Writes (all requiring `--confirm`) — `set-scopes`, `set-events`,
`set-request-url`, `apply`, `token-rotate`.

Why an API and not the web UI: `api.slack.com/apps/<id>/oauth` now 302s into
`app.slack.com/app-settings/...`, part of the Slack client SPA. In a fresh tab
it renders zero controls and takes 30+ seconds when it renders at all, and its
workspace picker is a Slack Kit `.c-basic-select` that ignores every synthetic
event (clicks on the placeholder and on `.c-select_button`, Enter/Space/ArrowDown
KeyboardEvents, and a full pointerdown/mousedown/pointerup/mouseup/click
sequence all leave `aria-expanded="false"`). Verified 2026-09-18. There is
deliberately no browser automation in these commands.

## Contents

- [The export-modify-update rule](#the-export-modify-update-rule)
- [The `--allow-deletions` gate](#the---allow-deletions-gate)
- [`permissions_updated` means REINSTALL](#permissions_updated-means-reinstall)
- [Authentication (a third, separate credential)](#authentication-a-third-separate-credential)
- [Quick start](#quick-start)
- [Available commands](#available-commands)
  - [slack-ext app export \<app_id\> [--out=\<file\>] [--json]](#slack-ext-app-export-app_id---outfile---json)
  - [slack-ext app show \<app_id\> [--json]](#slack-ext-app-show-app_id---json)
  - [slack-ext app validate \<app_id\> --manifest=\<file\> [--json]](#slack-ext-app-validate-app_id---manifestfile---json)
  - [slack-ext app diff \<app_id\> --manifest=\<file\> [--json]](#slack-ext-app-diff-app_id---manifestfile---json)
  - [slack-ext app set-scopes \<app_id\> [--add=a,b] [--remove=c,d] [--confirm]](#slack-ext-app-set-scopes-app_id---addab---removecd---confirm)
  - [slack-ext app set-events \<app_id\> [--add=a,b] [--remove=c,d] [--confirm]](#slack-ext-app-set-events-app_id---addab---removecd---confirm)
  - [slack-ext app set-request-url \<app_id\> \<https url\> [--confirm]](#slack-ext-app-set-request-url-app_id-https-url---confirm)
  - [slack-ext app apply \<app_id\> --manifest=\<file\> [--allow-deletions] [--confirm]](#slack-ext-app-apply-app_id---manifestfile---allow-deletions---confirm)
  - [slack-ext app token-rotate [--refresh-token=\<tok\>] [--confirm] [--json]](#slack-ext-app-token-rotate---refresh-tokentok---confirm---json)
- [App manifest wire facts (verified live 2026-09-18)](#app-manifest-wire-facts-verified-live-2026-09-18)

### The export-modify-update rule

`apps.manifest.update` has **no merge semantics**. Measured live, 2026-09-18:

- **Omitting a field DELETES it.** Omitting `display_information.description`
  removed it from the live app.
- **Arrays are REPLACED WHOLESALE.** Sending `bot_events: ["channel_created"]`
  removed `team_join` outright.
- **A partial manifest VALIDATES `ok=true`.** A `display_information`-only
  payload passes `apps.manifest.validate` (re-confirmed live with a real app
  configuration token), so the API will accept a payload that silently strips
  the bot user, every scope and every event subscription. The validator catches
  only *some* incoherence, which is worse than blanket rejection: the dangerous
  payloads are the ones that pass.

Therefore **every write exports the live manifest, modifies that object, and
sends the complete result** — never a hand-written partial. This is enforced
structurally: all five write commands go through one internal helper
(`updateFromLiveManifest`) that exports first, refuses to continue if the export
failed or carried no manifest, mutates a clone of it, and is the only call site
for `apps.manifest.update` in the file.

One measured exception: `display_information.background_color` survived being
omitted, because it can never be null. That is one field, **not** merge
semantics — generalising from it is exactly the wrong conclusion.

### The `--allow-deletions` gate

Before any write, the command prints the same leaf-by-leaf diff `app diff`
produces, and then classifies the deletions:

- **Requested** deletions — what `set-scopes --remove` / `set-events --remove`
  were explicitly asked to drop — proceed with `--confirm` alone.
- **Unrequested** deletions — anything outside the field the command owns, and
  every omission in an `app apply` file — are a **hard stop even with
  `--confirm`**. The refusal names each one by JSON pointer and nothing is sent.
  Re-run with `--allow-deletions` once every named deletion is intended.

`app apply` has a second layer: without `--allow-deletions` its payload is the
file **overlaid on a fresh live export**, so a field the file omits is preserved
rather than deleted, while the diff shown is still live-vs-FILE so the operator
sees every omission. With `--allow-deletions` the file is sent as the complete
manifest and the deletions really happen. The gate and the overlay are
independent, so a bug in one does not silently wipe an app.

### `permissions_updated` means REINSTALL

`permissions_updated: true` in the update response means the app must be
**reinstalled** before a newly added scope reaches the live bot token — adding a
scope to the configuration alone does not grant it, and calls with the old token
keep failing on `missing_scope` until it is reissued. Every write command surfaces
this prominently; `--json` reports it as `permissions_updated` and
`reinstall_required`.

`apps.manifest.create` and `apps.manifest.delete` are real methods and are
**deliberately never wired up**. Deleting a Slack app is unrecoverable, and
there is no reason for a CLI to offer it; a guard in the script refuses those
two method names before any request is made.

### Authentication (a third, separate credential)

These commands use an **app configuration token** (`xoxe.xoxp-...`) sent as
`Authorization: Bearer <token>`. It is **not** the bot `xoxb` token and **not**
the `xoxc` session token every other command in this skill uses. There is no
fallback between them: `xoxb-` and `xoxc-` values are rejected with an
explanatory error rather than being tried.

Resolution order: `--token=<tok>` → `$SLACK_APP_CONFIG_TOKEN` → skill config key
`appConfigToken`.

Minting the first token is a **human step in the browser and cannot be
automated** (the workspace picker is the unautomatable Slack Kit control
described above):

1. Open `api.slack.com/apps`.
2. Scroll to **Your App Configuration Tokens**.
3. **Generate Token** → pick a workspace → **Generate**.

These tokens are short-lived and are rotated with `slack-ext app token-rotate`
(see below). A SLICC masked secret works: a session secret named
`SLACK_APP_CONFIG_TOKEN` scoped to `slack.com` is unmasked by the kernel at
request time. The script therefore does **not** shape-check the token value
beyond rejecting `xoxb-`/`xoxc-`, because a masked secret is opaque hex inside
the script.

### Quick start

```bash
# Human summary of the live app configuration
slack-ext app show A0123456789

# Save the live manifest, edit it, then see exactly what an update would change
slack-ext app export A0123456789 --out=./manifest.json
slack-ext app diff A0123456789 --manifest=./manifest.json

# Ask Slack whether a candidate manifest is well-formed
slack-ext app validate A0123456789 --manifest=./manifest.json

# Writes: dry run first (prints the diff, changes nothing), then --confirm
slack-ext app set-scopes A0123456789 --add=reactions:read
slack-ext app set-scopes A0123456789 --add=reactions:read --confirm
slack-ext app set-events A0123456789 --remove=team_join --confirm
slack-ext app set-request-url A0123456789 https://relay.example.com/slack --confirm
slack-ext app apply A0123456789 --manifest=./manifest.json --confirm

# Rotate the configuration token pair (invalidates the old refresh token)
slack-ext app token-rotate --confirm
```

### Available commands

#### slack-ext app export \<app_id\> [--out=\<file\>] [--json]

Fetch the live manifest (`apps.manifest.export`) and pretty-print it, or write
it to `--out=<file>`. The file form also reports the leaf-field count and prints
the matching `app diff` command. A real manifest is small — the app used to
verify this feature has 14 leaf fields / 709 bytes.

#### slack-ext app show \<app_id\> [--json]

Human summary of the live manifest: app name, description and colour, bot user
display name and always-online flag, every bot scope, the event-subscription
request URL and each subscribed bot event, plus the notable booleans
(socket mode, org deploy, token rotation, app-level token rotation, MCP, PKCE).

#### slack-ext app validate \<app_id\> --manifest=\<file\> [--json]

Validate a candidate manifest file (`apps.manifest.validate`). Each error is
rendered with its **JSON pointer** into the manifest, e.g.

```text
✗ [illegal_bot_scopes] Illegal bot scopes found `this:is:not:a:real:scope`
  pointer: /oauth_config/scopes/bot
```

Exits non-zero when the manifest is rejected. **A pass does not mean safe** — a
partial manifest validates `ok=true`, so the command tells you to run `app diff`
before applying anything.

#### slack-ext app diff \<app_id\> --manifest=\<file\> [--json]

Compare a candidate manifest against a fresh live export, leaf field by leaf
field, and report three separate buckets:

- **DELETIONS** — present live, absent in the candidate. Printed first, in red,
  with a warning that these fields would be removed and an explanation that
  arrays are replaced wholesale. Array entries count individually: `bot_events`
  going from `["channel_created","team_join"]` to `["channel_created"]` is
  reported as a deletion of `team_join`, not as a modification.
- **Modifications** — `pointer  old -> new`.
- **Additions** — fields and array entries the candidate adds.

An identical candidate prints "No changes". `--json` emits
`{deletions, additions, modifications, changed}` with a JSON pointer on every
entry. This is the command to run before any manual manifest edit is applied.

#### slack-ext app set-scopes \<app_id\> [--add=a,b] [--remove=c,d] [--confirm]

Add and/or remove bot scopes (`/oauth_config/scopes/bot`). Exports the live
manifest, adjusts that one array, and updates with the complete result; every
other field of the manifest travels back unchanged. Additions are appended in
order and duplicates are ignored; a `--remove` of a scope that is not present is
reported and changes nothing. At least one of `--add` / `--remove` is required,
and names are validated (`channels:read`-style) before anything is sent.

```bash
slack-ext app set-scopes A0123456789 --add=reactions:read            # dry run
slack-ext app set-scopes A0123456789 --add=reactions:read --confirm
slack-ext app set-scopes A0123456789 --remove=users:read.email --confirm
```

A removal you asked for does **not** need `--allow-deletions`. If the diff shows
any deletion outside `/oauth_config/scopes/bot`, the command refuses.

Almost always reports `permissions_updated: true` — **reinstall the app** before
expecting the new scope to work.

#### slack-ext app set-events \<app_id\> [--add=a,b] [--remove=c,d] [--confirm]

Same shape for subscribed bot events
(`/settings/event_subscriptions/bot_events`). Touches nothing else — in
particular not the scopes array, which is the failure this command's tests pin
down (`bot_events` and `scopes.bot` are both arrays that Slack replaces
wholesale). If the manifest has no `event_subscriptions` block yet, the path is
created and its siblings are left alone.

```bash
slack-ext app set-events A0123456789 --add=app_mention --confirm
slack-ext app set-events A0123456789 --remove=team_join --confirm
```

#### slack-ext app set-request-url \<app_id\> \<https url\> [--confirm]

Set `/settings/event_subscriptions/request_url`. Requires an `https://` URL.

**Slack verifies the URL immediately on save**: it posts a `url_verification`
challenge and rejects the update unless the endpoint echoes the `challenge` value
back. The endpoint must already be deployed and answering before this command is
run, otherwise the update fails and nothing changes.

#### slack-ext app apply \<app_id\> --manifest=\<file\> [--allow-deletions] [--confirm]

Apply a manifest file — the round trip for `app export --out=...`, edit, apply.

The diff shown is live-vs-FILE, so every field the file omits appears as a
deletion. Without `--allow-deletions` the command refuses when there is any, and
its payload is the file overlaid on a fresh export (so it could not delete
anything even if the gate were bypassed). With `--allow-deletions` the file is
sent as the complete manifest and the deletions take effect.

```bash
slack-ext app export A0123456789 --out=./manifest.json
$EDITOR ./manifest.json
slack-ext app diff  A0123456789 --manifest=./manifest.json     # review first
slack-ext app apply A0123456789 --manifest=./manifest.json --confirm
```

#### slack-ext app token-rotate [--refresh-token=\<tok\>] [--confirm] [--json]

Rotate the app configuration token pair via `tooling.tokens.rotate`. The refresh
token is read from `--refresh-token`, `$SLACK_APP_REFRESH_TOKEN`, or the skill
config key `appRefreshToken`.

**A rotate INVALIDATES the refresh token it consumes.** Consequences designed
around:

- `--confirm` is required even though nothing about the app changes, because a
  speculative rotate throws away a working credential. Rotate on demand, or in
  response to a `401`/`invalid_auth` — never "just in case".
- The new pair is written to the skill config (`appConfigToken`,
  `appRefreshToken`) **before anything else happens with it**. Between the API
  response and that write, the process holds the only usable copy of the
  credential: if it died there, only a human could mint a replacement.
- **If persisting fails, the new pair is printed to stdout.** Printing a secret
  is normally forbidden because output lands in the agent transcript, but the old
  refresh token is already dead at that point, so surfacing beats losing it. On
  the success path only masked forms are shown.
- `invalid_refresh_token` is reported with the single-use explanation: if the
  token was already rotated, the pair from *that* rotation is the live one.
- A response that is `ok` but missing either half of the pair is refused rather
  than treated as a rotation, so a partial response cannot make the CLI discard
  a still-valid credential.

### App manifest wire facts (verified live 2026-09-18)

- Requests are **form-encoded** (`application/x-www-form-urlencoded`); a JSON
  body is rejected with `invalid_arguments`. The `manifest` parameter is a JSON
  **string**.
- **Slack answers HTTP 200 with `ok:false` on failure** — a bogus bearer token
  returned HTTP 200 + `invalid_auth`, and a bad app id returned HTTP 200 +
  `invalid_app_id`. `body.ok` is the only verdict; reading the HTTP status would
  report every error as a success.
- `apps.manifest.export` and `apps.manifest.validate` both answer `not_authed`
  to an unauthenticated probe (a nonexistent method answers `unknown_method`),
  which is how the method names were confirmed without a credential.
- Sending `; charset=utf-8` on the content-type makes Slack add
  `warning: "superfluous_charset"` to the response body. Harmless.
