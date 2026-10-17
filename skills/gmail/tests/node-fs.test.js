import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { exitStub, load } from './extract.js';
import { nodeFs } from './node-fs.js';

// gmail download writes attachment bytes with Node's fs.promises, which
// slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6 promise dialect
// fails under Node semantics (#487). Runs the shipped cmdDownload with the
// Gmail API stubbed.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/gmail.jsh'), 'utf8');

test('download writes every attachment into the --out directory', async () => {
  const vfs = nodeFs();
  const exit = exitStub();
  const out = [];
  const msg = {
    payload: {
      parts: [
        { filename: 'a.pdf', body: { attachmentId: 'A1', size: 3 } },
        { filename: 'b.txt', body: { attachmentId: 'B2', size: 2 } },
      ],
    },
  };
  const data = { A1: 'JVBE', B2: 'aGk' }; // base64url of "%PD" and "hi"
  const { cmdDownload } = load(
    SOURCE,
    ['cmdDownload', 'collectAttachments', 'decodeBase64UrlBytes'],
    {
      require: (id) => {
        if (id === 'fs') return vfs;
        throw new Error(`unexpected require(${id})`);
      },
      positional: ['M1'],
      flags: { out: '/shared/att/', json: true },
      gmailGet: async (p) =>
        p.includes('/attachments/') ? { data: data[p.split('/').pop()] } : msg,
      die: exit.die,
      C: { green: (s) => s },
      process: { stdout: { write: (s) => out.push(s) } },
    }
  );
  await cmdDownload();
  is(exit.dies, []);
  is(vfs.text('/shared/att/a.pdf'), '%PD');
  is(vfs.text('/shared/att/b.txt'), 'hi');
  is(
    JSON.parse(out.join('')).map((w) => w.bytes),
    [3, 2]
  );
});
