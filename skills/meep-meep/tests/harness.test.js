import test, { is, ok } from 'tst';
import {
  arms,
  command,
  containsValue,
  hnTopFromHtml,
  judge,
  placeholder,
  result,
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

test('command quotes the goal and passes the first --expect and --expect-url', () => {
  const arm = arms.find((a) => a.id === 'kev-9b');
  const goal = {
    url: 'https://x/',
    goal: `it's "here"`,
    expect: ['a', 'b'],
    expect_url: ['/p'],
    max_steps: 6,
  };
  is(
    command(goal, arm, { shellQuote: quote }),
    `'webrunner' 'run' '--url' 'https://x/' '--goal' 'it'\\''s "here"' '--expect' 'a' '--expect-url' '/p' '--max-steps' '6' '--decider' 'kev' '--model' '9b' '--json'`
  );
});

test('every skill arm pulls the kev model it decides with', () => {
  for (const arm of arms.filter((a) => a.pool === 'gpu')) {
    const i = arm.args.indexOf('--model');
    const model = arm.args.includes('--vision') && i < 0 ? '4b-vision' : arm.args[i + 1];
    is(arm.setup, [`kev pull --model ${model}`], arm.id);
  }
});

test('result reads the last JSON webrunner printed and keeps the trace', () => {
  const out =
    'step 1 click\n{"note": 1}\n{\n  "ok": true,\n  "steps": 4,\n  "decideSeconds": 2.5,\n  "run": "r1"\n}\n';
  is(result(out), {
    ok: true,
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
