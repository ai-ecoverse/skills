import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/fj.jsh', ['docs', '--help'], 'fj — Adobe FluffyJaws CLI'],
  ['scripts/fj.jsh', ['mcp', '-h'], 'fj — Adobe FluffyJaws CLI'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
