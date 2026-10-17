import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// excel caches its Graph token, uploads and downloads workbooks with Node's
// fs (existsSync, fs.promises incl. chmod), which slicc-jsh (SLICC 7) and SLICC 6
// both serve; the SLICC 6 promise dialect, and fs.chmod without a callback,
// fail under Node semantics (ai-ecoverse/skills#487). Runs the shipped
// functions with Graph stubbed.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/excel.jsh'), 'utf8');
const TOKEN_CACHE = '/tmp/.slicc-excel-token.json';

test('the token cache round-trips and is made owner-only', async () => {
  const vfs = nodeFs();
  const modes = [];
  vfs.promises.chmod = async (p, m) => modes.push([p, m]);
  const c = load(SOURCE, ['readCache', 'writeCache'], { fs: vfs, TOKEN_CACHE });
  is(await c.readCache(), null);
  await c.writeCache({ token: 'eyJ.x.y', exp: 1 });
  is(await c.readCache(), { token: 'eyJ.x.y', exp: 1 });
  is(modes, [[TOKEN_CACHE, 0o600]]);
});

test('download writes the workbook bytes', async () => {
  const vfs = nodeFs();
  const done = [];
  const xlsx = new Uint8Array([80, 75, 3, 4]);
  const { cmdDownload } = load(SOURCE, ['cmdDownload'], {
    fs: vfs,
    flags: { out: '/shared/Budget.xlsx' },
    ref: () => ({
      meta: '/me/drive/root:/Budget.xlsx',
      content: '/me/drive/root:/Budget.xlsx:/content',
    }),
    graph: async (_p, o) =>
      o && o.binary ? Buffer.from(xlsx) : { id: 'I1', name: 'Budget.xlsx', size: 4 },
    ok: (m) => done.push(m),
    human: (n) => `${n} B`,
    c: { bold: (s) => s },
    cli: {
      die: (m) => {
        throw new Error(m);
      },
    },
  });
  await cmdDownload('/Budget.xlsx');
  is(Array.from(vfs.files['/shared/Budget.xlsx']), [80, 75, 3, 4]);
  ok(done[0].includes('/shared/Budget.xlsx'));
});

test('upload refuses a local file that does not exist', async () => {
  const { cmdUpload } = load(SOURCE, ['cmdUpload'], {
    fs: nodeFs(),
    cli: {
      die: (m) => {
        throw new Error(m);
      },
    },
  });
  let err = null;
  try {
    await cmdUpload('/shared/none.xlsx');
  } catch (e) {
    err = e;
  }
  is(err?.message, 'no such local file: /shared/none.xlsx');
});
