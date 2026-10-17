import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// pandoc reads inputs and font folders with Node's fs (fs.promises.readFile
// for bytes, readdir, stat with isDirectory()/isFile()), which slicc-jsh
// (SLICC 7) and SLICC 6 both serve; SLICC 6's readFileBinary / readDir, and
// stat's booleans, fail under Node semantics (ai-ecoverse/skills#487).
// pandoc.jsh is a copy of pandoc.src.js; both are checked.
const read = (f) => fs.readFileSync(path.join(process.cwd(), 'scripts', f), 'utf8');

for (const file of ['pandoc.jsh', 'pandoc.src.js']) {
  const SOURCE = read(file);

  test(`${file}: font folders are walked for .otf/.ttf files`, async () => {
    const vfs = nodeFs({
      '/fonts/Inter-Regular.ttf': 'x',
      '/fonts/extra/Mono.otf': 'x',
      '/fonts/LICENSE.txt': 'x',
    });
    const { collectFontFiles } = load(SOURCE, ['collectFontFiles'], {
      fs: vfs,
      FONT_FILE: /\.(otf|ttf)$/i,
    });
    is((await collectFontFiles('/fonts', [])).sort(), [
      '/fonts/Inter-Regular.ttf',
      '/fonts/extra/Mono.otf',
    ]);
  });

  test(`${file}: text inputs are decoded as UTF-8, binary ones passed as bytes`, async () => {
    const vfs = nodeFs({
      '/shared/a.md': '# Café — 日本',
      '/shared/b.docx': new Uint8Array([80, 75, 3, 4]),
    });
    const { readInputForConvert } = load(SOURCE, ['readInputForConvert'], {
      fs: vfs,
      BINARY_FROM: new Set(['docx']),
    });
    is(await readInputForConvert('/shared/a.md', 'markdown'), {
      stdin: '# Café — 日本',
      files: {},
    });
    const bin = await readInputForConvert('/shared/b.docx', 'docx');
    is(Array.from(bin.files['b.docx']), [80, 75, 3, 4]);
  });
}

test('pandoc.jsh and pandoc.src.js stay identical', () => {
  is(read('pandoc.jsh'), read('pandoc.src.js'));
});
