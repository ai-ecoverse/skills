# Sizing the window you are about to record

Every route below was measured live, not read from documentation.

Since **SLICC 6.169.0** there is a real window API in the `sliccy:browser` jsh module, and it
is the route to use. Everything under "Fallback" exists for older runtimes.

## Primary: `sliccy:browser` window verbs (6.169.0+)

```js
const browser = require('sliccy:browser');

browser.openWindow(url, { width?, height?, left?, top?, state?, decorated?, focus? }) // -> TabHandle
browser.windowBounds(tab)                                  // -> {left,top,width,height,state,dpr}
browser.setWindowBounds(tab, { left?, top?, width?, height?, state? }) // -> ACHIEVED bounds
```

These sit alongside the eight pre-existing verbs (`findTab`, `ensureTab`, `eval`, `evalAsync`,
`cookie`, `localStorage`, `fetch`, `websocket`). The returned `TabHandle` is accepted by all of
them, so `openWindow` is interchangeable with `findTab`/`ensureTab` as a handle source.

Measured in a scoop sandbox on 6.169.0 (macOS, 1470x956 CSS px, dpr 2):

```
openWindow('https://example.com', {width:900, height:600, left:50, top:50, decorated:true})
  -> {"targetId":"2592E635973B8DA976D9B5BC86F64492","url":"https://example.com","title":""}
windowBounds(tab)
  -> {"left":50,"top":50,"width":900,"height":600,"state":"normal","dpr":2}
page-reported
  -> {"ow":900,"oh":600,"iw":900,"ih":513,"dpr":2,"chrome":87,
      "availW":1470,"availH":841,"availTop":33,"scrH":956}
```

Why this supersedes every page-context trick: the frame size was honoured **exactly**, `dpr 2`
was preserved, and `chrome: 87` means the window is fully **decorated** — title bar and URL bar
present. Every older route forced a tradeoff: a sized window got minimal popup chrome (67px),
and a decorated window silently refused to be sized. A recording that must show the URL bar
(navigation demos, docs, tutorials) is expressible for the first time.

Notes:

- `decorated` defaults to `true`. `false` gives popup chrome.
- `state` is `'normal' | 'minimized' | 'maximized' | 'fullscreen'`. Any state other than
  `'normal'` **cannot** be combined with `left`/`top`/`width`/`height`.
- `focus` brings the window forward.

## Units: `width`/`height` are FRAME pixels, including chrome

This is the trap when porting older code.

| API | what the numbers mean |
| --- | --- |
| `window.open(url, name, 'width=W,height=H')` | **content area** |
| `browser.openWindow({width, height})` | **frame, including chrome** |
| CDP `Target.createTarget`, `chrome.windows.create` | **frame, including chrome** |

Proof from the measurement above: requested frame height 600 produced `outerHeight` 600 and
`innerHeight` **513** — a difference of exactly the 87px chrome.

So the two routes are **not interchangeable at the same numbers**. Do not port a `window.open`
size straight into `openWindow`; the content area will be short by the chrome height. Convert
explicitly, and state which convention your code uses:

```
openWindow height  = desired content height + chromeHeight
chromeHeight       = outerHeight - innerHeight   // measured: 87 decorated, 67 popup
```

Chrome height is platform- and chrome-version-specific. Measure it; do not hardcode 87.

## Capture resolution = frame × dpr

`windowBounds()` returns `dpr`, so use it rather than assuming 2:

```js
const b = await browser.windowBounds(tab);
const frame = { w: b.width * b.dpr, h: b.height * b.dpr };
```

Confirmed end to end on the older path too: a window reporting `outerWidth/Height` of
`1424x375` at `dpr 2` produced encoded frames of exactly **2848x750** per `ffprobe`.

Related pitfalls:

- The **viewport** (`innerWidth/Height`) does not describe the frame for a window or monitor
  capture.
- `track.getSettings()` is not a substitute: for `displaySurface: "window"` it reported
  `2940x1912`, which is the *screen* at backing scale (`screen.width/height` 1470x956 × dpr 2),
  while the frames were `2848x750`. Read `videoWidth`/`videoHeight` off the decoded stream.

## Read the achieved bounds back — requests are clamped silently

`setWindowBounds()` returns the **achieved** bounds because Chrome clamps without raising an
error. Measured:

```
setWindowBounds(tab, {width:1080, height:1080})
  -> {"left":50,"top":33,"width":1080,"height":841,"state":"normal","dpr":2}
```

Requested height **1080**, achieved **841**, and `top` was moved 50 → 33. Nothing threw.
**Treat the return value as authoritative over the request, always.**

## The usable ceiling is `availHeight`, not `screen.height`

For window placement the limit is the *usable* area, which excludes OS chrome such as the
macOS menu bar and the dock:

| value | measured |
| --- | --- |
| `screen.width` / `screen.height` | 1470 x **956** |
| `screen.availWidth` / `availHeight` | 1470 x **841** |
| `screen.availTop` | **33** |

`956` is the wrong number for fitness checks — an 1080-tall request does not merely exceed
956, it is clamped to **841**, which is why the clamp above landed there and why `top` shifted
to `availTop`.

These are **one machine's values**. Discover them at runtime from the page
(`screen.availWidth`/`availHeight`/`availTop`) and never hardcode them.

## Fallback: `window.open` with size features (runtimes before 6.169.0)

Kept only because before 6.169.0 there was **no window API at all**; a page-context popup was
the only way to get a sized window. Its limitation: it can produce **popup chrome only**, so it
**cannot** create a decorated window with a URL bar. It also sizes the **content area**, not the
frame.

It requires a real click (a full-document sprinkle with `allow-popups`), and the handle is what
makes sizing possible:

```js
window.open(url, 'sliccTarget', 'popup=yes,width=1280,height=800,left=40,top=60');
```

Measured on the older routes, for context:

| route | sizes the OS window? | `devicePixelRatio` | CDP-controllable? |
| --- | --- | --- | --- |
| `playwright-cli resize` | **no** — viewport only | **drops 2 → 1**, sticky | yes |
| `window.resizeTo()` on a normal tab | **no** — reverts in ~50 ms | 2 | yes |
| dip button → `window.open` | blocked by the dip sandbox | — | — |
| dip button → `target=_blank` anchor | opens, but **cannot size** | 2 | yes |
| sprinkle → `window.open` with size features | yes | 2 preserved | yes |

### Why `playwright-cli resize` is the wrong tool

It is a CDP device-metrics override. Measured, requesting `1280x800`:

| metric | before | after |
| --- | --- | --- |
| `innerWidth`/`innerHeight` | 1200x714 | **1280x800** (changed) |
| `outerWidth`/`outerHeight` | 1200x801 | **1200x801** (unchanged) |
| `devicePixelRatio` | **2** | **1** (changed) |

1. For a window or monitor capture the frame comes from the OS window, so the override
   **cannot** change the recording size.
2. It **halves the render resolution** while the window is still captured at the 2× backing
   scale — forcing a size makes the recording *worse* than leaving it alone.

**The dpr damage is not recoverable.** Resizing back leaves `dpr` at 1, and `resize 0 0` is
rejected (`requires positive integer width and height`). Closing and reopening the tab is the
only reset. Never run `resize` against a window whose quality you care about — with
`openWindow` available there is no reason to run it at all.

`resize` remains correct for one case: a `displaySurface: "browser"` capture, where the tab
*is* the frame.

### Why `resizeTo` looks like it works

On a normal tab it is a **false success**. Requesting `1280x800`: synchronously afterwards
`outerWidth/Height` reads `1280x800` (and `screenY` even moves 381 → 156), but at +50 ms,
+200 ms and +600 ms it has reverted to `1424x375`. A naive check reads back the requested value
and concludes success. Chrome honours `resizeTo` only for script-opened, single-tab windows.

### The sandbox boundary

A **dip** cannot open a popup. With `navigator.userActivation.isActive === true` — a genuine
gesture — both `window.open(url, name, features)` and `window.open(url, '_blank')` returned
**no handle**. A `target="_blank"` anchor *does* escape and yields a controllable tab with
`dpr 2`, but there is no handle, so it cannot be sized and inherits the opener's dimensions.

A **full-document sprinkle** was blocked the same way until the runtime granted `allow-popups`:

```
Blocked opening 'https://…' in a new window because the request was made in a
sandboxed frame whose 'allow-popups' permission is not set.
```

On such a runtime, expect the anchor fallback and report the window as **unsized** rather than
claiming a size that was not applied.

Also: **CDP `eval` carries no user activation** (`isActive === false`), so `window.open` from
`playwright-cli eval` returns null. Only a real gesture — or trusted CDP mouse input
(`mousemove x y` then `mousedown`/`mouseup`, which take *no* coordinates) — can open a popup.

## Discovering a window opened the old way

`openWindow` hands back a `TabHandle` directly, so none of this is needed on 6.169.0+.

For the fallback path: a popup is a first-class CDP target, so find it in
`playwright-cli tab-list` after opening. Match by **set difference** against a snapshot taken
before the open — the new target id is the popup whatever it navigates to. URL matching breaks
on a cross-host redirect (`https://www.yahoo.de/` → `consent.yahoo.com/v2/collectConsent?…`
returned no match), and a popup still on `about:blank` needs a bounded retry. The sprinkle's own
`window` handle **cannot** read a cross-origin popup's geometry — that throws `SecurityError` —
so measure over CDP, which is not bound by same-origin.
