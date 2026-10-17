import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// intent-arm reads the scoop's scripts and transcript with Node's fs
// (fs.promises.readdir/stat/readFile), which slicc-jsh (SLICC 7) and SLICC 6
// both serve; the SLICC 6 promise dialect, and stat's isDirectory read as a
// boolean, fail under Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/intent-arm.jsh'), 'utf8');

test('scriptsIn walks the scoop directory and keeps only scripts', async () => {
  const vfs = nodeFs({
    '/scoops/s1/run.sh': 'echo hi',
    '/scoops/s1/lib/a.mjs': 'export {}',
    '/scoops/s1/notes.md': '# not a script',
  });
  const { scriptsIn } = load(SOURCE, ['scriptsIn'], { fs: vfs });
  const found = await scriptsIn('/scoops/s1');
  is(found.map((f) => f.name).sort(), ['lib/a.mjs', 'run.sh']);
  is(found.find((f) => f.name === 'run.sh').text, 'echo hi');
});

test('findTranscript picks this run’s transcript by name and prompt', async () => {
  const vfs = nodeFs({
    '/tmp/agent-arm-2026-10-17T10-00-01-000Z.md': 'PROMPT: buy milk\n...',
    '/tmp/agent-arm-2026-10-17T09-00-00-000Z.md': 'PROMPT: older run',
  });
  const { findTranscript } = load(SOURCE, ['findTranscript'], { fs: vfs });
  is(
    await findTranscript(Date.parse('2026-10-17T10:00:00Z'), 'PROMPT: buy milk'),
    'PROMPT: buy milk\n...'
  );
});
