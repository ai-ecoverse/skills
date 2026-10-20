import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/sessionize.jsh',
    ['-h'],
    'Sessionize CFP / speaker client — same-origin via your logged-in browser tab.',
  ],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
