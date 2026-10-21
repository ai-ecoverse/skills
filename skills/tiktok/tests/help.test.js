import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/tiktok.jsh', ['-h'], 'TikTok web API client — drive TikTok from the command line.'],
  [
    'scripts/tiktok.jsh',
    ['post', 'video.mp4', '--help'],
    'TikTok web API client — drive TikTok from the command line.',
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
