import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/check-ai-words.jsh',
    ['--help'],
    'check-ai-words — detect overused AI vocabulary against corpus base rates',
  ],
  [
    'scripts/check-ai-words.jsh',
    ['-h'],
    'check-ai-words — detect overused AI vocabulary against corpus base rates',
  ],
  [
    'scripts/check-ai-patterns.jsh',
    ['--help'],
    'check-ai-patterns — AI pattern checker (vocabulary rates, em-dash usage, structural patterns)',
  ],
  [
    'scripts/check-ai-patterns.jsh',
    ['-h'],
    'check-ai-patterns — AI pattern checker (vocabulary rates, em-dash usage, structural patterns)',
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
