import test, { is, ok } from 'tst';
import * as adapterMod from '../evals/harness/adapter.js';
import * as transcriptMod from '../scripts/transcript.js';
import { existsSync } from 'fs';

const adapter = adapterMod.default || adapterMod;
const transcript = transcriptMod.default || transcriptMod;
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

test('arms: intent variants side by side, the cone as reference', () => {
  is(adapter.arms.map((a) => a.id), ['intent-agent', 'intent-budget', 'playwright-agent']);
  is(adapter.arms[0].setup, ['intent prepare', 'intent pull --model 4b-vision']);
  is(adapter.arms[1].args.slice(-2), ['--retrieve', 'budget']);
  ok(adapter.arms.slice(0, 2).every((a) => a.pool === 'gpu' && a.args.includes('--require-gpu')));
  is(adapter.heldArms.map((a) => a.id), ['playwright-scoop', 'intent-lexical']);
  is(adapter.heldArms[1].args.slice(-2), ['--retrieve', 'lexical']);
});

test('command: one intent-arm line with the time limit inside the driver timeout', () => {
  const goal = { url: 'https://httpbin.org/forms/post', goal: "Enter 'Ada'", timeout_s: 600 };
  const line = adapter.command(goal, adapter.arms[0], { shellQuote: quote });
  ok(line.startsWith("'intent-arm' '--url' 'https://httpbin.org/forms/post'"), line);
  ok(line.includes("'--time-limit' '540'"), line);
  ok(line.includes("'--tool' 'intent'") && line.includes("'--s1-model' '4b-vision'") && line.includes("'--require-gpu'"), line);
  is(adapter.timeLimit({}, { HARNESS_RUN_S: '900' }), 810);
});

test('result: the last JSON object, with its run files', () => {
  const r = adapter.result('[stderr noise]\n{\n  "run": "2026-10-03T01-00-00-000Z",\n  "steps": 7\n}');
  is(r.run, '2026-10-03T01-00-00-000Z');
  is(r.steps, 7);
  is(r.artifacts, ['/tmp/intent-arm/2026-10-03T01-00-00-000Z/result.json', '/tmp/intent-arm/2026-10-03T01-00-00-000Z/calls.jsonl']);
  is(adapter.result('no json here'), null);
  const failed = adapter.result('{"run": "r1", "tool": "intent", "ok": false, "error": "System 1 did not load: software adapter"}');
  is([failed.ok, failed.error], [false, 'System 1 did not load: software adapter']);
  ok(!('ok' in r));
});

test('judge: URL and texts, and a number must not run on', () => {
  const snap = 'Page URL: https://httpbin.org/post\n- text "custname Ada Lovelace size medium Oct 15"';
  ok(adapter.judge(snap, { expect: ['Ada Lovelace'], expect_url: ['httpbin.org/post'] }));
  ok(!adapter.judge(snap, { expect: ['Oct 1'], expect_url: [] }));
  ok(!adapter.judge(snap, { expect: [], expect_url: [] }));
});

test('toolCalls: commands and result sizes from a scoop transcript', () => {
  const md = [
    '# Agent session: x',
    '- turns: 2',
    '## assistant',
    '### tool: bash',
    'Input:',
    '```json',
    '{\n  "command": "intent --intent \\"open https://x\\""\n}',
    '```',
    'Result:',
    '```',
    '✓ opened https://x',
    '```',
    '## assistant',
    '### tool: bash',
    'Input:',
    '```json',
    '{\n  "command": "intent --help"\n}',
    '```',
    'Result:',
    '```',
    'intent — one browser step',
    '```',
  ].join('\n');
  const calls = transcript.toolCalls(md);
  is(calls.map((c) => c.command), ['intent --intent "open https://x"', 'intent --help']);
  is(calls[0].chars, '✓ opened https://x'.length);
  is(transcript.stats([3, 1, 2]), { n: 3, mean: 2, p50: 2, max: 3, total: 6 });
  is(transcript.stats([]), null);
});

test('the arm driver installs with the skill: scripts/, not evals/', () => {
  // A leader installs a skill without evals/, so a command there is "not found".
  const at = (rel) => existsSync(rel) || existsSync(`skills/intent/${rel}`);
  ok(at('scripts/intent-arm.jsh'), 'scripts/intent-arm.jsh');
  ok(!at('evals/harness/intent-arm.jsh'), 'no driver left in evals/');
  ok(adapter.command({ url: 'u', goal: 'g' }, adapter.arms[1], { shellQuote: quote }).startsWith("'intent-arm'"));
});

test('diagnostics: the newest run of this goal, never one of another goal', async () => {
  const runs = ['2026-10-03T10-01-12-318Z-news-ycombinator-com', '2026-10-03T10-05-12-873Z-www-biketouringtips-com'];
  const list = async () => runs;
  const bike = { url: 'https://www.biketouringtips.com/ArmchairBikeTouring/' };
  is((await adapter.diagnostics({ goal: bike, own: null, list }))[0], `/tmp/intent-arm/${runs[1]}/result.json`);
  is(await adapter.diagnostics({ goal: { url: 'https://httpbin.org/forms/post' }, own: null, list }), []);
  is(adapter.hostSlug('https://news.ycombinator.com/'), 'news-ycombinator-com');
});

test('judge: the bike tour also counts as done on its summary page', () => {
  const goal = { expect: ['completed your first bicycle tour'], expect_url: [], expect_any: [["You've accumulated", 'What would you like to do next?']] };
  const done = 'Page URL: https://x/\n- text "Congratulations! You have just completed your first bicycle tour."';
  const summary = 'Page URL: https://x/\n- row "You\'ve accumulated 2663 points."\n- row "What would you like to do next? Go to Next Tour"';
  const riding = 'Page URL: https://x/\n- row "Mile 64 of 100"';
  ok(adapter.judge(done, goal) && adapter.judge(summary, goal) && !adapter.judge(riding, goal));
  is([adapter.gamePoints(summary), adapter.gamePoints('Total Points All Tours -151'), adapter.gamePoints(riding)], [2663, -151, null]);
  is(adapter.metrics('You\'ve accumulated -3,190 points.', { id: 'armchair-bike' }), { points: -3190 });
});
