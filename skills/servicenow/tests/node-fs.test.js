import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { nodeFs } from './node-fs.js';

// servicenow keeps its config in a JSON file. Node's fs.promises reads and
// writes it on SLICC 6 and on slicc-jsh (SLICC 7) alike; the SLICC 6 promise
// dialect fails under Node semantics (ai-ecoverse/skills#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/servicenow.jsh'), 'utf8');
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

const CONFIG_FILE = '/shared/servicenow/.config.json';

test('saveConfig writes the config and loadConfig reads it back', async () => {
  const vfs = nodeFs();
  const a = load(SOURCE, ['loadConfig', 'saveConfig'], { fs: vfs, CONFIG_FILE, _config: null });
  await a.saveConfig({ instance: 'acme.service-now.com' });
  is(JSON.parse(vfs.text(CONFIG_FILE)), { instance: 'acme.service-now.com' });
  const b = load(SOURCE, ['loadConfig'], { fs: vfs, CONFIG_FILE, _config: null });
  is(await b.loadConfig(), { instance: 'acme.service-now.com' });
});

test('loadConfig is null when there is no config yet', async () => {
  const a = load(SOURCE, ['loadConfig'], { fs: nodeFs(), CONFIG_FILE, _config: null });
  is(await a.loadConfig(), null);
});
