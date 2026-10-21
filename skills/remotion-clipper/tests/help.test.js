import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/remotion.jsh',
    ['validate', '-h'],
    'remotion -- EDL tooling for the interview-clipping pipeline (runs in SLICC)',
  ],
  [
    'scripts/remotion.jsh',
    ['render', '-h'],
    'remotion -- EDL tooling for the interview-clipping pipeline (runs in SLICC)',
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
