// playwright-cli tab helpers.

/**
 * Parse `playwright-cli tab-list`. Each line is `[TARGETID] url "title"`.
 *
 * The title is the FINAL `"..."` run and the emitter always puts a space before
 * its opening quote, so anchoring on ` "` (rather than on any quote, e.g.
 * lastIndexOf('"')) keeps a URL that itself contains a quote from being cut in
 * the wrong place. Verified against 63 live tabs plus adversarial input.
 */
export function parseTabList(stdout) {
  const out = [];
  for (let line of (stdout || '').split('\n')) {
    line = line.trim();
    if (!line) continue;
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1];
    const rest = m[2];
    let url = rest;
    let title = '';
    const tm = /^(.*?)\s+"([\s\S]*)"\s*$/.exec(rest);
    if (tm) {
      url = tm[1].trim();
      title = tm[2];
    }
    out.push({ id, url, title });
  }
  return out;
}

/**
 * Shell command that foregrounds a tab BY TARGET ID.
 *
 * MEASURED: `tab-select` takes a 1-BASED LINE INDEX, not a target id, and
 * `tab-list` does NOT print an index despite --help claiming it does. So the
 * index has to be derived by counting lines -- and it SHIFTS whenever tabs open
 * or close between loadTabs() and the recording start, which is why this is
 * resolved at start time in ONE shell invocation (no race between the two
 * commands) rather than reusing an index captured earlier.
 *
 * `tab-select` echoes `Selected tab N [targetId: ...]`, so the caller can
 * confirm it foregrounded the RIGHT tab instead of assuming.
 */
export function foregroundTabCmd(targetId) {
  const id = String(targetId).replace(/[^A-Za-z0-9]/g, '');
  return (
    'IDX=$(playwright-cli tab-list | grep -n ' +
    id +
    " | cut -d: -f1); " +
    'if [ -n "$IDX" ]; then playwright-cli tab-select "$IDX"; else echo "target ' +
    id +
    ' not in tab-list" >&2; exit 3; fi'
  );
}

/**
 * Did the tab-select output actually foreground the tab we asked for?
 * Confirms against the echoed target id rather than trusting exit code alone.
 */
export function confirmForegrounded(stdout, targetId) {
  const s = String(stdout || '');
  return s.toUpperCase().indexOf(String(targetId).toUpperCase()) !== -1;
}

/**
 * Shell command that reads back what a resize ACTUALLY did.
 *
 * MEASURED (`playwright-cli resize 1280 800` on a live tab):
 *   innerWidth/Height  1200x714 -> 1280x800   CHANGED (the viewport)
 *   outerWidth/Height  1200x801 -> 1200x801   UNCHANGED (the OS window)
 *   devicePixelRatio   2        -> 1          CHANGED, as a side effect
 *
 * `resize` is a CDP device-metrics override -- "Resize viewport to width x
 * height" is literally all it does. It cannot move the OS window, so for a
 * `window` or `monitor` capture (where frames come from the OS surface) it
 * cannot change the recording's geometry at all, AND it halves the page's
 * render resolution while the window is still captured at the 2x backing
 * scale -- making the recording look WORSE than not resizing. The dpr override
 * is also sticky: resizing back did not restore dpr 2.
 *
 * `resize exit 0` is therefore a FALSE SUCCESS. An exit code is not evidence of
 * effect (third time this class of bug hit this project). So: read the metrics
 * back and report what really happened.
 */
export function readViewportCmd(targetId) {
  const id = String(targetId).replace(/[^A-Za-z0-9]/g, '');
  return (
    "playwright-cli eval \"JSON.stringify({iw:innerWidth,ih:innerHeight,ow:outerWidth,oh:outerHeight,dpr:devicePixelRatio,sw:screen.width,sh:screen.height})\" --tab=" +
    id
  );
}

/** Tolerant parse of the read-back payload (the CLI may wrap or quote it). */
export function parseViewport(stdout) {
  const s = String(stdout || '');
  const m = s.match(/\{[^{}]*"iw"[\s\S]*?\}/);
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
 * Build the honest verdict for the manifest + log.
 *
 * `effectiveForCapture` is true ONLY when the captured surface is the tab
 * itself (`displaySurface: 'browser'`), because that is the only case where the
 * viewport IS the frame.
 */
export function describeResize(requested, before, after, displaySurface) {
  const r = {
    requested: requested || null,
    viewportAfter: after ? after.iw + 'x' + after.ih : null,
    outerAfter: after ? after.ow + 'x' + after.oh : null,
    dprBefore: before ? before.dpr : null,
    dprAfter: after ? after.dpr : null,
    effectiveForCapture: displaySurface === 'browser',
  };
  const viewportChanged = !!(before && after && (before.iw !== after.iw || before.ih !== after.ih));
  const outerChanged = !!(before && after && (before.ow !== after.ow || before.oh !== after.oh));
  r.viewportChanged = viewportChanged;
  r.osWindowChanged = outerChanged;
  if (!after) {
    r.note = 'could not read the viewport back — effect unverified';
  } else if (viewportChanged && !outerChanged && displaySurface !== 'browser') {
    r.note =
      'viewport now ' +
      after.iw +
      'x' +
      after.ih +
      ', OS window unchanged at ' +
      after.ow +
      'x' +
      after.oh +
      ' — a ' +
      (displaySurface || 'window/monitor') +
      ' capture frames the OS window, so this does NOT change the recording size' +
      (before && after.dpr < before.dpr
        ? '; devicePixelRatio dropped ' + before.dpr + '\u2192' + after.dpr + ', which LOWERS captured quality'
        : '');
  } else if (displaySurface === 'browser') {
    r.note = 'tab surface captured, so the viewport IS the frame — resize applies';
  } else {
    r.note = 'viewport unchanged — resize had no measurable effect';
  }
  return r;
}
