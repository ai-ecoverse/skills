import test, { is, ok } from 'tst';
import * as runtimeMod from '../scripts/kev-runtime.js';

const runtime = runtimeMod.default || runtimeMod;

const BASE = '/workspace/models/ai-ecoverse/kev.js/kev-9b';
const MANIFEST = {
  files: { tokenizer: 'tokenizer.json', tokenizer_config: 'tokenizer_config.json', head: 'head.json' },
  variants: {
    q8f32: {
      model: 'r-1/q8f32/model.onnx',
      data: ['r-1/q8f32/model.onnx.data', 'r-1/q8f32/model.onnx.data_1'],
      sizes: { 'r-1/q8f32/model.onnx.data': 50, 'r-1/q8f32/model.onnx.data_1': 40 },
    },
  },
};

// A VFS with the given files and sizes, and no network: exec must stay unused.
function fakeFs(files) {
  return {
    async exists(path) {
      return path in files;
    },
    async readFile(path) {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
    async stat(path) {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return { size: typeof files[path] === 'number' ? files[path] : files[path].length };
    },
  };
}

test('no manifest means nothing is downloaded yet', async () => {
  const status = await runtime.weightsStatus(fakeFs({}), '9b');
  is(status.manifest, false);
  is(status.missing, ['manifest.json']);
  const message = runtime.missingWeightsMessage(status);
  ok(message.includes('kev pull --model 9b'), message);
  ok(message.includes('8.8 GB'), message);
  ok(message.includes("slicc's hf"), message);
});

test('a short or absent shard is missing; a full one is not', async () => {
  const status = await runtime.weightsStatus(
    fakeFs({
      [`${BASE}/manifest.json`]: JSON.stringify(MANIFEST),
      [`${BASE}/tokenizer.json`]: 10,
      [`${BASE}/tokenizer_config.json`]: 10,
      [`${BASE}/head.json`]: 10,
      [`${BASE}/r-1/q8f32/model.onnx`]: 10,
      [`${BASE}/r-1/q8f32/model.onnx.data`]: 20,
    }),
    '9b'
  );
  is(status.files, 6);
  is(status.missing, ['r-1/q8f32/model.onnx.data', 'r-1/q8f32/model.onnx.data_1']);
  ok(runtime.missingWeightsMessage(status).startsWith('2 of 6 kev-9b weight files are missing'));
});

test('a complete model has nothing missing', async () => {
  const status = await runtime.weightsStatus(
    fakeFs({
      [`${BASE}/manifest.json`]: JSON.stringify(MANIFEST),
      [`${BASE}/tokenizer.json`]: 10,
      [`${BASE}/tokenizer_config.json`]: 10,
      [`${BASE}/head.json`]: 10,
      [`${BASE}/r-1/q8f32/model.onnx`]: 10,
      [`${BASE}/r-1/q8f32/model.onnx.data`]: 50,
      [`${BASE}/r-1/q8f32/model.onnx.data_1`]: 40,
    }),
    '9b'
  );
  is(status.missing, []);
});
