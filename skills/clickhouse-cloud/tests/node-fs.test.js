import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// clickhouse-cloud stages page probes and reads --file queries with Node's fs
// (fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6
// promise dialect fails under Node semantics (#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/clickhouse-cloud.jsh'), 'utf8');

test('the token probe is written for eval-file and removed afterwards', async () => {
  const vfs = nodeFs();
  const seen = [];
  const { tabHasToken } = load(SOURCE, ['tabHasToken'], {
    fs: vfs,
    exec: async (cmd) => {
      const file = /eval-file (\S+)/.exec(cmd)[1];
      seen.push(vfs.text(file).includes('control-plane-web'));
      return { exitCode: 0, stdout: '"yes"' };
    },
  });
  is(await tabHasToken('T1'), true);
  is(seen, [true]);
  is(Object.keys(vfs.files), [], 'the probe file is gone');
});

test('query --file reads the SQL from the file', async () => {
  const vfs = nodeFs({ '/shared/q.sql': 'SELECT 1\n' });
  let asked = null;
  const STOP = new Error('stop');
  const { cmdQuery } = load(SOURCE, ['cmdQuery'], {
    fs: vfs,
    resolveService: async () => {
      throw STOP;
    },
    console: { error: () => {} },
    process: {
      exit: (c) => {
        throw new Error(`exit ${c}`);
      },
    },
  });
  try {
    await cmdQuery([], { file: '/shared/q.sql' });
  } catch (e) {
    asked = e;
  }
  is(asked, STOP, 'it got past reading the SQL');
});
