import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';
import {
  arms,
  command,
  containsValue,
  diagnostics,
  gamePoints,
  heldArms,
  hnTopFromHtml,
  judge,
  judgeTrace,
  metrics,
  placeholder,
  result,
  timeLimit,
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
    `'webrunner' 'run' '--url' 'https://x/' '--goal' 'it'\\''s "here"' '--expect' 'a' '--expect' 'b' '--expect-url' '/p' '--max-steps' '6' '--time-limit' '810' '--decider' 'hybrid' '--model' '4b-vision' '--vision' '--require-gpu' '--json'`
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
      review: {
        why: 'System 1 handed over the last 5 steps',
        assessment: 'Kev lacked the food name.',
      },
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
  ok(
    trace.steps[1].startsWith(
      'plan review (System 1 handed over the last 5 steps): Kev lacked the food name.'
    )
  );
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

test('metrics reads the game points off the final snapshot', () => {
  is(metrics('- text "Total Points All Tours -4255" [ref=e40]', { id: 'armchair-bike' }), {
    points: -4255,
  });
  is(metrics('- button "Start Riding" [ref=e28]', {}), { points: null });
});

// Lars, 2026-10-02: anything involving kev needs the GPU pool.
test('every arm that runs kev is on the GPU pool', () => {
  for (const arm of [...arms, ...heldArms]) {
    const pullsKev = (arm.setup || []).some((s) => /\bkev pull\b/.test(s));
    const i = (arm.args || []).indexOf('--decider');
    const decidesWithKev = i >= 0 && ['kev', 'hybrid'].includes(arm.args[i + 1]);
    if (pullsKev || decidesWithKev) is([arm.id, arm.pool], [arm.id, 'gpu']);
  }
});

test('metrics reads each game’s own number', () => {
  is(metrics('Paperclips: 1,204\nMake Paperclip', { id: 'paperclips' }), { points: 1204 });
  is(metrics('Rule 1 ... Rule 9 ... Rule 4', { id: 'password' }), { points: 9 });
  is(
    metrics('- row "Planet water: 500" [ref=e34]\n- row "Total: 9511" [ref=e61]', {
      id: 'seedship',
    }),
    { points: 9511 }
  );
  is(metrics('SCORE: $48,210', { id: 'drugwars' }), { points: 48210 });
  is(metrics('light fire', { id: 'darkroom' }), { points: null });
  is(metrics('catnip 12 /5000\nkittens 1 /2', { id: 'kittens' }), { points: 1 });
  const goals = JSON.parse(
    readFileSync(fileURLToPath(new URL('../evals/harness/goals.json', import.meta.url)), 'utf8')
  ).goals;
  for (const g of goals.filter((x) => x.rubric)) {
    is([g.id, Object.values(g.weights).reduce((a, b) => a + b, 0)], [g.id, 100]);
    for (const id of Object.keys(g.weights))
      ok(g.rubric.includes(`${id} — `), `${g.id} defines ${id}`);
  }
});

test('webrunner stops itself before the driver times out', () => {
  is(timeLimit({}, {}), 810, 'the default 900 s run');
  is(timeLimit({}, { HARNESS_RUN_S: '600' }), 540, "the driver's own timeout");
  is(timeLimit({ timeout_s: 3600 }, { HARNESS_RUN_S: '600' }), 3240, 'a goal timeout_s wins');
  is(timeLimit({ timeout_s: 3600 }), 3240);
  is(timeLimit({ timeout_s: 120 }), 60);
  is(timeLimit({ timeout_s: 20 }), 30, 'never under 30 s');
});

test('diagnostics keep the logs and the run trace, the newest run when none was printed', async () => {
  const list = async (dir) => {
    is(dir, '/tmp/meep/runs');
    return [
      '2026-10-02T09-55-59-drugwars-online',
      'index.json',
      '2026-10-02T10-01-07-flights',
      '2026-09-30T08-00-00-x',
    ];
  };
  const logs = ['/tmp/meep/webrunner.log', '/tmp/kev/pull.log'];
  is(await diagnostics({ own: { run: 'r1' }, list }), [...logs, '/tmp/meep/runs/r1/trace.jsonl']);
  is(
    await diagnostics({ own: null, list }),
    [...logs, '/tmp/meep/runs/2026-10-02T10-01-07-flights/trace.jsonl'],
    'index.json sorts last but is not a run'
  );
  is(await diagnostics({ own: null, list: async () => [] }), logs);
});

// Codex review of 969a51e: a check that passes ends the run on an
// observation with no orient, and audited steps were labelled System 1.
test('the judge trace keeps the terminal page and names audits as System 2', async () => {
  const state = (text) => `Goal: g\nPage text:\n  ${text}\nControls:\n  [e1] button "x"`;
  const lines = [
    { type: 'start', goal: 'g' },
    {
      type: 'step',
      step: 1,
      observe: { screenshot: 'step-01.png' },
      orient: { state: state('Total Points All Tours -13') },
      decide: {
        system: 'agent',
        system1: { action: 'click:e1', oversight: { reason: 'base 0.01', chance: 0.01 } },
        action: { describe: 'click button "Keep Riding"' },
      },
    },
    {
      type: 'step',
      step: 2,
      observe: {
        screenshot: 'step-02.png',
        pageText: '  Tour complete\n  Total Points All Tours 1059',
      },
      outcome: 'check passed',
    },
    { type: 'end', ok: true, reason: 'check passed', steps: 1 },
  ];
  const trace = await traceFromLines(lines, async () => null);
  ok(trace.steps[0].startsWith('System 2 (audit): click button "Keep Riding"'));
  ok(trace.steps[1].includes('page text: Tour complete Total Points All Tours 1059'));
  ok(trace.finalResult.includes('Total Points All Tours 1059'));
  is(trace.metrics, { points: 1059 }, 'the score from the final page, not the step before');
});
