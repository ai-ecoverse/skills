---
name: servicenow
description: Interact with Adobe's ServiceNow instance — list and manage tickets/incidents, read and post comments, search the Knowledge Base. Use when the user mentions ServiceNow, tickets, incidents, KB articles, support requests, RITM, INC numbers, pagerduty replacement, on-call, or wants to check ticket status, leave comments, or find internal documentation.
allowed-tools: bash
---

# ServiceNow (Adobe)

Direct API access to Adobe's ServiceNow Employee Service Center (ESC) at `adobe.service-now.com`. Bypasses the slow portal UI.

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

Session-based via Okta SSO cookies. The user must be logged into `adobe.service-now.com` in a browser tab.

If the session has expired, the user will see: "Session expired — log into adobe.service-now.com and try again."

KB search uses a Coveo JWT token extracted from the portal page. This token expires after ~24h and is refreshed automatically by loading the portal page.

## Available commands

### servicenow tickets [--state=STATE] [--table=TABLE]

List your open tickets (incidents and requests). Default: open states (New, In Progress, On Hold).

States: `new` (1), `in-progress` (2), `on-hold` (3), `resolved` (6), `closed` (7), `all`

Tables: `incident` (default), `sc_req_item`, `sc_request`

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

### servicenow monday [--limit N] [--date Nd]

Output tickets in the monday aggregator protocol format. Compatible with the `monday` dispatcher for unified inbox/todo aggregation across services.

```bash
# Used automatically by the monday aggregator:
monday servicenow gh slack

# Or standalone:
servicenow monday --limit 20 --date 7d
```

## Incident management (pagerduty replacement)

Incidents use the same `incident` table as regular tickets. This skill posts customer comments and internal work notes; it does not change the `state` field. Any state transitions depend on ServiceNow-side business rules or assignment-group workflows reacting to those entries.

**1. Acknowledge (post customer-visible comment)**
```bash
servicenow comment INC3616952 "Acknowledged. Investigating."
```

**2. Verify the comment was recorded**
```bash
servicenow get INC3616952
# Confirm the comment appears in the journal; state only changes if a ServiceNow rule promotes it.
```

**3. Investigate and log internal progress**
```bash
servicenow worknote INC3616952 "Root cause identified: ..."
```

**4. Document resolution**
```bash
servicenow comment INC3616952 "Issue resolved. Root cause was X; fix applied Y."
servicenow get INC3616952
# Confirm the resolution comment was posted. Moving the incident to Resolved (6) must be done in the ServiceNow UI or by a configured workflow.
```

State field values for reference: New (1), In Progress (2), On Hold (3), Resolved (6), Closed (7).

## Architecture

All API calls execute through a page-context session targeting a ServiceNow browser tab. Internal configuration constants (portal ID, widget IDs, Coveo org and search hub) and endpoint details are documented in `references/endpoints.md`.
