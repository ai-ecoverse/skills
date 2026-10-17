import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { exitStub, load } from './extract.js';
import { nodeFs } from './node-fs.js';

// printful mockup downloads the rendered previews with Node's fs (mkdir,
// writeFile, stat via a fetchToFile helper), which slicc-jsh (SLICC 7) and
// SLICC 6 both serve; SLICC 6's fs.fetchToFile does not exist on 7 (#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/printful.jsh'), 'utf8');

test('mockup saves every preview and reports its size', async () => {
  const vfs = nodeFs();
  const exit = exitStub();
  const out = [];
  const png = new Uint8Array([137, 80, 78, 71, 13, 10]);
  const { cmdMockup } = load(SOURCE, ['cmdMockup', 'fetchToFile', 'str', 'num', 'bool', 'slug'], {
    fs: vfs,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => png.buffer,
      url,
    }),
    collectPreviews: async () => [
      {
        variant: 'Black / M',
        fileId: 11,
        variantId: 1,
        url: 'https://files.cdn.printful.com/m1.png',
      },
      {
        variant: 'White / L',
        fileId: 12,
        variantId: 2,
        url: 'https://files.cdn.printful.com/m2.png',
      },
    ],
    cli: { die: exit.die, out: (v) => out.push(v), warn: () => {} },
    exec: {},
  });
  await cmdMockup(['P1'], { out: '/shared/mockups', json: true });
  is(exit.dies, []);
  const saved = out[0];
  is(
    saved.map((s) => [s.path, s.bytes]),
    [
      ['/shared/mockups/black-m-11.png', 6],
      ['/shared/mockups/white-l-12.png', 6],
    ]
  );
  is(Array.from(vfs.files['/shared/mockups/black-m-11.png']), Array.from(png));
});

test('a failed preview download is an error, not an empty file', async () => {
  const vfs = nodeFs();
  const { fetchToFile } = load(SOURCE, ['fetchToFile'], {
    fs: vfs,
    fetch: async () => ({ ok: false, status: 404, statusText: 'Not Found' }),
  });
  let err = null;
  try {
    await fetchToFile('https://files.cdn.printful.com/x.png', '/shared/x.png');
  } catch (e) {
    err = e;
  }
  is(err?.message, 'fetch 404 Not Found');
  is(vfs.files['/shared/x.png'], undefined);
});
