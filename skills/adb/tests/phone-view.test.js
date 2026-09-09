const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../phone-view.shtml'), 'utf8');
const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

function panel(list = async () => []) {
  const controls = Array.from({ length: 4 }, () => ({ disabled: true }));
  const elements = {
    status: { textContent: 'No device connected', className: '' },
    screen: { hidden: true, getContext: () => ({}), addEventListener() {} },
    'empty-state': { hidden: false },
    'connect-btn': { textContent: 'Connect', disabled: false },
  };
  const calls = [];
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    setInterval,
    clearInterval,
    document: { getElementById: (id) => elements[id], querySelectorAll: () => controls },
    slicc: {
      usb: {
        list,
        releaseInterface: async () => calls.push('release'),
        close: async () => calls.push('close'),
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
