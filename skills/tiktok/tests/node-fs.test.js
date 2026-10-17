import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// tiktok post reads the video with Node's fs (existsSync, fs.promises.readFile
// for bytes), which slicc-jsh (SLICC 7) and SLICC 6 both serve; SLICC 6's
// fs.exists / readFileBinary do not exist on 7 (#487). This runs the shipped
// cmdPost up to the login check, so nothing is uploaded.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/tiktok.jsh'), 'utf8');

function post(vfs, file) {
  const logs = [];
  const STOP = new Error('stop before upload');
  const { cmdPost } = load(SOURCE, ['cmdPost'], {
    fs: vfs,
    VISIBILITY: { self: 1, friends: 2, public: 0 },
    probeVideo: async () => ({ error: 'no ffprobe here' }),
    ownIdentity: async () => {
      throw STOP;
    },
    postFail: (msg) => {
      throw Object.assign(new Error(msg), { name: 'PostFail' });
    },
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
  });
  return cmdPost([file], {}).then(
    () => ({ logs, err: null }),
    (err) => ({ logs, err: err === STOP ? null : err })
  );
}

test('post reads the video bytes before talking to TikTok', async () => {
  const r = await post(nodeFs({ '/shared/clip.mp4': new Uint8Array(1234) }), '/shared/clip.mp4');
  is(r.err, null);
  ok(
    r.logs.some((l) => l.includes('1234 bytes')),
    r.logs.join('\n')
  );
});

test('a missing video stops with "file not found"', async () => {
  const r = await post(nodeFs(), '/shared/none.mp4');
  is(r.err?.message, 'file not found: /shared/none.mp4');
});
