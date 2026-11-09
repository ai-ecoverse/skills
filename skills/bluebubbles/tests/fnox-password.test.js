import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/bluebubbles');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const PLACEHOLDER = 'fnox_proxy_' + 'a'.repeat(24);

function loadHelpers(opts = {}) {
  // jsh strips the `#!/usr/bin/env jsh` line; an AsyncFunction body cannot hold it.
  let source = fs.readFileSync(SCRIPT, 'utf8').replace(/^#![^\n]*/, '');
  source = source.replace(/\nawait main\(\);\s*$/, '\n');
  source += `
return {
  isFnoxPlaceholder, usablePassword, fnoxReexecArgv, getCfg, FNOX_TRIED,
  resolveConfig, normalizeServerUrl, rootOnly, setExecGrant, setFnoxSecret,
  sealedProviderName, cmdLogin,
};
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

  // opts.files: path -> text; opts.stats: path -> { uid, mode }. A pinned
  // server (opts.pinned: url) adds a root-owned /etc/bluebubbles/config.json.
  const files = { ...(opts.files || {}) };
  const stats = { ...(opts.stats || {}) };
  if (opts.pinned) {
    files['/etc/bluebubbles/config.json'] = JSON.stringify({ url: opts.pinned });
    stats['/etc/bluebubbles/config.json'] ??= { uid: 0, mode: 0o100644 };
    stats['/etc/bluebubbles'] ??= { uid: 0, mode: 0o40755 };
  }
  const written = [];
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const stubs = {
    fs: {
      readFile: async () => null,
      exists: () => false,
      existsSync: (p) => p in files,
      statSync: (p) => {
        if (p in stats) return stats[p];
        throw enoent();
      },
      promises: {
        readFile: async (p) => {
          if (p in files) return files[p];
          throw enoent();
        },
        writeFile: async (p, data) => {
          written.push([p, String(data)]);
          files[p] = String(data);
        },
        unlink: async () => {},
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
  const argv = ['node', opts.script || SCRIPT, ...(opts.argv || ['status'])];
  argv.parseFlags = () => ({
    subcommand: opts.argv?.[0] || 'status',
    positional: opts.argv || ['status'],
    flags: { ...(opts.flags || {}) },
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
    files,
    written,
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
  const script = '/usr/share/skills/bluebubbles/scripts/bluebubbles';
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
    pinned: 'https://bb.example.com',
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
    pinned: 'https://bb.example.com',
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
    pinned: 'https://bb.example.com',
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
  ok(String(caught.message).includes('bluebubbles login'));
  ok(!String(caught.message).includes('shell = true'));
  is(h.spawns.length, 0);
});

test('a child error on stderr only is shown with its exit code, not replaced by the auth help', async () => {
  const childErr = 'bluebubbles: Could not reach BlueBubbles at http://localhost:1234 (fetch failed).\n';
  const h = await loadHelpers({
    pinned: 'https://bb.example.com',
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
    pinned: 'https://bb.example.com',
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
  ok(String(caught.message).includes('bluebubbles login'));
  ok(!String(caught.message).includes('shell = true'));
  ok(h.spawns.some((a) => a.includes('--only') && a.includes('BLUEBUBBLES_PASSWORD')));
});

// The vault's grant names this script, so it must run by its own path.
test('the script starts with a #!/usr/bin/env jsh line', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  is(source.split('\n')[0], '#!/usr/bin/env jsh');
});

// ── the pinned server: the vault password goes to one host only ───────────

async function exitOf(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return null;
}

test('with a pin, the URL comes from it, not BLUEBUBBLES_URL or a user config', async () => {
  const h = await loadHelpers({
    pinned: 'https://bb.example.com/',
    env: {
      BLUEBUBBLES_PASSWORD: 'vault-value-123',
      BLUEBUBBLES_URL: 'https://attacker.invalid',
      BLUEBUBBLES_CONFIG: '/tmp/evil.json',
    },
    files: { '/tmp/evil.json': JSON.stringify({ url: 'https://attacker2.invalid' }) },
  });
  const cfg = await h.resolveConfig();
  is(cfg.url, 'https://bb.example.com');
  is(cfg.password, 'vault-value-123');
  is(cfg.pinned, true);
});

test('without a pin, a password in the environment is not used and fnox is not asked', async () => {
  const h = await loadHelpers({
    env: { BLUEBUBBLES_PASSWORD: 'vault-value-123', BLUEBUBBLES_URL: 'https://attacker.invalid' },
  });
  const err = await exitOf(() => h.getCfg());
  ok(err && err.name === 'NodeExitError');
  is(err.code, 1);
  ok(String(err.message).includes('is set, but there is no /etc/bluebubbles/config.json'));
  is(h.spawns.length, 0);
});

test('without a pin, a password file and BLUEBUBBLES_URL still work', async () => {
  const h = await loadHelpers({
    env: { BLUEBUBBLES_PASSWORD_FILE: '/home/test/pw', BLUEBUBBLES_URL: 'https://mine.example.com/' },
    files: { '/home/test/pw': 'file-password-1\n' },
  });
  const cfg = await h.resolveConfig();
  is(cfg.url, 'https://mine.example.com');
  is(cfg.password, 'file-password-1');
  is(cfg.pinned, false);
});

test('a pin that is not root-only is refused, not skipped', async () => {
  for (const st of [{ uid: 1034, mode: 0o100644 }, { uid: 0, mode: 0o100666 }]) {
    const h = await loadHelpers({
      pinned: 'https://bb.example.com',
      stats: { '/etc/bluebubbles/config.json': st },
      env: { BLUEBUBBLES_PASSWORD: 'vault-value-123' },
    });
    const err = await exitOf(() => h.resolveConfig());
    ok(err && err.name === 'NodeExitError', `refused for ${JSON.stringify(st)}`);
    ok(String(err.message).includes('must be owned by root'));
  }
});

test('--url is gone', async () => {
  const h = await loadHelpers({ pinned: 'https://bb.example.com', flags: { url: 'https://attacker.invalid' } });
  const err = await exitOf(() => h.resolveConfig());
  ok(err && err.name === 'NodeExitError');
  ok(String(err.message).includes('--url was removed'));
});

test('normalizeServerUrl accepts plain http(s) only', async () => {
  const { normalizeServerUrl } = await loadHelpers();
  is(normalizeServerUrl('https://bb.example.com/'), 'https://bb.example.com');
  is(normalizeServerUrl(' http://10.0.0.2:1234 '), 'http://10.0.0.2:1234');
  is(normalizeServerUrl('https://bb.example.com/base/'), 'https://bb.example.com/base');
  is(normalizeServerUrl('https://u:p@bb.example.com'), null);
  is(normalizeServerUrl('https://bb.example.com/?password=x'), null);
  is(normalizeServerUrl('file:///etc/passwd'), null);
  is(normalizeServerUrl('not a url'), null);
});

// ── login's file edits ─────────────────────────────────────────────────────

test('setExecGrant replaces a shell grant, keeps other lines and sections', async () => {
  const { setExecGrant } = await loadHelpers();
  const S = '/usr/share/skills/bluebubbles/scripts/bluebubbles';
  is(
    setExecGrant('[exec]\nBLUEBUBBLES_PASSWORD = { shell = true }\nNPM_TOKEN = true\n\n[limits]\nshell_per_day = 5\n', 'BLUEBUBBLES_PASSWORD', S),
    `[exec]\nBLUEBUBBLES_PASSWORD = { argv = [["${S}"]] }\nNPM_TOKEN = true\n\n[limits]\nshell_per_day = 5\n`,
  );
  is(setExecGrant('', 'BLUEBUBBLES_PASSWORD', S), `[exec]\nBLUEBUBBLES_PASSWORD = { argv = [["${S}"]] }\n`);
  is(
    setExecGrant('[exec]\nNPM_TOKEN = true\n', 'BLUEBUBBLES_PASSWORD', S),
    `[exec]\nBLUEBUBBLES_PASSWORD = { argv = [["${S}"]] }\nNPM_TOKEN = true\n`,
  );
  // the same key in another section is not the grant
  is(
    setExecGrant('[exits]\nBLUEBUBBLES_PASSWORD = ["page"]\n', 'BLUEBUBBLES_PASSWORD', S),
    `[exits]\nBLUEBUBBLES_PASSWORD = ["page"]\n\n[exec]\nBLUEBUBBLES_PASSWORD = { argv = [["${S}"]] }\n`,
  );
});

test('setFnoxSecret sets the placeholder and adds the entry under the sealed provider', async () => {
  const { setFnoxSecret } = await loadHelpers();
  const base = 'default_provider = "vault"\n\n[providers.vault]\ntype = "sealed"\n';
  is(
    setFnoxSecret(base, 'BLUEBUBBLES_PASSWORD', PLACEHOLDER),
    `${base}\n[secrets.BLUEBUBBLES_PASSWORD]\nprovider = "vault"\nvalue = "${PLACEHOLDER}"\n`,
  );
  const old = `[secrets.BLUEBUBBLES_PASSWORD]\nprovider = "seven"\nvalue = "fnox_proxy_${'b'.repeat(24)}"\n\n[secrets.OTHER]\nvalue = "x"\n`;
  is(
    setFnoxSecret(old, 'BLUEBUBBLES_PASSWORD', PLACEHOLDER),
    `[secrets.BLUEBUBBLES_PASSWORD]\nprovider = "seven"\nvalue = "${PLACEHOLDER}"\n\n[secrets.OTHER]\nvalue = "x"\n`,
  );
  const same = `[secrets.BLUEBUBBLES_PASSWORD]\nprovider = "seven"\nvalue = "${PLACEHOLDER}"\n`;
  is(setFnoxSecret(same, 'BLUEBUBBLES_PASSWORD', PLACEHOLDER), same);
});

test('login seals the password, writes the three root files with sudo install, then checks status', async () => {
  const SCRIPT_PATH = '/usr/share/skills/bluebubbles/scripts/bluebubbles';
  const h = await loadHelpers({
    script: SCRIPT_PATH,
    argv: ['login', 'https://bb.example.com/'],
    files: {
      '/etc/fnox/config.toml': 'default_provider = "seven"\n\n[providers.seven]\ntype = "sealed"\n',
      '/etc/slicc/secrets-policy.toml': '[exec]\nBLUEBUBBLES_PASSWORD = { shell = true }\n',
    },
    stats: {
      [SCRIPT_PATH]: { uid: 0, mode: 0o100755 },
      '/usr/share/skills/bluebubbles/scripts': { uid: 0, mode: 0o40755 },
    },
    spawn: async (argv) => {
      if (argv[0] === 'sealed' && argv[1] === 'placeholder') return { exitCode: 1, stdout: '', stderr: 'no record' };
      if (argv[0] === 'sealed' && argv[1] === 'ask') return { exitCode: 0, stdout: `${PLACEHOLDER}\n`, stderr: '' };
      if (argv[0] === 'sudo') return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: 'status ok\n', stderr: '' };
    },
  });
  const err = await exitOf(() => h.cmdLogin(['https://bb.example.com/'], {}));
  ok(err && err.name === 'NodeExitError');
  is(err.code, 0);
  const asks = h.spawns.filter((a) => a[0] === 'sealed' && a[1] === 'ask');
  is(asks.length, 1);
  ok(!asks[0].includes('--replace'));
  const installs = h.spawns.filter((a) => a[0] === 'sudo');
  is(installs.map((a) => a.slice(0, 9)), Array(3).fill(['sudo', 'install', '-D', '-o', 'root', '-g', 'root', '-m', '644']));
  ok(installs.every((a) => a[9].startsWith('/tmp/bluebubbles-login-') && a.length === 11));
  is(installs.map((a) => a[10]), ['/etc/bluebubbles/config.json', '/etc/fnox/config.toml', '/etc/slicc/secrets-policy.toml']);
  // what each sudo install copied, by destination
  const tmpData = Object.fromEntries(h.written);
  const content = Object.fromEntries(installs.map((a) => [a[10], tmpData[a[9]]]));
  is(JSON.parse(content['/etc/bluebubbles/config.json']), { url: 'https://bb.example.com' });
  ok(content['/etc/fnox/config.toml'].includes(`[secrets.BLUEBUBBLES_PASSWORD]\nprovider = "seven"\nvalue = "${PLACEHOLDER}"`));
  is(content['/etc/slicc/secrets-policy.toml'], `[exec]\nBLUEBUBBLES_PASSWORD = { argv = [["${SCRIPT_PATH}"]] }\n`);
  ok(!h.written.some(([, d]) => d.includes('shell = true')));
  is(h.spawns[h.spawns.length - 1], [SCRIPT_PATH, 'status']);
});

test('login refuses a script the vault grant could not match', async () => {
  const h = await loadHelpers({
    script: '/usr/share/skills/bluebubbles/scripts/bluebubbles',
    stats: {
      '/usr/share/skills/bluebubbles/scripts/bluebubbles': { uid: 1034, mode: 0o100755 },
      '/usr/share/skills/bluebubbles/scripts': { uid: 0, mode: 0o40755 },
    },
  });
  const err = await exitOf(() => h.cmdLogin(['https://bb.example.com'], {}));
  ok(err && err.name === 'NodeExitError');
  ok(String(err.message).includes('must be owned by root'));
  ok(!h.spawns.some((a) => a[0] === 'sudo' || a[0] === 'sealed'));
});
