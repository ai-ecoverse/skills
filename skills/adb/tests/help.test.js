import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/adb.jsh',
    ['pull', '--help'],
    'adb — drive an Android device over WebUSB, no host adb required',
  ],
  [
    'scripts/adb.jsh',
    ['connect', '-h'],
    'adb — drive an Android device over WebUSB, no host adb required',
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
