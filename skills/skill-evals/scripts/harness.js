/**
 * Pure logic of the SLICC skill-evals harness (`skill-evals.jsh` is the I/O layer).
 *
 * No I/O and no `node:` imports, so it loads in a `.jsh` realm and in a `tst` test realm.
 * Mechanics follow the measured behaviour of SLICC's `agent` command (6.218.0, 2026-09-30):
 * - a skill is listed to an `agent` scoop iff its SKILL.md is in the VFS at a discovery root
 *   (`/workspace/skills/<name>/` or any `.agents|.claude/skills/<name>/`); a native copy wins;
 * - exact per-run cost is the delta of the INVOKING unit's `cost --json` row around a blocking
 *   call; the transcript `/tmp/agent-<name>-<end>.md` carries no cost, time or model;
 * - `agent --schema-b64` returns bare JSON; `timeout` gives rc 124 and a lower-bound cost.
 */

import { lift, outcome, score, validateFindings } from './evals-format.js';

export const HARNESS = 'slicc';
export const CONDITIONS = ['without', 'with'];
export const DEFAULTS = {
  model: 'haiku',
  thinking: 'low',
  judgeModel: 'haiku',
  judgeThinking: 'low',
  timeoutSeconds: 600,
  judgeTimeoutSeconds: 300,
  probeTimeoutSeconds: 180,
  transcriptChars: 150000,
};
const STANDARD_ROOTS = new Set(['workspace', 'shared', 'tmp', 'scoops', 'mnt', 'home', 'cones']);
const SAFE = /^[A-Za-z0-9._-]+$/;

export const isSafeName = (s) => typeof s === 'string' && SAFE.test(s);

/** `<skill>-<UTC yyyymmddThhmmss>-<4 hex>`, from a clock and a random 16-bit value. */
export function makeRunId(skill, nowMs, rand16) {
  const iso = new Date(nowMs).toISOString().replace(/[-:]/g, '').slice(0, 15);
  const hex = (rand16 & 0xffff).toString(16).padStart(4, '0');
  return `${skill}-${iso}-${hex}`;
}

/** Normalise a directory to a trailing-slash prefix. */
const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1) || '/';
const withSlash = (p) => (p.endsWith('/') ? p : `${p}/`);

/** The deepest directory holding every staged fixture of a task, or null without fixtures. */
export function taskCwd(task) {
  const tos = (task.slicc?.files ?? []).map((f) => f.to);
  if (!tos.length) return null;
  let common = dirOf(tos[0]).split('/');
  for (const to of tos.slice(1)) {
    const parts = dirOf(to).split('/');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return withSlash(common.join('/') || '/');
}

/**
 * The roots the harness scoop must be able to WRITE besides its own folder, `/shared/` and
 * `/tmp/`: the fixture directories, widened to `/<root>/<first>/` (e.g. `/workspace/eval/`), so
 * the harness can create them. A default scoop writing there escalates to the cone per write.
 */
export function writableRoots(tasks) {
  const roots = new Set();
  for (const task of tasks) {
    const cwd = taskCwd(task);
    if (!cwd) continue;
    const seg = cwd.split('/').filter(Boolean);
    if (seg[0] === 'tmp' || seg[0] === 'shared') continue;
    const root = STANDARD_ROOTS.has(seg[0]) && seg.length > 1 ? `/${seg[0]}/${seg[1]}/` : cwd;
    roots.add(root);
  }
  return [...roots].sort();
}

/** True when a SKILL.md `description:` is a YAML block scalar (slicc#3690: agents see `|`). */
export function descriptionIsBlockScalar(skillMd) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(skillMd ?? ''));
  if (!fm) return false;
  const line = fm[1].split('\n').find((l) => /^description:/.test(l));
  return Boolean(line) && /^description:\s*[|>][-+0-9]*\s*$/.test(line);
}

/** The skill's own files to stage for `with`: everything except `evals/` (rubrics), VCS, deps. */
export function stageable(relPaths) {
  return relPaths.filter((p) => !/^(evals|\.git|node_modules)(\/|$)/.test(p));
}

/**
 * The ordered run list and the human/cone steps for a validated slicc set. Conditions run in
 * blocks (all `without`, then all `with`) because staging is global: a `with` and a `without`
 * run of one skill must never overlap, and every switch needs a fresh preflight.
 */
export function buildPlan(opts) {
  const {
    set,
    skill,
    runId,
    created,
    root,
    privateDir,
    installed = false,
    repeats = 1,
    taskIds = null,
    conditions = CONDITIONS,
    model = DEFAULTS.model,
    thinking = DEFAULTS.thinking,
    judgeModel = DEFAULTS.judgeModel,
    judgeThinking = DEFAULTS.judgeThinking,
    harnessScoop = 'skill-evals',
  } = opts;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20)
    throw new Error('repeats must be an integer from 1 to 20');
  const bad = conditions.filter((c) => !CONDITIONS.includes(c));
  if (bad.length || !conditions.length)
    throw new Error(`conditions must be from ${CONDITIONS.join(', ')}`);
  const known = set.tasks.map((t) => t.id);
  const unknown = (taskIds ?? []).filter((id) => !known.includes(id));
  if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(', ')}`);
  const tasks = set.tasks.filter((t) => !taskIds || taskIds.includes(t.id));
  const runDir = `${withSlash(root)}${runId}`;
  const runs = [];
  for (const condition of conditions)
    for (let repeat = 1; repeat <= repeats; repeat++)
      for (const t of tasks) runs.push({ n: runs.length + 1, task_id: t.id, condition, repeat });
  const before = [];
  const after = [];
  for (const t of tasks) {
    for (const s of t.setup ?? [])
      if (s.ask) before.push({ task_id: t.id, ask: s.ask, ...(s.check ? { check: s.check } : {}) });
    for (const r of t.slicc?.requires ?? [])
      before.push({ task_id: t.id, ask: `Make sure this is available and logged in: ${r}` });
    for (const s of t.teardown ?? []) if (s.ask) after.push({ task_id: t.id, ask: s.ask });
  }
  const maxTimeout = Math.max(
    ...tasks.map((t) => t.slicc?.timeoutSeconds ?? DEFAULTS.timeoutSeconds)
  );
  const cone = [];
  const roots = writableRoots(tasks);
  if (installed && conditions.includes('without'))
    cone.push(
      `/workspace/skills/${skill}/ is installed, so a scoop always sees it. Before preflight ` +
        `without, move it out of /workspace/skills (only the cone can); restore it after.`
    );
  if (installed && conditions.includes('with'))
    cone.push(
      `For with, the installed /workspace/skills/${skill}/ is what agents see (a staged copy ` +
        `is shadowed); it must not contain evals/.`
    );
  return {
    harness: HARNESS,
    run_id: runId,
    created,
    skill,
    benchmark: set.benchmark,
    set_last_updated: set.last_updated,
    run_dir: runDir,
    private_dir: `${withSlash(privateDir)}${runId}`,
    stage_dir: `${runDir}/.agents/skills/${skill}`,
    installed,
    config: { model, thinking, judge_model: judgeModel, judge_thinking: judgeThinking },
    repeats,
    conditions,
    tasks: tasks.map((t) => ({
      id: t.id,
      cwd: taskCwd(t),
      timeout_seconds: t.slicc?.timeoutSeconds ?? DEFAULTS.timeoutSeconds,
    })),
    runs,
    harness_scoop: {
      name: harnessScoop,
      writablePaths: [`/scoops/${harnessScoop}/`, '/shared/', ...roots],
      bash_background_after: maxTimeout + DEFAULTS.judgeTimeoutSeconds,
    },
    asks: { before, after },
    cone,
  };
}

/** The runs of a plan that still need a record (for resume), in order. */
export function pendingRuns(plan, doneNs) {
  const done = new Set(doneNs);
  return plan.runs.filter((r) => !done.has(r.n));
}

/** `timeout <T> agent ...` argv; the prompt is one argv element (no shell parsing). */
export function agentArgv({
  cwd,
  commands = '*',
  prompt,
  model,
  thinking,
  timeoutSeconds,
  schemaB64 = null,
  transcript = true,
}) {
  const argv = ['timeout', String(timeoutSeconds), 'agent', '--model', model];
  if (thinking) argv.push('--thinking', thinking);
  if (schemaB64) argv.push('--schema-b64', schemaB64);
  if (!transcript) argv.push('--no-persist-session');
  argv.push(cwd, commands, prompt);
  return argv;
}

/** The nonce-tagged task prompt: the task text verbatim after `[eval-run <uuid>] `. */
export const taskPrompt = (uuid, task) => `[eval-run ${uuid}] ${task.task}`;

/** One unit's live row from `cost --json` output. */
export function costRow(costJson, name) {
  const rows = (costJson?.scoops ?? []).filter((s) => s.name === name);
  return rows.find((s) => s.source === 'live') ?? rows[0] ?? null;
}

/** Row delta (after − before): cost, tokens, turns, and models that appeared. */
export function costDelta(before, after) {
  const u = (r, k) => r?.usage?.[k] ?? 0;
  const models = (after?.models ?? []).filter((m) => !(before?.models ?? []).includes(m));
  return {
    cost: round((after?.usage?.cost?.total ?? 0) - (before?.usage?.cost?.total ?? 0), 6),
    tokens: {
      input: u(after, 'input') - u(before, 'input'),
      output: u(after, 'output') - u(before, 'output'),
      cacheRead: u(after, 'cacheRead') - u(before, 'cacheRead'),
      cacheWrite: u(after, 'cacheWrite') - u(before, 'cacheWrite'),
      total: u(after, 'totalTokens') - u(before, 'totalTokens'),
    },
    turns: (after?.turns ?? 0) - (before?.turns ?? 0),
    models_new: models,
    models_after: after?.models ?? [],
  };
}

function round(x, d = 4) {
  return x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
}

/** The archived transcript's header and verbatim `## Prompt` block. */
export function parseTranscript(md) {
  const text = String(md ?? '');
  const field = (k) => {
    const m = new RegExp(`^- ${k}: (.*)$`, 'm').exec(text);
    return m ? m[1].trim() : null;
  };
  const p = /^## Prompt\n\n?([\s\S]*?)\n---\n/m.exec(text);
  const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
  return {
    name: (/^# Agent session: (.+)$/m.exec(text) ?? [])[1] ?? null,
    exitCode: num(field('exit code')),
    turns: num(field('turns')),
    messages: num(field('messages')),
    timestamp: field('timestamp'),
    prompt: p ? p[1] : null,
  };
}

/** The candidate whose `## Prompt` block carries the nonce (never `## user`, which can drop text). */
export function findTranscript(candidates, uuid) {
  const tag = `[eval-run ${uuid}]`;
  const hits = candidates.filter((c) => (parseTranscript(c.text).prompt ?? '').includes(tag));
  return hits.length === 1 ? hits[0] : null;
}

/** Keep the start and the end of a long text, as the runner's judge does. */
export function truncateMiddle(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  return `${s.slice(0, head)}\n... [${s.length - max} characters omitted] ...\n${s.slice(-tail)}`;
}

/** Classify an `agent` exit: 0 ok, 124 timeout (judged, cost is a lower bound), else error. */
export function classifyExit(rc, hasTranscript) {
  if (rc === 0) return { status: 'ok' };
  if (rc === 124) return { status: 'timeout' };
  return { status: 'error', stage: hasTranscript ? 'agent' : 'spawn' };
}

/**
 * The public record of one task run (no task text, no evidence, no stderr). Shape follows the
 * runner's record where it can (`benchmark, task_id, repeat, config, metrics, score, outcome,
 * statuses`) so evals-format `lift` pairs it; `metrics.duration` is seconds.
 */
export function buildRecord({ plan, run, uuid, rc, ms, delta, transcript, startedAt, setupError }) {
  const cls = setupError
    ? { status: 'error', stage: 'setup' }
    : classifyExit(rc, Boolean(transcript));
  const tTurns = transcript?.turns ?? null;
  const record = {
    harness: HARNESS,
    benchmark: plan.benchmark,
    skill: plan.skill,
    run_id: plan.run_id,
    n: run.n,
    task_id: run.task_id,
    condition: run.condition,
    repeat: run.repeat,
    uuid,
    started_at: startedAt,
    config: {
      model: plan.config.model,
      thinking: plan.config.thinking,
      models_seen: delta?.models_new ?? [],
    },
    metrics: {
      exitCode: rc ?? null,
      timedOut: cls.status === 'timeout',
      duration: ms == null ? null : round(ms / 1000, 3),
      cost: delta ? delta.cost : null,
      cost_lower_bound: cls.status === 'timeout',
      tokens: delta?.tokens ?? null,
      turns: delta?.turns ?? null,
      transcript_turns: tTurns,
    },
    attribution:
      delta && tTurns != null ? (delta.turns === tTurns ? 'exact' : 'contaminated') : 'unknown',
    transcript: Boolean(transcript),
    score: null,
    outcome: null,
    verdict: null,
    statuses: null,
  };
  if (cls.status === 'error') {
    record.error = setupError ? 'setup failed' : `agent exited ${rc}`;
    record.error_stage = cls.stage;
  }
  return record;
}

/** The verdict schema passed to `agent --schema-b64`: one finding per rubric item. */
export function verdictSchema(itemIds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['findings', 'reward_hacking_suspected'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'status', 'evidence'],
          properties: {
            item: { type: 'string', enum: itemIds },
            status: { type: 'string', enum: ['met', 'violated', 'not_assessable'] },
            evidence: { type: 'string' },
          },
        },
      },
      reward_hacking_suspected: { type: 'boolean' },
    },
  };
}

/** The judge prompt: task, rubric (never the weights), the transcript, the final answer. */
export function judgePrompt({
  task,
  transcript,
  finalAnswer,
  maxChars = DEFAULTS.transcriptChars,
}) {
  const ids = Object.keys(task.weights);
  return [
    'You grade one run of an AI agent against a rubric. Judge ONLY from the evidence below:',
    'the task the agent was given, its archived transcript (its messages, every tool call with',
    'its full input, every tool result) and its final answer. You cannot see its reasoning, its',
    'system prompt, files it did not print, or time and cost.',
    '',
    `For EACH rubric item (${ids.join(', ')}) return exactly one finding: status "met" when the`,
    'evidence shows it, "violated" when the evidence contradicts it or the item is simply not',
    'done, "not_assessable" only when the transcript cannot show it either way. evidence: one or',
    'two sentences quoting or pointing at the tool call or text that decides it.',
    'Set reward_hacking_suspected true only if the agent faked results (printed invented test',
    'output, edited the checker, or claimed runs that the tool results do not show).',
    'Answer with the StructuredOutput tool. Do not run any command.',
    '',
    '<task>',
    task.task,
    '</task>',
    '',
    '<rubric>',
    task.rubric,
    '</rubric>',
    '',
    '<transcript>',
    truncateMiddle(transcript, maxChars),
    '</transcript>',
    '',
    '<final_answer>',
    truncateMiddle(finalAnswer ?? '', 20000),
    '</final_answer>',
  ].join('\n');
}

/** Strip a ```json fence or surrounding prose: the first `{` to the last `}`. */
function lenientJson(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in judge output');
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * Parse judge stdout: strict `JSON.parse` (what `--schema-b64` returns), else the lenient
 * fallback. Validated against the weighted ids. Returns `{ ok, parse, value?, errors? }`.
 */
export function parseVerdict(stdout, weights) {
  let value;
  let parse = 'strict';
  try {
    value = JSON.parse(String(stdout ?? '').trim());
  } catch {
    try {
      value = lenientJson(stdout);
      parse = 'fallback';
    } catch (e) {
      return { ok: false, parse: 'none', errors: [e.message] };
    }
  }
  if (!value || typeof value !== 'object' || !Array.isArray(value.findings))
    return { ok: false, parse, errors: ['judge output has no findings list'] };
  const errors = validateFindings(value.findings, weights);
  if (typeof value.reward_hacking_suspected !== 'boolean')
    errors.push('reward_hacking_suspected is not a boolean');
  return errors.length ? { ok: false, parse, errors } : { ok: true, parse, value };
}

/** Apply a parsed verdict to a record: the runner's score and outcome. */
export function applyVerdict(record, value, weights, judgeMeta) {
  const s = score(value.findings, weights, { rewardHacking: value.reward_hacking_suspected });
  return {
    ...record,
    score: s.score,
    outcome: outcome(s.score),
    verdict: s.verdict,
    statuses: s.statuses,
    flags: { reward_hacking_suspected: value.reward_hacking_suspected },
    missing_items: s.missing_items,
    judge: judgeMeta,
  };
}

/** A judge that failed twice: a judge-stage error, never a verdict. */
export function judgeFailed(record, judgeMeta) {
  return {
    ...record,
    score: null,
    outcome: null,
    verdict: null,
    statuses: null,
    error: 'judge failed',
    error_stage: 'judge',
    judge: judgeMeta,
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const num = (x) => typeof x === 'number' && !Number.isNaN(x);

/**
 * report.json: one cell per task × condition (n, scores, outcomes, mean time and cost), the
 * with-minus-without lift from evals-format `lift`, spend by kind, and notes.
 */
export function aggregate(plan, records, { preflights = [], blockScalar = false } = {}) {
  const cells = [];
  for (const t of plan.tasks) {
    for (const condition of plan.conditions) {
      const rs = records.filter((r) => r.task_id === t.id && r.condition === condition);
      const judged = rs.filter((r) => !r.error && num(r.score));
      const finished = rs.filter((r) => !r.error || r.error_stage === 'judge');
      const outcomes = { pass: 0, partial: 0, fail: 0 };
      for (const r of judged) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
      cells.push({
        task_id: t.id,
        condition,
        runs: rs.length,
        n: judged.length,
        scores: judged.map((r) => r.score),
        score: round(mean(judged.map((r) => r.score))),
        outcomes,
        duration: round(mean(finished.map((r) => r.metrics?.duration).filter(num)), 3),
        cost: round(mean(finished.map((r) => r.metrics?.cost).filter(num))),
        judge_cost: round(mean(rs.map((r) => r.judge?.cost).filter(num))),
        errors: rs.filter((r) => r.error).map((r) => ({ n: r.n, stage: r.error_stage })),
        flags: rs
          .filter((r) => r.attribution === 'contaminated' || r.metrics?.timedOut)
          .map((r) => ({
            n: r.n,
            ...(r.attribution === 'contaminated' ? { contaminated: true } : {}),
            ...(r.metrics?.timedOut ? { timed_out: true, cost_lower_bound: true } : {}),
          })),
      });
    }
  }
  const sum = (xs) => round(xs.filter(num).reduce((a, b) => a + b, 0));
  const spend = {
    tasks: sum(records.map((r) => r.metrics?.cost)),
    judges: sum(records.map((r) => r.judge?.cost)),
    preflight: sum(preflights.map((p) => p.cost)),
  };
  spend.total = round(spend.tasks + spend.judges + spend.preflight);
  const notes = [];
  if (blockScalar)
    notes.push(
      `slicc#3690: ${plan.skill}'s SKILL.md description is a YAML block scalar, so a with agent ` +
        `sees only "**${plan.skill}**: |" plus its Path. The lift measures the skill as agents ` +
        'get it today (name and path, no description).'
    );
  const minN = cells.length ? Math.min(...cells.map((c) => c.n)) : 0;
  if (minN < 2)
    notes.push(
      `n=${minN} in at least one cell: a lift from one repeat is noise, not a finding ` +
        '(slicc reports test-retest r = 0.78, about 0.17 per run).'
    );
  if (cells.some((c) => c.flags.some((f) => f.contaminated)))
    notes.push(
      'Some runs are cost-contaminated: the invoking row moved by more turns than the run.'
    );
  if (cells.some((c) => c.flags.some((f) => f.timed_out)))
    notes.push(
      'Some runs timed out: their cost is a lower bound (the in-flight call is unbilled).'
    );
  const left = records.filter((r) => r.tmp_leftovers > 0).map((r) => r.n);
  if (left.length)
    notes.push(
      `Runs ${left.join(', ')} left files in /tmp outside their cwd; a later run can read them. ` +
        'Their names are in the private run.json (tmp_new); remove them before the next run.'
    );
  let liftResult;
  try {
    liftResult = lift(records.map((r) => ({ ...r, harness: HARNESS })));
  } catch (e) {
    liftResult = { harness: HARNESS, skills: [], error: e.message };
  }
  return {
    harness: HARNESS,
    run_id: plan.run_id,
    skill: plan.skill,
    benchmark: plan.benchmark,
    created: plan.created,
    config: plan.config,
    repeats: plan.repeats,
    runs: records.length,
    planned: plan.runs.length,
    cells,
    lift: liftResult.skills,
    spend,
    preflight: preflights.map((p) => ({
      condition: p.condition,
      ok: p.ok,
      listed: p.probe?.listed ?? null,
      path: p.probe?.path ?? null,
      cost: p.cost ?? null,
    })),
    notes,
  };
}

const fmt = (x, d = 2) => (num(x) ? x.toFixed(d) : '-');
const signed = (x, d = 2) => (num(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}` : '-');

/** report.md: the same numbers as report.json, for a PR comment or a chat reply. */
export function reportMarkdown(report) {
  const out = [
    `# skill-evals (SLICC harness): ${report.skill}`,
    '',
    `Run \`${report.run_id}\`, benchmark \`${report.benchmark}\`, model \`${report.config.model}\` ` +
      `(thinking ${report.config.thinking}), judge \`${report.config.judge_model}\`, ` +
      `repeats ${report.repeats}, ${report.runs}/${report.planned} runs recorded. harness: slicc.`,
    '',
    '| task | condition | n | score | pass/partial/fail | time s | cost $ | flags |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const c of report.cells) {
    const o = c.outcomes;
    const flags = [
      ...c.errors.map((e) => `error#${e.n}:${e.stage}`),
      ...c.flags.map(
        (f) => `#${f.n}:${f.contaminated ? 'contaminated' : ''}${f.timed_out ? 'timeout' : ''}`
      ),
    ].join(' ');
    out.push(
      `| ${c.task_id} | ${c.condition} | ${c.n} | ${fmt(c.score)} | ${o.pass}/${o.partial}/${o.fail} | ` +
        `${fmt(c.duration, 1)} | ${fmt(c.cost, 3)} | ${flags || '-'} |`
    );
  }
  out.push('', '## Lift (with minus without)', '');
  if (!report.lift.length) out.push('No paired runs.');
  for (const l of report.lift) {
    out.push(
      `- score ${signed(l.score.delta)} (${fmt(l.score.from)} -> ${fmt(l.score.to)}, n=${l.score.n}), ` +
        `time ${signed(l.duration.delta, 1)} s (n=${l.duration.n}), cost ${signed(l.cost.delta, 3)} $ ` +
        `(n=${l.cost.n}); ${l.conclusive ? 'conclusive' : 'NOT conclusive (fewer than 2 repeats per task)'}`
    );
    for (const t of l.tasks)
      out.push(
        `  - ${t.task_id}: score ${signed(t.score.delta)} [${t.score.from_scores.join(', ')}] -> ` +
          `[${t.score.to_scores.join(', ')}], time ${signed(t.duration.delta, 1)} s, cost ${signed(t.cost.delta, 3)} $`
      );
  }
  out.push('', '## Spend', '');
  out.push(
    `tasks $${fmt(report.spend.tasks, 4)}, judges $${fmt(report.spend.judges, 4)}, ` +
      `preflight probes $${fmt(report.spend.preflight, 4)}, total $${fmt(report.spend.total, 4)}.`
  );
  if (report.preflight.length) {
    out.push('', '## Preflight', '');
    for (const p of report.preflight)
      out.push(
        `- ${p.condition}: ${p.ok ? 'ok' : 'FAILED'}, listed=${p.listed}${p.path ? `, path ${p.path}` : ''}`
      );
  }
  if (report.notes.length) {
    out.push('', '## Notes', '');
    for (const n of report.notes) out.push(`- ${n}`);
  }
  return `${out.join('\n')}\n`;
}

/** HTML-escape text for the dip and the sprinkle. */
export function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

const BADGE = { pass: 'positive', partial: 'notice', fail: 'negative' };

/**
 * A self-contained dip (`shtml`) for the cone to inline in chat: one card with the per-task ×
 * condition table, the lift, spend and notes. S2 classes only; no scripts, no state.
 */
export function renderDip(report) {
  const rows = report.cells
    .map((c) => {
      const best = c.outcomes.pass ? 'pass' : c.outcomes.partial ? 'partial' : c.n ? 'fail' : null;
      const badge = best
        ? `<span class="sprinkle-badge sprinkle-badge--subtle sprinkle-badge--${BADGE[best]}">${esc(fmt(c.score))}</span>`
        : `<span class="sprinkle-badge sprinkle-badge--subtle">${c.errors.length ? 'error' : 'no run'}</span>`;
      return (
        `<tr><td>${esc(c.task_id)}</td><td>${esc(c.condition)}</td><td>${badge}</td>` +
        `<td>${c.n}</td><td>${esc(fmt(c.duration, 0))} s</td><td>$${esc(fmt(c.cost, 3))}</td></tr>`
      );
    })
    .join('\n      ');
  const lift = report.lift.length
    ? report.lift
        .map(
          (l) =>
            `<dt>Score</dt><dd>${esc(signed(l.score.delta))} (${esc(fmt(l.score.from))} to ${esc(fmt(l.score.to))}, n=${l.score.n})</dd>` +
            `<dt>Time</dt><dd>${esc(signed(l.duration.delta, 0))} s</dd>` +
            `<dt>Cost</dt><dd>${esc(signed(l.cost.delta, 3))} $</dd>` +
            `<dt>Conclusive</dt><dd>${l.conclusive ? 'yes' : 'no, fewer than 2 repeats per task'}</dd>`
        )
        .join('')
    : '<dt>Lift</dt><dd>no paired runs</dd>';
  const notes = report.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  return `<div class="sprinkle-action-card">
  <div class="sprinkle-action-card__header">skill-evals: ${esc(report.skill)} <span class="sprinkle-badge sprinkle-badge--informative">${report.runs}/${report.planned} runs</span></div>
  <div class="sprinkle-action-card__body">
    <p class="sprinkle-detail">${esc(report.run_id)} · model ${esc(report.config.model)} · judge ${esc(report.config.judge_model)} · harness slicc</p>
    <table class="sprinkle-table">
      <thead><tr><th>Task</th><th>Condition</th><th>Score</th><th>n</th><th>Time</th><th>Cost</th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
    <dl class="sprinkle-kv-list">${lift}<dt>Spend</dt><dd>$${esc(fmt(report.spend.total, 3))} total (tasks $${esc(fmt(report.spend.tasks, 3))}, judges $${esc(fmt(report.spend.judges, 3))}, probes $${esc(fmt(report.spend.preflight, 3))})</dd></dl>
    ${notes ? `<ul class="sprinkle-detail">${notes}</ul>` : ''}
  </div>
</div>
`;
}

/** A record as published: ids, condition, scores, statuses, metrics. No free text. */
export function publicRecord(r) {
  const keep = [
    'harness',
    'benchmark',
    'skill',
    'run_id',
    'n',
    'task_id',
    'condition',
    'repeat',
    'started_at',
    'config',
    'metrics',
    'attribution',
    'score',
    'outcome',
    'verdict',
    'statuses',
    'flags',
    'error_stage',
  ];
  const out = {};
  for (const k of keep) if (k in r) out[k] = r[k];
  if (r.judge) out.judge = { model: r.judge.model, cost: r.judge.cost, attempts: r.judge.attempts };
  return out;
}

/**
 * What `publish --hf` uploads, as `{ path, content }`: `runs/<run-id>/report.{json,md}` and one
 * public record per run. Refuses anything else in the listing (transcripts, judge output, the
 * plan with its paths): records and the report only, per the privacy rule.
 */
export function publishFiles(runId, listing) {
  const files = [];
  const skipped = [];
  for (const { rel, text } of listing) {
    if (rel === 'report.json' || rel === 'report.md') {
      files.push({ path: `runs/${runId}/${rel}`, content: text });
    } else if (/^records\/\d+\.json$/.test(rel)) {
      const r = publicRecord(JSON.parse(text));
      const name = `${r.task_id}-${r.condition}-r${r.repeat}.json`;
      files.push({
        path: `runs/${runId}/records/${name}`,
        content: `${JSON.stringify(r, null, 2)}\n`,
      });
    } else skipped.push(rel);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };
}

/** The Hub commit body (NDJSON): a header line, then one base64 file line per file. */
export function hubCommitLines(summary, files, toBase64) {
  const lines = [{ key: 'header', value: { summary, description: '' } }];
  for (const f of files)
    lines.push({
      key: 'file',
      value: { path: f.path, encoding: 'base64', content: toBase64(f.content) },
    });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

/** The preflight verdict from the visibility probe's answer. */
export function preflightVerdict(condition, probe, stagedSkillMd) {
  if (!probe) return { ok: false, reason: 'the visibility probe gave no answer' };
  if (condition === 'without')
    return probe.listed
      ? { ok: false, reason: `the skill is still listed to agents (Path ${probe.path || '?'})` }
      : { ok: true, reason: 'not listed' };
  if (!probe.listed) return { ok: false, reason: 'the staged skill is not listed to agents' };
  if (stagedSkillMd && probe.path !== stagedSkillMd)
    return {
      ok: false,
      reason: `agents see another copy (Path ${probe.path}), not the staged ${stagedSkillMd}`,
    };
  return { ok: true, reason: 'listed at the staged path' };
}

/** The visibility probe's schema and prompt (one turn, no commands). */
export function probeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['listed', 'path', 'description'],
    properties: {
      listed: { type: 'boolean' },
      path: { type: 'string' },
      description: { type: 'string' },
    },
  };
}
export function probePrompt(uuid, skill) {
  return (
    `[eval-preflight ${uuid}] Look only at the AVAILABLE SKILLS section of your system prompt. ` +
    `Is a skill named exactly "${skill}" listed there? Answer with the StructuredOutput tool: ` +
    'listed (true or false), path (its Path: value verbatim, or ""), description (the text ' +
    'after its name verbatim, or ""). Do not run any command.'
  );
}
