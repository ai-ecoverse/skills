---
name: gcloud
description: >-
  Use Google Cloud from SLICC with the real Google Cloud CLI, `gcloud` and
  `bq` (the @ai-ecoverse/gcloud-cli package, Google Cloud SDK on
  wasix-python): install it, sign in with gcloud's paste-code flow, query
  BigQuery, and seal a service-account key in the vault with fnox so no
  credential sits on disk. Plus `gcloud-ext billing cost` for per-service and
  per-SKU cost and usage reports from a logged-in Cloud Console tab, which no
  CLI command offers. Triggers on Google Cloud, GCP, gcloud, bq, BigQuery,
  "run a BigQuery query", "list my GCP projects", Compute Engine, Cloud
  Storage, GCS buckets, Cloud Run, Cloud DNS, IAM, service accounts,
  service-account keys, "gcloud auth login", "Reauthentication failed",
  "GCP cost", "cost per SKU", "billing report". Not AWS, not Azure.
allowed-tools: bash
---

# Google Cloud: `gcloud` and `bq`, plus `gcloud-ext`

`gcloud` and `bq` are Google's own CLIs, so their syntax, `--help` and
`--format=json` all work as documented upstream. Search before you guess:
`gcloud help <words>`, `gcloud <group> --help`, `bq help <command>`.

## 1. Install

```bash
pnpm add -g @ai-ecoverse/gcloud-cli    # gcloud + bq on wasix-python
gcloud version
```

The package is about 340 MB unpacked. On OPFS the install has taken from 6
minutes to many hours, so run it in the background and check back. Updates,
the component manager, usage reporting and survey prompts are off: install a
newer package version instead of `gcloud components update`.

## 2. Sign in (paste-code flow)

In SLICC, `gcloud auth login` uses the paste-code flow: it prints a Google URL
whose redirect is `https://sdk.cloud.google.com/authcode.html`, and waits for
the code that page shows. Don't try the loopback flow: SLICC refuses browser
automation on `127.0.0.1`, and device-code sign-in isn't available for Cloud
scopes.

The prompt blocks, so hold its stdin open with a FIFO and run it in the
background:

```bash
mkfifo /tmp/gcl-in; (sleep 1800 > /tmp/gcl-in &)
(gcloud auth login [ACCOUNT] --no-launch-browser < /tmp/gcl-in > /tmp/gcl-auth.log 2>&1 &)
grep -o 'https://accounts.google.com/o/oauth2/auth?[^ ]*' /tmp/gcl-auth.log   # open it in a tab
```

The user signs in and pastes the code from the authcode page into the chat.
Write it to the FIFO, then check the result:

```bash
printf '%s\n' "$CODE" > /tmp/gcl-in; grep -E 'logged in|ERROR' /tmp/gcl-auth.log
gcloud config set project PROJECT_ID
```

Then stop the `sleep` and remove the FIFO and the log. Several accounts can be
signed in at once (`gcloud auth list`, `gcloud config set account …`).

Credentials stay in `~/.config/gcloud/`. Google Workspace reauthentication
policies (Adobe's among them) expire a user login within about a day; `bq` then
reports "Reauthentication failed", and you sign in again.

## 3. Use it

```bash
gcloud projects list --format=json
gcloud services list --enabled --format='value(config.name)'
bq ls PROJECT:DATASET
bq query --use_legacy_sql=false --dry_run 'SELECT …'   # bytes it would scan, free
bq query --use_legacy_sql=false --format=csv 'SELECT …'
```

- BigQuery on-demand bills **bytes scanned**. `LIMIT` doesn't reduce them: name
  the columns, filter on the partition column, and dry-run first. Put
  [ai-aligned-bq](https://github.com/ai-ecoverse/ai-aligned-bq) in front of
  `bq` when agents run queries.
- Ask the user before anything that creates, changes or deletes resources,
  IAM bindings included.
- `gcloud auth print-access-token` prints a live token. Don't run it where the
  output lands in the chat.

## 4. Service-account keys, sealed in the vault

A service-account key file is a long-lived credential. Don't leave one on
disk: seal it, and let only a root-owned runner see it.

```bash
sh <skill>/assets/gcloud-slicc/install-sealed.sh   # once: root-owned gcloud copy, run.py, wrappers
sh <skill>/assets/gcloud-slicc/seal-key.sh KEY.json
bq-sealed query --use_legacy_sql=false --project_id=PROJECT 'SELECT 1'
gcloud-sealed projects describe PROJECT
```

- **`install-sealed.sh`** copies the installed package to
  `/usr/local/lib/gcloud-cli`, owned by root. It also installs
  [`run.py`](assets/gcloud-slicc/run.py) in `/usr/local/lib/gcloud-sealed/`
  and the `gcloud-sealed` and `bq-sealed` wrappers in `/usr/local/bin`. The
  vault gives a secret only to programs a non-root user can't change, which is
  why the copy must be root-owned. The copy takes minutes on OPFS. It asks for
  sudo once.
- **`seal-key.sh`** checks that the file is a service-account key (or an
  `authorized_user` credential). It stores the file **base64-encoded** as
  `GCLOUD_CREDENTIALS` with `fnox set --global`. It sets the `[exec]` grant to
  exactly `/usr/bin/python3 /usr/local/lib/gcloud-sealed/run.py`, then shreds
  the file (`--keep` keeps it, `--dry-run` changes nothing). It asks for sudo
  once.
- **Always seal base64, never the raw JSON.** The vault scrubs every sealed
  value out of model requests, and the boilerplate inside raw key JSON
  (`-----BEGIN PRIVATE KEY-----`, `.googleapis.com/`) makes that scrubbing
  corrupt the requests, so every model call fails.
- **The wrappers** run `fnox exec`, which hands the real value to `run.py`
  only. `run.py` decodes it into a `0600` file in a private `0700` directory,
  named by `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` and
  `GOOGLE_APPLICATION_CREDENTIALS`, and runs gcloud or bq. It removes the file
  when they exit or fail, and on SIGTERM, SIGHUP or SIGINT. SIGKILL can't be
  caught: the next run removes what a killed run left. With no user login,
  `bq-sealed` first prints gcloud's "You do not currently have an active
  account selected" error, then runs on the key: that message is harmless.
- **While a sealed call runs, the decoded key is a file your own user can
  read,** and the vault doesn't scrub it, because it only knows the base64
  form. Never `cat` or list the contents of `gcloud-cred-*` directories.
- **To make a key expire on its own,** upload a certificate with an end date
  (`gcloud iam service-accounts keys upload`) instead of letting Google
  generate the key. Table-level BigQuery IAM takes no conditions, so a key's
  end date is the only TTL there. Project-level grants can carry
  `request.time < timestamp(…)` conditions.

## 5. Cost and usage: `gcloud-ext billing cost`

No CLI or public API reports cost per service or SKU. `gcloud-ext` replays the
Cloud Console's billing-report API from a logged-in
`console.cloud.google.com` tab. Project-level `billing.resourceCosts.get` is
enough: no billing-account IAM and no BigQuery export are needed.

```bash
gcloud-ext billing cost --project PROJECT                    # this month, per service
gcloud-ext billing cost --group-by sku --from 2026-07-01 --to 2026-07-26 --json
```

It resolves the billing account with `gcloud billing projects describe`
(override it with `--billing-account ID`) and defaults to gcloud's configured
project. The API is private and may change: if it breaks, re-capture the
`BillingData` request from Billing → Reports and update the constants at the
top of `scripts/gcloud-ext.jsh`.
