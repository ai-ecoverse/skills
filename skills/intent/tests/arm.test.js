import test, { is, ok } from 'tst';
import * as armMod from '../scripts/arm.js';

const arm = armMod.default || armMod;
const CANARY = 'canary-7f3a-task-text';

test('runId: the host slug, or -run without a URL', () => {
  const now = new Date('2026-10-04T05:06:07.890Z');
  is(arm.runId('https://news.ycombinator.com/', now), '2026-10-04T05-06-07-890Z-news-ycombinator-com');
  is(arm.runId('', now), '2026-10-04T05-06-07-890Z-run');
  is(arm.hostSlug(undefined), 'run');
});

test('checkUrl: none is fine, a start URL must be http(s)', () => {
  is(arm.checkUrl(''), null);
  is(arm.checkUrl('https://example.com/a'), null);
  ok(/http or https/.test(arm.checkUrl('file:///etc/passwd')));
  ok(/not a URL/.test(arm.checkUrl('example.com')));
});

test('prompt: with a URL the scoop opens it; without one it opens the site itself', () => {
  const withUrl = arm.prompt('https://httpbin.org/forms/post', 'Order a pizza', 'intent');
  ok(withUrl.startsWith('Open https://httpbin.org/forms/post in a new browser tab'), withUrl);
  const bare = arm.prompt('', 'Find the cheapest flight to Lisbon on example.travel', 'intent');
  ok(!/\bOpen undefined|Open {2}/.test(bare), bare);
  ok(bare.startsWith('Do this in the browser: Find the cheapest flight'), bare);
  ok(bare.includes('No page is open yet') && bare.includes('`intent --intent "open https://…"`'), bare);
  ok(arm.prompt('', 'x', 'playwright-cli').includes('`playwright-cli open https://…`'));
});

test('printable --private: no task text, answer or page URL on stdout', () => {
  const result = {
    run: '2026-10-04T05-06-07-890Z-run',
    tool: 'intent',
    ok: false,
    error: `System 1 did not load while doing ${CANARY}`,
    seconds: 12.5,
    steps: 4,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    intent: { calls: 4, kinds: { ACT: 3, NAVIGATE: 1 }, outcomes: { acted: 3, opened: 1 } },
    finalUrl: `https://example.com/search?q=${CANARY}`,
    answer: `The answer to ${CANARY} is 42`,
    tab: 'ABCDEF0123456789ABCDEF0123456789',
  };
  const out = JSON.stringify(arm.printable(result, { private: true }));
  ok(!out.includes(CANARY), out);
  ok(!out.includes('example.com') && !out.includes('"answer"') && !out.includes('"finalUrl"'), out);
  is(arm.printable(result, { private: true }).steps, 4);
  is(arm.printable(result, { private: true }).run, result.run);
  // Without --private the result prints in full, as the harness evals read it.
  is(arm.printable(result), result);
});

test('printable --private: a field added to the result later stays off stdout', () => {
  const out = arm.printable({ run: 'r', steps: 1, notes: CANARY, lastIntent: CANARY }, { private: true });
  is(out, { run: 'r', steps: 1 });
});
