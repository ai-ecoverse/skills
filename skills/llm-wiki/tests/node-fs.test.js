import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// wiki keeps its config and reads the wiki tree with Node's fs (existsSync,
// fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6
// promise dialect fails under Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'wiki.jsh'), 'utf8');

test('the config object round-trips (writeConfigObject, readConfigObject)', async () => {
  const vfs = nodeFs();
  const w = load(SOURCE, ['readConfigObject', 'writeConfigObject', 'parentDir'], {
    fs: vfs,
    configFilePath: () => '/home/u/.config/llm-wiki/config.json',
  });
  is(await w.readConfigObject(), {});
  await w.writeConfigObject({ root: '/shared/wiki' });
  is(await w.readConfigObject(), { root: '/shared/wiki' });
});
