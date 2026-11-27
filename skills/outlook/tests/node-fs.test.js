import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';
import { readScript } from './script.js';

// outlook caches its Graph/Outlook bearer token in ~/.local/share/outlook/token with Node's fs
// (fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6
// promise dialect fails under Node semantics (ai-ecoverse/skills#487). Runs
// the shipped token functions with the browser side stubbed.
const SOURCE = readScript(path.join(process.cwd(), 'scripts/outlook.jsh'));
const TOKEN_PATH = '/home/u/.local/share/outlook/token';
const LEGACY_TOKEN_PATH = '/shared/.outlook-token';

function tokens(vfs, { tab = 'T1', cached = null } = {}) {
  const dies = [];
  const api = load(SOURCE, ['cachePath', 'writeCache', 'readCache', 'extractTokenFromBrowser', 'getToken', 'reacquireToken'], {
    fs: vfs,
    path,
    process: { env: { HOME: '/home/u' } },
    LEGACY_TOKEN_PATH,
    findOutlookTab: async () => tab,
    extractTokenFromCache: async () => cached,
    captureTokenFromNetwork: async () => null,
    isFreshBearerCandidate: (t) => t.startsWith('eyJ'),
    _rejectedTokens: new Set(),
    _refreshedToken: null,
    die: (m) => {
      dies.push(m);
      throw Object.assign(new Error(m), { name: 'NodeExitError' });
    },
  });
  return { api, dies };
}

test('a token read from the tab is cached to disk', async () => {
  const vfs = nodeFs();
  const { api } = tokens(vfs, { cached: 'eyJ.tab.token' });
  is(await api.extractTokenFromBrowser(), 'eyJ.tab.token');
  is(vfs.text(TOKEN_PATH), 'eyJ.tab.token');
});

test('without a usable tab the cached token on disk is used', async () => {
  const vfs = nodeFs({ [TOKEN_PATH]: 'eyJ.saved.token\n' });
  const { api } = tokens(vfs, { tab: null });
  is(await api.getToken(), 'eyJ.saved.token');
});

test('a rejected token is wiped from the cache before a fresh one is fetched', async () => {
  const vfs = nodeFs({ [TOKEN_PATH]: 'eyJ.bad.token' });
  const { api } = tokens(vfs, { cached: 'eyJ.fresh.token' });
  await api.reacquireToken('eyJ.bad.token');
  is(vfs.text(TOKEN_PATH), 'eyJ.fresh.token');
});

test('the legacy /shared token is still read when the new cache is empty', async () => {
  const vfs = nodeFs({ [LEGACY_TOKEN_PATH]: 'eyJ.legacy.token' });
  const { api } = tokens(vfs, { tab: null });
  is(await api.getToken(), 'eyJ.legacy.token');
});

test('a failing cache write does not fail a successful extraction', async () => {
  const vfs = nodeFs();
  vfs.promises.writeFile = async (p) => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
  };
  const { api } = tokens(vfs, { cached: 'eyJ.tab.token' });
  is(await api.extractTokenFromBrowser(), 'eyJ.tab.token');
});

test('the cache directory is created before the token is written', async () => {
  const vfs = nodeFs();
  const made = [];
  vfs.promises.mkdir = async (p) => made.push(p);
  const { api } = tokens(vfs, { cached: 'eyJ.tab.token' });
  await api.extractTokenFromBrowser();
  is(made[0], '/home/u/.local/share/outlook');
});

test('the shipped script does not write its cache under /shared', () => {
  is(/writeCache\([^)]*LEGACY/.test(SOURCE), false);
});

test('the token cache is written 0600, in a 0700 directory, through a rename', async () => {
  const vfs = nodeFs();
  const { api } = tokens(vfs, { cached: 'eyJ.tab.token' });
  await api.extractTokenFromBrowser();
  is(vfs.modes[TOKEN_PATH], 0o600, 'file mode');
  is(vfs.ops.find((o) => o[0] === 'mkdir')[2], 0o700, 'directory mode');
  const write = vfs.ops.find((o) => o[0] === 'writeFile');
  const rename = vfs.ops.find((o) => o[0] === 'rename');
  ok(write && write[1] !== TOKEN_PATH, 'written to a temporary file first');
  is(rename && rename[2], TOKEN_PATH, 'then renamed over the cache');
});
