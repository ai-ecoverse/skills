import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// linkedin keeps its notification-watch state with Node's fs (fs.promises),
// which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6 promise dialect
// fails under Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/linkedin.jsh'), 'utf8');

test('watch state is saved through fs.promises', async () => {
  const vfs = nodeFs();
  const { saveWatchState } = load(SOURCE, ['saveWatchState'], {
    fs: vfs,
    WATCH_STATE_FILE: '/shared/.linkedin-watch-state.json',
  });
  await saveWatchState({ seen: ['urn:li:activity:1'] });
  is(JSON.parse(vfs.text('/shared/.linkedin-watch-state.json')), { seen: ['urn:li:activity:1'] });
});
