import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// pptx2pdf reads the deck and writes the PDF with Node's fs
// (require('fs').promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve;
// SLICC 6's readFileBinary / writeFileBinary do not exist on 7, and a bare
// `fs` global exists on neither (ai-ecoverse/skills#487). The library is
// loaded the way SKILL.md loads it, with pdf-lib and JSZip stubbed.
const LIB = fs.readFileSync(path.join(process.cwd(), 'scripts/pptx2pdf-lib.jsh'), 'utf8');

test('convertPptxToPdf reads the PPTX bytes and writes the PDF', async () => {
  const deck = new Uint8Array([80, 75, 3, 4, 9, 9]);
  const pdf = new Uint8Array([37, 80, 68, 70]);
  const vfs = nodeFs({ '/shared/deck.pptx': deck });
  let loaded = null;
  const JSZip = {
    loadAsync: async (bytes) => {
      loaded = Array.from(bytes);
      return { files: {}, file: () => null };
    },
  };
  const fakePdfLib = {
    StandardFonts: {
      Helvetica: 'H',
      HelveticaBold: 'HB',
      HelveticaOblique: 'HO',
      HelveticaBoldOblique: 'HBO',
    },
    PDFDocument: {
      create: async () => ({ embedFont: async (n) => ({ name: n }), save: async () => pdf }),
    },
  };
  const req = (id) => {
    if (id === 'fs') return vfs;
    if (id === 'jszip') return JSZip;
    throw new Error(`unexpected require(${id})`);
  };
  const logs = [];
  const lib = await new Function(
    'require',
    'exec',
    'console',
    `${LIB}\n_pdfLib = arguments[3];\nreturn { convertPptxToPdf };`
  )(req, async () => ({ stdout: '4 /shared/deck.pdf' }), { log: (m) => logs.push(m) }, fakePdfLib);
  is(await lib.convertPptxToPdf('/shared/deck.pptx', '/shared/deck.pdf'), '/shared/deck.pdf');
  is(loaded, Array.from(deck));
  is(Array.from(vfs.files['/shared/deck.pdf']), Array.from(pdf));
  ok(logs.some((l) => l.startsWith('PDF written')));
});
