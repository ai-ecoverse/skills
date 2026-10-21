import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  [
    'scripts/oryx.jsh',
    ['--help'],
    'oryx — ZSA Oryx API client (GraphQL access to the oryx.zsa.io keyboard configurator)',
  ],
  [
    'scripts/oryx.jsh',
    ['-h'],
    'oryx — ZSA Oryx API client (GraphQL access to the oryx.zsa.io keyboard configurator)',
  ],
  [
    'scripts/oryx.jsh',
    ['whoami', '--help'],
    'oryx — ZSA Oryx API client (GraphQL access to the oryx.zsa.io keyboard configurator)',
  ],
  [
    'scripts/oryx.jsh',
    ['grid', '-h'],
    'oryx — ZSA Oryx API client (GraphQL access to the oryx.zsa.io keyboard configurator)',
  ],
];

for (const [script, words, usage] of cases) {
  test(`${script} ${words.join(' ')} prints usage and exits 0`, async () => {
    const r = await runHelp(script, words, { denyFs: true });
    is(r.exitCode, 0);
    ok(r.stdout.includes(usage), 'usage on stdout');
    is(r.stderr, '');
  });
}
