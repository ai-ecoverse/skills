import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// slack keeps per-channel "last post" state with Node's fs (fs.promises),
// which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6 promise dialect
// fails under Node semantics (ai-ecoverse/skills#487). Runs the shipped
// rememberLastPostTs / readLastPost.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/slack.jsh'), 'utf8');

test('the last post a cone made round-trips with its owner', async () => {
  const vfs = nodeFs();
  const s = load(SOURCE, ['rememberLastPostTs', 'readLastPost', 'lastPostFile', 'stateOwner'], {
    fs: vfs,
    LAST_POST_DIR: '/workspace/skills/slack/.state',
  });
  await s.rememberLastPostTs('T1', 'C1', '1791442410.765389', 'cone-a');
  is(await s.readLastPost('T1', 'C1'), { ts: '1791442410.765389', owner: 'cone-a' });
  is(await s.readLastPost('T1', 'C2'), null);
});
