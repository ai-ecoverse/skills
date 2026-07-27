---
name: gcloud
description: Interact with Google Cloud Platform from the command line via the `gcloud` CLI — list projects, Compute Engine instances and zones, Cloud Storage buckets, enabled services (APIs), and Cloud Run services, or make authenticated raw calls to any Google Cloud REST API. Authenticates by reusing the Google Cloud SDK's own public OAuth client through `oauth-token --intercept`, so a human completes the standard Google consent screen once and tokens auto-refresh thereafter — no service account key or pre-provisioned secret needed. Use whenever the user mentions Google Cloud, GCP, gcloud, Compute Engine, GCE, Cloud Storage, GCS buckets, Cloud Run, Google Cloud projects, enabled APIs/services, or wants to query or automate anything on Google Cloud without clicking through the Cloud Console. Activate on "gcloud", "google cloud", "GCP", "compute engine", "gcs bucket", "cloud run", "my gcp projects", "list instances", or related Google Cloud workflows.
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
| `gcloud dns records remove <zone> <name> <type> --confirm` | Delete a record set |
| `gcloud dns logging status <zone>` | Show whether query logging is enabled for a zone |
| `gcloud dns logging enable <zone> --confirm` | Enable Cloud DNS query logging on a zone |
| `gcloud dns logging disable <zone> --confirm` | Disable query logging on a zone |
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

Names are normalized to FQDNs (a trailing dot is appended if missing), and TXT
values are auto-quoted. `add` is an upsert — it replaces an existing record set
of the same name+type in one transactional change (Cloud DNS requires
delete-then-add), so you don't have to remove first.

Records that use a **routing policy** (weighted round-robin, geo-location, or
primary/backup failover) carry an empty top-level `rrdatas` and stash their real
targets under `routingPolicy`. `records list` surfaces these — e.g. a weighted
CNAME prints each item's weight and target (weight `0` is flagged as inactive) —
so a routed record no longer renders as a blank line. Use `--json` for the raw
`routingPolicy` structure.

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
spend (dollar amounts, usage breakdowns) is **not** available here — use the
BigQuery billing export or the Cloud Console billing reports instead
(project-scoped cost reports require the `billing.resourceCosts.get`
permission on the project).

### Raw API access

For anything not wrapped above, `gcloud api` attaches a valid Bearer token to a
request against any Google Cloud REST endpoint:

```bash
gcloud api GET  "https://cloudresourcemanager.googleapis.com/v1/projects/my-project-id"
gcloud api POST "https://compute.googleapis.com/compute/v1/projects/P/zones/Z/instances/I/start"
gcloud api PATCH "https://.../resource" --data '{"field":"value"}'
```

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
