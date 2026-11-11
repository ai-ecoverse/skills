import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { setExecGrant } from '../assets/cf-slicc/exec-grant.mjs';

const ASSETS = path.join(process.cwd(), 'assets/cf-slicc');
const GRANT = '{ argv = [["/usr/bin/node", "/usr/local/lib/cf-slicc/bin/cf"]] }';
const KEY = 'CLOUDFLARE_API_TOKEN';

test('exec grant: added as a new [exec] table to an empty policy', () => {
  is(setExecGrant('', KEY, GRANT), `[exec]\n${KEY} = ${GRANT}\n`);
});

test('exec grant: a broader existing grant is replaced, other keys and tables kept', () => {
  const before = `[exec]\nNPM_TOKEN = true\n${KEY} = { shell = true }\n\n[exits]\n${KEY} = ["page"]\n`;
  is(
    setExecGrant(before, KEY, GRANT),
    `[exec]\nNPM_TOKEN = true\n${KEY} = ${GRANT}\n\n[exits]\n${KEY} = ["page"]\n`
  );
});

test('exec grant: a key in another table does not count as the grant', () => {
  const before = `[exits]\n${KEY} = ["page"]\n\n[exec]\nNPM_TOKEN = true\n`;
  is(
    setExecGrant(before, KEY, GRANT),
    `[exits]\n${KEY} = ["page"]\n\n[exec]\nNPM_TOKEN = true\n${KEY} = ${GRANT}\n`
  );
});

test('exec grant: a multi-line value is refused, not half-replaced', () => {
  let err = null;
  try {
    setExecGrant(`[exec]\n${KEY} = { argv = [\n  ["/bin/x"]\n] }\n`, KEY, GRANT);
  } catch (e) {
    err = e;
  }
  ok(err && /several lines/.test(err.message));
});

function sandbox({
  create = '{"value":"cf-token-value-123456"}',
  fnoxFails = false,
  denyCat = false,
  policy = '',
} = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.HOME || '/tmp', '.seal-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  stub('sudo', `${denyCat ? '[ "$1" = cat ] && exit 1\n' : ''}exec "$@"`);
  stub('sealed', `echo "${KEY}\tfnox_proxy_x\tactive"`);
  stub(
    'fnox',
    `cat > "${dir}/fnox-stdin"; echo "$@" > "${dir}/fnox-args"; ${fnoxFails ? 'exit 1' : 'exit 0'}`
  );
  fs.writeFileSync(path.join(dir, 'create.json'), create);
  stub(
    'cf-stub',
    [
      `case "$1 $2 $3 $4" in`,
      `  "auth whoami  ") echo '{"accounts":[{"id":"a1","name":"Acct"}]}' ;;`,
      `  "user get  ") echo '{"id":"u1"}' ;;`,
      `  "user tokens permission-groups list") echo '[{"id":"g1","name":"Zone Read","scopes":["com.cloudflare.api.account.zone"]}]' ;;`,
      `  "user tokens create --body"*) cat "${dir}/create.json" ;;`,
      `  "auth logout  ") touch "${dir}/logged-out" ;;`,
      `esac`,
    ].join('\n')
  );
  const policyFile = path.join(dir, 'secrets-policy.toml');
  fs.writeFileSync(policyFile, policy);
  const run = (...args) =>
    spawnSync('sh', [path.join(ASSETS, 'seal-token.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: dir,
        PATH: `${bin}:${process.env.PATH}`,
        CF: `${bin}/cf-stub`,
        SECRETS_POLICY: policyFile,
      },
    });
  const read = (f) =>
    fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null;
  return { dir, run, read, policyFile };
}

test('seal-token: seals the minted value, sets the exact grant, logs cf out', () => {
  const s = sandbox({ policy: `[exec]\n${KEY} = { shell = true }\n` });
  const r = s.run();
  is(r.status, 0, r.stderr);
  is(s.read('fnox-stdin'), 'cf-token-value-123456');
  ok(/^set CLOUDFLARE_API_TOKEN --global/.test(s.read('fnox-args')));
  is(s.read('secrets-policy.toml'), `[exec]\n${KEY} = ${GRANT}\n`);
  ok(s.read('logged-out') !== null);
  ok(!r.stdout.includes('cf-token-value-123456') && !r.stderr.includes('cf-token-value-123456'));
});

test('seal-token: no token from cf means no seal, no policy change, no logout', () => {
  const s = sandbox({ create: '{"success":false}', policy: '[exec]\n' });
  const r = s.run();
  ok(r.status !== 0);
  is(s.read('fnox-stdin'), null);
  is(s.read('secrets-policy.toml'), '[exec]\n');
  is(s.read('logged-out'), null);
});

test('seal-token: a failed fnox set leaves the policy and the login alone', () => {
  const s = sandbox({ fnoxFails: true, policy: '' });
  const r = s.run();
  ok(r.status !== 0);
  ok(/fnox set failed/.test(r.stderr));
  is(s.read('secrets-policy.toml'), '');
  is(s.read('logged-out'), null);
});

test('seal-token: an unreadable policy stops it before anything is minted or written', () => {
  const before = `[exec]\nNPM_TOKEN = true\n\n[limits]\nmaterialize_per_minute = 10\n`;
  const s = sandbox({ denyCat: true, policy: before });
  const r = s.run();
  ok(r.status !== 0);
  ok(/could not read/.test(r.stderr));
  is(s.read('secrets-policy.toml'), before);
  is(s.read('fnox-stdin'), null);
  is(s.read('logged-out'), null);
});

test('seal-token --dry-run creates and changes nothing', () => {
  const s = sandbox({ policy: '' });
  const r = s.run('--dry-run');
  is(r.status, 0, r.stderr);
  is(s.read('fnox-stdin'), null);
  is(s.read('secrets-policy.toml'), '');
  is(s.read('logged-out'), null);
});

function wrapper(sealedOk) {
  const dir = fs.mkdtempSync(path.join(process.env.HOME || '/tmp', '.wrap-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'lib/bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'lib/bin/cf'),
    'console.log("direct " + process.argv.slice(2).join(" "));\n'
  );
  for (const [name, body] of [
    ['sealed', sealedOk ? 'exit 0' : 'exit 1'],
    ['fnox', 'echo "fnox $*"'],
  ]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  const r = spawnSync('sh', [path.join(ASSETS, 'cf-wrapper.sh'), 'zones', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CF_LIB: path.join(dir, 'lib') },
  });
  return { ...r, lib: path.join(dir, 'lib') };
}

test('cf wrapper: a sealed token runs cf through fnox exec with the granted argv', () => {
  const r = wrapper(true);
  is(r.stdout.trim(), `fnox exec -- /usr/bin/node ${r.lib}/bin/cf zones list`);
});

test('cf wrapper: without a sealed token cf runs directly on its own login', () => {
  const r = wrapper(false);
  is(r.stdout.trim(), 'direct zones list');
});
