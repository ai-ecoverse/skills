import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// interview-me installs its sprinkle and writes its runtime config with
// Node's fs (fs.promises.mkdir/readFile/writeFile/readdir), which slicc-jsh
// (SLICC 7) and SLICC 6 both serve; the SLICC 6 promise dialect fails under
// Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/interview-me.jsh'), 'utf8');
const SPRINKLE_DIR = '/shared/sprinkles/interview-me';
const ASSETS = '/workspace/skills/interview-me/assets';

test('install copies the panel and its lib modules and seeds config.json once', async () => {
  const vfs = nodeFs({
    [`${ASSETS}/sprinkle/interview-me.shtml`]: '<html>panel</html>',
    [`${ASSETS}/sprinkle/lib/kb.js`]: 'export const kb = 1;',
    [`${ASSETS}/sprinkle/lib/notes.txt`]: 'not a module',
    [`${ASSETS}/kb/README.md`]: '# kb',
  });
  const logs = [];
  const { cmdInstall } = load(SOURCE, ['cmdInstall'], {
    fs: vfs,
    SPRINKLE_DIR,
    SPRINKLE_CONFIG_FILE: `${SPRINKLE_DIR}/config.json`,
    KB_DIR: `${SPRINKLE_DIR}/kb`,
    resolveAssetsRoot: async () => ASSETS,
    readConfig: async () => ({ model: 'default' }),
    console: { log: (m) => logs.push(m) },
  });
  await cmdInstall();
  is(vfs.text(`${SPRINKLE_DIR}/interview-me.shtml`), '<html>panel</html>');
  is(vfs.text(`${SPRINKLE_DIR}/lib/kb.js`), 'export const kb = 1;');
  is(vfs.text(`${SPRINKLE_DIR}/lib/notes.txt`), undefined);
  is(JSON.parse(vfs.text(`${SPRINKLE_DIR}/config.json`)), { model: 'default' });
  is(vfs.text(`${SPRINKLE_DIR}/KB-README.md`), '# kb');
  ok(logs[0].startsWith('Installed interview-me.shtml + 1 lib module(s)'));
});

test('writeConfig mirrors the merged config into the sprinkle', async () => {
  const vfs = nodeFs();
  const { writeConfig } = load(SOURCE, ['writeConfig'], {
    fs: vfs,
    SPRINKLE_CONFIG_FILE: `${SPRINKLE_DIR}/config.json`,
    skill: { config: async (c) => ({ model: 'default', ...c }) },
  });
  await writeConfig({ voice: 'Ava' });
  is(JSON.parse(vfs.text(`${SPRINKLE_DIR}/config.json`)), { model: 'default', voice: 'Ava' });
});
