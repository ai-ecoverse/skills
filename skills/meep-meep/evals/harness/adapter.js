// The adapter's logic, as a CommonJS module: tst in a SLICC leader cannot
// load an .mjs file, even through import() ("Unexpected token 'export'",
// live self-test on #423, 2026-10-02). harness.mjs re-exports it for the
// driver, which imports harness.mjs.

/**
 * meep-meep's harness-evals adapter (driven by tools/harness-evals): the goals in goals.json,
 * run by webrunner with each decider, and by the bare agent, all judged by `judge` below.
 *
 * `judge` is deliberately self-contained instead of importing scripts/page.js: it is the
 * yardstick, so a change to webrunner's own check cannot change how its runs are graded, and a
 * stacked PR comparing an older webrunner judges with the same code.
 */

const AGENT_MODEL = 'claude-sonnet-5-5';
const kevArm = (id, model, args) => ({
  id,
  kind: 'skill',
  pool: 'gpu',
  skills: ['decide-quickly'],
  setup: [`kev pull --model ${model}`],
  args,
});

// The realistic configuration is always hybrid: a kev vision bundle as
// System 1 and System 2 at its default, claude-sonnet-5-5 with thinking low.
// --require-gpu: a leader whose worker gets SwiftShader instead of the GPU
// fails at once with that reason, instead of timing out at ~10x slower.
const hybridArm = (model) =>
  kevArm(`hybrid-${model}`, model, [
    '--decider',
    'hybrid',
    '--model',
    model,
    '--vision',
    '--require-gpu',
  ]);

const arms = [
  // Safe since slicc #3746: webrunner's agent() calls run no command, get
  // their screenshots as images (agent --image) and cannot escalate
  // (agent --no-escalate). cost --json counts escalations per scoop.
  hybridArm('0.8b-vision'),
  hybridArm('4b-vision'),
  { id: 'playwright-agent', kind: 'agent', pool: 'bench', model: AGENT_MODEL },
];

/** Arms on hold. */
const heldArms = [];

const RUN_S_DEFAULT = 900;

/**
 * webrunner's --time-limit: the driver's per-run timeout less 10%, at
 * least a minute: the goal's timeout_s, else the driver's HARNESS_RUN_S
 * (diag rounds ran at 600 s, under the old fixed 810), else 900.
 */
function timeLimit(goal, env = typeof process === 'undefined' ? {} : process.env) {
  const fromEnv = Number.parseInt(env.HARNESS_RUN_S, 10);
  const run =
    Number(goal.timeout_s) > 0 ? Number(goal.timeout_s) : fromEnv > 0 ? fromEnv : RUN_S_DEFAULT;
  return Math.max(30, run - Math.max(60, Math.round(run * 0.1)));
}

/**
 * Leader files the driver keeps after every run, failed or timed out
 * (#461): webrunner's log (truncated per run), kev's pull log, and the
 * run's trace. Without a run id in the output (a timeout, a crash), the
 * newest run directory. Ids are timestamps, so they sort in time order;
 * index.json sorts after them and is not a run.
 */
async function diagnostics({ own, list }) {
  const keep = ['/tmp/meep/webrunner.log', '/tmp/kev/pull.log'];
  let run = own && own.run;
  if (!run) {
    const ids = (await list('/tmp/meep/runs'))
      .filter((n) => /^\d{4}-\d\d-\d\dT[\w.-]+$/.test(n))
      .sort();
    run = ids[ids.length - 1];
  }
  if (run) keep.push(`/tmp/meep/runs/${run}/trace.jsonl`);
  return keep;
}

/** One goal as a `webrunner run` command line. */
function command(goal, arm, { shellQuote }) {
  const argv = ['webrunner', 'run', '--url', goal.url, '--goal', goal.goal];
  for (const t of goal.expect ?? []) argv.push('--expect', t);
  for (const u of goal.expect_url ?? []) argv.push('--expect-url', u);
  if (goal.max_steps) argv.push('--max-steps', String(goal.max_steps));
  // webrunner stops itself before the driver's timeout, so a stalled run
  // still prints its result and says where it stuck.
  argv.push('--time-limit', String(timeLimit(goal)));
  argv.push(...arm.args, '--json');
  return argv.map(shellQuote).join(' ');
}

/** webrunner's own verdict from its --json output (the last JSON object printed). */
function result(stdout) {
  const lines = String(stdout).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines.slice(i).join('\n');
    if (!text.trimStart().startsWith('{')) continue;
    try {
      const r = JSON.parse(text);
      return {
        ok: Boolean(r.ok),
        run: r.run || null,
        steps: r.steps,
        decideSeconds: r.decideSeconds,
        artifacts: r.run ? [`/tmp/meep/runs/${r.run}/trace.jsonl`] : [],
      };
    } catch {}
  }
  return null;
}

/** `text` occurs in `haystack`, and a number at its end does not run on: "Oct 1" is not in "Oct 15". */
function containsValue(haystack, text) {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(text, from);
    if (at < 0) return false;
    const next = haystack[at + text.length];
    if (!(/\d$/.test(text) && next && /\d/.test(next))) return true;
    from = at + 1;
  }
}

/**
 * A `playwright-cli snapshot` passes when its page URL contains every expect_url and its text
 * contains every expect (case-sensitive, as written in goals.json).
 */
function judge(raw, goal) {
  const text = String(raw);
  const url = /Page URL:\s*(\S+)/.exec(text)?.[1] ?? '';
  const expect = goal.expect ?? [];
  const expectUrl = goal.expect_url ?? [];
  if (!expect.length && !expectUrl.length) return false;
  return expectUrl.every((u) => url.includes(u)) && expect.every((t) => containsValue(text, t));
}

/** The first story id in Hacker News front page HTML, or null. */
function hnTopFromHtml(html) {
  const m = /<tr[^>]*class=['"][^'"]*\bathing\b[^'"]*['"][^>]*\bid=['"](\d+)['"]/.exec(
    String(html)
  );
  return m ? m[1] : null;
}

/** {{hn:top}}: the story the Hacker News goal must open, read just before each run. */
async function placeholder(name, { fetch }) {
  if (name !== 'hn:top') throw new Error(`meep-meep's goals have no {{${name}}}`);
  const r = await fetch('https://news.ycombinator.com/', {
    headers: { 'user-agent': 'slicc-harness-evals' },
  });
  const id = hnTopFromHtml(await r.text());
  if (!id) throw new Error('could not read the top story id from the Hacker News front page');
  return id;
}

// ── judged goals (rubric + weights, graded by the bench's findings judge) ──

/**
 * The game's own score, read off its last points table: "Total Points All
 * Tours -4255" (Armchair Bike Touring). null when none is shown.
 */
function gamePoints(text) {
  const all = [...String(text).matchAll(/Total Points All Tours\s*(-?\d[\d,]*)/g)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
}

const pageTextOf = (state) => {
  const s = String(state || '');
  const i = s.indexOf('Page text:');
  if (i < 0) return '';
  const j = s.indexOf('\nControls:', i);
  return s.slice(i + 'Page text:'.length, j < 0 ? undefined : j).trim();
};

/**
 * A webrunner run as the bench judge's trace ({ steps, finalResult,
 * outputFilesText, screenshots }): one line per cycle with who decided, the
 * action, what it changed and System 2's assessment, plus the page text
 * whenever it changed; the final page in full; the last screenshots.
 * lines: the parsed trace.jsonl; screenshot(name) → base64 PNG or null.
 * Pure: the driver's judgeTrace hook below feeds it from the leader's VFS.
 */
async function traceFromLines(lines, screenshot, { shots = 4 } = {}) {
  const steps = [];
  let lastText = '';
  let lastPage = '';
  const stepLines = lines.filter((l) => l.type === 'step');
  for (const s of stepLines) {
    const d = s.decide || {};
    const parts = [];
    if (s.review) parts.push(`plan review (${s.review.why}): ${s.review.assessment || ''}`);
    if (d.action) {
      // A random or rut audit is System 2's decision too.
      const who = !d.system1
        ? d.system || ''
        : d.system1.oversight
          ? 'System 2 (audit)'
          : d.system1.shrug
            ? 'System 2'
            : 'System 1';
      parts.push(`${who}: ${d.action.describe}${d.action.text ? ` "${d.action.text}"` : ''}`);
    }
    if (s.diff && s.diff.changed && s.diff.changed.length) {
      parts.push(`changed: ${s.diff.changed.map((c) => `${c.label} = "${c.to}"`).join('; ')}`);
    }
    if (d.system2 && d.system2.assessment) parts.push(`assessment: ${d.system2.assessment}`);
    if (s.act && s.act.error) parts.push(`action failed: ${s.act.error}`);
    if (s.outcome) parts.push(`outcome: ${s.outcome}`);
    // A terminal observation (check passed, out of steps) has no orient:
    // its page text is on the observe record.
    const state = s.orient ? s.orient.state : '';
    const text = state ? pageTextOf(state) : String((s.observe && s.observe.pageText) || '').trim();
    if (text) lastPage = text;
    if (text && text !== lastText) {
      parts.push(`page text: ${text.replace(/\s+/g, ' ').slice(0, 600)}`);
      lastText = text;
    }
    if (parts.length) steps.push(parts.join(' | '));
  }
  const end = lines.find((l) => l.type === 'end') || {};
  const finalText = lastPage;
  const finalResult = [
    `webrunner: ${end.ok ? 'passed' : 'did not pass'} (${end.reason || 'no end record'}) after ${end.steps ?? stepLines.length} steps.`,
    'Final page text:',
    finalText || '(none)',
  ].join('\n');
  const named = stepLines.map((s) => s.observe && s.observe.screenshot).filter(Boolean);
  const screenshots = [];
  for (const name of named.slice(-shots)) {
    const base64 = await screenshot(name);
    if (base64) screenshots.push({ label: name, base64, format: 'png' });
  }
  return {
    steps,
    finalResult,
    outputFilesText: '',
    screenshots,
    // Only the final page counts: an earlier day's table is not the result
    // (the solo pilot read -13 off day 1 while the game stood at -2245).
    metrics: { points: gamePoints(finalText) },
  };
}

/**
 * The driver's hook for a goal with a rubric: read the run's trace and
 * screenshots through its callbacks and return the judge's trace.
 * own: result(stdout), which names the run directory.
 */
async function judgeTrace({ own, readText, readBase64 }) {
  const dir = own && own.run ? `/tmp/meep/runs/${own.run}` : null;
  if (!dir) {
    return {
      steps: [],
      finalResult: 'webrunner printed no run id, so there is no trace to judge.',
      outputFilesText: '',
      screenshots: [],
      metrics: { points: null },
    };
  }
  const text = await readText(`${dir}/trace.jsonl`);
  const lines = String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return traceFromLines(lines, async (name) => {
    try {
      return await readBase64(`${dir}/${name}`);
    } catch {
      return null;
    }
  });
}

const lastNumber = (text, re) => {
  const all = [...String(text).matchAll(re)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
};

// Each game's own number on its final page. A Dark Room has none: the
// rubric alone grades it. Patterns from the pages as probed 2026-10-02; the
// ones for end screens not yet seen (Drug Wars, Seedship) are the games'
// documented wording and get checked on the first runs.
const GAME_METRICS = {
  'armchair-bike': (text) => gamePoints(text),
  drugwars: (text) =>
    lastNumber(text, /(?:SCORE|NET WORTH|Net Worth|Net worth)[:\s]*\$?\s*(-?[\d,]+)/g),
  // The ending's score table ends with the row "Total: 9511" (seen 2026-10-02).
  seedship: (text) => lastNumber(text, /Total:\s*(-?[\d,]+)/g),
  password: (text) => {
    const rules = [...String(text).matchAll(/Rule (\d+)/g)].map((m) => Number(m[1]));
    return rules.length ? Math.max(...rules) : null;
  },
  paperclips: (text) => lastNumber(text, /Paperclips:\s*([\d,]+)/g),
  // The resource row reads "kittens 1 /2" (current / capacity), no colon.
  kittens: (text) => lastNumber(text, /[Kk]ittens?\s*:?\s*(\d+)\s*\//g),
};

/**
 * Metrics from the final page, for every arm (the driver calls this on the
 * last snapshot, so the bare agent arm gets each game's number too).
 */
function metrics(snapshot, goal) {
  const read = GAME_METRICS[goal && goal.id] || gamePoints;
  return { points: read(snapshot) };
}

module.exports = {
  arms,
  heldArms,
  timeLimit,
  diagnostics,
  command,
  result,
  containsValue,
  judge,
  hnTopFromHtml,
  placeholder,
  gamePoints,
  traceFromLines,
  judgeTrace,
  metrics,
};
