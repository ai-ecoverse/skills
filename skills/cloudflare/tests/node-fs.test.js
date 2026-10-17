import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { exitStub, load } from './extract.js';
import { nodeFs } from './node-fs.js';

// wrangler and wrangler-ext keep caches, scratch files and fixtures with
// Node's fs (fs.promises, including chmod), which slicc-jsh (SLICC 7) and
// SLICC 6 both serve; the SLICC 6 promise dialect, and fs.chmod without a
// callback, fail under Node semantics (#487).
const WRANGLER = fs.readFileSync(path.join(process.cwd(), 'scripts/wrangler.jsh'), 'utf8');
const EXT = fs.readFileSync(path.join(process.cwd(), 'scripts/wrangler-ext.jsh'), 'utf8');

test('the zones cache round-trips (saveZones, loadZones)', async () => {
  const vfs = nodeFs();
  const chmods = [];
  vfs.promises.chmod = async (p, mode) => chmods.push([p, mode]);
  const z = load(WRANGLER, ['ensureDirs', 'loadZones', 'saveZones'], {
    fs: vfs,
    CONFIG_DIR: '/shared/.cf',
    ZONES_FILE: '/shared/.cf/zones.json',
  });
  is(await z.loadZones(), null);
  await z.saveZones([{ id: 'z1', name: 'example.com' }]);
  is(await z.loadZones(), [{ id: 'z1', name: 'example.com' }]);
  is(chmods, [['/shared/.cf/zones.json', 0o600]]);
});

test('wrangler-ext: account cache, scratch PDF and fixtures', async () => {
  const vfs = nodeFs({
    '/shared/.cf/account.json': '{"id":"acc1"}',
    '/shared/fx.json': '{"result":[{"id":"inv1"}]}',
  });
  const exit = exitStub();
  const e = load(EXT, ['loadCachedAccount', 'scratchWrite', 'loadFixture', 'str'], {
    fs: vfs,
    ACCOUNT_FILE: '/shared/.cf/account.json',
    HOME: '/home/t',
    process: { env: { TMPDIR: '/tmp' } },
    cli: { die: exit.die },
  });
  is(await e.loadCachedAccount(), 'acc1');
  const p = await e.scratchWrite(new Uint8Array([37, 80, 68, 70]));
  is(vfs.text(p), '%PDF');
  is(await e.loadFixture('/shared/fx.json'), [{ id: 'inv1' }]);
});
