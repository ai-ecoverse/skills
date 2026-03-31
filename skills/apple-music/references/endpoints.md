# Apple Music API — Endpoint Reference

## Authentication

Every request requires two headers:

| Header | Source | Description |
|--------|--------|-------------|
| `Authorization` | `Bearer <developerToken>` | Static MusicKit JS developer token (JWT), embedded in the web player |
| `media-user-token` | `<userToken>` | User's Apple Music session token |

Extract from the page context:
```js
const mk = window.MusicKit.getInstance();
const developerToken = mk.developerToken;
const userToken = mk.musicUserToken;
```

## Base URLs

| Host | Purpose |
|------|---------|
| `amp-api-edge.music.apple.com` | Catalog search and public endpoints |
| `amp-api.music.apple.com` | Library/personal endpoints (playlists, etc.) |

## Storefront

The user's storefront is a two-letter country code (e.g., `us`, `de`, `gb`) that appears in catalog URLs. Detect it from the Apple Music page URL (e.g., `music.apple.com/de/...`) or the user's locale settings. The `l` parameter provides locale-specific formatting (e.g., `l=en-US`, `l=de-DE`).

---

## 1. Search Catalog

Search the Apple Music catalog for songs, albums, artists, and playlists.

```
GET https://amp-api-edge.music.apple.com/v1/catalog/{storefront}/search
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `term` | string | yes | URL-encoded search query |
| `types` | string | yes | Comma-separated: `songs`, `albums`, `artists`, `playlists` |
| `limit` | integer | no | Results per type (default 21, max 25) |
| `l` | string | no | Locale (e.g., `en-US`) |
| `platform` | string | no | `web` |
| `fields[albums]` | string | no | Field selection for albums |
| `fields[artists]` | string | no | Field selection for artists |
| `include[songs]` | string | no | Related resources to include (e.g., `artists`) |
| `relate[songs]` | string | no | Related resources to relate (e.g., `albums`) |
| `format[resources]` | string | no | `map` — returns resources as a keyed map |

### Example Request

```
GET /v1/catalog/de/search?term=what+is+love&types=songs&limit=5&format[resources]=map&platform=web&l=de-DE
```

### Example Response

```json
{
  "results": {
    "song": {
      "data": [
        {"id": "1731434189", "type": "songs", "href": "/v1/catalog/de/songs/1731434189"}
      ],
      "next": "/v1/catalog/de/search?offset=5&term=what+is+love&types=songs"
    }
  },
  "resources": {
    "songs": {
      "1731434189": {
        "id": "1731434189",
        "type": "songs",
        "attributes": {
          "name": "What Is Love (7\" Mix)",
          "artistName": "Haddaway",
          "albumName": "The Album",
          "durationInMillis": 270373,
          "artwork": {
            "url": "https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/.../{w}x{h}bb.{f}",
            "width": 1200,
            "height": 1200
          },
          "genreNames": ["Pop"],
          "releaseDate": "1993-06-07",
          "url": "https://music.apple.com/de/song/what-is-love-7-mix/1731434189"
        }
      }
    },
    "artists": {},
    "albums": {}
  }
}
```

---

## 2. Search Suggestions

Get autocomplete suggestions for a partial query.

```
GET https://amp-api-edge.music.apple.com/v1/catalog/{storefront}/search/suggestions
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `term` | string | yes | Partial search query |
| `kinds` | string | no | `terms,topResults` |
| `types` | string | no | Comma-separated resource types |
| `l` | string | no | Locale |
| `platform` | string | no | `web` |

---

## 3. List Library Playlists

List all playlists in the user's library.

```
GET https://amp-api.music.apple.com/v1/me/library/playlist-folders/p.playlistsroot/children
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `format[resources]` | string | no | `map` |
| `extend` | string | no | `hasCollaboration` |
| `extend[library-playlists]` | string | no | `tags` |
| `l` | string | no | Locale |
| `platform` | string | no | `web` |
| `offset` | integer | no | Pagination offset |

### Example Request

```
GET /v1/me/library/playlist-folders/p.playlistsroot/children?format[resources]=map&platform=web&l=en-US
```

### Example Response

```json
{
  "data": [
    {"id": "p.V7VYJJMcvl92Y", "type": "library-playlists", "href": "/v1/me/library/playlists/p.V7VYJJMcvl92Y"}
  ],
  "next": "/v1/me/library/playlist-folders/p.playlistsroot/children?offset=100",
  "resources": {
    "library-playlists": {
      "p.V7VYJJMcvl92Y": {
        "id": "p.V7VYJJMcvl92Y",
        "type": "library-playlists",
        "attributes": {
          "name": "About that Girl",
          "artwork": {"url": "https://..."},
          "canDelete": true,
          "canEdit": true,
          "dateAdded": "2024-09-24T10:30:00Z",
          "hasCatalog": false,
          "hasCollaboration": false,
          "isPublic": false,
          "lastModifiedDate": "2024-09-24T10:30:00Z",
          "description": {"standard": "A playlist about that girl"}
        }
      }
    }
  }
}
```

Pagination: follow the `next` field. Default page size is ~100.

---

## 4. Get Playlist Details

```
GET https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `format[resources]` | string | no | `map` |
| `l` | string | no | Locale |
| `platform` | string | no | `web` |

Returns the full playlist object with metadata.

---

## 5. Get Playlist Tracks

```
GET https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}/tracks
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `format[resources]` | string | no | `map` |
| `l` | string | no | Locale |
| `platform` | string | no | `web` |

### Example Response

```json
{
  "data": [
    {"id": "i.zpZxmA9tDARo7", "type": "library-songs", "href": "/v1/me/library/songs/i.zpZxmA9tDARo7"}
  ],
  "resources": {
    "library-songs": {
      "i.zpZxmA9tDARo7": {
        "id": "i.zpZxmA9tDARo7",
        "type": "library-songs",
        "attributes": {
          "name": "What Is Love (7\" Mix)",
          "artistName": "Haddaway",
          "albumName": "The Album",
          "artwork": {"url": "https://..."},
          "durationInMillis": 270373,
          "genreNames": ["Pop"],
          "playParams": {
            "catalogId": "1731434189",
            "id": "i.zpZxmA9tDARo7",
            "isLibrary": true
          },
          "releaseDate": "1993-06-07",
          "trackNumber": 2,
          "discNumber": 1
        }
      }
    }
  }
}
```

---

## 6. Create Playlist

```
POST https://amp-api.music.apple.com/v1/me/library/playlists
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `art[url]` | string | no | `f` |
| `l` | string | no | Locale |

### Request Body

```json
{
  "attributes": {
    "name": "Test Playlist",
    "description": "Optional description",
    "isPublic": false
  },
  "relationships": {
    "tracks": {
      "data": [
        {"id": "1731434189", "type": "songs"}
      ]
    }
  }
}
```

- `relationships.tracks` is optional — omit to create an empty playlist
- Track IDs must be **catalog song IDs** (numeric)

### Response

Returns `201 Created` with the created playlist data.

---

## 7. Update Playlist

```
PATCH https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `art[url]` | string | no | `f` |
| `format[resources]` | string | no | `map` |
| `l` | string | no | Locale |
| `platform` | string | no | `web` |

### Request Body

```json
{
  "attributes": {
    "name": "New Name",
    "description": "New description",
    "isPublic": false
  }
}
```

### Response

Returns `204 No Content`.

---

## 8. Delete Playlist

```
DELETE https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `art[url]` | string | no | `f` |

### Response

Returns `204 No Content`.

---

## 9. Add Tracks to Playlist

```
POST https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}/tracks
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `art[url]` | string | no | `f` |
| `l` | string | no | Locale |
| `representation` | string | no | `resources` |

### Request Body

```json
{
  "data": [
    {"id": "1731434189", "type": "songs"},
    {"id": "120152901", "type": "songs"}
  ]
}
```

- Track IDs must be **catalog song IDs** (numeric)

### Response

Returns `200 OK` with the added library-song data.

---

## 10. Reorder/Replace Tracks

Replaces the entire track list with the given order.

```
PUT https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}/tracks
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `art[url]` | string | no | `f` |
| `format[resources]` | string | no | `map` |
| `l` | string | no | Locale |
| `platform` | string | no | `web` |

### Request Body

```json
{
  "data": [
    {"id": "i.zpZxmA9tDARo7", "type": "library-songs"},
    {"id": "i.2P0DBqOf5lzv1", "type": "library-songs"}
  ]
}
```

- Uses **library song IDs** (`i.xxx` format)
- The array order defines the new track order
- This is a full replacement — include ALL tracks you want to keep

### Response

Returns `204 No Content`.

---

## 11. Remove Track from Playlist

```
DELETE https://amp-api.music.apple.com/v1/me/library/playlists/{playlistId}/tracks
```

### Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ids[library-songs]` | string | yes | Library song ID (e.g., `i.zpZxmA9tDARo7`) |
| `mode` | string | no | `all` |
| `art[url]` | string | no | `f` |

### Response

Returns `204 No Content`.

---

## Notes

### Resource Map Format

When `format[resources]=map` is used, related resources are returned in a `resources` object keyed by type and then by ID, rather than as nested arrays. This makes lookup by ID much simpler:

```json
{
  "resources": {
    "songs": {
      "1731434189": { "id": "1731434189", "attributes": { ... } }
    }
  }
}
```

### Artwork URLs

Artwork URLs contain `{w}`, `{h}`, and `{f}` placeholders. Replace them to get a sized image:
```
https://.../{w}x{h}bb.{f}  →  https://.../300x300bb.jpg
```

### Pagination

List endpoints return a `next` field with the relative URL for the next page. Follow it until `next` is absent or empty.
