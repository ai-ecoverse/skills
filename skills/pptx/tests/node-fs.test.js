import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { nodeFs } from './node-fs.js';

// pptx-lib stages the deck through a base64 file written with Node's fs
// (require('fs').promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve;
// a bare `fs` global exists on neither (ai-ecoverse/skills#487). The library
// is evaluated as SKILL.md inlines it, with the shell stubbed.
const LIB = fs.readFileSync(path.join(process.cwd(), 'scripts/pptx-lib.jsh'), 'utf8');

test('writePptx stages the bytes as base64 and decodes them into the output', async () => {
  const vfs = nodeFs();
  const cmds = [];
  const exec = async (cmd) => {
    cmds.push(cmd);
    return { stdout: cmd.startsWith('wc -c') ? "4 '/shared/deck.pptx'" : '' };
  };
  const { writePptx } = await new Function('require', 'exec', `${LIB}\nreturn { writePptx };`)(
    (id) => {
      if (id === 'fs') return vfs;
      throw new Error(`unexpected require(${id})`);
    },
    exec
  );
  is(await writePptx(new Uint8Array([80, 75, 3, 4]), '/shared/deck.pptx'), "4 '/shared/deck.pptx'");
  is(vfs.text('/tmp/_pptx_export.b64'), 'UEsDBA==');
  is(cmds[0], "cat /tmp/_pptx_export.b64 | base64 -d > '/shared/deck.pptx'");
});
