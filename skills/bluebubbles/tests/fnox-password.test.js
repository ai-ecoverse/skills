import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/bluebubbles.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadHelpers() {
  let source = fs.readFileSync(SCRIPT, 'utf8');
  source = source.replace(/\nawait main\(\);\s*$/, '\n');
  source += `
return { isFnoxPlaceholder, usablePassword, fnoxReexecArgv };
`;

  const stubs = {
    fs: { readFile: async () => null, exists: () => false, existsSync: () => false, promises: { readFile: async () => { throw new Error('ENOENT'); } } },
    os: { homedir: () => '/home/test' },
    path,
    'sliccy:cli': {
      die: (message) => {
        const err = new Error(String(message));
        err.name = 'NodeExitError';
        throw err;
      },
      help: () => {},
      out: () => {},
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': { trunc: (s) => String(s), date: () => '' },
    'sliccy:http': { client: () => ({}) },
    'sliccy:exec': { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  };
  const requireStub = (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`unexpected require(${id})`);
  };
  const argv = ['node', SCRIPT, 'status'];
  argv.parseFlags = () => ({ subcommand: 'status', positional: ['status'], flags: {} });
  const factory = new AsyncFunction('require', 'process', 'console', 'URL', source);
  return factory(requireStub, { argv, env: {}, exit: () => {}, cwd: () => '/tmp' }, { log: () => {} }, URL);
}

test('a fnox placeholder is not a usable password', async () => {
  const { isFnoxPlaceholder, usablePassword } = await loadHelpers();
  const placeholder = 'fnox_proxy_' + 'a'.repeat(24);
  ok(isFnoxPlaceholder(placeholder));
  ok(isFnoxPlaceholder('  ' + placeholder + '  '));
  is(usablePassword(placeholder), null);
  is(usablePassword(''), null);
  is(usablePassword(undefined), null);
  is(usablePassword('real-server-password'), 'real-server-password');
  ok(!isFnoxPlaceholder('fnox_proxy_short'));
  ok(!isFnoxPlaceholder('fnox_proxy_' + 'g'.repeat(24)));
});

test('the fnox retry asks the vault for the shell grant and does not pass the password', async () => {
  const { fnoxReexecArgv } = await loadHelpers();
  const argv = fnoxReexecArgv('/skills/bluebubbles/scripts/bluebubbles.jsh', ['status', '--json']);
  is(argv[0], 'env');
  is(argv[1], '-u');
  is(argv[2], 'BLUEBUBBLES_PASSWORD');
  ok(argv.includes('--shell-grants'));
  ok(argv.includes('BLUEBUBBLES_FNOX_TRIED=1'));
  ok(argv.includes('jsh'));
  ok(argv.includes('status'));
  ok(!argv.some((part) => String(part).includes('fnox_proxy_')));
  ok(!argv.some((part) => String(part).includes('password=')));
});
