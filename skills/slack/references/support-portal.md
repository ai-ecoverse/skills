# Slack support on Salesforce Help (`slack-support`, `intercom`)

Reference for the commands summarised in SKILL.md ("Slack support cases"). Everything
here was captured live on 2026-11-09 unless marked otherwise.

## Where cases live

- The old portal, `<org>.enterprise.slack.com/help/requests`, shows "Support has a new
  home" and lists legacy requests read-only. Its **My Cases** link goes through
  `iis.digital.salesforce.com/relay?community=Help_Portal&provider=slack&path=/cases`
  and signs the user in to `https://help.salesforce.com/s/cases`.
- help.salesforce.com is a Salesforce Experience Cloud (Aura) site. The Slack org shows
  as its id (`E0…`) with its support plan.
- New cases are not a form: **Ask Agentforce** opens an Intercom Messenger with the AI
  agent "Fin", which creates the case.

## Files

| file | what |
| --- | --- |
| `scripts/slack-support` | the command (`#!/usr/bin/env jsh`, no extension) |
| `scripts/intercom` | the Intercom command |
| `scripts/sfhelp-aura.js` | Aura/Apex client, no I/O |
| `scripts/intercom-messenger.js` | Intercom messenger client, no I/O |
| `scripts/support-args.js` | argv parser for both commands |
| `tests/slack-support.test.js` | tst suite, offline, recorded responses |

The clients take an `evalInPage(source)` function and send it self-contained page code
(a serialized function plus JSON arguments). Tokens and session fields are read and used
in the page; only API responses come back.

`sliccy:browser` 0.1.42 evaluated in a same-origin child frame of the tab (Intercom's
launcher iframe) rather than the top document, so the page code works on `window.top`.

## Aura (cases)

```
POST https://help.salesforce.com/s/sfsites/aura?r=1&aura.ApexAction.execute=1
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
message      {"actions":[{"id":"1;a","descriptor":"aura://ApexActionController/ACTION$execute",
              "callingDescriptor":"UNKNOWN","params":{"namespace":"","classname":C,"method":M,
              "params":P,"cacheable":false,"isContinuation":false}}]}
aura.context {mode, fwuid, app:"siteforce:communityApp", loaded, dn:[], globals:{}, uad:false}
aura.pageURI the tab's path and query
aura.token   the CSRF token
```

- `fwuid` is the path segment after `/auraFW/javascript/` in the framework `<script src>`.
  A wrong or empty one answers `*/{"event":{"descriptor":"markup://aura:clientOutOfSync"}…}/*ERROR*/`.
- `$A.clientService.getToken()` returns the token only behind an internal flag. Its source
  (`function(){if(this.os)return this.Ec}`) names the minified field, which the client
  reads at run time. A wrong token answers `aura:invalidSession` with `invalid_csrf`.
- `actions[0].returnValue.returnValue` is usually a JSON **string**; parse it again.

| class.method | params | returns |
| --- | --- | --- |
| `HC_RequestsController.getActiveContext` | — | JSON `{orgId, orgName, username, cloud, …}` |
| `HC_CaseRequestsController.getCasesTableFilters` | — | `[{value,label}]`: 1 My Open Cases, 2 My Closed Cases, 5/6 Success Activities |
| `…getCasesTableRecords` | `{params: JSON {filterName:"", searchValue, filterValue, sortValue:"priorityStatus", sortDirection:"desc", loadLimit, offset}}` | `[{caseId, caseNumber, subject, status, openDate, contactName, link}]` |
| `…getCasesTableTotalCount` | same | number |
| `…getCaseViewTemplate` | `{caseId, caseRecord:null}` | subject, status, caseNumber, `sections.details` (product, topic, severityLevel, description), `sections.comments.comments[]`, `sections.attachments.files[]`, `sections.statusBar.buttons.data` (isClosed, isCloseDisabled, isReopenDisabled, isEscalateAvailable, severityLevelOptions, escalationReasons) |
| `…submitCaseComment` | `{inputData: JSON {caseId, commentBody:"<p>html</p>", contentDocumentIds:[], versionIds:[]}}` | `{isSuccess, message, caseComment}` |

- `caseId` is the 18-character record id (`500…`); `caseNumber` is the 9-digit display number.
- `commentBody` is HTML. Escape `& < > "` and wrap paragraphs in `<p>`; `commentText`
  comes back HTML-escaped and is decoded once for display.
- Attachments (not in the CLI yet): `lightning-file-upload` calls
  `serviceComponent://ui.chatter.components.aura.components.forceChatter.chatter.PublisherFileAttachmentController/ACTION$saveContentVersion`
  with `{title, firstPublishLocationId: caseId, pathOnClient, contentBodyId}` →
  `{versionId: "068…", docid: "069…"}`; then `submitCaseComment` with those ids links the
  file to the comment. Setting the file input from code made the widget upload twice.
- Seen but not exercised: `HC_RequestsController.getSessionId` (would mint a REST API
  session; `/services/data/v62.0/sobjects/...` otherwise answers 401 INVALID_SESSION_ID).
- Close, reopen, escalate and severity changes: not captured yet.

## Intercom (Fin)

help.salesforce.com boots Intercom app `udbi4dh7` with an identity-verification JWT from
Salesforce (`window.intercomSettings.intercom_user_jwt`). The end user has no API key.

- Messenger calls are form posts to `https://api-iam.intercom.io/messenger/web/<path>`.
  Each carries the widget session: `app_id, v=3, g, s, r, platform, user_data,
  anonymous_session, device_identifier, messenger_environment, page_title, referer,
  Idempotency-Key`. `user_data`, `s` and `anonymous_session` are credentials.
- The client calls `Intercom('update')`, which makes the widget send `/messenger/web/ping`;
  a temporary XHR/fetch hook keeps that body in page memory (`window.top.__sliccIcTpl`)
  and is removed at once. Calls reuse it with `source`/`sampling` dropped and a fresh
  `Idempotency-Key`; a 401/403 borrows a new body once.
- The page helper only calls allowlisted paths: `conversations`, `conversations/<id>`,
  `conversations/<id>/reply`, `messages`.

| path | verified | notes |
| --- | --- | --- |
| `/messenger/web/conversations` | live | `{pages, conversations:[{id, title, state, updated_at, …}]}` |
| `/messenger/web/conversations/<id>` | live | `conversation_parts[{id, part_type, author{type: widget_user|Admin, name}, created_at, blocks}]`, `state` (`state_closed`), `prevent_end_user_replies`, `salesforce_external_reference`, `escalated_to_salesforce` |
| `/messenger/web/messages` | from the widget code | new conversation: `blocks` (JSON `[{type:"paragraph", text:<escaped html>}]`), `created_at`, `client_assigned_uuid` |
| `/messenger/web/conversations/<id>/reply` | from the widget code | same fields |

The `create` flow that opened case 400000002 by hand: an opening message naming the
severity; Fin asked whether to get the team, then offered live chat; the reply "I'd prefer
a case I can follow up on asynchronously rather than live chat. Please create the case."
got "Case #400000002 has been opened and is under review." and the chat closed. Fin wrote
the subject ("Slack mobile Link Preview Bug: Slack"), topic "Using Slack" and severity
from the text, and its description dropped the example URL and turned `&#x26;` into `&`.

The first `slack-support create` and `intercom reply/new` run confirms the send format;
update the table when it does.

## Libraries considered

- `intercom-client` (npm) is Intercom's admin REST API and needs a workspace access token.
- `@intercom/messenger-js-sdk` wraps `window.Intercom()`, which can open and prefill the
  messenger but cannot read conversations.
- jsforce and the Salesforce REST API need an API session the portal doesn't issue to the page.
- jerk: no API key is involved. `jerk tab export | jerk tab import` can move a signed-in
  help.salesforce.com tab between browsers for jsh on a host, without IndexedDB.

## Instrument notes

- `playwright-cli har-start` recorded none of the Aura POSTs (it classed them protected)
  and blanked query values: 129 GETs only. Use an in-page XHR hook that logs the
  `message` field, never `aura.token`.
- Intercom's `/rtm/authorize` response is a realtime subscription token; hooks skip it.
- The comment editor is not in the ARIA snapshot; it takes focus from a mouse click.
