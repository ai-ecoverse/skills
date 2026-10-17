import fs from 'node:fs';
import path from 'node:path';
import test, { is } from 'tst';

// stdin under Node semantics (slicc-jsh, SLICC 7): process.stdin is a stream
// whose read() has nothing yet, so the script must take all of stdin from
// fs.readFileSync(0), which SLICC 6 serves as well (ai-ecoverse/skills#488).
// The functions run are the shipped ones, cut out of the .jsh.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/wrangler.jsh'), 'utf8');

function extract(signature) {
  const start = SOURCE.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 2);
}

function load({ stdin = '', isTTY = false } = {}) {
  const reads = [];
  const scope = {
    process: { stdin: { isTTY, read: () => null, on: () => {} } },
    require: (id) => {
      if (id !== 'fs') throw new Error(`unexpected require(${id})`);
      return {
        readFileSync: (fd, enc) => {
          reads.push([fd, enc]);
          return stdin;
        },
      };
    },
  };
  const proxy = new Proxy(scope, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
  });
  const src = ['async function readStdin()'].map(extract).join('\n');
  return {
    reads,
    run: new Function('scope', `with (scope) { ${src}\nreturn async () => readStdin(); }`)(proxy),
  };
}

test('piped stdin is read whole, through readFileSync(0)', async () => {
  const { reads, run } = load({ stdin: '{ viewer { zones { zoneTag } } }' });
  is(await run(), '{ viewer { zones { zoneTag } } }');
  is(reads, [[0, 'utf8']]);
});

test('a terminal is not waited on: it reads as empty', async () => {
  const { reads, run } = load({ isTTY: true });
  is(await run(), '');
  is(reads, []);
});
