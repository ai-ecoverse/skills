import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { load } from './extract.js';
import { nodeFs } from './node-fs.js';

// sharepoint caches its Graph/Outlook bearer token in /shared/.sharepoint-token with Node's fs
// (fs.promises), which slicc-jsh (SLICC 7) and SLICC 6 both serve; the SLICC 6
// promise dialect fails under Node semantics (ai-ecoverse/skills#487). Runs
// the shipped token functions with the browser side stubbed.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/sharepoint.jsh'), 'utf8');
const TOKEN_PATH = '/shared/.sharepoint-token';

function tokens(vfs, { tab = 'T1', cached = null } = {}) {
  const dies = [];
  const api = load(SOURCE, ['extractTokenFromBrowser', 'getToken', 'reacquireToken'], {
    fs: vfs,
    TOKEN_PATH,
    findM365Tab: async () => tab,
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
