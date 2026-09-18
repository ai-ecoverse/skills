// "Open Target Window" — open a REAL, correctly-sized window to record.
//
// STATUS: FALLBACK PATH (runtimes before SLICC 6.169.0).
//
// 6.169.0 added real window verbs to the `sliccy:browser` jsh module --
// `openWindow(url,{width,height,left,top,state,decorated,focus})`,
// `windowBounds(tab)` and `setWindowBounds(tab,bounds)` -- and those are now the
// primary route. Prefer them: they need no click, they hand back a TabHandle that
// every other verb accepts, and they can produce a DECORATED window (title bar +
// URL bar) at an exact size, which this module fundamentally cannot.
//
// This popup path is kept because before 6.169.0 there was NO window API at all.
// Its limitation is structural: `popup=yes` is what makes Chrome honour the size
// features, so the result always has popup chrome (measured 67px vs 87px
// decorated) and can never show a URL bar.
//
// UNIT DIFFERENCE -- do not port numbers between the two routes:
//   window.open(...,'width=W,height=H')  sizes the CONTENT area
//   browser.openWindow({width,height})   sizes the FRAME, chrome included
// Measured on 6.169.0: openWindow height 600 -> outerHeight 600, innerHeight 513
// (87px chrome). Copying a window.open size straight into openWindow leaves the
// content area short by the chrome height.
//
// WHY THIS EXISTS
// `playwright-cli resize` sets the VIEWPORT only and drops devicePixelRatio
// from 2 to 1, so "Force tab size" actively LOWERED capture quality and never
// changed the frame. Worse, that dpr damage is STICKY: resizing back leaves dpr
// 1, `resize 0 0` is rejected, and there is no clear-override command -- only
// closing the tab resets it.
//
// `window.open` with width/height features sizes a REAL window and KEEPS dpr 2,
// so the same two numbers finally mean what the UI claims.
//
// Capture resolution is FRAME x dpr. On 6.169.0 read dpr from
// `browser.windowBounds(tab).dpr` rather than assuming 2; on this path it must be
// measured over CDP because the opener cannot read a cross-origin popup.
//
// MEASURED (live, human-clicked; not reproducible from an agent shell):
//  * requested 1280x800 -> outer 1280x843, inner 1280x776, dpr 2,
//    predictedFrame 2560x1686. Width matched exactly; HEIGHT MATCHED NEITHER
//    (800 requested, 843 outer, 776 inner) -- so ALWAYS measure what was
//    achieved, never assume the request was honoured.
//  * the popup IS a CDP target: it appears in `tab-list` and can be navigated
//    and driven, so foregrounding / REC_TAB / geometry probes all keep working.
//  * FRAME = outerWidth x dpr. Confirmed against ffprobe: outer 1424x375, dpr 2
//    -> encoded frames exactly 2848x750.
//  * `window.resizeTo()` on a normal tab is a FALSE SUCCESS: it reports the new
//    size synchronously then REVERTS within 50ms. Chrome honours it only for
//    script-opened windows. Never use it, and never trust a synchronous
//    read-back as proof.
//  * CDP `eval` has NO user activation, so `window.open` from `playwright-cli
//    eval` returns no handle. Only a real gesture can open a popup.
//  * A DIP cannot open a popup at all, but a `target=_blank` anchor DOES open a
//    tab -- unsized, inheriting the opener's dimensions.
//  * There is no CDP passthrough in `playwright-cli`. That USED to mean OS-window
//    sizing was unreachable -- no longer true: `require('sliccy:browser')`
//    .setWindowBounds(tab, bounds) does it directly on 6.169.0+, and returns the
//    ACHIEVED bounds because Chrome clamps silently (measured: requesting height
//    1080 yielded 841, with top moved to availTop 33, and nothing threw).
//
// HARD PROHIBITION: never call `playwright-cli resize` on the window opened
// here. It would undo the dpr 2 this path exists to preserve, irreversibly.

/** Accept only http/https. Rejects javascript:, data:, file:, and junk. */
export function validateUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, reason: 'empty' };
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    // Allow a bare host by assuming https, the common case for typed input.
    try {
      u = new URL('https://' + s);
    } catch (e2) {
      return { ok: false, reason: 'not a URL' };
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'only http/https (got ' + u.protocol + ')' };
  }
  if (!u.hostname) return { ok: false, reason: 'no host' };
  return { ok: true, url: u.href };
}

/**
 * Quote a URL for a single-quoted shell context. The URL is validated first, so
 * this is defence in depth rather than the only guard -- same rigour already
 * applied to tab ids.
 */
export function shellQuoteUrl(url) {
  return "'" + String(url).replace(/'/g, "'\\''") + "'";
}

/** `popup=yes` is what makes Chrome treat the size features as a real window. */
export function popupFeatures(w, h) {
  return 'popup=yes,width=' + (w | 0) + ',height=' + (h | 0) + ',left=40,top=60';
}

/**
 * The one geometry command. Reads OUTER (which determines the frame) as well as
 * inner and dpr. Runs over CDP because the sprinkle's own window handle CANNOT
 * read a cross-origin popup's geometry -- that throws SecurityError (measured).
 */
export function windowGeometryCmd(targetId) {
  const id = String(targetId).replace(/[^A-Za-z0-9]/g, '');
  return (
    'playwright-cli eval "JSON.stringify({ow:outerWidth,oh:outerHeight,iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})" --tab=' +
    id
  );
}

export function parseGeometry(stdout) {
  const s = String(stdout || '');
  const m = s.match(/\{[^{}]*"ow"[\s\S]*?\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (e) {
    try {
      return JSON.parse(m[0].replace(/\\"/g, '"'));
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Turn measured geometry into the manifest's targetWindow block.
 *
 * predictedFrame = outerWidth x dpr (measured formula, confirmed by ffprobe).
 * `sized` is true ONLY when a handle let the size features apply -- the anchor
 * fallback opens a window it cannot size, and saying otherwise would be a lie.
 */
export function describeTargetWindow(opts) {
  const o = opts || {};
  const g = o.geometry || null;
  const out = {
    url: o.url || null,
    requested: o.requestedW && o.requestedH ? o.requestedW + 'x' + o.requestedH : null,
    openedVia: o.openedVia || null,
    sized: !!o.sized,
    targetId: o.targetId || null,
    outerAfter: g ? g.ow + 'x' + g.oh : null,
    innerAfter: g ? g.iw + 'x' + g.ih : null,
    dpr: g ? g.dpr : null,
    predictedFrame: g && g.dpr ? Math.round(g.ow * g.dpr) + 'x' + Math.round(g.oh * g.dpr) : null,
  };
  if (!o.openedVia) {
    out.note = 'no target window was opened';
  } else if (!out.sized) {
    out.note =
      'window opened UNSIZED via ' +
      out.openedVia +
      ' (no handle, so size features could not apply) — it inherits the opener’s dimensions; size it manually before recording';
  } else if (!g) {
    out.note = 'opened at the requested size, but the achieved geometry could not be measured';
  } else {
    const exact = out.requested === out.outerAfter;
    out.note =
      'opened via ' +
      out.openedVia +
      '; achieved outer ' +
      out.outerAfter +
      ' at dpr ' +
      g.dpr +
      ' → frame ≈ ' +
      out.predictedFrame +
      (exact
        ? ''
        : ' (requested ' + out.requested + '; Chrome adjusts height for window chrome)');
  }
  return out;
}

/**
 * Attempt the sized popup. Returns {handle, openedVia, sized}.
 *
 * MUST be called from a real click handler: CDP eval has no user activation, and
 * a full-document sprinkle renders in a SANDBOXED iframe which may withhold
 * `allow-popups` entirely. Both cases surface as a null handle, so the caller
 * must degrade honestly rather than assume success.
 */
export function openTargetWindow(url, w, h, win) {
  const W = win || window;
  let handle = null;
  if (w && h) {
    try {
      handle = W.open(url, 'sliccTarget', popupFeatures(w, h));
    } catch (e) {
      handle = null;
    }
    if (handle) return { handle: handle, openedVia: 'window.open', sized: true };
  } else {
    try {
      handle = W.open(url, 'sliccTarget');
    } catch (e) {
      handle = null;
    }
    if (handle) return { handle: handle, openedVia: 'window.open', sized: false };
  }
  // Fallback: a target=_blank anchor escapes where window.open is blocked
  // (measured in a dip). It opens the window but CANNOT size it -- there is no
  // handle, and it inherits the opener's dimensions.
  try {
    const a = W.document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    W.document.body.appendChild(a);
    a.click();
    W.document.body.removeChild(a);
    return { handle: null, openedVia: 'anchor', sized: false };
  } catch (e) {
    return { handle: null, openedVia: null, sized: false, error: (e && e.message) || String(e) };
  }
}

/** Find the just-opened window in tab-list by URL. Most recent match wins. */
export function findTargetId(tabs, url) {
  if (!tabs || !tabs.length) return null;
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    target = null;
  }
  const exact = tabs.filter((t) => t.url === url);
  if (exact.length) return exact[exact.length - 1].id;
  if (target) {
    // Chrome may normalise or the page may redirect; fall back to host+path.
    const host = tabs.filter((t) => {
      try {
        const u = new URL(t.url);
        return u.hostname === target.hostname && u.pathname === target.pathname;
      } catch (e) {
        return false;
      }
    });
    if (host.length) return host[host.length - 1].id;
    const byHost = tabs.filter((t) => {
      try {
        return new URL(t.url).hostname === target.hostname;
      } catch (e) {
        return false;
      }
    });
    if (byHost.length) return byHost[byHost.length - 1].id;
  }
  return null;
}
