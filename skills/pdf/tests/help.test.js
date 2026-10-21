import test, { is, ok } from 'tst';
import { runHelp } from './help.js';

const cases = [
  ['scripts/create-pdf.jsh', ['--help'], 'create-pdf — create a PDF from scratch with pdf-lib'],
  ['scripts/create-pdf.jsh', ['-h'], 'create-pdf — create a PDF from scratch with pdf-lib'],
  [
    'tests/make-fixtures.jsh',
    ['--help'],
    'make-fixtures — build the deterministic PDF fixtures used by run-tests.sh',
  ],
  [
    'tests/make-fixtures.jsh',
    ['-h'],
    'make-fixtures — build the deterministic PDF fixtures used by run-tests.sh',
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
