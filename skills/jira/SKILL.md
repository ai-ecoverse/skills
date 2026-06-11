---
name: jira
description: |
  Use this when interacting with Jira — fetching issues, searching by JQL,
  reading comments, or creating new issues. Uses the Jira tab open in the
  browser for auth (SSO session, no token needed). Activate on any mention of
  Jira, issue keys (e.g. PROJ-123), JQL queries, or requests to
  read/find/list/create Jira tickets.
allowed-tools: bash
---

# Jira

Direct API access to any Jira instance via the browser's SSO session. Uses the
Jira tab open in the browser for auth — no token setup needed.

## Quick start

```bash
jira detect                                          # Find Jira tab — confirm URL first
jira whoami                                          # Verify auth is working
jira get PROJ-123                                    # Fetch a single issue with full detail
jira search "project=PROJ ORDER BY updated DESC"     # JQL search (up to 50 results)
jira comments PROJ-123                               # Fetch all comments on an issue
jira components PROJ                                 # List all components defined in a project
jira types PROJ                                      # List all issue types available in a project
jira labels PROJ                                     # List all labels in use in a project
jira create --project PROJ --type Story --summary "My new story"
```

## Authentication

Auth is handled via the browser's SSO session. All API calls run inside the
Jira tab's page context using `browser.fetch`, so SSO cookies are sent
automatically — no token extraction needed.

**Requirements:**
- A Jira tab must be open in the browser
- You must be logged in to that Jira instance

If you get auth errors (401), refresh the Jira tab, log in again, and retry.

## URL detection

The skill auto-detects the Jira base URL by scanning open browser tabs for any
URL containing `jira`. Always run `jira detect` first in a new session or when
switching Jira instances. **The user must confirm the detected URL is correct
before proceeding with other commands.**

## Commands

### `jira detect`

Scans open browser tabs for a Jira instance and prints the detected base URL.

```
Found Jira tab: https://jira.example.com
Please confirm this is the correct Jira instance before proceeding.
```

### `jira whoami`

Confirms the SSO session is active. Prints the logged-in user's display name and email.

```
Authenticated as: Jane Smith (jane@example.com)
```

### `jira get <issue-key>`

Fetches a single issue with full detail: summary, type, status, assignee, reporter,
components, labels, fix versions, and description.

```bash
jira get PROJ-123
```

### `jira search "<jql>"`

Runs a JQL query and returns matching issues (up to 50).

```bash
jira search "project=PROJ ORDER BY updated DESC"
jira search "project=PROJ AND status=Open"
jira search "project=PROJ AND assignee=currentUser()"
```

### `jira comments <issue-key>`

Fetches all comments on an issue with author, date, and body text.

```bash
jira comments PROJ-123
```

### `jira create`

Creates a new issue. **Required fields are discovered automatically** from the
project's `createmeta` — every Jira project and issue type combination has its
own set of required fields, so the command fetches those before attempting to
create, and reports exactly what's missing if the call would fail.

```bash
# Minimal invocation — will report missing required fields if any exist
jira create --project PROJ --type Story --summary "Add dark mode"

# With optional fields
jira create --project PROJ --type Bug \
  --summary "Login fails on Safari" \
  --description "Steps to reproduce..." \
  --assignee jsmith \
  --priority High \
  --labels "frontend,regression" \
  --components "Auth,Frontend"

# Set a custom field by numeric ID
jira create --project PROJ --type Story --summary "..." --cf-10014 "Sprint 3"

# Set any field by its raw Jira field ID
jira create --project PROJ --type Story --summary "..." --field-customfield_10200 "value"
```

**Flags:**

| Flag | Description |
|---|---|
| `--project <key>` | Project key — required |
| `--type <name>` | Issue type name (Story, Bug, Task, …) — required |
| `--summary <text>` | Issue summary — required for most types |
| `--description <text>` | Issue description (plain text; Jira wiki markup also accepted) |
| `--assignee <username>` | Assignee's Jira username |
| `--priority <name>` | Priority name (e.g. High, Medium, Low, Critical) |
| `--labels <a,b,c>` | Comma-separated label names |
| `--components <a,b>` | Comma-separated component names |
| `--cf-NNNNN <value>` | Custom field by numeric ID (e.g. `--cf-10014 "Sprint 3"`) |
| `--field-<id> <value>` | Any field by raw Jira field ID |
| `--dry-run` | Validate fields and print the payload that would be posted, without creating anything |

**How required-field discovery works:**

Before posting, the command fetches the project's `createmeta` to find required
fields for the given issue type. It tries two endpoint shapes in order:

1. **Paginated** (Jira Server 9+ / Data Center): `GET /rest/api/2/issue/createmeta/{project}/issuetypes`
2. **Classic** (older Jira Server): `GET /rest/api/2/issue/createmeta?projectKeys=…&expand=projects.issuetypes.fields`

Whichever responds with 200 is used; the result is normalised so the rest of
the command behaves identically regardless of which endpoint answered.

If any required fields are not covered by the provided flags, it prints them
with their type and the flag to use, then exits without creating anything.
Re-run with the missing flags.

If the issue type name is wrong for the project, the command lists valid types
for that project.

**Example output:**
```
✓ Created PROJ-456: https://jira.example.com/browse/PROJ-456
```

## Output format — Jira wiki markup

The `description` and comment `body` fields from `get` and `comments` are
returned in **Jira wiki markup**, not plain text or Markdown. Common patterns:

| Jira markup | Meaning |
|---|---|
| `*text*` | Bold |
| `_text_` | Italic |
| `{{text}}` | Inline code |
| `[label\|url]` | Hyperlink |
| `{color:#hex}text{color}` | Colored text (usually discard) |
| `# item` | Ordered list item |
| `- item` | Unordered list item |

When consuming this output to generate content, strip or convert markup as
appropriate for the target format.

## Project metadata

Several fields on issue creation require values from a fixed list defined per-project. Fetch these directly before prompting the user:

```bash
# All components defined in a project
jira components ACE

# All issue types available in a project
jira types ACE
```

Or via the REST API directly:

| Data | Endpoint |
|---|---|
| Components | `GET /rest/api/2/project/{key}/components` |
| Labels in use in project | `GET /rest/api/2/search?jql=project={key}+AND+labels+is+not+EMPTY&fields=labels` |
| All instance labels | `GET /rest/api/1.0/labels/suggest?query=&maxResults=100` |
| Issue types (paginated, Server 9+) | `GET /rest/api/2/issue/createmeta/{key}/issuetypes` |
| Issue types (classic) | `GET /rest/api/2/issue/createmeta?projectKeys={key}&expand=projects.issuetypes` |
| Fields for a type (paginated) | `GET /rest/api/2/issue/createmeta/{key}/issuetypes/{typeId}` |
| Priority values | `GET /rest/api/2/priority` |

The `create` command fetches components automatically when `--components` is omitted and the field is required — it presents the full list from `/rest/api/2/project/{key}/components`, scored by relevance to the issue summary and description, and prompts the user to pick.

For labels, `create` always prompts (even though labels are optional). It merges two sources: labels already used in the project (from the search API, boosted in ranking) and the full instance-wide label universe (from `/rest/api/1.0/labels/suggest`). Both are scored against the issue content; project-familiar labels are weighted higher and annotated with `(used in project)` in the prompt.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `No Jira tab found` | No browser tab with `jira` in the URL | Open Jira in your browser |
| `API error 401` | SSO session expired | Refresh the Jira tab, log in again |
| `Project not found` | Wrong project key or no permission | Check the key; verify you can see the project in the browser |
| `Issue type not found` | Type name doesn't match this project | Run `jira create --project PROJ --type x` — it will list valid types |
| `Missing required fields` | Project has additional required fields beyond summary | Re-run with the flags listed in the error output |

## SSO Jira instances

For corporate SSO-protected Jira instances (no personal API tokens available):
- Uses Jira Server/Data Center REST API (`/rest/api/2/`) not Jira Cloud
- Standard field names (`summary`, `description`, `status`, `assignee`) work
  reliably; custom fields (`customfield_XXXXX`) vary by instance
- Session cookies are scoped to the corp domain; page-context fetch (the
  default) handles this automatically
