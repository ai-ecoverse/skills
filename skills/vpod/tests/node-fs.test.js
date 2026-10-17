import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// vpod keeps session locks and metadata with Node's fs (existsSync,
// fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6
// promise dialect fails under Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/vpod.jsh'), 'utf8');
const SESSION_DIR = '/shared/vpod/sessions';

function store(vfs) {
  return load(SOURCE, ['readJson', 'isLocked', 'acquireLock', 'listSessions'], {
    fs: vfs,
    SESSION_DIR,
    LOCK_SLACK_MS: 1000,
    TOOL: 'vpod',
    metaPath: (n) => `${SESSION_DIR}/${n}.json`,
    deltaPath: (n) => `${SESSION_DIR}/${n}.delta`,
    lockPath: (n) => `${SESSION_DIR}/${n}.lock`,
    cli: {
      die: (m) => {
        throw new Error(m);
      },
    },
  });
}

test('a session lock is written, seen as held, and refuses a second taker', async () => {
  const vfs = nodeFs();
  const s = store(vfs);
  const token = await s.acquireLock('dev', 60000);
  ok(JSON.parse(vfs.text(`${SESSION_DIR}/dev.lock`)).token === token);
  is(await s.isLocked('dev'), true);
  let err = null;
  try {
    await s.acquireLock('dev', 60000);
  } catch (e) {
    err = e;
  }
  ok(err && err.message.includes("session 'dev' is busy"), String(err));
});

test('listSessions reads the metadata and the delta size', async () => {
  const vfs = nodeFs({
    [`${SESSION_DIR}/dev.json`]: JSON.stringify({ snapshotId: 's1', savedAt: 5 }),
    [`${SESSION_DIR}/dev.delta`]: new Uint8Array(42),
  });
  const s = store(vfs);
  const list = await s.listSessions();
  is(
    list.map((x) => [x.name, x.deltaBytes, x.locked]),
    [['dev', 42, false]]
  );
});
