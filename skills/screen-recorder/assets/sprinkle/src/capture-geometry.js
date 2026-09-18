// True frame geometry of a display-capture stream.
//
// MEASURED DEFECT (30s take, /workspace/captures/2026-09-17T15-47-32-388Z):
// `track.getSettings()` reported **2940x1912** while the encoded frames were
// constant **2848x750** (sampled at t=0.5/2/4.5/6/28s -- not a mid-stream
// change). 2940x1912 / 2 = 1470x956, a standard MacBook Air scaled screen
// (screen.width/height -- NOT the usable area, which is availHeight 841; 956 is
// the right number HERE because getSettings() reported the whole display);
// 2848x750 / 2 = 1424x375, the Chrome window. So for
// `displaySurface: "window"` getSettings() described the DISPLAY, not the
// captured surface.
//
// That is not merely a wrong number: capture{} exists to be the ONE
// authoritative record of frame geometry (forcedTabSize provably cannot
// describe the frame -- a 1280x800 requested viewport produced a ~1424x375
// window). A consumer trusting 2940x1912 sizes a 3.8:1 video into a 1.54:1
// canvas.
//
// So the authoritative source is the DECODED STREAM: attach the stream to an
// off-screen <video> and read videoWidth/videoHeight after `loadedmetadata`.
// The getSettings() numbers are KEPT alongside, never overwritten, so the
// discrepancy stays visible instead of being silently papered over.
//
// DO NOT "simplify" this back to getSettings().

/**
 * Resolve the true frame geometry for a display stream.
 *
 * Never throws, never blocks the take: `loadedmetadata` can be slow or never
 * fire, so it is bounded by withTimeout and falls back to track settings.
 *
 * @param {MediaStream} stream    the getDisplayMedia stream
 * @param {MediaStreamTrack} track the stream's video track
 * @param {Function} withTimeout  (promise, ms, label) => promise
 * @param {number} timeoutMs      metadata deadline (default 2000)
 * @returns {Promise<object>} capture{} for the manifest
 */
export async function probeCaptureGeometry(stream, track, withTimeout, timeoutMs) {
  const settings = (track && track.getSettings && track.getSettings()) || {};
  const out = {
    width: settings.width || null,
    height: settings.height || null,
    frameRate: settings.frameRate || null,
    settingsWidth: settings.width || null,
    settingsHeight: settings.height || null,
    geometrySource: 'track-settings',
  };

  let video = null;
  try {
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    const meta = new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('video element error'));
    });
    video.srcObject = stream;
    await withTimeout(meta, timeoutMs == null ? 2000 : timeoutMs, 'capture-geometry:loadedmetadata');
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      out.width = video.videoWidth;
      out.height = video.videoHeight;
      out.geometrySource = 'video-metadata';
    }
  } catch (err) {
    // Timed out, errored, or no DOM: keep the settings-derived fallback and say
    // so via geometrySource. The recording is never delayed or failed for this.
    out.geometryError = (err && err.message) || String(err);
  } finally {
    if (video) {
      try {
        video.srcObject = null; // release the element; the TRACK stays live
      } catch (e) {
        /* ignore */
      }
    }
  }
  return out;
}

/**
 * A window capture can be resized mid-recording. Recording the changes is
 * cheap (one event listener) and lets a consumer detect a non-constant frame
 * size instead of assuming the start geometry held for the whole take.
 * Returns a getter for the accumulated changes.
 */
export function watchCaptureResize(track, originMs, capture) {
  const changes = [];
  if (!track || !track.addEventListener) return () => changes;
  try {
    track.addEventListener('resize', () => {
      try {
        const s = (track.getSettings && track.getSettings()) || {};
        changes.push({
          atMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - originMs),
          // Settings are the only thing available on the event; they are
          // unreliable for absolute geometry (see above) but a CHANGE in them
          // still signals that the surface was resized.
          settingsWidth: s.width || null,
          settingsHeight: s.height || null,
        });
      } catch (e) {
        /* never let a diagnostic listener break a recording */
      }
    });
  } catch (e) {
    /* no resize event support: changes stays empty */
  }
  return () => changes;
}
