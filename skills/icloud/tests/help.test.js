import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/icloud.jsh', ['calendars', '--help'], 'icloud — iCloud Calendar & Notes CLI for SLICC'],
  ['scripts/icloud.jsh', ['notes', '-h'], 'icloud — iCloud Calendar & Notes CLI for SLICC'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
