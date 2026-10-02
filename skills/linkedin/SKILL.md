---
name: linkedin
description: Manage a LinkedIn company page from a logged-in LinkedIn tab — publish text, image and video posts as the page, list posts with engagement stats, read and answer comments, look up commenter profiles, read and send LinkedIn messages, watch for new comments, and aggregate engagement for the monday dispatcher. Keeps a brand knowledge base (voice, pillars, audience, cadence, content log) for drafting posts in the page's voice. Use when the user wants to publish or draft a LinkedIn post, share an update on the company page, check LinkedIn comments or reactions, reply to a commenter, see how recent LinkedIn posts performed, review the page's brand voice, plan the LinkedIn posting cadence, or read and send LinkedIn DMs. Activate on mentions of LinkedIn, LinkedIn post, LinkedIn company page, LinkedIn comments, LinkedIn followers or engagement, LinkedIn inbox or DMs, or the page's brand voice.
allowed-tools: bash
---

# LinkedIn company page

The `linkedin` command is `scripts/linkedin.jsh` in this skill. Installing the
skill registers it as the bare command `linkedin`; without registration, run it
as `jsh <skill-dir>/scripts/linkedin.jsh <command> ...`. It talks to LinkedIn's
internal Voyager API from inside a logged-in LinkedIn tab, so it needs no API key.

Prerequisites: a LinkedIn tab signed in as an admin of the page, and a one-time
`linkedin setup <companyId> --name="<Page name>"`. Check with `linkedin auth status`
and `linkedin list --limit 1`.

## Quick start

```bash
linkedin list --limit 5                                   # recent posts + engagement
linkedin post "$(cat /shared/drafts/post.md)"             # text post
linkedin post "$(cat post.md)" --image=/shared/chart.png --alt="Chart of ..."
linkedin comments 7463311119181312000                     # comments on a post
linkedin comment 7463311119181312000 "Thanks, good point."
linkedin profile klimetschek                              # who is commenting
```

## Publishing a post

Publishing is public and immediate, so every post goes through these steps:

1. Read `brand/voice.md`, `brand/pillars.md` and `brand/cadence.md`, and the last
   entries of `brand/content-log.md` so the post does not repeat a recent one.
2. Draft into a file. Keep LinkedIn's rendering in mind:
   - LinkedIn removes backticks, so write code names as plain text or in quotes.
   - Every URL in the text is auto-linked and shortened, including example URLs.
     Put only real, intended links in a post; write placeholders as `<server>`.
3. Run the ai-writing-detector checks on the draft file.
4. **Checkpoint:** show the user the exact text (and image, if any) and wait for
   approval. Never post without it.
5. Check the end of the draft file (`tail -c 80 <file>`) for stray trailing text,
   then post: `linkedin post "$(cat <file>)" [--image=<path> --alt="..."]`.
6. **Verify:** `linkedin list --limit 2` must show the new post with the approved
   text (URLs shortened). If it differs, fix it in the LinkedIn editor.
7. Append the post to `brand/content-log.md`: date, activity URN, URL, full text.

## Brand knowledge base

`brand/` holds the page's editorial memory:

| File | Holds |
|---|---|
| `voice.md` | Tone, vocabulary, formatting and hashtag rules |
| `pillars.md` | Topics the page covers and the ones it avoids |
| `audience.md` | Who engages, and what has worked |
| `cadence.md` | Posting rhythm, times, content mix |
| `content-log.md` | Every published post, with engagement filled in later |

To build it for a new page: run `linkedin list --limit 50`, draft `voice.md` and
`pillars.md` from those posts plus the user's input, and **show both drafts to the
user for confirmation before saving them**. Then create `audience.md`,
`cadence.md` and an empty `content-log.md`. About 48 hours after each post, add
its engagement from `linkedin list` to the content log, and update `voice.md`
whenever the user corrects a draft.

## Commands

| Command | Does |
|---|---|
| `post <text> [--image=<path> [--alt=...] \| --video=<path>]` | Publish as the page (public) |
| `image <path> <text>` / `video <path> <text>` | Same as `post --image` / `post --video` |
| `list [--limit N]` | Recent posts with likes, comments, reposts, impressions, clicks |
| `comments <activityId>` / `reactions <activityId>` | Comments or reactions on a post |
| `comment <activityId> <text>` | New top-level comment on a post, as the page |
| `profile <vanityName\|urn>` | Name, headline and positions of a member |
| `inbox`, `messages`, `send`, `search-contacts`, `dm` | LinkedIn messaging (add `--json`, last, to the reads) |
| `watch --scoop=<name>`, `unwatch`, `watches` | Poll for new comments, deliver to a scoop |
| `monday [--limit N] [--date 3d]` | New comments and engagement as monday inbox items |
| `setup`, `auth setup`, `auth login`, `auth status` | Page and auth configuration |

Arguments, output fields (such as the `isRepost` flag in `list`) and examples for
each command are in `references/commands.md`. The underlying API calls are in
`references/endpoints.md`.

## Answering comments

`linkedin watch --scoop=linkedin-responder` polls every 5 minutes and sends the
scoop a webhook for each new comment:

```json
{ "type": "linkedin-comment", "event": "new-comment",
  "data": { "activityUrn": "urn:li:activity:...", "postText": "...", "postUrl": "https://www.linkedin.com/feed/update/...",
            "commentText": "...", "commenter": "Commenter Name", "commentUrn": "urn:li:fsd_comment:..." } }
```

The receiving scoop runs `linkedin profile <commenter>`, reads `brand/voice.md`,
drafts a reply, and posts it with `linkedin comment <activityId> <text>` once the
reply is approved.

## How it works

1. Finds an open LinkedIn tab, or opens the page's admin view.
2. Reads the CSRF token from the tab's `JSESSIONID` cookie.
3. Sends every API call from the page itself through the `sliccy:browser`
   bridge, so LinkedIn sees its own origin and session cookies.
4. Media posts register an upload, PUT the file's bytes from the page, then create
   the share with the uploaded asset.

## Limitations

- One image or one video per post. Carousels, image people-tags and very large
  videos that LinkedIn uploads in parts (MULTIPART) are not supported.
- The Voyager API is undocumented and its query IDs are pinned in the script;
  if LinkedIn changes them, commands fail until the IDs are updated.
- Rate limits are unknown, so keep polling intervals at minutes, not seconds.
- `profile <vanityName>` navigates the tab, which is slower than a URN lookup.
- Headless posting through LinkedIn's official API (`auth setup` / `auth login`)
  needs an approved developer app with organization posting rights; without it,
  the session mode above is the working path.
