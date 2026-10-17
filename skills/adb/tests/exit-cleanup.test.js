import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// cmdPull + withDevice, cut out of the shipped adb.jsh. Under Node exit
// semantics (slicc-jsh, SLICC 7) nothing runs after cli.die, so a refusal
// inside the device session must surface as an error AFTER the transport is
// closed, never as a die inside it (which would leave the USB interface claimed).
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/adb.jsh'), 'utf8');

function extract(signature) {
  const start = SOURCE.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 2);
}

test('pull from a device without shell_v2 closes the transport before failing', async () => {
  const events = [];
  class AdbTransport {
    async open() {
      events.push('open');
    }
    async close() {
      events.push('close');
    }
  }
  const scope = {
    AdbTransport,
    pickDevice: async () => ({ device: { serialNumber: 'S1' } }),
    loadKey: async () => ({}),
    handshake: async () => 'device::features=cmd,stat_v2',
    parseBanner: () => ({ props: { features: 'cmd,stat_v2' } }),
    runCommand: async () => {
      throw new Error('must not run');
    },
    shellQuote: (v) => `'${v}'`,
    cli: {
      die: (msg) => {
        events.push({ die: msg, closed: events.includes('close') });
        throw Object.assign(new Error(msg), { name: 'NodeExitError' });
      },
    },
    fs: { writeFileBinary: async () => events.push('write') },
  };
  const proxy = new Proxy(scope, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
  });
  const cmdPull = new Function(
    'scope',
    `with (scope) { ${extract('async function withDevice(')}\n${extract('async function cmdPull(')}\nreturn cmdPull; }`
  )(proxy);
  let err = null;
  try {
    await cmdPull({}, ['/sdcard/a.png', '/tmp/a.png']);
  } catch (e) {
    err = e;
  }
  ok(
    err && err.name !== 'NodeExitError',
    'the refusal is an error for main(), not an exit inside the session'
  );
  ok(err.message.includes('does not advertise shell_v2'), err.message);
  is(events, ['open', 'close']);
});
