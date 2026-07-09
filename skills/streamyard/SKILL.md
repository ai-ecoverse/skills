---
name: streamyard
description: >-
  Interact with a StreamYard live-streaming studio via its API — read the
  broadcast title/status, connected destinations (YouTube/LinkedIn/etc), live
  viewer comments, and starred comments, and watch for new comments in real
  time. Use when the user wants to check a StreamYard broadcast, monitor live
  stream comments, build a comment overlay/ticker, or automate anything in a
  StreamYard studio. Triggers on mentions of StreamYard, live stream comments,
  broadcast status, studio, or a streamyard.com studio tab.
allowed-tools: bash
---

# StreamYard

Direct API access to a StreamYard live studio. All calls run **inside the open
studio browser tab** (`streamyard.com/<id>`) via the `sliccy:browser` bridge —
StreamYard's backend is same-origin cookie-authed REST, so the page context
carries the session automatically. Open your studio and sign in first.

## Quick start

```bash
streamyard info          # broadcast title, status, destinations, durations
streamyard comments      # live viewer comments across connected platforms
streamyard starred       # starred/featured comments
streamyard watch         # stream new comments as they arrive (poll)
streamyard watch --scoop=my-watcher   # also POST new comments to a scoop
streamyard raw /api/broadcasts/<id>/workspace   # escape hatch
```

Add `--json` to `info`/`comments`/`starred` for machine-readable output.

## How it works

- The broadcast id is the studio URL path (`streamyard.com/<bid>`), auto-detected
  from the open tab.
- Live viewer comments per platform live at
  `/api/broadcasts/<bid>/destinations/<destinationId>/platform_comments`, where
  `destinationId` = `outputs[].destinationId` in the broadcast object (not the
  output `id`). `comments` resolves this automatically for every connected output.
- Comments only appear while the broadcast is live on a platform that has a
  comment feed (e.g. YouTube). A `available`/`scheduled` studio returns none.

See `references/endpoints.md` for the full discovered surface.

## Auth

Cookie session on `streamyard.com`. If a call returns 401/403, reload the studio
tab and sign in again. Nothing is written to disk; the session lives only in the
browser tab.
