/**
 * goals — load a harness goals file and fill its run-time placeholders.
 *
 * A goals file (`skills/<skill>/evals/harness/goals.json`) lists browser goals that every arm
 * gets with the same wording:
 *
 *   { "last_updated": "YYYY-MM-DD",
 *     "goals": [ { "id", "url", "goal", "expect": [..], "expect_url": [..], "max_steps" } ] }
 *
 * Placeholders, filled just before each run so that a goal and its check always agree:
 *   - `{{date:+N:FMT}}`: today (UTC) plus N days, formatted with YYYY, MMMM, MMM, MM, M, DD, D
 *     (Flights needs dates that are always in the future);
 *   - `{{hn:top}}`: the id of the first story on the Hacker News front page, so a check can
 *     require that story's comments page rather than any.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** Format a UTC date with YYYY, MMMM, MMM, MM, M, DD, D (longest token first). */
export function formatDate(date, fmt) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return fmt.replace(/YYYY|MMMM|MMM|MM|M|DD|D/g, (t) => {
    switch (t) {
      case 'YYYY':
        return String(y);
      case 'MMMM':
        return MONTHS[m];
      case 'MMM':
        return MONTHS[m].slice(0, 3);
      case 'MM':
        return pad(m + 1);
      case 'M':
        return String(m + 1);
      case 'DD':
        return pad(d);
      default:
        return String(d);
    }
  });
}

/** The placeholders a text uses, e.g. ['date:+7:MMM D', 'hn:top']. */
export function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((m) => m[1].trim());
}

/**
 * Fill one text. ctx: { now: Date, hnTop: string|null }. An unknown placeholder, or `hn:top`
 * without a value, throws: a goal must never run with a check that silently means something else.
 */
export function fillText(text, ctx) {
  return String(text).replace(PLACEHOLDER, (_, body) => {
    const name = body.trim();
    const date = /^date:([+-]\d+):(.+)$/.exec(name);
    if (date) {
      const t = new Date(ctx.now.getTime());
      t.setUTCDate(t.getUTCDate() + Number(date[1]));
      return formatDate(t, date[2]);
    }
    if (name === 'hn:top') {
      if (!ctx.hnTop)
        throw new Error('{{hn:top}} needs the Hacker News front page, which was not fetched');
      return ctx.hnTop;
    }
    throw new Error(`unknown placeholder {{${name}}}`);
  });
}

/** A goal with every placeholder filled. */
export function fillGoal(goal, ctx) {
  return {
    ...goal,
    goal: fillText(goal.goal, ctx),
    expect: (goal.expect ?? []).map((t) => fillText(t, ctx)),
    expect_url: (goal.expect_url ?? []).map((t) => fillText(t, ctx)),
  };
}

/** Whether a goal needs `{{hn:top}}` (so the driver fetches the front page only when needed). */
export function needsHnTop(goal) {
  return [goal.goal, ...(goal.expect ?? []), ...(goal.expect_url ?? [])].some((t) =>
    placeholders(t).includes('hn:top')
  );
}

/** The first story id on the Hacker News front page HTML, or null. */
export function hnTopFromHtml(html) {
  const m = /<tr[^>]*class=['"][^'"]*\bathing\b[^'"]*['"][^>]*\bid=['"](\d+)['"]/.exec(
    String(html)
  );
  return m ? m[1] : null;
}

/** Problems with a goals document (empty when valid). */
export function validateGoals(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['goals file is not an object'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.last_updated ?? '')))
    errors.push('last_updated must be YYYY-MM-DD');
  if (!Array.isArray(doc.goals) || !doc.goals.length)
    return [...errors, 'goals must be a non-empty array'];
  const ids = new Set();
  for (const [i, g] of doc.goals.entries()) {
    const at = `goals[${i}]`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(String(g.id ?? '')))
      errors.push(`${at}: id must be lowercase a-z0-9-`);
    else if (ids.has(g.id)) errors.push(`${at}: duplicate id ${g.id}`);
    ids.add(g.id);
    if (!/^https?:\/\//.test(String(g.url ?? ''))) errors.push(`${at}: url must be http(s)`);
    if (!String(g.goal ?? '').trim()) errors.push(`${at}: goal is empty`);
    for (const k of ['expect', 'expect_url'])
      if (g[k] != null && !(Array.isArray(g[k]) && g[k].every((t) => typeof t === 'string' && t)))
        errors.push(`${at}: ${k} must be an array of non-empty strings`);
    if (!(g.expect?.length || g.expect_url?.length))
      errors.push(`${at}: needs expect or expect_url (a check)`);
    if (g.max_steps != null && !(Number.isInteger(g.max_steps) && g.max_steps > 0))
      errors.push(`${at}: max_steps must be a positive integer`);
    for (const t of [g.goal, ...(g.expect ?? []), ...(g.expect_url ?? [])])
      for (const p of placeholders(t))
        if (!/^date:[+-]\d+:.+$/.test(p) && p !== 'hn:top')
          errors.push(`${at}: unknown placeholder {{${p}}}`);
  }
  return errors;
}

/** POSIX single-quote one shell word (the leader's shell is just-bash). */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
