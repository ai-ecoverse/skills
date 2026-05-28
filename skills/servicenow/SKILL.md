---
name: servicenow
description: Interact with Adobe's ServiceNow instance — list and manage tickets/incidents, read and post comments, search the Knowledge Base. Use when the user mentions ServiceNow, tickets, incidents, KB articles, support requests, RITM, INC numbers, pagerduty replacement, on-call, or wants to check ticket status, leave comments, or find internal documentation.
allowed-tools: bash
---

# ServiceNow (Adobe)

Direct API access to Adobe's ServiceNow Employee Service Center (ESC) at `adobe.service-now.com`. Bypasses the slow portal UI.

**Important:** All requests must be made from the page context via Angular's `$http` service (which adds the `X-UserToken` CSRF header and session cookies automatically). Both the Table API (`/api/now/table/...`) and the Service Portal API (`/api/now/sp/...`) work through this channel. Raw `fetch()` or `XMLHttpRequest` from the page will hang — Angular's interceptors are required.

## Quick start

```bash
# List your open incidents
servicenow tickets

# Create a new incident with attachment
servicenow create --title "VPN broken on Mac" --description "Details..." --attach /tmp/screenshot.png

# Attach a file to an existing ticket
servicenow attach INC3616952 /path/to/screenshot.png

# Get details and comments for a specific ticket
servicenow get INC3616952

# Post a comment on a ticket
servicenow comment INC3616952 "Any update on this?"

# Search the Knowledge Base
servicenow kb "VPN GlobalProtect setup"

# Get a specific KB article
servicenow kb-article KB0023295
```

## Authentication

Session-based via Okta SSO cookies. The user must be logged into `adobe.service-now.com` in a browser tab. The skill uses Angular's `$http` injector from the page context, which automatically includes the `X-UserToken` (CSRF) and session cookies.

If the session has expired, the user will see: "Session expired — log into adobe.service-now.com and try again."

For KB search, a Coveo JWT token is extracted from the portal page data. This token expires after ~24h and is refreshed automatically by loading the portal page.

## Available commands

### servicenow tickets [--state=STATE]

List your open tickets (incidents and requests). Default: open states (New, In Progress, On Hold).

States: `new` (1), `in-progress` (2), `on-hold` (3), `resolved` (6), `closed` (7)

### servicenow get <NUMBER>

Get full details of a ticket including metadata, state, assignment group, and all comments/work notes.

NUMBER can be an INC number (e.g., INC3616952) or a sys_id.

### servicenow create --title "..." [--description "..."] [--category ...] [--subcategory ...] [--attach FILE]

Create a new incident. Returns the INC number and sys_id. Multiple `--attach` flags supported.

```bash
servicenow create --title "Outlook unable to sign in" --description "Native app fails at Okta SSO" --category Software --subcategory Email --attach /tmp/error.png
```

### servicenow attach <NUMBER> <FILE> [<FILE>...]

Attach one or more files to an existing ticket. Supports INC, RITM, and REQ numbers.

### servicenow comment <NUMBER> <MESSAGE>

Post a comment (Additional comments - Customer Visible) on a ticket.

### servicenow worknote <NUMBER> <MESSAGE>

Post a work note (internal, not customer-visible) on a ticket.

### servicenow kb <QUERY>

Search the Knowledge Base using Coveo. Returns titles, article numbers, and excerpts.

### servicenow kb-article <KB_NUMBER>

Fetch a specific KB article's full content (issue, solution, additional info).

## Architecture

- **Portal ID:** `70cd9f3b734b13001fdae9c54cf6a72f`
- **Ticket conversation widget:** `a54beb3a87f10010e0ef0cf888cb0bba`
- **Coveo org:** `adobev2prod9e382h1q`
- **Coveo search hub:** `ServiceNowESC_MainSearch`
- **User sys_id:** resolved dynamically at login and stored in `.config.json`

All SP API calls go through Angular's `$http` to inherit session state. The `.jsh` script uses `playwright-cli eval` targeting a ServiceNow tab.

### servicenow tickets [--state=STATE] [--table=TABLE]

List your open tickets. Supports filtering by state and table.

States: `new` (1), `in-progress` (2), `on-hold` (3), `resolved` (6), `closed` (7), `all`
Tables: `incident` (default), `sc_req_item`, `sc_request`

### servicenow monday [--limit N] [--date Nd]

Output tickets in the monday aggregator protocol format. Compatible with the `monday` dispatcher for unified inbox/todo aggregation across services.

```bash
# Used automatically by the monday aggregator:
monday servicenow gh slack

# Or standalone:
servicenow monday --limit 20 --date 7d
```

## Incident management (pagerduty replacement)

Incidents use the same `incident` table as regular tickets. To acknowledge/update an incident:

```bash
servicenow comment INC3616952 "Acknowledged. Investigating."
servicenow get INC3616952
```

The state field in ticket details shows: New (1), In Progress (2), On Hold (3), Resolved (6), Closed (7).
