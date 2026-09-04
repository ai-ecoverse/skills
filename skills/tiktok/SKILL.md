---
name: tiktok
description: Interact with TikTok via its web API and messages page — upload and
  publish videos (private by default), search TikTok
  (videos, users, mixed feed), read video stats (plays, likes, comments, shares,
  saves), list a creator's videos, read comments, check notifications and the
  activity feed, read/send direct messages, and see a video (extract auto-caption
  transcripts + filmstrip contact sheets so an agent can see/hear what a TikTok
  is about without a human). Use when the user wants to automate TikTok, look up
  a TikTok video's stats or view count, search TikTok, check TikTok notifications
  or DMs, read or send a TikTok message, pull a TikTok transcript/captions,
  generate a filmstrip of frames, "watch" a TikTok, or pull TikTok data without
  clicking through www.tiktok.com. Also use when the user wants to post, upload
  or publish a video to TikTok, post a TikTok privately/self-only, or set a
  TikTok caption, privacy, comment/duet/stitch settings on a new post. Activate on mentions of "TikTok", "TikTok
  stats", "TikTok video", "TikTok search", "TikTok notifications", "TikTok
  messages", "TikTok DM", "views/likes on a TikTok", "TikTok post", "post to TikTok", "upload a video to TikTok",
  "publish a TikTok", "TikTok transcript",
  "TikTok captions", "TikTok filmstrip", "watch this TikTok", or related TikTok
  workflows.
allowed-tools: bash
---

# TikTok

Drive TikTok from the command line via its own web API. Covers search, video
stats, comments, a creator's videos, notifications/activity, and direct messages.

## Prerequisite

The user must be **logged into www.tiktok.com in the browser**. Every command
talks to TikTok through that open, authenticated tab. If no TikTok tab is open,
open one first:

```bash
playwright-cli open https://www.tiktok.com
```

Then confirm the session:

```bash
tiktok whoami
```

## Why it works this way (important)

TikTok protects its own `/api/*` JSON endpoints with anti-bot request signatures
(`X-Bogus` / `X-Gnarly` / `X-Dynosaur` / `msToken`). Those are injected
**automatically** by TikTok's own `webmssdk` bundle, which hooks `window.fetch`
**in the page's main world**. So the skill issues each API call *from inside the
logged-in tab's main world* (via `playwright-cli eval-file`) — the interceptor
then signs the request for us.

- A plain Node `fetch()` is rejected (unsigned, wrong origin, no cookies).
- `browser.evalAsync` runs in an *isolated* world where the `fetch` hook is
  absent, so signature-required endpoints (e.g. a creator's video list) fail
  with `status_code 10201` / HTTP 400. This skill deliberately uses
  `eval-file` (main world) for all API calls.
- The web API id is always `aid=1988`. Do **not** read `appId` from the page's
  app-context: some pages (e.g. `/messages`) report `appId=1233`, which fails
  signing.

Direct messages are delivered over an encrypted "Frontier" WebSocket, not REST,
so DM listing / reading / sending go through the rendered messages page DOM.

See `references/endpoints.md` for the discovered endpoints and `references/notes.md`
for the full set of gotchas.

## Commands

```
tiktok whoami                                    # logged-in account
tiktok search <query> [--type=general|video|user] [--count=N] [--cursor=N]
tiktok video <videoId>                           # full stats: plays/likes/comments/shares/saves
tiktok comments <videoId> [--count=N] [--cursor=N]
tiktok user-videos <secUid> [--count=N] [--cursor=N]  # alias: posted

# Upload + publish a video (private by default)
tiktok post <file> [--caption="..."] [--privacy=self|friends|public]
                   [--no-comment] [--no-duet] [--no-stitch] [--json]

# Profile tabs (secUid optional — defaults to your own logged-in account)
tiktok posted    [<secUid>] [--count=N] [--cursor=N]  # posted videos
tiktok reposts   [<secUid>] [--count=N] [--cursor=N]  # reposted videos
tiktok liked     [<secUid>] [--count=N] [--cursor=N]  # liked videos (usually self-only)
tiktok favorites [<secUid>] [--count=N] [--cursor=N]  # favorited/bookmarked videos (self-only)
tiktok notice-count                              # unread counts by group
tiktok notifications [--group=N] [--count=N] [--mark-read] [--cursor=<max_time>]
tiktok conversations                             # list DM conversations (alias: messages)
tiktok read-messages "<name>"                    # read latest messages in a conversation
tiktok send-message "<name>" "<text>"            # send a DM

# Creator analytics (TikTok Studio)
tiktok studio analytics [--range=7d|28d|60d|365d]  # views/likes/comments/shares/followers
tiktok studio user                                 # Studio creator profile info

# Aggregation
tiktok monday [--limit=N] [--date=Nd]            # unified inbox JSON (notifications + unread DMs)

# See a video (transcript + filmstrip — for agents)
tiktok transcript <videoId|url> [--lang=eng-US] [--out=path] [--json] [--raw]
tiktok filmstrip  <videoId|url> [--frames=8] [--width=160] [--out=path] [--seek-wait=700] [--json]
tiktok see        <videoId|url> [--frames=8] [--width=160] [--lang=eng-US] [--dir=path] [--seek-wait=700] [--json]


# Escape hatch — call ANY TikTok endpoint (like `gh api`)
tiktok api <path> [--method=GET] [--query k=v ...] [--data '<json>'] [--bare] [--raw] [--include]
```

### The `api` escape hatch

`tiktok api` is the general-purpose door: it runs any TikTok endpoint through the
logged-in, **signed** page context (the same core all other commands use). By
default it prepends the standard web params (`aid=1988`, `device_id`, `region`,
`odinId`, …) and pretty-prints the JSON response.

```bash
# Common params auto-added; just supply the endpoint-specific ones:
tiktok api /api/item/detail/ --query itemId=7210798564014837035
tiktok api /api/comment/list/ -q aweme_id=7210798564014837035 -q count=5

# --bare = send exactly the params you give (no common params)
tiktok api /tiktok/v1/analytics/insights/ --bare \
  --query 'type_requests=[{"insight_type":121,"data_date_range":1}]' \
  --query time_offset=7200

# POST with a JSON body; --raw prints the raw text; --include prints the status
tiktok api /some/endpoint/ --method POST --data '{"foo":"bar"}' --include
```

Flags: `--method/-X`, repeatable `--query/-q k=v`, `--data/-d <json>`,
`--bare` (skip common params), `--raw` (don't pretty-print), `--include/-i`
(print `HTTP <status>` to stderr). Exits non-zero on HTTP ≥ 400 or a non-zero
`status_code`.

### `monday` (aggregator protocol)

Outputs a JSON array of unified inbox items (`{source, type, id, title, body,
url, from, date, unread}`) merging the TikTok activity feed and unread DM
conversations — the same shape as the `slack`/`outlook`/`github` `monday`
commands, for a cross-tool dispatcher.

### Examples

```bash
# View stats for a video (id is the number in tiktok.com/@user/video/<id>)
tiktok video 7210798564014837035

# Search — general (mixed), video-only, or user-only
tiktok search "golden retriever" --count=10
tiktok search cats --type=user
tiktok search cats --type=video --count=20

# A creator's videos: first get their secUid via a user search
tiktok search mrbeast --type=user      # copy the secUid
tiktok user-videos MS4wLjABAAAA... --count=15

# The four profile tabs. Omit the secUid to use your own account
# (Liked / Favorites are typically only visible on your own profile):
tiktok posted
tiktok reposts
tiktok liked
tiktok favorites --count=20
tiktok liked MS4wLjABAAAA... --count=10   # someone else's liked tab (if public)

# Notifications / activity feed
tiktok notice-count
tiktok notifications --count=20            # group 500 = all activity
tiktok notifications --group=3 --count=20  # comments only
tiktok notifications --mark-read           # mark them read

# Creator analytics (needs a creator account)
tiktok studio analytics                    # last 7 days by default
tiktok studio analytics --range=28d
tiktok studio user

# Aggregated inbox (JSON) and raw API
tiktok monday --limit=20 --date=7d
tiktok api /api/user/detail/ --query uniqueId=mrbeast

# Direct messages
tiktok conversations
tiktok read-messages "Olanski"
tiktok send-message "Olanski" "thanks for the video!"
```


## Posting a video (`tiktok post`)

Uploads a local video file and publishes it. **Private by default.**

```bash
# Self-only ("Only me") — the default. Nothing is ever published publicly by accident.
tiktok post /path/to/clip.mp4 --caption="my caption"

# Explicit visibility
tiktok post clip.mp4 --privacy=friends
tiktok post clip.mp4 --privacy=public          # the ONLY way to go public
tiktok post clip.mp4 --no-comment --no-duet --no-stitch --json
```

| flag | default | meaning |
|------|---------|---------|
| `--caption` | empty | post text (`text` + `markup_text`; hashtag/mention spans are not parsed) |
| `--privacy` | **`self`** | `self` → `visibility_type 1` ("Only me"), `friends` → `2`, `public` → `0` |
| `--no-comment` | comments allowed | `allow_comment: 0` |
| `--no-duet` | see note | `allow_duet: 0` |
| `--no-stitch` | see note | `allow_stitch: 0` |
| `--json` | off | machine-readable result (`item_id`, `project_id`, `url`, `video_id`, dimensions, crc32) |

On success it prints the `item_id`, the `project_id` and the canonical URL
(`https://www.tiktok.com/@<you>/video/<item_id>`). A fresh post shows as
"Content under review" in Studio for a while — that is normal.

### Safety

`--privacy` defaults to `self` on purpose: an agent that mis-parses an
instruction must not be able to publish to a public audience. Going public
requires typing `--privacy=public`.

### How it works (4 stages, see `references/upload-flow.md`)

1. `GET /api/v1/video/upload/auth/?aid=1988` → STS2 credentials
   (`video_token_v5`; note TikTok's own typo `secret_acess_key`).
   Signature-required → issued from the **main world** via `signedRequest()`.
2. `GET /top/v1?Action=ApplyUploadInner…`, signed AWS4-HMAC-SHA256
   (region `gcp`, service `vod`, `SignedHeaders=x-amz-date;x-amz-security-token`)
   → `Vid`, `StoreUri`, `Auth`, `UploadHost`, `SessionKey`. Plain HTTP from node.
3. `POST https://<UploadHost>/upload/v1/<StoreUri>` — one multipart POST
   (`file` + `post_upload_req`) with `Authorization: SpaceKey/…`, `Content-CRC32`,
   `X-Storage-U: <uid>`, `X-Upload-With-PostUpload: 1`. The header makes the
   ingest edge commit the upload for you, and the response carries the server's
   own probe of the media (`video_meta`). Plain HTTP from node; a single POST
   handles at least 24 MB.
4. `POST /tiktok/web/project/post/v1/?…&aid=1988` with `post_common_info` /
   `feature_common_info_list` / `single_post_req_list` → `item_id`.
   Signature-required → main world.

No cover is uploaded (TikTok generates one), no draft is created, and the
client-side transcode/polling the Studio UI does is skipped entirely.

### ⚠️ Never route the bytes through the browser

`playwright-cli upload` **corrupts binary files**: it reads the VFS file as text
and re-encodes it with `TextEncoder`, so every byte ≥ 0x80 becomes `EF BF BD`.
Measured: a 24,349,008-byte mp4 arrived as 45,152,034 bytes, and TikTok turned it
into a 480x360 clip whose transcode never finished (cover stuck on
"Processing…", Post button permanently disabled). `tiktok post` therefore reads
the file with `fs.readFileBinary()` and POSTs it from node — stages 2 and 3 need
no cookies, so the browser is not involved in the byte path at all. Do not
"simplify" this by driving the upload page.

As a second guard, `post` compares the server's `video_meta` (`Width`, `Height`,
`Duration`, `Size`) against a local `ffprobe` of the source and against the exact
byte length, and **aborts before publishing** on any mismatch (a degraded
`480x360` with no `Duration` is the signature of mangled bytes). It also checks
that the CRC-32 the edge computed equals the one it sent.

### Limits and gaps

- Cover frame, location/POI, playlist, scheduling, branded content and AIGC
  labels are not implemented (their publish-body fields were never observed —
  see `references/upload-flow.md` §9). `post` sends no `cover_info`.
- `allow_duet` / `allow_stitch` default to `null` for a self-only post (what the
  UI sends when the toggles are hidden) and `1` otherwise. `1` = allow is
  MEASURED; `0` = disallow is INFERRED from the field being numeric — not
  exercised on the wire.
- `is_long_video` is always sent as `0` (the observed value for a 30 s clip);
  behaviour for >60 min videos and files above ~1 GiB is untested.
- Photo/carousel posts are not supported.
- Drafts cannot be deleted through this skill — no delete endpoint was observed.
  Use TikTok Studio → Content → Drafts in the browser.

## Seeing a video (transcript + filmstrip)

The combo command is `tiktok see` — **not** `watch`. In SLICC, `watch` means a
long-lived webhook/lick monitor (`gh pr watch`, `slack watch`). This is a one-shot
content capture.

An agent can't literally play a TikTok. `see` / `transcript` / `filmstrip`
give it the next-best thing: the auto-caption track (what was said / narrated)
plus a contact sheet of frames (what it looked like).

```bash
# One-shot: open the video, dump captions + filmstrip into a dir
tiktok see 7667617105923083542 --json
tiktok see 'https://www.tiktok.com/@uci_cycling/video/7667617105923083542' --frames=12

# Just the timed transcript (WebVTT → plain text)
tiktok transcript 7667617105923083542
tiktok transcript 7667617105923083542 --json            # {cues:[{start,end,text},...]}
tiktok transcript 7667617105923083542 --raw             # original WebVTT
tiktok transcript 7667617105923083542 --out=/tmp/t.txt

# Just a filmstrip JPEG of N frames across the duration
tiktok filmstrip 7667617105923083542 --frames=8 --out=/tmp/strip.jpg
tiktok filmstrip 7667617105923083542 --frames=12 --width=200 --json
```

### How it works

- **Transcript** reads `video.subtitleInfos` / `claInfo.captionInfos` from the
  item (via `/api/item/detail/` or the open video page's rehydration data),
  then downloads the WebVTT from the CDN **inside the logged-in tab** so cookies
  and referer are correct. Not every video has captions — exit code 2 means none.
  Caption URLs are short-lived, so a tab that has been open a while yields URLs
  the CDN rejects; the skill reloads the page once and retries with fresh URLs.
- **Filmstrip** navigates to the video page, finds the `<video>` element, seeks
  to N evenly-spaced timestamps, and `canvas.drawImage`s each frame into a
  horizontal JPEG contact sheet with timestamps. Seeks are synchronous
  (`video.currentTime = t` + shell sleep) — top-level `await` on `seeked`
  hangs on TikTok tabs, so don't "improve" it that way.
### Exit codes

`transcript` and `see` distinguish "this video has no captions" from "something
broke", so an agent can tell an expected gap from a fault:

| code | meaning |
|------|---------|
| `0` | every requested artefact was produced |
| `2` | the video genuinely ships no captions. For `see` the filmstrip may still have succeeded — check `filmstrip` in the summary |
| `1` | an operation failed: captions existed but the WebVTT download failed, the filmstrip could not be captured, or a usage error |

`see`'s `summary.json` also carries `transcriptErrorKind`: `none` (no captions
on the item), `fetch` (download failed), or `error`. Branch on that rather than
matching the English in `transcriptError`.

- **see** does both, writes `captions.vtt`, `transcript.txt`,
  `filmstrip.jpg`, and `summary.json` under `--dir` (default
  `/workspace/skills/tiktok/.tmp/see-<id>/`), and with `--json` prints one
  agent-friendly payload including full `cues`.

### Flags

| flag | commands | default | notes |
|------|----------|---------|-------|
| `--lang` | transcript, see | eng-US preference | substring match on language code |
| `--out` | transcript, filmstrip | stdout / `.tmp/filmstrip-<id>.jpg` | path; `transcript` infers format from extension (`.vtt`/`.json`/`.txt`) |
| `--dir` | see | `.tmp/see-<id>/` | output directory |
| `--frames` / `--n` | filmstrip, see | 8 | 1–24 |
| `--width` / `--w` | filmstrip, see | 160 | thumb width px (64–480) |
| `--seek-wait` | filmstrip, see | 700 | ms to wait after each seek for the frame to decode |
| `--json` | all three | off | machine-readable |
| `--raw` | transcript | off | original WebVTT on stdout |

## Notes for the assistant

- **`post` never sends bytes through the browser.** `playwright-cli upload`
  UTF-8-mangles binary files (24,349,008 B mp4 → 45,152,034 B, resulting in a
  480x360 video that never transcodes). The byte upload is a plain node POST to
  the TOS ingest host; only the two signature-required calls use the tab.
- **`post` is private by default** (`--privacy=self`, `visibility_type 1`). Only
  pass `--privacy=public` when the user explicitly asked for a public post.
- **Pagination:** most list commands print a `cursor` / `max_time`; pass it back
  via `--cursor` to page further.
- **secUid vs uniqueId:** `user-videos` needs a `secUid` (a long `MS4wLjAB...`
  string), not an `@handle`. Get it from `tiktok search <name> --type=user`.
- **Throttling:** firing many API calls in a few seconds makes TikTok return an
  empty `200` (soft anti-abuse block). The skill retries once after 3s; if it
  still fails, wait ~30s or reload the tab. Space out bulk calls.
- **Messages are DOM-based.** `send-message` works best with the TikTok tab in
  the foreground (it issues real keyboard events). Reading only captures what's
  currently rendered (roughly the last ~40 bubbles).
- Do not read `appId` from the page — the web API id is hard-coded to `1988`.
- **Frame capture needs a VISIBLE tab.** A backgrounded tab never decodes video:
  the `<video>` element exists but reports `readyState 0` and `duration NaN`
  indefinitely. `filmstrip`/`see` therefore bring the TikTok tab to the front
  before probing the player, which **switches the user's active tab**. The probe
  then polls for up to ~10s while the player initialises.
- **Filmstrip seeks must be sync.** `video.currentTime = t` + shell sleep +
  canvas capture. Top-level `await` on the `seeked` event hangs on TikTok
  tabs; `eval-file` of an async canvas export can return `{}`. Don't "fix".
- **A dead CDP session cannot be reloaded away.** If a TikTok tab is closed or
  its target recycled, every `eval-file` fails with `-32001` ("Session with
  given id not found"). The skill now recovers automatically: it opens a fresh
  tab, adopts the new target id, and retries once. If you hit it manually, open
  a **new** tab — reloading the old one keeps the same dead target. Use
  `playwright-cli tab-list` to see live tabs.
- **Not every video has captions.** `transcript`/`see` exit 2 when
  `subtitleInfos`/`captionInfos` are empty. Sports/music/text-on-screen
  clips often still have ASR commentary captions; pure-music clips often don't.
- `see`/`filmstrip` need a real navigable video page (they call
  `playwright-cli goto`). Prefer passing a full `@user/video/<id>` URL when
  you have one so the first navigation hits.

