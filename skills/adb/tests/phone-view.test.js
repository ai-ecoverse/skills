import test, { is, ok, rejects } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const source = fs.readFileSync(path.join(__dirname, '../phone-view.shtml'), 'utf8');
const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

function panel(list = async () => [], usb = {}, timers = {}) {
  const controls = Array.from({ length: 4 }, () => ({ disabled: true }));
  const elements = {
    status: {
      textContent: 'No device connected',
      className: '',
      classList: { contains: (name) => elements.status.className.split(/\s+/).includes(name) },
    },
    screen: { hidden: true, getContext: () => ({}), addEventListener() {} },
    'empty-state': { hidden: false },
    'connect-btn': { textContent: 'Connect', disabled: false },
  };
  const calls = [];
  class FakeVideoDecoder {
    constructor() {
      this.state = 'configured';
    }
    configure() {}
    decode() {}
    async close() {
      this.state = 'closed';
    }
  }
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    performance,
    setInterval,
    clearInterval,
    setTimeout: timers.setTimeout ?? setTimeout,
    clearTimeout: timers.clearTimeout ?? clearTimeout,
    VideoDecoder: FakeVideoDecoder,
    EncodedVideoChunk: class {},
    document: { getElementById: (id) => elements[id], querySelectorAll: () => controls },
    slicc: {
      usb: {
        list,
        releaseInterface: async () => calls.push('release'),
        close: async () => calls.push('close'),
        ...usb,
      },
    },
  });
  vm.runInContext(scripts, context);
  return { elements, controls, calls, run: (code) => vm.runInContext(code, context) };
}

test('no granted device leaves a useful error and enables retry', async () => {
  const p = panel();
  await p.run('start()');
  ok((/usb request/).test(p.elements.status.textContent));
  is(p.elements.status.className, 'err');
  is(p.elements['connect-btn'].disabled, false);
  is(p.elements['empty-state'].hidden, false);
  is(p.elements.screen.hidden, true);
  ok(p.controls.every((button) => button.disabled));
});

test('a pending connection disables Connect and ignores duplicate starts', async () => {
  let resolveDevices;
  let calls = 0;
  const p = panel(() => {
    calls++;
    return new Promise((resolve) => {
      resolveDevices = resolve;
    });
  });
  const pending = p.run('start()');
  is(p.elements['connect-btn'].disabled, true);
  is(p.elements['connect-btn'].textContent, 'Connecting…');
  await p.run('start()');
  is(calls, 1);
  resolveDevices([]);
  await pending;
  is(p.elements['connect-btn'].disabled, false);
});

test('a rejected mid-stream read retains its cause and enables retry', async () => {
  let reads = 0;
  const p = panel(undefined, {
    transferOut: async () => {},
    transferIn: async () => {
      if (reads++ === 0) {
        const bytes = new Uint8Array(24);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x59414b4f, true); // A_OKAY: stream opened
        view.setUint32(4, 9, true); // remote id
        view.setUint32(8, 2, true); // first local stream id
        return { bytes };
      }
      throw new Error('transport lost');
    },
  });
  await p.run(`
    const adb = new Adb(1, { epIn: 2, epOut: 3 });
    session = {
      device: { handle: 1 }, iface: { interfaceNumber: 4 }, adb,
      stopped: false, frames: 0, bytes: 0, size: { w: 720, h: 1568 },
      lastByteAt: performance.now(),
    };
    syncControls();
    pump(adb, session.size);
  `);
  is(reads, 2);
  ok((/Stream ended: transport lost/).test(p.elements.status.textContent));
  is(p.elements.status.className, 'err');
  is(p.elements['connect-btn'].disabled, false);
  is(p.calls, ['release', 'close']);
});

test('a never-settling transferIn is bounded', async () => {
  const p = panel(undefined, { transferIn: () => new Promise(() => {}) });
  await rejects(() => p.run('new Adb(1, { epIn: 2 }, { read: 5 }).readExact(1)'), /read timed out/);
});

test('a healthy idle stream gets a long read timeout', () => {
  let transferInCalls = 0;
  let scheduledDelay = 0;
  const p = panel(
    undefined,
    {
      transferIn: () => {
        transferInCalls++;
        return new Promise(() => {});
      },
    },
    {
      setTimeout: (_callback, delay) => {
        scheduledDelay = delay;
        return 1;
      },
      clearTimeout: () => {},
    }
  );
  void p.run('new Adb(1, { epIn: 2 }).readExact(1)');
  is(transferInCalls, 1);
  is(p.run('STREAM_READ_TIMEOUT_MS'), 30 * 60_000);
  ok(scheduledDelay > 29 * 60_000);
});

test('a warn status survives the pump finally path', async () => {
  // When a stream stalls into the amber warning and then ends cleanly (no
  // rejection), pump's real finally block must NOT overwrite the warning with
  // the bland "Stream ended. Connect to retry." message. Exercises the actual
  // pump() → adb.stream() → dispatchLoop path, not a copy of the guard.
  let reads = 0;
  const p = panel(undefined, {
    transferOut: async () => {},
    transferIn: async () => {
      reads++;
      if (reads === 1) {
        // A_OKAY — the stream is accepted by the device.
        const bytes = new Uint8Array(24);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x59414b4f, true); // A_OKAY
        view.setUint32(4, 9, true); // remote id
        view.setUint32(8, 2, true); // first local stream id
        return { bytes };
      }
      if (reads === 2) {
        // Before the stream ends, put the session in the stale/warn state
        // as if the ticker's reportStreamStatus had fired after a long quiet.
        p.run(`
          session.lastByteAt = performance.now() - NO_DATA_WARNING_MS;
          reportStreamStatus('test phone');
        `);
        is(p.elements.status.className, 'warn');
        ok((/no data for/).test(p.elements.status.textContent));
        // A_CLSE — clean stream end (no error). This makes stream() resolve
        // without rejection, so pump's catch is skipped and only finally runs.
        const bytes = new Uint8Array(24);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 0x45534c43, true); // A_CLSE
        view.setUint32(4, 9, true); // remote id (arg0)
        view.setUint32(8, 2, true); // local stream id (arg1)
        return { bytes };
      }
      // dispatchLoop exits when streams.size === 0; should not reach here.
      return new Promise(() => {});
    },
  });
  await p.run(`
    const adb = new Adb(1, { epIn: 2, epOut: 3 });
    session = {
      device: { handle: 1 }, iface: { interfaceNumber: 4 }, adb,
      stopped: false, frames: 0, bytes: 0, size: { w: 720, h: 1568 },
      lastByteAt: performance.now(),
    };
    syncControls();
    pump(adb, session.size);
  `);
  // pump's finally has now run. The warn status must have survived.
  is(reads, 2);
  is(p.elements.status.className, 'warn');
  ok((/no data for/).test(p.elements.status.textContent));
  is(p.elements['connect-btn'].disabled, false);
  is(p.calls, ['release', 'close']);
});

test('lack of byte progress changes the streaming status', () => {
  const p = panel();
  p.run(`
    session = {
      stopped: false, frames: 7, bytes: 1024,
      lastByteAt: performance.now() - NO_DATA_WARNING_MS,
    };
    reportStreamStatus('test phone');
  `);
  ok((/no data for 45s/).test(p.elements.status.textContent));
  ok((/disconnected or claimed elsewhere/).test(p.elements.status.textContent));
  is(p.elements.status.className, 'warn');
});

test('a ticker update cannot overwrite a latched stream error', () => {
  const p = panel();
  p.run(`
    session = { stopped: false, frames: 7, bytes: 1024, lastByteAt: performance.now() };
    say('Stream ended: transport lost. Connect to retry.', true);
    reportStreamStatus('test phone');
  `);
  is(p.elements.status.textContent, 'Stream ended: transport lost. Connect to retry.');
  is(p.elements.status.className, 'err');
});

test('Stop releases the connection and restores the disconnected controls', async () => {
  const p = panel();
  p.run(
    'session = { device: { handle: 1 }, iface: { interfaceNumber: 2 }, stopped: false, frames: 7 }; syncControls();'
  );
  is(p.elements.screen.hidden, false);
  ok(p.controls.every((button) => !button.disabled));
  await p.run('stop()');
  is(p.calls, ['release', 'close']);
  ok((/stopped after 7 frames/).test(p.elements.status.textContent));
  is(p.elements.screen.hidden, true);
  is(p.elements['connect-btn'].disabled, false);
  ok(p.controls.every((button) => button.disabled));
});

for (const cleanupFails of [false, true]) {
  for (const trigger of ['stop()', 'teardown()']) {
    test(`${trigger} blocks reconnect through both cleanup steps (${cleanupFails ? 'rejection' : 'success'})`, async () => {
      let finishRelease;
      let finishClose;
      let releases = 0;
      let closes = 0;
      let starts = 0;
      const p = panel(
        async () => {
          starts++;
          return [];
        },
        {
          releaseInterface: () => {
            releases++;
            return new Promise((resolve, reject) => {
              finishRelease = () =>
                cleanupFails ? reject(new Error('release failed')) : resolve();
            });
          },
          close: () => {
            closes++;
            return new Promise((resolve, reject) => {
              finishClose = () => (cleanupFails ? reject(new Error('close failed')) : resolve());
            });
          },
        }
      );
      p.run(
        'session = { device: { handle: 1 }, iface: { interfaceNumber: 2 }, frames: 7 }; syncControls();'
      );
      const pending = p.run(trigger);
      const duplicate = p.run('teardown()');
      await new Promise(setImmediate);
      is(p.elements['connect-btn'].disabled, true);
      is(p.elements['connect-btn'].textContent, 'Disconnecting…');
      await p.run('start()');
      is(starts, 0);
      is(releases, 1);
      is(closes, 0);

      finishRelease();
      await new Promise(setImmediate);
      p.run('syncControls()');
      is(closes, 1);
      is(p.elements['connect-btn'].disabled, true);
      await p.run('start()');
      is(starts, 0);

      finishClose();
      await Promise.all([pending, duplicate]);
      is(p.elements['connect-btn'].disabled, false);
      is(p.elements['connect-btn'].textContent, 'Connect');
      is(releases, 1);
      is(closes, 1);
      await p.run('start()');
      is(starts, 1);
    });
  }
}
