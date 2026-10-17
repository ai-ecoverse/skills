import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as argvMod from '../scripts/argv.js';
import * as classifyMod from '../scripts/classify.js';
import * as domainsMod from '../scripts/domains.js';
import * as pipelineMod from '../scripts/pipeline.js';
import * as renderMod from '../scripts/render.js';
import * as sourcesMod from '../scripts/sources.js';
import { nodeFs } from './node-fs.js';

// The whole script on Node's fs semantics (slicc-jsh, SLICC 7; SLICC 6 serves
// the same): the TLD snapshot, `check --from FILE` and `--out FILE` all go
// through fs.promises, and the caches through the same fs. Only Instant
// Domain Search is stubbed (sliccy:http); RDAP, WHOIS, DNS and premium are off.
const ROOT = process.cwd();
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts/domain-hoarding.jsh'), 'utf8');
const SNAPSHOT = fs.readFileSync(path.join(ROOT, 'assets/tlds-porkbun-2026-09-24.txt'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const mod = (m) => m.default || m;
const ASSETS = '/workspace/skills/domain-hoarding/assets';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

async function run(args, vfs) {
  const out = [];
  const err = [];
  const modules = {
    fs: vfs,
    'sliccy:cli': {
      die: (m) => {
        err.push(String(m));
        throw new NodeExitError(1);
      },
      help: (t) => {
        out.push(t);
        throw new NodeExitError(0);
      },
      out: (v) => out.push(typeof v === 'string' ? v : JSON.stringify(v)),
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:http': {
      client: () => ({
        get: async (p, o) => {
          if (p !== '/services/check') throw new Error(`unexpected GET ${p}`);
          return {
            results: String(o.params.names)
              .split(',')
              .map((name) => ({ name, availability: 'inuse', trust: 'high' })),
          };
        },
        post: async (p) => {
          throw new Error(`unexpected POST ${p}`);
        },
      }),
    },
    'sliccy:pool': async (_n, items, fn) => {
      const res = [];
      for (const it of items) res.push(await fn(it));
      return res;
    },
    'sliccy:exec': { exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
    'sliccy:skill': { dir: '/workspace/skills/domain-hoarding/scripts', assets: ASSETS },
    './argv.js': mod(argvMod),
    './domains.js': mod(domainsMod),
    './pipeline.js': mod(pipelineMod),
    './sources.js': mod(sourcesMod),
    './render.js': mod(renderMod),
    './classify.js': mod(classifyMod),
  };
  const proc = {
    argv: ['node', 'domain-hoarding.jsh', ...args],
    env: { TMPDIR: '/tmp', NO_COLOR: '1' },
    exit: (c) => {
      throw new NodeExitError(c);
    },
    stdout: { write: (s) => out.push(String(s)), isTTY: false },
    stderr: { write: (s) => err.push(String(s)), isTTY: false },
  };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', SOURCE)(
      (id) => {
        if (id in modules) return modules[id];
        throw new Error(`unexpected require(${id})`);
      },
      proc,
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) }
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

test('check --from FILE --json --out FILE reads the list and writes the report', async () => {
  const vfs = nodeFs({
    [`${ASSETS}/tlds-porkbun-2026-09-24.txt`]: SNAPSHOT,
    '/shared/names.txt': 'live.com\npage.zip\n',
  });
  const r = await run(
    [
      'check',
      '--from',
      '/shared/names.txt',
      '--json',
      '--out',
      '/shared/report.json',
      '--no-rdap',
      '--no-dns',
      '--no-whois',
      '--no-premium',
      '--no-cache',
      '--quiet',
    ],
    vfs
  );
  is(r.code, 0, r.stderr);
  const doc = JSON.parse(vfs.text('/shared/report.json'));
  is(doc.results.map((x) => x.domain).sort(), ['live.com', 'page.zip']);
  ok(doc.results.every((x) => x.tier === 'taken-reserved-blocked'));
});
