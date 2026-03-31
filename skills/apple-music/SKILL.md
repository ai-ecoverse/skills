---
name: apple-music
description: >
  Interact with Apple Music — search the Apple Music catalog, manage Apple Music playlists,
  add and remove tracks from Apple Music playlists, and browse Apple Music library content.
  Use this skill whenever the user asks about Apple Music, wants to search for songs on
  Apple Music, manage their Apple Music playlists, or automate any Apple Music workflow.
  Activate for requests involving music search, playlist creation, playlist editing,
  track management, or any Apple Music library operations.
allowed-tools: bash
---

# Apple Music Skill

Automate Apple Music library and catalog operations via the `apple-music` shell command.

## Prerequisites

The user must have Apple Music open in a browser tab and be signed in. The skill uses page-context fetch via `playwright-cli eval` to make authenticated API calls from within the Apple Music tab, ensuring correct origin, cookies, and tokens.

If no Apple Music tab is open, the script will open one automatically and prompt the user to sign in if needed.

## Commands

```bash
# Search the Apple Music catalog
apple-music search "what is love"
apple-music search "haddaway" --type artists
apple-music search "the album" --type albums
apple-music search "workout" --type playlists
apple-music search "90s dance" --limit 10

# List all library playlists
apple-music playlists

# Get playlist details and tracks
apple-music playlist p.V7VYJJMcvl92Y

# Create a new playlist (empty or with initial tracks)
apple-music create-playlist "My Playlist"
apple-music create-playlist "Road Trip" --description "Songs for driving"

# Edit playlist metadata
apple-music edit-playlist p.V7VYJJMcvl92Y --name "New Name"
apple-music edit-playlist p.V7VYJJMcvl92Y --description "Updated description"

# Delete a playlist
apple-music delete-playlist p.V7VYJJMcvl92Y

# Add tracks to a playlist (use catalog song IDs from search results)
apple-music add-tracks p.V7VYJJMcvl92Y 1731434189 120152901

# Remove a track from a playlist (use library song ID from playlist tracks)
apple-music remove-track p.V7VYJJMcvl92Y i.zpZxmA9tDARo7

# Reorder tracks in a playlist (list all library song IDs in desired order)
apple-music reorder p.V7VYJJMcvl92Y i.zpZxmA9tDARo7 i.2P0DBqOf5lzv1
```

## ID Conventions

There are two kinds of song IDs:
- **Catalog song IDs** — numeric (e.g., `1731434189`). Used when adding tracks to playlists and returned by `search`.
- **Library song IDs** — prefixed with `i.` (e.g., `i.zpZxmA9tDARo7`). Used when removing or reordering tracks, returned by `playlist`.

Playlist IDs are prefixed with `p.` (e.g., `p.V7VYJJMcvl92Y`).

## Workflow Examples

**Find a song and add it to a playlist:**
```bash
apple-music search "what is love haddaway"
# Note the catalog song ID from results, e.g. 1731434189
apple-music add-tracks p.V7VYJJMcvl92Y 1731434189
```

**Create a playlist with songs:**
```bash
apple-music create-playlist "90s Hits" --description "Best of the 90s"
# Note the playlist ID from output, e.g. p.ABC123
apple-music search "what is love"
apple-music add-tracks p.ABC123 1731434189
```

**Remove a specific track:**
```bash
apple-music playlist p.V7VYJJMcvl92Y
# Note the library song ID, e.g. i.zpZxmA9tDARo7
apple-music remove-track p.V7VYJJMcvl92Y i.zpZxmA9tDARo7
```

## Reference

See `references/endpoints.md` for full API endpoint documentation with request/response examples.
