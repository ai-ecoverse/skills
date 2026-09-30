#!/usr/bin/env node
/**
 * start-leader — slicc's start-leader.mjs, then the staged skill set injected into the new
 * leader's VFS. The workflow points the runner's `BENCH_LEADER_SCRIPTS` at this directory, so
 * every boot and every restart (`--fresh-leader-every 1`) goes through here.
 *
 * Why not a mount: on the production webapp (2026-09-30) the runner's staging command
 * `cp -r /workspace/bench-skills/<skill>/. /workspace/skills/` fails when the source is a
 * node-server mount, with `cp: cannot safely determine whether '/workspace/bench-skills/tst/.'
 * and '/workspace/skills/.' are the same file` (Skill evals run 36721431189). A VFS-to-VFS `cp`
 * works (the runner's own stash copy of /workspace/skills). So the set is written INTO the VFS
 * with slicc's inject-files.mjs (gzip-tar over `slicc … exec`) and the runner copies from there.
 *
 * Env: SKILL_EVALS_SLICC_SCRIPTS (slicc's packages/github-workflow/scripts), SKILL_EVALS_SEED
 * (`<runner dir>:<VFS dir>`, empty for the `none` condition), plus everything slicc's
 * start-leader.mjs reads (INPUT_*, SLICC_GW_HOME, SLICC_CLI).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  console.log(`::error::skill-evals start-leader: ${message}`);
  process.exit(1);
}

const scripts = process.env.SKILL_EVALS_SLICC_SCRIPTS ?? '';
if (!scripts || !existsSync(join(scripts, 'start-leader.mjs')))
  fail(`SKILL_EVALS_SLICC_SCRIPTS has no start-leader.mjs: "${scripts}"`);

const boot = spawnSync(process.execPath, [join(scripts, 'start-leader.mjs')], {
  stdio: 'inherit',
  env: process.env,
});
if (boot.status !== 0) process.exit(boot.status ?? 1);

const seed = (process.env.SKILL_EVALS_SEED ?? '').trim();
if (seed) {
  const sep = seed.lastIndexOf(':');
  const source = seed.slice(0, sep);
  const target = seed.slice(sep + 1);
  if (sep <= 0 || !/^\/workspace\/bench-skills\/[a-z0-9][a-z0-9-]*$/.test(target))
    fail(`SKILL_EVALS_SEED must be <runner dir>:/workspace/bench-skills/<skill>, not "${seed}"`);
  if (!existsSync(source)) fail(`seed source ${source} does not exist`);
  const { readState } = await import(join(scripts, 'gh-io.mjs'));
  const url = readState()?.joinUrl;
  if (!url) fail('start-leader left no join URL in its state file');
  const inject = spawnSync(process.execPath, [join(scripts, 'inject-files.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, SLICC_JOIN_URL: url, INPUT_SOURCE: source, INPUT_TARGET: target },
  });
  if (inject.status !== 0) fail(`inject-files exited ${inject.status} for ${target}`);
  const { execOnLeader } = await import(join(scripts, 'gh-io.mjs'));
  const listing = execOnLeader(url, `ls ${target}`, { timeoutMs: 60_000 }).toString('utf8');
  console.log(`[skill-evals] ${target}: ${listing.trim().split('\n').join(', ') || '(empty)'}`);
  if (!listing.trim()) fail(`${target} is empty after the injection`);
}
