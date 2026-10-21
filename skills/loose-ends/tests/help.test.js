import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/loose-ends.jsh',
    ['--help'],
    'loose-ends — store + sprinkle management for the loose-ends panel',
  ],
  [
    'scripts/loose-ends.jsh',
    ['-h'],
    'loose-ends — store + sprinkle management for the loose-ends panel',
  ],
  [
    'scripts/loose-ends.jsh',
    ['done', '--help'],
    'loose-ends — store + sprinkle management for the loose-ends panel',
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
