# TikTok Studio web upload + publish — observed API flow

Discovery date: 2026-09-04. Account: a private test account (`uid` redacted), region DE,
store_region DE, account private. Browser: Chrome 152 on macOS driven over CDP.
Method: real uploads through https://www.tiktok.com/tiktokstudio/upload with a
fetch+XMLHttpRequest wrapper injected into the page MAIN world (HAR recording was started but
`/recordings/` is not visible from this scoop's VFS, so all wire data below comes from the
injected wrapper, which persisted each entry into `localStorage` so it survived page
navigations). Raw captures were kept in a scratch dir only (not durable, not published).

**Everything marked MEASURED was seen on the wire or proven by experiment. Anything marked
FROM BUNDLE was read out of TikTok's own minified JS. Anything marked GAP was not observed.**

---

## 0. Executive summary

There are four logical stages. Only stages 1 and 4 need the browser.

| # | Stage | Endpoint | Signed? | Can run outside browser? |
|---|-------|----------|---------|--------------------------|
| 1 | Get STS upload credentials | `GET www.tiktok.com/api/v1/video/upload/auth/?aid=1988` | YES (msToken/X-Bogus path list) | No — main world |
| 2 | Reserve a vid + storage URI | `GET www.tiktok.com/top/v1?Action=ApplyUploadInner…` | No — AWS4-HMAC-SHA256 with the STS creds | **YES (proven)** |
| 3 | Upload bytes (+ implicit commit) | `POST https://<UploadHost>/upload/v1/<StoreUri>` | No — `Authorization: SpaceKey/…` token from step 2 | **YES (proven)** |
| 4 | Publish | `POST www.tiktok.com/tiktok/web/project/post/v1/?…` | YES | No — main world |

MEASURED end-to-end proof: a 24,349,008-byte 1080x1920 h264 test video was uploaded
**from plain node in the sandbox** (steps 2+3), and published with a hand-built body issued from
the page main world (step 4). Server-side probe of the uploaded object returned
`Height 1920, Width 1080, Duration 29.93066, Bitrate 6508111, Codec h264, Size 24349008` — i.e.
the original bytes arrived intact (the echoed CRC-32 matched too). The resulting post (ids
redacted) had visibility "Only me".

The Studio UI additionally does client-side cover-frame extraction, cover upload, transcode
polling and draft autosave. None of that is required to publish (proven: the direct publish
carried no `cover_info` and succeeded).

---

## 1. Stage 1 — `GET /api/v1/video/upload/auth/?aid=1988`  (MEASURED)

* Host `www.tiktok.com`. Only query param observed: `aid=1988`.
* Headers: just `accept: application/json, text/plain, */*`. Cookies required (session).
* **Signature-required.** FROM BUNDLE (`chunks/495.*.js`), the app initialises
  `byted_acrawler` with `intercept:true, enablePathList:[…]` containing exactly:
  `/api/v1/web/project/post`, `/api/v1/item/create/bulk/`, `/api/v1/item/create/`,
  `/api/upload/search/user/`, `/api/upload/challenge/sug/`, `/api/post/item_list/`,
  `/api/v1/user/profile/upload/`, `/api/v1/video/upload/auth/`,
  `/api/v1/draft/create_update/`, `/tiktok/web/project/post/v1/`,
  `/tiktok/web/project/cancel/v1/`, `/tiktok/post/edit/v1/`, `/api/user/list/`.
  Those are the paths that get msToken / X-Bogus / X-Gnarly injected, so those are the calls
  that must go through the MAIN-world path (the existing `signedRequest()` in
  `scripts/tiktok.jsh`). Everything else in this document is plain.
* Response (long tokens elided):

```json
{ "ak":"<AK, 32 hex>",
  "auth":"HMAC-SHA256:3.0:<redacted>",         // 261 chars, unused by us
  "store_region":"DE",
  "video_token_v5":  { "access_key_id":"<STS_ACCESS_KEY_ID, AKTP-prefixed>",
                       "secret_acess_key":"<STS_SECRET_ACESS_KEY, 44-64 char b64>",
                       "session_token":"STS2<base64 policy blob, ~1256 chars>",
                       "space_name":"tiktok",
                       "current_time":"2026-09-04T12:28:50Z",
                       "expired_time":"2026-10-04T12:28:50Z" },
  "vframe_token_v5": { … "space_name":"tiktok-ai-frame" },
  "audio_token_v5":  { … "space_name":"tt_audio_mode", "expired_time": ~9 days },
  "status_code":0 }
```

* Note the typo in the real field name: **`secret_acess_key`** (one `c`).
* `video_token_v5` is the credential set for video uploads; `vframe_token_v5` is used for the
  AI-frame/cover-candidate space; `audio_token_v5` for audio-only. Validity observed: video and
  vframe tokens ~30 days, audio ~9 days. The Studio re-fetches this endpoint on every entry to
  the upload page and again when the cover editor opens.
* Decoding the `session_token` (base64 after the `STS2` prefix) shows the policy:
  actions `vod:ApplyUpload`, `vod:ApplyUploadInner`, `vod:CommitUpload`,
  `vod:CommitUploadInner`, `vod:GetUploadCandidates`, `ImageX:ApplyImageUpload`,
  `ImageX:CommitImageUpload`, `ImageX:ApplyUploadImageFile`, `ImageX:CommitUploadImageFile`,
  bound to `AppId 1988`, `PSM tiktok.post.api`, `PriorityRegion DE`, `StoreRegion DE`,
  `UserId <UID>`.

## 2. Stage 2 — `GET /top/v1?Action=ApplyUploadInner…`  (MEASURED, and reproduced from node)

Full URL as issued by the page for a video:

```
GET https://www.tiktok.com/top/v1
  ?Action=ApplyUploadInner
  &Version=2020-11-19
  &SpaceName=tiktok               # from upload/auth video_token_v5.space_name
  &FileType=video
  &IsInner=1
  &ClientBestHosts=tos-no1a16-up.tiktokcdn-eu.com,tos-no1a19-up.tiktokcdn-eu.com
  &X-Amz-Expires=604800
  &s=ekrw4intyy7                  # random 11-char nonce, client-generated
  &device_platform=web
  &business_tag=tiktok_video_submission_web
```

Headers (MEASURED):

```
X-Amz-Date: 20260904T123039Z
x-amz-security-token: <video_token_v5.session_token>
Authorization: AWS4-HMAC-SHA256 Credential=<video_token_v5.access_key_id>/20260904/gcp/vod/aws4_request,
               SignedHeaders=x-amz-date;x-amz-security-token, Signature=<hex>
```

* Region `gcp`, service `vod`, signing key = standard SigV4 chain over
  `AWS4 + secret_acess_key`. Only two headers are signed. Payload hash = `SHA256("")`.
* No cookies needed. **PROVEN**: the identical request, signed in the sandbox with node's
  WebCrypto, returned HTTP 200 and a fresh `Vid` + `StoreUri`. Working reference implementation:
  `cmdPost` in `scripts/tiktok.jsh` (SigV4 over WebCrypto, ~40 lines).
* `ClientBestHosts` is optional-looking (the node reproduction omitted it and still got a
  usable `UploadHost`); it comes from a client-side speed test (see §6).
* Response (elided):

```json
{"ResponseMetadata":{"RequestId":"…","Action":"ApplyUploadInner","Version":"2020-11-19",
                     "Service":"vod","Region":"gcp"},
 "Result":{
   "UploadAddress":null,
   "InnerUploadAddress":{
     "UploadNodes":[{
       "Vid":"<VID>",                                 // the video id used when publishing
       "Vids":["<VID>"],
       "StoreInfos":[{
         "StoreUri":"tos-no1a-v-<bucket>-no/<opaque object key>",
         "Auth":"SpaceKey/tiktok/0/:version:v2:<JWT, ~790 chars>",
         "UploadID":"<32 hex, unused by us>",
         "UploadHeader":{"X-Logical-Part-Mode":"logical_part"}}],
       "UploadHost":"tos-no1a19-up.tiktokcdn-eu.com",
       "UploadCluster":"no1a","Type":"IDC","Protocol":"tcp",
       "SessionKey":"<base64 JSON, ~3.2 kB>",
       "NodeConfig":{"UploadMode":""}},
       { …a SECOND node with the same Vid and a different StoreUri/SessionKey (failover)… }],
     "AdvanceOption":{"Parallel":0,"Stream":0,"SliceSize":0,
                      "EncryptionKey":"<opaque>"}},
   "SDKParam":{ "dynamic_slice_web":{"high_slice_size":10485760,
                                     "high_slice_size_500M":20971520,
                                     "normal_slice_size":5242880,
                                     "normal_slice_size_500M":10485760,
                                     "low_slice_size":3145728,
                                     "low_normal_network_threshold":200,
                                     "normal_high_network_threshold":400},
                "enable_omit_initupload_web":1, "enable_merge_request_web":1,
                "pre_connect_count_web":5, "upload_mode":"stream",
                "upload_slice_before_crc32_web":1, "slice_retry_count":10,
                "max_crc_error_count":1, "large_file_threshold":1073741821,
                "speed_test_ttl_seconds":3600, … }}}
```

Values carried forward: `Vid` (→ publish `video_id`), `StoreInfos[0].StoreUri` (→ upload path),
`StoreInfos[0].Auth` (→ `Authorization` on the byte upload), `UploadHost`, `SessionKey`
(→ `post_upload_req.session_key`).

Also seen at page load, bodies NOT captured (GAP): `GET /top/v1?Action=GetUploadCandidates&Version=2020-11-19&SpaceName=tiktok&X-Amz-Expires=604800`.

## 3. Stage 3 — the byte upload

Host: the `UploadHost` from stage 2 (`tos-no1a16-up.tiktokcdn-eu.com` /
`tos-no1a19-up.tiktokcdn-eu.com` for this DE account — an EU TOS ingest edge, not
`www.tiktok.com`). Path: `/upload/v1/<StoreUri>`. Verb: **POST** in every observed variant
(no PUT anywhere). No cookies. Auth = the `SpaceKey/…` JWT from stage 2 in `Authorization`.

Two shapes exist; both were observed.

### 3a. Single-request multipart, upload+commit merged (MEASURED; this is what I recommend)

Used by the app for a small file, and **proven to work from node for the full 24 MB file**:

```
POST https://<UploadHost>/upload/v1/<StoreUri>          (no query string)
Authorization: SpaceKey/tiktok/0/:version:v2:<Auth from ApplyUploadInner>
Content-CRC32: 11a5c831            # lowercase hex CRC-32 (IEEE, poly 0xEDB88320) of the file bytes
X-Storage-U: <UID>                 # numeric user id of the logged-in account
X-Upload-With-PostUpload: 1
content-type: multipart/form-data; boundary=…   (set by FormData)

form field "file"            = the raw bytes (Blob/File, any filename)
form field "post_upload_req" = {"sts2_token":  <video_token_v5.session_token>,
                                "sts2_secret": <video_token_v5.secret_acess_key>,
                                "session_key": <SessionKey from ApplyUploadInner>,
                                "functions":   []}
```

Response:

```json
{"code":2000,"apiversion":"v1","message":"Success",
 "data":{"file_info":{"crc32":"11a5c831"},
         "post_upload_resp":{"request_id":"…",
           "results":[{"vid":"<VID>",
             "video_meta":{"Uri":"<StoreUri>","Height":1920,"Width":1080,
               "OriginHeight":1920,"OriginWidth":1080,"Duration":29.93066,"Bitrate":6508111,
               "Format":"MP4","Size":24349008,"FileType":"video","Codec":"h264"}}],
           "multi_callback_args":[""],"plugin_results":[null]}}}
```

`X-Upload-With-PostUpload: 1` + `post_upload_req` is what makes the ingest edge perform the
`CommitUploadInner` for you (that is the `enable_merge_request_web:1` behaviour). If the server
cannot parse the media it still returns `code 2000` but `video_meta` degrades to
`Height 360, Width 480` with no `Duration` — treat that as a corrupt-upload signal.

`Content-CRC32` is mandatory and validated: the response echoes the crc32 it computed. A
mismatch is what `max_crc_error_count:1` refers to.

### 3b. Chunked "stream" mode (MEASURED for a 45 MB body)

For a body above the slice size (`dynamic_slice_web.high_slice_size` = 10 MiB here) the SDK
slices. Each part is its own POST, all with the same client-generated `uploadid`:

```
POST https://tos-no1a16-up.tiktokcdn-eu.com/upload/v1/<StoreUri>
     ?uploadid=<client-generated UUIDv4>                 # NOT ApplyUploadInner's UploadID
     &device_platform=web
Authorization: SpaceKey/tiktok/0/:version:v2:<Auth>
Content-CRC32: Ignore            # per-part CRC deliberately skipped in stream mode
X-Storage-U: <UID>
X-Part-Number: 1                 # 1-based
X-Part-Offset: 0                 # byte offset of this part (0, 10485760, 20971520, …)
X-Size: 10485760                 # size of THIS part (last part smaller)
X-Offset: 0
X-Phase: transfer
X-Enable-Omit-Init-Upload: 1     # no separate init-upload round trip
X-Enable-Upload-Mode: stream
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="undefined"
body: the raw slice (Blob)

→ {"code":2000,…,"data":{"uploadid":"<same uuid>","part_number":"1","crc32":"6e65bc0b","etag":""}}
```

Then one finish call (note lowercase `post` method as the app issued it; HTTP verbs are
case-insensitive on the wire):

```
POST https://tos-no1a16-up.tiktokcdn-eu.com/upload/v1/<StoreUri>?uploadid=<same>&device_platform=web
Authorization: SpaceKey/…
X-Storage-U: <UID>
X-Enable-Upload-Mode: stream
X-Size: 45152034                 # total bytes
X-Phase: finish
X-Upload-With-PostUpload: 1
Content-Type: application/json
body: {"parts_crc":"1:6e65bc0b,2:feec3800,3:16418d10,4:e5ce1196,5:ebe77a0e",
       "post_upload_param":{"sts2_token":…,"sts2_secret":…,"session_key":…,"functions":[]}}

→ {"code":2000,…,"data":{"file_info":{"hash":"dc072ee8","key":"<StoreUri>"},
                         "post_upload_resp":{…"results":[{"vid":"…","video_meta":{…}}]}}}
```

So the per-part CRC32s the server returned must be echoed back in `parts_crc` as
`"<part>:<crc32>"` comma-joined. No MD5 or SHA anywhere in the video path.

Before any transfer the SDK fires `pre_connect_count_web` (=5) warm-up POSTs to
`/upload/v1/<StoreUri>?uploadid=<uuid>&device_platform=web` with only
`Authorization`, `X-Storage-U`, `X-Phase: pre_connect` and an empty body →
`{"code":2000,…,"message":"Success"}`. These are optional TCP warm-up, not part of the protocol.

## 4. Stage 4 — publish: `POST /tiktok/web/project/post/v1/`  (MEASURED twice)

```
POST https://www.tiktok.com/tiktok/web/project/post/v1/
     ?app_name=tiktok_web&channel=tiktok_web&device_platform=web
     &tz_name=Europe%2FBerlin&aid=1988
content-type: application/json
accept: application/json, text/plain, */*
```

Signature-required (path is in `enablePathList`) → must be issued from the MAIN world.
The UI's own request additionally carried `tt-ticket-guard-public-key`,
`tt-ticket-guard-web-version: 1`, `tt-ticket-guard-version: 2`,
`tt-ticket-guard-iteration-version: 0`, `tt-ticket-guard-client-data: <~424 char b64>`.
**MEASURED: those are NOT required** — a bare `fetch()` from the page without any ticket-guard
header returned 200 and created the post.

Body actually used by the UI (trimmed; the full UI body also embeds a ~4 kB `cover_info.coverProject`
editor document which is not needed):

```json
{"post_common_info":{"creation_id":"<random client-generated id>","enter_post_page_from":8,"post_type":3},
 "feature_common_info_list":[
   {"geofencing_regions":[],"playlist_name":"","playlist_id":"",
    "tcm_params":"{\"commerce_toggle_info\":{}}","sound_exemption":0,"anchors":[],
    "vedit_common_info":{"draft":"","video_id":"<VID>"},
    "privacy_setting_info":{"visibility_type":1,"allow_duet":null,"allow_stitch":null,
                            "allow_comment":1,"allow_content_reuse":1,"allow_ai_remix":2}}],
 "single_post_req_list":[
   {"batch_index":0,"video_id":"<VID>","is_long_video":0,
    "single_post_feature_info":{
      "text":"slicc api mechanism test - private",
      "text_extra":[],
      "markup_text":"slicc api mechanism test - private",
      "music_info":{"origin_volume":"100"},
      "cover_info":{ …editor project…, "cover_uri":"<image StoreUri>",
                     "cover_width":486,"cover_height":648,"cover_type":1,"crop_type":2,
                     "frame_duration":0,"isAutoCropFirstFrame":true},
      "poster_delay":0,
      "cloud_edit_video_height":960,"cloud_edit_video_width":540,
      "cloud_edit_is_use_video_canvas":false,
      "has_original_audio":1,"is_upload_audio_track":false,
      "video_track_time_range_list":[{"start_time_in_ms":0,"end_time_in_ms":3000}],
      "mature_theme_type":0}}]}
```

Response:

```json
{"project_id":"<PROJECT_ID>","project_status":1,
 "single_post_resp_list":[{"batch_index":0,"item_id":"<ITEM_ID>","status_code":0,"status_msg":""}],
 "status_code":0,"status_msg":"","extra":{…},"log_pb":{…}}
```

MEASURED minimal body that worked (no `cover_info`, no draft, no project pre-created —
TikTok generated a cover itself): identical to the above minus `cover_info`, with
`creation_id` a client-generated random string, `text`/`markup_text` the caption,
`cloud_edit_video_{width,height}` = the real video dimensions, and
`video_track_time_range_list` = `[{start_time_in_ms:0,end_time_in_ms:<duration_ms>}]`.
This is what `cmdPost` in `scripts/tiktok.jsh` sends.

Enum values FROM BUNDLE (`chunks/2037.*.js`):

* `post_type`: 0 `WEB_POST_TYPE_OLD_WEB`, 1 `BULK_UPLOAD`, 2 `Y_PROJECT_WITH_CLOUD_EDIT`,
  3 `Y_PROJECT_WITHOUT_CLOUD_EDIT` (what the current UI sends for a plain upload),
  4 `IMAGE_WITHOUT_CLOUD_EDIT`.
* `visibility_type`: **0 = EVERYONE_OR_FOLLOWERS, 1 = ONLY_YOU, 2 = FRIENDS,
  3 = SUBSCRIBER_ONLY, 4 = AVAILABLE_FOR_ADS**. MEASURED: sending `1` produced a post the
  Studio lists as "Only me".
* `enter_post_page_from: 8` = the web upload page (constant in every observed request).
* `allow_comment` / `allow_duet` / `allow_stitch` / `allow_content_reuse` / `allow_ai_remix` are
  numbers; `null` is accepted for duet/stitch (the UI sends `null` when the toggles are hidden,
  which they are for a self-only post). `allow_ai_remix: 2` was the account default.
* A legacy sibling exists FROM BUNDLE: `createPostV2` → `POST /api/v1/web/project/post/`
  with the same body shape. Not exercised. `/tiktok/web/project/post/v1/` is what the shipping
  UI uses.

## 5. Where the per-post options live

* **Caption**: `single_post_req_list[0].single_post_feature_info.text` plus `markup_text`.
  In the UI the caption box is a DraftJS `contenteditable`; when saved as a *draft* the
  `markup_text` is the DraftJS raw JSON (`{"blocks":[…],"entityMap":{}}`), while on *publish* it
  is plain text. `text_extra: []` carries hashtag/mention spans.
* **Privacy**: `feature_common_info_list[0].privacy_setting_info.visibility_type` (see enum).
  UI: "Who can see this post" select; "Only you" is the self-only option. Selecting it hides
  the duet/stitch toggles and disables scheduling ("Private videos can't be scheduled").
* **Comments / duet / stitch / content-reuse / AI-remix**: same `privacy_setting_info` object.
  What the account is *allowed* to set comes from `GET /api/privacy/setting/restriction/v1/?aid=1988`
  (MEASURED, called on entry to the composer).
* **Cover frame**: `single_post_feature_info.cover_info.cover_uri` + `cover_width/height/type`,
  `crop_type`, and `poster_delay` (seconds into the video for an auto poster). Optional.
* **Location**: the composer calls `POST /tiktok/v1/creator/poi/list?aid=1988` for suggestions;
  the chosen POI would ride in the publish body (field not exercised — GAP).
* **Schedule**: FROM BUNDLE there is `/api/v1/post_schedule/ack/` and a `recordSchedulePost`
  mutation; the scheduling body field was not observed (GAP).

## 6. Everything the UI does that you can skip (and the traps)

1. **Page-load pre-warm.** Entering `/tiktokstudio/upload` fires, before any file is chosen:
   `GET /api/v1/video/upload/auth/`, `GET /top/v1?Action=GetUploadCandidates…`, two
   `?speedtest` POSTs to candidate TOS hosts, then `ApplyUploadInner` (no `FileSize`) plus 5
   `X-Phase: pre_connect` POSTs. Consequence for discovery: an injected observer must be in
   place before the app boots or those calls are invisible (they are visible in
   `performance.getEntriesByType('resource')` as URLs without bodies).
2. **Client-side "transcode" + polling.** For files it decides need it, the app remuxes/encodes
   in the browser (WASM at `…/creator_center/static/wasm/a81938ccb7561cdb.module.wasm`,
   Mediabunny/WebCodecs) and then polls
   `POST /api/v1/video/transcode/result/?aid=1988` about once per second with
   `{"scene":0,"video_info":[{"file_key":"file_<ts>_<rand>","video_id":"<vid>","original_width":…,"original_height":…,"original_duration_ms":…}]}`
   until `transcode_result[0].transcode_status != 0`. `scene:1` is the pre-upload probe.
   It also calls `POST /api/v1/video/transcode/enable/?video_id=<vid>&aid=1988` — that one needs
   a CSRF token obtained by a preceding `HEAD /api/v1/video/transcode/enable/` with
   `x-secsdk-csrf-request: 1` / `x-secsdk-csrf-version: 1.2.22`, whose response header supplies
   the `x-secsdk-csrf-token` value echoed on the POST (also `tt-csrf-token`, whose value equals
   the `tt_csrf_token` cookie). **The Post button stays soft-disabled (`aria-disabled=true`,
   opacity .4) while the cover shows "Processing…", i.e. while `transcode_status == 0`.**
   With a valid file that the app decides needs no transcode, there is no polling at all and
   Post is enabled immediately. A direct-API implementation skips this entirely.
3. **Cover pipeline** (MEASURED, optional): the app extracts a frame, then
   `ApplyUploadInner` twice — `SpaceName=tiktok-ai-frame&FileType=image&FileSize=22` (a 22-byte
   AI-frame descriptor, uploaded to `tos-no1a-fevfp-2755-no/…`) and
   `SpaceName=tiktok&FileType=image&FileSize=1022078&Scene=poster&business_tag=tiktok_video_cover_web`
   (the JPEG, uploaded to `tos-no1a-p-0037-no/…`). Image uploads are a single POST with
   `Content-CRC32`, `Content-Type: application/octet-stream`, raw ArrayBuffer body — **no**
   `X-Upload-With-PostUpload`; instead each is committed explicitly with
   `POST /top/v1?Action=CommitUploadInner&Version=2020-11-19&SpaceName=<space>`, AWS4-signed
   (adds `X-Amz-Content-Sha256`), body `{"SessionKey":"<from that apply>"}` →
   `{"Result":{"Results":[{"Uri":"…","UriStatus":2000}]}}`. The image `Uri` becomes `cover_uri`.
4. **Drafts.** "Save draft" = two calls: `POST /tiktok_creator/editor_tool/api/v1/post_draft/save?aid=1988`
   with `{"video_id":"<vid>","draft":"<editor state JSON>"}` → `{"data":{"draft_id":"<editor draft id>"}}`
   (an *editor* draft id), then `POST /api/v1/draft/create_update/?aid=1988` (signature-required)
   with `{"draft":{"web_video_param_list":[{"batch_index":0,"single_post_feature_info":{text,text_extra,markup_text,mature_theme_type}}],
   "basic_info":{"media_draft_info":{"vid","video_file_desc","play_url",…},"creation_id","project_id":"0","enter_post_page_from":8},
   "web_feature_common_info":{…same shape as feature_common_info_list[0]…,"vedit_common_info":{"video_id","vedit_param_id_list":["<editor draft id>"]}}}}`
   → `{"draft":{"draft":{"draft_id":"<draft id>"}}}`. Saving a draft triggers a **full page
   navigation** to `/tiktokstudio/content?tab=draft`, which destroys any in-page observer state
   (persist captures to `localStorage`). Read back with
   `GET /api/v1/draft/detail/?draft_id=<id>&aid=1988`; edit via
   `/tiktokstudio/upload?from=creator_center&draft_id=<id>&open_editor=0`.
   Limits shown in the UI: 30 drafts max, drafts expire after 60 days.
5. **`POST /api/v1/web/project/create/?creation_id=<cid>&type=1&aid=1988`** (MEASURED, when
   re-opening a draft) → `{"project":{"project_id":"<project id>","creationID":…}}`. Not needed
   for a plain publish (the publish response mints its own `project_id`).
6. **Limits / ceilings** (from the UI copy, not tested): max size 30 GB, max duration 60 min,
   recommended `.mp4`, 1080p/1440p/4K, 9:16 or 16:9. `SDKParam.large_file_threshold` is
   1,073,741,821 bytes (~1 GiB) — above that the SDK presumably switches strategy (untested).
   No rate limiting was hit: 3 uploads + 2 publishes + ~700 poll requests in ~40 min, all 200s.
   The soft anti-abuse throttle documented in the existing tiktok skill (200 with empty body)
   did not appear.

## 7. THE trap: getting the bytes into the browser

`playwright-cli upload [ref] <file>` **corrupts binary files.** Its handler
(`packages/webapp/src/shell/supplemental-commands/playwright/handlers/upload.ts`) does
`const content = await fs.readFile(path)` and, when that returns a string, re-encodes it with
`new TextEncoder()`. Every byte ≥ 0x80 becomes `EF BF BD` (U+FFFD). PROVEN byte-for-byte: the
24,349,008-byte test video arrived as 45,152,034 bytes; the 102,780-byte clip arrived as
186,522 bytes and `Buffer.from(orig.toString('utf8'),'utf8')` equals the bytes I downloaded back
from TikTok's storage exactly. Symptoms if you don't notice: TikTok reports the video as
`480x360`, duration 0, `isNeedTranscode:true`, the cover never leaves "Processing…", the Post
button stays disabled forever, and `transcode_status` stays 0 indefinitely (I burned ~25 minutes
on that before diagnosing it).

Also note `upload` needs a *focused* file input or a snapshot ref; TikTok's input is
`display:none`, so `document.querySelector('input[type=file]').style.display='block'` + `.focus()`
is required first.

What works (MEASURED):

* **Best — don't use the browser for bytes at all.** Sign `ApplyUploadInner` and POST the bytes
  from node (§2, §3a). No cookies, no CDP, no size blow-up.
* If you must go through the page: write a JS file whose text is `atob('<base64>')` →
  `Uint8Array` → `new File([...])` → `DataTransfer` → `input.files` and run it with
  `playwright-cli eval-file`. Base64 is ASCII so the text round-trip is lossless. Worked for a
  103 kB file as a 137 kB script; a 24 MB file would be a 32 MB script (untested).
* Media/UI note: the tab must be foregrounded (`playwright-cli tab-select <index>`) for the
  composer to behave, and refs from `snapshot` frequently do not resolve for TikTok's custom
  select/button widgets — I had to click via `mousemove`/`mousedown`/`mouseup` at coordinates
  from `getBoundingClientRect()`, or call `.click()` on the element from `eval`.
* The CDP session for a tab can die (`CDP error: Session with given id not found`) after heavy
  use; a dead session cannot be revived — open a new tab.

## 8. What the discovery run created (ids redacted)

Two posts (both **"Only me"**): one published entirely through the direct API with the
node-side byte upload (the 24,349,008-byte 1080x1920 h264 clip), one published through the
Studio UI (a 3 s 540x960 clip). Two drafts left behind from the corrupted-bytes attempts
(45 MB and 186 kB bodies), plus four orphan `Vid` reservations from page pre-warm and failed
uploads. Concrete `item_id` / `project_id` / `draft_id` / `Vid` values are deliberately not
published here.

Cleanup note: **no delete endpoint was observed** for posts or drafts (GAP), so leftovers have
to be removed by hand in TikTok Studio → Content. A fresh post sits in "Content under review"
for a while after publishing; that is normal.

## 9. Gaps — not observed, do not guess

* `GetUploadCandidates` and the `?speedtest` POST request/response bodies (URLs only).
* The exact msToken / X-Bogus / X-Gnarly query parameters actually appended to the signed calls:
  my wrapper sits *outside* webmssdk's hook, so it logged pre-signing URLs. That the four
  signed paths get signed is FROM BUNDLE (`enablePathList`) plus the pre-existing finding in
  `scripts/tiktok.jsh`; I did not run a negative control from an
  isolated world in this job.
* Whether `ApplyUploadInner`/`CommitUploadInner`/the TOS byte upload would *also* work with a
  server-side (non-browser) `upload/auth` — no, stage 1 needs the signed browser path; that is
  the only browser dependency on the upload side.
* Scheduled posting, POI/location, playlist, branded-content and AIGC-label fields in the
  publish body.
* Behaviour above ~1 GiB (`large_file_threshold`), and any real rate limit.
* Photo (carousel) posting — the `Photos` tab and `WEB_POST_TYPE_IMAGE_WITHOUT_CLOUD_EDIT`
  path were not touched.
