import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { setExecGrant } from '../assets/gcloud-slicc/exec-grant.mjs';

const ASSETS = path.join(process.cwd(), 'assets/gcloud-slicc');
const RUNNER = ['/usr/bin/python3', '/usr/local/lib/gcloud-sealed/run.py'];
const GRANT = `{ argv = [${JSON.stringify(RUNNER).replace(/,/g, ', ')}] }`;
const KEY = 'GCLOUD_CREDENTIALS';
const PRIVATE = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n';
const SA_JSON = `{"type":"service_account","project_id":"p","private_key_id":"abcdef0123456789","private_key":"${PRIVATE}","client_email":"probe@p.iam.gserviceaccount.com","token_uri":"https://oauth2.googleapis.com/token"}`;

test('exec grant: added to an empty policy, and a broader grant is replaced', () => {
  is(setExecGrant('', KEY, GRANT), `[exec]\n${KEY} = ${GRANT}\n`);
  is(
    setExecGrant(`[exec]\nNPM_TOKEN = true\n${KEY} = { shell = true }\n`, KEY, GRANT),
    `[exec]\nNPM_TOKEN = true\n${KEY} = ${GRANT}\n`
  );
});

function sandbox({ key = SA_JSON, policy = '', fnoxFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.HOME || '/tmp', '.seal-key-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(bin, name), 0o755);
  };
  stub('sudo', 'exec "$@"');
  stub('fnox', `cat > "${dir}/fnox-stdin"; echo "$@" > "${dir}/fnox-args"; ${fnoxFails ? 'exit 1' : 'exit 0'}`);
  const keyFile = path.join(dir, 'key.json');
  fs.writeFileSync(keyFile, key);
  const policyFile = path.join(dir, 'secrets-policy.toml');
  fs.writeFileSync(policyFile, policy);
  const run = (...args) =>
    spawnSync('sh', [path.join(ASSETS, 'seal-key.sh'), ...args, keyFile], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, SECRETS_POLICY: policyFile },
    });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
  return { run, read, keyFile, policyFile };
}

test('seal-key: seals the key base64-encoded, sets the exact grant, shreds the file', () => {
  const s = sandbox({ policy: `[exec]\n${KEY} = { shell = true }\n` });
  const r = s.run();
  is(r.status, 0, r.stderr);
  const sealed = s.read('fnox-stdin');
  is(sealed, Buffer.from(SA_JSON).toString('base64'));
  ok(!sealed.includes('{') && !sealed.includes('PRIVATE KEY'));
  ok(/^set GCLOUD_CREDENTIALS --global -d gcloud key for probe@p\.iam\.gserviceaccount\.com/.test(s.read('fnox-args')));
  is(s.read('secrets-policy.toml'), `[exec]\n${KEY} = ${GRANT}\n`);
  ok(!fs.existsSync(s.keyFile));
  ok(!(r.stdout + r.stderr).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'));
});

test('seal-key: a file that is not credential JSON is refused before anything is sealed', () => {
  for (const key of ['not json', '{"type":"external_account"}']) {
    const s = sandbox({ key, policy: '[exec]\n' });
    const r = s.run();
    ok(r.status !== 0);
    is(s.read('fnox-stdin'), null);
    is(s.read('secrets-policy.toml'), '[exec]\n');
    ok(fs.existsSync(s.keyFile));
  }
});

test('seal-key: a failed fnox set leaves the policy and the key file alone', () => {
  const s = sandbox({ fnoxFails: true, policy: '' });
  const r = s.run();
  ok(r.status !== 0);
  is(s.read('secrets-policy.toml'), '');
  ok(fs.existsSync(s.keyFile));
});

test('seal-key --dry-run and --keep: dry run changes nothing, --keep keeps the file', () => {
  const dry = sandbox({ policy: '' });
  is(dry.run('--dry-run').status, 0);
  is(dry.read('fnox-stdin'), null);
  is(dry.read('secrets-policy.toml'), '');
  ok(fs.existsSync(dry.keyFile));
  const keep = sandbox({ policy: '' });
  is(keep.run('--keep').status, 0);
  ok(keep.read('fnox-stdin') !== null);
  ok(fs.existsSync(keep.keyFile));
});

test('wrappers run fnox exec on exactly the granted runner argv', () => {
  for (const [file, tool] of [['gcloud-sealed', 'gcloud'], ['bq-sealed', 'bq']]) {
    const dir = fs.mkdtempSync(path.join(process.env.HOME || '/tmp', '.wrap-test-'));
    fs.writeFileSync(path.join(dir, 'fnox'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n`);
    fs.chmodSync(path.join(dir, 'fnox'), 0o755);
    const r = spawnSync('sh', [path.join(ASSETS, file), 'a b', '--x'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    is(r.status, 0, r.stderr);
    is(fs.readFileSync(path.join(dir, 'args'), 'utf8'), ['exec', '--', ...RUNNER, tool, 'a b', '--x', ''].join('\n'));
  }
});

test('run.py decodes base64, refuses a placeholder, and points both credential variables at its temp file', () => {
  const src = fs.readFileSync(path.join(ASSETS, 'run.py'), 'utf8');
  ok(src.startsWith(`#!${RUNNER[0]}\n`));
  ok(src.includes('base64.b64decode(cred, validate=True)'));
  ok(src.includes('cred.startswith("fnox_proxy_")'));
  ok(src.includes('CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE') && src.includes('GOOGLE_APPLICATION_CREDENTIALS'));
  ok(src.includes('BIN = "/usr/local/lib/gcloud-cli/bin"'));
});
