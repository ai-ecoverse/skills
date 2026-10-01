import test, { is, ok } from 'tst';
import * as traceMod from '../scripts/trace.js';

const traceLib = traceMod.default || traceMod;

function memoryFs() {
  const files = new Map();
  return {
    files,
    async mkdir() {},
    async exists(path) {
      return files.has(path);
    },
    async readFile(path) {
      if (!files.has(path)) throw new Error(`ENOENT ${path}`);
      return files.get(path);
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
  };
}

test('runId is sortable and names the run', () => {
  is(
    traceLib.runId(Date.UTC(2026, 9, 1, 17, 5, 9), 'www.google.com'),
    '2026-10-01T17-05-09-www-google-com'
  );
  is(traceLib.runId(0, '***'), '1970-01-01T00-00-00-run');
});

test('a trace writes start, steps and end as JSON lines and indexes the run', async () => {
  const fs = memoryFs();
  const trace = await traceLib.openTrace(fs, { id: 'r1' });
  await trace.start({ goal: 'g', url: 'https://x', decider: 'kev 9b' });
  await trace.step({ step: 1, decide: { action: { id: 'WAIT' } } });
  await trace.file('step-01.snapshot.txt', 'raw');
  let index = JSON.parse(fs.files.get(traceLib.INDEX));
  is(index[0].ok, null, 'a running run is indexed before it ends');
  await trace.end({ ok: true, reason: 'check passed', steps: 1 });
  const lines = fs.files
    .get('/tmp/meep/runs/r1/trace.jsonl')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  is(
    lines.map((l) => l.type),
    ['start', 'step', 'end']
  );
  is(lines[1].step, 1);
  is(fs.files.get('/tmp/meep/runs/r1/step-01.snapshot.txt'), 'raw');
  index = JSON.parse(fs.files.get(traceLib.INDEX));
  is(index.length, 1);
  is([index[0].id, index[0].ok, index[0].goal, index[0].steps], ['r1', true, 'g', 1]);
});

test('a failing write never fails the run', async () => {
  const fs = memoryFs();
  fs.writeFile = async () => {
    throw new Error('disk full');
  };
  const trace = await traceLib.openTrace(fs, { id: 'r2' });
  await trace.start({ goal: 'g' });
  await trace.step({ step: 1 });
  await trace.end({ ok: false });
  ok(true);
});

test('clip keeps short text and marks what it cut', () => {
  is(traceLib.clip('abc', 10), 'abc');
  is(traceLib.clip(null), '');
  ok(traceLib.clip('x'.repeat(20), 5).startsWith('xxxxx… (15 more chars)'));
});
