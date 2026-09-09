---
name: gcloud
description: Interact with Google Cloud Platform from the command line via the `gcloud` CLI — list projects, Compute Engine instances, Cloud Storage buckets, enabled services (APIs), and Cloud Run services, manage Cloud DNS zones, records and change history, query Cloud Logging entries including audit logs, or make authenticated raw calls to any Google Cloud REST API. Authenticates by reusing the Google Cloud SDK's own public OAuth client through `oauth-token --intercept`, so a human completes the Google consent screen once and tokens auto-refresh thereafter — no service account key needed. Use whenever the user mentions Google Cloud, GCP, gcloud, Compute Engine, Cloud Storage, Cloud Run, Cloud DNS change history, Cloud Logging, audit logs, who changed or deleted a DNS record, or wants to automate anything on Google Cloud without the Cloud Console. Activate on "gcloud", "google cloud", "GCP", "gcs bucket", "cloud run", "dns change history", "audit log", "who deleted this record", or related Google Cloud workflows.
allowed-tools: bash
command: gcloud
script: scripts/gcloud.jsh
---

# Google Cloud (gcloud) Skill

A `.jsh` CLI implementing a useful subset of the Google Cloud REST APIs. It
authenticates the same way the real `gcloud` CLI does — by driving Google's
OAuth authorization-code flow against the **Cloud SDK's own public OAuth
client** — but the interactive browser step is handled by SLICC's
`oauth-token --intercept`.

## Step 1: Log in (once)

```bash
gcloud login
```

This opens a browser tab at Google's consent screen. A human signs in and
approves the requested scopes (`cloud-platform`, `userinfo.email`, `openid`).
`oauth-token --intercept` captures the loopback redirect
(`http://127.0.0.1:8085/?code=…`), the script exchanges the authorization code
for tokens, and stores the **refresh token** in the skill config. Access tokens
are minted on demand and auto-refresh — you only re-run `gcloud login` if the
refresh token is revoked.

Verify:

```bash
gcloud whoami
```

## Step 2: Set a default project

Most calls need a project. Set one so you don't pass `--project` every time:

```bash
gcloud config set-project my-project-id
gcloud config              # show active config
```

Override per-call with `--project <id>` (or `-p`).

## Commands

| Command | What it does |
|---|---|
| `gcloud login` | Google consent → store refresh token |
| `gcloud whoami` | Show authenticated identity + active project |
| `gcloud logout` | Revoke and clear stored tokens |
| `gcloud config` | Show active config |
| `gcloud config set-project <id>` | Set default project |
| `gcloud projects list` | Projects you can access (Cloud Resource Manager) |
| `gcloud instances list [--zone Z]` | Compute Engine instances (aggregated across zones) |
| `gcloud zones list` | Compute Engine zones |
| `gcloud buckets list` | Cloud Storage buckets |
| `gcloud services list` | Enabled APIs (Service Usage) |
| `gcloud services enable <api.googleapis.com> --confirm` | Enable an API on the project |
| `gcloud run list [--region R]` | Cloud Run services (`R` defaults to all) |
| `gcloud dns zones list` | Managed DNS zones |
| `gcloud dns zones create <name> --dns-name <domain.> --confirm` | Create a managed zone |
| `gcloud dns records list <zone> [--name N] [--type T]` | List record sets in a zone |
| `gcloud dns records add <zone> <name> <type> <data>... [--ttl 300] --confirm` | Add/replace a record set |
| `gcloud dns records add <zone> <name> <type> --routing-policy wrr --routing-policy-data "W:rrdata;W:rrdata" --confirm` | Add/replace a weighted round-robin record set |
| `gcloud dns records remove <zone> <name> <type> --confirm` | Delete a record set |
| `gcloud dns changes list <zone> [--limit 20] [--since ISO8601]` | Cloud DNS change history (record diffs) for a zone |
| `gcloud dns logging status <zone>` | Show whether query logging is enabled for a zone |
| `gcloud dns logging enable <zone> --confirm` | Enable Cloud DNS query logging on a zone |
| `gcloud dns logging disable <zone> --confirm` | Disable query logging on a zone |
| `gcloud logging read <filter> [--limit 20] [--since ISO8601] [--max-pages 25]` | Cloud Logging entries (e.g. audit logs) matching a filter |
| `gcloud billing accounts list` | Billing accounts you can access |
| `gcloud billing accounts describe <ACCOUNT_ID>` | Details for one billing account |
| `gcloud billing accounts get-iam-policy <ACCOUNT_ID>` | IAM bindings on a billing account |
| `gcloud billing projects list <ACCOUNT_ID>` | Projects linked to a billing account |
| `gcloud billing projects describe <PROJECT_ID>` | A project's billing link + enabled state |
| `gcloud billing projects link <PROJECT_ID> --billing-account <ACCOUNT_ID> --confirm` | Link a project to a billing account |
| `gcloud billing projects unlink <PROJECT_ID> --confirm` | Remove a project's billing link |
| `gcloud api [METHOD] <full-url> [--data <json>]` | Authenticated raw call to any Google API |

All commands accept `--json` for raw output, and `--project <id>` to override
the active project. The gcloud-style two-word forms also work
(`gcloud compute instances list`, `gcloud auth login`, `gcloud auth status`).

**Flag values must use long flags** (`--project X`, `--zone X`, `--region X`,
`--type X`): the runtime's flag parser treats single-dash short flags as
booleans and never captures a following value, so short aliases are not
offered.

### Cloud DNS

Cloud DNS is the primary use case. Managed zones and record sets are read
freely; all **mutations require `--confirm`** and print a colored diff preview
otherwise:

```bash
gcloud services enable dns.googleapis.com --confirm     # if not already enabled
gcloud dns zones list
gcloud dns records list my-zone --type A
# add or replace (upsert): looks up any existing rrset of the same name+type
# and swaps it in a single atomic change
gcloud dns records add my-zone www.example.com A 203.0.113.10 --ttl 300 --confirm
gcloud dns records add my-zone example.com TXT "v=spf1 include:_spf.google.com ~all" --confirm
gcloud dns records remove my-zone old.example.com CNAME --confirm
```

`dns zones list` also prints each zone's `labels` (when it has any) — these
are load-bearing in some setups (e.g. selecting which zones a monitoring
workflow watches), so they're no longer visible only via `--json`.

Names are normalized to FQDNs (a trailing dot is appended if missing), and TXT
values are auto-quoted. `add` is an upsert — it replaces an existing record set
of the same name+type in one transactional change (Cloud DNS requires
delete-then-add), so you don't have to remove first.

Records that use a **routing policy** (weighted round-robin, geo-location, or
primary/backup failover) carry an empty top-level `rrdatas` and stash their real
targets under `routingPolicy`. `records list` surfaces these — e.g. a weighted
CNAME prints each item's weight and target (weight `0` is flagged as inactive) —
so a routed record no longer renders as a blank line. Use `--json` for the raw
`routingPolicy` structure. The `--confirm` **change preview** also renders the
routing policy of both the record being deleted and the one being added, so
flattening or restoring a weighted record shows exactly what changes.

**Weighted round-robin (WRR) records.** `records add` can create a weighted
record, not just a plain one — pass `--routing-policy wrr` with
`--routing-policy-data "WEIGHT:rrdata[,rrdata];WEIGHT:rrdata…"` (`;` separates
weighted groups, `,` separates rrdatas sharing a weight):

```bash
# Flatten a mostly-inactive WRR wildcard to a fixed CNAME (cheaper: plain queries
# bill as "DNS Query" $0.40/M vs "Routing Policy Query" $0.70/M):
gcloud dns records add my-zone '*.example.com.' CNAME target.example.net. --ttl 300 --confirm

# Reconstruct the weighted policy (rollback), e.g. 100% weight to one target:
gcloud dns records add my-zone '*.example.com.' CNAME --routing-policy wrr \
       --routing-policy-data "0:backup.example.net.;1:primary.example.net." --ttl 300 --confirm
```

Because `add` is an upsert that deletes the existing rrset (routing policy and
all) before adding the new one, the same command flattens WRR→plain **and**
restores plain→WRR — the conversion is fully reversible with the skill.

**Query logging.** `gcloud dns logging status <zone>` reports whether a managed
zone records DNS queries (via the zone's `cloudLoggingConfig.enableLogging`
flag). `enable`/`disable` toggle it and, like every mutation, require
`--confirm` — without it they print a preview only. Enabling logging is not
free: DNS query logs bill through Cloud Logging ingestion at $0.50/GiB after the
first 50 GiB/project/month (the enable preview repeats this so it isn't a
surprise).

```bash
gcloud dns logging status hlx-live
gcloud dns logging enable hlx-live --confirm
gcloud dns logging disable hlx-live --confirm
```

**Change history.** `gcloud dns changes list <zone>` shows Cloud DNS's own
change log for a managed zone — every `changes` resource Cloud DNS recorded,
each with a `startTime`, `id`, `status`, and the additions/deletions that made
up that change (rendered the same way as `records list`, including routing-
policy targets for weighted/geo/failover records). This is **not** the same
thing as query logging above: `dns logging` toggles whether individual DNS
*queries* get logged; `dns changes list` is the zone's built-in history of
*configuration changes* (record adds/removes), and needs no logging enabled at
all — Cloud DNS keeps it regardless.

```bash
gcloud dns changes list aem-live --limit 5
gcloud dns changes list aem-live --since 2026-09-01T00:00:00Z
gcloud dns changes list aem-live --json
```

The underlying `managedZones.changes.list` API has no server-side time filter,
so `--since` is applied client-side against each change's `startTime`. Results
come back sorted descending by `changeSequence` (newest first), so the command
stops paging as soon as it sees a change older than `--since` rather than
walking the zone's entire history. `--limit` (default 20) caps how many
changes are fetched/printed independent of `--since`.

### Cloud Logging

`gcloud logging read <filter>` lists Cloud Logging entries for the active
project — the main use case is audit-log forensics (who did what, when):

```bash
gcloud logging read 'protoPayload.methodName="dns.managedZones.delete"' --limit 10
gcloud logging read 'logName="projects/helix-225321/logs/cloudaudit.googleapis.com%2Factivity" AND protoPayload.methodName="dns.managedZones.delete"'
gcloud logging read 'severity>=ERROR' --since 2026-09-01T00:00:00Z --json
```

The `filter` is the same
[Cloud Logging query language](https://cloud.google.com/logging/docs/view/logging-query-language)
`gcloud logging read`/the Console's Logs Explorer use. **Gotcha:** inside a
`logName=` clause the `/` in the log id must be percent-encoded as `%2F` —
`cloudaudit.googleapis.com/activity` becomes
`cloudaudit.googleapis.com%2Factivity` — otherwise Cloud Logging silently
treats it as a different (non-matching) string. `--since` is folded into the
filter as `timestamp>="<ISO>" AND (<your filter>)`; it isn't a separate API
parameter.

Rendering: audit-log entries (`protoPayload`) show `timestamp`, `severity` (if
present), the principal email, `methodName`, and `resourceName`. Other entries
fall back to `textPayload`/`jsonPayload`. `--json` returns the raw entry
objects.

**Pagination is sparse — read this before assuming "no results" is real.**
`entries:list` does not reliably put matching entries on the first page it
returns, even when a filter matches only a couple of entries in the whole
project. Verified live against `helix-225321`: a filter matching exactly 2
entries returned **15 consecutive pages containing only a `nextPageToken` and
no `entries` key at all**, with the 2 matching entries only appearing on the
**16th** page. `logging read` therefore keeps following `nextPageToken` until
it is empty, `--limit` is satisfied, or `--max-pages` (default 25) is hit —
never stopping just because one page came back empty. If the page cap is what
stopped the search, the command says so explicitly (`Stopped after --max-pages
N pages…`) instead of implying the result set is complete; raise `--max-pages`
to search further back.

### Cloud Billing

`gcloud billing` mirrors the Cloud Billing API. `accounts list/describe/
get-iam-policy` and `projects list <ACCOUNT_ID>` operate on billing **account**
resources and therefore need billing-account-level IAM (e.g. *Billing Account
Viewer*) — without it `accounts list` returns an empty list (printed as "No
billing accounts accessible."), which is normal, not an error.

```bash
gcloud billing accounts list
gcloud billing accounts describe 002EE3-CC6C9E-B2B150   # prefix optional
gcloud billing projects list 002EE3-CC6C9E-B2B150       # linked projects
gcloud billing projects describe my-project-id          # this project's link
gcloud billing projects link   my-project-id --billing-account 002EE3-CC6C9E-B2B150 --confirm
gcloud billing projects unlink my-project-id --confirm
```

`projects describe <PROJECT_ID>` works with ordinary **project-level** access —
it reads the project's `billingInfo` (billing account name + whether billing is
enabled). Account IDs may be given with or without the `billingAccounts/`
prefix; it is normalized either way. `link`/`unlink` mutate billing and are
`--confirm`-gated with a preview.

Note: this API exposes billing **configuration**, not **cost**. Per-project
spend (dollar amounts, usage breakdowns) is **not** available through the public
Cloud Billing API. The supported programmatic source is the BigQuery billing
export (needs the export enabled + BigQuery read access). Alternatively, for
cost **and usage** without any billing-account IAM, see
[`gcloud-ext billing cost`](#gcloud-ext-slicc-only-cost-and-usage-reports) below,
which replays the Cloud Console's own report API from a logged-in browser
session (project-level `billing.resourceCosts.get` is sufficient — the same
permission the Console UI uses).

### Raw API access

For anything not wrapped above, `gcloud api` attaches a valid Bearer token to a
request against any Google Cloud REST endpoint:

```bash
gcloud api GET  "https://cloudresourcemanager.googleapis.com/v1/projects/my-project-id"
gcloud api POST "https://compute.googleapis.com/compute/v1/projects/P/zones/Z/instances/I/start"
gcloud api PATCH "https://.../resource" --data '{"field":"value"}'
```

## gcloud-ext: SLICC-only cost and usage reports

The real `gcloud` CLI has no command for cost/usage reports (Google offers them
only via the Cloud Console UI or a BigQuery billing export). To keep `gcloud`
command-compatible with the upstream tool, that capability lives in a separate
binary, **`gcloud-ext`** (`scripts/gcloud-ext.jsh`).

```bash
gcloud-ext billing cost --project helix-225321
gcloud-ext billing cost --project helix-225321 --group-by sku
gcloud-ext billing cost --project P --group-by sku --from 2026-07-01 --to 2026-07-26 --json
```

`billing cost` reports per-service or per-SKU **cost and usage** for a project
over a date range (defaults to the current month). With `--group-by sku` it
includes the usage amount per SKU — e.g. actual DNS query counts:

```
Networking Cloud DNS Routing Policy Query   $2473.35  net $1978.68  6066731525 count
DNS Query (port 53)                          $171.85  net $137.48    429635772 count
```

**How it works / requirements.** Google exposes cost data only through the
Console's private first-party API (`cloudconsole-pa.clients6.google.com`),
authenticated with a session `SAPISIDHASH` rather than an OAuth Bearer token.
`gcloud-ext` therefore runs the request **inside a logged-in
`console.cloud.google.com` browser tab** (via the `sliccy:browser` bridge),
signing it with the session cookie. Requirements:

- An open, signed-in GCP Console tab (any page under `console.cloud.google.com`).
- Project-level **`billing.resourceCosts.get`** (what the Console UI itself
  uses) — **no** billing-account IAM and **no** BigQuery export required.

The billing account is resolved automatically from the project (override with
`--billing-account ID`). Use `--json` for machine-readable output.

> This relies on a **private, undocumented** Console API. Google may change the
> query signature, API key, or schema without notice. If `billing cost` breaks,
> re-capture the `BillingReportsEntityService … BillingData` request from
> Billing → Reports in the Console and update the constants at the top of
> `scripts/gcloud-ext.jsh`.

## How authentication works

The Google Cloud SDK ships a **public "desktop app" OAuth client** — its client
id and secret are compiled into the gcloud source
(`CLOUDSDK_CLIENT_ID` = `32555940559.apps.googleusercontent.com`,
`CLOUDSDK_CLIENT_NOTSOSECRET`). Desktop clients are non-confidential by design:
Google protects them with loopback redirect-URI matching, not by keeping the
"secret" secret. This skill reuses that client so that completing the normal
Google consent screen yields a real `cloud-platform`-scoped token — exactly the
credential `gcloud auth login` produces — without registering a new OAuth app or
provisioning a service account key.

- Authorize endpoint: `https://accounts.google.com/o/oauth2/auth`
- Token endpoint: `https://oauth2.googleapis.com/token`
- Redirect: `http://127.0.0.1:8085/` (loopback; captured by `oauth-token --intercept`)
- Scopes: `openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform`

If Google ever rotates the Cloud SDK client credentials, update the `CLIENT_ID`
/ `CLIENT_SECRET` constants at the top of `scripts/gcloud.jsh` from the current
gcloud source.

### Security notes

- The authorization-code flow here does **not** use PKCE (SLICC's intercept
  mode can't inject an authorize-side `code_challenge`). The captured `code` is
  handled entirely inside the script and exchanged immediately — it is never
  printed to stdout — which keeps the exposure window minimal. See the gmail
  skill's `references/oauth-bootstrap.md` for the fuller discussion of this
  trade-off for public clients.
- Tokens live in the skill config, not in stdout. `gcloud logout` revokes the
  refresh token at Google and clears local state.
- The consent screen will show "Google Cloud SDK" as the requesting app,
  because that is the client being reused.
