import test, { is, ok } from 'tst';
import * as adapterMod from '../evals/harness/adapter.js';
import * as transcriptMod from '../evals/harness/transcript.js';

const adapter = adapterMod.default || adapterMod;
const transcript = transcriptMod.default || transcriptMod;
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

test('arms: the intent scoop, its playwright-cli control, and the cone', () => {
  is(adapter.arms.map((a) => a.id), ['intent-agent', 'playwright-scoop', 'playwright-agent']);
  is(adapter.arms[0].setup, ['intent prepare', 'intent pull --model 4b-vision']);
  ok(adapter.arms.every((a) => a.kind === 'agent' || a.args.includes('claude-sonnet-5-5')));
});

test('command: one intent-arm line with the time limit inside the driver timeout', () => {
  const goal = { url: 'https://httpbin.org/forms/post', goal: "Enter 'Ada'", timeout_s: 600 };
  const line = adapter.command(goal, adapter.arms[0], { shellQuote: quote });
  ok(line.startsWith("'intent-arm' '--url' 'https://httpbin.org/forms/post'"), line);
  ok(line.includes("'--time-limit' '540'"), line);
  ok(line.includes("'--tool' 'intent'") && line.includes("'--s1-model' '4b-vision'"), line);
  is(adapter.timeLimit({}, { HARNESS_RUN_S: '900' }), 810);
});

test('result: the last JSON object, with its run files', () => {
  const r = adapter.result('[stderr noise]\n{\n  "run": "2026-10-03T01-00-00-000Z",\n  "steps": 7\n}');
  is(r.run, '2026-10-03T01-00-00-000Z');
  is(r.steps, 7);
  is(r.artifacts, ['/tmp/intent-arm/2026-10-03T01-00-00-000Z/result.json', '/tmp/intent-arm/2026-10-03T01-00-00-000Z/calls.jsonl']);
  is(adapter.result('no json here'), null);
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
