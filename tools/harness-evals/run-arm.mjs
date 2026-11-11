#!/usr/bin/env node
import { spawnSync as spawnSyncNode } from 'node:child_process';
import {
  mkdirSync as mkdirSyncNode,
  readFileSync as readFileSyncNode,
  writeFileSync as writeFileSyncNode,
} from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAdapter as loadAdapterDefault } from './adapter.mjs';
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

export async function runArm(envIn = process.env, deps = {}) {
  const env = (k, d) => (envIn[k] ?? d ?? '').trim();
  const spawnSync = deps.spawnSync ?? spawnSyncNode;
  const mkdirSync = deps.mkdirSync ?? mkdirSyncNode;
  const readFileSync = deps.readFileSync ?? readFileSyncNode;
  const writeFileSync = deps.writeFileSync ?? writeFileSyncNode;
  const loadAdapter = deps.loadAdapter ?? loadAdapterDefault;
  const dynamicImport = deps.import ?? ((specifier) => import(specifier));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? console.log;

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
  const shard = Number.parseInt(env('HARNESS_REPEAT'), 10);
  const repeats = Math.max(1, Number.parseInt(env('HARNESS_REPEATS', '1'), 10) || 1);
  const reps = shard >= 1 ? [shard] : Array.from({ length: repeats }, (_, i) => i + 1);
  const out = env('HARNESS_OUT');
  const runTimeoutMs = (Number.parseInt(env('HARNESS_RUN_S', '900'), 10) || 900) * 1000;
  const timeoutFor = (goal) => (goal.timeout_s ? goal.timeout_s * 1000 : runTimeoutMs);

  const io = await dynamicImport(join(SLICC, 'packages/github-workflow/scripts/gh-io.mjs'));
  const vfs = await dynamicImport(join(SLICC, 'packages/github-workflow/scripts/vfs-file.mjs'));
  const bench = await dynamicImport(join(SLICC, 'packages/bench/scripts/slicc-adapter.mjs'));
  const url = io.readState()?.joinUrl;
  if (!url) throw new Error('no leader: start-leader left no join URL');

  const rubricGoals = selectSuites(goals.goals, suites).some(hasRubric);
  let judgeRubric = null;
  let leader = null;
  if (rubricGoals) {
    const judgeMod = await dynamicImport(join(SLICC, 'packages/bench/scripts/judge.mjs'));
    const upstream = await dynamicImport(join(SLICC, 'packages/bench/scripts/upstream.mjs'));
    const apiKey = envIn.AWS_BEARER_TOKEN_BEDROCK || envIn.BEDROCK_API_KEY;
    if (!apiKey) throw new Error('goals with a rubric need AWS_BEARER_TOKEN_BEDROCK for the judge');
    const spec = await upstream.loadFindingsSpec();
    const primary = judgeMod.DEFAULT_JUDGE_MODEL;
    const fallback = judgeMod.DEFAULT_JUDGE_FALLBACK_MODEL;
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
            region: envIn.BEDROCK_REGION || 'us-west-2',
          }),
        [primary, fallback]
      );
  }
  if (arm.kind === 'agent') {
    const executors = await dynamicImport(join(SLICC, 'packages/bench/scripts/executors.mjs'));
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
  function runSkill(command, timeoutMs) {
    const r = spawnSync(io.cliPath(), [url, 'exec', command], {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024 * 1024,
      env: { ...envIn, SLICC_NO_TUI: '1', NO_COLOR: '1' },
    });
    const outText = redactSecrets(r.stdout?.toString('utf8') ?? '');
    const err = redactSecrets(r.stderr?.toString('utf8') ?? '');
    const timedOut = r.error?.code === 'ETIMEDOUT';
    const ok = !r.error && r.status === 0;
    const why = timedOut
      ? `timed out after ${timeoutMs / 1000} s`
      : r.error
        ? String(r.error.message)
        : `exit ${r.status}`;
    return {
      ok,
      out: outText,
      timedOut,
      error: ok ? null : `${why}: ${err.trim().slice(-200)}`.trim(),
    };
  }

  function keepFiles(paths, dir, what) {
    for (const path of paths ?? []) {
      if (typeof path !== 'string' || !/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..'))
        continue;
      try {
        vfs.readVfsFile(
          url,
          path,
          join(dir, path.replace(/^\//, '').replace(/\//g, '__')),
          120_000
        );
      } catch (e) {
        log(`::warning::${what} ${path}: ${e.message}`);
      }
    }
  }

  const cli = (args, { input, timeoutMs = 120_000 } = {}) =>
    spawnSync(io.cliPath(), [url, ...args], {
      input,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...envIn, SLICC_NO_TUI: '1', NO_COLOR: '1' },
    });
  const spend = () => {
    const r = trySh('cost --json --all', 60_000);
    return r.ok
      ? { cost: bench.costTotals(r.out), escalations: escalationTotals(r.out) }
      : { cost: null, escalations: null };
  };
  const tabs = () => tabIds(trySh('playwright-cli tab-list', 60_000).out);

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

  const agentPrompt = (g) =>
    `Open ${g.url} in a new browser tab and do this there: ${g.goal}\nLeave the final page open in that tab when you are done.`;

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
  if (arm.kind === 'skill' && !spend().escalations)
    throw new Error(
      'this leader reports no escalation counters (cost --json rows lack `escalations`; needs slicc #3746 in the release), so skill-arm runs could not be validated'
    );
  for (const command of arm.setup ?? []) {
    const t0 = Date.now();
    sh(command, 30 * 60_000);
    log(`[harness] setup \`${command}\`: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const results = [];
  for (const rep of reps) {
    for (const raw of selectSuites(goals.goals, suites)) {
      const values = await resolvePlaceholders(
        raw,
        typeof adapter.placeholder === 'function' &&
          ((name) => adapter.placeholder(name, { fetch }))
      );
      const g = fillGoal(raw, { now: now(), values });
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
      const opened = tabs().filter((id) => !before.includes(id));
      const judged = [];
      let metrics = null;
      for (const id of opened.length ? opened : tabs()) {
        const snap = trySh(`playwright-cli snapshot --tab=${id}`, 60_000);
        judged.push({ tab: id, ok: hasCheck(g) && snap.ok && Boolean(adapter.judge(snap.out, g)) });
        if (snap.ok && !metrics && typeof adapter.metrics === 'function')
          metrics = adapter.metrics(snap.out, g) ?? null;
      }
      for (const id of opened) trySh(`playwright-cli tab-close --tab=${id}`, 30_000);
      const runDir = join(out, 'artifacts', arm.id, `${g.id}-r${rep}`);
      if (skillOut) {
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'stdout.txt'), skillOut.slice(-2 * 1024 * 1024));
      }
      if (arm.kind === 'agent' && Array.isArray(trace?.steps)) {
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'transcript.md'), `${trace.steps.join('\n\n')}\n`);
        if (trace.finalResult) writeFileSync(join(runDir, 'final.txt'), `${trace.finalResult}\n`);
      }
      keepFiles(own?.artifacts, runDir, 'artifact');
      if (arm.kind === 'skill' && typeof adapter.diagnostics === 'function') {
        try {
          keepFiles(
            await adapter.diagnostics({ goal: g, own, list: vfsReaders.list }),
            runDir,
            'diagnostic'
          );
        } catch (e) {
          log(`::warning::diagnostics: ${e.message}`);
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
        at: now().toISOString(),
      };
      writeFileSync(
        join(out, 'records', `${skill}--${arm.id}--${g.id}--r${rep}.json`),
        `${JSON.stringify(record, null, 2)}\n`
      );
      results.push(record);
      log(
        `[harness] ${skill}/${arm.id} ${g.id} r${rep}: ${record.pass == null ? 'no check' : record.pass ? 'PASS' : 'fail'} (own ${record.self_ok}) ${seconds.toFixed(0)} s${delta.costUsd == null ? '' : ` $${delta.costUsd.toFixed(3)}`}${rubric ? ` credit ${rubric.credit == null ? `error (${rubric.error})` : `${Math.round(rubric.credit * 100)}%`}` : ''}${record.invalid ? ` INVALID: ${record.invalid}` : ''}${runError ? ` ERROR ${redactSecrets(runError).slice(0, 120)}` : ''}`
      );
    }
  }
  log(
    `[harness] ${skill}/${arm.id}: ${results.filter((r) => r.pass).length}/${results.length} passed`
  );
  return results;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runArm();
