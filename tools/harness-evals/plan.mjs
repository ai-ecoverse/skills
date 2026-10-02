#!/usr/bin/env node
/**
 * plan — which skills' harness evals to run, and one matrix entry per skill × arm.
 *
 *   node tools/harness-evals/plan.mjs <changed|all|skill,skill> [<base ref for 'changed'>]
 *
 * `changed` (the default for pull requests and dispatches) takes every skill the diff against
 * the base touches that has an evals/harness/harness.mjs, so a PR only evaluates what it
 * changed. Each adapter and goals file is validated here, before any leader boots.
 * Prints the matrix JSON (`{ include: [...] }`) on stdout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ADAPTER, loadAdapter } from './adapter.mjs';
import { parseSuites, selectSuites, validateGoals } from './placeholders.mjs';
import { hasRubric } from './rubric.mjs';

/** Skill names under skills/ that a list of changed paths touches. */
export function touchedSkills(paths) {
  const names = new Set();
  for (const p of paths) {
    const m = /^skills\/([^/]+)\//.exec(p);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

export async function plan(which, base, root = process.cwd(), suites = ['default'], repeats = 1) {
  const withAdapter = (name) => existsSync(join(root, 'skills', name, ADAPTER));
  let skills;
  if (which === 'all') skills = readdirSync(join(root, 'skills')).filter(withAdapter).sort();
  else if (which === 'changed') {
    const diff = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    skills = touchedSkills(diff.split('\n').filter(Boolean)).filter(withAdapter);
  } else {
    skills = which
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of skills) if (!withAdapter(s)) throw new Error(`skills/${s} has no ${ADAPTER}`);
  }
  const include = [];
  for (const skill of skills) {
    const { adapter, goalsPath } = await loadAdapter(join(root, 'skills', skill));
    const doc = JSON.parse(readFileSync(goalsPath, 'utf8'));
    const errors = validateGoals(doc);
    // A skill arm on a rubric goal needs the adapter to say what the judge reads.
    if (
      doc.goals?.some(hasRubric) &&
      adapter.arms.some((a) => a.kind === 'skill') &&
      typeof adapter.judgeTrace !== 'function'
    )
      errors.push('goals with a rubric need the adapter to export judgeTrace for its skill arms');
    if (errors.length) throw new Error(`${goalsPath}: ${errors.join('; ')}`);
    // A skill with no goal in the selected suites gets no jobs.
    if (!selectSuites(doc.goals, suites).length) continue;
    // One job per arm and repeat: repeats run in parallel, on as many machines as the arm's pool
    // has (GPU arms on cloud-run-gpu, the rest on cloud-run-bench), and a job holds one pass
    // over the goals, so a long suite with several repeats stays under the job's time limit.
    for (const arm of adapter.arms)
      for (let repeat = 1; repeat <= repeats; repeat += 1)
        include.push({
          skill,
          arm: arm.id,
          repeat,
          runs_on: arm.pool === 'gpu' ? 'cloud-run-gpu' : 'cloud-run-bench',
          gpu: arm.pool === 'gpu' ? '1' : '',
          // Only the skill under test and what its arm needs: an agent arm keeps the bare leader.
          inject: arm.kind === 'agent' ? '' : [skill, ...(arm.skills ?? [])].join(','),
        });
  }
  return { include };
}

// realpath: argv[1] keeps symlinks (macOS /tmp), import.meta.url doesn't.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [which = 'changed', base = 'origin/main', suites = 'default', repeats = '1'] =
    process.argv.slice(2);
  const n = Number.parseInt(repeats, 10);
  if (!(n >= 1 && n <= 10)) throw new Error('repeats must be 1-10');
  process.stdout.write(
    `${JSON.stringify(await plan(which, base, process.cwd(), parseSuites(suites), n))}\n`
  );
}
