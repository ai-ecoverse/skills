#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../test/integration/kernel.mjs';
import { loadAdapter } from './adapter.mjs';
import { escalationDelta, invalidReason } from './escalations.mjs';
import { bootKernelSession } from './kernel-session.mjs';
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

const envGet = (env, k, d) => (env[k] ?? d ?? '').trim();

export async function runArm(env = process.env, deps = {}) {
  const root = deps.REPO_ROOT ?? REPO_ROOT;
  const sessionBoot = deps.bootKernelSession ?? bootKernelSession;
  const load = deps.loadAdapter ?? loadAdapter;
  const skillDir =
    envGet(env, 'HARNESS_SKILL_DIR') || join(root, 'skills', envGet(env, 'HARNESS_SKILL'));
  const skill = basename(skillDir);
  const { adapter, goalsPath } = await load(skillDir);
  const arm = adapter.arms.find((a) => a.id === envGet(env, 'HARNESS_ARM_ID'));
  if (!arm) throw new Error(`${skill} has no arm ${envGet(env, 'HARNESS_ARM_ID')}`);
  const goals = JSON.parse(readFileSync(goalsPath, 'utf8'));
  const suites = parseSuites(envGet(env, 'HARNESS_SUITES'));
  const goalErrors = validateGoals(goals);
  if (goalErrors.length) throw new Error(`${goalsPath}: ${goalErrors.join('; ')}`);
  const shard = Number.parseInt(envGet(env, 'HARNESS_REPEAT'), 10);
  const repeats = Math.max(1, Number.parseInt(envGet(env, 'HARNESS_REPEATS', '1'), 10) || 1);
  const reps = shard >= 1 ? [shard] : Array.from({ length: repeats }, (_, i) => i + 1);
  const out = envGet(env, 'HARNESS_OUT') || join(root, 'artifacts', 'harness-out');
  const runTimeoutMs = (Number.parseInt(envGet(env, 'HARNESS_RUN_S', '900'), 10) || 900) * 1000;
  const timeoutFor = (goal) => (goal.timeout_s ? goal.timeout_s * 1000 : runTimeoutMs);
  const smoke = envGet(env, 'HARNESS_SMOKE') === '1' || envGet(env, 'HARNESS_SMOKE') === 'true';

  const inject = arm.kind === 'agent' ? [] : [skill, ...(arm.skills ?? [])];
  const session = await sessionBoot({
    skills: inject,
    skillsDir: join(root, 'skills'),
    artifacts: join(out, 'kernel'),
  });

  const { sh, trySh, runSkill, keepFiles, vfsReaders, spend, spendDelta, stop } = session;

  let judgeRubric = null;
  const rubricGoals = selectSuites(goals.goals, suites).some(hasRubric);
  if (rubricGoals && !smoke) {
    const slicc = envGet(env, 'HARNESS_SLICC');
    if (!slicc || !existsSync(join(slicc, 'packages/bench/scripts/judge.mjs'))) {
      await stop();
      throw new Error(
        'goals with a rubric need HARNESS_SLICC pointing at a slicc checkout with packages/bench'
      );
    }
    const judgeMod = await import(
      pathToFileURL(join(slicc, 'packages/bench/scripts/judge.mjs')).href
    );
    const upstream = await import(
      pathToFileURL(join(slicc, 'packages/bench/scripts/upstream.mjs')).href
    );
    const apiKey = env.AWS_BEARER_TOKEN_BEDROCK || env.BEDROCK_API_KEY;
    if (!apiKey) {
      await stop();
      throw new Error('goals with a rubric need AWS_BEARER_TOKEN_BEDROCK for the judge');
    }
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
            region: env.BEDROCK_REGION || 'us-west-2',
          }),
        [primary, fallback],
        deps.judgeRetry ?? {}
      );
  }

  mkdirSync(join(out, 'records'), { recursive: true });
  mkdirSync(join(out, 'artifacts'), { recursive: true });

  if (arm.kind === 'agent' && !smoke) {
    await stop();
    throw new Error(
      'agent arms need the SLICC product cone (sliccy:agent / slicc prompt); the kernel harness runs skill arms only'
    );
  }

  if (arm.kind === 'skill' && !spend().escalations) {
    await stop();
    throw new Error('kernel session reports no escalation counters');
  }

  for (const command of arm.setup ?? []) {
    if (smoke) {
      console.log(`[harness] smoke: skip setup \`${command}\``);
      continue;
    }
    const t0 = Date.now();
    await sh(command, 30 * 60_000);
    console.log(`[harness] setup \`${command}\`: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  const agentPrompt = (g) =>
    `Open ${g.url} in a new browser tab and do this there: ${g.goal}\nLeave the final page open in that tab when you are done.`;

  const results = [];
  try {
    const selected = smoke
      ? selectSuites(goals.goals, suites).slice(0, 1)
      : selectSuites(goals.goals, suites);
    for (const rep of smoke ? [1] : reps) {
      for (const raw of selected) {
        const values = await resolvePlaceholders(
          raw,
          typeof adapter.placeholder === 'function' &&
            ((name) => adapter.placeholder(name, { fetch }))
        );
        const g = fillGoal(raw, { now: new Date(), values });
        const before = tabIds((await trySh('playwright-cli tab-list', 60_000)).out);
        const costBefore = spend();
        const t0 = Date.now();
        let own = null;
        let runError = null;
        let trace = null;
        let skillOut = null;
        if (arm.kind === 'skill' && smoke) {
          const probe = await trySh('true', 30_000);
          skillOut = probe.ok ? 'smoke ok\n' : probe.out;
          if (!probe.ok) runError = probe.out;
          own = { ok: probe.ok, steps: 0, decideSeconds: 0 };
        } else if (arm.kind === 'skill') {
          const r = await runSkill(adapter.command(g, arm, { shellQuote }), timeoutFor(g));
          own = typeof adapter.result === 'function' && r.out ? adapter.result(r.out) : null;
          skillOut = r.out;
          if (!r.ok && !own)
            runError = `${r.error}${r.out.trim() ? ` | stdout tail: ${r.out.trim().slice(-300)}` : ''}`;
        } else {
          runError = `agent arm unsupported on kernel harness: ${agentPrompt(g).slice(0, 80)}`;
        }
        const seconds = (Date.now() - t0) / 1000;
        const costAfter = spend();
        const delta = spendDelta(costBefore.cost, costAfter.cost);
        const escalations = escalationDelta(costBefore.escalations, costAfter.escalations);
        const afterTabs = tabIds((await trySh('playwright-cli tab-list', 60_000)).out);
        const opened = afterTabs.filter((id) => !before.includes(id));
        const judged = [];
        let metrics = null;
        for (const id of opened.length ? opened : afterTabs) {
          const snap = await trySh(`playwright-cli snapshot --tab=${id}`, 60_000);
          judged.push({
            tab: id,
            ok: !smoke && hasCheck(g) && snap.ok && Boolean(adapter.judge(snap.out, g)),
          });
          if (snap.ok && !metrics && typeof adapter.metrics === 'function')
            metrics = adapter.metrics(snap.out, g) ?? null;
        }
        for (const id of opened) await trySh(`playwright-cli tab-close --tab=${id}`, 30_000);
        const runDir = join(out, 'artifacts', arm.id, `${g.id}-r${rep}`);
        if (skillOut) {
          mkdirSync(runDir, { recursive: true });
          writeFileSync(join(runDir, 'stdout.txt'), skillOut.slice(-2 * 1024 * 1024));
        }
        await keepFiles(own?.artifacts, runDir, 'artifact');
        if (arm.kind === 'skill' && !smoke && typeof adapter.diagnostics === 'function') {
          try {
            await keepFiles(
              await adapter.diagnostics({ goal: g, own, list: vfsReaders.list }),
              runDir,
              'diagnostic'
            );
          } catch (e) {
            console.log(`::warning::diagnostics: ${e.message}`);
          }
        }
        let rubric = null;
        if (judgeRubric && hasRubric(g) && !smoke) {
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
          pass: smoke ? true : hasCheck(g) ? judged.some((j) => j.ok) : null,
          self_ok: own && 'ok' in own ? Boolean(own.ok) : null,
          steps: own?.steps ?? null,
          seconds,
          decide_seconds: own?.decideSeconds ?? null,
          cost_usd: delta.costUsd,
          tokens: delta.tokens,
          escalations,
          invalid: smoke ? null : invalidReason(arm.kind, escalations),
          rubric,
          metrics,
          tabs_judged: judged,
          error: runError == null ? null : redactSecrets(runError),
          at: new Date().toISOString(),
          ...(smoke ? { smoke: true } : {}),
        };
        writeFileSync(
          join(out, 'records', `${skill}--${arm.id}--${g.id}--r${rep}.json`),
          `${JSON.stringify(record, null, 2)}\n`
        );
        results.push(record);
        console.log(
          `[harness] ${skill}/${arm.id} ${g.id} r${rep}: ${record.pass == null ? 'no check' : record.pass ? 'PASS' : 'fail'} (own ${record.self_ok}) ${seconds.toFixed(0)} s${delta.costUsd == null ? '' : ` $${delta.costUsd.toFixed(3)}`}${rubric ? ` credit ${rubric.credit == null ? `error (${rubric.error})` : `${Math.round(rubric.credit * 100)}%`}` : ''}${record.invalid ? ` INVALID: ${record.invalid}` : ''}${runError ? ` ERROR ${redactSecrets(runError).slice(0, 120)}` : ''}`
        );
        if (smoke) break;
      }
      if (smoke) break;
    }
    console.log(
      `[harness] ${skill}/${arm.id}: ${results.filter((r) => r.pass).length}/${results.length} passed`
    );
  } finally {
    await stop();
  }
  return results;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await runArm();
