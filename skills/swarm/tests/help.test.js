import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/swarm.jsh', ['checkins', '--help'], 'swarm — Foursquare/Swarm check-in history'],
  ['scripts/swarm.jsh', ['venue', '-h'], 'swarm — Foursquare/Swarm check-in history'],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words);
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
