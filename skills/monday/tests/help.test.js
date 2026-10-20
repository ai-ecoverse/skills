import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/monday-dip.jsh',
    ['--help'],
    'monday-dip — render a `monday` JSON plan as a dip (inline shtml widget)',
  ],
  [
    'scripts/monday-dip.jsh',
    ['-h'],
    'monday-dip — render a `monday` JSON plan as a dip (inline shtml widget)',
  ],
  ['scripts/monday.jsh', ['-h'], 'monday — aggregate and rank inbox items across tools'],
  ['scripts/monday.jsh', ['done', '-h'], 'monday — aggregate and rank inbox items across tools'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
