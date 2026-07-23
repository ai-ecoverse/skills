# TikTok web API endpoints

All are GET requests to `https://www.tiktok.com/<path>` issued from inside the
logged-in tab's **main world** (so `webmssdk` signs them). Every request carries
a large set of "common" params; the skill builds these live from the page's
app-context (`__UNIVERSAL_DATA_FOR_REHYDRATION__` →
`__DEFAULT_SCOPE__['webapp.app-context']`) plus `navigator`/`screen`. The web app
id is hard-coded to `aid=1988` (never read `appId` from the page).

## Common params (built automatically)

`aid=1988`, `app_name=tiktok_web`, `app_language`, `channel=tiktok_web`,
`device_platform=web_pc`, `region`, `priority_region`, `os`, `cookie_enabled`,
`screen_width`, `screen_height`, `browser_language`, `browser_platform`,
`browser_name=Mozilla`, `browser_online`, `device_id` (= app-context `wid`),
`odinId` (= logged-in user uid), `user_is_login`, `webcast_language`, `tz_name`,
`from_page`.

Signatures appended by `webmssdk` (do NOT set these yourself): `msToken`,
`X-Bogus`, `X-Gnarly`, `X-Dynosaur`, `verifyFp`.

## Search

| Path | Extra params | Response |
|------|--------------|----------|
| `/api/search/general/full/` | `keyword`, `count`, `cursor`, `offset`, `web_search_code` | `data[]` — mixed: each row has `.item` (a video) or `.user_list[]` |
| `/api/search/item/full/` | `keyword`, `count`, `cursor`, `offset` | `item_list[]` (videos) |
| `/api/search/user/full/` | `keyword`, `count`, `cursor` | `user_list[]` → each `.user_info` (`unique_id`, `nickname`, `follower_count`, `sec_uid`, `signature`) |
| `/api/search/suggest/guide/` | `keyword`, `search_source` | related-search suggestions |

## Videos & stats

| Path | Extra params | Response |
|------|--------------|----------|
| `/api/item/detail/` | `itemId` | `itemInfo.itemStruct` — full video; stats at `.stats` and `.statsV2` (`playCount`, `diggCount`, `commentCount`, `shareCount`, `collectCount`, `repostCount`) |
| `/api/comment/list/` | `aweme_id`, `count`, `cursor` | `comments[]` (`text`, `digg_count`, `create_time`, `user.unique_id`), `total`, `has_more`, `cursor` |
| `/api/post/item_list/` | `secUid`, `count`, `cursor` | `itemList[]` (videos with `.stats`), `cursor`, `hasMore` — a creator's posts |

Video stats are also embedded in search / post-list items (`.stats` / `.statsV2`),
so you often get counts without a separate `item/detail` call.

## Notifications / activity

| Path | Extra params | Response |
|------|--------------|----------|
| `/api/notice/count/` | — | `notice_count[]` (`{group, count}`) — unread counts per group |
| `/api/notice/multi/` | `group_list` (URL-encoded JSON, see below) | `notice_lists[]` → `[0].notice_list[]`, `[0].has_more` |
| `/api/inbox/notice_list/` | `group_list` | per-group notice list (used by the inbox panel) |

`group_list` is a JSON array, e.g.:

```json
[{"count":20,"is_mark_read":0,"group":500,"max_time":0,"min_time":0}]
```

- `group` `500` = combined "All activity" feed. Other groups from
  `/api/notice/count/`: `2` likes, `3` comments, `6` followers, `12` account
  updates, `20` video updates, `36` shop, etc.
- `is_mark_read: 1` marks the returned notices as read.
- `max_time` = paginate: pass the last notice's `create_time` as the next cursor.
- Notice objects have a `type` (int) — e.g. like/comment/follow/mention/reply —
  plus `has_read`, `create_time`, and a nested payload (`digg`/`comment`/`follow`).

## TikTok Studio (creator analytics)

Same origin (`www.tiktok.com/tiktokstudio/...`), so the same signed page-context
fetch works. Best called from any logged-in `www.tiktok.com` tab.

| Path | Params | Response |
|------|--------|----------|
| `/tiktok/v1/analytics/insights/` | `type_requests` (URL-encoded JSON array of `{insight_type, data_date_range}`), `time_offset` (tz offset secs, e.g. 7200), `is_dark_mode` | one named key per requested insight |
| `/tiktokstudio/api/web/user` | — (no common params needed) | `userId`, `userExtra` (isPrivate/isVerified/profileBio), `userBaseInfo`, `tt-csrf-token` |
| `/tiktok/v1/creator/m10n_center/reward_analytics` | — | monetization/rewards |

### `data_date_range`

`1` = 7 days, `2` = 28 days, `3` = 60 days, `4` = 365 days. The returned metric's
`list.value[]` (or `new_viewer_list.value[]`) is a per-day time series of
`{value, message, timestamp}`; the period total is the sum, and `delta_change.value`
is the change vs. the prior window.

### Overview `insight_type` map

| type | key | metric |
|------|-----|--------|
| 121 | `analytics_overview_views` | video views |
| 122 | `analytics_overview_profile_views` | profile views |
| 123 | `analytics_overview_likes` | likes |
| 124 | `analytics_overview_comments` | comments |
| 125 | `analytics_overview_shares` | shares |
| 126 | `analytics_overview_rewards` | creator rewards ($) |
| 127 | `analytics_overview_traffic_source` | traffic sources |
| 140 | `analytics_viewer_new_viewer` | new followers/viewers |

Many more insight types exist (e.g. `studio_feed_*`, `article_links_*`); request a
wide `insight_type` range and read the returned key names to discover them. Use
`tiktok api /tiktok/v1/analytics/insights/ --bare --query 'type_requests=[...]'`
to fetch raw per-day series or other insight types.

## Direct messages (NOT REST)

Message content rides an encrypted "Frontier" WebSocket, so there is no clean
REST endpoint for conversation history or sending. The skill uses the rendered
`/messages` page DOM instead:

- **Conversation list**: `[class*="DivItemWrapper"]` rows in the left pane — name
  in the first `<p>`, preview in a nested `<p>`, date + unread badge alongside.
- **Message history**: bubbles in the right pane
  (`[class*="DivMessageContent"]` / `MessageItem` / `DivChatItem`, with a
  paragraph fallback).
- **Composer**: `[contenteditable="true"]` / `textarea`; type + Enter to send.
- `/api/im/item_detail/?itemId=<id>` is only used by the UI to hydrate previews
  of *shared videos* inside a conversation — not the messages themselves.
