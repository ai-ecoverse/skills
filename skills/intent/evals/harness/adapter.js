// The adapter's logic, as a CommonJS module: tst in a SLICC leader cannot
// load an .mjs file. harness.mjs re-exports it for the driver.

/**
 * intent's harness-evals adapter (driven by tools/harness-evals): the goals in
 * goals.json, and arms that are all Sonnet 5.5:
 *   intent-agent      a scoop that may run `intent` (not playwright-cli)
 *   intent-budget     the same, RETRIEVE returning its top texts up to a budget
 *   intent-lexical    the same, RETRIEVE ranked by words alone
 *   playwright-agent  the cone with raw playwright-cli: the reference
 * The two scoop arms run through scripts/intent-arm.jsh: it is a command of the
 * skill, because a leader installs a skill without its evals/ folder (the
 * first smoke round failed with 'intent-arm: command not found'). `judge` is the
 * same self-contained yardstick as meep-meep's (#423, closed).
 */

const AGENT_MODEL = 'claude-sonnet-5-5';
// System 1 of the intent arm: the shipped kev bundle the tool defaults to.
const KEV_MODEL = '4b-vision';

const scoopArm = (id, tool, extra = []) => ({
  id,
  kind: 'skill',
  pool: tool === 'intent' ? 'gpu' : 'bench',
  tool,
  ...(tool === 'intent' ? { setup: ['intent prepare', `intent pull --model ${KEV_MODEL}`] } : {}),
  // --require-gpu: a leader whose worker gets SwiftShader fails at once,
  // instead of running kev ~10x slower until the time limit.
  args: ['--tool', tool, '--model', AGENT_MODEL, ...(tool === 'intent' ? ['--s1-model', KEV_MODEL, '--require-gpu'] : []), ...extra],
});

// Intent variants run side by side, one GPU leader each (Lars, 2026-10-03):
// how RETRIEVE answers is the first thing tried.
const arms = [
  scoopArm('intent-agent', 'intent'),
  scoopArm('intent-budget', 'intent', ['--retrieve', 'budget']),
  scoopArm('intent-lexical', 'intent', ['--retrieve', 'lexical']),
  { id: 'playwright-agent', kind: 'agent', pool: 'bench', model: AGENT_MODEL },
];

/** Arms on hold: the playwright-cli scoop was the control of the first smoke rounds. */
const heldArms = [scoopArm('playwright-scoop', 'playwright-cli')];

const RUN_S_DEFAULT = 900;

/**
 * intent-arm's --time-limit: the driver's per-run timeout less 10%, at
 * least a minute: the goal's timeout_s, else HARNESS_RUN_S, else 900.
 */
function timeLimit(goal, env = typeof process === 'undefined' ? {} : process.env) {
  const fromEnv = Number.parseInt(env.HARNESS_RUN_S, 10);
  const run =
    Number(goal.timeout_s) > 0 ? Number(goal.timeout_s) : fromEnv > 0 ? fromEnv : RUN_S_DEFAULT;
  return Math.max(30, run - Math.max(60, Math.round(run * 0.1)));
}

const RUNS = '/tmp/intent-arm';

/** A goal URL's hostname as intent-arm slugs it into its run ids. */
function hostSlug(url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return (
    host
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'run'
  );
}

/**
 * The run's files, kept after every run, failed or timed out. Without a run
 * id in the output (a timeout, a crash), the newest run of this goal's host;
 * none rather than another goal's (a run that never started once shipped the
 * previous goal's files, 2026-10-03).
 */
async function diagnostics({ goal, own, list }) {
  let run = own && own.run;
  if (!run && goal && goal.url) {
    const slug = hostSlug(goal.url);
    const ids = (await list(RUNS)).filter((n) => /^\d{4}-\d\d-\d\dT[\w.-]+$/.test(n) && n.endsWith(`-${slug}`)).sort();
    run = ids[ids.length - 1];
  }
  return run ? ['result.json', 'transcript.md', 'calls.jsonl', 'judge.json'].map((f) => `${RUNS}/${run}/${f}`) : [];
}

/** One goal as an `intent-arm` command line. */
function command(goal, arm, { shellQuote }) {
  const argv = ['intent-arm', '--url', goal.url, '--goal', goal.goal];
  argv.push('--time-limit', String(timeLimit(goal)));
  argv.push(...arm.args, '--json');
  return argv.map(shellQuote).join(' ');
}

/** intent-arm's report from its --json output (the last JSON object printed). */
function result(stdout) {
  const lines = String(stdout).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines.slice(i).join('\n');
    if (!text.trimStart().startsWith('{')) continue;
    try {
      const r = JSON.parse(text);
      return {
        // Only a run that could not start says ok:false (System 1 did not
        // load, e.g. --require-gpu on SwiftShader); the judge decides the rest.
        ...(r.ok === false ? { ok: false, error: r.error } : {}),
        run: r.run || null,
        steps: r.steps,
        artifacts: r.run ? [`${RUNS}/${r.run}/result.json`, `${RUNS}/${r.run}/calls.jsonl`] : [],
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
  if (name !== 'hn:top') throw new Error(`intent's goals have no {{${name}}}`);
  const r = await fetch('https://news.ycombinator.com/', {
    headers: { 'user-agent': 'slicc-harness-evals' },
  });
  const id = hnTopFromHtml(await r.text());
  if (!id) throw new Error('could not read the top story id from the Hacker News front page');
  return id;
}

/** "Total Points All Tours -4255" (Armchair Bike Touring); null when none is shown. */
function gamePoints(text) {
  const all = [...String(text).matchAll(/Total Points All Tours\s*(-?\d[\d,]*)/g)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
}

const lastNumber = (text, re) => {
  const all = [...String(text).matchAll(re)];
  return all.length ? Number(all[all.length - 1][1].replace(/,/g, '')) : null;
};

// Each game's own number on its final page, as meep-meep reads it.
const GAME_METRICS = {
  'armchair-bike': (text) => gamePoints(text),
  drugwars: (text) =>
    lastNumber(text, /(?:SCORE|NET WORTH|Net Worth|Net worth)[:\s]*\$?\s*(-?[\d,]+)/g),
  seedship: (text) => lastNumber(text, /Total:\s*(-?[\d,]+)/g),
  password: (text) => {
    const rules = [...String(text).matchAll(/Rule (\d+)/g)].map((m) => Number(m[1]));
    return rules.length ? Math.max(...rules) : null;
  },
  paperclips: (text) => lastNumber(text, /Paperclips:\s*([\d,]+)/g),
  kittens: (text) => lastNumber(text, /[Kk]ittens?\s*:?\s*(\d+)\s*\//g),
};

/** Metrics from the final page, for every arm. */
function metrics(snapshot, goal) {
  const read = GAME_METRICS[goal && goal.id] || gamePoints;
  return { points: read(snapshot) };
}

/**
 * A scoop run as the bench judge's trace ({ steps, finalResult,
 * outputFilesText, screenshots }), from the judge.json intent-arm writes:
 * one line per tool call (command and result), the agent's answer and the
 * final page's text, and the final screenshot.
 */
async function judgeTrace({ own, readText, readBase64 }) {
  const dir = own && own.run ? `${RUNS}/${own.run}` : null;
  const empty = (why) => ({ steps: [], finalResult: why, outputFilesText: '', screenshots: [], metrics: { points: null } });
  if (!dir) return empty('intent-arm printed no run id, so there is no trace to judge.');
  let j;
  try {
    j = JSON.parse(await readText(`${dir}/judge.json`));
  } catch {
    return empty('intent-arm left no judge.json.');
  }
  const screenshots = [];
  for (const name of j.screenshots || []) {
    try {
      screenshots.push({ label: name, base64: await readBase64(`${dir}/${name}`), format: 'png' });
    } catch {}
  }
  return {
    steps: j.steps || [],
    finalResult: j.finalResult || '',
    outputFilesText: '',
    screenshots,
    metrics: { points: gamePoints(j.finalResult || '') },
  };
}

module.exports = {
  arms,
  heldArms,
  timeLimit,
  diagnostics,
  hostSlug,
  command,
  result,
  containsValue,
  judge,
  hnTopFromHtml,
  placeholder,
  gamePoints,
  judgeTrace,
  metrics,
};
