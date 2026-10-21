import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/slack.jsh', ['-h'], 'Slack API client — interact with Slack from the command line.'],
  [
    'scripts/slack.jsh',
    ['post', 'C123', 'hello', '--help'],
    'Slack API client — interact with Slack from the command line.',
  ],
  [
    'scripts/slack-support.jsh',
    ['list', '--help'],
    'Slack Support Portal — manage help requests from the command line.',
  ],
  [
    'scripts/slack-support.jsh',
    ['view', '-h'],
    'Slack Support Portal — manage help requests from the command line.',
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
