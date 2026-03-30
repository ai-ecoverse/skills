# Last.fm API Reference

Base URL: `https://ws.audioscrobbler.com/2.0/`

All endpoints require `api_key` parameter. Add `format=json` for JSON responses.

## User Listening Data

### user.getTopArtists

Get most-listened artists for a user.

```
GET /?method=user.getTopArtists&user={USERNAME}&api_key={KEY}&format=json
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| user | Yes | Last.fm username |
| period | No | `overall`, `7day`, `1month`, `3month`, `6month`, `12month` |
| limit | No | Results per page (default 50) |
| page | No | Page number |

### user.getTopTracks

Get most-listened tracks for a user.

```
GET /?method=user.getTopTracks&user={USERNAME}&api_key={KEY}&format=json
```

Same parameters as getTopArtists.

### user.getRecentTracks

Get recently scrobbled tracks (includes "now playing").

```
GET /?method=user.getRecentTracks&user={USERNAME}&api_key={KEY}&format=json
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| user | Yes | Last.fm username |
| limit | No | Results per page (default 50, max 1000) |
| from | No | UNIX timestamp - start of range |
| to | No | UNIX timestamp - end of range |
| extended | No | `1` to include artist info and loved status |

## Artist Data

### artist.getTopTracks

Get an artist's most popular tracks.

```
GET /?method=artist.getTopTracks&artist={ARTIST}&api_key={KEY}&format=json
```

### artist.getSimilar

Get similar artists.

```
GET /?method=artist.getSimilar&artist={ARTIST}&api_key={KEY}&format=json
```

## Track Data

### track.getSimilar

Get similar tracks.

```
GET /?method=track.getSimilar&artist={ARTIST}&track={TRACK}&api_key={KEY}&format=json
```

### track.getInfo

Get track metadata including play counts.

```
GET /?method=track.getInfo&artist={ARTIST}&track={TRACK}&api_key={KEY}&format=json
```

## Browsing Without API Key

Public user profiles are viewable at:
- Profile: `https://www.last.fm/user/{USERNAME}`
- Library: `https://www.last.fm/user/{USERNAME}/library`
- Top artists: `https://www.last.fm/user/{USERNAME}/library/artists`
- Top tracks: `https://www.last.fm/user/{USERNAME}/library/tracks`

These pages can be fetched and parsed when no API key is available.

## Error Codes

| Code | Meaning |
|------|---------|
| 6 | Invalid parameters |
| 10 | Invalid API key |
| 17 | User not found |
| 29 | Rate limit exceeded |

## Mixtape Usage

1. Ask the user for their Last.fm username (or check memory for a previously stored one)
2. Fetch `user.getTopArtists` with `period=overall` to understand taste profile
3. Fetch `user.getTopTracks` to find specific beloved songs
4. Use `artist.getSimilar` to expand beyond obvious choices
5. Cross-reference with theme to find relevant tracks from user's history

