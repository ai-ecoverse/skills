import path from 'node:path';
import test, { is, ok } from 'tst';
import { load } from './extract.js';
import { readScript } from './script.js';

const SOURCE = readScript(path.join(process.cwd(), 'scripts/gmail.jsh'));

function setup({ spawn, flags = {} }) {
  const out = [];
  const err = [];
  const calls = [];
  const exits = [];
  const scope = {
    flags,
    exec: {
      spawn: async (argv) => {
        calls.push(argv);
        return spawn(argv);
      },
    },
    C: { green: (s) => s, gray: (s) => s },
    process: {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      exit: (c) => {
        exits.push(c);
        throw Object.assign(new Error('exit'), { name: 'NodeExitError' });
      },
    },
    importCredentialsFile: async (f) => calls.push(['import', f]),
  };
  const { cmdLogin } = load(SOURCE, ['cmdLogin'], scope);
  return { cmdLogin, out, err, calls, exits };
}

test('login delegates to jerk gmail create', async () => {
  const t = setup({ spawn: async () => ({ exitCode: 0, stdout: 'Signed in\n', stderr: '' }) });
  await t.cmdLogin();
  is(t.calls, [['jerk', 'gmail', 'create']]);
  ok(t.out.join('').includes('Signed in'));
  is(t.exits, []);
});

test('login --force is passed on', async () => {
  const t = setup({ flags: { force: true }, spawn: async () => ({ exitCode: 0 }) });
  await t.cmdLogin();
  is(t.calls, [['jerk', 'gmail', 'create', '--force']]);
});

for (const code of [3, 4, 2]) {
  test(`login exits ${code} when jerk does`, async () => {
    const t = setup({ spawn: async () => ({ exitCode: code, stdout: '', stderr: 'nope\n' }) });
    try {
      await t.cmdLogin();
    } catch {}
    is(t.exits, [code]);
    ok(t.err.join('').includes('nope'));
    ok(!t.out.join('').includes('Signed in to Gmail'));
  });
}

test('login exits 4 and names the install when jerk is missing', async () => {
  const t = setup({
    spawn: async () => {
      throw new Error('spawn jerk ENOENT');
    },
  });
  try {
    await t.cmdLogin();
  } catch {}
  is(t.exits, [4]);
  ok(t.err.join('').includes('slicc-jerk'));
});

test('login --from-file keeps the legacy import and never runs jerk', async () => {
  const t = setup({ flags: { 'from-file': '/tmp/c.json' }, spawn: async () => ({ exitCode: 0 }) });
  await t.cmdLogin();
  is(t.calls, [['import', '/tmp/c.json']]);
});
