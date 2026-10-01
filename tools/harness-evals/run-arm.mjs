#!/usr/bin/env node
/**
 * run-arm — run one arm of one skill's harness eval on an already booted hosted leader
 * (boot.mjs), every goal `repeats` times, and write one record per run.
 *
 * Skill-specific behaviour comes from the skill's adapter (adapter.mjs): how a goal runs
 * (`command`), how a final page is judged (`judge`), custom placeholders, artifacts. This file
 * only drives: setup commands, a fresh session per run, the timing and the spend, the shared
 * judging of every tab the run left open, and the records.
 *   - kind 'skill': runs `adapter.command(goal, arm)` in the leader's shell;
 *   - kind 'agent': one `slicc prompt` per goal (the bare agent and its bundled skills), with
 *     the arm's model.
 *
 * Env: HARNESS_SLICC (slicc checkout), HARNESS_SKILL_DIR, HARNESS_ARM_ID, HARNESS_REPEATS,
 * HARNESS_OUT, HARNESS_RUN_S (per-run timeout, default 900), plus SLICC_GW_HOME / SLICC_CLI.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAdapter } from './adapter.mjs';
import {
  customPlaceholders,
  fillGoal,
  shellQuote,
  tabIds,
  validateGoals,
} from './placeholders.mjs';

const env = (k, d) => (process.env[k] ?? d ?? '').trim();
const SLICC = env('HARNESS_SLICC');
const skillDir = env('HARNESS_SKILL_DIR');
const skill = basename(skillDir);
const { adapter, goalsPath } = await loadAdapter(skillDir);
const arm = adapter.arms.find((a) => a.id === env('HARNESS_ARM_ID'));
if (!arm) throw new Error(`${skill} has no arm ${env('HARNESS_ARM_ID')}`);
const goals = JSON.parse(readFileSync(goalsPath, 'utf8'));
const goalErrors = validateGoals(goals);
if (goalErrors.length) throw new Error(`${goalsPath}: ${goalErrors.join('; ')}`);
const repeats = Math.max(1, Number.parseInt(env('HARNESS_REPEATS', '1'), 10) || 1);
const out = env('HARNESS_OUT');
const runTimeoutMs = (Number.parseInt(env('HARNESS_RUN_S', '900'), 10) || 900) * 1000;

const io = await import(join(SLICC, 'packages/github-workflow/scripts/gh-io.mjs'));
const vfs = await import(join(SLICC, 'packages/github-workflow/scripts/vfs-file.mjs'));
const bench = await import(join(SLICC, 'packages/bench/scripts/slicc-adapter.mjs'));
const url = io.readState()?.joinUrl;
if (!url) throw new Error('no leader: start-leader left no join URL');

const sh = (command, timeoutMs = 120_000) =>
  io.execOnLeader(url, command, { timeoutMs }).toString('utf8');
const trySh = (command, timeoutMs) => {
  try {
    return { ok: true, out: sh(command, timeoutMs) };
  } catch (e) {
    return { ok: false, out: String(e.message ?? e) };
  }
};
/** A CLI verb on the leader (`slicc <url> <verb> …`), like the bench adapter's cli(). */
const cli = (args, { input, timeoutMs = 120_000 } = {}) =>
  spawnSync(io.cliPath(), [url, ...args], {
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
  });
const spend = () => {
  const r = trySh('cost --json --all', 60_000);
  return r.ok ? bench.costTotals(r.out) : null;
};
const tabs = () => tabIds(trySh('playwright-cli tab-list', 60_000).out);

mkdirSync(join(out, 'records'), { recursive: true });
mkdirSync(join(out, 'artifacts'), { recursive: true });

if (arm.kind === 'agent') {
  const m = cli(['model', arm.model]);
  if (m.status !== 0)
    throw new Error(`slicc model ${arm.model} failed: ${String(m.stderr ?? '').slice(-300)}`);
}
for (const command of arm.setup ?? []) {
  const t0 = Date.now();
  sh(command, 30 * 60_000);
  console.log(`[harness] setup \`${command}\`: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const agentPrompt = (g) =>
  `Open ${g.url} in a new browser tab and do this there: ${g.goal}\nLeave the final page open in that tab when you are done.`;

const results = [];
for (let rep = 1; rep <= repeats; rep += 1) {
  for (const raw of goals.goals) {
    const values = {};
    for (const name of customPlaceholders(raw)) {
      if (typeof adapter.placeholder !== 'function')
        throw new Error(`goal ${raw.id} uses {{${name}}} but the adapter resolves no placeholders`);
      values[name] = String(await adapter.placeholder(name, { fetch }));
    }
    const g = fillGoal(raw, { now: new Date(), values });
    cli(['new-session', '--erase'], { timeoutMs: 60_000 });
    const before = tabs();
    const costBefore = spend();
    const t0 = Date.now();
    let own = null;
    let runError = null;
    if (arm.kind === 'skill') {
      const r = trySh(adapter.command(g, arm, { shellQuote }), runTimeoutMs);
      own = typeof adapter.result === 'function' ? adapter.result(r.out) : null;
      if (!r.ok && !own) runError = r.out.slice(0, 300);
    } else {
      const r = cli(['prompt', '--allsettled', '2m', '-'], {
        input: agentPrompt(g),
        timeoutMs: runTimeoutMs,
      });
      if (r.status !== 0)
        runError = `slicc prompt exited ${r.status}: ${String(r.stderr ?? '').slice(-300)}`;
    }
    const seconds = (Date.now() - t0) / 1000;
    const delta = bench.spendDelta(costBefore, spend());
    // One bar for every arm: the skill's judge on each tab the run left open.
    const opened = tabs().filter((id) => !before.includes(id));
    const judged = [];
    for (const id of opened.length ? opened : tabs()) {
      const snap = trySh(`playwright-cli snapshot --tab=${id}`, 60_000);
      judged.push({ tab: id, ok: snap.ok && Boolean(adapter.judge(snap.out, g)) });
    }
    for (const id of opened) trySh(`playwright-cli tab-close --tab=${id}`, 30_000);
    for (const path of own?.artifacts ?? []) {
      if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) continue;
      try {
        vfs.readVfsFile(
          url,
          path,
          join(out, 'artifacts', arm.id, path.replace(/^\//, '').replace(/\//g, '__')),
          120_000
        );
      } catch (e) {
        console.log(`::warning::artifact ${path}: ${e.message}`);
      }
    }
    const record = {
      skill,
      arm: arm.id,
      kind: arm.kind,
      goal: g.id,
      repeat: rep,
      pass: judged.some((j) => j.ok),
      self_ok: own && 'ok' in own ? Boolean(own.ok) : null,
      steps: own?.steps ?? null,
      seconds,
      decide_seconds: own?.decideSeconds ?? null,
      cost_usd: delta.costUsd,
      tokens: delta.tokens,
      tabs_judged: judged,
      error: runError,
      at: new Date().toISOString(),
    };
    writeFileSync(
      join(out, 'records', `${skill}--${arm.id}--${g.id}--r${rep}.json`),
      `${JSON.stringify(record, null, 2)}\n`
    );
    results.push(record);
    console.log(
      `[harness] ${skill}/${arm.id} ${g.id} r${rep}: ${record.pass ? 'PASS' : 'fail'} (own ${record.self_ok}) ${seconds.toFixed(0)} s${delta.costUsd == null ? '' : ` $${delta.costUsd.toFixed(3)}`}${runError ? ` ERROR ${runError.slice(0, 120)}` : ''}`
    );
  }
}
console.log(
  `[harness] ${skill}/${arm.id}: ${results.filter((r) => r.pass).length}/${results.length} passed`
);
