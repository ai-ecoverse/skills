/**
 * placeholders — fill a goal's run-time placeholders, and validate a goals file.
 *
 * Built in: `{{date:+N:FMT}}`, today (UTC) plus N days, formatted with YYYY, MMMM, MMM, MM, M,
 * DD, D. Any other `{{name}}` belongs to the skill: its harness adapter resolves it
 * (`placeholder(name)` in evals/harness/harness.mjs), just before the run. A placeholder nobody
 * resolves fails the run rather than running a check that silently means something else.
 */
import { hasRubric, validateRubric } from './rubric.mjs';

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
const DATE = /^date:([+-]\d+):(.+)$/;

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

/** The placeholder names a text uses, e.g. ['date:+7:MMM D', 'hn:top']. */
export function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((m) => m[1].trim());
}

/** The non-date placeholder names a goal needs from its skill's adapter. */
export function customPlaceholders(goal) {
  const names = [goal.goal, ...(goal.expect ?? []), ...(goal.expect_url ?? [])].flatMap(
    placeholders
  );
  return [...new Set(names.filter((n) => !DATE.test(n)))];
}

/**
 * Values for a goal's non-date placeholders, from `resolve(name)` (the adapter's `placeholder`).
 * A missing resolver, or a value that is null, undefined, empty or not a string or number,
 * refuses the goal: String(null) would otherwise run it with "null" in its goal and check.
 */
export async function resolvePlaceholders(goal, resolve) {
  const values = {};
  for (const name of customPlaceholders(goal)) {
    if (typeof resolve !== 'function')
      throw new Error(`goal ${goal.id} uses {{${name}}} but the adapter resolves no placeholders`);
    const value = await resolve(name);
    if (!['string', 'number'].includes(typeof value) || String(value) === '')
      throw new Error(`goal ${goal.id}: {{${name}}} resolved to no value (${value})`);
    values[name] = String(value);
  }
  return values;
}

/** Fill one text: dates relative to `now`, other names from `values` (must all be present). */
export function fillText(text, { now, values = {} }) {
  return String(text).replace(PLACEHOLDER, (_, body) => {
    const name = body.trim();
    const date = DATE.exec(name);
    if (date) {
      const t = new Date(now.getTime());
      t.setUTCDate(t.getUTCDate() + Number(date[1]));
      return formatDate(t, date[2]);
    }
    if (typeof values[name] !== 'string' || !values[name])
      throw new Error(`placeholder {{${name}}} has no value`);
    return values[name];
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
    errors.push(...validateRubric(g, at));
    if (g.suite != null && !(typeof g.suite === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(g.suite)))
      errors.push(`${at}: suite must be lowercase a-z0-9-`);
    // A goal needs a deterministic check, a rubric, or both. Rubric-only goals (play as far as
    // you get) have no pass/fail; they are scored by credit alone.
    if (!(g.expect?.length || g.expect_url?.length || hasRubric(g)))
      errors.push(`${at}: needs expect or expect_url (a check), or a rubric`);
    if (g.max_steps != null && !(Number.isInteger(g.max_steps) && g.max_steps > 0))
      errors.push(`${at}: max_steps must be a positive integer`);
  }
  return errors;
}

/** POSIX single-quote one shell word (the leader's shell is just-bash). */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Tab ids from `playwright-cli tab-list` output (`[<targetId>] <url> "<title>"`). */
export function tabIds(listing) {
  const ids = [];
  for (const line of String(listing).split('\n')) {
    const m = /^\s*(?:\d+\.\s*)?\[([A-Za-z0-9]{4,})\]/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * Goals in the selected suites. A goal without `suite` is in `default`, the suite a pull request
 * runs; longer ones (games with big step budgets) name their own and run on dispatch.
 */
export function selectSuites(goals, suites = ['default']) {
  const want = new Set(suites);
  return goals.filter((g) => want.has(g.suite ?? 'default'));
}

/** `HARNESS_SUITES`-style text → suite names (empty → default). */
export function parseSuites(text) {
  const names = String(text ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const n of names)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) throw new Error(`bad suite name ${JSON.stringify(n)}`);
  return names.length ? names : ['default'];
}

/** Whether a goal has a deterministic check (else `pass` is null and only the rubric scores). */
export const hasCheck = (goal) => Boolean(goal.expect?.length || goal.expect_url?.length);
