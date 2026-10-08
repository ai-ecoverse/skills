/**
 * The skill-evals task-set format: validation, the host conversion, scoring and lift.
 *
 * One format for both harnesses. A set IS slicc's BU Bench V2 envelope (so a host set goes to
 * `packages/bench/scripts/run.mjs --set` as it is), plus additive fields the runner ignores:
 * `skill` on the envelope, `setup` / `teardown` on a task. See CLAUDE.md "Skill evals".
 *
 * Dependency-free ES module with no I/O: it runs in plain Node 22 (GitHub Actions), in SLICC's
 * node/.jsh realm, and in a `tst` test realm. Scoring reproduces slicc's `judge.mjs` `score()`
 * and `format.mjs` `outcome()` at commit 2fc68c083459c3511e4e980c177b910c5b356a89; lift
 * reproduces `results.mjs` `pairedDelta()` at the same commit.
 */

export const HARNESSES = ['host', 'slicc'];
export const STATUSES = ['met', 'violated', 'not_assessable'];

/** An item id as the runner requires it (`format.mjs` ITEM_ID). */
export const ITEM_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ID = /^[A-Za-z0-9._+-]+$/;
const SOURCE_FACTS = /^## Source facts \(verified (\d{4}-\d{2}-\d{2})\)\s*$/m;
const ITEM_LINE = /^([A-Za-z][A-Za-z0-9_]*) \u2014 \S/;
const TASK_KEYS = new Set([
  'id',
  'title',
  'summary',
  'canary',
  'task',
  'rubric',
  'weights',
  'slicc',
  'setup',
  'teardown',
]);
const DIGEST_KEYS = ['task_sha', 'rubric_sha', 'weights_sha'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';

function isDate(text) {
  if (typeof text !== 'string' || !DATE.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * The rubric's item lines: the `## Items` section, up to the next `## ` heading. Every non-empty
 * line there must read `ID — description` (an em dash). Returns `{ ids, bad }`.
 */
export function rubricItems(rubric) {
  const lines = String(rubric ?? '').split('\n');
  const start = lines.findIndex((l) => /^## Items\s*$/.test(l));
  if (start < 0) return { ids: [], bad: [], missing: true };
  const ids = [];
  const bad = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (!line.trim()) continue;
    const m = ITEM_LINE.exec(line);
    if (m) ids.push(m[1]);
    else bad.push(line);
  }
  return { ids, bad, missing: false };
}

// The runner's own rules (format.mjs validateTask / validateSliccExtension), same wording.
function runnerTaskErrors(task, where) {
  const errors = [];
  if (typeof task.id !== 'string' || !task.id.trim()) errors.push('id is missing');
  if (!isText(task.task)) errors.push(`${where}: task text is missing`);
  if (!isText(task.rubric)) errors.push(`${where}: rubric is missing`);
  const weights = task.weights;
  if (!isObject(weights)) {
    errors.push(`${where}: weights must be an object of item id → integer`);
    return errors;
  }
  const ids = Object.keys(weights);
  if (ids.length === 0) errors.push(`${where}: weights has no items`);
  else {
    let sum = 0;
    for (const id of ids) {
      const w = weights[id];
      if (!ITEM_ID.test(id))
        errors.push(`${where}: item id ${JSON.stringify(id)} is not an identifier`);
      if (!Number.isInteger(w) || w <= 0)
        errors.push(`${where}: weight of ${id} must be a positive integer`);
      else sum += w;
      if (typeof task.rubric === 'string' && !task.rubric.includes(id))
        errors.push(`${where}: rubric never names item ${id}`);
    }
    if (sum !== 100) errors.push(`${where}: weights sum to ${sum}, not 100`);
  }
  if (task.slicc !== undefined) errors.push(...sliccErrors(task.slicc, where));
  return errors;
}

function sliccErrors(ext, where) {
  if (!isObject(ext)) return [`${where}: slicc must be an object`];
  const errors = [];
  const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (ext.website !== undefined && typeof ext.website !== 'string')
    errors.push(`${where}: slicc.website must be a string`);
  if (ext.skills !== undefined && !strings(ext.skills))
    errors.push(`${where}: slicc.skills must be a list of skill names`);
  if (ext.requires !== undefined && !strings(ext.requires))
    errors.push(`${where}: slicc.requires must be a list of strings`);
  if (
    ext.timeoutSeconds !== undefined &&
    !(Number.isInteger(ext.timeoutSeconds) && ext.timeoutSeconds > 0)
  )
    errors.push(`${where}: slicc.timeoutSeconds must be a positive integer`);
  if (ext.files !== undefined) {
    const ok =
      Array.isArray(ext.files) &&
      ext.files.every(
        (f) => f && typeof f.from === 'string' && typeof f.to === 'string' && f.to.startsWith('/')
      );
    if (!ok) errors.push(`${where}: slicc.files must be [{ from, to }] with an absolute VFS "to"`);
    else {
      // Ours: `from` is relative to tasks.json and stays inside the eval dir.
      for (const f of ext.files) {
        if (f.from.startsWith('/') || f.from.split('/').includes('..'))
          errors.push(
            `${where}: slicc.files from ${JSON.stringify(f.from)} must be relative, without ".."`
          );
      }
    }
  }
  return errors;
}

function stepErrors(steps, field, where, harness) {
  if (steps === undefined) return [];
  if (harness === 'host')
    return [`${where}: a host task has no ${field} (the runner cannot execute it)`];
  if (!Array.isArray(steps)) return [`${where}: ${field} must be a list of steps`];
  const errors = [];
  steps.forEach((step, i) => {
    const at = `${where}: ${field}[${i}]`;
    if (!isObject(step)) {
      errors.push(`${at} is not an object`);
      return;
    }
    const kinds = ['run', 'ask'].filter((k) => k in step);
    if (kinds.length !== 1) errors.push(`${at} must have exactly one of run or ask`);
    for (const k of kinds)
      if (!isText(step[k])) errors.push(`${at}.${k} must be a non-empty string`);
    if ('check' in step) {
      if (!('ask' in step)) errors.push(`${at}.check is only allowed on an ask step`);
      if (!isText(step.check)) errors.push(`${at}.check must be a non-empty string`);
    }
    for (const k of Object.keys(step))
      if (!['run', 'ask', 'check'].includes(k)) errors.push(`${at} has unknown key ${k}`);
  });
  return errors;
}

function ecoverseTaskErrors(task, where, { harness, skill }) {
  const errors = [];
  for (const k of Object.keys(task)) {
    if (DIGEST_KEYS.includes(k)) errors.push(`${where}: omit ${k}; the runner computes digests`);
    else if (!TASK_KEYS.has(k)) errors.push(`${where}: unknown task key ${k}`);
  }
  if (typeof task.id === 'string' && task.id) {
    if (!SAFE_ID.test(task.id)) errors.push(`${where}: id must use only [A-Za-z0-9._+-]`);
    if (skill && !task.id.startsWith(`${skill}-`))
      errors.push(`${where}: id must start with ${skill}-`);
  }
  if (task.title !== undefined && !isText(task.title))
    errors.push(`${where}: title must be a non-empty string`);
  if (typeof task.rubric === 'string') {
    const facts = SOURCE_FACTS.exec(task.rubric);
    if (!facts)
      errors.push(`${where}: rubric needs a "## Source facts (verified YYYY-MM-DD)" heading`);
    else if (!isDate(facts[1]))
      errors.push(`${where}: Source facts date ${facts[1]} is not a date`);
    const items = rubricItems(task.rubric);
    if (items.missing) errors.push(`${where}: rubric needs a "## Items" section`);
    for (const line of items.bad)
      errors.push(`${where}: Items line is not "ID — description": ${line.slice(0, 60)}`);
    const weighted = isObject(task.weights) ? Object.keys(task.weights) : [];
    for (const id of weighted)
      if (!items.missing && !items.ids.includes(id))
        errors.push(`${where}: Items never defines ${id}`);
    for (const id of items.ids)
      if (!weighted.includes(id)) errors.push(`${where}: Items defines ${id}, which has no weight`);
    const dup = items.ids.filter((id, i) => items.ids.indexOf(id) !== i);
    for (const id of new Set(dup)) errors.push(`${where}: Items defines ${id} twice`);
  }
  if (harness === 'host' && isObject(task.slicc) && task.slicc.requires !== undefined)
    errors.push(`${where}: a host task has no slicc.requires (a CI leader has no logins)`);
  errors.push(...stepErrors(task.setup, 'setup', where, harness));
  errors.push(...stepErrors(task.teardown, 'teardown', where, harness));
  return errors;
}

/**
 * Every rule of the format: the runner's (id, task, rubric, integer weights > 0 summing to 100,
 * each weight named in the rubric, unique ids, slicc extension shape), the ecoverse ones
 * (`benchmark` is `ecoverse-<skill>`, `skill` is the folder name, dated Source facts, an Items
 * section that defines exactly the weighted ids, setup/teardown step shape) and the host-only
 * ones (no setup, teardown, ask or requires). Returns `{ ok, errors }`.
 */
export function validateSet(set, { harness, skill } = {}) {
  const errors = [];
  if (!HARNESSES.includes(harness)) errors.push(`harness must be one of ${HARNESSES.join(', ')}`);
  if (!isObject(set) || !Array.isArray(set.tasks)) {
    errors.push('a task set is { benchmark, skill, tasks: [...] }');
    return { ok: false, errors };
  }
  const name = skill ?? set.skill;
  if (!isText(name)) errors.push('skill is missing (pass { skill } or set "skill")');
  if (typeof set.benchmark !== 'string' || !set.benchmark.trim())
    errors.push('benchmark name is missing');
  else if (isText(name) && set.benchmark !== `ecoverse-${name}`)
    errors.push(`benchmark must be ecoverse-${name}, not ${set.benchmark}`);
  if (set.skill !== name)
    errors.push(
      `skill must be ${JSON.stringify(name)} (the folder name), not ${JSON.stringify(set.skill)}`
    );
  if (!isDate(set.last_updated)) errors.push('last_updated must be a YYYY-MM-DD date');
  if (set.tasks.length === 0) errors.push('tasks is empty');
  const seen = new Set();
  for (const task of set.tasks) {
    if (!isObject(task)) {
      errors.push('task is not an object');
      continue;
    }
    const where = typeof task.id === 'string' && task.id ? task.id : '(no id)';
    errors.push(...runnerTaskErrors(task, where));
    errors.push(...ecoverseTaskErrors(task, where, { harness, skill: name }));
    if (typeof task.id === 'string') {
      if (seen.has(task.id)) errors.push(`duplicate task id ${task.id}`);
      seen.add(task.id);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The object for slicc's `run.mjs --set`: the same envelope, `setup`/`teardown` removed. */
export function toRunnerSet(set) {
  const copy = JSON.parse(JSON.stringify(set));
  for (const task of copy.tasks ?? []) {
    delete task.setup;
    delete task.teardown;
  }
  return copy;
}

/** Problems with a judge's findings against the weighted ids (as `judge.mjs` validateJudgement). */
export function validateFindings(findings, weights) {
  if (!Array.isArray(findings)) return ['findings is not a list'];
  const ids = Object.keys(weights ?? {});
  const errors = [];
  for (const f of findings) {
    if (!ids.includes(f?.item)) errors.push(`finding for unknown item ${JSON.stringify(f?.item)}`);
    if (!STATUSES.includes(f?.status))
      errors.push(`finding ${f?.item} has status ${JSON.stringify(f?.status)}`);
  }
  return errors;
}

/**
 * Findings → score, the runner's arithmetic: earned weight of `met` items / total weight; a
 * missing item and `not_assessable` earn nothing; duplicate findings for one item resolve
 * worst-wins (violated > not_assessable > met); `rewardHacking` zeroes the run.
 */
export function score(findings, weights, { rewardHacking = false } = {}) {
  const severity = { met: 0, not_assessable: 1, violated: 2 };
  const statuses = {};
  for (const f of findings ?? []) {
    if (!(f.item in statuses) || severity[f.status] > severity[statuses[f.item]])
      statuses[f.item] = f.status;
  }
  const ids = Object.keys(weights);
  const total = ids.reduce((a, id) => a + weights[id], 0);
  const earned = ids.reduce((a, id) => a + (statuses[id] === 'met' ? weights[id] : 0), 0);
  const rh = Boolean(rewardHacking);
  return {
    score: rh ? 0 : earned / total,
    verdict: rh ? false : ids.every((id) => statuses[id] === 'met'),
    earned_weight: earned,
    rh_zeroed: rh,
    missing_items: ids.filter((id) => !(id in statuses)),
    statuses,
  };
}

/** Score → outcome, as `format.mjs` outcome(): 1 is pass, above 0 partial, else fail. */
export function outcome(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'fail';
  if (value >= 1) return 'pass';
  if (value > 0) return 'partial';
  return 'fail';
}

// Pairing rules of results.mjs: scores pair judged runs; time and cost pair finished runs.
const ran = (r) => !r.error || r.error_stage === 'judge';
const judged = (r) => !r.error && typeof r.score === 'number' && !Number.isNaN(r.score);
const metric = (r, field) => (typeof r.metrics?.[field] === 'number' ? r.metrics[field] : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** A record's condition: `condition` (slicc harness) or the runner's `config.skills` (host). */
export function conditionOf(r) {
  return r.condition ?? r.config?.skills ?? null;
}

/** `without` / `none` is the baseline; `with` / `none+<skill>` the treatment. */
export function isBaseline(c) {
  return c === 'without' || c === 'none';
}
export function isTreatment(c) {
  return c === 'with' || (typeof c === 'string' && c.startsWith('none+'));
}

function paired(from, to, field) {
  const keep = field === 'score' ? judged : ran;
  const value = (r) => (field === 'score' ? r.score : metric(r, field));
  const index = (rs) => new Map(rs.filter(keep).map((r) => [`${r.task_id}|${r.repeat}`, r]));
  const b = index(to);
  const pairs = [];
  for (const [k, ra] of index(from)) {
    const rb = b.get(k);
    if (rb && value(ra) !== null && value(rb) !== null) pairs.push([value(ra), value(rb)]);
  }
  // Rounded as results.mjs delta(): 3 decimals for duration, 4 otherwise; pct as relative().
  const d = field === 'duration' ? 3 : 4;
  const base = mean(pairs.map(([x]) => x));
  const change = mean(pairs.map(([x, y]) => y - x));
  return {
    n: pairs.length,
    from: round(base, d),
    to: round(mean(pairs.map(([, y]) => y)), d),
    delta: round(change, d),
    pct: base ? round(change / base) : null,
    ...(field === 'score'
      ? { from_scores: pairs.map(([x]) => x), to_scores: pairs.map(([, y]) => y) }
      : {}),
  };
}

/**
 * With minus without, paired by task and repeat (as `results.mjs` pairedDelta), per task and per
 * skill (benchmark) and model, for score, duration and cost, each with its own n. Records from
 * more than one harness are refused: the two harnesses are never merged. `conclusive` is false
 * unless every task has at least two paired repeats: one repeat is never a finding.
 */
export function lift(records) {
  const harnesses = [...new Set(records.map((r) => r.harness ?? 'unstamped'))];
  if (harnesses.length > 1)
    throw new Error(
      `records mix harnesses (${harnesses.join(', ')}); report each harness on its own`
    );
  // As results.mjs canonicalRecords: a run that repeats a (config, task, repeat) moves to the
  // next free repeat, in input order, so pairing keeps every run.
  const used = new Map();
  const renumbered = records.map((r) => {
    const key = `${r.benchmark}|${r.config?.model ?? ''}|${conditionOf(r)}|${r.task_id}`;
    const taken = used.get(key) ?? new Set();
    used.set(key, taken);
    let repeat = r.repeat ?? 1;
    while (taken.has(repeat)) repeat += 1;
    taken.add(repeat);
    return repeat === r.repeat ? r : { ...r, repeat };
  });
  const groups = new Map();
  for (const r of renumbered) {
    const key = `${r.benchmark}|${r.config?.model ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const skills = [];
  for (const rs of groups.values()) {
    const conds = [...new Set(rs.map(conditionOf))];
    const base = conds.find(isBaseline);
    const treat = conds.find(isTreatment);
    if (!base || !treat) continue;
    const from = rs.filter((r) => conditionOf(r) === base);
    const to = rs.filter((r) => conditionOf(r) === treat);
    const taskIds = [...new Set(rs.map((r) => r.task_id))].sort();
    const tasks = taskIds.map((id) => {
      const f = from.filter((r) => r.task_id === id);
      const t = to.filter((r) => r.task_id === id);
      return {
        task_id: id,
        score: paired(f, t, 'score'),
        duration: paired(f, t, 'duration'),
        cost: paired(f, t, 'cost'),
      };
    });
    const minRepeats = tasks.length ? Math.min(...tasks.map((t) => t.score.n)) : 0;
    const s = paired(from, to, 'score');
    delete s.from_scores;
    delete s.to_scores;
    skills.push({
      benchmark: rs[0].benchmark,
      model: rs[0].config?.model ?? null,
      from: base,
      to: treat,
      score: s,
      duration: paired(from, to, 'duration'),
      cost: paired(from, to, 'cost'),
      min_repeats: minRepeats,
      conclusive: minRepeats >= 2,
      tasks,
    });
  }
  return { harness: harnesses[0] ?? null, skills };
}
