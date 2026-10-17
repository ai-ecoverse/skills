import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// wavespeed reads prompts and its key fallback, and saves outputs, with Node's
// fs (fs.promises and a fetchToFile helper), which slicc-jsh (SLICC 7) and
// SLICC 6 both serve; SLICC 6's readFileBinary / fetchToFile do not exist on 7
// (#487). The functions run are the shipped ones.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/wavespeed.jsh'), 'utf8');

test('a prompt file is decoded as UTF-8', async () => {
  const { readTextUtf8 } = load(SOURCE, ['readTextUtf8'], {
    fs: nodeFs({ '/shared/p.txt': 'Café — 日本' }),
  });
  is(await readTextUtf8('/shared/p.txt'), 'Café — 日本');
});

test('the key falls back to the secrets file', async () => {
  const { getKey } = load(SOURCE, ['getKey'], {
    fs: nodeFs({ '/shared/.wavespeed-key': 'ws_key_123\n' }),
    SECRETS_FALLBACK: '/shared/.wavespeed-key',
    process: { env: {} },
    loadConfig: async () => ({}),
  });
  is(await getKey(), 'ws_key_123');
});

test('outputs are saved with fetchToFile', async () => {
  const vfs = nodeFs();
  const bytes = new Uint8Array([255, 216, 255, 224]);
  const { fetchToFile } = load(SOURCE, ['fetchToFile'], {
    fs: vfs,
    fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer }),
  });
  is(await fetchToFile('https://cdn.wavespeed.ai/o.jpg', '/shared/o.jpg'), 4);
  is(Array.from(vfs.files['/shared/o.jpg']), [255, 216, 255, 224]);
});
