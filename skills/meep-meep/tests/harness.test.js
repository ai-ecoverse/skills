import test, { is, ok } from 'tst';
import {
  arms,
  command,
  containsValue,
  gamePoints,
  heldArms,
  hnTopFromHtml,
  judge,
  judgeTrace,
  placeholder,
  result,
  traceFromLines,
} from '../evals/harness/harness.mjs';

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const shot = (url, ...lines) => [`- Page URL: ${url}`, '- Page Title: T', ...lines].join('\n');

test('judge: every expect_url in the URL and every expect on the page', () => {
  const goal = { expect: ['London', 'Oct 8', 'Oct 15'], expect_url: ['/travel/flights/search'] };
  const url = 'https://www.google.com/travel/flights/search?tfs=x';
  is(judge(shot(url, '- text "London Oct 8 – Oct 15"'), goal), true);
  is(
    judge(shot(url, '- text "London Oct 8 Oct 15"'), { ...goal, expect: ['Oct 1'] }),
    false,
    'Oct 1 is not Oct 15'
  );
  is(
    judge(shot('https://www.google.com/travel/flights', '- text "London Oct 8 Oct 15"'), goal),
    false
  );
  is(judge(shot(url, '- text "london Oct 8 Oct 15"'), goal), false, 'case-sensitive');
  is(judge(shot(url), { expect: [], expect_url: [] }), false, 'a goal without checks never passes');
});

test('containsValue skips a number that runs on, and finds a later exact one', () => {
  is(containsValue('Oct 15, Oct 1', 'Oct 1'), true);
  is(containsValue('Oct 15', 'Oct 1'), false);
  is(containsValue('medium size', 'medium'), true);
});

test('command quotes the goal and repeats --expect and --expect-url', () => {
  const arm = [...arms, ...heldArms].find((a) => a.id === 'hybrid-4b-vision');
  const goal = {
    url: 'https://x/',
    goal: `it's "here"`,
    expect: ['a', 'b'],
    expect_url: ['/p'],
    max_steps: 6,
  };
  is(
    command(goal, arm, { shellQuote: quote }),
    `'webrunner' 'run' '--url' 'https://x/' '--goal' 'it'\\''s "here"' '--expect' 'a' '--expect' 'b' '--expect-url' '/p' '--max-steps' '6' '--decider' 'hybrid' '--model' '4b-vision' '--vision' '--json'`
  );
});

test('every skill arm pulls the kev model it decides with', () => {
  for (const arm of [...arms, ...heldArms].filter((a) => a.pool === 'gpu')) {
    const i = arm.args.indexOf('--model');
    const model = arm.args.includes('--vision') && i < 0 ? '4b-vision' : arm.args[i + 1];
    is(arm.setup, [`kev pull --model ${model}`], arm.id);
  }
  ok(
    arms.some((a) => a.kind === 'agent'),
    'a bare agent arm'
  );
});

test('result reads the last JSON webrunner printed and keeps the trace', () => {
  const out =
    'step 1 click\n{"note": 1}\n{\n  "ok": true,\n  "steps": 4,\n  "decideSeconds": 2.5,\n  "run": "r1"\n}\n';
  is(result(out), {
    ok: true,
    run: 'r1',
    steps: 4,
    decideSeconds: 2.5,
    artifacts: ['/tmp/meep/runs/r1/trace.jsonl'],
  });
  is(result('Error: webrunner: no tab'), null);
});

test('hn:top reads the first story row, and refuses unknown names', async () => {
  const html = `<tr class='athing submission' id='45678901'><td></td></tr><tr class='athing' id='2'>`;
  is(hnTopFromHtml(html), '45678901');
  is(hnTopFromHtml('<html></html>'), null);
  const fetch = async () => ({ text: async () => html });
  is(await placeholder('hn:top', { fetch }), '45678901');
  let threw = false;
  try {
    await placeholder('other', { fetch });
  } catch {
    threw = true;
  }
  ok(threw);
});

test('the game points come from the last points table', () => {
  is(gamePoints('Points Scored Today -1825 Total Points All Tours -4,255'), -4255);
  is(gamePoints('Total Points All Tours -13 ... Total Points All Tours 120'), 120);
  is(gamePoints('no table'), null);
});

test('traceFromLines builds the judge trace from webrunner lines and reads points off the final page only', async () => {
  const state = (text) => `Goal: g\nPage text:\n  ${text}\nControls:\n  [e1] button "x"`;
  const lines = [
    { type: 'start', goal: 'g' },
    {
      type: 'step',
      step: 1,
      observe: { screenshot: 'step-01.png' },
      orient: { state: state('Total Points All Tours -13') },
      decide: {
        system: 'kev',
        system1: { action: 'click:e1' },
        action: { describe: 'click button "Start Riding"' },
      },
    },
    {
      type: 'step',
      step: 2,
      observe: { screenshot: 'step-02.png' },
      orient: { state: state('Riding') },
      decide: {
        system: 'agent',
        system1: { action: 'click:e1', shrug: 'confidence 0.1 < 0.5' },
        action: { describe: 'click link "Rice and Beans"' },
        system2: { assessment: 'Buy and Eat needs a selection first.' },
      },
    },
    { type: 'end', ok: false, reason: 'stalled', steps: 2 },
  ];
  const trace = await traceFromLines(lines, async (name) =>
    name === 'step-02.png' ? 'BASE64' : null
  );
  is(trace.steps.length, 2);
  ok(trace.steps[0].startsWith('System 1: click button "Start Riding"'));
  ok(trace.steps[1].includes('System 2: click link "Rice and Beans"'));
  ok(trace.steps[1].includes('assessment: Buy and Eat needs a selection first.'));
  ok(trace.finalResult.includes('did not pass (stalled) after 2 steps'));
  ok(trace.finalResult.includes('Riding'));
  is(trace.screenshots, [{ label: 'step-02.png', base64: 'BASE64', format: 'png' }]);
  is(trace.metrics, { points: null }, 'the -13 on an earlier page is not the result');

  // The driver's hook reads the same run through its callbacks.
  const files = {
    '/tmp/meep/runs/r1/trace.jsonl': lines.map((l) => JSON.stringify(l)).join('\n'),
  };
  const hooked = await judgeTrace({
    goal: { id: 'armchair-bike' },
    own: result(JSON.stringify({ ok: false, run: 'r1', steps: 2 })),
    readText: async (p) => files[p],
    readBase64: async (p) => {
      if (p !== '/tmp/meep/runs/r1/step-02.png') throw new Error('ENOENT');
      return 'BASE64';
    },
    list: async () => [],
  });
  is(hooked.steps, trace.steps);
  is(hooked.screenshots, trace.screenshots);
  const none = await judgeTrace({
    own: null,
    readText: async () => '',
    readBase64: async () => '',
  });
  ok(none.finalResult.includes('no run id'));
});
