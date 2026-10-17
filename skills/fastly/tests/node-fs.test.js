import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// purge --file reads the surrogate keys with Node's fs.promises, which works
// on SLICC 6 and on slicc-jsh (SLICC 7); the SLICC 6 promise dialect fails
// under Node semantics (ai-ecoverse/skills#487). This runs the shipped command
// without --confirm, so nothing is sent.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/fastly.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Cut a top-level function out of the shipped script and run it with `scope`
// supplying every free name (anything not supplied resolves to a global).
function load(source, names, scope) {
  const body = names
    .map((name) => {
      const sig = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(source);
      if (!sig) throw new Error(`not found: ${name}`);
      const end = source.indexOf('\n}\n', sig.index);
      return source.slice(sig.index, end + 2);
    })
    .join('\n');
  const proxy = new Proxy(scope, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return new Function('scope', `with (scope) { ${body}\nreturn { ${names.join(', ')} }; }`)(proxy);
}
void AsyncFunction;

function purge(vfs, flags) {
  const out = [];
  const dies = [];
  const api = load(SOURCE, ['cmdServicePurge'], {
    fs: vfs,
    API: 'https://api.fastly.com',
    str: (v) => (typeof v === 'string' ? v : ''),
    resolveServiceId: async () => 'SVC1',
    c: new Proxy({}, { get: () => (s) => String(s) }),
    console: { log: (...a) => out.push(a.join(' ')) },
    cli: {
      die: (m) => {
        dies.push(m);
        throw Object.assign(new Error(m), { name: 'NodeExitError' });
      },
    },
    api: async () => {
      throw new Error('must not purge without --confirm');
    },
  });
  return api
    .cmdServicePurge(flags)
    .catch((e) => {
      if (e.name !== 'NodeExitError') throw e;
    })
    .then(() => ({ out: out.join('\n'), dies }));
}

test('purge --file reads the keys and previews the purge', async () => {
  const r = await purge(nodeFs({ '/shared/keys.txt': 'k1\nk2\n\n' }), { file: '/shared/keys.txt' });
  is(r.dies, []);
  ok(r.out.includes('2 surrogate key(s) from /shared/keys.txt on service SVC1'), r.out);
});

test('an unreadable --file is reported as such', async () => {
  const r = await purge(nodeFs(), { file: '/shared/missing.txt' });
  is(r.dies, ['Cannot read --file /shared/missing.txt']);
});
