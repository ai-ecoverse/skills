# ZSA Oryx GraphQL — Endpoint catalog

Endpoint: `https://oryx.zsa.io/graphql`
Auth: `Authorization: Bearer <jwtToken>` from `localStorage.jwtToken` on
`oryx.zsa.io` / `configure.zsa.io`. The JWT payload is `{uid, exp}` —
no roles, no scopes; the user is identified by `uid`.

The API does not validate `Origin`, so a direct fetch from any host with
a valid Bearer token works. CORS is permissive in practice.

---

## Queries

### `currentUser: User`
The user identified by the JWT. Returns `null` when unauthenticated.

```graphql
{ currentUser { hashId email name admin has2fa pictureUrl } }
```

### `myLayouts: [MyLayout!]!`
All layouts owned by the current user, with the full revision history
(newest first). Each `Revision` carries hashId, title (commit message),
createdAt, model, qmkVersion, and `qmkUptodate`.

### `layout(hashId: String!, revisionId: String!, geometry: String, model: String): Layout`
A specific layout at a specific revision. `revisionId` accepts the
literal string `latest`. `geometry` is one of `voyager`, `moonlander`,
`ergodox_ez`. The `Layout.revision` payload includes `layers { keys }`
where `keys` is a Json array indexed by physical key position.

### `searchLayouts(start: Int!, limit: Int!, anonymous: Boolean, withTour: Boolean, tags: [String!]!, geometry: String): LayoutSearchResult!`
Public layout search. The result type is `LayoutSearch` (note: distinct
from `Layout`) with fields: `hashId, title, geometry, hasTour,
lastUpdate, username, commitMessage, aboutIntro, tags`. `tags` here is
`[String!]` (names), not the structured Tag type.

### `tags(limit: Int, filter: String): [Tag!]`
Available tags for `--filter` substring match. `Tag { hashId, name }`.

### `getLayoutIdByLegacyId(legacyId: String!): LayoutHashId`
For users coming from the legacy ErgoDox configurator.

### `searchLegacyLayoutsByTags(start, limit, tags): LayoutSearchResult!`
Old-style search that hits legacy ErgoDox layouts.

### `getDeletedLayers(revisionHashId: String!): [Layer!]!`
List soft-deleted layers in a revision (restorable via
`restoreLayer` mutation).

### `getTour(hashId: String!): Tour`
Walk-through metadata for a guided tour layout.

### `layerTemplate(hashId: String!): LayerTemplateResult`
A single shareable layer template.

### `layerTemplatesForLayer(layerHashId: String!): [LayerTemplate!]!`
Templates derived from a specific layer.

### `searchLayerTemplates(geometry: String!, term: String, os: [String!], tags: [String!]): [LayerTemplate!]!`
Search the layer-template catalog.

### `locale(hashId: String!): Locale!`
A custom keyboard locale (key mappings).

### `locales: [Locale!]`
All built-in + user-created locales.

### `orderData(orderId: String!): OrderData!`
Hardware order lookup.

### `otp: Otp`
Time-based 2FA setup metadata.

### `statsExport: String`
Admin / power-user analytics export.

### Auth helpers

- `authenticate(authToken: String!): Authentication!` — exchange a magic
  link or session token for a JWT.
- `loginWithEmail(email: String!, password: String!): Authentication!` —
  password login.

---

## Mutations

Each mutation returns a payload object containing the affected resource(s)
plus an `errors: [String!]` field. Treat a non-empty `errors` array as a
failure even when the HTTP status is 200.

### Layout

| Mutation                                | Notes |
|-----------------------------------------|-------|
| `createLayout(title, revisionHashId, parentHashId, geometry, mcuAlternate)` | Make a new layout, optionally forking from a parent revision |
| `deleteLayout(hashId)`                  | Soft-delete the layout |
| `updateLayoutTitle(hashId, title)`      | Rename |
| `updateLayoutPrivacy(hashId, privacy)`  | `privacy: true` ⇒ private, `false` ⇒ public |
| `updateLayoutTags(hashId, tagIds)`      | Replace the full tag set |
| `migrateLegacyLayout(legacyId)`         | Pull a legacy ErgoDox layout into Oryx |
| `saveLayoutSnapshot(layout)`            | Bulk save (used by the configurator on auto-save) |
| `reportRevision(hashId)`                | Flag a public revision |

### Revision

| Mutation                                  | Notes |
|-------------------------------------------|-------|
| `forkRevision(hashId)`                    | Create an editable fork |
| `compileRevision(hashId)`                 | Trigger a firmware build (returns hexUrl/zipUrl/md5) |
| `deleteRevision(hashId)`                  | Remove an old revision |
| `updateRevision(hashId, revision)`        | Replace large parts of the revision Json in one shot |
| `updateRevisionConfig(hashId, config)`    | Edit the QMK `config.h` knobs (auto-shift, tapping term, …) |
| `updateRevisionTitle(hashId, title)`      | Set the commit message |
| `updateRevisionIntro(hashId, intro)`      | Set the "about" intro shown on the public page |
| `updateRevisionOutro(hashId, outro)`      | Set the "about" outro |
| `updateRevisionModel(hashId, model)`      | Switch hardware sub-model |
| `updateRevisionSwatch(hashId, swatch)`    | Edit the LED swatch (per-key colors palette) |
| `updateRevisionAutomouse(revisionHash, layerPosition, automouse)` | Toggle auto-mouse on a layer |
| `updateNavigators(revisionHash, navigators)` | Edit the on-screen navigator panel mapping |
| `ackMacroRisks`                           | Acknowledge macro security warning (no args) |

### Layer

| Mutation                                                                       | Notes |
|--------------------------------------------------------------------------------|-------|
| `createLayer(revisionHashId, newKeys, position, title, automouse)`             | Insert a layer at `position` |
| `updateLayer(hashId, newKeys, position, title, color)`                         | Patch (any subset of fields) |
| `updateLayerColor(hashId, color)`                                              | Convenience |
| `deleteLayer(hashId)` / `restoreLayer(layerHashId)`                            | Soft-delete + restore |
| `reorderLayers(hashId, direction)`                                             | `direction: UP|DOWN` |
| `swapKeys(targetLayerId, sourceLayerId, targetPosition, sourcePosition)`       | Swap one or all keys between layers |
| `updateKey(hashId, keyData, position)`                                         | Patch a single key (`hashId` here is the **layer** id) |

### Combo

| Mutation                                                                 | Notes |
|--------------------------------------------------------------------------|-------|
| `upsertCombo(revisionHashId, comboIdx, name, layerIdx, keyIndices, trigger)` | Insert (omit `comboIdx`) or update (provide `comboIdx`) |
| `deleteCombo(revisionHashId, comboIdx)`                                  | Remove |

### Locale (custom keyboard layouts)

`upsertLocale(...)`, `cloneLocale(hashId)`, `compileLocale(localeId, geometry)`,
`upsertKeyMapping(...)`, `compileMapping(mappingId, geometry)`,
`deleteKeyMapping(hashId)`.

### Tags / templates / tours

`createTag(name)`, `createOrUpdateLayerTemplate(...)`,
`deleteLayerTemplate(hashId)`, `publishTour(hashId)`,
`reorderTourStep(tourHashId, sequence)`,
`updateTourStep(layerHashId, position, intro, outro, tourStepHashId, keyIndex, comboIndex, content)`,
`toggleAnnotationsGrant(hashId)`.

### Account

`signupWithEmail`, `requestPasswordReset(email)`,
`resetPassword(token, password)`, `emailChangeRequest(email)`,
`changeEmailWithToken(token)`, `updateUsername(name)`,
`disable2fa(otp)`, `otpChallenge(otp)`, `deleteAccount`.

### Misc

- `submitQcReport(report)` — quality-control feedback (admin / qc users).
- `trackEvent(event, payload)` — analytics ping (used internally; rarely
  needed from automation).

---

## Type cheatsheet

```
User       { hashId, email, name, admin, has2fa, needs2fa, identity, pictureUrl, ackMacroRisks }
MyLayout   { hashId, title, geometry, privacy, createdAt, revisions [Revision] }
Layout     { hashId, title, geometry, privacy, createdAt, updatedAt, isDefault,
             isLatestRevision, lastRevisionCompiled, parent[Layout],
             revision[Revision], tags[Tag], user[User] }
Revision   { hashId, title, model, md5, hexUrl, zipUrl, qmkVersion, qmkUptodate,
             createdAt, hasTour, mcuAlternate*, alternates[AlternateRevision],
             config[Json], swatch[Json], navigators[Json],
             layers[Layer], combos[Combo], tour[Tour] }
Layer      { hashId, title, position, color, builtIn, automouse, keys[Json], prevHashId }
Combo      { name, layerIdx, keyIndices[Int!]!, trigger[Json] }
Tag        { hashId, name }
```

The `keys` Json shape per key:

```json
{
  "tap":      { "code": "KC_A", "modifiers": null, "color": null,
                "layer": null, "macro": null, "modifier": null, "description": null },
  "hold":     null,
  "tapHold":  null,
  "doubleTap":null,
  "icon":     null,
  "emoji":    null,
  "about":    null,
  "history":  [],
  "swapped":  false,
  "detached": false,
  "pristine": true,
  "swapping": false,
  "glowColor":null,
  "customLabel":null,
  "tappingTerm":null,
  "aboutPosition":null
}
```

The `trigger` Json on combos has the **same shape** as a `tap` key blob —
combo triggers are ordinary keycodes. `keyIndices` are the physical
positions of the keys that, when pressed simultaneously, fire the combo.

Common QMK key-code prefixes:
- `KC_*` — basic keys (`KC_A`, `KC_SPACE`, `KC_LEFT_CTRL`)
- `LT(layer, KC_X)` — layer-tap (hold for layer, tap for key)
- `MT(mods, KC_X)` — mod-tap (hold for mods, tap for key)
- `MO(layer)` / `TO(layer)` / `TG(layer)` — layer ops
- `OSL(layer)`, `OSM(mod)` — one-shot
- `RGB_*`, `RGB_TOG`, `RGB_VAI` — RGB controls
- `MAC_<n>` — user macros (defined elsewhere in the revision)
