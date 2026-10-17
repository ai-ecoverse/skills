import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';

// aem and aem-ext save and upload files through Node's fs (fs.promises), which
// works on SLICC 6 and on slicc-jsh (SLICC 7); the SLICC 6 promise dialect
// fails under Node semantics (ai-ecoverse/skills#487). The commands run are the
// shipped ones, cut out of the scripts, with their network calls stubbed.
const AEM = fs.readFileSync(path.join(process.cwd(), 'scripts/aem.jsh'), 'utf8');
const AEM_EXT = fs.readFileSync(path.join(process.cwd(), 'scripts/aem-ext.jsh'), 'utf8');
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

const target = { org: 'acme', repo: 'site', path: '/index' };
function aemScope(vfs, extra = {}) {
  const out = [];
  return {
    out,
    scope: {
      fs: vfs,
      process: {
        cwd: () => '/shared',
        stdout: { write: (s) => out.push(s) },
        stderr: { write: () => {} },
        exit: () => {},
      },
      resolveTarget: () => target,
      getToken: async () => 'tok',
      normalizeAemPath: (p) => p.replace(/^\//, '') + '.html',
      resolveBackend: async () => ({ version: 5 }),
      DA_ADMIN_BASE: 'https://admin.da.live',
      ...extra,
    },
  };
}

test('aem get --output writes the document through fs.promises', async () => {
  const vfs = nodeFs();
  const { scope, out } = aemScope(vfs, {
    aemRequest: async () => '<main>Hallo — Welt</main>',
    getFlag: (args, name) => (name === '--output' ? '/shared/index.html' : null),
  });
  await load(AEM, ['cmdGet'], scope).cmdGet([]);
  is(vfs.text('/shared/index.html'), '<main>Hallo — Welt</main>');
  ok(out.join('').startsWith('Saved to /shared/index.html'));
});

test('aem put (DA) uploads through a temp copy that it removes again', async () => {
  const vfs = nodeFs({ '/shared/page.html': '<main>neu</main>' });
  const uploads = [];
  const { scope } = aemScope(vfs, {
    positionals: () => ['/index', 'page.html'],
    aemFetchMultipart: async (method, url, tok, args) => {
      const tmp = args[1].match(/data=@([^;]+)/)[1];
      uploads.push({ method, url, body: vfs.text(tmp) });
    },
  });
  await load(AEM, ['cmdPut'], scope).cmdPut([]);
  is(uploads, [
    {
      method: 'PUT',
      url: 'https://admin.da.live/source/acme/site/index.html',
      body: '<main>neu</main>',
    },
  ]);
  is(Object.keys(vfs.files), ['/shared/page.html'], 'the temp copy is gone');
});

test('aem-ext put counts the file bytes with fs.promises.readFile', async () => {
  const vfs = nodeFs({ '/shared/page.html': '<p>— ü</p>' });
  const outs = [];
  const scope = {
    fs: vfs,
    words: ['put', '/index', '/shared/page.html'],
    flags: { json: true },
    PREFIX: 'aem-ext',
    resolveTarget: () => ({ org: 'acme', site: 'site', path: '/index' }),
    documentPath: () => 'index.html',
    credential: async () => ({}),
    sourceUrl: () => 'https://admin.hlx.page/source/acme/site/index.html',
    authCurlArgs: () => [],
    isHelix5: () => false,
    shellQuote: (s) => s,
    exec: async () => ({ exitCode: 0, stdout: '{}\n200' }),
    cli: {
      out: (v) => outs.push(v),
      die: (m) => {
        throw new Error(m);
      },
    },
  };
  await load(AEM_EXT, ['cmdPut'], scope).cmdPut();
  is(outs, [{ path: 'index.html', status: 200, bytes: 13 }]);
});
