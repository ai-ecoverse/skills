---
name: linkedin
description: Manage a LinkedIn company page — publish posts with consistent brand
  voice, grow engagement, respond to comments, analyze performance, preview profiles,
  and aggregate engagement for the monday dispatcher. Maintains a knowledge base of
  content ideas, audience insights, and brand guidelines. Use when the user wants to
  publish a LinkedIn post, draft LinkedIn content, check LinkedIn comments, respond
  to engagement, plan content strategy, review brand voice, view a LinkedIn profile,
  or manage a company page. Activate on mentions of LinkedIn, LinkedIn post, company
  page, social media, content calendar, engagement, brand voice, or audience growth.
allowed-tools: bash
---

# LinkedIn Company Page Management

Complete LinkedIn presence management for any company page.
Combines API automation with content strategy, brand voice, and engagement growth.

Configure your page with `linkedin setup <companyId> --name="Your Company"`.

## Quick start

```bash
# Post a text update
linkedin post "Excited to announce our latest open source contribution! #AIEcoverse"

# List recent posts with engagement stats
linkedin list --limit 5

# View and respond to comments
linkedin comments 7463311119181312000
linkedin comment 7463311119181312000 "Thanks for the feedback!"

# Profile lookup (before responding to someone)
linkedin profile klimetschek

# Watch for new comments (delegates to a scoop)
linkedin watch --scoop=linkedin-responder

# Monday aggregation
linkedin monday --limit 20 --date 3d
```

## Brand Voice & Content Strategy

The skill maintains a brand knowledge base at `/workspace/skills/linkedin/brand/`:

### Brand Voice (`brand/voice.md`)

Defines how your company speaks on LinkedIn. Updated by the user or inferred from
successful posts. The voice guide covers:
- Tone and register (technical but approachable)
- Vocabulary preferences and avoidances
- Formatting conventions (emoji usage, hashtag strategy, line breaks)
- Content pillars (what we talk about and why)

When drafting posts, **always read `brand/voice.md` first** and conform to it.

### Content Pillars (`brand/pillars.md`)

The recurring themes that define your LinkedIn presence:
- What topics we cover
- What angle we take on each
- What we never post about
- How we differentiate from generic AI hype

### Audience Insights (`brand/audience.md`)

Who follows and engages with your page:
- Demographics and roles observed from commenters/reactors
- What content gets the most engagement
- Which profiles are VIPs (frequent engagers, industry voices)
- Engagement patterns by time/day

### Content Log (`brand/content-log.md`)

Append-only record of every post published through the skill:
- Date, post text, engagement metrics (updated periodically)
- What worked, what didn't
- Ideas for future posts

### Posting Cadence (`brand/cadence.md`)

Defines the rhythm:
- Target posting frequency (e.g., 3x/week)
- Best times to post (learned from engagement data)
- Content mix ratio (e.g., 40% technical, 30% community, 20% announcements, 10% culture)
- Scheduled drafts queue

## Knowledge Base Operations

### Building the brand KB

When the user first sets up the LinkedIn skill or asks to establish brand voice:

1. **Analyze existing posts** — `linkedin list --limit 50` to understand current voice
2. **Create `brand/voice.md`** — synthesize the voice from existing content + user input
3. **Create `brand/pillars.md`** — define content themes
4. **Create `brand/audience.md`** — initialize from current followers/engagers
5. **Create `brand/cadence.md`** — set posting rhythm
6. **Create `brand/content-log.md`** — start tracking

### Maintaining the KB

After every post:
- Append to `brand/content-log.md` with date and text
- After 48h, update with engagement metrics

Periodically (weekly or on request):
- Analyze what's working → update `brand/audience.md`
- Refine voice if the user gives feedback → update `brand/voice.md`
- Rotate content pillars if needed → update `brand/pillars.md`

### Using the KB when drafting

When asked to draft or post:
1. Read `brand/voice.md` for tone
2. Read `brand/pillars.md` for topic alignment
3. Read `brand/cadence.md` to check if it's the right time
4. Read recent entries in `brand/content-log.md` to avoid repetition
5. Draft in the established voice
6. Present for approval before posting

## Authentication

### Current: Session-based (Voyager API)

Uses the active LinkedIn browser session (cookie + CSRF token). The LinkedIn tab
must be open. Works immediately, no setup required.

### Future: OAuth (Official API)

For headless operation (no browser tab needed), register a LinkedIn Developer App
and request the Community Management API product. Then:

```bash
linkedin auth setup --client-id=<ID> --client-secret=<SECRET>
```

This enables:
- Posting without a LinkedIn tab open
- Stable, versioned API endpoints
- Proper rate limits and error handling
- Image/video upload support
- Scheduled posts via cron without browser dependency

## Available commands

### linkedin post \<text\> [--video=\<path\> | --image=\<path\> [--alt="..."]]

Publish a post to the configured company page.
- Posts as the company page (not personal profile)
- Visibility: Anyone (public)
- Include #hashtags and https://links inline
- With `--video=<path>`, attaches a video (mp4, H.264). Equivalent to
  `linkedin video <path> "<text>"`. Uses the Voyager media-upload pipeline
  (register → PUT bytes → createShare with media). SINGLE-part uploads only
  for now; LinkedIn switches to MULTIPART for very large videos (not yet
  supported — the helper raises a clear error in that case).
- With `--image=<path>`, attaches an image (jpg/jpeg/png/gif/webp). Equivalent
  to `linkedin image <path> "<text>"`. Uses the same Voyager pipeline as video
  with `mediaUploadType: IMAGE_SHARING`. Add `--alt="<altText>"` to set the
  image's accessibility alt text. Cannot be combined with `--video`.

### linkedin video \<path\> "\<text\>"

Alt form of `linkedin post --video=`. Posts a video update with the given
caption.

### linkedin image \<path\> "\<text\>" [--alt="..."]

Alt form of `linkedin post --image=`. Posts an image update with the given
caption and optional alt text.

### linkedin list [--limit N]

List recent posts with engagement statistics (comments, likes, reposts).

### linkedin comments \<activityId\>

View comments on a specific post.

### linkedin comment \<activityId\> \<text\>

Add a top-level comment on a post as the company page. (Does not reply to
a specific comment — it posts a new comment on the activity thread.)

### linkedin reactions \<activityId\>

View who reacted to a post.

### linkedin profile \<vanityName|memberUrn\>

Quick preview of a LinkedIn profile. Returns name, headline, location, summary,
and current positions. Use before responding to commenters to understand context.

### linkedin watch --scoop=\<name\> [--interval="cron"]

Start watching for new comments. Polls every 5 minutes (configurable), fires a
webhook to the specified scoop when new comments arrive.

### linkedin unwatch

Stop the comment watcher.

### linkedin watches

Show current watch configuration and last-check status.

### linkedin monday [--limit N] [--date Nd]

Monday protocol aggregation. Produces JSON array of:
- Posts with new engagement
- Individual new comments needing response

## Watching for new comments

```bash
linkedin watch --scoop=linkedin-responder
```

Webhook payload on new comment:
```json
{
  "type": "linkedin-comment",
  "event": "new-comment",
  "data": {
    "activityUrn": "urn:li:activity:...",
    "postText": "Original post (truncated)...",
    "postUrl": "https://www.linkedin.com/feed/update/...",
    "commentText": "The comment text",
    "commenter": "Commenter Name",
    "commentUrn": "urn:li:fsd_comment:..."
  }
}
```

The receiving scoop should:
1. `linkedin profile <commenter>` — understand who's commenting
2. Read `brand/voice.md` — respond in brand voice
3. `linkedin comment <activityId> <text>` — reply

## Engagement Growth Playbook

Built into the brand KB, but the key principles:

1. **Respond to every comment within 4 hours** — signals the algorithm to boost
2. **Ask questions in posts** — drives comment engagement
3. **Tag relevant people sparingly** — only when genuinely relevant
4. **Cross-reference with real conversations** — share insights from actual work
5. **Consistent cadence > viral attempts** — steady posting beats sporadic bursts
6. **Engage on others' posts** — builds reciprocal relationships
7. **Use the hook-body-CTA pattern** — first line hooks, body delivers, end asks

## How it works

The script:
1. Finds an open LinkedIn tab (or opens one)
2. Extracts the CSRF token from the JSESSIONID cookie
3. Makes API calls via `playwright-cli eval` from the page context
4. Requests carry cookies and correct Origin automatically

## Endpoints reference

See `references/endpoints.md` for the full API documentation.

## Limitations

- Both image and video posts work via the session-based Voyager pipeline
  (`linkedin post --image=...` / `--video=...`); OAuth is not required
- Large media files that LinkedIn marks as MULTIPART chunked uploads are not
  yet supported (SINGLE-part only — covers everything ~3-5 MB and short clips)
- Multi-image carousel posts (up to 20 images) are not yet supported — only
  one media item per post
- Click-to-tag-people on images (`tapTargets`) is not yet supported
- The Voyager API is undocumented and may change; queryIds are version-pinned
- Rate limits are unknown; use reasonable intervals for polling
- Profile lookup by vanity name requires page navigation (slower than URN lookup)
- Real-time notifications require polling (LinkedIn has no push for company pages)
