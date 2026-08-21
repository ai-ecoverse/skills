# Slack watch architecture

This file documents the internals of `slack watch` and of `slack post`'s 1-hour
reply auto-watch. You do **not** need to read it to use those commands — SKILL.md
covers the flags and the observable behaviour. Read this when debugging a watch
that stopped firing, when changing the implementation, or when you need to know
exactly what state and background tasks a watch leaves behind.

## Pipeline

```
Slack servers → wss://*.slack.com/ → Browser WebSocket
    ↓
Runtime WebSocket observer (declarative filter: type=message + channel/thread)
    ↓
forward → SLICC webhook (closed-enum sink)
    ↓
SLICC delivers lick event to target scoop
```

Step by step, both for a manual `slack watch` and for `slack post`'s auto-watch:

1. A SLICC webhook is created, routed to the target scoop (one webhook per watch).
2. A declarative WebSocket observer is registered on the Slack browser tab via the
   sanctioned `browser.websocket` runtime API — no page-context code injection, no
   prototype patching.
3. Slack's `wss://*.slack.com/` connections carry all real-time events (messages,
   typing indicators, etc.).
4. The observer filters for `type: "message"` frames matching the watched channel
   (and thread, if specified).
5. Matching frames are forwarded to the webhook, which delivers them as licks to
   the scoop.

Because nothing polls, the mechanism is silent by construction: when nobody says
anything, no frame arrives, so the scoop is never woken. There are no ticks and no
per-minute wakes; a lick means a real message matched.

## WebSocket observer mechanism and selector shape

Registration is a three-call chain (`subscribeWatch()` in `scripts/slack.jsh`):

```js
browser.websocket
  .on(tab, { urlMatch: /slack\.com/ })
  .filter({ parseAs: 'json', where: { type: 'message', channel: '<channel>' /*, thread_ts */ } })
  .forward({ sink: 'webhook', webhookId: '<id>' });
```

- `urlMatch` is constrained to `/slack\.com/` so no cross-origin socket is ever
  matched (defence against cross-origin capture bleed).
- The `where` selector is a deep-equality subset match, equivalent to the guard
  `data.type === 'message' && data.channel === w.channel && (!w.thread_ts ||
  data.thread_ts === w.thread_ts)`. A `thread_ts` key is added only for a
  thread-scoped watch.
- The sink is a closed enum: skill code supplies a JSON selector plus an existing
  SLICC webhook id, and can neither author page-context code nor see the inbound
  frame firehose. The runtime owns the audited, single-source page-side router.

The predecessor implementation monkey-patched `WebSocket.prototype.send` inside the
Slack page and posted a reshaped `{ type: 'slack-watch', ... }` envelope to a
webhook URL. That patch was a P0 security finding and is gone. Consequence for
consumers: the sink now receives the **raw** Slack `message` frame the router
matched, not the old envelope. The per-channel/thread subscription makes the watch
context implicit, and the full frame is a superset of the old envelope's `event`.

## Subscription lifetime, and why deleting the webhook is the kill-switch

The observer subscription is owned by the runtime's page-side router and is tied to
the **tab**, not to the jsh process that registered it. Verified live. Three
consequences:

- It **survives the creating process's exit** — this is what lets `slack post` set
  up a watch and return immediately, and what lets it keep forwarding real reply
  frames afterwards.
- It **survives a tab reload** only as far as the router does; after a page reload
  the observers are gone and must be re-registered (see «Recovery» below).
- It can **only be closed by the process that created it** — `browser.websocket
  .list()` offers no cross-process close.

So teardown cannot revoke the subscription. Instead, **deleting the webhook is the
kill-switch**: once the webhook is gone the observer's sink no longer resolves, so
matched frames are silently dropped. The orphaned subscription lingers in the page
router until the Slack tab reloads, but it is an inert sink — no lick can reach
anyone. This is also why the auto-watch never deletes and recreates a webhook to
change its filter: that would orphan the observer with a live, unreachable sink.

## Socket-capture timing (the first ≤10 seconds)

Discovery requires an outbound `send()` on the socket: the runtime router wraps a
`WebSocket` instance the first time the page calls `send()` on it. A receive-only
socket that was established *before* the subscription was registered is therefore
captured only on its next outbound frame. Slack sends ping keepalives roughly every
10 seconds, so an existing connection is picked up within one ping cycle — but a
message arriving in the first few seconds after registration can be missed. This
matches the discovery semantics of the removed prototype patch.

## Genuine-reply webhook filter (auto-watch only)

`slack post`'s auto-watch attaches a `--filter` to its webhook so that only real new
replies wake the scoop. The webhook event carries the matched Slack frame under
`e.body` (the observer forwards the frame; the webhook wraps it), and the filter
keeps the defensive shape `(e && e.body) || e || {}` so it works either way. It is a
self-contained string with every value JSON-inlined — it closes over nothing:

```js
(e) => { const m = (e && e.body) || e || {};
  if (m.type !== 'message') return false;
  if (m.subtype) return false;          // message_replied parent updates, joins, edits
  if (m.ts === "<selfTs>") return false;   // echo of the message that created the watch
  if (m.user === "<selfUser>") return false; // anything WE post, for the whole hour
  return true; }
```

- `selfTs` is the `ts` of the message that started the watch.
- `selfUser` is our own Slack user id, resolved once at watch-creation time via the
  `auth.test` Web API method (`user_id`). The call is non-fatal: if it fails or
  returns no `user_id`, the `m.user` clause is omitted and the filter degrades to
  timestamp-only dropping. Posting never fails because of it.
- The own-user clause is what makes «your own messages never notify» hold for the
  whole life of the watch, and therefore makes TTL extension silent. It must be
  decided at creation time: a webhook's `--filter` is fixed at `webhook create`
  (the CLI has `create`/`list`/`delete`, no update), and the filter cannot be
  swapped later without deleting the webhook and orphaning the observer.

The resolved id is persisted as `selfUser` in the watch state file so the state
stays self-describing.

## Scope decision: `conversations.info` `num_members`

The auto-watch looks up the resolved channel with `conversations.info` and reads
`channel.num_members`:

- **> 100 members** → watch the **thread only**; the observer selector adds
  `thread_ts === <threadRoot>`, to avoid a firehose on a big channel.
- **≤ 100 members, or a DM, or an unknown/missing count** → watch the **whole
  channel**. A channel message watch also receives thread-reply frames, because
  those carry a top-level `channel` plus a `thread_ts`, so whole-channel scope
  covers both channel messages and thread replies.

A missing `num_members` (DMs and some conversation types omit it, and a failed
lookup is swallowed) is treated as «small». The thread root is the `--thread_ts`
that was replied into, or — for a fresh top-level post — the new message's own `ts`.

The watch id is derived from the scope decision: `<channel>-<threadTs>` for a
thread-scoped watch, plain `<channel>` for a channel-scoped one. This is the same
deterministic id scheme `slack watch` uses, so `slack unwatch <channel>` /
`--thread=<ts>` addresses an auto-watch exactly like a manual one.

## Routing

Replies route to the **cone** by default (`--scoop cone`), so they surface directly
to the human. If the runtime ever rejects the cone as a webhook target, the
auto-watch warns and falls back to a standing relay scoop `slack-reply-watch`,
auto-created if missing. `--watch-scoop=<name>` overrides the target.

If the observer registration fails after the webhook was created, the webhook is
deleted again (roll-back) and the post still succeeds with a warning — the whole
auto-watch path is non-fatal.

## One-hour TTL and the one-shot teardown crontask

`expiresAt` (now + 3600 s) and the teardown task id are stored in the watch state
file. A one-shot `crontask` named `slack-autowatch-teardown-<watchId>` is scheduled
about 60 minutes out. When it fires it delivers a self-describing lick to the watch
scoop naming the exact commands to run:

```json
{
  "kind": "slack-autowatch-teardown",
  "watchId": "<watchId>",
  "instruction": "The 1h Slack reply auto-watch has expired. Run these commands then stop.",
  "commands": ["slack unwatch <channel> [--thread=<ts>]", "crontask delete <taskName>"]
}
```

`slack unwatch` deletes the webhook (the kill-switch) and the state file; the second
command deletes the teardown task itself. So nothing runs or delivers past the hour.

**Local-time cron computation.** The cron expression pins minute, hour, day-of-month
and month (`<min> <hour> <dom> <month> *`) so the task fires exactly once. The
fields are read from `new Date()` in the JS realm, which is **local** time, because
the scheduler evaluates cron in local time — bash `date` must not be used here, it
is UTC in this environment. Pinning day and month means a same-time recurrence next
month would be the only repeat, and the teardown deletes itself before that.

## TTL extension

Posting again into a channel or thread that is already under an active auto-watch
**extends** the existing watch instead of erroring or duplicating the
webhook/observer: the old teardown crontask is deleted, a new one is scheduled
another hour out, and `expiresAt` is rewritten in the state file. The webhook, its
filter and the observer subscription are untouched (they cannot be updated — see
above), which is precisely why the filter drops by user id rather than by a single
timestamp: otherwise the extending post would itself be forwarded as a reply.

Output on the extend path is `Extended reply watch for <watchId> to 1h (routes to
<scoop>)`.

## State files

One JSON file per watch, at `/workspace/skills/slack/.watch-<watchId>.json`. Fields
written by the auto-watch (a manual `slack watch` writes the same shape minus the
`autowatch*`, `selfTs`, `selfUser`, `threadRoot`, `expiresAt` and `teardownTaskId`
fields):

| Field | Meaning |
|-------|---------|
| `watchId` | `<channel>` or `<channel>-<threadTs>` — deterministic, prevents duplicates |
| `channel` | Resolved conversation id (`C…`/`D…`/`G…`) |
| `thread_ts` | Thread root when thread-scoped, else `null` |
| `scoop` | Scoop the webhook routes licks to (`cone` by default) |
| `workspace` | Team/enterprise id the watch belongs to |
| `createdAt` | ISO timestamp of creation |
| `autowatch` | `true` for a `slack post` auto-watch (absent for manual watches) |
| `delivery` | `ws` — event-driven WebSocket observer delivery |
| `autowatchScope` | `thread` or `channel`, from the `num_members` decision |
| `threadRoot` | Thread root ts considered when the watch was created |
| `selfTs` | `ts` of the message that created the watch (dropped by the filter) |
| `selfUser` | Our own Slack user id from `auth.test`, or `null` (dropped by the filter) |
| `webhookId` | SLICC webhook id — deleting it is the delivery kill-switch |
| `webhookUrl` | Webhook URL |
| `filter` | The exact `--filter` JS string handed to `webhook create` |
| `expiresAt` | ISO expiry (creation + 1 h, rewritten on extension) |
| `teardownTaskId` | Crontask id of the one-shot teardown, or `null` |
| `subId` | Observer subscription id returned by the runtime |

`slack watches` reads these files; `slack unwatch` deletes the webhook, the teardown
crontask if present, and the file.

## Recovery after a page reload

The observers live in the Slack tab. If the page reloads, they are gone while the
webhooks and state files survive — the watch looks active in `slack watches` but no
licks arrive. Run `slack reinject` to read all active watch state files and
re-register one observer per watch. Same fix if watches simply stop firing.
