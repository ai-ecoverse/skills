/**
 * rubric — partial credit for goals that carry a rubric, judged the way the bench judges BU Bench
 * tasks: slicc's packages/bench `judgeWithFallback` (findings per rubric item, gpt-5.6-luna, then
 * gpt-5.6-sol when luna's judgement stays invalid) with the upstream findings prompt, and the
 * bench's `score()` (met weight / total weight).
 *
 * A goal opts in with `rubric` (bench format: "## Source facts …" + "## Items") and `weights`
 * ({ item: positive number }). The deterministic `expect` check still decides `pass`; the rubric
 * adds `credit`. The trace the judge reads comes from the adapter's `judgeTrace` for skill arms,
 * and from the leader's transcript and screenshots for the bare agent arm.
 */

/** Problems with a goal's rubric fields (empty when it has none or they are valid). */
export function validateRubric(goal, at) {
  const has = goal.rubric != null || goal.weights != null;
  if (!has) return [];
  const errors = [];
  if (typeof goal.rubric !== 'string' || !goal.rubric.trim())
    errors.push(`${at}: rubric must be non-empty text when weights are given`);
  const w = goal.weights;
  if (!w || typeof w !== 'object' || Array.isArray(w) || !Object.keys(w).length)
    return [...errors, `${at}: weights must be an object of item → positive number`];
  for (const [id, v] of Object.entries(w)) {
    if (!(Number.isFinite(v) && v > 0))
      errors.push(`${at}: weight ${id} must be a positive number`);
    if (typeof goal.rubric === 'string' && !goal.rubric.includes(id))
      errors.push(`${at}: weight ${id} is not named in the rubric`);
  }
  return errors;
}

export const hasRubric = (goal) => typeof goal.rubric === 'string' && Boolean(goal.weights);

/** The bench task the judge reads: the goal as given to the arm, its site, rubric and weights. */
export function rubricTask(goal) {
  return {
    id: goal.id,
    task: goal.goal,
    website: goal.url,
    rubric: goal.rubric,
    weights: goal.weights,
  };
}

/** A judge trace, checked: the judge reads these fields and nothing else. */
export function checkTrace(trace) {
  const errors = [];
  if (!trace || typeof trace !== 'object') return ['judgeTrace returned no object'];
  if (!Array.isArray(trace.steps) || !trace.steps.every((s) => typeof s === 'string'))
    errors.push('steps must be an array of strings');
  if (typeof (trace.finalResult ?? '') !== 'string') errors.push('finalResult must be a string');
  if (
    !Array.isArray(trace.screenshots) ||
    !trace.screenshots.every(
      (s) => s && typeof s.base64 === 'string' && typeof s.label === 'string'
    )
  )
    errors.push('screenshots must be [{ label, base64, format? }]');
  return errors;
}

/** What a run record keeps of a judgement (never the judge's free text: it can quote the page). */
export function rubricRecord(j) {
  return {
    credit: j.result.score,
    all_met: j.result.verdict,
    statuses: j.result.statuses,
    missing_items: j.result.missing_items,
    rh_zeroed: j.result.rh_zeroed,
    judge: {
      model: j.model,
      images: j.imagesSent,
      usage: j.usage,
      ...(j.repairs ? { repairs: j.repairs } : {}),
      ...(j.fallbackFrom ? { fallback_from: j.fallbackFrom } : {}),
    },
  };
}

/** A judge failure worth another try: a throttle, a 5xx, a dropped connection. */
export const transientJudgeError = (err) =>
  /HTTP (429|5\d\d)|throttl|timed? ?out|ECONNRESET|fetch failed|socket hang up/i.test(
    String(err?.message ?? err)
  );

/**
 * `fn` with retries on transient errors (Bedrock answered HTTP 500 on 3 of 21 judgements in
 * run 37013006178). An invalid judgement is not transient: judgeWithFallback already repairs
 * and falls back for those.
 */
export async function withRetry(
  fn,
  { delays = [15_000, 45_000], sleep, isTransient = transientJudgeError } = {}
) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !isTransient(err)) throw err;
      await wait(delays[attempt]);
    }
  }
}

/**
 * `judgeAs(model)` on each model in turn, each with its transient retries, moving on only when a
 * model keeps failing transiently. Bedrock kept answering 5xx for the same long traces across all
 * three tries (runs 37013006178 and 37038030725: the bike tour and Drug Wars); the bench's
 * fallback judge takes over only an invalid judgement, not a failed request.
 */
export async function judgeAcrossModels(judgeAs, models, retry = {}) {
  let last;
  for (const model of models) {
    try {
      return await withRetry(() => judgeAs(model), retry);
    } catch (err) {
      if (!(retry.isTransient ?? transientJudgeError)(err)) throw err;
      last = err;
    }
  }
  throw last;
}

/** How big a judge trace is, for an error message: steps, characters, screenshots and bytes. */
export function traceSize(trace) {
  const chars = (trace?.steps ?? []).reduce((n, x) => n + String(x).length, 0);
  const shots = trace?.screenshots ?? [];
  const bytes = shots.reduce((n, x) => n + Math.floor((String(x.base64 ?? '').length * 3) / 4), 0);
  return `${trace?.steps?.length ?? 0} steps / ${chars} chars, ${shots.length} screenshots / ${Math.round(bytes / 1024)} KiB`;
}
