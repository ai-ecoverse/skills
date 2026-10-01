/**
 * meep-meep's harness-evals adapter (driven by tools/harness-evals): the goals in goals.json,
 * run by webrunner with each decider, and by the bare agent, all judged by `judge` below.
 *
 * `judge` is deliberately self-contained instead of importing scripts/page.js: it is the
 * yardstick, so a change to webrunner's own check cannot change how its runs are graded, and a
 * stacked PR comparing an older webrunner judges with the same code.
 */

export const goals = './goals.json';

const AGENT_MODEL = 'claude-haiku-4-5';
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
const hybridArm = (model) =>
  kevArm(`hybrid-${model}`, model, ['--decider', 'hybrid', '--model', model, '--vision']);

export const arms = [
  // Safe since slicc #3746: webrunner's agent() calls run no command, get
  // their screenshots as images (agent --image) and cannot escalate
  // (agent --no-escalate). cost --json counts escalations per scoop.
  hybridArm('0.8b-vision'),
  hybridArm('4b-vision'),
  { id: 'playwright-agent', kind: 'agent', pool: 'bench', model: AGENT_MODEL },
];

/** Arms on hold. */
export const heldArms = [];

/** One goal as a `webrunner run` command line. */
export function command(goal, arm, { shellQuote }) {
  const argv = ['webrunner', 'run', '--url', goal.url, '--goal', goal.goal];
  for (const t of goal.expect ?? []) argv.push('--expect', t);
  for (const u of goal.expect_url ?? []) argv.push('--expect-url', u);
  if (goal.max_steps) argv.push('--max-steps', String(goal.max_steps));
  argv.push(...arm.args, '--json');
  return argv.map(shellQuote).join(' ');
}

/** webrunner's own verdict from its --json output (the last JSON object printed). */
export function result(stdout) {
  const lines = String(stdout).trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines.slice(i).join('\n');
    if (!text.trimStart().startsWith('{')) continue;
    try {
      const r = JSON.parse(text);
      return {
        ok: Boolean(r.ok),
        steps: r.steps,
        decideSeconds: r.decideSeconds,
        artifacts: r.run ? [`/tmp/meep/runs/${r.run}/trace.jsonl`] : [],
      };
    } catch {}
  }
  return null;
}

/** `text` occurs in `haystack`, and a number at its end does not run on: "Oct 1" is not in "Oct 15". */
export function containsValue(haystack, text) {
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
export function judge(raw, goal) {
  const text = String(raw);
  const url = /Page URL:\s*(\S+)/.exec(text)?.[1] ?? '';
  const expect = goal.expect ?? [];
  const expectUrl = goal.expect_url ?? [];
  if (!expect.length && !expectUrl.length) return false;
  return expectUrl.every((u) => url.includes(u)) && expect.every((t) => containsValue(text, t));
}

/** The first story id in Hacker News front page HTML, or null. */
export function hnTopFromHtml(html) {
  const m = /<tr[^>]*class=['"][^'"]*\bathing\b[^'"]*['"][^>]*\bid=['"](\d+)['"]/.exec(
    String(html)
  );
  return m ? m[1] : null;
}

/** {{hn:top}}: the story the Hacker News goal must open, read just before each run. */
export async function placeholder(name, { fetch }) {
  if (name !== 'hn:top') throw new Error(`meep-meep's goals have no {{${name}}}`);
  const r = await fetch('https://news.ycombinator.com/', {
    headers: { 'user-agent': 'slicc-harness-evals' },
  });
  const id = hnTopFromHtml(await r.text());
  if (!id) throw new Error('could not read the top story id from the Hacker News front page');
  return id;
}
