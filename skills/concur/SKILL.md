---
name: concur
description: Interact with SAP Concur (Concur Expense / Travel) via its API — list expense reports, view report and line-item details, list available receipts and smart expenses, check approvals, and call any of 50+ Concur GraphQL operations directly. Use whenever the user mentions Concur, SAP Concur, Concur Expense, expense reports, expense submission, expense receipts, smart expenses, T&E (travel and expense), reimbursements at Adobe, or wants to automate, query, or extract data from Concur without clicking through https://us2.concursolutions.com. Activate on mentions of "concur", "expense report", "expense receipts", "submit expenses", "T&E", "reimbursement", "travel allowance", or related Adobe expense workflows.
allowed-tools: bash
---

# Concur

Direct API access to SAP Concur (`us2.concursolutions.com`). Skip the slow web UI — list reports, fetch report details, query receipts, and run any of the 56 captured GraphQL operations from one CLI.

## Quick start

```bash
# Requires being logged in to Concur in a browser tab
concur me                                  # confirms session, returns user info
concur reports                             # active expense reports
concur reports --status=PAID --size=50     # paid reports, latest 50
concur report A1B2C3D4E5F60718293A         # full detail for a single report
concur expenses A1B2C3D4E5F60718293A       # line items + exceptions
concur available-receipts                  # receipts not yet attached to a report
concur smartexpenses                       # SmartExpense queue
concur reports-v3                          # full historical report list (REST v3)
concur ops                                 # list every callable GraphQL operation
```

## Authentication

Concur authenticates with cookies on `*.concursolutions.com`. SLICC's localhost-origin `fetch` cannot send those cookies, so this skill **always issues requests from the page context** of an existing Concur tab (via the browser bridge).

- The first time you run any command, the skill looks for an open tab on `concursolutions.com`. If none exists, it opens `https://us2.concursolutions.com/home` — you will need to log in (Adobe SSO) before the next call succeeds.
- The user UUID is auto-discovered via `GetUserPermissions` and cached at `<skill-dir>/.session.json` (next to `SKILL.md`). Delete that file to force re-discovery if you switch accounts.
- A 401/403 from any call means the session expired — log in again in the Concur tab and retry.

## Available commands

The skill exposes two parallel surfaces — pick by use case:

| Use case | Best command |
|---|---|
| Rich data on a single ACTIVE report (entries, exceptions, policy, workflows) | `concur report` (GraphQL) |
| Full historical report list, including paid / processed reports going back years | `concur reports-v3` (REST) |
| Programmatic line-item walk for a known reportId | `concur entries-v3 --reportId=...` (REST) |
| Anything not yet wrapped | `concur graphql <opName>` |

### Core commands

| Command | Description |
|---|---|
| `concur me` | User UUID + permission flags (BondUser, VerifyAIUser, ExpenseIt status). |
| `concur reports [--status=ACTIVE\|PAID\|...] [--page=N] [--size=N]` | GraphQL: paginated reports list, rich shape, status-filtered. |
| `concur report <reportId>` | GraphQL: full report — header, summary, entries, exceptions, policy, workflows. |
| `concur expenses <reportId>` | GraphQL: line items + exceptions for one report. |
| `concur available-receipts` | GraphQL: receipts not yet attached. |
| `concur smartexpenses [--size=25]` | REST `/smartexpense/v4`: SmartExpense queue. |
| `concur policies` | GraphQL: available expense policies. |
| `concur recent-types [--policy=<id>]` | GraphQL: recent expense types. `--policy` is optional; when omitted the default (or first) policy from `concur policies` is used. |
| `concur cards` | GraphQL: corporate card accounts. |
| `concur messages` | REST `/messagenexus/v1`: system messages. |

### REST v3 commands (Concur Platform API — full historical access)

These hit the public-API surface at `www-us2.api.concursolutions.com/api/v3.0/*`. They authenticate with the page session cookie and return classic field-cased JSON (`{"Items": [...], "NextPage": "..."}`).

| Command | Description |
|---|---|
| `concur reports-v3 [--limit=N] [--offset=N] [--user=<email>] [--modifiedAfter=<iso>]` | All reports (every status, full history). |
| `concur report-v3 <reportId>` | Single report header + custom fields, OrgUnit, totals, status. |
| `concur entries-v3 [--reportId=<id>] [--limit=N] [--offset=N]` | Expense line items, optionally filtered to one report. |
| `concur attendees-v3 [--limit=N]` | Saved attendees from the user's address book. |
| `concur digests [--limit=N] [--user=<email>]` | Lightweight digest list (less data than `reports-v3`). |
| `concur locations [--name=<prefix>] [--country=<ISO>] [--limit=N]` | Concur location reference data. |

### Attendees

| Command | Description |
|---|---|
| `concur attendees list <reportId> <expenseId>` | Resolve and list attendees on a single expense entry. Maps the GraphQL hex `expenseId` → v3 `EntryID`, paginates `/expense/entryattendeeassociations`, filters client-side, and looks up each attendee by ID. Returns `{associationId, attendeeId, firstName, lastName, company, title, email, attendeeType, amount, count}`. |
| `concur attendees search <terms>` | GraphQL `GetAttendeesByPredictiveSearch` against the company directory. Returns names, titles, emails, GraphQL `atnKey`/`graphqlId`. **These IDs are NOT compatible with `attendees add`** — they're a different namespace. Use this only for *finding* people you'd then look up by email/name in your own attendee book. |
| `concur attendees book [--search=<text>] [--max=N]` | Paginate your saved v3 attendee book (people you've used before). Returns the `attendeeId` you can pass to `add`. The book may be very large (5,000+); search hits a 200-page cap. If you can't find someone here, use `attendees list` on a previous report where you already had them attached to grab their `attendeeId`. |
| `concur attendees add <reportId> <expenseId> <attendeeId> [--amount=N] [--count=N]` | Attach an attendee (by v3 `attendeeId`) to an expense entry. Defaults amount to `entry.TransactionAmount / count`. POSTs to `/expense/entryattendeeassociations`. |
| `concur attendees remove <associationId>` | DELETE `/expense/entryattendeeassociations/{id}`. Returns 204. **Caveat:** on Adobe's tenant this returns success but the association persists — DELETE appears to be silently no-op. Use the Concur UI to remove attendees until this is resolved. |

### Mutations

| Command | Description |
|---|---|
| `concur attach-receipt <reportId> <expenseId> <localPath>` | Upload a receipt image and attach it to a specific expense entry. Auto-converts HEIC/PNG → JPEG via ImageMagick (downscaled to 2048px max, quality 85). Pass `--no-convert` to skip conversion. |
| `concur submit <reportId> [--source=WEB] [--approver-validated]` | Two-step submit: runs server validation, then commits. Returns `{validation, commit}` statuses (both should be `COMPLETED`). Before submitting, run `concur report <reportId>` and check for open exceptions/policy violations — the server validation step catches hard blockers, but reviewing first avoids a wasted round-trip on reports that need edits. All mutation commands (`change-type`, `attach-receipt`, `itemize`, `submit`) also refuse to run against reports that are locked (already Approved/Submitted/Paid) and report the current status instead. |

### Escape hatches

| Command | Description |
|---|---|
| `concur ops` | List all 56 bundled GraphQL operations. |
| `concur graphql <opName> [<variables-json>] [spend\|cds]` | Run any captured operation verbatim. |
| `concur tab` | Print the tab handle the skill is using for Concur requests. |
| `concur help` | Usage + examples. |

## API surfaces

Four backends are bundled: `/spend-graphql/graphql` (main expense GraphQL, 50+ operations — `references/operations/*.graphql`), `/api/v3.0/*` (public Concur Platform REST, full historical reads, Pascal-cased JSON), `/cds/graphql` (Common Data Service, less commonly needed), and REST helpers (`/smartexpense/v4`, `/messagenexus/v1`).

Known caveats worth remembering: v3 attendee-association/attendee-search filter params (`expenseEntryID`, `lastName`, etc.) are silently ignored server-side — `attendees list`/`attendees book` paginate and filter client-side instead. `DELETE /expense/entryattendeeassociations/{id}` returns 204 but the row persists on Adobe's tenant (no-op; use the Concur UI). The `/homepage/v4/*` tiles and `/api/v3.0/expense/exceptions`/`quickexpenses` don't work from this skill (Bearer-JWT-only or decommissioned) — use `concur reports-v3` / `concur graphql` instead.

Full surface map, host list, and per-operation detail: `references/endpoints.md`.

## Calling arbitrary GraphQL operations

`concur ops` prints the full list. Each one is stored verbatim from the live web app, so the variables shape matches what the official UI sends. To call one:

```bash
# Get the variable shape from the operation source
cat /workspace/skills/concur/references/operations/GetCardAccounts.graphql

# Look up your userId
USER_ID=$(concur me | jq -r .userId)

# Call it
concur graphql GetCardAccounts "{\"userId\":\"$USER_ID\",\"contextRole\":\"TRAVELER\"}"
```

For the few operations on the `cds` surface (e.g. `GetOnScreenHelpData`), pass `cds` as the third arg.

## Notes & caveats

- **Cookie auth requires an open Concur tab.** The skill auto-finds the first `concursolutions.com` tab; pass a different one by closing extras or by opening the desired tab first.
- **Single-user scope.** Cached `userId` is per-skill-install. Delete `<skill-dir>/.session.json` after switching SSO identities.
- **GraphQL operations were captured in batched form.** The web app sometimes sends multiple operations in one POST as a JSON array; this skill always sends a single operation per request, which Concur accepts.
- **Mutations are real.** `UpdateExistingExpenseEntry`, `CreateReportHeader`, `MoveAvailableExpensesToReport`, `SaveExpenseAttendees`, `SubmitExpenseReport`, `AttachImage`, `MoveExpense` modify state. They are exposed via `concur graphql <op>` rather than a top-level command, so you can't fire them by accident — but they will work.

## Files

```
skills/concur/
├── SKILL.md                          # this file
├── scripts/
│   └── concur.jsh                    # CLI (auto-mapped to `concur` command)
└── references/
    ├── endpoints.md                  # API surface map (HAR-distilled)
    └── operations/                   # 56 captured GraphQL queries (one per file)
```
