# Apple Developer portal API

Found on 2026-11-18 while registering `ai.sliccy.mac` with iCloud and creating its
Developer ID profile in Certificates, Identifiers & Profiles. Method:

1. `playwright-cli recording-start --tab <id>` and `har-start --tab <id> --content embed`
   on the signed-in tab, each held open by a background `sleep | …`. Every step was
   driven with `--intent "<what this step does>"`, so the recorded actions carry
   comments (`portal-walkthrough.md`).
2. `playwright-cli requests` listed the XHRs. The HAR kept only document loads and
   static assets, not the portal's XHRs, but it embedded the portal bundle
   (`/account/resources/static/js/main.<hash>.js`). The request builders in that
   bundle gave the exact request shapes below.
3. Each shape was checked against the live API with page-context `fetch`: reads for
   real, writes only against requests the server refuses (a duplicate identifier, an
   App ID that doesn't exist), so the probes created nothing.

## Transport

Base: `https://developer.apple.com/services-account/v1/`, same origin as the portal,
cookies only. The tab's session is the credential; nothing is stored.

| | Method | Headers | Body |
| --- | --- | --- | --- |
| Read | `POST` | `Content-Type: application/vnd.api+json`, `X-Requested-With: XMLHttpRequest`, `X-HTTP-Method-Override: GET` | `{"urlEncodedQueryParams":"<query>","teamId":"<TEAMID>"}` |
| Write | `POST` / `PATCH` | the same, without the override, plus `csrf` and `csrf_ts` | JSON:API document |

- A plain `GET` answers 403 `"Please select a team."`: the team must be in the body.
- Every API response carries `csrf` and `csrf_ts` response headers. The portal stores
  the last pair and sends it on writes (`Gn`/`Kn` in the bundle). A write without
  them answers 421 `Bad Request`. The CLI reads `certificates?limit=1` first to get a
  pair.
- Query strings use App Store Connect syntax: `filter[identifier]=…`, `include=…`,
  `limit=…`, with literal brackets and commas. `filter[identifier]` also matches
  prefixes, so filter the result again for an exact identifier.
- Errors are JSON:API `errors[]` with `code`, `detail` and sometimes `resultCode`.

Teams come from the older action API:
`POST /services-account/QH65B2/account/listTeams.action`, `Content-Type:
application/x-www-form-urlencoded`, empty body → `{teams:[{teamId,name,type,status,…}]}`.
A JSON body answers 415.

## Resources

| Resource | Notes |
| --- | --- |
| `certificates` | `filter[certificateType]=DEVELOPER_ID_APPLICATION`; attributes `name`, `serialNumber`, `expirationDate`, `certificateContent` (DER, base64) |
| `bundleIds` | `filter[identifier]`, `include=bundleIdCapabilities`; capability rows are `<bundleId>_<CAPABILITY>` with `settings` such as `ICLOUD_VERSION=XCODE_6` |
| `capabilities` | `filter[capabilityType]=capability,service&filter[includeRequestable]=true`; IDs such as `ICLOUD` |
| `profiles` | `filter[name]`, `filter[profileType]`, `include=bundleId,certificates`; `profileContent` is the signed `.provisionprofile`, base64, byte-identical to the portal's Download |

The portal's Download link is
`/services-account/QH65B2/account/{mac|ios}/profile/downloadProfileContent?teamId=…&provisioningProfileId=…`
(cookie GET, `application/octet-stream`). The CLI uses `profileContent` instead.

## Write shapes (from the portal bundle)

Create an App ID (`POST bundleIds`), from the App ID form's submit handler:

```json
{"data":{"type":"bundleIds",
  "attributes":{"identifier":"ai.example.mac","seedId":"TEAMID","teamId":"TEAMID","name":"Example"},
  "relationships":{"bundleIdCapabilities":{"data":[
    {"type":"bundleIdCapabilities","attributes":{"enabled":true,"settings":[]},
     "relationships":{"capability":{"data":{"type":"capabilities","id":"ICLOUD"}}}}]}}}}
```

Settings are only sent for capabilities that have options (for example
`{"key":"ICLOUD_VERSION","options":[{"key":"XCODE_6"}]}`). The server applies the
default for single-option settings: `ai.sliccy.mac` came out as `ICLOUD_VERSION=XCODE_6`.

Create a profile (`POST profiles`), from the "Review, Name and Generate" step:

```json
{"data":{"type":"profiles",
  "attributes":{"name":"…","profileType":"MAC_APP_DIRECT","teamId":"TEAMID"},
  "relationships":{"bundleId":{"data":{"type":"bundleIds","id":"<resource id>"}},
                   "certificates":{"data":[{"type":"certificates","id":"<resource id>"}]}}}}
```

Development and ad hoc profiles also send `relationships.devices`. Mac Catalyst
profiles change `MAC_` to `MAC_CATALYST_`.

Edit an App ID's capabilities: the edit form sends `PATCH bundleIds/<id>` with the
App ID's whole `data` (minus `platform` and `links`) and a full
`relationships.bundleIdCapabilities.data` list. Capabilities that are switched on have
`enabled: true`, and ones switched off have `enabled: false`. `POST bundleIdCapabilities`
on its own is refused (`relationship 'capabilities' … not allowed`). The CLI doesn't
implement this yet, because a wrong list could switch off capabilities.

## Re-capturing after a change

Open the portal page for the action, run `playwright-cli requests --tab <id>` after it,
and look up the request builder in the bundle: search `main.<hash>.js` for the resource
name (`"/services-account/v1/bundleIds"`, `type:"profiles"`). Check a new write shape
against a request the server refuses before you send a real one.
