#!/usr/bin/env node
/**
 * boot — start one hosted leader with slicc's start-leader.mjs, then put the arm's skills into
 * its /workspace/skills (without their evals/) so their commands (webrunner, kev, …) exist.
 *
 * Env: HARNESS_SLICC (slicc checkout), HARNESS_SKILLS_DIR (the arm's skills/ dir),
 * HARNESS_SKILLS (comma list, may be empty), plus everything start-leader.mjs reads (INPUT_*,
 * SLICC_GW_HOME, SLICC_CLI, and SLICC_CHROME_GPU for a GPU leader).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fail = (m) => {
  console.log(`::error::harness boot: ${m}`);
  process.exit(1);
};
const scripts = join(process.env.HARNESS_SLICC ?? '', 'packages/github-workflow/scripts');
if (!existsSync(join(scripts, 'start-leader.mjs'))) fail(`no start-leader.mjs under ${scripts}`);

const boot = spawnSync(process.execPath, [join(scripts, 'start-leader.mjs')], {
  stdio: 'inherit',
  env: process.env,
});
if (boot.status !== 0) process.exit(boot.status ?? 1);

const io = await import(join(scripts, 'gh-io.mjs'));
const url = io.readState()?.joinUrl;
if (!url) fail('start-leader left no join URL');
console.log(`::add-mask::${url}`);

const names = (process.env.HARNESS_SKILLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (names.length) {
  const src = process.env.HARNESS_SKILLS_DIR ?? '';
  const stage = mkdtempSync(join(tmpdir(), 'harness-skills-'));
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`bad skill name ${name}`);
    if (!existsSync(join(src, name, 'SKILL.md'))) fail(`${src}/${name} has no SKILL.md`);
    // The arm never sees its own evals (goals, rubrics).
    cpSync(join(src, name), join(stage, name), {
      recursive: true,
      filter: (p) => !/\/evals(\/|$)/.test(p.slice(src.length)),
    });
  }
  // A leader that just minted its join URL can still refuse a terminal for a few seconds
  // (skill-evals run 36735238551); the injection overwrites, so retry it.
  let ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt += 1) {
    const r = spawnSync(process.execPath, [join(scripts, 'inject-files.mjs')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SLICC_JOIN_URL: url,
        INPUT_SOURCE: stage,
        INPUT_TARGET: '/workspace/skills',
      },
    });
    ok = r.status === 0;
    if (!ok) spawnSync('sleep', ['10']);
  }
  if (!ok) fail('could not inject the skills into /workspace/skills');
  for (const name of names) {
    const out = io
      .execOnLeader(url, `ls /workspace/skills/${name}/SKILL.md`, { timeoutMs: 60_000 })
      .toString();
    if (!out.includes('SKILL.md')) fail(`${name} is not in /workspace/skills after injection`);
  }
  console.log(`[harness] injected ${names.join(', ')} into /workspace/skills`);
}
