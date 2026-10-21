import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/linkedin.jsh', ['--help'], 'Usage: linkedin <command> [args] [--flags]'],
  ['scripts/linkedin.jsh', ['-h'], 'Usage: linkedin <command> [args] [--flags]'],
  ['scripts/linkedin.jsh', ['list', '--help'], 'Usage: linkedin <command> [args] [--flags]'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
