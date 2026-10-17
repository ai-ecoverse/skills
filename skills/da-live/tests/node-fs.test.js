import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import * as sheetMod from '../sheet.js';
import { nodeFs } from './node-fs.js';

// da-live reads and rewrites a sheet file. Against Node's fs semantics
// (slicc-jsh, SLICC 7) the SLICC 6 promise dialect fails; fs.promises works on
// both (ai-ecoverse/skills#487). This runs the shipped da-live.jsh.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'da-live.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { flags, positional };
}

async function daLive(args, vfs) {
  const out = [];
  const err = [];
  const argv = ['node', 'da-live.jsh', ...args];
  argv.parseFlags = () => parseFlags(args);
  const cli = {
    die: (m) => {
      err.push(String(m));
      throw new NodeExitError(1);
    },
    help: (t) => {
      out.push(t);
      throw new NodeExitError(0);
    },
  };
  const modules = {
    fs: vfs,
    'sliccy:cli': cli,
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    './sheet.js': sheetMod.default || sheetMod,
  };
  let code = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', SOURCE)(
      (id) => {
        if (id in modules) return modules[id];
        throw new Error(`unexpected require(${id})`);
      },
      { argv, env: {} },
      { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) }
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    code = e.code;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const FILE = '/shared/people.json';
const sheet = {
  total: 1,
  limit: 1,
  offset: 0,
  data: [{ name: 'Ada', role: 'dev' }],
  ':type': 'sheet',
};

test('write reads the sheet, validates the rows and writes it back', async () => {
  const vfs = nodeFs({ [FILE]: JSON.stringify(sheet) });
  const rows = JSON.stringify([
    { name: 'Ada', role: 'dev' },
    { name: 'Bob', role: 'ops' },
  ]);
  const r = await daLive(['write', FILE, rows], vfs);
  is(r.code, 0, r.stderr);
  const written = JSON.parse(vfs.text(FILE));
  is(written.data.length, 2);
  is(written.total, 2);
});

test('recalc rewrites total/limit/offset in place', async () => {
  const vfs = nodeFs({ [FILE]: JSON.stringify({ ...sheet, total: 9, limit: 9 }) });
  const r = await daLive(['recalc', FILE], vfs);
  is(r.code, 0, r.stderr);
  const written = JSON.parse(vfs.text(FILE));
  is([written.total, written.limit, written.offset], [1, 1, 0]);
});
