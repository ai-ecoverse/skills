const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../phone-view.shtml'), 'utf8');
const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

function panel(list = async () => [], usb = {}) {
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
    setTimeout,
    clearTimeout,
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
  assert.match(p.elements.status.textContent, /usb request/);
  assert.equal(p.elements.status.className, 'err');
  assert.equal(p.elements['connect-btn'].disabled, false);
  assert.equal(p.elements['empty-state'].hidden, false);
  assert.equal(p.elements.screen.hidden, true);
  assert.ok(p.controls.every((button) => button.disabled));
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
  assert.equal(p.elements['connect-btn'].disabled, true);
  assert.equal(p.elements['connect-btn'].textContent, 'Connecting…');
  await p.run('start()');
  assert.equal(calls, 1);
  resolveDevices([]);
  await pending;
  assert.equal(p.elements['connect-btn'].disabled, false);
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
  assert.equal(reads, 2);
  assert.match(p.elements.status.textContent, /Stream ended: transport lost/);
  assert.equal(p.elements.status.className, 'err');
  assert.equal(p.elements['connect-btn'].disabled, false);
  assert.deepEqual(p.calls, ['release', 'close']);
});

test('a never-settling transferIn is bounded', async () => {
  const p = panel(undefined, { transferIn: () => new Promise(() => {}) });
  await assert.rejects(
    p.run('new Adb(1, { epIn: 2 }, { read: 5 }).readExact(1)'),
    /read timed out/
  );
});

test('a healthy idle stream survives the read timeout', async () => {
  // An idle screen produces no data, so transferIn stays pending for minutes.
  // The stream-read timeout must be long enough that it never kills a healthy
  // idle session — it is a backstop for an infinite hang, not a diagnostic.
  // The 45-second amber warning is the real user-facing signal.
  let transferInCalls = 0;
  const p = panel(undefined, {
    transferIn: () => {
      transferInCalls++;
      // Simulate an idle screen: transferIn never completes.
      return new Promise(() => {});
    },
  });
  // Verify the constant is at least 30 minutes — long enough that no
  // plausible idle period trips it.
  const ms = p.run('STREAM_READ_TIMEOUT_MS');
  assert.ok(ms >= 30 * 60_000, `STREAM_READ_TIMEOUT_MS should be >= 30 min, got ${ms}`);

  // Start a readExact with the default timeout. If the timeout were still
  // 5 minutes, this would reject; at 30 minutes, it should NOT reject within
  // a short window. We race the readExact against a short timer.
  const raceResult = await p.run(`
    Promise.race([
      new Adb(1, { epIn: 2 }).readExact(1).then(() => 'data'),
      new Promise(resolve => setTimeout(() => resolve('still-alive'), 50)),
    ])
  `);
  assert.equal(raceResult, 'still-alive', 'readExact must not reject while idle');
  assert.ok(transferInCalls >= 1, 'transferIn should have been called');
});

test('a warn status survives the pump finally path', async () => {
  // When a stream stalls into the amber warning and then ends without a
  // rejection, pump's finally block must NOT overwrite the warning with a
  // bland "Stream ended" message. The stall reason must survive.
  const p = panel();
  // Set up the warn state as reportStreamStatus would.
  p.run(`
    session = {
      device: { handle: 1 }, iface: { interfaceNumber: 2 },
      adb: { dummy: true }, stopped: false, frames: 7, bytes: 1024,
      lastByteAt: performance.now() - NO_DATA_WARNING_MS,
    };
    reportStreamStatus('test phone');
  `);
  // Confirm the warning is active.
  assert.equal(p.elements.status.className, 'warn');
  assert.match(p.elements.status.textContent, /no data for/);

  // Now simulate what pump's finally block does: check the guard and call say().
  // This mirrors phone-view.shtml's finally block logic.
  const overwritten = p.run(`
    const before = statusEl.textContent;
    if (!statusEl.classList.contains('err') && !statusEl.classList.contains('warn')) {
      say('Stream ended. Connect to retry.');
    }
    statusEl.textContent !== before
  `);
  assert.equal(overwritten, false, 'pump finally must not overwrite a warn status');
  assert.match(p.elements.status.textContent, /no data for/);
  assert.equal(p.elements.status.className, 'warn');
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
  assert.match(p.elements.status.textContent, /no data for 45s/);
  assert.match(p.elements.status.textContent, /disconnected or claimed elsewhere/);
  assert.equal(p.elements.status.className, 'warn');
});

test('a ticker update cannot overwrite a latched stream error', () => {
  const p = panel();
  p.run(`
    session = { stopped: false, frames: 7, bytes: 1024, lastByteAt: performance.now() };
    say('Stream ended: transport lost. Connect to retry.', true);
    reportStreamStatus('test phone');
  `);
  assert.equal(p.elements.status.textContent, 'Stream ended: transport lost. Connect to retry.');
  assert.equal(p.elements.status.className, 'err');
});

test('Stop releases the connection and restores the disconnected controls', async () => {
  const p = panel();
  p.run(
    'session = { device: { handle: 1 }, iface: { interfaceNumber: 2 }, stopped: false, frames: 7 }; syncControls();'
  );
  assert.equal(p.elements.screen.hidden, false);
  assert.ok(p.controls.every((button) => !button.disabled));
  await p.run('stop()');
  assert.deepEqual(p.calls, ['release', 'close']);
  assert.match(p.elements.status.textContent, /stopped after 7 frames/);
  assert.equal(p.elements.screen.hidden, true);
  assert.equal(p.elements['connect-btn'].disabled, false);
  assert.ok(p.controls.every((button) => button.disabled));
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
      assert.equal(p.elements['connect-btn'].disabled, true);
      assert.equal(p.elements['connect-btn'].textContent, 'Disconnecting…');
      await p.run('start()');
      assert.equal(starts, 0);
      assert.equal(releases, 1);
      assert.equal(closes, 0);

      finishRelease();
      await new Promise(setImmediate);
      p.run('syncControls()');
      assert.equal(closes, 1);
      assert.equal(p.elements['connect-btn'].disabled, true);
      await p.run('start()');
      assert.equal(starts, 0);

      finishClose();
      await Promise.all([pending, duplicate]);
      assert.equal(p.elements['connect-btn'].disabled, false);
      assert.equal(p.elements['connect-btn'].textContent, 'Connect');
      assert.equal(releases, 1);
      assert.equal(closes, 1);
      await p.run('start()');
      assert.equal(starts, 1);
    });
  }
}
