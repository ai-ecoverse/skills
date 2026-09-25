# Slack Enterprise Grid admin commands (`slack-ext`)

Reference for the `slack-ext eg-*`, `channel-*`, `approvals` and `admin-app` commands
summarised in SKILL.md ("Enterprise Grid admin commands"). Read SKILL.md's
"CRITICAL: audit attribution" first: every write here is indistinguishable from the
human doing it by hand.

## Contents

- [Authentication](#authentication)
- [Dry-run default](#dry-run-default)
- [Enterprise user lifecycle](#enterprise-user-lifecycle)
  - [`eg-status <user_id> [--json]`](#eg-status-user_id---json)
  - [`eg-set-restricted <user_id> [--confirm]`](#eg-set-restricted-user_id---confirm)
  - [`eg-set-regular <user_id> [--confirm]`](#eg-set-regular-user_id---confirm)
  - [`eg-deactivate <user_id> [--confirm]`](#eg-deactivate-user_id---confirm)
  - [`eg-forget <user_id> [--confirm]`](#eg-forget-user_id---confirm)
  - [`eg-bulk-guest [<user_id>...] [--file=<path>] [--confirm]`](#eg-bulk-guest-user_id---filepath---confirm)
  - [`eg-set-ultra-restricted <user_id> [--confirm]`  — **UNVERIFIED**](#eg-set-ultra-restricted-user_id---confirm---unverified)
- [Channel management](#channel-management)
  - [`channel-search [--query=<q>] [--limit=<n>] [--max=<n>] [--types=<t>] [--sort=<s>] [--sort-dir=<d>] [--json]`](#channel-search---queryq---limitn---maxn---typest---sorts---sort-dird---json)
  - [`channel-to-public <channel_id> [--confirm]`](#channel-to-public-channel_id---confirm)
  - [`channel-to-private <channel_id> [--confirm]`](#channel-to-private-channel_id---confirm)
- [Slack Connect approvals](#slack-connect-approvals)
  - [`approvals [--query=<q>] [--limit=<n>] [--all] [--json]`](#approvals---queryq---limitn---all---json)
- [App governance](#app-governance)
  - [`admin-app approve <app_id|request_id> [--confirm]`](#admin-app-approve-app_idrequest_id---confirm)
  - [`admin-app restrict <app_id|request_id> [--confirm]`](#admin-app-restrict-app_idrequest_id---confirm)
  - [`admin-app clear <app_id> [--confirm]`](#admin-app-clear-app_id---confirm)
  - [`admin-app permissions <app_id> --type=<no_one|everyone|named_entities> [--confirm]`](#admin-app-permissions-app_id---typeno_oneeveryonenamed_entities---confirm)
  - [`admin-app list [--restricted] [--json]`](#admin-app-list---restricted---json)
- [What remains unverified](#what-remains-unverified)

### Authentication

Enterprise Grid commands use the org-level `xoxc` token from the browser's `localStorage`,
at key `teams['E06V3987PMY'].token`. The `xoxc` token is only valid together with the
browser's `d` session cookie, so calls **must** go through the browser tab via
`browser.fetch` (same-origin XHR). `SLICC`'s own `fetch()` strips cookies and would
silently fail. This is the same mechanism as every other `slack-ext` command.

### Dry-run default

Every mutating command defaults to dry-run and requires `--confirm` to act. The dry-run
output shows exactly which API method would be called and with which parameters.

---

### Enterprise user lifecycle

#### `eg-status <user_id> [--json]`

Show a user's enterprise-level state. **Read-only**; no `--confirm`.

- API: `users.info` with the org-level token (parameter `user`)
- Prints name and id, handle, type (regular / multi-channel guest / single-channel guest /
  bot / deactivated) and, from `enterprise_user`, the org (`enterprise_name`, `enterprise_id`)
  and its workspaces (`teams`). `--json` also prints the raw `user` object.
- `user_not_found` is reported as "User not found: <user_id>".

#### `eg-set-restricted <user_id> [--confirm]`

Make a full member a **multi-channel guest** at the org level.

- API: `enterprise.users.admin.setRestricted`
- Parameter: `user` (just the user ID — no `team_id`)
- Verified: `{"ok":true}` observed from the UI. Bogus-user probe → `user_not_found`.
- Reads back `users.info` after the call. `{"ok":true}` alone is not treated as evidence.
- Observed `_x_reason=enterprise-set-multi-channel-guest` from the UI.

#### `eg-set-regular <user_id> [--confirm]`

Promote a guest back to a **full member** at the org level.

- API: `enterprise.users.admin.setRegular`
- Parameter: `user`
- Verified: `{"ok":true}` observed. Bogus-user probe → `user_not_found`.
- Reads back `users.info` after the call.
- Observed `_x_reason=OrgMembers_setToMember`.

#### `eg-deactivate <user_id> [--confirm]`

**Deactivate** a user account (reversible).

- API: `enterprise.users.admin.setStatus` with `status=delete`
- **THE STATUS=DELETE TRAP:** `status=delete` means **deactivate** (the user is disabled
  and cannot sign in). It does NOT permanently delete the account. The account is
  recoverable. The value `"delete"` is the wire string observed from the live UI;
  changing it to `"inactive"`, `"disabled"`, or anything else calls a different operation.
- The reactivation `status` value is **NOT KNOWN**. Do not guess it.
- Verified: `{"ok":true}` observed. Bogus-user probe → `invalid_user` (different from
  `user_not_found` — this endpoint validates the user field differently).
- Observed `_x_reason=deactivateMembers`.

#### `eg-forget <user_id> [--confirm]`

**GDPR-style permanent identity scrub. IRREVERSIBLE.**

- API: `users.admin.profileDeidentify` (workspace-level namespace, org-wide effect)
- Effect: `real_name` → `"Deactivated User"`, handle → `"deactivateduser<N>"`,
  guest flags cleared. The user's messages remain but lose author attribution.
- **CANNOT BE UNDONE.** There is no support ticket that restores it.
- Design decision: this is its own command and **must never be a flag on `eg-deactivate`**
  and **must never run inside an unattended bulk loop without per-user confirmation.**
  The `--confirm` flag is the confirmation; the dry-run output names the user explicitly.
- Verified: `{"ok":true}` observed. Bogus-user probe → `user_not_found`.
- Observed `_x_reason=forget-user`.

#### `eg-bulk-guest [<user_id>...] [--file=<path>] [--confirm]`

Convert a list of full members to multi-channel guests. The primary motivating use case is
converting 14 vendor accounts that are currently full members.

- API: `enterprise.users.admin.setRestricted` called once per user
- Input: space-separated user IDs as positional arguments, or `--file=<path>` (one ID per
  line; lines starting with `#` are comments).
- Per-user read-back: each user's type is confirmed via `users.info` after the call.
  `{"ok":true}` alone is not accepted as evidence.
- Already-guests are no-ops. Bots are skipped with a warning. Errors are collected and
  reported in the final summary; the command continues to the next user rather than aborting.

Example:

```bash
# Dry run first
slack-ext eg-bulk-guest U12345 U67890 UABCDE --org=E06V3987PMY

# With a file
echo "U12345\nU67890\nUABCDE" > vendors.txt
slack-ext eg-bulk-guest --file=vendors.txt

# Confirm
slack-ext eg-bulk-guest --file=vendors.txt --confirm
```

#### `eg-set-ultra-restricted <user_id> [--confirm]`  — **UNVERIFIED**

Make a single-channel guest at the org level.

- API: `enterprise.users.admin.setUltraRestricted`
- **UNVERIFIED:** The endpoint is real (bogus-user probe → `user_not_found`, not
  `unknown_method`), but `{"ok":true}` was **never observed** from a live admin UI session.
  The parameter shape (just `user`, no `channel`) is a best-effort inference from the
  method naming pattern.
- **Do not use in production** until the method has been confirmed to produce the expected
  state change against a real account.
- Clearly marked in code comments and in the command output.

---

### Channel management

#### `channel-search [--query=<q>] [--limit=<n>] [--max=<n>] [--types=<t>] [--sort=<s>] [--sort-dir=<d>] [--json]`

Enumerate channels using `admin.conversations.search`.

**Observed parameters (2026-09-22):**

| Parameter | Values | Notes |
|-----------|--------|-------|
| `search_channel_types` | `exclude_archived` \| `all` \| `private` \| `private_exclude` \| `archived` | Materially changes results: `all` → 2072, `exclude_archived` → 1515. Default: `exclude_archived`. Lars Trieloff observed omitting this returns `invalid_arguments` in the UI path; the API appears to default internally but the param should always be included explicitly. |
| `sort` | `name` \| `member_count` \| `created` | `last_activity_ts` and `num_members` return `invalid_sort` (probed live). |
| `sort_dir` | `asc` \| `desc` | |
| `query` | any string, including empty | |
| `cursor` | any string, including empty | |

**`--types` shorthand in this command:** `--types=all`, `--types=private`, `--types=archived`, etc.

**Measured defect: `channel_ids` parameter is silently ignored.** Passing
`channel_ids=C0634KMGW2G` (bare string) and `channel_ids=["C0634KMGW2G"]` (JSON array) both
returned `{"ok":true}` with the **unfiltered full list** starting at `#general`. The
command never passes `channel_ids`; it enumerates with cursor pagination and filters locally.

**`archived` search_channel_types caveat:** Lars observed `archived` returning 0 results for
a query that both `all` and `exclude_archived` matched. A probe on 2026-09-22 showed `archived`
returning 1 result for the same query (a genuinely archived channel). The discrepancy may be
query-specific. Do not treat a 0-result `archived` response as proof a channel was never archived.

Response fields per channel: `id`, `name`, `purpose`, `member_count`, `external_user_count`,
`channel_manager_count`, `created`, `creator_id`, `is_private`, `is_archived`, `is_general`,
`last_activity_ts`.

#### `channel-to-public <channel_id> [--confirm]`

Convert a private channel to public.

- API: `admin.conversations.convertToPublic`
- Parameter: `channel_id` (verified live 2026-09-22; bogus ID → `channel_not_found`)

#### `channel-to-private <channel_id> [--confirm]`

Convert a public channel to private.

- API: `admin.conversations.convertToPrivate`
- Parameter: `channel_id`
- **PRIVATE CHANNEL INVISIBILITY:** after converting to private, the channel becomes
  invisible to any caller who is not a member:
  - `conversations.info` returns `channel_not_found`
  - `conversations.genericInfo` returns `{"ok":true}` with an **empty array**
  - The edge cache returns the channel id under `failed_ids`
  
  This is **expected behaviour**, not a sign that the channel was deleted. The command warns
  about this and suggests using `channel-search` to confirm the channel still exists.

---

### Slack Connect approvals

#### `approvals [--query=<q>] [--limit=<n>] [--all] [--json]`

List Slack Connect shared channel invite approvals.

- API: `conversations.sharedApprovals.list`
- Sort: `date_expire` descending (most-recently-expiring first)
- Paginates automatically via `response_metadata.next_cursor`
- Response per approval: `id` (e.g. `I0C3EKRE3S5`), `connecting_team{id,name,icon}`,
  `channel{name}`, `status`, `date_expire`
- Verified live: 977 total approvals in the org at time of measurement.
- `--all` removes the default 200-item cap. Use with care on large orgs.

---

### App governance

#### `admin-app approve <app_id|request_id> [--confirm]`

Approve an app for the org.

- API: `admin.apps.approve`
- Accepts a pending install `request_id` (starts with `I`) **or** an `app_id` (starts with
  `A`) + the org's `enterprise_id`.
- **SINGLE-USE `request_id`:** a `request_id` can only be resolved **once**. Approving an
  already-resolved `request_id` returns `{"ok":false,"error":"request_already_resolved"}`.
  The command surfaces this error rather than swallowing it. To reverse a resolution, use
  the `app_id` form.

#### `admin-app restrict <app_id|request_id> [--confirm]`

Restrict an app for the org. Same single-use `request_id` caveat applies.

- API: `admin.apps.restrict`
- `request_already_resolved` is surfaced explicitly with instructions to use `app_id` instead.

#### `admin-app clear <app_id> [--confirm]`

Clear the current approval or restriction decision for an app.

- API: `admin.apps.clearResolution`
- Parameters: `app_id` + `enterprise_id`

#### `admin-app permissions <app_id> --type=<no_one|everyone|named_entities> [--confirm]`

Set the install-permission policy for an app.

- API: `admin.apps.permissions.set`
- Observed valid `permission_type` values: `no_one`, `everyone`, `named_entities`
- Response echoes `{ok, permission_type, channel_restriction_mode}`

#### `admin-app list [--restricted] [--json]`

List approved or restricted apps.

- API: `admin.apps.approved.list` (default) or `admin.apps.restricted.list` (with `--restricted`)
- Parameter: `enterprise_id` + `limit`
- Entry shape: `{app:{id,name,…}, scopes, date_updated, last_resolved_by, domains}`
- Paginates automatically.

---

### What remains unverified

| Item | Status | Reason |
|------|--------|--------|
| `enterprise.users.admin.setUltraRestricted` | Endpoint real, behaviour unverified | Probe returns `user_not_found` (not `unknown_method`), but `{"ok":true}` was never observed from the UI. Parameter shape unknown. |
| `enterprise.users.admin.setStatus` reactivation value | Unknown | The deactivation value `"delete"` was observed. The reactivation value was not. Do not guess. |
| `admin.apps.permissions.set` with `named_entities` entity list | Partial | The method and three `permission_type` values are verified. The additional parameters for specifying named entities in `named_entities` mode were not observed. |
