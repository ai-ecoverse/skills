import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// cmdFilmstrip, cut out of the shipped tiktok.jsh. `info` runs it as one part
// of a bundle and records a failure instead of stopping; under Node exit
// semantics (slicc-jsh, SLICC 7) a process.exit inside it would end `info` too.
// So with the soft flag it must throw, and on its own it must still exit 1.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/tiktok.jsh'), 'utf8');

function load() {
  const start = SOURCE.indexOf('const FILMSTRIP_SOFT = ');
  ok(start >= 0, 'FILMSTRIP_SOFT is defined next to cmdFilmstrip');
  const fn = SOURCE.indexOf('async function cmdFilmstrip(', start);
  const end = SOURCE.indexOf('\n}\n', fn);
  const exits = [];
  const errors = [];
  const scope = {
    parseVideoRef: () => null,
    process: {
      exit: (code) => {
        exits.push(code);
        throw Object.assign(new Error(`exit ${code}`), { name: 'NodeExitError' });
      },
    },
    console: { error: (m) => errors.push(String(m)), log: () => {} },
  };
  const proxy = new Proxy(scope, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
  });
  const api = new Function(
    'scope',
    `with (scope) { ${SOURCE.slice(start, end + 2)}\nreturn { cmdFilmstrip, FILMSTRIP_SOFT }; }`
  )(proxy);
  return { ...api, exits, errors };
}

test('inside `info` (soft) a filmstrip failure throws and never exits', async () => {
  const t = load();
  let err = null;
  try {
    await t.cmdFilmstrip(['not-a-video'], { [t.FILMSTRIP_SOFT]: true });
  } catch (e) {
    err = e;
  }
  is(t.exits, []);
  ok(err && err.name !== 'NodeExitError');
  ok(err.message.startsWith('Usage: tiktok filmstrip'), err.message);
});

test('on its own `filmstrip` still prints the problem and exits 1', async () => {
  const t = load();
  try {
    await t.cmdFilmstrip(['not-a-video'], {});
  } catch {}
  is(t.exits, [1]);
  ok(t.errors[0].startsWith('Usage: tiktok filmstrip'));
});
