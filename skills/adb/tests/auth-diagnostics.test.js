import test, { is, ok, rejects } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const source = fs.readFileSync(path.join(__dirname, '../scripts/adb.jsh'), 'utf8');

function loadClient() {
  const end = source.indexOf('const SHELL_V2_STDOUT');
  ok(end > 0, 'ADB handshake block not found');
  const warnings = [];
  // Evaluate the actual .jsh helpers without running the CLI. Stub signing so
  // these diagnostic tests need no private key or connected device.
  const client = new Function(
    'require',
    'console',
    `${source.slice(0, end)}
    signToken = (token) => token;
    return { handshake, AdbTransport, A_CNXN, A_AUTH, A_OKAY, AUTH_TOKEN, AUTH_SIGNATURE };`
  )(() => ({}), { error: (message) => warnings.push(message) });
  return { ...client, warnings };
}

for (const repeated of [false, true]) {
  test(`auth failure reports observed frames and both causes (${repeated ? 'identical' : 'fresh'} tokens)`, async () => {
    const { handshake, A_CNXN, A_AUTH, A_OKAY, AUTH_TOKEN, AUTH_SIGNATURE } = loadClient();
    const messages = [{ cmd: A_OKAY }];
    for (let i = 0; i < 4; i++) {
      messages.push({
        cmd: A_AUTH,
        arg0: AUTH_TOKEN,
        data: new Uint8Array(20).fill(repeated ? 1 : i),
      });
    }
    const writes = [];
    const transport = {
      writeMessage: async (...args) => writes.push(args),
      readMessage: async () => {
        ok(messages.length, 'handshake read beyond the auth limit');
        return messages.shift();
      },
    };
    await rejects(() => handshake(transport, null), (error) => {
      ok((/after 4 A_AUTH TOKEN frames/).test(error.message));
      ok((/Either this key is not trusted by the device/).test(error.message));
      ok((/USB transport\n {2}is desynced with stale A_AUTH frames/).test(error.message));
      ok((/previous killed session/).test(error.message));
      ok((/retry \(optionally with --no-reset\) may clear a stale transport/).test(error.message));
      ok((/--key/).test(error.message));
      ok((/~\/\.android\/adbkey/).test(error.message));
      ok((/Enrolling a NEW key is not\n {2}supported/).test(error.message));
      ok((/AUTH RSAPUBLICKEY frame, which this\n {2}client does not send/).test(error.message));
      ok((/no on-device approval prompt will appear/).test(error.message));
      ok(!(/device rejected the signature — this key is not authorized/).test(error.message));
      return true;
    });
    is(messages.length, 0);
    is(
      writes.map(([cmd, arg0]) => [cmd, arg0]),
      [[A_CNXN, 0x01000001], ...Array.from({ length: 3 }, () => [A_AUTH, AUTH_SIGNATURE])]
    );
  });
}

for (const reset of ['failed', 'successful', 'skipped']) {
  test(`${reset} reset preserves interface claiming and handshake success`, async () => {
    const { AdbTransport, handshake, A_CNXN, warnings } = loadClient();
    const calls = [];
    const descriptor = new Uint8Array([
      9, 2, 32, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 2, 0xff, 0x42, 1, 0, 7, 5, 0x81, 2, 0, 2, 0, 7, 5,
      2, 2, 0, 2, 0,
    ]);
    const device = {
      open: async () => calls.push('open'),
      controlTransferIn: async (_setup, length) => descriptor.slice(0, length),
      selectConfiguration: async () => calls.push('configure'),
      reset: async () => {
        calls.push('reset');
        if (reset === 'failed') throw new Error('synthetic reset failure');
      },
      claimInterface: async (number) => calls.push(`claim ${number}`),
    };
    const transport = new AdbTransport(device, 100, { reset: reset !== 'skipped' });
    await transport.open();
    is(transport.claimed, true);
    is(calls, [
      'open',
      'configure',
      ...(reset === 'skipped' ? [] : ['reset']),
      'claim 0',
    ]);
    if (reset === 'failed') {
      is(warnings.length, 1);
      ok((/warning: USB reset failed to clear endpoint buffers/).test(warnings[0]));
      ok((/handshake may encounter stale frames/).test(warnings[0]));
    } else {
      is(warnings, []);
    }
    transport.writeMessage = async () => {};
    transport.readMessage = async () => ({
      cmd: A_CNXN,
      arg1: 4096,
      data: new TextEncoder().encode('device::\0'),
    });
    is(await handshake(transport, null), 'device::');
    is(transport.maxPayload, 4096);
  });
}
