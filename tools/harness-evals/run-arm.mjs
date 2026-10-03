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
 * HARNESS_REPEAT (this job's one repeat, when the plan shards), HARNESS_OUT, HARNESS_RUN_S (per-run timeout, default 900), HARNESS_SUITES (comma list, default
 * `default`), plus SLICC_GW_HOME / SLICC_CLI.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadAdapter } from './adapter.mjs';
import { escalationDelta, escalationTotals, invalidReason } from './escalations.mjs';
import {
  fillGoal,
  hasCheck,
  parseSuites,
  redactSecrets,
  resolvePlaceholders,
  selectSuites,
  shellQuote,
  tabIds,
  validateGoals,
} from './placeholders.mjs';
import {
  checkTrace,
  hasRubric,
  judgeAcrossModels,
  rubricRecord,
  rubricTask,
  traceSize,
} from './rubric.mjs';

const env = (k, d) => (process.env[k] ?? d ?? '').trim();
const SLICC = env('HARNESS_SLICC');
const skillDir = env('HARNESS_SKILL_DIR');
const skill = basename(skillDir);
const { adapter, goalsPath } = await loadAdapter(skillDir);
const arm = adapter.arms.find((a) => a.id === env('HARNESS_ARM_ID'));
if (!arm) throw new Error(`${skill} has no arm ${env('HARNESS_ARM_ID')}`);
const goals = JSON.parse(readFileSync(goalsPath, 'utf8'));
const suites = parseSuites(env('HARNESS_SUITES'));
const goalErrors = validateGoals(goals);
if (goalErrors.length) throw new Error(`${goalsPath}: ${goalErrors.join('; ')}`);
// One repeat per job when the plan shards (HARNESS_REPEAT); else every repeat in turn.
const shard = Number.parseInt(env('HARNESS_REPEAT'), 10);
const repeats = Math.max(1, Number.parseInt(env('HARNESS_REPEATS', '1'), 10) || 1);
const reps = shard >= 1 ? [shard] : Array.from({ length: repeats }, (_, i) => i + 1);
const out = env('HARNESS_OUT');
const runTimeoutMs = (Number.parseInt(env('HARNESS_RUN_S', '900'), 10) || 900) * 1000;
/** A goal's own `timeout_s` (long games) overrides the default per-run limit. */
const timeoutFor = (goal) => (goal.timeout_s ? goal.timeout_s * 1000 : runTimeoutMs);

const io = await import(join(SLICC, 'packages/github-workflow/scripts/gh-io.mjs'));
const vfs = await import(join(SLICC, 'packages/github-workflow/scripts/vfs-file.mjs'));
const bench = await import(join(SLICC, 'packages/bench/scripts/slicc-adapter.mjs'));
const url = io.readState()?.joinUrl;
if (!url) throw new Error('no leader: start-leader left no join URL');

// Goals with a rubric are also judged for partial credit, by the bench's judge (rubric.mjs).
const rubricGoals = selectSuites(goals.goals, suites).some(hasRubric);
let judgeRubric = null;
let leader = null;
if (rubricGoals) {
  const judgeMod = await import(join(SLICC, 'packages/bench/scripts/judge.mjs'));
  const upstream = await import(join(SLICC, 'packages/bench/scripts/upstream.mjs'));
  const apiKey = process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY;
  if (!apiKey) throw new Error('goals with a rubric need AWS_BEARER_TOKEN_BEDROCK for the judge');
  const spec = await upstream.loadFindingsSpec();
  const primary = judgeMod.DEFAULT_JUDGE_MODEL;
  const fallback = judgeMod.DEFAULT_JUDGE_FALLBACK_MODEL;
  // luna (falling back to sol on an invalid judgement); when luna's requests keep failing, sol.
  judgeRubric = (goal, trace) =>
    judgeAcrossModels(
      (model) =>
        judgeMod.judgeWithFallback({
          spec,
          task: rubricTask(goal),
          trace,
          model,
          fallbackModel: model === primary ? fallback : undefined,
          apiKey,
          region: process.env.BEDROCK_REGION || 'us-west-2',
        }),
      [primary, fallback]
    );
}
// The bare agent's trace is the bench's (screenshots while it works, then its transcript), for
// every agent goal: the judge reads it for rubric goals, and it is kept for review on all.
if (arm.kind === 'agent') {
  const executors = await import(join(SLICC, 'packages/bench/scripts/executors.mjs'));
  leader = executors.createLeader({ url, cli: io.cliPath() });
}

const sh = (command, timeoutMs = 120_000) =>
  io.execOnLeader(url, command, { timeoutMs }).toString('utf8');
const trySh = (command, timeoutMs) => {
  try {
    return { ok: true, out: sh(command, timeoutMs) };
  } catch (e) {
    return { ok: false, out: String(e.message ?? e) };
  }
};
/**
 * One skill run in the leader's shell. Unlike `sh`, a timeout keeps what the command printed, and
 * the CLI's SIGTERM makes it ask the leader to interrupt the command, so it doesn't keep running
 * into the next goal.
 */
function runSkill(command, timeoutMs) {
  const r = spawnSync(io.cliPath(), [url, 'exec', command], {
    timeout: timeoutMs,
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
  });
  // Redacted whole, before anything slices it: a cut could separate /join/ from its token.
  const out = redactSecrets(r.stdout?.toString('utf8') ?? '');
  const err = redactSecrets(r.stderr?.toString('utf8') ?? '');
  const timedOut = r.error?.code === 'ETIMEDOUT';
  const ok = !r.error && r.status === 0;
  const why = timedOut
    ? `timed out after ${timeoutMs / 1000} s`
    : r.error
      ? String(r.error.message)
      : `exit ${r.status}`;
  return { ok, out, timedOut, error: ok ? null : `${why}: ${err.trim().slice(-200)}`.trim() };
}

/** Copy leader files into this run's artifact folder (paths absolute and plain). */
function keepFiles(paths, dir, what) {
  for (const path of paths ?? []) {
    if (typeof path !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..'))
      continue;
    try {
      vfs.readVfsFile(url, path, join(dir, path.replace(/^\//, '').replace(/\//g, '__')), 120_000);
    } catch (e) {
      console.log(`::warning::${what} ${path}: ${e.message}`);
    }
  }
}

/** A CLI verb on the leader (`slicc <url> <verb> …`), like the bench adapter's cli(). */
const cli = (args, { input, timeoutMs = 120_000 } = {}) =>
  spawnSync(io.cliPath(), [url, ...args], {
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SLICC_NO_TUI: '1', NO_COLOR: '1' },
  });
/** One `cost --json --all` reading: spend (bench adapter) and escalation counters. */
const spend = () => {
  const r = trySh('cost --json --all', 60_000);
  return r.ok
    ? { cost: bench.costTotals(r.out), escalations: escalationTotals(r.out) }
    : { cost: null, escalations: null };
};
const tabs = () => tabIds(trySh('playwright-cli tab-list', 60_000).out);

/** VFS readers handed to the adapter's judgeTrace; paths are absolute and plain. */
const safePath = (p) => /^\/[A-Za-z0-9._/-]+$/.test(p) && !p.includes('..');
let readSeq = 0;
function readBytes(path) {
  if (!safePath(path)) throw new Error(`refusing to read ${path}`);
  readSeq += 1;
  const local = join(out, 'tmp', `read-${readSeq}`);
  mkdirSync(join(out, 'tmp'), { recursive: true });
  vfs.readVfsFile(url, path, local, 120_000);
  return readFileSync(local);
}
const vfsReaders = {
  readText: async (path) => readBytes(path).toString('utf8'),
  readBase64: async (path) => readBytes(path).toString('base64'),
  list: async (dir) => {
    if (!safePath(dir)) throw new Error(`refusing to list ${dir}`);
    const r = trySh(`ls -1 ${shellQuote(dir)}`, 60_000);
    return r.ok
      ? r.out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  },
};

/** The bare agent's run as the bench runs it: screenshots while it works, then its transcript. */
async function agentRunWithTrace(g, rep) {
  const tag = `${g.id}-r${rep}`;
  const shotsDir = `/tmp/harness-shots/${tag}`;
  await leader.exec(`rm -rf ${shotsDir} && mkdir -p ${shotsDir}`);
  const shooter = bench.startCapture(leader, shotsDir);
  const t0 = Date.now();
  const r = await leader.cli(['prompt', '--allsettled', '2m', '-'], {
    stdin: agentPrompt(g),
    timeoutMs: timeoutFor(g),
  });
  const shots = await shooter.stop();
  const { images } = await bench.readShots(leader, shots);
  const { doc, info } = await bench.exportTranscript(leader, `/tmp/harness-transcript/${tag}`);
  const trace = bench.traceFromResult({
    transcript: doc,
    transcriptExport: info,
    finalText: (doc && bench.lastConeAssistantText(doc)) || r.stdout,
    screenshots: images,
    exitCode: r.status,
    stderr: r.status !== 0 ? redactSecrets(r.stderr).slice(-300) : '',
    durationMs: Date.now() - t0,
  });
  return { r, trace };
}

mkdirSync(join(out, 'records'), { recursive: true });
mkdirSync(join(out, 'artifacts'), { recursive: true });

if (arm.kind === 'agent') {
  const m = cli(['model', arm.model]);
  if (m.status !== 0)
    throw new Error(`slicc model ${arm.model} failed: ${redactSecrets(m.stderr).slice(-300)}`);
}
// A skill arm's runs only count when escalations can be counted (slicc #3746); stop before
// setup (model downloads) instead of producing runs nobody can trust.
if (arm.kind === 'skill' && !spend().escalations)
  throw new Error(
    'this leader reports no escalation counters (cost --json rows lack `escalations`; needs slicc #3746 in the release), so skill-arm runs could not be validated'
  );
for (const command of arm.setup ?? []) {
  const t0 = Date.now();
  sh(command, 30 * 60_000);
  console.log(`[harness] setup \`${command}\`: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const agentPrompt = (g) =>
  `Open ${g.url} in a new browser tab and do this there: ${g.goal}\nLeave the final page open in that tab when you are done.`;

const results = [];
for (const rep of reps) {
  for (const raw of selectSuites(goals.goals, suites)) {
    const values = await resolvePlaceholders(
      raw,
      typeof adapter.placeholder === 'function' && ((name) => adapter.placeholder(name, { fetch }))
    );
    const g = fillGoal(raw, { now: new Date(), values });
    cli(['new-session', '--erase'], { timeoutMs: 60_000 });
    const before = tabs();
    const costBefore = spend();
    const t0 = Date.now();
    let own = null;
    let runError = null;
    let trace = null;
    let skillOut = null;
    if (arm.kind === 'skill') {
      const r = runSkill(adapter.command(g, arm, { shellQuote }), timeoutFor(g));
      own = typeof adapter.result === 'function' && r.out ? adapter.result(r.out) : null;
      // What the command printed is kept whatever happens (bounded), and its tail goes into
      // the record when the run failed without a result.
      skillOut = r.out;
      if (!r.ok && !own)
        runError = `${r.error}${r.out.trim() ? ` | stdout tail: ${r.out.trim().slice(-300)}` : ''}`;
    } else if (leader) {
      const { r, trace: t } = await agentRunWithTrace(g, rep);
      trace = t;
      if (r.status !== 0)
        runError = `slicc prompt exited ${r.status}: ${redactSecrets(r.stderr).slice(-300)}`;
    } else {
      const r = cli(['prompt', '--allsettled', '2m', '-'], {
        input: agentPrompt(g),
        timeoutMs: timeoutFor(g),
      });
      if (r.status !== 0)
        runError = `slicc prompt exited ${r.status}: ${redactSecrets(r.stderr).slice(-300)}`;
    }
    const seconds = (Date.now() - t0) / 1000;
    const costAfter = spend();
    const delta = bench.spendDelta(costBefore.cost, costAfter.cost);
    const escalations = escalationDelta(costBefore.escalations, costAfter.escalations);
    // One bar for every arm: the skill's judge on each tab the run left open.
    const opened = tabs().filter((id) => !before.includes(id));
    const judged = [];
    let metrics = null;
    for (const id of opened.length ? opened : tabs()) {
      const snap = trySh(`playwright-cli snapshot --tab=${id}`, 60_000);
      // A rubric-only goal has no check: the adapter's judge is never asked (its contract
      // predates optional checks), but the snapshot still feeds metrics.
      judged.push({ tab: id, ok: hasCheck(g) && snap.ok && Boolean(adapter.judge(snap.out, g)) });
      // The adapter's own numbers from the final page (a game's score), the same for every arm.
      if (snap.ok && !metrics && typeof adapter.metrics === 'function')
        metrics = adapter.metrics(snap.out, g) ?? null;
    }
    for (const id of opened) trySh(`playwright-cli tab-close --tab=${id}`, 30_000);
    const runDir = join(out, 'artifacts', arm.id, `${g.id}-r${rep}`);
    if (skillOut) {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'stdout.txt'), skillOut.slice(-2 * 1024 * 1024));
    }
    // The bare agent's own record of what it did (every tool call, cone and scoops), so a
    // reviewer can check how it played: the judge reads the same steps.
    if (arm.kind === 'agent' && Array.isArray(trace?.steps)) {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'transcript.md'), `${trace.steps.join('\n\n')}\n`);
      if (trace.finalResult) writeFileSync(join(runDir, 'final.txt'), `${trace.finalResult}\n`);
    }
    keepFiles(own?.artifacts, runDir, 'artifact');
    // What the skill wants kept from every run, failed ones included (its own log, the latest
    // trace): without it a timeout leaves nothing to debug, since the leader is gone afterwards.
    if (arm.kind === 'skill' && typeof adapter.diagnostics === 'function') {
      try {
        keepFiles(
          await adapter.diagnostics({ goal: g, own, list: vfsReaders.list }),
          runDir,
          'diagnostic'
        );
      } catch (e) {
        console.log(`::warning::diagnostics: ${e.message}`);
      }
    }
    let rubric = null;
    if (judgeRubric && hasRubric(g)) {
      try {
        if (arm.kind === 'skill') {
          if (typeof adapter.judgeTrace !== 'function')
            throw new Error('the adapter has no judgeTrace for a goal with a rubric');
          trace = await adapter.judgeTrace({ goal: g, own, ...vfsReaders });
        }
        const problems = checkTrace(trace);
        if (problems.length) throw new Error(`judge trace: ${problems.join('; ')}`);
        rubric = rubricRecord(await judgeRubric(g, trace));
        // A skill adapter may report its numbers with the trace instead of from the page.
        if (!metrics && arm.kind === 'skill' && trace.metrics) metrics = trace.metrics;
      } catch (e) {
        rubric = {
          credit: null,
          error: redactSecrets(
            `${redactSecrets(e.message ?? e).slice(0, 240)} (trace: ${traceSize(trace)})`
          ),
        };
      }
    }
    const record = {
      skill,
      arm: arm.id,
      kind: arm.kind,
      goal: g.id,
      repeat: rep,
      pass: hasCheck(g) ? judged.some((j) => j.ok) : null,
      self_ok: own && 'ok' in own ? Boolean(own.ok) : null,
      steps: own?.steps ?? null,
      seconds,
      decide_seconds: own?.decideSeconds ?? null,
      cost_usd: delta.costUsd,
      tokens: delta.tokens,
      escalations,
      invalid: invalidReason(arm.kind, escalations),
      rubric,
      metrics,
      tabs_judged: judged,
      error: runError == null ? null : redactSecrets(runError),
      at: new Date().toISOString(),
    };
    writeFileSync(
      join(out, 'records', `${skill}--${arm.id}--${g.id}--r${rep}.json`),
      `${JSON.stringify(record, null, 2)}\n`
    );
    results.push(record);
    console.log(
      `[harness] ${skill}/${arm.id} ${g.id} r${rep}: ${record.pass == null ? 'no check' : record.pass ? 'PASS' : 'fail'} (own ${record.self_ok}) ${seconds.toFixed(0)} s${delta.costUsd == null ? '' : ` $${delta.costUsd.toFixed(3)}`}${rubric ? ` credit ${rubric.credit == null ? `error (${rubric.error})` : `${Math.round(rubric.credit * 100)}%`}` : ''}${record.invalid ? ` INVALID: ${record.invalid}` : ''}${runError ? ` ERROR ${redactSecrets(runError).slice(0, 120)}` : ''}`
    );
  }
}
console.log(
  `[harness] ${skill}/${arm.id}: ${results.filter((r) => r.pass).length}/${results.length} passed`
);
