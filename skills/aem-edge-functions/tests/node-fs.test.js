import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';
import { nodeFs } from './node-fs.js';

// The adc-config credential file is read with Node's fs (existsSync +
// fs.promises.readFile), which works on SLICC 6 and slicc-jsh (SLICC 7);
// the SLICC 6 promise dialect fails under Node semantics (#487).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/aem-edge-functions.jsh'), 'utf8');
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

class NodeExitError extends Error {}
const cli = {
  die: (m) => {
    throw Object.assign(new NodeExitError(m), { name: 'NodeExitError' });
  },
};

test('readCredentialFromFile reads a Developer Console project file', async () => {
  const config = {
    project: {
      workspace: {
        details: {
          credentials: [
            {
              integration_type: 'oauth_server_to_server',
              oauth_server_to_server: {
                client_id: 'cid',
                client_secrets: ['sec'],
                scopes: ['s1', 's2'],
              },
            },
          ],
        },
      },
    },
  };
  const vfs = nodeFs({ '/shared/adc.json': JSON.stringify(config) });
  const { readCredentialFromFile } = load(SOURCE, ['readCredentialFromFile'], { fs: vfs, cli });
  is(await readCredentialFromFile('/shared/adc.json'), {
    clientId: 'cid',
    clientSecret: 'sec',
    scopes: 's1,s2',
  });
});

test('a missing adc-config dies with its path', async () => {
  const { readCredentialFromFile } = load(SOURCE, ['readCredentialFromFile'], {
    fs: nodeFs(),
    cli,
  });
  let err = null;
  try {
    await readCredentialFromFile('/shared/nope.json');
  } catch (e) {
    err = e;
  }
  is(err?.message, 'adc-config not found: /shared/nope.json');
});
