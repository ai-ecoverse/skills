# Workday UI endpoints used by `workday`

Captured live on 2026-11-25 against a `myworkday.com` tenant, from the
requests Workday's own web client makes. `<t>` is the tenant, the first path
segment of every Workday URL (`/<t>/d/home.htmld`). All requests run in the
Workday tab (`sliccy:browser` `fetch`), so they carry its session cookies; none
needs an extra header.

Workday instance IDs are `<class>$<number>`: `247$…` a worker, `2500$…` a
supervisory organization, `2998$…` a task, `216$…` a location.

## Errors come back as HTTP 200

A bad or incomplete request usually answers **200** with an XML body, not JSON:

```xml
<wml:System_Error …><wml:Message>Missing Required Parm: Navigable_Task--IS (15$35098)</wml:Message></wml:System_Error>
<wml:Application_Error Type="Server Error"><wml:Message>There was an error processing your request. …</wml:Message></wml:Application_Error>
```

### Rate limit

A burst of requests gets HTTP **200** and

```xml
<wml:Application_Error … Type="Validation"><wml:Message>Too many repeating requests. Please try again later.</wml:Message></wml:Application_Error>
```

Only this message means "wait and retry" (`isRateLimited()`); `call()` waits 15 s,
30 s, 60 s and gives up after the 4th try. Other `Application_Error` bodies are final.

A lapsed session, or a URL that doesn't exist, gives an HTML page (404 or 200).
So check the body before you parse it as JSON (`workdayError()` in `scripts/lib/workday.js`).

## Current user

`GET /<t>/home.htmld` → JSON root; `currentUser.iid` is the worker ID
(`247$…`) and `currentUser.label` the name. `/<t>/d/home.htmld` is the HTML
shell, not this.

## People search

`GET /<t>/search.htmld?q=<text>&autocomplete=true` → `autoCompleteSearchList` with
up to 10 `listItems`. Each one has `instanceId`, `label`, `classLabel`, `iconId`,
`subtitle1` (business title), `subtitle2` (org), `subtitle3` (location) and `uri`
(`/<t>/inst/autocompletesearch/<id>`). The list mixes people (`iconId:
wd-icon-user`, `classLabel: Employee`) with tasks, custom organizations and
reports, so filter. Without `autocomplete=true`, the response is a federated
results layout with no items in it.

## Worker profile

`GET /<t>/inst/autocompletesearch/<247$id>.htmld` (or `/<t>/inst/1$37/<id>.htmld`) →
`body.widget: profile`.

- `title.instances[0]`: ID and name.
- `body.compositeViewHeader.contactInfo` (`contactLayout`): `businessTitle`,
  `primaryEmail`, `firstName`, `lastName`, and `organization`, the org path as
  `A (Owner) >> B (Owner)`.
- A `monikerList` with `propertyName: wd:Manager_For_Position--IS`: managers.
- `propertyName: wd:Location_Not_Secured--IS`: location.
- A `commandButton` with `propertyName: wd:View_Team`: `uri` of the team page,
  `/<t>/inst/4547$…/rel-task/2998$…`.

## Team page (hierarchy navigator)

`GET <View_Team uri>.htmld` → `body.widget: hierarchyNavigator`:

- `navigatorInstance.instances[0]`: the org ID and name. That is the org the worker
  **leads** if they are a manager, else the org they are in.
- `taskIid` (a `2998$…` task ID) and `navigationUri` (`/<t>/navigable`): what the
  org chart request needs. Read them from here, don't hard-code them.
- `ancestors[]`: the parent orgs, nearest first, as `navigatorDetail` nodes.

## Org chart

`POST <navigationUri>/<id>.htmld`, `Content-Type: application/x-www-form-urlencoded`,
body `initial-step=<taskIid>` → `body.navigatorContainers[]`, one each of
`navigatorContainerNodeType` `PARENT`, `SELF` and `CHILD_NODES_AND_LEAVES`.

- `<id>` is a supervisory org (`2500$…`). A worker ID (`247$…`) works too, but its
  `SELF` is the worker alone and `CHILD_NODES_AND_LEAVES` is empty.
- The web client also sends `navigable-instance-iid`, `-set-id`, `-did`,
  `-worker-iid` and `effective`. Only `initial-step` is required: without it,
  the request fails with the `Missing Required Parm` XML above.
- Each `navigatorDetail` node: `navigatorInstance.instances[0]` (ID and name),
  `leaf: true` for a person, `childrenAndPeersCount`, `hasChildren`, and
  `navigatorItems[]` with `owner` (the org's leader, or the person),
  `detailOne` (business title) and `detailTwo` (location).
- The children container has `count` (total members) and `chunkingUrl`.

### More children

`GET <chunkingUrl>.htmld?startRow=<n>&maxRows=<m>` → `navigatorDetailsChunk`
with `totalCount` and `navigatorDetails[]`. The chunk URL is a server-side
cursor (`/<t>/navigablechunk/c…/<n>`) and goes stale: read straight after its
org chart request it answers, but reused after other requests it answers the
`Application_Error` XML. Page through it immediately, once per org, before the next org's request.
Never cache a chunk response or its URL: cache the assembled member list of the
org instead (the `workday` cache does). The first response carries only part of
a large org (`count` is the total, the list is shorter), so a walk that skips the
chunk requests drops people without any error. `workday` asks for 50 rows a chunk
and marks an org `incomplete` (not cached) if the list still falls short.

## Not used

- `/wday/sirg/protectedapi/navigableInternal/v1/<t>/workers/<id>?navigableTask=…`
  (the side panel of the org chart) needs a `Session-Secure-Token` header from
  page state, and answered 404 `not found` for a worker ID from the profile.
- The `/wday/pex/graphql/*` calls serve the home page, not the org chart.

## Capturing this again

A HAR recording of a Workday tab held only `/wday/asset/` static files: no app
request, and no bodies even with `--content embed`. To find the requests, read
`performance.getEntriesByType('resource')` in the tab for the URLs, then call them
with `curlwright --tab <id>` to see the bodies. The request shapes (`initial-step`,
the chunk query) come from the org chart bundle (`uic-orgchart/wd-org-chart.min.js`):
search it for `navigationUri` and `chunkingUrl`.
