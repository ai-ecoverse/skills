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

// Trimmed from the shell's `commands`, 2026-10-04.
const COMMANDS = [
  'Available commands:',
  '',
  '  File operations:',
  '    ls, cat, head, tail, wc, touch, mkdir, rm, cp, mv',
  '',
  '  Network:',
  '    curl, curlwright, dig',
  '',
  '  Languages:',
  '    node, jsh, python, python3',
  '',
  '  Data processing:',
  '    xargs, jq, base64, date, expr, seq',
  '',
  '  Browser & UI:',
  '    serve, open, imgcat, playwright-cli, playwright, puppeteer, sprinkle',
  '',
  '  Other:',
  '    intent, intent-arm, convert, grep, sed, awk',
  '',
  "Use '<command> --help' for details on a specific command.",
].join('\n');

test('toolset full: every command the shell lists, except the browser commands', () => {
  const names = arm.commandNames(COMMANDS);
  ok(names.includes('curlwright') && names.includes('playwright-cli') && names.includes('intent'), names.join(','));
  ok(!names.includes('Use') && !names.includes('Available'), names.join(','));
  const full = arm.utilitiesFor('full', names);
  for (const t of ['curl', 'python3', 'node', 'open', 'convert', 'date', 'grep', 'intent']) ok(full.includes(t), t);
  for (const t of ['playwright-cli', 'playwright', 'puppeteer', 'intent-arm']) ok(!full.includes(t), t);
  // When `commands` cannot be read: the fallback list, still without the browser commands.
  const fallback = arm.utilitiesFor('full', []);
  ok(fallback.includes('curl') && fallback.includes('node') && !fallback.includes('playwright-cli'));
  is(arm.utilitiesFor('browser', names), arm.UTILITIES);
  is(arm.utilitiesFor(), arm.UTILITIES);
});

test('toolset full: the prompt says how the browser commands go, up front', () => {
  const full = arm.prompt('', 'Find X', 'intent', 'full');
  ok(full.includes('Use the `intent` command for the browser') && !/only through/.test(full), full);
  ok(full.includes('`playwright-cli`, `playwright` and `puppeteer` are not available'), full);
  ok(full.includes('intent <command> [args] --intent'), full);
  ok(full.includes('open --view --size'), full);
  ok(arm.prompt('', 'Find X', 'intent').includes('You browse only through the `intent` command'));
});

test('audit: browser access around the tool, and bare browser commands', () => {
  const calls = [
    { command: 'playwright-cli snapshot --tab=AB' },
    { command: 'ls; playwright-cli tab-list | head' },
    { command: 'x=$(playwright tab-list)' },
    { command: 'intent click e5 --intent "open the first result"' },
    { command: 'echo "playwright-cli is not here"' },
    { command: `node -e "const b = require('sliccy:browser')"` },
    { command: 'grep -c puppeteer notes.txt' },
  ];
  const files = [
    { name: 'drive.mjs', text: "import { chromium } from 'playwright';" },
    { name: 'plain.js', text: 'console.log(1)' },
  ];
  const a = arm.audit(calls, files);
  is(a.bypass, { calls: 1, files: 1 });
  is(a.bypassFiles, ['drive.mjs']);
  is(a.barePlaywright, 3);
  is(arm.audit([]), { bypass: { calls: 0, files: 0 }, barePlaywright: 0, bypassFiles: [] });
});

test('printable --private: the audit and the thinking level are numbers to keep', () => {
  const out = arm.printable(
    { run: 'r', thinking: 'low', toolset: 'full', bypass: { calls: 0, files: 1 }, bypassFiles: ['task-words.js'], barePlaywright: 2, answer: 'x' },
    { private: true }
  );
  is(out, { run: 'r', toolset: 'full', thinking: 'low', bypass: { calls: 0, files: 1 }, barePlaywright: 2 });
});
