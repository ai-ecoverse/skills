import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// firefly saves generated images with Node's fs (mkdir, writeFile), which
// slicc-jsh (SLICC 7) and SLICC 6 both serve; SLICC 6's writeFileBinary does
// not exist on 7 (#487). Runs the shipped downloadOutputs with fetch stubbed.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/firefly.jsh'), 'utf8');

test('downloadOutputs writes each generated image', async () => {
  const vfs = nodeFs();
  const png = new Uint8Array([137, 80, 78, 71]);
  const warnings = [];
  const { downloadOutputs } = load(SOURCE, ['downloadOutputs', 'shortJobId'], {
    fs: vfs,
    Buffer,
    fetch: async (url) =>
      url.endsWith('/bad.png')
        ? { ok: false, status: 403 }
        : { ok: true, arrayBuffer: async () => png.buffer },
    cli: { warn: (m) => warnings.push(m) },
  });
  const saved = await downloadOutputs(
    [
      { image: { url: 'https://f.example/1.png' } },
      { image: { url: 'https://f.example/bad.png' } },
    ],
    '/shared/ff/',
    'urn:job:abcdef1234567890'
  );
  is(saved.length, 1);
  is(Array.from(vfs.files[saved[0]]), [137, 80, 78, 71]);
  is(warnings, ['Failed to download output 2 (403)']);
});
