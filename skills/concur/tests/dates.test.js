import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { readScript } from './script.js';

const SOURCE = readScript(path.join(process.cwd(), 'scripts/concur.jsh'));
const { v3DateFilters, buildQS } = load(SOURCE, ['v3DateFilters', 'buildQS'], {});

test('modifiedAfter is sent as modifiedDateAfter', () => {
  const f = v3DateFilters({ modifiedAfter: '2026-01-01' });
  is(f.modifiedDateAfter, '2026-01-01');
  ok(!('modifiedAfter' in f));
});

test('all four flags map to the names Concur honours', () => {
  const f = v3DateFilters({
    modifiedAfter: '2026-01-01',
    modifiedBefore: '2026-02-01T00:00:00',
    createdAfter: '2026-03-01',
    createdBefore: '2026-04-01',
  });
  is(
    buildQS(f),
    '?modifiedDateAfter=2026-01-01&modifiedDateBefore=2026-02-01T00%3A00%3A00&createDateAfter=2026-03-01&createDateBefore=2026-04-01'
  );
});

test('unset flags add nothing', () => {
  is(buildQS(v3DateFilters({ limit: '25' })), '');
});
