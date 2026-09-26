/**
 * Working-day arithmetic for the FETCHER (CommonJS, because the fetcher uses require), lifted verbatim from the panel's
 * inline copy (the panel is one HTML file, so it cannot import this). Phase 7b
 * needs it to skip agent calls for records the panel will hide, and the rule has
 * to be the SAME rule. It is a COPY, so the two can drift: an edit to one that
 * is not mirrored in the other silently changes which records get a generated
 * status. No shipped test checks the two against each other yet; change both
 * together.
 */
const WORKING_DAY_MS = 864e5;

function workingMsBetween(from, to) {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  let total = 0;
  let cursor = a;
  while (cursor < b) {
    const d = new Date(cursor);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const segEnd = Math.min(b, dayStart + WORKING_DAY_MS);
    const dow = new Date(dayStart).getUTCDay(); // 0 Sun ... 6 Sat
    if (dow !== 0 && dow !== 6) total += segEnd - cursor;
    cursor = segEnd;
  }
  return total;
}

function workingDaysSince(iso, now) {
  return workingMsBetween(iso, now) / WORKING_DAY_MS;
}

module.exports = { WORKING_DAY_MS, workingMsBetween, workingDaysSince };
