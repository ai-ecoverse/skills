import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// calendar create --from-json reads the events file with Node's fs.promises,
// which works on SLICC 6 and on slicc-jsh (SLICC 7); the SLICC 6 promise
// dialect fails under Node semantics (ai-ecoverse/skills#487). This runs the
// shipped command and its helpers as a dry run (no iCloud tab, no network).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/icloud.jsh'), 'utf8');
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

const HELPERS = [...SOURCE.matchAll(/^(?:async )?function (\w+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'findICloudTab');

test('a dry run reads the --from-json events file', async () => {
  const events = [{ title: 'Standup', start: '2026-10-20T09:00', end: '2026-10-20T09:15' }];
  const vfs = nodeFs({ '/shared/events.json': JSON.stringify(events) });
  const out = [];
  const dies = [];
  const api = load(SOURCE, HELPERS, {
    fs: vfs,
    console: { log: (...a) => out.push(a.join(' ')), error: (...a) => out.push(a.join(' ')) },
    cli: {
      die: (m) => {
        dies.push(m);
        throw Object.assign(new Error(m), { name: 'NodeExitError' });
      },
      out: (v) => out.push(JSON.stringify(v)),
    },
    findICloudTab: async () => null,
  });
  try {
    await api.cmdCalendarCreate({
      calendar: 'Work',
      'dry-run': true,
      'from-json': '/shared/events.json',
      json: true,
    });
  } catch (e) {
    if (e.name !== 'NodeExitError') throw e;
  }
  is(dies, []);
  ok(out.join('\n').includes('Standup'), out.join('\n'));
});
