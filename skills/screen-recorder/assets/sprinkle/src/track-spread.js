// Track-duration spread.
//
// MEASURED (take 2026-09-18T07-58-49-077Z): screen 19.116s vs mic 19.919s -- an
// 803ms gap present AT CAPTURE TIME, with startOffsetMs ~0 for both (0 and 0.26).
// The tracks START together; the VIDEO track simply ENDS earlier, because
// MediaRecorder stops each recorder independently and the video encoder's final
// partial GOP is dropped.
//
// This is SEPARATE from the `-c copy` keyframe-snap desync already documented in
// notes[]: it survives trimming unchanged (14.116 vs 14.919 after a 5s trim), so
// an accurate seek does not help. Anything muxing these tracks must pad or trim
// to the SHORTER stream rather than assume equal length -- `-shortest` is the
// ffmpeg spelling.

/**
 * Max-minus-min of the per-track container durations, in ms.
 * Returns null when fewer than two tracks have a usable duration (nothing to
 * compare) rather than a misleading 0.
 */
export function trackDurationSpreadMs(tracks) {
  const ds = (tracks || [])
    .map((t) => (t && typeof t.containerDurationSec === 'number' ? t.containerDurationSec : null))
    .filter((d) => d != null && isFinite(d) && d > 0);
  if (ds.length < 2) return null;
  return Math.round((Math.max.apply(null, ds) - Math.min.apply(null, ds)) * 1000);
}

/** The shortest track — what a muxer should align to. */
export function shortestTrack(tracks) {
  let best = null;
  for (const t of tracks || []) {
    const d = t && typeof t.containerDurationSec === 'number' ? t.containerDurationSec : null;
    if (d == null || !isFinite(d) || d <= 0) continue;
    if (!best || d < best.containerDurationSec) best = t;
  }
  return best ? { name: best.name, file: best.file, containerDurationSec: best.containerDurationSec } : null;
}

export const TRACK_SPREAD_NOTE =
  'Tracks do NOT end together. trackDurationSpreadMs is the max-minus-min of the per-track ' +
  'container durations and is INHERENT to capture, not a trim artefact: MediaRecorder stops each ' +
  'recorder independently and the video encoder drops its final partial GOP, so the video track ' +
  'ends first (measured 19.116s video vs 19.919s audio = 803ms, with startOffsetMs ~0 for both, ' +
  'and the gap survives trimming unchanged). Anything muxing these tracks must pad or trim to the ' +
  'SHORTER stream (ffmpeg: -shortest) rather than assume equal length. This is separate from the ' +
  '-c copy keyframe-snap desync noted above.';
