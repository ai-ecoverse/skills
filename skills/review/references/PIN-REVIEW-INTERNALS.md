# Pin Review — internals

Background for debugging the Pin Review overlay. **Not needed for normal operation** — see the
Pin Review section of [`SKILL.md`](../SKILL.md) for the commands. Read this when pins go missing, duplicate, or
land in the wrong spot.

## Two concerns

The overlay has two independent layers:

1. **Display layer** — markers + hover tooltips + the "Fix with Speck" button. Once injected it is
   **always visible**, regardless of Pin Review mode. Done pins are skipped. Exposes
   `window.__sliccRenderMarkers()` to re-render from state.
2. **Add mode** (`window.__sliccAddMode`) — the crosshair + click-to-place-new-pin behavior. This
   is the **only** thing the Pin Review button toggles.

So `exit.js` (add mode off) keeps markers visible; only the crosshair and open popups go away.

## Dual-store persistence

Pins live in two places; the second is what makes them durable.

- **`sessionStorage` (key `__sliccReviewMarkers`)** — fast, page-local cache. Survives reloads but
  is scoped to that tab's session; lost on tab close / browser restart.
- **Durable slicc state (`state.pins`, keyed by page url)** — the sprinkle persists every pin's full
  marker object (`{num, comment, pageX, pageY, selector, relX, relY, url, ts, done}`) through
  `slicc.setState()`. Survives panel reloads and browser restarts, and can be re-seeded onto any tab
  pointed at the same url. Populated by `add-pin`, read back via `request-pins` → `pins` lick.

Because `state.pins` is appended on every `add-pin`, slicc is always a superset of the cache — seeding
from it never drops pins.

## Precedence: `__sliccReviewAll` vs `sessionStorage`

On injection the overlay (`enter.js:35–36`) takes markers from a pre-populated
`window.__sliccReviewAll` if it is non-empty; otherwise it falls back to the `sessionStorage` cache.
This is a **precedence, not a merge**: a non-empty `__sliccReviewAll` wins outright.

Consequence: seeding `__sliccReviewAll` makes durable slicc state authoritative. Only do it when you
want that (fresh tab / restart, or to repair a stale cache). **Never seed an empty or stale array** —
it would clobber visible pins. If pins vanish after a re-inject, you likely seeded empty
`__sliccReviewAll`; recover by setting `window.__sliccReviewAll=[]` and re-injecting so it falls back
to `sessionStorage`. When `sessionStorage` already holds the pins (same-session reload), skip the
seed round-trip entirely.

## Element-anchored positioning

Each pin stores its target element's `selector` plus the click's fractional offset within that element
(`relX`/`relY`), with absolute `pageX`/`pageY` as a fallback. Markers are positioned relative to the
live element's bounding rect, so they stay attached on resize / reflow instead of being pinned to
absolute page coords. The overlay binds `window.__sliccDoReposition` and listens for `resize`/`scroll`
(rAF-throttled) to reposition all markers.

## Overlay versioning

The overlay is versioned via `OVERLAY_VERSION` (`enter.js:10`, currently **4**), surfaced as
`window.__sliccOverlayVersion`.

- Re-running `enter.resolved.js` when the display layer exists **and** the version matches just
  refreshes markers + add mode (returns `status:'reinjected'`) — it does not duplicate listeners.
- A higher version forces a full re-init.
- A click-gen token (`window.__sliccClickGen`) makes superseded click listeners inert
  (`enter.js:248–251`), so upgrades never double-handle a click.

Bump `OVERLAY_VERSION` whenever render/reposition logic changes.

## Why `mode:'no-cors'` for remote pages

The overlay POSTs each pin to the webhook with `mode:'no-cors'`. A normal cross-origin POST from a
remote page is blocked (the webhook returns no CORS headers); `no-cors` still delivers the body
(fire-and-forget, opaque response). Only **Fix with Speck** stays local-only — it injects editing JS
that remote CSP blocks.

## Why the pin icon is never sent as an emoji

Passing the 📍 emoji through the scoop's jq/shell pipeline double-encodes it (mojibake — renders like
an Icelandic `ð`). The **sprinkle renders the icon itself**: `renderCommentEntry` detects a pin
(numeric `num`), draws a Lucide `map-pin` icon, and strips any leading emoji/mojibake/`PIN #n:` prefix
from the display text. So the cone always sends plain ASCII comment text.

## Sorted display

Comment lines render **sorted by pin number** (ascending) via the `sortedComments(list)` helper,
applied at every render site (card build, done-toggle, `set-comment-done`, `clear-pins`/`remove-pin`
re-renders). Non-pin comments (no `num`) sort after pins, preserving their relative order.
