import { spawn, spawnSync } from 'node:child_process';
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

function runner() {
  const dir = fs.mkdtempSync(path.join(process.env.HOME || '/tmp', '.runner-test-'));
  const bin = path.join(dir, 'bin');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  const src = fs.readFileSync(path.join(ASSETS, 'run.py'), 'utf8');
  const fixed = 'BIN = "/usr/local/lib/gcloud-cli/bin"';
  ok(src.includes(fixed));
  fs.writeFileSync(path.join(dir, 'run.py'), src.replace(fixed, `BIN = ${JSON.stringify(bin)}`));
  const stub = [
    'import json, os, sys, time',
    'p = os.environ.get("CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "")',
    'out = {"argv": sys.argv[1:], "same": p == os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"), "path": p}',
    'if p:',
    '    out["mode"] = oct(os.stat(p).st_mode & 0o777)',
    '    out["dirmode"] = oct(os.stat(os.path.dirname(p)).st_mode & 0o777)',
    '    out["body"] = open(p).read()',
    'open(os.environ["STUB_OUT"], "w").write(json.dumps(out))',
    'if "--sleep" in sys.argv: time.sleep(30)',
    'if "--fail" in sys.argv: raise SystemExit(7)',
  ].join('\n');
  for (const tool of ['gcloud', 'bq']) fs.writeFileSync(path.join(bin, tool), stub);
  const env = (cred) => ({
    ...process.env,
    TMPDIR: tmp,
    STUB_OUT: path.join(dir, 'out.json'),
    ...(cred === undefined ? {} : { GCLOUD_CREDENTIALS: cred }),
  });
  const run = (cred, ...args) =>
    spawnSync('python3', [path.join(dir, 'run.py'), ...args], { encoding: 'utf8', env: env(cred) });
  const start = (cred, ...args) => spawn('python3', [path.join(dir, 'run.py'), ...args], { env: env(cred) });
  const out = () => JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  const left = () => fs.readdirSync(tmp).filter((n) => n.startsWith('gcloud-cred-'));
  return { run, start, out, left, tmp, outFile: path.join(dir, 'out.json') };
}

const B64 = Buffer.from(SA_JSON).toString('base64');
const HAS_PYTHON = spawnSync('python3', ['-c', 'pass']).status === 0;
if (!HAS_PYTHON) console.log('# run.py tests skipped: no python3 here (gcloud needs @ai-ecoverse/wasix-python)');
const PY = { skip: !HAS_PYTHON, timeout: 60000 };

test('run.py: decodes the key into a private 0600 file named by both variables, and removes it after', PY, () => {
  const r = runner();
  for (const tool of ['gcloud', 'bq']) {
    const p = r.run(B64, tool, 'a b', '--x');
    is(p.status, 0, p.stderr);
    const o = r.out();
    is(o.argv, ['a b', '--x']);
    ok(o.same && o.path.startsWith(r.tmp));
    is(o.body, SA_JSON);
    is(o.mode, '0o600');
    is(o.dirmode, '0o700');
    is(r.left(), []);
  }
});

test('run.py: removes the file when the tool fails, and passes no credential when none is set', PY, () => {
  const r = runner();
  is(r.run(B64, 'bq', '--fail').status, 7);
  is(r.left(), []);
  is(r.run(undefined, 'bq', 'q').status, 0);
  is(r.out().path, '');
});

test('run.py: refuses a placeholder, a non-base64 value and raw JSON, writing nothing', PY, () => {
  const r = runner();
  for (const cred of ['fnox_proxy_d5cb63850b60d46da720bf44', 'not base64!', SA_JSON]) {
    const p = r.run(cred, 'bq', 'q');
    is(p.status, 2);
    ok(!(p.stdout + p.stderr).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'));
    ok(!fs.existsSync(r.outFile));
    is(r.left(), []);
  }
});

test('run.py: SIGTERM, SIGHUP and SIGINT during a run remove the credential file', PY, async () => {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    const r = runner();
    const child = r.start(B64, 'bq', '--sleep');
    for (let n = 0; !fs.existsSync(r.outFile); n += 1) {
      ok(n < 200, 'the stub never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    is(r.left().length, 1);
    const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));
    child.kill(sig);
    is(await done, sig);
    is(r.left(), [], `${sig} left the key behind`);
  }
});

test('run.py: a directory left by a killed run is removed; a live run is left alone', PY, () => {
  const r = runner();
  const dead = path.join(r.tmp, 'gcloud-cred-999999-abc');
  const live = path.join(r.tmp, `gcloud-cred-${process.pid}-abc`);
  for (const d of [dead, live]) {
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'credentials.json'), '{}');
  }
  is(r.run(B64, 'bq', 'q').status, 0);
  ok(!fs.existsSync(dead));
  ok(fs.existsSync(live));
});
