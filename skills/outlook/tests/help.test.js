import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/outlook.jsh', ['view', '--help'], 'outlook — Microsoft Outlook CLI for SLICC'],
  ['scripts/outlook.jsh', ['event', '-h'], 'outlook — Microsoft Outlook CLI for SLICC'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
