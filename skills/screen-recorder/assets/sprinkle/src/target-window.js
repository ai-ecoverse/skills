// "Open Target Window" — open a REAL, correctly-sized window to record.
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
//  * There is no CDP passthrough in `playwright-cli`, so `Browser.setWindowBounds`
//    (the only API that truly sizes an OS window) is unreachable.
//
// HARD PROHIBITION: never call `playwright-cli resize` on the window opened
// here. It would undo the dpr 2 this path exists to preserve, irreversibly.


/**
 * Normalise a typed URL so `www.example.com` works.
 *
 * Rules:
 *  - no scheme        -> prepend https://
 *  - explicit http:// -> LEFT ALONE (never silently upgraded; the user asked for it)
 *  - about:/file:/chrome: -> left alone, returned as-is for the caller to judge
 *  - bare localhost / 127.0.0.1 / host:port -> https:// too, but http is common for
 *    localhost so it is preserved when typed explicitly
 * Returns the string to display back in the field (so the user sees what will open).
 */
export function normalizeUrlInput(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  // Already has a scheme? Leave it exactly as typed.
  //
  // CAREFUL: `host:port` looks exactly like `scheme:rest` to a naive regex, so
  // `localhost:8080` was being left un-normalised (measured in the unit tests).
  // A real scheme is followed by `//` (http://, file:///) or by a non-digit
  // opaque part (mailto:a, about:blank); `name:8080` is a host and a port.
  const schemeM = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(t);
  if (schemeM) {
    const rest = schemeM[2];
    const looksLikePort = /^\d+(?:[/?#]|$)/.test(rest);
    if (!looksLikePort) return t;
    // else: fall through and treat the whole thing as host:port
  }
  // Protocol-relative //host -> https:
  if (t.slice(0, 2) === '//') return 'https:' + t;
  return 'https://' + t;
}

/**
 * Build the autocomplete entries for #startUrl from the live tab list.
 * De-duplicates by URL, drops non-navigable entries, keeps the title as the
 * <option> label where one exists.
 */
export function urlSuggestions(tabs) {
  const skip = /^(about:|chrome:|chrome-extension:|devtools:|blob:|data:)/i;
  const seen = new Set();
  const out = [];
  for (const t of tabs || []) {
    const u = t && t.url ? String(t.url) : '';
    if (!u || skip.test(u)) continue;
    // Only offer things a popup could actually navigate to.
    if (!/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({ url: u, title: (t.title || '').trim() });
  }
  return out;
}

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
// NOTE the unit difference vs openTargetWindowApi: these features size the
// CONTENT area, while openWindow sizes the FRAME. Same numbers mean different
// windows -- they differ by the chrome height (67 popup / 87 decorated, measured).
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
 * Does a requested window size fit the usable display area?
 *
 * MEASURED DEFECT (take 2026-09-18T07-58-49-077Z): Lars requested 1080x1080 and
 * Chrome SILENTLY CLAMPED it -- the decoded frame was 2160x1618, i.e. an achieved
 * outer size of 1080x809 at dpr 2: width exact, height short by 271px, no error
 * anywhere. The display is only 1470x956 CSS px (capture.settings 2940x1912 / dpr
 * 2), so a 1080-tall window never could have fitted.
 *
 * THE KEY INSIGHT: `sized: true` means "the size features were ACCEPTED", NOT
 * "the requested size was ACHIEVED". Trusting `requested` would have written
 * 1080x1080 into the manifest -- a success-shaped wrong answer.
 *
 * availWidth/availHeight (not width/height) is the right bound: it excludes OS
 * chrome such as the menu bar and dock, which is exactly what limits a window.
 */
export function checkDisplayFit(w, h, scr) {
  const s = scr || (typeof screen !== 'undefined' ? screen : null);
  const availWidth = s && s.availWidth ? s.availWidth : null;
  const availHeight = s && s.availHeight ? s.availHeight : null;
  const out = { availWidth, availHeight, fitsDisplay: true, clampedAxes: [] };
  if (!w || !h || availWidth == null || availHeight == null) return out;
  if (w > availWidth) out.clampedAxes.push('width');
  if (h > availHeight) out.clampedAxes.push('height');
  out.fitsDisplay = out.clampedAxes.length === 0;
  return out;
}


/**
 * Decide which #sizePreset options are physically impossible on THIS display.
 *
 * MEASURED: on Lars's 1470x956 CSS-px display, 4 of the 7 shipped presets cannot
 * exist -- 1920x1080 (both axes), 1080x1920 and 1080x1080 (too tall), and he
 * picked 1080x1080, which Chrome clamped SILENTLY to 1080x809.
 *
 * Read from `screen` at RUNTIME -- never hard-code a display size; 1470x956 is
 * one machine's. Recomputed whenever the panel re-renders, so reopening on a
 * different display re-evaluates.
 *
 * @returns {Array<{value,fits,reason,suffix}>} one entry per preset value
 */
export function presetFitness(values, scr) {
  const out = [];
  for (const v of values || []) {
    if (!v) { // the "Custom…" entry
      out.push({ value: v, fits: true, reason: null, suffix: '' });
      continue;
    }
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (!m) { out.push({ value: v, fits: true, reason: null, suffix: '' }); continue; }
    const w = +m[1], h = +m[2];
    const fit = checkDisplayFit(w, h, scr);
    if (fit.fitsDisplay) { out.push({ value: v, fits: true, reason: null, suffix: '' }); continue; }
    const axes = fit.clampedAxes;
    const reason =
      axes.length === 2 ? 'too large for this display'
      : axes[0] === 'height' ? 'too tall for this display'
      : 'too wide for this display';
    out.push({ value: v, fits: false, reason, suffix: ' (' + reason + ')' });
  }
  return out;
}

/** Human-readable warning for the panel, or null when the request fits. */
export function displayFitWarning(w, h, fit) {
  if (!fit || fit.fitsDisplay || !fit.clampedAxes.length) return null;
  const axes = fit.clampedAxes.join(' and ');
  const capped =
    Math.min(w, fit.availWidth) + 'x' + Math.min(h, fit.availHeight);
  return (
    'Requested ' +
    w +
    'x' +
    h +
    ' does not fit the usable display (' +
    fit.availWidth +
    'x' +
    fit.availHeight +
    ' CSS px). Chrome will clamp the ' +
    axes +
    ' silently, so the window will be about ' +
    capped +
    ' and the recording will be captured at that size, not the size you asked for.'
  );
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
  // Display bounds recorded even when the CDP geometry probe could not run --
  // that is exactly the case where the manifest was previously unable to explain
  // a clamped window (all geometry null, note said only "could not be measured").
  const fit = o.fit || null;
  out.availWidth = fit ? fit.availWidth : null;
  out.availHeight = fit ? fit.availHeight : null;
  out.fitsDisplay = fit ? fit.fitsDisplay : null;
  if (!o.openedVia) {
    out.note = 'no target window was opened';
  } else if (!out.sized) {
    out.note =
      'window opened UNSIZED via ' +
      out.openedVia +
      ' (no handle, so size features could not apply) — it inherits the opener’s dimensions; size it manually before recording';
  } else if (!g) {
    // Honest: never fabricate outerAfter from `requested`. But DO say when the
    // request could not have been honoured, which is knowable without the probe.
    out.note =
      'opened, but the achieved geometry could not be measured (no target id)' +
      (fit && !fit.fitsDisplay
        ? ' — and the requested ' +
          out.requested +
          ' does NOT fit the usable display ' +
          fit.availWidth +
          'x' +
          fit.availHeight +
          ', so Chrome clamped the ' +
          fit.clampedAxes.join(' and ') +
          '; `sized: true` means the size features were accepted, not achieved'
        : '');
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
        : ' (requested ' +
          out.requested +
          '; ' +
          (fit && !fit.fitsDisplay
            ? 'CLAMPED on ' +
              fit.clampedAxes.join(' and ') +
              ' — it exceeds the usable display ' +
              fit.availWidth +
              'x' +
              fit.availHeight
            : 'Chrome adjusts height for window chrome') +
          ')');
  }
  return out;
}

/**
 * PRIMARY PATH (SLICC 6.169.0+). Open a DECORATED window at an exact FRAME size.
 *
 * `slicc.browser.openWindow` sizes the FRAME (chrome included) and preserves dpr.
 * The frame is the interesting number because CAPTURE RESOLUTION FOLLOWS FROM IT
 * -- it determines the video size. Measured on 6.169.0: requesting 1000x700 gave
 * outer 1000x700 with chrome 87 (a real title/URL bar; popup mode is 67) and
 * dpr 2 preserved. The popup path below fundamentally cannot do that.
 *
 * Needs NO user activation -- verified by opening a window from a jsh script,
 * which has none at all. So it is safe to `await`, unlike `window.open`.
 *
 * BUT the size still is not guaranteed: Chrome clamps to the usable display
 * silently. Caller must keep using checkDisplayFit() + the geometry probe and
 * prefer capture.width/height over any prediction.
 *
 * Returns the fallback's shape plus `targetId`, so the caller can skip URL
 * matching entirely.
 */
export async function openTargetWindowApi(url, w, h, api) {
  const B =
    api || (typeof slicc !== 'undefined' && slicc && slicc.browser) || null;
  if (!B || typeof B.openWindow !== 'function') {
    return { handle: null, openedVia: null, sized: false, unavailable: true };
  }
  const opts = { decorated: true };
  if (w && h) {
    opts.width = w | 0;
    opts.height = h | 0;
  }
  try {
    const tab = await B.openWindow(url, opts);
    const targetId = (tab && (tab.targetId || tab)) || null;
    if (!targetId) return { handle: null, openedVia: null, sized: false };
    return {
      handle: null,
      targetId: targetId,
      openedVia: 'slicc.browser.openWindow',
      sized: !!(w && h),
      decorated: true,
    };
  } catch (e) {
    return {
      handle: null,
      openedVia: null,
      sized: false,
      error: (e && e.message) || String(e),
    };
  }
}

/**
 * FALLBACK PATH (runtimes before 6.169.0). Attempt the sized popup.
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


/**
 * Resolve the popup's CDP target id by SET DIFFERENCE against a pre-open snapshot.
 *
 * MEASURED FAILURE that motivated this (take 2026-09-18T07-58-49-077Z):
 * `findTargetId` matched on URL, and `https://www.yahoo.de/` REDIRECTS to a
 * different host (`consent.yahoo.com/v2/collectConsent?...`, the GDPR
 * interstitial). Exact, host+path and hostname matching all missed, so targetId
 * was null -- and because it was null the foreground step and the CDP geometry
 * probe never ran at all (manifest: config.tabId null, targetWindow.targetId
 * null, foregroundedTab null, outerAfter/dpr/predictedFrame all null).
 *
 * Identity beats URL matching: whatever the popup navigates to, it is the target
 * that was NOT in the list a moment ago. That is redirect-proof and does not
 * depend on the URL at all.
 *
 * Second failure mode: racing the popup while it is still on `about:blank`, so
 * the caller must POLL (bounded) rather than ask once.
 *
 * @param {string[]} before target ids present before window.open
 * @param {string[]} after  target ids present now
 * @returns {string|null} the single new id, or null when it is ambiguous/absent
 */
export function newTargetId(before, after) {
  const prev = new Set(before || []);
  const added = (after || []).filter((id) => !prev.has(id));
  // Exactly one new target is the unambiguous case. If several appeared (the user
  // opened something else at the same instant) we do NOT guess -- the caller
  // falls back to URL matching, which is at least explainable.
  if (added.length === 1) return added[0];
  return null;
}

/** Ids only, for set-difference snapshots. */
export function tabIds(tabs) {
  return (tabs || []).map((t) => t.id).filter(Boolean);
}

/** A target id is useless until it has navigated off about:blank. */
export function isNavigated(tabs, id) {
  const t = (tabs || []).find((x) => x.id === id);
  if (!t) return false;
  const u = String(t.url || '');
  return !!u && u !== 'about:blank' && u !== 'about:newtab' && u !== 'chrome://newtab/';
}

/** Did the popup land somewhere other than what we asked for? */
export function landedElsewhere(tabs, id, requestedUrl) {
  const t = (tabs || []).find((x) => x.id === id);
  if (!t || !t.url) return null;
  let a, b;
  try { a = new URL(t.url); } catch (e) { return null; }
  try { b = new URL(requestedUrl); } catch (e) { return null; }
  if (a.hostname === b.hostname) return null;
  return { landed: t.url, requested: requestedUrl, landedHost: a.hostname, requestedHost: b.hostname };
}

/**
 * LAST-RESORT fallback: find the window by URL. Kept because it is explainable,
 * but it CANNOT survive a cross-host redirect -- see newTargetId above, which is
 * the primary strategy.
 */
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
