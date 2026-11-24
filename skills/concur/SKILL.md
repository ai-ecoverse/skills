---
name: concur
description: Interact with SAP Concur (Concur Expense / Travel) via its API — list expense reports, view report and line-item details, list available receipts and smart expenses, check approvals, and call any of 50+ Concur GraphQL operations directly. Use whenever the user mentions Concur, SAP Concur, Concur Expense, expense reports, expense submission, expense receipts, smart expenses, T&E (travel and expense), reimbursements at Adobe, or wants to automate, query, or extract data from Concur without clicking through https://us2.concursolutions.com. Activate on mentions of "concur", "expense report", "expense receipts", "submit expenses", "T&E", "reimbursement", "travel allowance", or related Adobe expense workflows.
allowed-tools: bash
---

# Concur

Direct API access to SAP Concur (`us2.concursolutions.com`). Skip the slow web UI — list reports, fetch report details, query receipts, create/edit expenses, and run any of the bundled GraphQL operations from one CLI.

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

## Workflow: build and submit an out-of-pocket expense report

End-to-end sequence for filing a cash/personal expense report from scratch. Validate at each checkpoint before proceeding.

```bash
# 1. Create the report header (or reuse an existing reportId)
concur new-report --name="Trip addendum" --purpose="Internal Stakeholder Meetings / Review"
#    Checkpoint: capture the returned reportId.

# 2. Add each out-of-pocket line. Meals/lodging: isExpensePartOfTravelAllowance true;
#    transport (TAXIX): false. Foreign currency needs --exchange; same-currency uses 1.0.
concur new-expense <reportId> --type=BRKFT --date=2026-06-01 --vendor="..." \
  --amount=39.38 --currency=GBP --location=<locationId> --payment=CASH --exchange=1.1555 \
  --fields='{"custom8":{...},"custom24":{...},"taxRateLocation":"HOME","receiptTypeId":"R","isExpensePartOfTravelAllowance":true}'
#    Checkpoint: each call returns the new expenseId — record it for the receipt step.

# 3. Itemize entries that require it (e.g. hotel folio -> room + tax per night)
concur itemize hotel <reportId> <hotelExpenseId> bill.json
#    Checkpoint: sum of itemizations must equal the parent entry total.

# 4. Attach a receipt image to each entry
concur attach-receipt <reportId> <expenseId> /path/to/receipt.jpg

# 5. Check exceptions — this is the submit gate
concur exceptions <reportId>
#    Checkpoint: hasBlockingExceptions MUST be false before submitting.
#    Fix blocking issues (ITEMREQ -> itemize; some RECEIPT_REQUIRED -> attach-receipt) and re-check.

# 6. Submit (2-step validate + commit, both must be COMPLETED)
concur submit <reportId>
#    Checkpoint: verify with `concur report-v3 <reportId>` (ApprovalStatusName changes from
#    "Not Submitted" to "Pending Audit Review"/"Submitted & Pending Approval").
```

## Workflow: card charges (e.g. Navan) to a report

Trip bookings paid with the corporate card show up as available card charges, not as entries. `navan expenses <tripId>` (navan skill) previews what they will look like.

```bash
concur available --since=2026-10-01                     # 1. find the charges (vendors NVN-AL-<bookingId>, NVN  TRP FEE <bookingId>, the hotel)
concur new-report --name="Basel trip" --purpose="Internal Stakeholder Meetings / Review"   # 2. purpose is resolved first
concur move <reportId> <availableId> <availableId> …    # 3. attach the charges to the report
concur expenses <reportId>                              #    note the new expenseIds
concur change-type <reportId> <airfareExpenseId> TOLLS  # 4. airfare arrives typed 01145; see below
concur set-fields <reportId> <airfareExpenseId> --ticket=KDMDXPL --class=Economy   # 5. airfare required fields
concur itemize hotel <reportId> <hotelExpenseId> bill.json   # 6. hotel folio -> room + tax per night
concur itinerary <reportId> itinerary.json              # 7. German travel allowance (meals in Germany)
concur attach-receipt <reportId> <expenseId> receipt.pdf --no-convert   # 8. receipts (navan invoice --download gives the PDF)
concur exceptions <reportId>                            # 9. must report hasBlockingExceptions: false
concur submit <reportId>                                # 10. submit
```

**Navan airfare is mistyped on arrival.** Navan airfare card charges (`NVN-AL-<bookingId>`) arrive typed `01145` *Travel Booking Fees*. Change them to `TOLLS` (*Airfare, Paid by Corporate Card or You*) or the report shows the `NVNAL` and `TIPTRLHS` exceptions. The Navan trip fee (`NVN  TRP FEE <bookingId>`, two spaces) is a genuine booking fee and **stays `01145`**.

Once typed `TOLLS`, an airfare entry is blocked by `MISSREQFLD` until two fields are set: `ticketNumber` (the airline e-ticket, which for Navan is the flight confirmation such as `KDMDXPL`; `navan expenses` prints it) and `custom15` Class of Service (`{"value":"<listItemId>"}`, Economy is `5E0AC8B576C2D643ADF191F71E320549`). `concur exceptions` lists exactly which fields are empty and prints the `set-fields` command.

`GetAvailableExpenses` and `MoveAvailableExpensesToReport` take `{userId, contextRole, page, size}` and `{userId, contextRole, ids, reportId}`; passing a `params` object makes both fail with HTTP 400, so use the commands instead of hand-building the call.

To flip an existing card transaction to personal/out-of-pocket: `concur set-payment <reportId> <expenseId> CASH`.

## On a host

`concur` also runs on macOS or Linux under [slicc-jsh](https://github.com/ai-ecoverse/slicc-jsh), over Chrome DevTools (`SLICC_CDP_URL`, else found). See [references/jsh-host.md](references/jsh-host.md).

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
| `concur reports-v3 [--limit=N] [--offset=N] [--user=<email>] [--modifiedAfter=<date>] [--modifiedBefore=<date>] [--createdAfter=<date>] [--createdBefore=<date>]` | All reports (every status, full history). Date flags take `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SS` and are sent as `modifiedDateAfter`/`modifiedDateBefore`/`createDateAfter`/`createDateBefore`. |
| `concur report-v3 <reportId>` | Single report header + custom fields, OrgUnit, totals, status. |
| `concur entries-v3 [--reportId=<id>] [--limit=N] [--offset=N]` | Expense line items, optionally filtered to one report. |
| `concur attendees-v3 [--limit=N]` | Saved attendees from the user's address book. |
| `concur digests [--limit=N] [--user=<email>] [--modifiedAfter=<date>] [--modifiedBefore=<date>] [--createdAfter=<date>] [--createdBefore=<date>]` | Lightweight digest list (less data than `reports-v3`); same date flags. |
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
| `concur new-expense <reportId> --type=<expenseTypeId> --date=YYYY-MM-DD --amount=NN.NN --currency=<ISO> --location=<locationId> [--vendor="..."] [--payment=CASH] [--exchange=<rate>] [--comment="..."] [--personal] [--receipt=<imageId>] [--fields='<json>']` | Create a brand-new (out-of-pocket / cash) expense line via `SaveNewExpenseEntry`/`createExpense`. `policyId` auto-resolves from the report. `--payment=CASH` = Out of Pocket, `PCCD` = Pending Card Transaction. An `exchangeRate` is always sent (defaults to 1.0 for same-currency; pass `--exchange` for a foreign currency, e.g. GBP→EUR `1.1555`). Many policies require extra required fields — pass them via `--fields '<json>'` (e.g. `custom8`/`custom24` list items, `taxRateLocation`, `receiptTypeId`). Note: for non-meal types (e.g. transport `TAXIX`) set `isExpensePartOfTravelAllowance:false` in `--fields`; meals/lodging policies may want it true. Returns the new `expenseId`. |
| `concur new-report --name="<name>" [--policy=<policyId>] [--purpose=<id\|label\|code>] [--comment="..."]` | Create a new unsubmitted report via `CreateReportHeader`. Cost center, company code and site location default from your profile; `--purpose` sets the Business Purpose (`custom14`) and copies it down, which most policies require before submit. `--purpose` takes a list-item id, a label (case-insensitive exact, or a unique prefix), a code, or the v3 `Custom14.ListItemID` shown by `reports-v3` (looked up across your whole v3 report history, following `NextPage` for at most 50 pages of 100 reports and stopping at the first match or a repeated page link; if it is not found there, pass the label, code or GraphQL list-item id from `concur purposes`); it is resolved **before** the report is created, so an unknown purpose fails with the option list and creates nothing. Returns the new `reportId`. |
| `concur delete-expense <reportId> <expenseId> [<expenseId>…] --confirm` | Delete entries **or itemizations** from an unsubmitted report (`DeleteExpenseEntries`). `--confirm` is a **prerequisite** — without it the command dry-runs and prints what it would remove; `--dry-run` does the same explicitly. Company-card charges are **not** destroyed: they return to Available Expenses and can be moved onto another report. Out-of-pocket entries and itemizations are permanent. |
| `concur delete-report <reportId> --confirm` | Delete an entire unsubmitted report (`DeleteExpenseReport`). Same `--confirm`/`--dry-run` contract as `delete-expense`, and the dry run lists what is on the report plus which lines would return to Available Expenses. Submitted/approved/paid reports are refused — recall or send back first. |
| `concur set-payment <reportId> <expenseId> <CASH\|PCCD> [--comment="..."]` | Change an existing entry's payment type via `UpdateExistingExpenseEntry` (e.g. flip Corporate Card → Out of Pocket). `policyId` auto-resolves. |
| `concur payment-types` | List the payment types available to the report owner (`GetPaymentTypes`). `CASH`="Out of Pocket", `PCCD`="Pending Card Transaction". |
| `concur attach-receipt <reportId> <expenseId> <localPath> [--json]` | Upload a receipt image and attach it to a specific expense entry. Auto-converts HEIC/PNG → JPEG via ImageMagick (downscaled to 2048px max, quality 85). Pass `--no-convert` to skip conversion. (PDF attach needs ghostscript; attach a rendered image if unavailable.) Prints `{ok, expenseId, imageId}`; `--json` prints the full upload and attach payload. |
| `concur report-purpose <reportId> <id\|label\|code>` | Set the report header's **Business Purpose** (`custom14`) via `UpdateReportHeader` and copy it down to every line (clears `NOBUSPUR`/`NOBUSLIN`/`BADHEADR`). Accepts the same id/label/prefix/code/v3-id forms as `new-report --purpose`. |
| `concur purposes [<reportId>] [--policy=<id>]` | List the Business Purpose choices (`id`, `code`, `label`) from the new-report form (or an existing report's form). Use it to see what `--purpose` accepts. |
| `concur available [--since=YYYY-MM-DD] [--json]` | List unattached card charges (`GetAvailableExpenses`) as id / date / vendor / amount / currency / type / hasReceipt. The id is what `move` takes (it equals the smartExpenseId). `--json` prints rows as JSON. |
| `concur move <reportId> <availableExpenseId>…` | Move available card charges onto a report (`MoveAvailableExpensesToReport`). Refuses locked reports; fails with the server errors if `status.success` is false. |
| `concur set-fields <reportId> <expenseId> --fields='<json>' [--ticket=<no>] [--class=<label>] [--json]` | Set arbitrary entry fields via `UpdateExistingExpenseEntry` (same variables as `set-payment`). `--fields` is merged into the update input, e.g. `{"ticketNumber":"KDMDXPL","custom15":{"value":"<listItemId>"}}`. Airfare shortcuts: `--ticket=KDMDXPL` and `--class=Economy` (the label is resolved from the entry form's Class of Service list). Prints `{ok, expenseId, fields, exceptions}`. |
| `concur types [--policy=<id>] [--search=text] [--parent=<typeId>]` | List **every** expense type of a policy (`GetExpenseFormExpenseTypes`, ~108 on Adobe's policy), with group headers flagged. `recent-types` only returns recently used types and `itemize types` only itemization types. |
| `concur itinerary <reportId> <itinerary.json>` | Build & assign a **German Travel Allowance itinerary** (clears `GERTAB`/`NOITIN`) via the legacy Ext.Direct endpoint. `itinerary.json`: `{ "name":"...", "tacKey":"2043", "rows":[ {"departLocation":"Potsdam, GERMANY","departDate":"2026-06-29","departTime":"5:00 AM","arrivalLocation":"San Francisco, California","arrivalDate":"2026-06-29","arrivalTime":"2:00 PM"}, … ] }`. Location keys (`LnKey`) auto-resolve from the location strings; override per-row with `departLnKey`/`arrivalLnKey`. Note: meal expenses on a German-TA report must also be flagged `isExpensePartOfTravelAllowance:true` (via `new-expense --fields` or an entry update) or `GERTAB` persists. |
| `concur submit <reportId> [--source=WEB] [--approver-validated]` | Two-step submit: runs server validation, then commits. Returns `{validation, commit}` statuses (both should be `COMPLETED`). Before submitting, run `concur exceptions <reportId>` and check `hasBlockingExceptions` — the server validation step catches hard blockers, but reviewing first avoids a wasted round-trip on reports that need edits. All mutation commands (`change-type`, `attach-receipt`, `itemize`, `submit`) also refuse to run against reports that are locked (already Approved/Submitted/Paid) and report the current status instead. |

### German travel allowance (`GERTAB` / `NOITIN`)

Meal expense types (`BRKFT` Daily Meals, `01040` Group Meals, …) on a German policy are gated by two mutually exclusive blocking exceptions, and which one you get tells you the state of the `isExpensePartOfTravelAllowance` flag:

| Exception | Meaning | Fix |
|---|---|---|
| `GERTAB` "always apply Travel Allowance box" | flag is **false** | set the flag (below) |
| `NOITIN` "cannot be submitted until a Travel Allowance Itinerary is created" | flag is **true**, report has no itinerary | `concur itinerary <reportId> <itinerary.json>` |

Set the flag per itemization with `concur itemize add … --travel-allowance`, or in `bill.json` — `"travelAllowance": true` at the top level applies to every line, and a per-line `"travelAllowance"` on any `nights[]`/`extras[]` entry overrides it:

```json
{ "currency": "USD", "travelAllowance": false,
  "nights": [ { "roomRate": 283.00, "roomTax": 42.95, "date": "2026-05-18" } ],
  "extras": [ { "typeId": "ONLIN", "amount": 30.00, "comment": "In-room internet" },
              { "typeId": "BRKFT", "amount": 47.80, "travelAllowance": true } ] }
```

An itinerary only satisfies the rule — it does **not** create per-diem expense lines, so adding one to an addendum does not double-claim against the original report. After deleting a travel-allowance line, re-run `concur exceptions`: sibling meal lines can keep reporting a stale `NOITIN` until the report recomputes.

`concur itemize types <reportId> <expenseId>` lists the ~100 selectable itemization types (id, name, parent group) for the parent entry's policy — use it instead of guessing type ids.

`concur itemize hotel`/`add` now auto-resolve the required `locationId` and `exchangeRate` from the parent entry's expense form (moved card charges carry a null `location` on the summary, which previously caused a generic `400`). `concur attach-receipt` accepts PDF receipts directly with `--no-convert` (Concur stores PDFs natively; no ghostscript rasterization needed).

`concur change-type` prints `{ok, expenseId, expenseTypeId, expenseType, exceptions}` instead of the whole updated-report payload; pass `--json` for the full response.

### Escape hatches

| Command | Description |
|---|---|
| `concur ops` | List all bundled GraphQL operations. |
| `concur list-items <listId> [--search=text]` | Resolve a form picklist's items (id, code, value) — e.g. Business Purpose or Class of Service. Runs `GetFormListItems` on the **spend** surface with `{listInformation:{id,…}}` (not `cds`, and the key is `id`, not `listId`). |
| `concur exceptions <reportId>` | Report status check: lists all validation exceptions (errors/warnings) grouped per entry, with `code`, `isBlocking`, and `message` (e.g. `ITEMREQ` "Itemizations are required", `RECEIPT_REQUIRED` "You must attach a receipt image"). Returns `hasBlockingExceptions` so you can tell if a report can be submitted. For an entry with `MISSREQFLD` it also prints `missingRequiredFields` (the empty required fields from the entry form) and a `fixWith` `set-fields` command. |
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
- **Approved/paid reports expose less.** `concur report <id>` retries without `costObjects` when Concur answers 403 `reports.cannotAccess` (normal once a report is submitted) and adds a `_note` saying so, instead of failing. For full history use `concur report-v3` / `concur entries-v3`.
- **Report URL:** `https://us2.concursolutions.com/nui/expense/reports/<reportId>`. The plausible-looking `/nui/expense/report/<rptKey>` (singular, rptKey) sends the SPA into a redirect loop that appends the report id until the tab dies.
- **Mutations are real.** `UpdateExistingExpenseEntry`, `CreateReportHeader`, `MoveAvailableExpensesToReport`, `SaveExpenseAttendees`, `SubmitExpenseReport`, `AttachImage`, `MoveExpense` modify state. Several are top-level commands (`new-report`, `move`, `set-fields`, `change-type`, `attach-receipt`, `submit`); the rest are reachable via `concur graphql <op>`. They all work.

## Files

```
skills/concur/
├── SKILL.md                          # this file
├── scripts/
│   └── concur.jsh                    # CLI (auto-mapped to `concur` command)
└── references/
    ├── endpoints.md                  # API surface map (HAR-distilled)
    └── operations/                   # captured GraphQL queries (one per file)
```
