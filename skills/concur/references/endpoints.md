# Concur API endpoints

Captured from `https://us2.concursolutions.com` (Adobe / SAP Concur Expense, US2 datacenter) on 2026-05-26 via secret-sauce HAR analysis.

## Auth

- **Cookie-based** on `.concursolutions.com`.
- **No** `Authorization: Bearer` header on any captured request — the SAP IDP session cookie is the credential.
- **Custom request header** all calls send: `concur-correlationId: <uuid>` (also sent lowercased as `concur-correlationid`). The skill generates a fresh UUID per request.
- **Origin validation:** all API hosts accept `Origin: https://us2.concursolutions.com`. Calls from SLICC's localhost origin will fail; this skill issues requests from inside an open Concur tab via `playwright-cli eval-file`.

## Hosts

| Host | Purpose |
|---|---|
| `us2.concursolutions.com` | Web shell, legacy `.ashx` RPC proxy, `/homepage/v4/*` REST tiles |
| `www-us2.api.concursolutions.com` | Modern API host: GraphQL + REST (`/smartexpense`, `/messagenexus`, `/ipm`) |

(Other regions use `us`, `eu1`, `eu2`, `cn`, `ind` prefixes — same shape.)

## GraphQL surfaces

### `POST https://www-us2.api.concursolutions.com/spend-graphql/graphql`

The main expense management API. Captured operations (all in `operations/*.graphql`):

**Reports**
- `GetReportsForUser` — paginated report list, filter by status (`ACTIVE`, `PAID`, etc.)
- `GetReportPageData` — full report incl. summary, entries, exceptions, policy, workflows
- `GetReportPageSecondaryData` — comments, cash advances, requests, travel allowance, print formats
- `GetReportExceptionsAndEntries`
- `GetReportFormFields`, `GetNewReportFormFields`
- `GetReportHeaderExceptions`
- `GetReportTotals`, `GetReportTravelAllowanceStatus`
- `GetReportIdAndKey`, `GetRptKey`
- `GetExpenseReportDetails`
- `CreateReportHeader` (mutation), `SubmitExpenseReport` (mutation)

**Expense entries**
- `GetExistingExpenseEntries`, `GetExistingExpenseEntry`, `GetExistingExpenseEntryForReceipts`
- `GetExistingExpenseForm`, `GetExistingItemizationForm`
- `GetExistingEntryExceptions`
- `GetExpenseFormExpenseTypes`, `GetExpenseProviderData`
- `GetNewItemizationForm`, `GetNewItemizationExpenseTypesForm`
- `GetRecentExpenseTypes`
- `UpdateExistingExpenseEntry` (mutation), `MoveExpense` (mutation), `MoveAvailableExpensesToReport` (mutation)
- `FindMatchingAvailableExpenses`, `MatchAvailableExpensesToReport`
- `GetAvailableExpenses`

**Receipts / images**
- `GetAvailableReceipts`, `GetProcessingReceipts`
- `GetLineItemImage`, `GetLineItemImages`, `GetLineItemImageForExpenseSource`
- `AttachImage` (mutation)
- `GetGroupSettingsForReceipts`

**Attendees**
- `GetAttendeesByPredictiveSearch`, `GetMRUAttendees`, `GetAttendeesMeta`
- `SaveExpenseAttendees` (mutation)

**Reference data**
- `GetCountries`, `GetCurrencies`, `GetPaymentTypes`
- `GetListItems`, `GetFormListItems`
- `GetRecentLists`, `GetRecentLocations`, `AddMultipleRecentLists` (mutation)

**Travel allowance**
- `GetTravelAllowanceConfig`, `GetTravelAllowancePolicies`
- `GetPolicyTravelAllowanceDisabled`

**User / settings**
- `GetUserPermissions` — returns `userId`, `isExpenseItEnabled`, `isBondUser`, `isVerifyAIUser`, `isCashAdvanceUser`, `isRequestTraveler`
- `GetUserAIPermissions`
- `GetPolicies`
- `GetCardAccounts`
- `GetSiteSettings`, `GetHomepageSettings`
- `CXPEnabledStatus`

### `POST https://www-us2.api.concursolutions.com/cds/graphql`

Common Data Service GraphQL — much smaller surface, used for on-screen help and feature flags.

- `GetOnScreenHelpData` — three captured shapes (with/without `featureCodes`, with/without `sessionId`)

### `POST https://www-us2.api.concursolutions.com/spend-graphql/upload`

Multipart file upload for receipt images. Wrapped by `concur attach-receipt`, which converts/downscales the image, POSTs the multipart `FormData` here to get an `imageId`, and then runs the `AttachImage` mutation to bind it to a specific expense entry. Call via `pageFetch` directly if you need raw upload behavior.

## REST endpoints

### `GET /smartexpense/v4/users/{userId}/context/{context}/smartexpenses?size=N`

Host: `www-us2.api.concursolutions.com`. The SmartExpense queue (e-receipts, ExpenseIt scans, etc.). `context` is `TRAVELER` for normal user, other roles for delegates/approvers.

```json
{ "content": [], "page": { "number": 1, "size": 25, "totalElements": 0, "totalPages": 0 } }
```

### `GET /messagenexus/v1/messages?sort=timestamp&order=descending`

Host: `www-us2.api.concursolutions.com`. System messages.

### `GET /messagenexus/v1/messages/newMessageCount`

Host: `www-us2.api.concursolutions.com`. Polled aggressively (~67 times during the recording). Just an unread counter.

### `GET /ipm/api/users/v2/messages/`

Host: `www-us2.api.concursolutions.com`. In-product messaging (banners/tips). Polled often.

### `POST /ipm/api/log/metric`

Host: `www-us2.api.concursolutions.com`. Telemetry write — ignored by this skill.

### `GET https://us2.concursolutions.com/homepage/v4/{tile}/{userId}?lang=en`

Convenience API for the home page. Tiles seen:

- `alerts` — `{"hasExpenseDataIntegration": false}` (just feature flags)
- `approvals` — `{"approvals":[], "taskCounts":{...}, "taskErrors":[], "totalCount":0}`
- `notes` — internal news + travel note (Adobe-customized HTML)
- `reports` — `{"content":[...], "page":{number,size,totalElements,totalPages}}` — same as GraphQL reports list, simpler shape

> **Auth caveat — does NOT work from this skill.** The `homepage/v4/*` server checks for `Authorization: Bearer <jwt>` and ignores cookies. The JWT lives in an HttpOnly cookie called `JWT` on `.concursolutions.com`, but JS in the page cannot read it. The Concur SPA somehow obtains a Bearer token (probably through an internal token-exchange flow we haven't isolated yet), so a fetch from `playwright-cli eval` returns 401 even though all other endpoints work. As of skill compilation, use `/api/v3.0/expense/reports` for the reports tile and `concur graphql GetUserPermissions` etc. for the rest.

### `GET https://www-us2.api.concursolutions.com/api/v3.0/*`  (Concur Platform API)

Full public REST surface. Cookie-auth works through page-context fetch.

- `GET /api/v3.0/expense/reports?limit=N&offset=N&user=<email>&modifiedAfter=<iso>` — full historical report list, all statuses. Each item includes `Name, Total, CurrencyCode, Country, CreateDate, SubmitDate, ProcessingPaymentDate, PaidDate, ApprovalStatusName, PaymentStatusName, OwnerLoginID, ID, ...`
- `GET /api/v3.0/expense/reports/{reportId}` — single report header + custom fields + OrgUnit values.
- `GET /api/v3.0/expense/entries?reportID=<id>&limit=N&offset=N` — line items, optionally filtered to one report. Each item: `ExpenseID, ReportID, ExpenseTypeCode, ExpenseTypeName, SpendCategoryCode, TransactionDate, TransactionAmount, TransactionCurrencyCode, VendorDescription, BusinessPurpose, ...`
- `GET /api/v3.0/expense/attendees?limit=N` — attendee book.
- `GET /api/v3.0/expense/reportdigests?limit=N` — lighter-weight report list.
- `GET /api/v3.0/common/locations?name=<prefix>&country=<ISO>&limit=N` — location reference data.

Confirmed 404/410 (don't try):
- `/api/v3.0/expense/exceptions`
- `/api/v3.0/expense/quickexpenses` — server returns "This API is decommissioned"
- `/api/v3.0/receipts/`

## Legacy ASP.NET RPC

### `POST https://us2.concursolutions.com/expense/expenseDotNet/Proxy/expenseRouter.ashx?requests=<RPC1>%2C<RPC2>`

The old Expense codebase. Multiple RPCs comma-separated in the `requests` query param. Captured calls:

- `ExpenseReport:GetReportHeader`
- `Location:GetLocations`
- `TravelAllowance:GetTaConfig`, `GetTripLengthList`, `GetUsedItinDatesForEmp`
- `TravelAllowance:GetAvailableTaItineraries`, `GetAssignedTaItineraries`, `GetTaAddressMrus`, `GetTaFixedAllowances`
- `TravelAllowance:ValidateAndSaveItineraryRow`, `UpdateFixedAllowances`

Request body is form-encoded. **Not currently exposed as named commands** — the GraphQL surface covers most of these. Use `pageFetch` directly if you need them.

## Identifiers seen

- **userId** — UUID, e.g. `00000000-0000-0000-0000-000000000000`. Required by almost every GraphQL op. Discovered via `GetUserPermissions`.
- **reportId** — 20-char hex ID, e.g. `A1B2C3D4E5F60718293A`. From `reports` listing or the URL of a report page.
- **rptKey** — opaque base64-ish string, e.g. `EXAMPLEKeyEXAMPLEKeyEXAMPLEKeyEXAMPLEKeyEXAMPLEKey`. Used by the legacy `.ashx` RPCs.
- **expenseId** — present on each line item in `GetReportExceptionsAndEntries.list[].expenseId`.
- **imageId** — used by `GetLineItemImage` to fetch receipt images.

## Sample responses

### `GetReportsForUser` → `data.employee.reportsForUser.list[]`

```json
{
  "reportId": "A1B2C3D4E5F60718293A",
  "reportNumber": "ABCD12",
  "name": "Q3 Conference Travel",
  "approvalStatus": "Not Submitted",
  "approvalStatusId": "A_NOTF",
  "paymentStatus": "Not Paid",
  "reportDate": "2026-05-26",
  "reportType": "REGULAR",
  "approvedAmount":   { "currencyCode": "EUR", "value": 6418.76 },
  "claimedAmount":    { "currencyCode": "EUR", "value": 6418.76 },
  "reportTotal":      { "currencyCode": "EUR", "value": 6418.76 },
  "totalAmountDueEmployee": { "currencyCode": "EUR", "value": 0 },
  "exceptionLevel": "NONE",
  "wasSentForPayment": false,
  "submitDate": null,
  "sentBackDate": null,
  "rptKey": "EXAMPLEKeyEXAMPLEKeyEXAMPLEKeyEXAMPLEKeyEXAMPLEKey",
  "meta": {
    "canAddExpense": true,
    "isMarkedForReviewByDelegate": false,
    "isApproved": false,
    "isPendingApproval": false,
    "isSentBack": false,
    "isSubmitted": false,
    "isReopened": false
  }
}
```

### `GetUserPermissions` → `data.userPermissions`

```json
{
  "userId": "00000000-0000-0000-0000-000000000000",
  "isRequestTraveler": false,
  "isCashAdvanceUser": false,
  "isExpenseItEnabled": "ON",
  "isBondUser": false,
  "isVerifyAIUser": false
}
```

### `GET /homepage/v4/reports/{userId}` (empty for this user)

```json
{ "content": [], "page": { "number": 1, "size": 25, "totalElements": 0, "totalPages": 0 } }
```

## Filter status values

`GetReportsForUser.variables.filterByStatus` — observed: `ACTIVE`. Other values from the UI:
`PAID`, `PENDING_APPROVAL`, `RETURNED`, `SUBMITTED`, `IN_PAYMENT_PROCESS`, `EXTRACTED_FOR_PAYMENT`, `APPROVED`, `NOT_SUBMITTED`. Try them as-is; the GraphQL will reject unknown enums clearly.
