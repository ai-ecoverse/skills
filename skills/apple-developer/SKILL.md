---
name: apple-developer
description: Apple Developer portal (Certificates, Identifiers & Profiles) from the
  browser session. Lists developer teams, signing certificates (Developer ID
  Application, Apple Distribution, Apple Development) with serials and expiry, App IDs
  and their capabilities (iCloud, push, app groups), and provisioning profiles;
  downloads a .provisionprofile or prints it as base64 for a CI secret; registers an App
  ID with capabilities; creates Developer ID, App Store or development profiles. Use
  when the user wants to create or renew a provisioning profile, enable iCloud for an
  app, register a bundle ID, check which certificate a profile uses or when it expires,
  or put a profile into a GitHub Actions secret. Triggers on developer.apple.com,
  provisioning profile, embedded.provisionprofile, Developer ID, App ID, bundle ID, team
  ID, entitlements, ubiquity-kvstore, codesign profile, notarization setup.
allowed-tools: bash
---

# Apple Developer portal

`apple-developer` drives the portal's own JSON:API backend
(`https://developer.apple.com/services-account/v1/`) from a signed-in
developer.apple.com tab. It needs no App Store Connect API key: the tab's session
does the work, so it can do what the portal's UI does for that Apple ID.

## Quick start

```bash
apple-developer teams                                 # team IDs (pass --team when you have several)
apple-developer certs --type DEVELOPER_ID_APPLICATION # IDs, serials, expiry
apple-developer bundle-id ai.example.mac              # App ID with its capabilities
apple-developer profiles --type MAC_APP_DIRECT        # Developer ID profiles
apple-developer profile download "Example Developer ID"            # writes a 0600 file, prints its path
apple-developer profile download K2Q8T6ZQTP --base64 | gh secret set PROFILE_BASE64 --env signing
```

## Create an App ID and a Developer ID profile with iCloud

Creates print the exact request and change nothing until you add `--confirm`.

```bash
apple-developer capabilities | grep -i icloud         # capability IDs: ICLOUD, PUSH_NOTIFICATIONS, …
apple-developer bundle-id create ai.example.mac --name Example --capability ICLOUD
apple-developer bundle-id create ai.example.mac --name Example --capability ICLOUD --confirm
apple-developer profile create --name "Example Developer ID iCloud" --type MAC_APP_DIRECT \
  --bundle-id ai.example.mac --cert 714FB0EAF0BEA248 --confirm   # cert by serial or ID
apple-developer profile download "Example Developer ID iCloud" --out ./embedded.provisionprofile
security cms -D -i ./embedded.provisionprofile        # check the Entitlements before signing
```

A Developer ID profile with iCloud grants
`com.apple.developer.ubiquity-kvstore-identifier = <TEAMID>.*`, so the app may sign
with any key-value container of the team, such as one shared with another app.

Profile types: `MAC_APP_DIRECT` (Developer ID), `MAC_APP_STORE`, `MAC_APP_DEVELOPMENT`,
`IOS_APP_STORE`, `IOS_APP_ADHOC`, `IOS_APP_DEVELOPMENT`, the `TVOS_` ones, and
`MAC_CATALYST_APP_*`. Development and ad hoc profiles also need devices, which this
CLI doesn't add yet; create those in the portal.

## Flags

- `--team <TEAMID>`: the team. Default `$APPLE_TEAM_ID`, else your only active team. With
  several teams and neither set, it stops and lists them.
- `--json`: raw rows.
- `--confirm`: send a create. Without it, print the body.

## Notes

- A profile expires with its certificate in the portal, even when the file's own
  `ExpirationDate` is later. Renewing a certificate means creating the profiles again.
- `profile download` writes a new 0600 file renamed into place. Without `--out` it goes
  into a fresh private temp directory.
- Not covered yet: turning capabilities on or off for an existing App ID (the portal
  sends the App ID's whole capability list), devices, certificates creation, and
  deleting anything. Use the portal for those; `references/portal-walkthrough.md` has a
  recorded UI walkthrough.

## Setup

In SLICC 7: `cd /opt/user && pnpm add <path-to>/skills/apple-developer`.
On a host: install [jsh](https://github.com/ai-ecoverse/slicc-jsh), then
`npm install -g "$(npm pack ./skills/apple-developer)"`. Chrome must have a DevTools
port (`SLICC_CDP_URL`, default `http://127.0.0.1:9222`) and a signed-in
https://developer.apple.com/account tab.

See `references/endpoints.md` for the API, how it was found, and how to re-capture it
when Apple changes it.
