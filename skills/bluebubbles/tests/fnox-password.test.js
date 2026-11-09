import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/bluebubbles.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PLACEHOLDER = 'fnox_proxy_' + 'a'.repeat(24);

function loadHelpers(opts = {}) {
  // jsh strips the `#!/usr/bin/env jsh` line; an AsyncFunction body cannot hold it.
  let source = fs.readFileSync(SCRIPT, 'utf8').replace(/^#![^\n]*/, '');
  source = source.replace(/\nawait main\(\);\s*$/, '\n');
  source += `
return { isFnoxPlaceholder, usablePassword, fnoxReexecArgv, getCfg, FNOX_TRIED };
`;

  const spawns = [];
  const stdout = [];
  const stderr = [];
  const spawnImpl =
    opts.spawn ||
    (async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '/usr/bin/fnox\n', stderr: '' };
      return { exitCode: 0, stdout: 'child-ok\n', stderr: '' };
    });

  const execFn = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  execFn.spawn = async (argv) => {
    spawns.push(argv.slice());
    return spawnImpl(argv);
  };

  const stubs = {
    fs: {
      readFile: async () => null,
      exists: () => false,
      existsSync: () => false,
      promises: {
        readFile: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      },
    },
    os: { homedir: () => '/home/test' },
    path,
    'sliccy:cli': {
      die: (message) => {
        const err = new Error(String(message));
        err.name = 'NodeExitError';
        err.code = 1;
        throw err;
      },
      help: () => {},
      out: () => {},
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': { trunc: (s) => String(s), date: () => '' },
    'sliccy:http': { client: () => ({}) },
    'sliccy:exec': { exec: execFn },
  };
  const requireStub = (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`unexpected require(${id})`);
  };
  const argv = ['node', SCRIPT, ...(opts.argv || ['status'])];
  argv.parseFlags = () => ({
    subcommand: opts.argv?.[0] || 'status',
    positional: opts.argv || ['status'],
    flags: {},
  });
  const env = { ...(opts.env || {}) };
  const proc = {
    argv,
    env,
    exit: (code) => {
      const err = new Error(`exit ${code}`);
      err.name = 'NodeExitError';
      err.code = Number.isInteger(code) ? code : 1;
      throw err;
    },
    cwd: () => '/tmp',
    stdout: { write: (chunk) => stdout.push(String(chunk)) },
    stderr: { write: (chunk) => stderr.push(String(chunk)) },
  };
  const factory = new AsyncFunction('require', 'process', 'console', 'URL', source);
  return factory(requireStub, proc, { log: () => {} }, URL).then((mod) => ({
    ...mod,
    spawns,
    stdout,
    stderr,
    env,
  }));
}

test('a fnox placeholder is not a usable password', async () => {
  const { isFnoxPlaceholder, usablePassword } = await loadHelpers();
  ok(isFnoxPlaceholder(PLACEHOLDER));
  ok(isFnoxPlaceholder('  ' + PLACEHOLDER + '  '));
  is(usablePassword(PLACEHOLDER), null);
  is(usablePassword(''), null);
  is(usablePassword(undefined), null);
  is(usablePassword('real-server-password'), 'real-server-password');
  ok(!isFnoxPlaceholder('fnox_proxy_short'));
  ok(!isFnoxPlaceholder('fnox_proxy_' + 'g'.repeat(24)));
});

test('the fnox retry execs the script itself, so an argv grant on its path matches', async () => {
  const { fnoxReexecArgv } = await loadHelpers();
  const script = '/usr/share/skills/bluebubbles/scripts/bluebubbles.jsh';
  const argv = fnoxReexecArgv(script, ['status', '--json']);
  is(argv, [
    'env', '-u', 'BLUEBUBBLES_PASSWORD', 'BLUEBUBBLES_FNOX_TRIED=1',
    'fnox', 'exec', '--only', 'BLUEBUBBLES_PASSWORD', '--',
    script, 'status', '--json',
  ]);
  ok(!argv.includes('--shell-grants'));
  // nothing may sit between `--` and the script: a jsh or env there breaks the grant
  is(argv[argv.indexOf('--') + 1], script);
  ok(!argv.some((part) => String(part).includes('fnox_proxy_')));
  ok(!argv.some((part) => String(part).includes('password=')));
});

test('getCfg re-execs via fnox when credentials are missing and propagates child output', async () => {
  const childOut = 'server ok\n';
  const childErr = 'fnox: granted\n';
  const h = await loadHelpers({
    env: {},
    spawn: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '/usr/bin/fnox\n', stderr: '' };
      return { exitCode: 42, stdout: childOut, stderr: childErr };
    },
  });
  let caught;
  try {
    await h.getCfg();
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.name === 'NodeExitError');
  is(caught.code, 42);
  is(h.stdout.join(''), childOut);
  is(h.stderr.join(''), childErr);
  const fnox = h.spawns.find((a) => a.includes('fnox') && a.includes('--only'));
  ok(fnox);
  ok(fnox.includes('BLUEBUBBLES_FNOX_TRIED=1'));
  ok(fnox.includes('-u'));
  ok(fnox.includes('BLUEBUBBLES_PASSWORD'));
});

test('getCfg re-execs via fnox when the env password is only a placeholder', async () => {
  const h = await loadHelpers({
    env: { BLUEBUBBLES_PASSWORD: PLACEHOLDER },
    spawn: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '/usr/bin/fnox\n', stderr: '' };
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  let caught;
  try {
    await h.getCfg();
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.name === 'NodeExitError');
  is(caught.code, 0);
  is(h.stdout.join(''), 'ok\n');
  ok(h.spawns.some((a) => a.includes('--only') && a.includes('BLUEBUBBLES_PASSWORD')));
});

test('BLUEBUBBLES_FNOX_TRIED prevents a second fnox dispatch and reaches authDie', async () => {
  const h = await loadHelpers({
    env: { BLUEBUBBLES_FNOX_TRIED: '1' },
  });
  let caught;
  try {
    await h.getCfg();
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.name === 'NodeExitError');
  is(caught.code, 1);
  ok(String(caught.message).includes('argv = [['));
  ok(!String(caught.message).includes('shell = true'));
  is(h.spawns.length, 0);
});

test('a child error on stderr only is shown with its exit code, not replaced by the auth help', async () => {
  const childErr = 'bluebubbles: Could not reach BlueBubbles at http://localhost:1234 (fetch failed).\n';
  const h = await loadHelpers({
    env: {},
    spawn: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '/usr/bin/fnox\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: childErr };
    },
  });
  let caught;
  try {
    await h.getCfg();
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.name === 'NodeExitError');
  is(caught.code, 1);
  is(h.stderr.join(''), childErr);
  ok(!String(caught.message).includes('No BlueBubbles password found'));
});

test('fnox exec failure with no output at all falls through to authDie', async () => {
  const h = await loadHelpers({
    env: {},
    spawn: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '/usr/bin/fnox\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: '' };
    },
  });
  let caught;
  try {
    await h.getCfg();
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.name === 'NodeExitError');
  is(caught.code, 1);
  ok(String(caught.message).includes('No BlueBubbles password found'));
  ok(String(caught.message).includes('argv = [['));
  ok(!String(caught.message).includes('shell = true'));
  ok(h.spawns.some((a) => a.includes('--only') && a.includes('BLUEBUBBLES_PASSWORD')));
});

// The vault's grant names this script, so it must run by its own path.
test('the script starts with a #!/usr/bin/env jsh line', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  is(source.split('\n')[0], '#!/usr/bin/env jsh');
});
