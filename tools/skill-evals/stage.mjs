#!/usr/bin/env node
/**
 * stage — build the skill SET directory the runner's `none+<skill>` condition copies from.
 *
 *   node tools/skill-evals/stage.mjs <skill> <stage root>
 *
 * Writes `<stage root>/<skill>/<skill>/`, a copy of `skills/<skill>/` without its top-level
 * `evals/` (the agent under test must not read the rubrics). Symlinks are not copied. The workflow mounts
 * `<stage root>/<skill>` at `/workspace/bench-skills/<skill>`, and the runner runs
 * `cp -r /workspace/bench-skills/<skill>/. /workspace/skills/` (slicc-adapter.mjs:215-216).
 * An empty set would pass the runner's own check and silently run as `none`, so this exits 1
 * unless the copy has `SKILL.md` and no `evals/`.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function countFiles(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    n += statSync(join(dir, name)).isDirectory() ? countFiles(join(dir, name)) : 1;
  }
  return n;
}

/** Copy a directory tree, files and directories only; `skip(name, depth)` leaves an entry out. */
export function copyTree(src, dest, skip = () => false, depth = 0) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (skip(name, depth)) continue;
    const from = join(src, name);
    const to = join(dest, name);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTree(from, to, skip, depth + 1);
    else if (st.isFile()) copyFileSync(from, to);
  }
}

export function stageSkill(skill, stageRoot, { root = REPO_ROOT } = {}) {
  if (!SAFE_SKILL_NAME.test(skill)) throw new Error(`not a skill name: ${JSON.stringify(skill)}`);
  const src = join(root, 'skills', skill);
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`${src} does not exist`);
  const setDir = join(resolve(stageRoot), skill);
  const dest = join(setDir, skill);
  rmSync(setDir, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  copyTree(src, dest, (name, depth) => depth === 0 && name === 'evals');
  if (!existsSync(join(dest, 'SKILL.md')))
    throw new Error(`${relative(root, dest)} has no SKILL.md: none+${skill} would run as none`);
  if (existsSync(join(dest, 'evals'))) throw new Error(`${dest}/evals was staged`);
  const entries = readdirSync(setDir);
  if (entries.length !== 1 || entries[0] !== skill)
    throw new Error(`${setDir} must hold exactly ${skill}/, has ${entries.join(', ')}`);
  return { setDir, dest, files: countFiles(dest) };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let code = 1;
  try {
    const [skill, stageRoot] = process.argv.slice(2);
    if (!skill || !stageRoot) throw new Error('usage: stage.mjs <skill> <stage root>');
    const got = stageSkill(skill, stageRoot);
    console.log(`staged ${got.dest}: ${got.files} file(s), SKILL.md present, evals/ left out`);
    code = 0;
  } catch (err) {
    console.log(`::error::skill-evals stage: ${err.message}`);
  }
  process.exit(code);
}
