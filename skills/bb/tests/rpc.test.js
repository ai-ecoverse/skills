// bb rpc: path construction, request body, name validation, output, auth errors.
//
// Run from the skill directory: tst tests/rpc.test.js

import test, { is, ok } from 'tst';
import { CREDENTIAL, runBb, SERVER } from './harness.js';

const envelope = (result) => () => ({ status: 200, body: { ok: true, result } });

test('rpc posts to /plugins/<plugin>/rpc/<method> with a null body by default', async () => {
  const run = await runBb(['rpc', 'github', 'listLinks'], { server: envelope({ links: {} }) });
  is(run.exitCode, 0);
  is(run.calls.length, 1);
  const call = run.calls[0];
  is(call.method, 'POST');
  is(call.url, `${SERVER}/api/v1/plugins/github/rpc/listLinks`);
  is(call.search, '');
  is(call.body, 'null');
  is(call.headers['content-type'], 'application/json');
  is(run.stdinReads(), 0);
});

test('rpc sends the machine credential header like every other request', async () => {
  const run = await runBb(['rpc', 'github', 'listLinks'], { server: envelope({ links: {} }) });
  is(run.calls[0].headers['x-bb-connect-machine'], CREDENTIAL);
});

test('rpc prints the result, and the raw envelope with --json', async () => {
  const result = { links: { 'pr:owner/repo#1': [{ kind: 'pr', number: 1 }] } };
  const plain = await runBb(['rpc', 'github', 'listLinks'], { server: envelope(result) });
  is(plain.out, [result]);
  const raw = await runBb(['rpc', 'github', 'listLinks', '--json'], { server: envelope(result) });
  is(raw.out, [{ ok: true, result }]);
});

test('rpc sends a JSON argument as the body', async () => {
  const run = await runBb(['rpc', 'github', 'pullForThread', '{"threadId":"t-0001"}'], {
    server: envelope({ pull: null }),
  });
  is(run.exitCode, 0);
  is(run.calls[0].url, `${SERVER}/api/v1/plugins/github/rpc/pullForThread`);
  is(JSON.parse(run.calls[0].body), { threadId: 't-0001' });
  is(run.out, [{ pull: null }]);
});

test('rpc takes the body back when --json swallowed it', async () => {
  const run = await runBb(['rpc', 'github', 'pullForThread', '--json', '{"threadId":"t-0001"}'], {
    server: envelope({ pull: null }),
  });
  is(run.exitCode, 0);
  is(JSON.parse(run.calls[0].body), { threadId: 't-0001' });
  is(run.out, [{ ok: true, result: { pull: null } }]);
});

test('rpc reads the body from stdin with -', async () => {
  const run = await runBb(['rpc', 'github', 'pullForThread', '-'], {
    stdin: '{"threadId":"t-0002"}\n',
    server: envelope({ pull: null }),
  });
  is(run.exitCode, 0);
  is(run.stdinReads(), 1);
  is(JSON.parse(run.calls[0].body), { threadId: 't-0002' });
});

test('rpc with - and empty stdin sends null', async () => {
  const run = await runBb(['rpc', 'github', 'listLinks', '-'], {
    stdin: null,
    server: envelope({ links: {} }),
  });
  is(run.exitCode, 0);
  is(run.calls[0].body, 'null');
});

test('rpc refuses invalid JSON before any request', async () => {
  const run = await runBb(['rpc', 'github', 'pullForThread', '{threadId:'], {
    server: envelope(null),
  });
  is(run.exitCode, 1);
  ok(/not valid JSON/u.test(run.error.message));
  is(run.calls.length, 0);
});

test('rpc rejects plugin and method names that could escape the path', async () => {
  const bad = ['../x', 'a/b', 'x?y', 'x#y', '..', '%2e%2e', 'a b', ''];
  for (const name of bad) {
    const asPlugin = await runBb(['rpc', name, 'listLinks'], { server: envelope(null) });
    is(asPlugin.exitCode, 1, `plugin ${JSON.stringify(name)}`);
    is(asPlugin.calls.length, 0, `plugin ${JSON.stringify(name)} made a request`);
    if (name !== '') ok(/invalid plugin name/u.test(asPlugin.error.message), `plugin ${name}`);

    const asMethod = await runBb(['rpc', 'github', name], { server: envelope(null) });
    is(asMethod.exitCode, 1, `method ${JSON.stringify(name)}`);
    is(asMethod.calls.length, 0, `method ${JSON.stringify(name)} made a request`);
    if (name !== '') ok(/invalid method name/u.test(asMethod.error.message), `method ${name}`);
  }
});

test('rpc without a method prints usage and makes no request', async () => {
  const run = await runBb(['rpc', 'github'], { server: envelope(null) });
  is(run.exitCode, 1);
  ok(/usage: bb rpc <plugin> <method>/u.test(run.error.message));
  is(run.calls.length, 0);
});

test('rpc refuses connect.createMachineCode and points at bb attach', async () => {
  const run = await runBb(['rpc', 'connect', 'createMachineCode'], {
    server: envelope({ code: 'one-time-code' }),
  });
  is(run.exitCode, 1);
  ok(/bb attach/u.test(run.error.message));
  is(run.calls.length, 0);
  ok(!run.stdout.includes('one-time-code'));
});

test('rpc reports a rejected credential exactly like other commands', async () => {
  const denied = () => ({ status: 401, body: { error: 'unauthorized' } });
  const rpc = await runBb(['rpc', 'github', 'listLinks'], { server: denied });
  const list = await runBb(['thread', 'list'], { server: denied });
  is(rpc.exitCode, 1);
  ok(/rejected the stored credential \(401\)/u.test(rpc.error.message));
  is(rpc.error.message, list.error.message);
  for (const text of [rpc.stdout, rpc.stderr, rpc.error.message]) {
    ok(!text.includes(CREDENTIAL), 'credential leaked');
  }
});

test('rpc surfaces a server error with its status', async () => {
  const run = await runBb(['rpc', 'github', 'nope'], {
    server: () => ({
      status: 404,
      body: { ok: false, error: { code: 'unknown_method', message: 'no rpc method' } },
    }),
  });
  is(run.exitCode, 1);
  ok(/returned 404 for \/plugins\/github\/rpc\/nope/u.test(run.error.message));
  ok(/unknown_method/u.test(run.error.message));
  ok(!run.error.message.includes(CREDENTIAL));
});
