import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { nodeFs } from './node-fs.js';

// signal keeps watch state in JSON files. Node's fs.promises reads and writes
// them on SLICC 6 and on slicc-jsh (SLICC 7) alike; the SLICC 6 promise
// dialect fails under Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/signal.jsh'), 'utf8');
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

test('a watch state survives a write and a read', async () => {
  const vfs = nodeFs();
  const execs = [];
  const w = load(SOURCE, ['readWatchState', 'writeWatchState'], {
    fs: vfs,
    WATCH_DIR: '/shared/signal',
    watchStatePath: (id) => `/shared/signal/.watch-${id}.json`,
    escapeShellArg: (s) => `'${s}'`,
    exec: async (cmd) => {
      execs.push(cmd);
      return { exitCode: 0, stdout: '' };
    },
  });
  await w.writeWatchState('w1', { id: 'w1', chat: 'Family' });
  is(await w.readWatchState('w1'), { id: 'w1', chat: 'Family' });
  is(await w.readWatchState('missing'), null);
  is(execs, ["mkdir -p '/shared/signal'"]);
});
