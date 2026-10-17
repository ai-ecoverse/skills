import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { nodeFs } from './node-fs.js';

// create-pdf writes the document with Node's fs (require('fs').promises) and
// opens it through sliccy:exec, which slicc-jsh (SLICC 7) and SLICC 6 both
// serve; SLICC 6's writeFileBinary and the bare `fs` / `open` globals exist on
// neither (ai-ecoverse/skills#487). pdf-lib comes from esm.sh at run time; the
// test hands the script a stand-in for that one network import.
const SOURCE = fs
  .readFileSync(path.join(process.cwd(), 'scripts/create-pdf.jsh'), 'utf8')
  .replace("await import('https://esm.sh/pdf-lib')", 'pdfLibStub');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('create-pdf writes the PDF bytes and opens the file', async () => {
  const vfs = nodeFs();
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  const font = { widthOfTextAtSize: (t, s) => String(t).length * s * 0.5 };
  const page = { drawText: () => {}, drawLine: () => {} };
  const pdfLibStub = {
    StandardFonts: { Helvetica: 'H', HelveticaBold: 'HB' },
    PDFDocument: {
      create: async () => ({
        embedFont: async () => font,
        addPage: () => page,
        save: async () => bytes,
      }),
    },
  };
  const spawned = [];
  const logs = [];
  await new AsyncFunction('require', 'process', 'console', 'pdfLibStub', SOURCE)(
    (id) => {
      if (id === 'fs') return vfs;
      if (id === 'sliccy:exec') return { spawn: async (argv) => spawned.push(argv) };
      throw new Error(`unexpected require(${id})`);
    },
    { argv: ['node', 'create-pdf.jsh', 'Quarterly Report', '--output=/shared/q.pdf'] },
    { log: (m) => logs.push(m) },
    pdfLibStub
  );
  is(Array.from(vfs.files['/shared/q.pdf']), Array.from(bytes));
  is(spawned, [['open', '/shared/q.pdf', '--download']]);
  is(logs, ['Created: /shared/q.pdf']);
});
