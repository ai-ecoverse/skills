#!/usr/bin/env node
/**
 * plan — decide which host eval sets a Skill evals run covers, validate them, and print the job
 * matrix for .github/workflows/skill-evals.yml.
 *
 *   git diff --name-only origin/main...HEAD | node tools/skill-evals/plan.mjs --changed -
 *   node tools/skill-evals/plan.mjs --skills all|a,b [--repeats N] [--tasks id,id] [--out f]
 *
 * A skill is covered when it has `skills/<skill>/evals/host/tasks.json` and the PR touches
 * `skills/<skill>/**`. A change to the eval machinery itself (the workflow, `tools/skill-evals/**`,
 * the shared format module) runs the pilot skill `tst`. Every covered set is checked with
 * `validateSet(set, { harness: 'host', skill })` from `skills/skill-evals/scripts/evals-format.js`,
 * and every fixture `slicc.files[].from` must exist next to it. Any error exits 1.
 *
 * Output (stdout, and `--out <file>`): `{ node, skills: [...], matrix: { include: [...] },
 * expected_runs }`. Each matrix entry is one runner invocation: one skill, one condition
 * (`none`, or `none+<skill>` with the staged skill mounted), with its guardrails.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateSet } from '../../skills/skill-evals/scripts/evals-format.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PILOT = 'tst';
export const FORMAT_MODULE = 'skills/skill-evals/scripts/evals-format.js';
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SAFE_TASK_ID = /^[A-Za-z0-9._-]+$/;
const MACHINERY = [
  /^\.github\/workflows\/skill-evals\.yml$/,
  /^tools\/skill-evals\//,
  new RegExp(`^${FORMAT_MODULE.replaceAll('.', '\\.')}$`),
];

/** Guardrails per runner invocation, in one place. Dollar figures follow bench.yml's PR smoke. */
export const LIMITS = {
  defaultTimeout: 600, // seconds, for a task without slicc.timeoutSeconds
  minutesPerRun: 15, // wall-clock budget per run for the deadline: agent + 2 min quiet + restart + judge
  runOverhead: 20, // run.mjs RUN_OVERHEAD_MS, minutes
  maxDeadline: 300, // job limit is deadline + 45, under the 360-minute hosted-runner ceiling
  maxTaskCost: 2, // dollars; bench.yml:203 (PR smoke)
  costPerRun: 2.5, // dollars of --max-cost per planned run; bench.yml:204 is $10 for 4 runs
};

export const hostSetPath = (skill) => `skills/${skill}/evals/host/tasks.json`;

/** Skills a change list covers: touched skills with a host set, plus the pilot for machinery. */
export function selectFromChanges(paths, { hasHostSet }) {
  const picked = new Set();
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    if (MACHINERY.some((re) => re.test(path))) picked.add(PILOT);
    const m = /^skills\/([^/]+)\//.exec(path);
    if (m && SAFE_SKILL_NAME.test(m[1]) && hasHostSet(m[1])) picked.add(m[1]);
  }
  return [...picked].filter((s) => hasHostSet(s)).sort();
}

/** Skills a dispatch names: `all`, or a comma list whose every entry must have a host set. */
export function selectFromInput(text, { hasHostSet, allWithHostSet }) {
  const value = String(text ?? '').trim();
  if (value === '' || value === 'all') return allWithHostSet();
  const errors = [];
  const names = [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
  for (const name of names) {
    if (!SAFE_SKILL_NAME.test(name)) errors.push(`not a skill name: ${JSON.stringify(name)}`);
    else if (!hasHostSet(name)) errors.push(`${name} has no ${hostSetPath(name)}`);
  }
  if (errors.length) throw new Error(errors.join('; '));
  return names.sort();
}

/** Every skill directory with a host set. */
export function listHostSkills(root, readdir) {
  return readdir(join(root, 'skills'))
    .filter((name) => SAFE_SKILL_NAME.test(name))
    .filter((name) => existsSync(join(root, hostSetPath(name))))
    .sort();
}

/** Fixture files a set names that are missing next to it. */
export function missingFixtures(set, setDir, exists = existsSync) {
  const missing = [];
  for (const task of set.tasks ?? []) {
    for (const f of task?.slicc?.files ?? []) {
      if (typeof f?.from === 'string' && !exists(join(setDir, f.from)))
        missing.push(`${task.id}: fixture ${f.from} does not exist`);
    }
  }
  return missing;
}

/**
 * The matrix entries for one validated set: `none` and `none+<skill>`, each with the runner's
 * guardrails. `taskFilter` (ids) narrows the set; a skill with none of those ids is skipped.
 */
export function entriesFor(skill, set, { repeats = 1, taskFilter = null } = {}) {
  const tasks = (set.tasks ?? []).filter((t) => !taskFilter || taskFilter.includes(t.id));
  if (tasks.length === 0) return [];
  const timeout = Math.max(
    ...tasks.map((t) => t.slicc?.timeoutSeconds ?? LIMITS.defaultTimeout),
    30
  );
  const runs = tasks.length * repeats;
  const timeoutMinutes = Math.ceil(timeout / 60);
  const deadline = Math.min(
    LIMITS.maxDeadline,
    runs * LIMITS.minutesPerRun + timeoutMinutes + LIMITS.runOverhead
  );
  const base = {
    skill,
    set: hostSetPath(skill),
    tasks: taskFilter ? tasks.map((t) => t.id).join(',') : '',
    runs,
    repeats,
    timeout,
    deadline,
    run_minutes: deadline + 20,
    job_minutes: deadline + 45,
    max_task_cost: LIMITS.maxTaskCost,
    max_cost: Math.ceil(runs * LIMITS.costPerRun),
  };
  return [
    { ...base, arm: 'none', condition: 'none' },
    { ...base, arm: 'with', condition: `none+${skill}` },
  ];
}

export async function plan({
  root = REPO_ROOT,
  changed,
  skills,
  repeats = 1,
  tasks = '',
  readdir,
}) {
  const hasHostSet = (s) => SAFE_SKILL_NAME.test(s) && existsSync(join(root, hostSetPath(s)));
  const allWithHostSet = () => listHostSkills(root, readdir);
  const selected =
    changed !== undefined
      ? selectFromChanges(changed, { hasHostSet })
      : selectFromInput(skills, { hasHostSet, allWithHostSet });
  const taskFilter = String(tasks ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of taskFilter)
    if (!SAFE_TASK_ID.test(id)) throw new Error(`not a task id: ${JSON.stringify(id)}`);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
    throw new Error(`repeats must be 1 to 10, not ${repeats}`);

  const errors = [];
  const include = [];
  const report = [];
  for (const skill of selected) {
    const file = join(root, hostSetPath(skill));
    let set;
    try {
      set = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      errors.push({ file: hostSetPath(skill), message: `not valid JSON: ${err.message}` });
      continue;
    }
    const result = validateSet(set, { harness: 'host', skill });
    const problems = [...result.errors, ...missingFixtures(set, dirname(file))];
    if (!existsSync(join(root, 'skills', skill, 'SKILL.md')))
      problems.push(`skills/${skill}/SKILL.md does not exist`);
    for (const message of problems) errors.push({ file: hostSetPath(skill), message });
    if (problems.length) continue;
    const entries = entriesFor(skill, set, {
      repeats,
      taskFilter: taskFilter.length ? taskFilter : null,
    });
    report.push({ skill, tasks: set.tasks.length, runs_per_condition: entries[0]?.runs ?? 0 });
    include.push(...entries);
  }
  return {
    node: process.version,
    skills: report,
    matrix: { include },
    expected_runs: include.reduce((n, e) => n + e.runs, 0),
    errors,
  };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      changed: { type: 'string' },
      skills: { type: 'string' },
      repeats: { type: 'string', default: '1' },
      tasks: { type: 'string', default: '' },
      root: { type: 'string' },
      out: { type: 'string' },
    },
  });
  let changed;
  if (values.changed !== undefined) {
    const text =
      values.changed === '-' ? readFileSync(0, 'utf8') : readFileSync(values.changed, 'utf8');
    changed = text.split('\n');
  }
  const { readdirSync } = await import('node:fs');
  const result = await plan({
    root: values.root ? resolve(values.root) : REPO_ROOT,
    changed,
    skills: values.skills,
    repeats: Number(values.repeats),
    tasks: values.tasks,
    readdir: (d) => readdirSync(d),
  });
  const text = JSON.stringify(result, null, 2);
  if (values.out) writeFileSync(values.out, `${text}\n`);
  console.log(text);
  for (const e of result.errors) console.log(`::error file=${e.file}::${e.message}`);
  return result.errors.length ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error::skill-evals plan: ${err.message}`);
      process.exit(1);
    }
  );
}
