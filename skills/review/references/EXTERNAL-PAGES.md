# External browser page tools

Use these legacy tools only when reviewing an already-open browser tab. For
queue assets, use the single Preview button and its built-in annotations.
The external tools are in the collapsed **Tools for an external browser tab**
section of the queue.

## Pin Review (click-to-comment on a live page)

The sprinkle top bar has a **Pin Review** toggle that controls *adding* location pins to the active
tab. Markers are always visible once the display overlay is injected; the toggle only turns the
add-mode crosshair on/off. There is no in-page banner.

> **Architecture** — dual-store persistence, overlay versioning, element positioning, and the
> `__sliccReviewAll`/`sessionStorage` precedence rules live in [`PIN-REVIEW-INTERNALS.md`](PIN-REVIEW-INTERNALS.md). Read it
> when pins go missing, duplicate, or land in the wrong spot.

### Overlay assets (`overlay/`)
- `enter.js` — the full overlay. Has TWO placeholders, `sed` into a resolved copy `enter.resolved.js`:
  - `__WEBHOOK_URL__` (comment/pin webhook) — **required** at setup. Resolve from the live
    `review-marker` webhook URL.
  - `__SPECK_WEBHOOK_URL__` (speck-fix webhook) — **optional / lazy**. Resolve it to an empty string
    at first setup if Speck isn't wired yet; the Speck Fix lazy-load bootstrap (§ Lazy auto-load on
    first use) fills it in and re-injects the overlay the first time the user clicks **✨ Fix with
    Speck**. An empty value just means the Speck button is inert until that first click — Pin Review
    works fully without it.
- `exit.js` — turns OFF add mode (removes crosshair + open popups). Keeps markers visible.
- `remove-marker.js` — hide/restore one marker. Reads `window.__rvRemoveNum` + `window.__rvRemoveDone`
  set just before eval.
- `drain.js` / `reset.js` — poll committed comments / clear all marker state.

### Setup
1. Create a webhook routed to the `review` scoop: `webhook create --scoop review --name review-marker`.
2. `sed` its URL into `enter.resolved.js` for `__WEBHOOK_URL__`.
3. After any session resume, rebuild `enter.resolved.js` from `webhook list` — the URL regenerates
   across sessions. (Stale-URL symptom: pins POST opaquely but never arrive; `state.pins` stays empty.)

### Inject the overlay
Set `window.__sliccWantAdd` (true = add mode, false = display-only) in an inline eval **before**
eval-ing `enter.resolved.js`:
```bash
printf '(function(){window.__sliccWantAdd=false;})();' > /tmp/wantNoAdd.js
playwright-cli eval-file /tmp/wantNoAdd.js --tab <id>
playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
```
**Checkpoint** — the inject eval returns `{status:"active",...}` on first inject or
`{status:"reinjected",...}` on a refresh, with `markers`/`existing` equal to the expected pin count.
Confirm the version:
```bash
playwright-cli eval --tab <id> "window.__sliccOverlayVersion"   # must return 4
```

### Seed from durable state (fresh tab / after restart)
When a tab's `sessionStorage` may be empty (new tab, restarted browser, different machine), prime the
overlay from slicc state first: send `request-pins {url}`, await the `pins` lick, then write its array
into `window.__sliccReviewAll` in the same inline eval that sets `__sliccWantAdd`:
```bash
# PINS_JSON is the `pins` array from the request-pins → pins lick
printf '(function(){window.__sliccWantAdd=false;window.__sliccReviewAll=%s;})();' "$PINS_JSON" > /tmp/seed.js
playwright-cli eval-file /tmp/seed.js --tab <id>
playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
```
**Only seed with the real durable array — never an empty/stale one.** A non-empty `__sliccReviewAll`
wins over `sessionStorage` and clobbers visible pins (see [`PIN-REVIEW-INTERNALS.md`](PIN-REVIEW-INTERNALS.md)). On a same-session
reload, skip seeding and let the cache serve.

**Checkpoint** — after seeding, the marker count must equal `PINS_JSON` length:
```bash
playwright-cli eval --tab <id> "(window.__sliccReviewAll||[]).length"
```
If it's 0 after a seed, you seeded an empty array — set `window.__sliccReviewAll=[]` and re-inject to
fall back to sessionStorage.

### `toggle-review-mode` lick handler (cone)
- `active:true` → set `__sliccWantAdd=true`, eval `enter.resolved.js` (markers + crosshair). First
  remove any Speck layer and sync `set-speck active:false` (mutually exclusive — see [`SPECK-FIX.md`](SPECK-FIX.md)).
- `active:false` → eval `exit.js` (add mode off, crosshair off, markers stay).

### Keep pins visible across reloads (mandatory while review is active)

Pins live in the durable store, but the on-page **markers are erased whenever the
tab reloads or navigates** — a reload clears the injected overlay (`window.__sliccOverlayVersion`
goes back to `none`). While the review skill is active on a page, the cone is responsible for
**re-painting the markers after every reload/navigation** so the user always sees their pins.

The rule: **always keep the display overlay (`wantAdd=false`) injected on a pinned page** so pins
stay visible even with Pin Review off — including after Speck reloads, manual reloads, and
re-opening the page in a new tab.

Re-paint procedure (run whenever the page may have reloaded, or whenever the user reports pins
missing):

1. Check the tab's overlay state: `playwright-cli eval --tab <id> "window.__sliccOverlayVersion || 'none'"`.
   `none` (or a version below the expected `4`) means the overlay was cleared and must be re-injected.
2. Ask the sprinkle for the authoritative pins: `sprinkle send review '{"action":"request-pins","url":"<url>"}'`,
   then await the `pins` lick.
3. Seed the real array and inject the **display** overlay in the same step:
   ```bash
   printf '(function(){window.__sliccWantAdd=false;window.__sliccReviewAll=%s;})();' "$PINS_JSON" > /tmp/seed.js
   playwright-cli eval-file /tmp/seed.js --tab <id>
   playwright-cli eval-file /shared/review-overlay/enter.resolved.js --tab <id>
   ```
   (Use `__sliccWantAdd=true` instead only if add-mode should also be on — e.g. Pin Review toggled on.)
4. Verify: `(window.__sliccReviewAll||[]).length` equals the pin count and `window.__sliccOverlayVersion` is `4`.

Never seed an empty/stale array over a non-empty store (it clobbers visible pins — see
[`PIN-REVIEW-INTERNALS.md`](PIN-REVIEW-INTERNALS.md)). On a *same-session* reload where `sessionStorage` still holds the markers,
re-injecting the overlay alone is enough and seeding can be skipped; when in doubt, seed from the
durable `request-pins` array.

### Comment / pin flow
Each pin click opens a popup; on save it drops a numbered marker AND POSTs the full marker object to
the webhook. The `review` scoop pushes it into the sprinkle via **`add-pin`** with: a plain-text
display string `PIN #<num>: <comment>` (ASCII only — the sprinkle renders the icon itself), the
top-level numeric `num`, and the whole payload as `pin`. Use `add-comment` only for non-pin comments.

> **Record only.** Storing the pin is the *complete* handling of a pin click. Do **not** go on to edit
> the page/artifact to satisfy the pin's request (see § Scope). The change is the user's call, made
> explicitly or through Speck Fix.
```bash
sprinkle send review '{"action":"add-pin","id":"page-1","num":3,
  "comment":"PIN #3: tighten the hero copy",
  "pin":{"num":3,"comment":"tighten the hero copy","pageX":420,"pageY":680,
         "selector":".hero h1","relX":0.5,"relY":0.5,"url":"https://preview.example.com/x","ts":1733400000000}}'
```

### Auto-created per-page entries
Dropping a pin on ANY page auto-creates that page's review entry. The webhook handler derives a stable
item id from the pin's `url`, sends `ensure-item` to create or refresh the card, then `add-pin` to that
id. Never hardcode a single target id.

### Remote pages
Pin Review works on remote http(s) sites too — the overlay POSTs with `mode:'no-cors'`. Only
**Fix with Speck** is local-only (see [`SPECK-FIX.md`](SPECK-FIX.md)).

### Mark done (✗ per comment line)
Toggling a pin comment's done button fires `comment-done {num,done,itemId,cid}`. Cone handler: set
`window.__rvRemoveNum=<num>; window.__rvRemoveDone=<bool>`, eval `remove-marker.js` (re-renders
markers, hiding done pins), then echo to durable storage so a re-seed reflects it:
```bash
sprinkle send review '{"action":"set-pin-done","url":"https://preview.example.com/security","num":3,"done":true}'
```

## Speck Fix (element-level AI editing)

Optional add-on: run Speck's element-level AI editing on locally-served preview pages. The sprinkle
has a **Speck Fix** toggle, and each marker tooltip shows a "✨ Fix with Speck" button (local previews
only). Pin Review and Speck Fix are mutually exclusive.

### Lazy auto-load on first use (cone handler for `toggle-speck` / "Fix with Speck")

Speck is **loaded on demand**, not as a manual prerequisite. The user should be able to click
**✨ Fix with Speck** (or the **Speck Fix** toggle) and have it just work — the click is what triggers
the skill to load. When the cone receives a `toggle-speck {active:true}` lick (or an `inject-speck`
event) and Speck is **not yet set up**, the handler must bootstrap it automatically before proceeding,
then carry out the original request. Do not silently no-op on an unresolved `__SPECK_WEBHOOK_URL__`.

Bootstrap procedure (idempotent — skip any step already done):

1. **Install the skill if missing:** check for `speck` on disk; if absent, run
   `upskill ai-ecoverse/skills --skill speck`.
2. **Ensure the `speck-worker` scoop exists** (with `/tmp/` write access and the standing duties to
   handle the two webhooks — see [`SPECK-FIX.md`](SPECK-FIX.md)). Create it if missing.
3. **Ensure the two webhooks exist and are routed to `speck-worker`:** `speck-fix` (handles
   `inject-speck`) and `speck-lick` (element-instruction events). Create any that are missing.
4. **Resolve `__SPECK_WEBHOOK_URL__`:** re-build `enter.resolved.js` from the *current* `speck-fix`
   webhook URL (webhook URLs regenerate across sessions — always read the live URL from
   `webhook list`, never reuse a cached one), then re-inject the overlay so the tooltip button POSTs
   to a live endpoint.
5. **Proceed with the original request** — inject Speck on the active tab and sync the sprinkle
   (`set-speck active:true`, `set-review-mode active:false`).

Tell the user briefly that Speck is loading on first use; subsequent clicks are instant because the
bootstrap is idempotent.

**Full setup steps and architecture → [`SPECK-FIX.md`](SPECK-FIX.md).**
