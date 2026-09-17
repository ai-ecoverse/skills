// Duration slider scale.
//
// A linear 0..3600 slider wastes ~97% of its travel on durations nobody picks:
// the useful demo range is 10-120s. So the slider is an INDEX into a stepped
// ladder -- fine (5s) where it matters, coarse (2min) at the top. The DISPLAYED
// and STORED values are always the ladder's real seconds; only the slider
// position is remapped.
//
// index 0            => 0     (single screenshot)
// final index        => null  (infinity, no auto-stop)

export const DURATION_LADDER = (() => {
  const v = [0];
  for (let s = 5; s <= 120; s += 5) v.push(s); // 5..120 step 5      (24)
  for (let s = 150; s <= 600; s += 30) v.push(s); // 2m30..10m step 30 (16)
  for (let s = 720; s <= 3600; s += 120) v.push(s); // 12m..60m step 2m (25)
  return v;
})();

// One past the end. The #maxDur slider's `max` attribute MUST equal this, or the
// top notch silently stops short of infinity (shipped `61` vs 66 once, which
// capped at 3480s).
export const INFINITY_INDEX = DURATION_LADDER.length;

/** Seconds for a slider index: 0, a positive number, or null = infinity. */
export function durationForIndex(i) {
  const idx = Math.max(0, Math.min(INFINITY_INDEX, i | 0));
  return idx === INFINITY_INDEX ? null : DURATION_LADDER[idx];
}

export function formatDuration(sec) {
  if (sec === null) return '\u221e';
  if (sec === 0) return '0s';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const out = [];
  if (h) out.push(h + 'h');
  if (m) out.push(m + 'm');
  if (s) out.push(s + 's');
  return out.join(' ');
}
