import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// kev and cua-s1 read documents and model manifests with Node's fs
// (existsSync, fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve;
// the SLICC 6 promise dialect fails under Node semantics (#487). The functions
// run are the shipped ones, cut out of the scripts.
const KEV = fs.readFileSync(path.join(process.cwd(), 'scripts/kev.jsh'), 'utf8');
const CUA = fs.readFileSync(path.join(process.cwd(), 'scripts/cua-s1.jsh'), 'utf8');
const DEST = '/workspace/models/ai-ecoverse/kev.js';

function host(downloads) {
  return {
    resolvePath: (p) => p,
    hfDownload: async (_exec, repo, files, dest) => downloads.push({ repo, files, dest }),
  };
}

test('kev ask --state <file> reads the file as text', async () => {
  const { readArg } = load(KEV, ['readArg'], {
    fs: nodeFs({ '/shared/t.txt': 'Refund please — order 42' }),
    host: host([]),
  });
  is(await readArg('/shared/t.txt'), 'Refund please — order 42');
});

test('kev weights: a cached manifest is read, and only the model files are fetched', async () => {
  const manifest = {
    files: { tokenizer: 'tok.json', tokenizer_config: 'tokcfg.json', head: 'head.bin' },
    variants: { q8f32: { model: 'model.onnx', data: ['model.onnx_data'] } },
  };
  const downloads = [];
  const { ensureWeights } = load(KEV, ['ensureWeights'], {
    fs: nodeFs({ [`${DEST}/kev-0.8b/manifest.json`]: JSON.stringify(manifest) }),
    host: host(downloads),
    MODELS: { '0.8b': 'kev-0.8b' },
    DEST,
    exec: {},
  });
  is(await ensureWeights('0.8b'), `${DEST}/kev-0.8b`);
  is(downloads.length, 1, 'no manifest download');
  is(downloads[0].files, [
    'kev-0.8b/tok.json',
    'kev-0.8b/tokcfg.json',
    'kev-0.8b/head.bin',
    'kev-0.8b/model.onnx',
    'kev-0.8b/model.onnx_data',
  ]);
});

test('cua-s1 weights: the manifest is fetched when missing, then read', async () => {
  const D = '/workspace/models/ai-ecoverse/cua-s1.js';
  const vfs = nodeFs();
  const downloads = [];
  const { downloadWeights } = load(CUA, ['downloadWeights'], {
    fs: vfs,
    DEST: D,
    PREFIX: 'cua-s1-forms',
    exec: {},
    host: {
      hfDownload: async (_e, _repo, files) => {
        downloads.push(files);
        if (files[0].endsWith('manifest.json'))
          await vfs.promises.writeFile(`${D}/${files[0]}`, '{"model":"m.onnx"}');
      },
    },
  });
  is(await downloadWeights(), `${D}/cua-s1-forms`);
  is(downloads, [['cua-s1-forms/manifest.json'], ['cua-s1-forms/m.onnx']]);
});
