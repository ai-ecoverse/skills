import path from 'node:path';
import test, { is, ok } from 'tst';
import { exitStub, load } from './extract.js';
import { readScript } from './script.js';

const SOURCE = readScript(path.join(process.cwd(), 'scripts/gmail.jsh'));
const NAMES = [
  'envCredentials',
  'configCredentials',
  'firstLine',
  'jerkToken',
  'resolveSource',
  'noCredentialsMessage',
  'refreshAccessToken',
  'getAccessToken',
];
const ENV = {
  GWS_CLIENT_ID: 'id',
  GWS_CLIENT_SECRET: 'secret',
  GWS_REFRESH_TOKEN: 'refresh',
};

function setup({ env = {}, jerk, config = {}, refresh } = {}) {
  const calls = [];
  const exit = exitStub();
  const saved = [];
  const scope = {
    process: { env },
    exec: {
      spawn: async (argv) => {
        calls.push(argv);
        if (jerk instanceof Error) throw jerk;
        return jerk || { exitCode: 127, stdout: '', stderr: '' };
      },
    },
    loadConfig: async () => config,
    saveConfig: async (u) => saved.push(u),
    die: exit.die,
    OAUTH_CLIENT_ID: 'builtin-id',
    OAUTH_CLIENT_SECRET: 'builtin-secret',
    TOKEN_URL: 'https://oauth2.example/token',
    _accessToken: null,
    fetch: async (url, init) => {
      calls.push(['fetch', url, String(init.body)]);
      return { json: async () => refresh || {} };
    },
  };
  return { ...load(SOURCE, NAMES, scope), calls, exit, saved };
}

test('env credentials win and jerk is never run', async () => {
  const t = setup({
    env: ENV,
    jerk: { exitCode: 0, stdout: 'jerk-token\n', stderr: '' },
    refresh: { access_token: 'from-refresh' },
  });
  is(await t.getAccessToken(), 'from-refresh');
  ok(!t.calls.some((c) => c[0] === 'jerk'), 'jerk not spawned');
  ok(t.calls.some((c) => c[0] === 'fetch' && c[2].includes('refresh_token=refresh')));
});

test('partial env credentials do not count', async () => {
  const t = setup({
    env: { GWS_CLIENT_ID: 'id', GWS_CLIENT_SECRET: 'secret' },
    jerk: { exitCode: 0, stdout: 'jerk-token\n', stderr: '' },
  });
  is(await t.getAccessToken(), 'jerk-token');
});

test('jerk is asked to reveal the token, and beats the legacy config', async () => {
  const t = setup({
    jerk: { exitCode: 0, stdout: 'ya29.abc\n', stderr: '' },
    config: { refresh_token: 'legacy' },
  });
  is(await t.getAccessToken(), 'ya29.abc');
  is(t.calls[0], ['jerk', 'gmail', 'get', '--reveal']);
  is(t.saved, []);
});

test('a masked jerk token is not used', async () => {
  const t = setup({
    jerk: { exitCode: 0, stdout: 'ya29…beef\n', stderr: '' },
    config: { refresh_token: 'legacy', access_token: 'cached', expires_at: Date.now() + 600000 },
  });
  is(await t.getAccessToken(), 'cached');
});

for (const [name, jerk] of [
  ['needs sign-in (3)', { exitCode: 3, stdout: '', stderr: 'run jerk gmail create' }],
  ['is unavailable (4)', { exitCode: 4, stdout: '', stderr: 'no browser' }],
  ['is missing (127)', { exitCode: 127, stdout: '', stderr: '' }],
  ['cannot be spawned', new Error('spawn jerk ENOENT')],
]) {
  test(`legacy config is used when jerk ${name}`, async () => {
    const t = setup({
      jerk,
      config: { refresh_token: 'legacy', access_token: 'cached', expires_at: Date.now() + 600000 },
    });
    is(await t.getAccessToken(), 'cached');
  });
}

test('an expired legacy config refreshes with the stored client', async () => {
  const t = setup({
    config: { refresh_token: 'legacy', client_id: 'cid', client_secret: 'cs', expires_at: 1 },
    refresh: { access_token: 'fresh', expires_in: 100 },
  });
  is(await t.getAccessToken(), 'fresh');
  ok(t.calls.some((c) => c[0] === 'fetch' && c[2].includes('client_id=cid')));
  is(t.saved[0].access_token, 'fresh');
});

test('no source: the error names gmail login and installing jerk', async () => {
  const t = setup({});
  let err;
  try {
    await t.getAccessToken();
  } catch (e) {
    err = e;
  }
  is(err.name, 'NodeExitError');
  ok(t.exit.dies[0].includes('gmail login'));
  ok(t.exit.dies[0].includes('slicc-jerk'));
  ok(t.exit.dies[0].includes('GWS_REFRESH_TOKEN'));
});

test('no source with jerk present but signed out: no install hint', async () => {
  const t = setup({ jerk: { exitCode: 3, stdout: '', stderr: 'x' } });
  try {
    await t.getAccessToken();
  } catch {}
  ok(t.exit.dies[0].includes('gmail login'));
  ok(!t.exit.dies[0].includes('not installed'));
});

test('a jerk failure never puts its stdout into the message', async () => {
  const t = setup({ jerk: { exitCode: 1, stdout: 'SECRETTOKEN', stderr: 'boom' } });
  try {
    await t.getAccessToken();
  } catch {}
  ok(!t.exit.dies[0].includes('SECRETTOKEN'));
});

test('resolveSource reports the source in order', async () => {
  is((await setup({ env: ENV }).resolveSource()).source, 'env');
  is(
    (await setup({ jerk: { exitCode: 0, stdout: 't', stderr: '' } }).resolveSource()).source,
    'jerk'
  );
  is((await setup({ config: { refresh_token: 'r' } }).resolveSource()).source, 'config');
  is((await setup({}).resolveSource()).source, null);
});
