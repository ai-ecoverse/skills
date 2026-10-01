/**
 * judge — one bar for every arm: meep-meep's own success check (`checkExpect` from
 * skills/meep-meep/scripts/page.js, loaded from the reference checkout) applied to the final
 * page. A goal passes when ANY tab the arm left open satisfies it: every `expect` text is in the
 * raw snapshot (a number may not run on into a longer one) and the URL contains every
 * `expect_url`. The arms' own verdicts are recorded beside it, never used.
 */
import { createRequire } from 'node:module';

/** Load page.js (CommonJS) from `pagePath`; it needs no SLICC globals. */
export function loadChecker(pagePath) {
  const page = createRequire(import.meta.url)(pagePath);
  if (typeof page.checkExpect !== 'function' || typeof page.parseSnapshot !== 'function')
    throw new Error(`${pagePath} does not export checkExpect and parseSnapshot`);
  return page;
}

/** Whether one raw `playwright-cli snapshot` output satisfies the goal's check. */
export function passes(page, raw, goal) {
  const shot = page.parseSnapshot(String(raw));
  return Boolean(
    page.checkExpect({ raw: String(raw), shot }, goal.expect ?? [], goal.expect_url ?? [])
  );
}

/** Tab ids from `playwright-cli tab-list` output (lines carrying `[targetId: X]` or `[X]`). */
export function tabIds(listing) {
  const ids = [];
  for (const line of String(listing).split('\n')) {
    const m =
      /targetId:\s*([A-Za-z0-9]+)/.exec(line) ??
      /^\s*(?:\d+\.\s*)?\[([A-Za-z0-9]{4,})\]/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}
