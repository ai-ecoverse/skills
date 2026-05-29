---
name: jira
description: |
  Use this when interacting with Jira — fetching issues, searching by JQL,
  reading comments, or pulling issue detail to use in other workflows. Uses
  the Jira tab open in the browser for auth (SSO session, no token needed).
  Activate on any mention of Jira, issue keys (e.g. PROJ-123), JQL queries, or
  requests to read/find/list Jira tickets.
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
jira search "project=PROJ AND status=Open"           # Filter by status
jira comments PROJ-123                               # Fetch all comments on an issue
```

## Authentication

Auth is handled via the browser's SSO session. All API calls are made from within
the Jira page context using `playwright-cli eval` with `credentials: 'include'`,
so SSO cookies are sent automatically — no token extraction needed.

**Requirements:**
- A Jira tab must be open in the browser
- You must be logged in to that Jira instance

If you get auth errors (401), refresh the Jira tab, log in again, and retry.

## URL detection

The skill auto-detects the Jira base URL by scanning open browser tabs for any
URL containing `jira`. Always run `jira detect` first in a new session or when
switching Jira instances. **The user must confirm the detected URL is correct
before proceeding with other commands.**

If multiple Jira tabs are open, the first match is used. Close unwanted tabs or
note which workspace you're targeting.

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
jira get PROJ-456
```

**Example output:**
```
PROJ-123: Add dark mode support
  Type:        Story
  Status:      In Progress
  Assignee:    Jane Smith
  Reporter:    John Doe
  Created:     2025-08-18
  Updated:     2026-04-02
  Components:  Frontend
  Fix Versions: v1.2

  Description:
    ...
```

### `jira search "<jql>"`

Runs a JQL query and returns matching issues. Returns up to 50 results showing
key, summary, status, assignee, and issue type.

```bash
jira search "project=PROJ ORDER BY updated DESC"
jira search "project=PROJ AND status=Open"
jira search "project=PROJ AND assignee=currentUser()"
jira search "project=PROJ AND fixVersion='v1.2'"
jira search "project=PROJ AND component='Frontend'"
```

**Example output:**
```
3 issue(s) found (showing 3):

  PROJ-124: Improve search performance [In Review]
  PROJ-123: Add dark mode support [In Progress]
  PROJ-100: Fix broken pagination [Resolved]
```

**Note:** Results are capped at 50. For larger result sets, add filters to narrow
the query (e.g. `AND status=Open`, `AND updated >= -30d`).

### `jira comments <issue-key>`

Fetches all comments on an issue with author, date, and body text.

```bash
jira comments PROJ-123
```

**Example output:**
```
Comments on PROJ-123 (2):

  [2025-08-18] John Doe:
    Flagging this for design review before implementation.

  [2025-09-23] Jane Smith:
    Design approved — moving to development.
```

## Using with other skills

When building pages from Jira content, use `jira get` to pull the full issue and
`jira comments` for additional context. The `.jsh` script outputs plain text
suitable for use in prompts or piped to other commands.

### Output format — Jira wiki markup

The `description` and comment `body` fields are returned in **Jira wiki markup**,
not plain text or Markdown. Common patterns:

| Jira markup | Meaning |
|---|---|
| `*text*` | Bold |
| `_text_` | Italic |
| `{{text}}` | Inline code |
| `[label\|url]` | Hyperlink |
| `{color:#hex}text{color}` | Colored text (usually discard) |
| `{*}text{*}` | Bold (alternate form) |
| `# item` | Ordered list item |
| `- item` | Unordered list item |
| `\r\n` | Windows line endings |

When consuming this output to generate DA pages or other content, strip the markup
to plain text or convert to Markdown/HTML as appropriate for the target format.

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `No Jira tab found` | No browser tab with `jira` in the URL | Open Jira in your browser |
| `API error 401` | SSO session expired | Refresh the Jira tab, log in again |
| `eval failed` | Jira tab navigated away or closed | Check `playwright-cli tab-list` |

## SSO Jira instances

For corporate SSO-protected Jira instances (no personal API tokens available):
- Uses Jira Server/Data Center REST API (`/rest/api/2/`) not Jira Cloud
- Standard field names (`summary`, `description`, `status`, `assignee`) work
  reliably; custom fields (`customfield_XXXXX`) vary by instance
- Session cookies are scoped to the corp domain; direct fetch from localhost is
  rejected — page-context eval is required (already the default approach)

---

> **TODO:** Revisit and tighten this documentation after real use. Add examples
> of JQL queries that proved useful, output patterns that needed cleanup, and any
> edge cases encountered.
