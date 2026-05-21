---
name: linkedin
description: Post to and manage the AI Ecoverse LinkedIn company page — publish posts,
  view and reply to comments, see reactions and reposts, preview profiles, and aggregate
  engagement for the monday dispatcher. Use when the user wants to publish a LinkedIn
  post, check LinkedIn comments, respond to LinkedIn engagement, view a LinkedIn
  profile, automate LinkedIn posting, schedule LinkedIn content, or manage the
  ai-ecoverse company page. Activate on mentions of LinkedIn, LinkedIn post, company
  page, social media update, post to LinkedIn, LinkedIn comments, LinkedIn reactions,
  LinkedIn engagement, or LinkedIn profile.
allowed-tools: bash
---

# LinkedIn (AI Ecoverse Company Page)

Direct API access to LinkedIn's internal Voyager API for managing the AI Ecoverse company page (`urn:li:fsd_company:122314561`).

## Quick start

```bash
# Post a text update
linkedin post "Excited to announce our latest open source contribution! #AIEcoverse"

# List recent posts with engagement stats
linkedin list --limit 5

# View comments on a post
linkedin comments 7463311119181312000

# Reply to a comment as the company page
linkedin comment 7463311119181312000 "Thanks for the feedback!"

# Check reactions on a post
linkedin reactions 7463311119181312000

# Quick profile preview (useful before responding to someone)
linkedin profile klimetschek

# Monday aggregation (engagement needing attention)
linkedin monday --limit 20 --date 3d
```

## Authentication

Uses LinkedIn's internal Voyager API via page-context fetch. Auth is automatic via the user's active LinkedIn session cookies (`li_at` + `JSESSIONID` as CSRF token).

**Requirements:**
- The user must be logged into LinkedIn in the browser
- The user must have admin access to the AI Ecoverse company page

## Available commands

### linkedin post \<text\>

Publish a text post to the AI Ecoverse company page.

- Posts as the company page (not as the personal profile)
- Visibility: Anyone (public)
- Comments: open to all
- Include #hashtags and https://links inline in the text

### linkedin list [--limit N]

List recent posts with engagement statistics (comments, likes, reposts).
Default limit: 10.

### linkedin comments \<activityId\>

View comments on a specific post. The activityId is the numeric part from the post URN
(e.g., `7463311119181312000`).

### linkedin comment \<activityId\> \<text\>

Reply to a post as the AI Ecoverse company page.

### linkedin reactions \<activityId\>

View who reacted to a post and their reaction types.

### linkedin profile \<vanityName|memberUrn\>

Quick preview of a LinkedIn profile. Accepts either a vanity URL name (e.g., `klimetschek`)
or a member URN. Returns name, headline, location, summary, and current positions.

Useful for understanding who is commenting on or reacting to your posts before
crafting a response.

### linkedin monday [--limit N] [--date Nd]

Monday protocol aggregation. Produces a JSON array of actionable items:
- Posts with new engagement (comments, likes, reposts)
- Individual new comments that may need a response

Each item includes `source: "linkedin"`, `type` (engagement/comment), `id`, `title`,
`body`, `url`, `from`, and `date`.

## Webhook support for new comments

To get notified when new comments arrive, set up a cron-based polling watcher:

```bash
# Create a cron task that checks for new comments every 5 minutes
crontask create --name linkedin-comments --scoop linkedin-watcher \
  --cron "*/5 * * * *"
```

The `linkedin-watcher` scoop should:
1. Run `linkedin list --limit 5` to get recent posts
2. Run `linkedin comments <activityId>` for posts with new comment counts
3. Compare with previous state (stored in `/shared/.linkedin-comment-state.json`)
4. If new comments found, take action (notify, delegate to a response scoop, etc.)

## How it works

The script:
1. Finds an open LinkedIn tab (or opens one)
2. Extracts the CSRF token from the `JSESSIONID` cookie
3. Makes API calls via `playwright-cli eval` from the page context
4. Requests carry cookies and correct Origin automatically

## Endpoints reference

See `references/endpoints.md` for the full API documentation.

## Limitations

- Image/video posts require a separate upload flow (not yet supported)
- The Voyager API is undocumented and may change; queryIds are version-pinned
- Rate limits are unknown; use reasonable intervals for polling
- Profile lookup by vanity name requires a page navigation (slower than URN lookup)
