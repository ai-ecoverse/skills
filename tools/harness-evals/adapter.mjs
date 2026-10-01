/**
 * adapter — load and check a skill's harness adapter, skills/<skill>/evals/harness/harness.mjs.
 *
 * Everything skill-specific lives in the skill's folder; this repo's tools only drive it.
 * The adapter exports:
 *   goals            path of the goals file, relative to the adapter (see placeholders.mjs)
 *   arms             [{ id, kind: 'skill' | 'agent', pool: 'gpu' | 'bench',
 *                       skills?: [other skills to put on the leader], setup?: [shell commands],
 *                       model?: agent arms' model, ...anything the adapter reads }]
 *   command(goal, arm, { shellQuote })   the shell command that runs one goal (kind 'skill')
 *   judge(raw, goal)                      whether one `playwright-cli snapshot` passes the goal;
 *                                         every arm is judged this way, on the tabs it left open
 *   result?(stdout)                       the arm's own report: { ok?, steps?, decideSeconds?,
 *                                         artifacts?: [VFS paths to keep] }
 *   placeholder?(name, { fetch })         the value of a non-date {{name}}, fetched just
 *                                         before each run
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ADAPTER = 'evals/harness/harness.mjs';

/** Problems with an adapter's arms (empty when valid). */
export function validateArms(arms) {
  const errors = [];
  if (!Array.isArray(arms) || !arms.length) return ['arms must be a non-empty array'];
  const ids = new Set();
  for (const [i, a] of arms.entries()) {
    const at = `arms[${i}]`;
    // Dots allowed for model sizes (kev-0.8b); ids name records, jobs and artifacts.
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(String(a.id ?? '')))
      errors.push(`${at}: id must be lowercase a-z0-9.-`);
    else if (ids.has(a.id)) errors.push(`${at}: duplicate id ${a.id}`);
    ids.add(a.id);
    if (!['skill', 'agent'].includes(a.kind)) errors.push(`${at}: kind must be skill or agent`);
    if (!['gpu', 'bench'].includes(a.pool)) errors.push(`${at}: pool must be gpu or bench`);
    for (const s of a.skills ?? [])
      if (!/^[a-z0-9][a-z0-9-]*$/.test(String(s))) errors.push(`${at}: bad skill name ${s}`);
    if (
      a.setup != null &&
      !(Array.isArray(a.setup) && a.setup.every((c) => typeof c === 'string' && c))
    )
      errors.push(`${at}: setup must be an array of shell commands`);
    if (a.kind === 'agent' && !a.model) errors.push(`${at}: an agent arm names its model`);
  }
  return errors;
}

/** Import and check `<skillDir>/evals/harness/harness.mjs`; returns { adapter, goalsPath }. */
export async function loadAdapter(skillDir) {
  const file = join(skillDir, ADAPTER);
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const adapter = await import(pathToFileURL(file).href);
  const errors = validateArms(adapter.arms);
  if (typeof adapter.goals !== 'string') errors.push('goals must be a path string');
  if (typeof adapter.judge !== 'function') errors.push('judge(raw, goal) is required');
  if ((adapter.arms ?? []).some((a) => a.kind === 'skill') && typeof adapter.command !== 'function')
    errors.push("command(goal, arm) is required for 'skill' arms");
  if (errors.length) throw new Error(`${file}: ${errors.join('; ')}`);
  return { adapter, goalsPath: join(dirname(file), adapter.goals) };
}
