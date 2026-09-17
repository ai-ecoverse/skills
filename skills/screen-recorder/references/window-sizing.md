# Sizing the window you are about to record

Every route below was measured live, not read from documentation. The summary first, because four of the five routes fail:

| route | sizes the OS window? | `devicePixelRatio` | CDP-controllable? |
| --- | --- | --- | --- |
| `playwright-cli resize` | **no** — viewport only | **drops 2 → 1**, sticky | yes |
| `window.resizeTo()` on a normal tab | **no** — reverts in ~50 ms | 2 | yes |
| dip button → `window.open` | blocked by the dip sandbox | — | — |
| dip button → `target=_blank` anchor | opens, but **cannot size** | 2 | yes |
| **sprinkle → `window.open` with size features** | **yes** | **2 preserved** | **yes** |

## The frame equals `outerWidth × devicePixelRatio`

This is the formula that matters, and it is confirmed end to end: a window reporting
`outerWidth/Height` of `1424x375` at `dpr 2` produced encoded frames of exactly
**2848x750** according to `ffprobe`.

Consequences:

- The **viewport** (`innerWidth/Height`) does not describe the frame for a window or
  monitor capture.
- Neither does a requested size. Requesting `1280x800` yielded `outer 1280x843`,
  `inner 1280x776` — the width matched exactly, the height did not. **Measure the achieved
  geometry; never assume the request was honoured.**
- `track.getSettings()` is not a substitute: for `displaySurface: "window"` it reported
  `2940x1912`, which is the *screen* at backing scale (`screen` 1470x956 × dpr 2), while the
  frames were `2848x750`. Read `videoWidth`/`videoHeight` off the decoded stream instead.

## Why `playwright-cli resize` is the wrong tool here

It is a CDP device-metrics override. Measured, requesting `1280x800`:

| metric | before | after |
| --- | --- | --- |
| `innerWidth`/`innerHeight` | 1200x714 | **1280x800** (changed) |
| `outerWidth`/`outerHeight` | 1200x801 | **1200x801** (unchanged) |
| `devicePixelRatio` | **2** | **1** (changed) |

Two independent problems:

1. For a window or monitor capture the frame comes from the OS window, so the override
   **cannot** change the recording size.
2. It **halves the render resolution** while the window is still captured at the 2× backing
   scale — so forcing a size makes the recording *worse* than leaving it alone.

**The dpr damage is not recoverable.** Resizing back to the window's own dimensions leaves
`dpr` at 1, and `resize 0 0` is rejected (`requires positive integer width and height`).
There is no clear-override command. Closing and reopening the tab is the only reset — so
never run `resize` against a window whose quality you care about.

`resize` remains correct for one case: a `displaySurface: "browser"` capture, where the tab
*is* the frame.

## Why `resizeTo` looks like it works

On a normal tab it is a **false success**. Requesting `1280x800`:

- synchronously afterwards, `outerWidth/Height` reads `1280x800` — and `screenY` even moves
  from 381 to 156
- at +50 ms, +200 ms and +600 ms it has reverted to `1424x375`

A naive check reads back the requested value and concludes success. Chrome only honours
`resizeTo` for script-opened, single-tab windows.

## The sandbox boundary

A **dip** cannot open a popup. With `navigator.userActivation.isActive === true` — a genuine
gesture — both `window.open(url, name, features)` and `window.open(url, '_blank')` returned
**no handle**. A `target="_blank"` anchor *does* escape and yields a fully controllable tab
with `dpr 2`, but there is no handle, so it cannot be sized and inherits the opener's
dimensions.

A **full-document sprinkle** was blocked the same way until the runtime granted
`allow-popups` un-nested:

```
Blocked opening 'https://…' in a new window because the request was made in a
sandboxed frame whose 'allow-popups' permission is not set.
```

On a runtime without that grant, expect the anchor fallback and report the window as
**unsized** rather than claiming a size that was not applied.

Also note: **CDP `eval` carries no user activation** (`isActive === false`), so
`window.open` from `playwright-cli eval` returns null. Only a real gesture — or trusted CDP
mouse input (`mousemove x y` then `mousedown`/`mouseup`, which take *no* coordinates) — can
open a popup.

## Discovering the window you just opened

A popup is a first-class CDP target. After opening, find it in `playwright-cli tab-list`
and match on URL to recover its target id; it can then be navigated and driven like any
other tab (verified by seeking a video to 30 s and playing it). The sprinkle's own
`window` handle **cannot** read a cross-origin popup's geometry — that throws
`SecurityError` — so measure over CDP instead, which is not bound by same-origin.
