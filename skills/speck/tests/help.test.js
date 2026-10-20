import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['speck.jsh', ['collect', '--help'], 'speck — element annotation layer for local HTML pages'],
  ['speck.jsh', ['remove', '-h'], 'speck — element annotation layer for local HTML pages'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
