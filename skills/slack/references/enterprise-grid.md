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
  - [`channel-archive <channel_id> [--confirm] [--max-members=N] [--min-idle-days=N] [--allow-shared] [--json]`](#channel-archive-channel_id---confirm---max-membersn---min-idle-daysn---allow-shared---json)
  - [`channel-unarchive <channel_id> [--confirm] [--json]`](#channel-unarchive-channel_id---confirm---json)
- [Enterprise Grid Channel Admin (`admin.conversations.*`)](#enterprise-grid-channel-admin-adminconversations)
  - [POST /api/admin.conversations.archive](#post-apiadminconversationsarchive)
  - [POST /api/admin.conversations.unarchive](#post-apiadminconversationsunarchive)
  - [`admin.conversations.search` wire facts](#adminconversationssearch-wire-facts)
  - [How `slack-ext channel-archive` / `channel-unarchive` use these](#how-slack-ext-channel-archive--channel-unarchive-use-these)
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

#### `channel-archive <channel_id> [--confirm] [--max-members=N] [--min-idle-days=N] [--allow-shared] [--json]`

Archive a channel (`admin.conversations.archive`, org token; works on private channels the admin
is not in). The dry run reads and prints the current state and what `--confirm` would do;
`--confirm` re-reads it immediately before the write, refuses by name if a guard fails, then reads
the result back. Guards, check order, exit codes and wire facts: "Enterprise Grid Channel Admin" below.

#### `channel-unarchive <channel_id> [--confirm] [--json]`

Unarchive a channel (`admin.conversations.unarchive`), with the same dry run, pre-write re-check and
read-back. It does not restore Slack Connect connections that an archive cut (inferred, untested).

### Enterprise Grid Channel Admin (`admin.conversations.*`)

Used by `slack-ext channel-search`, `channel-to-public`, `channel-to-private`,
`channel-archive` and `channel-unarchive`. All take the **org-level** xoxc token
(`localStorage['localConfig_v2'].teams['E06V3987PMY'].token`) and go through
`browser.fetch` from the Slack tab like every other xoxc call. Calls are
indistinguishable from the admin doing it by hand in channel event history.

#### POST /api/admin.conversations.archive

Archive a channel. Used by `slack-ext channel-archive`.

| Param | Required | Description |
|-------|----------|-------------|
| token | yes | org-level xoxc token |
| channel_id | yes | Channel ID |

Measured 2026-09-25: works on **private channels the admin is not a member of**
and answers `{"ok":true}` with no warning. `ok:true` is not proof of the new
state; read it back through `admin.conversations.search` (below), with retries.

#### POST /api/admin.conversations.unarchive

Unarchive a channel. Used by `slack-ext channel-unarchive`. Same parameters and
token as `admin.conversations.archive`.

#### `admin.conversations.search` wire facts

Measured on the search method that `channel-archive` / `channel-unarchive` read state with. Its parameter
contract: `references/endpoints.md`, "Enterprise Grid channel search".

Wire facts (measured 2026-09-25 unless noted):

- **`channel_ids` is silently ignored** (2026-09-22): the response is the
  unfiltered list. Never filter with it.
- **`query` is not a reliable server-side filter.** Measured 2026-09-25:
  `query=concierge` (`search_channel_types=all`, `limit=20`) returned 2078
  channels over 105 pages, essentially the whole org; only 5 have "concierge" in
  their name. `query=zzqq-no-such-channel-xyz` returned 0. Always match results
  locally, and treat a search as complete only once `next_cursor` is empty: a
  cap on rows fetched before the local match silently drops matches (this is
  the `channel-search --max` bug).
- **`query=<channel id>` finds the channel.** 40 of 40 sampled channels
  (public, private including non-member, archived, ext-shared) came back for
  their own id, each as the only hit; `search_channel_types=all` is needed to
  include archived ones. A partial id matches nothing; a bogus id answers zero
  results. Still match on `id` locally.
- **`last_activity_ts` is microseconds** (16 digits): `1686690712432979` is
  2023-06-13T21:11:52.432Z. Divide by 1000 for JavaScript milliseconds.
- **`member_count` is `-1` for archived channels** (all 14 archived channels in
  the sample; also measured on 2026-09-25 ~13:20 UTC), not null or missing. Treat
  ANY negative or non-finite count, `null` and a missing field as unknown,
  never zero: a plain `members <= max` check would PASS `-1`. Check
  `is_archived` before any member guard, so an archived channel reads as
  already archived, not as an unknown count.
- **Archiving a Slack Connect channel we host disconnects every external
  organisation.** Measured on 5 of 5 channels (2026-09-25 ~13:20 UTC). Before:
  `is_ext_shared: true`, `external_user_count` 2 to 4, connected teams present.
  After `admin.conversations.archive`: `is_ext_shared: false`,
  `is_pending_ext_shared: false`, `external_user_count: 0`,
  `connected_team_ids: []`. `admin.conversations.unarchive` restores the channel
  but almost certainly NOT the connections, which would need a new Slack Connect
  invitation. That last point is an inference; it was not tested live.
- **External organisations** are `connected_team_ids` minus this org
  (`E06V3987PMY`) and its own workspaces (`internal_team_ids`,
  `context_team_id`), e.g. `["T0BQQL6FJ","E06V3987PMY","E08CP5WPXGT"]` is 2
  external orgs. Pending invitations are in `pending_connected_team_ids`. A missing
  or non-array list is **unknown** (`null` in the `--json` impact), and the text says
  the count could not be determined; it is never shown as 0.
- **`slack-ext channel-search --json` drops `is_ext_shared`,
  `is_pending_ext_shared` and `conversation_host_id`** (its `summarizeChannel`
  keeps neither). Anything that has to tell internal from shared or
  hosted-elsewhere channels must read the raw `admin.conversations.search`
  entry, as `channel-archive` does.
- **`conversation_host_id`** appears on ext-shared channels only. It equals the
  org id (`E06V3987PMY`) when this org hosts the channel; any other value is a
  channel hosted by another org.
- **The index lags a write, by up to ~50 s.** Right after
  `admin.conversations.archive` the channel was not reported archived. On the
  live round trip for `slack-ext channel-archive` (2026-09-25): an unarchive
  showed after ~5 s; an archive read `is_archived: false`, then the channel was
  **missing from the index entirely**, then `is_archived: true` 38 to 51 s after
  the write. `conversations.info` (public channel) showed it archived at once.
  A read-back has to retry (`slack-ext` uses 10 attempts, 10 s apart, 90 s) and
  report "unconfirmed", not "failed", when it runs out. A read right after an
  unarchive can still say archived, so a "nothing to do" answer that soon after
  a write can be stale.
- **Every write updates `last_activity_ts`** to the write time (both archive and
  unarchive, measured), so a channel archived today reads as 0 days idle.

#### How `slack-ext channel-archive` / `channel-unarchive` use these

**State read.** `admin.conversations.search` with `query=<channel id>`,
`search_channel_types=all`, `limit=20`, matched on `id` locally. On a miss:
`conversations.info` for the name (works for public channels and ones the admin
is in), then `query=<name>`. Up to 5 pages per query, never a full-org scan
(~104 calls at limit 20). **`not-found` is reported only after a complete
search.** Everything short of that fails the command (exit 1, "whether the
channel exists is UNKNOWN"), never a `not-found`: no body, `ok:false`, `ok:true`
without a `conversations` array (`malformed_response`), the page cap reached
with a cursor still pending (`lookup_truncated`), or `conversations.info`
failing with anything other than the expected `channel_not_found`, or
answering `ok:true` without this channel's `id` and a string `name`. A write
counts only when it answers `ok === true`. The helper
does not use `channel-search` and has no `--max`. `--json` emits a result
object on every path, including failures and zero matches.

**Flow.** Dry run: read, evaluate guards, print state and what `--confirm` would
do; never writes, exits 0. `--confirm`: the read IS the pre-write re-check
(nothing between it and the write), then guards, then the write, then the
read-back (10 attempts, 10 s apart, until `is_archived` flips).

| Refusal | When | Exit |
|---------|------|------|
| `not-found` | no channel with this id in search | 1 |
| `already-archived` / `not-archived` | nothing to do, no write | **0** |
| `sharing-unknown` | `is_ext_shared` or `is_pending_ext_shared` missing or not a boolean (never read as "not shared") | 1 |
| `ext-shared-hosted-elsewhere` | ext-shared, `conversation_host_id` is not this org | 1 |
| `ext-shared-host-unknown` | ext-shared, no `conversation_host_id` | 1 |
| `ext-shared-requires-allow-shared` | archive only: ext-shared, hosted by this org, no `--allow-shared` | 1 |
| `members-unknown` | `--max-members` given, count null / missing / negative (`-1`) / non-finite | 1 |
| `members-over-limit` | `--max-members` given, count greater than N | 1 |
| `activity-unknown` | `--min-idle-days` given, `last_activity_ts` missing or unparseable | 1 |
| `active-recently` | `--min-idle-days` given, idle fewer than N days | 1 |
| `archived-unknown` | Slack did not report `is_archived` | 1 |

**`sharing-unknown` also covers contradictions.** When `is_ext_shared` and
`is_pending_ext_shared` are both `false` but the same row reports a positive
`external_user_count`, an external team in `connected_team_ids` or
`pending_connected_team_ids`, or any `conversation_host_id`, the two flags are not
trusted: the channel is `sharing-unknown` and both commands refuse (`--allow-shared`
does not override it), naming the evidence (`sharing_conflicts` in `--json`). A consistent
non-shared row never trips this (measured: no host id on 25 of 25 non-ext-shared
channels; `connected_team_ids` null and 0 external users on the non-shared channels read).
Trade-off: whether an archive leaves `conversation_host_id` on a formerly shared channel was
not measured; if it does, `channel-unarchive` refuses that channel, and it has to be
unarchived in the Slack admin UI.

**Arguments fail closed.** Before any Slack call, on the dry run and with
`--confirm` alike, every flag name is checked against an allow-list: the
command's own flags plus the globals `--ws`, `--workspace`, `--org`, `--json`,
`--confirm`, `--help`. `parseArgv` keeps unknown flags, so without this a typo
such as `--max-member=2` left the real guard unset and a confirmed archive
went ahead without it. Refusals, all exit 1: `unknown-flag: --max-member (did
you mean --max-members?)`; `invalid-value` for a guard that is not a plain
non-negative integer (`abc`, empty, `-3`, `2.5`, or no value); `unexpected-argument`
for a stray word such as `max-members=2`; `archive-only-flag` for a guard given to
`channel-unarchive`.

**`--json` is one JSON document.** With `--json`, stdout carries only the result
object on every path (dry run, refusal, success, unconfirmed, write error,
read error, argument error, no Slack tab), with `status`, `exitCode` and the
attribution notice as `notice`. Error text also goes to stderr.

Write results: `archived (confirmed)` exit 0; `archived (unconfirmed: search
index did not reflect it after N attempts)` exit 3 (`ok:true` was returned; run
the dry run again later); the API error exit 1.

**Why `--allow-shared`:** archiving a Slack Connect channel this org hosts
disconnects every external organisation (measured, above), and unarchiving is
not expected to reconnect them. The archive is therefore not fully reversible
for a shared channel, and `member_count` / idle days say nothing about who on
the partner side still depends on it. Without the flag the command refuses with
`ext-shared-requires-allow-shared`; with it, the dry run and the confirm output
both say, in plain words, "Archiving will disconnect N external users from M
external organisations (...). Unarchiving will NOT reconnect them: that needs a
new Slack Connect invitation." The `--json` result carries the same as
`impact` (`external_users`, `external_team_ids`, `pending_external_team_ids`,
`reversible: false`), and the confirm output prints the sharing state read
back after the write. `channel-unarchive` takes no `--allow-shared`; its dry run
notes that connections a previous archive cut are not expected to come back.

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
