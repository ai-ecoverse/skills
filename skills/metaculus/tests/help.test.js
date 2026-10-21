import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/metaculus.jsh', ['--help'], 'metaculus — Metaculus forecasting API'],
  ['scripts/metaculus.jsh', ['me', '-h'], 'metaculus — Metaculus forecasting API'],
  [
    'scripts/metaculus-ext.jsh',
    ['-h'],
    'metaculus-ext — SLICC-only extensions to the metaculus skill (not public API).',
  ],
  [
    'scripts/metaculus-ext.jsh',
    ['cp', '--help'],
    'metaculus-ext — SLICC-only extensions to the metaculus skill (not public API).',
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
