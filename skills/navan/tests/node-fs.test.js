import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// navan saves receipts and itineraries with Node's fs.promises, which
// slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6 promise dialect
// fails under Node semantics (#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/navan.jsh'), 'utf8');

test('writeBase64 writes the decoded bytes', async () => {
  const vfs = nodeFs();
  const { writeBase64 } = load(SOURCE, ['writeBase64'], { fs: vfs });
  await writeBase64('/shared/receipt.pdf', Buffer.from('%PDF-1.7').toString('base64'));
  is(vfs.text('/shared/receipt.pdf'), '%PDF-1.7');
});
