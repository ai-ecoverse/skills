import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/navan.jsh',
    ['whoami', '--help'],
    'navan — Navan (TripActions) corporate travel: search, view trips, and book.',
  ],
  [
    'scripts/navan.jsh',
    ['book', '-h'],
    'navan — Navan (TripActions) corporate travel: search, view trips, and book.',
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
