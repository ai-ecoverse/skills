import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/apple-music.jsh', ['search', '--help'], 'apple-music — Apple Music CLI for SLICC'],
  ['scripts/apple-music.jsh', ['search', '-h'], 'apple-music — Apple Music CLI for SLICC'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
