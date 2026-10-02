# linkedin command reference

All commands are `linkedin <command> ...` (the skill's `scripts/linkedin.jsh`).
Output is JSON on stdout unless noted.

## Setup and auth

- `setup <companyId> [--name="<Page name>"]` — store the page to manage
  (company URN, id and name) in the skill's `.config`.
- `auth status` — `{ mode, oauth }`; `mode` is `session` (Voyager, the default) or `oauth`.
- `auth setup --client-id=<id> --client-secret=<secret>` and `auth login` —
  configure and run the official OAuth flow. Posting as an organization needs the
  `w_organization_social` scope on an approved developer app.

## Posting

### post \<text\> [--image=\<path\> [--alt="..."] | --video=\<path\>]

Publishes as the company page with visibility "Anyone". Hashtags and links go
inline in the text; LinkedIn shortens every URL it finds.

- `--image=<path>`: jpg, jpeg, png, gif or webp. `--alt` sets the alt text.
- `--video=<path>`: mp4 (H.264).
- Media flow: register the upload (`IMAGE_SHARING` or `VIDEO_SHARING`), PUT the
  bytes from the page context, then create the share with the asset URN. Only
  SINGLE-part uploads are supported; when LinkedIn answers with a MULTIPART plan
  (very large videos) the command stops with an error.
- `--image` and `--video` cannot be combined. One media item per post.
- Prints `{ success, shareUrn, url, activityUrn, activityId }`. For video, the
  activity URL can return "post not found" for about 30 seconds while LinkedIn
  processes the upload.

`image <path> "<text>" [--alt="..."]` and `video <path> "<text>"` are the same
operations with the media path first.

### list [--limit N]

Recent page posts, newest first, each with `activityUrn`, `text`, `likes`,
`comments`, `reposts`, `impressions`, `clicks`, `clickThroughRate`,
`engagementRate`, `publishedAt`, `publishedAtIso` and `url`.

Every post carries `isRepost`. For a reshare it is `true`, `repostHeader` holds the
attribution (for example "AI Ecoverse reposted this"), `originalAuthor` the original
author, and `text` is the ORIGINAL author's words. Filter out `isRepost: true`
when auditing what the page itself wrote (content log, cadence, voice analysis).

## Engagement

- `comments <activityId>` — comments on a post.
- `comment <activityId> <text>` — a new top-level comment on the post, as the page.
  It does not reply inside a specific comment's thread.
- `reactions <activityId>` — who reacted, and how.
- `profile <vanityName|memberUrn>` — name, headline, location, summary and current
  positions. A vanity-name lookup navigates the tab and is slower.

## Messaging

- `inbox [--unread] [--limit N]` — recent conversations.
- `messages <conversationUrn> [--limit N]` — messages in one conversation.
- `send <conversationUrn> <text>` — send into an existing conversation.
- `search-contacts <query>` — find messaging recipients.
- `dm <profileUrn> <text>` — message a person, finding or creating the conversation.

## Monitoring

- `watch --scoop=<name> [--interval="<cron>"]` — poll for new comments (every 5
  minutes by default) and send each one to the scoop as a `linkedin-comment`
  webhook (payload in SKILL.md).
- `unwatch` — stop polling. `watches` — show the watch configuration and last check.
- `monday [--limit N] [--date Nd|Nw|Nh]` — JSON inbox items for the monday
  dispatcher: posts with new engagement and comments that need a response.

## Examples

```bash
linkedin setup 122314561 --name="AI Ecoverse"
linkedin post "$(cat /shared/drafts/post.md)"
linkedin post "Demo of the new speck skill" --video=/shared/clips/speck-demo.mp4
linkedin image /shared/media/hero.jpg "Meet gh-reaper" --alt="gh-reaper hero banner"
linkedin list --limit 5
linkedin comments 7463311119181312000
linkedin comment 7463311119181312000 "Thanks for the feedback!"
linkedin inbox --unread
linkedin dm "urn:li:fsd_profile:ACoAA..." "Hey, quick question..."
linkedin monday --limit 20 --date 3d
```
