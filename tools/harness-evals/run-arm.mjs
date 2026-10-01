#!/usr/bin/env node
/**
 * run-arm — run every goal of a goals file, `repeats` times, for ONE arm on an already booted
 * hosted leader (slicc's start-leader.mjs), and write one record per run.
 *
 * An arm is either
 *   - `webrunner`: `webrunner run --url --goal --expect.. --expect-url.. --max-steps <args> --json`
 *     with the arm's own decider flags (the skill must already be in /workspace/skills), or
 *   - `agent`: one `slicc prompt` per goal (the bare agent with its bundled skills), the goal
 *     text and start URL as the prompt.
 * Every run is judged the same way (judge.mjs): meep-meep's checkExpect on each tab the run left
 * open. The arm's own verdict (webrunner `ok`) is recorded beside it.
 *
 * Env:
 *   HARNESS_SLICC     slicc checkout (packages/github-workflow/scripts, packages/bench/scripts)
 *   HARNESS_ARM       arm JSON (see arms.json)
 *   HARNESS_GOALS     goals.json path
 *   HARNESS_PAGE_JS   page.js path for the shared check
 *   HARNESS_REPEATS   runs per goal (default 1)
 *   HARNESS_OUT       output dir (records/, traces/)
 *   HARNESS_RUN_S     per-run timeout in seconds (default 900)
 *   SLICC_GW_HOME / SLICC_CLI as slicc's scripts read them.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fillGoal, hnTopFromHtml, needsHnTop, shellQuote, validateGoals } from './goals.mjs';
import { loadChecker, passes, tabIds } from './judge.mjs';

const env = (k, d) => (process.env[k] ?? d ?? '').trim();
const SLICC = env('HARNESS_SLICC');
const arm = JSON.parse(env('HARNESS_ARM'));
const goals = JSON.parse(readFileSync(env('HARNESS_GOALS'), 'utf8'));
const page = loadChecker(env('HARNESS_PAGE_JS'));
const repeats = Math.max(1, Number.parseInt(env('HARNESS_REPEATS', '1'), 10) || 1);
const out = env('HARNESS_OUT');
const runTimeoutMs = (Number.parseInt(env('HARNESS_RUN_S', '900'), 10) || 900) * 1000;

const errors = validateGoals(goals);
if (errors.length) {
  console.log(`::error::goals file: ${errors.join('; ')}`);
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(String(arm.id ?? ''))) throw new Error(`bad arm id ${arm.id}`);

const io = await import(join(SLICC, 'packages/github-workflow/scripts/gh-io.mjs'));
const vfs = await import(join(SLICC, 'packages/github-workflow/scripts/vfs-file.mjs'));
const adapter = await import(join(SLICC, 'packages/bench/scripts/slicc-adapter.mjs'));
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
const { spawnSync } = await import('node:child_process');
/** A CLI verb on the leader (`slicc <url> <verb> ...`), like the bench adapter's cli(). */
const cli = (args, { input, timeoutMs = 120_000 } = {}) =>
  spawnSync(io.cliPath(), [url, ...args], {
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
  });
const spend = () => {
  const r = trySh('cost --json --all', 60_000);
  return r.ok ? adapter.costTotals(r.out) : null;
};
const tabs = () => tabIds(trySh('playwright-cli tab-list', 60_000).out);

mkdirSync(join(out, 'records'), { recursive: true });
mkdirSync(join(out, 'traces'), { recursive: true });

// Models first, once: a webrunner arm never downloads by itself (it stops and names `kev pull`).
// The agent arm's model (webrunner arms pass theirs as flags).
if (arm.model) {
  const m = cli(['model', arm.model]);
  if (m.status !== 0)
    throw new Error(`slicc model ${arm.model} failed: ${String(m.stderr ?? '').slice(-300)}`);
}
for (const model of arm.pull ?? []) {
  if (!/^[a-z0-9.-]+$/.test(model)) throw new Error(`bad model ${model}`);
  const t0 = Date.now();
  sh(`kev pull --model ${model}`, 30 * 60_000);
  console.log(`[harness] kev pull --model ${model}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function hnTop() {
  const r = await fetch('https://news.ycombinator.com/', {
    headers: { 'user-agent': 'slicc-harness-evals' },
  });
  const id = hnTopFromHtml(await r.text());
  if (!id) throw new Error('could not read the top story id from the Hacker News front page');
  return id;
}

function webrunnerCommand(g) {
  const argv = ['webrunner', 'run', '--url', g.url, '--goal', g.goal];
  for (const t of g.expect) argv.push('--expect', t);
  for (const u of g.expect_url) argv.push('--expect-url', u);
  if (g.max_steps) argv.push('--max-steps', String(g.max_steps));
  argv.push(...(arm.args ?? []), '--json');
  return argv.map(shellQuote).join(' ');
}

function agentPrompt(g) {
  return `Open ${g.url} in a new browser tab and do this there: ${g.goal}\nLeave the final page open in that tab when you are done.`;
}

/** The last JSON object a command printed (webrunner --json prints one). */
function lastJson(text) {
  const lines = String(text).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const start = lines.slice(i).join('\n');
    if (!start.trimStart().startsWith('{')) continue;
    try {
      return JSON.parse(start);
    } catch {}
  }
  return null;
}

const results = [];
for (let rep = 1; rep <= repeats; rep += 1) {
  for (const raw of goals.goals) {
    const g = fillGoal(raw, { now: new Date(), hnTop: needsHnTop(raw) ? await hnTop() : null });
    cli(['new-session', '--erase'], { timeoutMs: 60_000 });
    const before = tabs();
    const costBefore = spend();
    const t0 = Date.now();
    let self = null;
    let runError = null;
    if (arm.kind === 'webrunner') {
      const r = trySh(webrunnerCommand(g), runTimeoutMs);
      self = lastJson(r.out);
      if (!r.ok && !self) runError = r.out.slice(0, 300);
    } else if (arm.kind === 'agent') {
      const r = cli(['prompt', '--allsettled', '2m', '-'], {
        input: agentPrompt(g),
        timeoutMs: runTimeoutMs,
      });
      if (r.status !== 0)
        runError = `slicc prompt exited ${r.status}: ${String(r.stderr ?? '').slice(-300)}`;
    } else throw new Error(`unknown arm kind ${arm.kind}`);
    const seconds = (Date.now() - t0) / 1000;
    const delta = adapter.spendDelta(costBefore, spend());
    // Judge every tab the run opened (and the active one, if it reused a tab).
    const opened = tabs().filter((id) => !before.includes(id));
    let pass = false;
    const judged = [];
    for (const id of opened.length ? opened : tabs()) {
      const snap = trySh(`playwright-cli snapshot --tab=${id}`, 60_000);
      const ok = snap.ok && passes(page, snap.out, g);
      judged.push({ tab: id, ok });
      if (ok) pass = true;
    }
    for (const id of opened) trySh(`playwright-cli tab-close --tab=${id}`, 30_000);
    // Keep the run's trace for `webrunner debug` (screenshots stay on the leader).
    if (self?.run && /^[A-Za-z0-9._-]+$/.test(self.run)) {
      try {
        vfs.readVfsFile(
          url,
          `/tmp/meep/runs/${self.run}/trace.jsonl`,
          join(out, 'traces', arm.id, `${self.run}.trace.jsonl`),
          120_000
        );
      } catch (e) {
        console.log(`::warning::trace ${self.run}: ${e.message}`);
      }
    }
    const record = {
      arm: arm.id,
      kind: arm.kind,
      goal: g.id,
      repeat: rep,
      pass,
      self_ok: self ? Boolean(self.ok) : null,
      self_reason: self?.reason ?? null,
      steps: self?.steps ?? null,
      seconds,
      decide_seconds: self?.decideSeconds ?? null,
      cost_usd: delta.costUsd,
      tokens: delta.tokens,
      tabs_judged: judged,
      error: runError,
      at: new Date().toISOString(),
    };
    writeFileSync(
      join(out, 'records', `${arm.id}--${g.id}--r${rep}.json`),
      `${JSON.stringify(record, null, 2)}\n`
    );
    results.push(record);
    console.log(
      `[harness] ${arm.id} ${g.id} r${rep}: ${pass ? 'PASS' : 'fail'} (self ${record.self_ok}) ${seconds.toFixed(0)} s ${delta.costUsd == null ? '' : `$${delta.costUsd.toFixed(3)}`}${runError ? ` ERROR ${runError.slice(0, 120)}` : ''}`
    );
  }
}
const passed = results.filter((r) => r.pass).length;
console.log(`[harness] ${arm.id}: ${passed}/${results.length} passed`);
