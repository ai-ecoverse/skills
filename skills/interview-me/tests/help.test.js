import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/interview-me.jsh',
    ['install', '--help'],
    'interview-me — CLI for the interview-me voice-interview skill',
  ],
  [
    'scripts/interview-me.jsh',
    ['set', '-h'],
    'interview-me — CLI for the interview-me voice-interview skill',
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
