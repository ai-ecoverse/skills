# StreamYard API — discovered surface

Reverse-engineered from a live studio session (secret-sauce). All endpoints are
**same-origin** on `https://streamyard.com`, **cookie-authenticated** (session
cookies + `csrfToken`), and must be called from the studio tab's page context
(SLICC's localhost-origin fetch can't carry the cookies). `<bid>` is the studio
URL path segment (e.g. `hrva5pvcuz`).

## Endpoints (GET)

| Path | Returns |
|---|---|
| `/api/broadcasts/<bid>` | Broadcast object: `title`, `status`, `hostDisplayName`, `outputs[]`, `shownCommentIds[]`, `cumulativeDurationInMs`, `lastEpisodeDurationInMs`, `lastStartedAt`, `selectedBrandId`, … |
| `/api/broadcasts/<bid>/destinations/<destinationId>/platform_comments` | `{ comments: [...], nextPageToken }` — live viewer comments for one connected platform |
| `/api/broadcasts/<bid>/starred_comments` | `{ starredComments: [...] }` |
| `/api/broadcasts/<bid>/workspace` | Workspace metadata |
| `/api/broadcasts/<bid>/team` | Team metadata |
| `/api/broadcasts/<bid>/token` | Studio/session token |
| `/api/ws/auth` | Realtime websocket auth (studio state + comments push) |

## `outputs[]` (connected destinations)

Each output describes one streaming destination:

- `id` — the output id
- `destinationId` — the connected-account id **used for `platform_comments`**
- `platform` — `youtube` | `linkedin` | `facebook` | …
- `platformUsername`, `platformLink`, `platformChatId`, `platformStreamId`
- `title`, `description`, `category`, `plannedStartTime`
- `status` — `scheduled` | `live` | …

## Realtime

The studio pushes live state and comments over a WebSocket authorized via
`/api/ws/auth`. The socket is opened at page load. For a scripted client, polling
`platform_comments` on an interval (see `streamyard watch`) is simpler and
sufficient; hook `window.WebSocket` in the page context if you need push latency.

## Notes

- Comments require the broadcast to be live on a platform with a comment feed.
- `shownCommentIds` on the broadcast = comments the host has put on screen.
- Everything here is read-only in this skill; broadcast controls (go-live,
  banners, layout) were intentionally not wired up to avoid disrupting a live show.
