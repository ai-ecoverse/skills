# Suno API Endpoints Reference

Base URL: `https://studio-api-prod.suno.com`

Auth: Bearer JWT obtained via `window.Clerk.session.getToken()` in a suno.com browser tab. Tokens expire ~1 hour. The header `Authorization: Bearer <JWT>` is required on all requests.

## Authentication

Suno uses Clerk for auth. The JWT is not stored in localStorage or cookies — it must be obtained by calling `window.Clerk.session.getToken()` from the page context of any suno.com tab.

```bash
playwright-cli eval --tab=<SUNO_TAB_ID> "(async()=>{return await window.Clerk.session.getToken();})()"
```

The JWT contains claims:
- `suno.com/claims/user_id` — Suno user UUID
- `https://suno.ai/claims/clerk_id` — Clerk user ID
- `suno.com/claims/email` — user email
- `exp` — expiration timestamp (~1hr from issue)

## Error Format

Suno uses Pydantic on the backend. Validation errors look like:
```json
{
  "detail": [
    {"loc": ["body", "ModelName", "field_name"], "msg": "...", "type": "value_error"}
  ]
}
```

The middle element in `loc` (e.g., `ModelName`) is the Pydantic model class name, NOT a JSON nesting level. The actual request body uses flat top-level keys.

---

## Song Generation

### POST /api/generate/v2-web/

Generate songs. This is the primary endpoint used by the web UI. `/api/generate/v2/` also works.

**Custom Mode** (user-provided lyrics + style):
```json
{
  "prompt": "[Verse 1]\nLyrics here...\n\n[Chorus]\nMore lyrics...",
  "tags": "indie rock, jangly guitars, male vocals",
  "negative_tags": "no autotune, no trap",
  "title": "My Song Title",
  "mv": "chirp-fenix",
  "make_instrumental": false,
  "generation_type": "TEXT",
  "metadata": {
    "create_mode": "CUSTOM"
  }
}
```

**Simple Mode** (AI writes lyrics from a description):
```json
{
  "gpt_description_prompt": "an upbeat indie rock song about a sunny day at the beach",
  "mv": "chirp-fenix",
  "prompt": "",
  "make_instrumental": false,
  "generation_type": "TEXT",
  "metadata": {
    "create_mode": "SIMPLE",
    "lyrics_model": "default"
  }
}
```

**Response:**
```json
{
  "id": "uuid",
  "clips": [
    {
      "id": "clip-uuid",
      "status": "submitted",
      "title": "...",
      "metadata": { ... }
    }
  ],
  "metadata": { ... }
}
```

Generates 1–2 clips per request. Each costs credits based on model/duration.

**All generate parameters** (most are optional):
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | `""` | Lyrics text (Custom mode) |
| `gpt_description_prompt` | string | `""` | Natural-language description (Simple mode) |
| `tags` | string | `""` | Style/genre tags (Custom mode) |
| `negative_tags` | string | `""` | Styles to avoid |
| `title` | string | `""` | Song title |
| `mv` | string | `"chirp-fenix"` | Model version. `chirp-fenix` = V5.5 |
| `make_instrumental` | bool | `false` | Instrumental only, no vocals |
| `generation_type` | string | `"TEXT"` | Always `"TEXT"` |
| `metadata` | object | `{}` | Contains `create_mode`, `lyrics_model`, etc. |
| `project_id` | string | `null` | Assign to a project |
| `persona_id` | string | `null` | Use a persona voice |
| `continue_clip_id` | string | `null` | Extend from an existing clip |
| `continue_at` | number | `null` | Timestamp to continue from (seconds) |
| `cover_clip_id` | string | `null` | Create a cover of existing clip |
| `artist_clip_id` | string | `null` | Reference clip for artist style |
| `user_uploaded_images_b64` | array | `[]` | Base64 images for cover art |
| `infill_start_s` | number | `null` | Infill start time |
| `infill_end_s` | number | `null` | Infill end time |
| `stem_type_id` | string | `null` | Stem type for generation |
| `override_fields` | object | `null` | Override specific generation params |
| `token` | string | `null` | Internal token (not auth) |
| `task` | string | `null` | Internal task ID |

### POST /api/generate/v2-web/cover/

Create a cover of an existing song.

```json
{
  "cover_clip_id": "original-clip-uuid",
  "tags": "acoustic folk cover",
  "mv": "chirp-fenix",
  ...
}
```

### POST /api/generate/concat/v2/

Extend/continue a song from a specific point.

```json
{
  "clip_id": "clip-uuid-to-extend",
  "is_infill": false,
  "edit_session_id": "optional-session-id"
}
```

### POST /api/generate/remaster/

Remaster an existing clip with improved audio quality.

### POST /api/generate/stems/

Generate separated stems from a clip (up to 12 stems in V5.5).

---

## Lyrics Generation

### POST /api/generate/lyrics-pair

Generate lyrics from a description. Returns a lyrics job ID for polling.

**Request:**
```json
{
  "prompt": "a melancholic ballad about leaving home"
}
```

**Response:**
```json
{
  "id": "lyrics-uuid",
  "status": "running"
}
```

### GET /api/generate/lyrics/{lyrics_id}

Poll for lyrics generation result.

**Response (complete):**
```json
{
  "id": "lyrics-uuid",
  "status": "complete",
  "title": "Generated Title",
  "text": "[Verse 1]\nLyrics here...\n\n[Chorus]\n..."
}
```

### POST /api/generate/lyrics-infill/

Fill in missing sections of existing lyrics.

### POST /api/generate/lyrics-mashup

Create a mashup of lyrics from multiple sources. Returns an ID for polling via `GET /api/generate/lyrics/{mashup_id}`.

---

## Clip Management

### GET /api/clip/{clip_id}

Get a single clip's details.

**Response:**
```json
{
  "id": "clip-uuid",
  "status": "complete",
  "title": "Song Title",
  "audio_url": "https://cdn1.suno.ai/{clip_id}.mp3",
  "image_url": "https://cdn2.suno.ai/image_{clip_id}.jpeg",
  "video_url": "https://cdn1.suno.ai/{clip_id}.mp4",
  "model_name": "chirp-fenix",
  "metadata": {
    "type": "gen",
    "tags": "indie rock...",
    "prompt": "lyrics text...",
    "gpt_description_prompt": "...",
    "duration": 180.5,
    "create_mode": "CUSTOM"
  },
  "is_public": false,
  "is_trashed": false,
  "created_at": "2026-03-31T16:00:00Z",
  "user_id": "user-uuid"
}
```

**Status values:** `submitted` → `queued` → `streaming` → `complete` (or `error`)

### GET /api/feed/?ids={id1},{id2},...

Get multiple clips by ID. Returns an array of clip objects.

### POST /api/feed/v3

Get the user's clip feed (paginated, cursor-based).

**Request:**
```json
{
  "page": 0
}
```

**Response:**
```json
{
  "clips": [ ... ],
  "has_more": true,
  "next_cursor": "cursor-string"
}
```

### POST /api/feed/v3/offset

Get feed offset/position info.

**Response:**
```json
{
  "offset": 0,
  "clip_id": "clip-uuid"
}
```

### POST /api/gen/trash

Move clips to trash or restore them.

**Request:**
```json
{
  "trash": true,
  "clip_ids": ["clip-uuid-1", "clip-uuid-2"]
}
```

**Response:**
```json
{
  "ids": ["clip-uuid-1", "clip-uuid-2"],
  "is_trashed": true
}
```

### POST /api/gen/{gen_id}/set_visibility/

Set a clip's public/private visibility.

**Request:**
```json
{
  "is_public": true,
  "submit_to_contest": false
}
```

### POST /api/gen/{gen_id}/set_metadata/

Update clip metadata (title, lyrics, caption, images).

**Request:**
```json
{
  "title": "New Title",
  "lyrics": "Updated lyrics...",
  "caption": "Description text",
  "caption_mentions": [],
  "image_url": null,
  "remove_image_cover": false,
  "remove_video_cover": false,
  "is_audio_upload_tos_accepted": false,
  "video_cover_upload_id": null
}
```

### POST /api/gen/{gen_id}/set_configurations/

Update clip configurations in metadata.

**Request:**
```json
{
  "configurations": { ... }
}
```

### POST /api/gen/{gen_id}/update_reaction_type/

Like/unlike a clip.

**Request:**
```json
{
  "reaction": "LIKE",
  "recommendation_metadata": {
    "context_type": "...",
    "recommendation_item_id": "...",
    "heuristic": "..."
  }
}
```

Set `reaction` to `null` to unlike.

### POST /api/clips/{clip_id}/toggle_remixes/

Enable/disable remixes for a clip.

**Request:**
```json
{
  "can_remix": true
}
```

### POST /api/clips/{clip_id}/toggle_show_remixes

Show/hide remixes for a clip.

**Request:**
```json
{
  "show_remix": true
}
```

---

## User & Account

### GET /api/user/me

Get current user profile.

### GET /api/billing/info/

Get billing/subscription info including credits.

**Response (key fields):**
```json
{
  "plan": {
    "id": "premier_year_v2",
    "subscription_type": "premier"
  },
  "total_credits_left": 9462,
  "monthly_limit": 10000,
  "monthly_usage": 538,
  "period_start": "2026-03-16T...",
  "period_end": "2026-04-16T..."
}
```

### POST /api/user/update_user_config/

Update user configuration flags.

**Request:**
```json
{
  "shown_creation_tour": true
}
```

### PATCH /api/profiles/v2/{handle}

Update user profile (display name, bio, links).

---

## Search

### POST /api/search/

Search for songs, playlists, personas, and users.

**Request:**
```json
{
  "search_queries": [
    {
      "term": "search text",
      "search_type": "public_song"
    }
  ]
}
```

**Search type enum:**
| Type | Description |
|------|-------------|
| `public_song` | Search public songs |
| `similar_song` | Find similar songs |
| `library_song` | Search user's library |
| `library_playlist` | Search user's playlists |
| `library_persona` | Search user's personas |
| `public_persona` | Search public personas |
| `tag_song` | Search by tag |
| `genre_preview_song` | Genre preview songs |
| `playlist` | Search playlists |
| `following_clip_feed` | Following feed |
| `user` | Search users |
| `hybrid_search` | Combined search |
| `ensemble_similar` | Ensemble similarity |

---

## Lyrics & Tags Helpers

### POST /api/tags/recommend

Get tag recommendations based on input tags.

**Request:**
```json
{
  "tags": ["rock", "indie"]
}
```

### GET /api/generate/get_recommend_styles

Get recommended style suggestions.

### GET /api/prompts/suggestions

Get prompt suggestions for the generate page.

---

## Projects

### GET /api/project/me

Get user's projects list.

### POST /api/project/

Create a new project.

### POST /api/project/{project_id}/add_clips

Add clips to a project.

### POST /api/project/{project_id}/remove_clips

Remove clips from a project.

---

## Playlists

### GET /api/playlist/me

Get user's playlists.

### POST /api/playlist/create

Create a new playlist.

### POST /api/playlist/{playlist_id}/add_clips

Add clips to a playlist.

### POST /api/playlist/{playlist_id}/remove_clips

Remove clips from a playlist.

---

## Personas

### GET /api/persona/me

Get user's personas.

### POST /api/persona/create

Create a new persona.

### GET /api/custom-model/pending/

Get pending custom model training jobs.

---

## Personalization

### GET /api/personalization/memory

Get the user's personalization/preference memory.

### GET /api/personalization/settings

Get personalization settings.

---

## Social

### GET /api/share/stats

Get sharing statistics.

### GET /api/challenge/progress

Get current challenge progress.

---

## CDN URLs

Audio, images, and video are served from Suno's CDN:

| Content | URL Pattern |
|---------|-------------|
| Audio (MP3) | `https://cdn1.suno.ai/{clip_id}.mp3` |
| Image (JPEG) | `https://cdn2.suno.ai/image_{clip_id}.jpeg` |
| Video (MP4) | `https://cdn1.suno.ai/{clip_id}.mp4` |

---

## Model Versions

| Constant | Model ID | Version |
|----------|----------|---------|
| Current default | `chirp-fenix` | V5.5 |
| Web UI flag | `v5-5-web-ui` | V5.5 (FENIX_WEB_UI) |

---

## Rate Limits & Credits

- Credits are consumed per generation (amount varies by model and duration)
- Monthly credit allocation depends on plan tier
- Check remaining credits via `GET /api/billing/info/`
- No explicit rate limit headers observed, but excessive requests may be throttled
