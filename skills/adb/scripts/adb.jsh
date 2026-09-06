// adb.jsh — an ADB client that speaks the wire protocol directly over WebUSB.
// No host `adb` binary, no adb server: SLICC is the ADB host.
//
// Wire format captured live against a moto g67 (Android 16), 2026-09-06.
// Protocol reference: platform/system/core/adb/protocol.txt.
const usb = require('sliccy:usb');
const fs = require('fs');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const skill = require('sliccy:skill');

const HELP = `
adb — drive an Android device over WebUSB, no host adb required

USAGE
  adb devices                    List granted USB devices exposing an ADB interface
  adb connect                    Authenticate and print the device banner
  adb shell <command...>         Run a shell command; everything after 'shell'
                                 is sent verbatim, flags included
  adb screencap <out.png>        Capture the framebuffer to a VFS path
  adb pull <remote> <local>      Copy a file off the device (binary-safe)

FLAGS  (must precede the subcommand, as with real adb: adb --serial X shell ...)
  --serial <s>   Target a specific device serial (default: first ADB-capable one)
  --key <path>   RSA private key, PKCS#8 PEM (default: config, then /workspace/.adb/adbkey)
  --json         Machine-readable output
  --timeout <ms> Per-transfer timeout (default 10000)
  --no-reset     Skip the USB reset on connect (see NOTES)

FIRST RUN
  1. usb request --vid 0x18d1        # or your vendor; needs a real user gesture
  2. Put a PKCS#8 private key at /workspace/.adb/adbkey — reuse the host's
     ~/.android/adbkey to inherit its existing authorization, or generate one
     and approve the on-device prompt.
  3. adb connect

NOTES
  Stop the host adb server first (\`adb kill-server\`). It claims the ADB
  interface exclusively. The USB reset issued on connect does free it, but the
  host server re-claims it as soon as the device re-enumerates, so leaving it
  running makes calls fail intermittently with a busy interface.

  The reset also clears endpoint buffers, which is what keeps the handshake
  deterministic after a session is killed mid-stream. --no-reset skips it:
  faster and less disruptive, but then a host adb server blocks the claim
  outright and stale frames can desync the next handshake.
`.trim();

// ── ADB protocol constants ────────────────────────────────────────────
const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const CMD_NAMES = {
  [A_CNXN]: 'CNXN', [A_AUTH]: 'AUTH', [A_OPEN]: 'OPEN',
  [A_OKAY]: 'OKAY', [A_CLSE]: 'CLSE', [A_WRTE]: 'WRTE',
};
const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
// AUTH type 3 (RSAPUBLICKEY) would enroll a new key and raise the on-device
// prompt; unimplemented — it needs ADB's Montgomery-form public key encoding.

const A_VERSION = 0x01000001;
const MAX_PAYLOAD = 256 * 1024;
// The ADB interface is identified by class/subclass/protocol, not by number.
const ADB_CLASS = 0xff, ADB_SUBCLASS = 0x42, ADB_PROTOCOL = 0x01;

const u32 = (v) => v >>> 0;
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── DER / PKCS#8 ──────────────────────────────────────────────────────
// Minimal DER reader: enough to walk PKCS#8 → PKCS#1 RSAPrivateKey.
function derReader(bytes) {
  let i = 0;
  const len = () => {
    let n = bytes[i++];
    if (n < 0x80) return n;
    const count = n & 0x7f;
    n = 0;
    for (let k = 0; k < count; k++) n = n * 256 + bytes[i++];
    return n;
  };
  return {
    tag() { return bytes[i++]; },
    length: len,
    take(n) { const out = bytes.subarray(i, i + n); i += n; return out; },
    skip(n) { i += n; },
    get offset() { return i; },
  };
}

/** Extract { n, d } as BigInt from a PKCS#8 (or bare PKCS#1) RSA private key. */
function parseRsaPrivateKey(der) {
  let r = derReader(der);
  if (r.tag() !== 0x30) throw new Error('not a DER SEQUENCE');
  r.length();
  const first = r.tag();
  if (first !== 0x02) throw new Error('unexpected PKCS#8 layout');
  const vLen = r.length();
  const version = r.take(vLen);

  // PKCS#8 wraps the PKCS#1 key in an OCTET STRING after an AlgorithmIdentifier.
  if (version.length === 1 && version[0] === 0) {
    const save = r.offset;
    const maybeAlg = r.tag();
    if (maybeAlg === 0x30) {
      r.skip(r.length());                       // AlgorithmIdentifier
      if (r.tag() !== 0x04) throw new Error('PKCS#8 missing privateKey OCTET STRING');
      const inner = r.take(r.length());
      return parseRsaPrivateKey(inner);         // inner is PKCS#1 RSAPrivateKey
    }
    r = derReader(der.subarray(save));          // bare PKCS#1: rewind
  }
  // PKCS#1 RSAPrivateKey ::= { version, n, e, d, p, q, ... }
  const int = () => {
    if (r.tag() !== 0x02) throw new Error('expected INTEGER');
    return bytesToBigInt(r.take(r.length()));
  };
  const n = int();
  int();                                        // e — unused for signing
  const d = int();
  return { n, d };
}

function bytesToBigInt(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex ? BigInt('0x' + hex) : 0n;
}

function bigIntToBytes(v, width) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const out = new Uint8Array(width);
  const raw = hex.match(/../g) ?? [];
  if (raw.length > width) throw new Error('integer wider than modulus');
  raw.forEach((h, k) => { out[width - raw.length + k] = parseInt(h, 16); });
  return out;
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

// ── ADB AUTH signing ──────────────────────────────────────────────────
// ADB signs the 20-byte AUTH token as if it were a SHA-1 digest: raw
// PKCS#1 v1.5 with the SHA-1 DigestInfo prefix and no further hashing.
// Web Crypto can't sign a pre-computed digest, so do the modular
// exponentiation directly.
const SHA1_DIGEST_INFO = new Uint8Array([
  0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e,
  0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
]);

function signToken(token, key) {
  const k = (key.n.toString(16).length + 1) >> 1;   // modulus size in bytes
  const tail = SHA1_DIGEST_INFO.length + token.length;
  if (k < tail + 11) throw new Error('RSA key too small for an ADB signature');
  const block = new Uint8Array(k);
  block[0] = 0x00;
  block[1] = 0x01;
  block.fill(0xff, 2, k - tail - 1);
  block[k - tail - 1] = 0x00;
  block.set(SHA1_DIGEST_INFO, k - tail);
  block.set(token, k - token.length);
  return bigIntToBytes(modPow(bytesToBigInt(block), key.d, key.n), k);
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── USB transport ─────────────────────────────────────────────────────
const asBytes = (r) => {
  const d = r?.data ?? r?.bytes ?? r;
  if (d instanceof Uint8Array) return d;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return new Uint8Array(d ?? 0);
};

const DESC_CONFIGURATION = 0x02;
const REQ_GET_DESCRIPTOR = 0x06;
const EP_BULK = 0x02;

/**
 * Read the full configuration descriptor. The realm's device info carries only
 * identity (handle / ids / serial) — no `configurations` array like page-side
 * WebUSB — so the interface layout has to come off the wire.
 * Verified live 2026-09-06 against a moto g67.
 */
async function readConfigDescriptor(device, index = 0) {
  const setup = {
    requestType: 'standard',
    recipient: 'device',
    request: REQ_GET_DESCRIPTOR,
    value: (DESC_CONFIGURATION << 8) | index,
    index: 0,
  };
  const head = asBytes(await device.controlTransferIn(setup, 9));
  if (head.length < 9) throw new Error('short configuration descriptor');
  const total = head[2] | (head[3] << 8);
  return asBytes(await device.controlTransferIn(setup, total));
}

/** Walk the descriptor blob for the ADB interface and its two bulk endpoints. */
function parseAdbInterface(desc) {
  let configurationValue = 1;
  let candidate = null;
  let i = 0;
  while (i + 1 < desc.length) {
    const len = desc[i];
    const type = desc[i + 1];
    if (!len) break;
    if (type === 0x02) configurationValue = desc[i + 5];
    if (type === 0x04) {
      const isAdb =
        desc[i + 5] === ADB_CLASS && desc[i + 6] === ADB_SUBCLASS && desc[i + 7] === ADB_PROTOCOL;
      candidate = isAdb
        ? { configurationValue, interfaceNumber: desc[i + 2], epIn: 0, epOut: 0 }
        : null;
    }
    if (type === 0x05 && candidate) {
      const address = desc[i + 2];
      if ((desc[i + 3] & 0x03) === EP_BULK) {
        if (address & 0x80) candidate.epIn = address & 0x0f;
        else candidate.epOut = address & 0x0f;
      }
      if (candidate.epIn && candidate.epOut) return candidate;
    }
    i += len;
  }
  return null;
}

class AdbTransport {
  constructor(device, timeoutMs, { reset = true } = {}) {
    this.device = device;
    this.timeoutMs = timeoutMs;
    this.shouldReset = reset;
    this.maxPayload = MAX_PAYLOAD;
    this.pending = new Uint8Array(0);
    this.iface = null;
  }

  /** Open, discover the ADB interface off the descriptor, claim it. */
  async open() {
    await this.device.open();
    this.opened = true;
    this.iface = parseAdbInterface(await readConfigDescriptor(this.device));
    if (!this.iface) throw new Error('device exposes no ADB interface (is USB debugging on?)');
    try {
      await this.device.selectConfiguration(this.iface.configurationValue);
    } catch {
      // Already the active configuration — claiming is what matters.
    }
    // Clear anything a previously killed session left in the endpoint buffers.
    // A read-with-timeout "drain" cannot do this: withTimeout abandons the
    // promise but the underlying transferIn stays pending in the bridge and
    // swallows the next real packet, desyncing every read after it.
    if (this.shouldReset) {
      try { await this.device.reset(); } catch { /* not fatal */ }
    }
    await this.device.claimInterface(this.iface.interfaceNumber);
    this.claimed = true;
  }

  async close() {
    if (this.claimed) {
      try { await this.device.releaseInterface(this.iface.interfaceNumber); } catch { /* ignore */ }
    }
    if (this.opened) {
      try { await this.device.close(); } catch { /* ignore */ }
    }
  }

  withTimeout(promise, what) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  async writeMessage(cmd, arg0, arg1, payload = new Uint8Array(0)) {
    const pkt = new Uint8Array(24 + payload.length);
    const dv = new DataView(pkt.buffer);
    let sum = 0;
    for (const b of payload) sum = u32(sum + b);
    dv.setUint32(0, cmd, true);
    dv.setUint32(4, u32(arg0), true);
    dv.setUint32(8, u32(arg1), true);
    dv.setUint32(12, payload.length, true);
    dv.setUint32(16, sum, true);
    dv.setUint32(20, u32(cmd ^ 0xffffffff), true);
    pkt.set(payload, 24);
    // Header and payload go in one bulk transfer; the device tolerates both
    // forms, and one transfer avoids a partial write wedging the stream.
    await this.withTimeout(this.device.transferOut(this.iface.epOut, pkt), `write ${CMD_NAMES[cmd] ?? cmd}`);
  }

  async readExact(n) {
    while (this.pending.length < n) {
      const chunk = asBytes(await this.withTimeout(
        this.device.transferIn(this.iface.epIn, Math.max(n - this.pending.length, 512)),
        'read'
      ));
      if (!chunk.length) continue;
      const merged = new Uint8Array(this.pending.length + chunk.length);
      merged.set(this.pending, 0);
      merged.set(chunk, this.pending.length);
      this.pending = merged;
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  async readMessage() {
    const head = await this.readExact(24);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const cmd = dv.getUint32(0, true);
    const arg0 = dv.getUint32(4, true);
    const arg1 = dv.getUint32(8, true);
    const length = dv.getUint32(12, true);
    const magic = dv.getUint32(20, true);
    if (magic !== u32(cmd ^ 0xffffffff)) {
      throw new Error(`corrupt ADB header (cmd=0x${cmd.toString(16)} magic=0x${magic.toString(16)})`);
    }
    const data = length ? await this.readExact(length) : new Uint8Array(0);
    return { cmd, arg0, arg1, data, name: CMD_NAMES[cmd] ?? `0x${cmd.toString(16)}` };
  }
}

// ── ADB session ───────────────────────────────────────────────────────
function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** CNXN + AUTH handshake. Resolves the device banner. */
async function handshake(transport, key) {
  await transport.writeMessage(
    A_CNXN, A_VERSION, MAX_PAYLOAD,
    enc.encode('host::features=shell_v2,cmd,exec\0')
  );
  let attempts = 0;
  const MAX_AUTH_ATTEMPTS = 3;
  for (;;) {
    const msg = await transport.readMessage();
    if (msg.cmd === A_CNXN) {
      if (msg.arg1) transport.maxPayload = msg.arg1;
      return dec.decode(msg.data).replace(/\0+$/, '');
    }
    if (msg.cmd === A_AUTH && msg.arg0 === AUTH_TOKEN) {
      if (++attempts > MAX_AUTH_ATTEMPTS) {
        throw new Error(
          'device rejected the signature — this key is not authorized.\n' +
          "  Point --key at a key the device already trusts (the host's\n" +
          '  ~/.android/adbkey is the usual one). Enrolling a NEW key is not\n' +
          '  supported yet: that needs the AUTH RSAPUBLICKEY frame, which this\n' +
          '  client does not send, so no on-device approval prompt will appear\n' +
          '  no matter how many times you retry.'
        );
      }
      await transport.writeMessage(A_AUTH, AUTH_SIGNATURE, 0, signToken(msg.data, key));
      continue;
    }
    // A previous session that died mid-stream leaves WRTE/OKAY/CLSE queued on
    // the pipe. They belong to a dead stream id — drain them rather than
    // failing the handshake. (Observed live after an aborted `adb shell`.)
    if (msg.cmd === A_WRTE) { await transport.writeMessage(A_OKAY, msg.arg1 || 1, msg.arg0); continue; }
    if (msg.cmd === A_OKAY) continue;
    if (msg.cmd === A_CLSE) { await transport.writeMessage(A_CLSE, msg.arg1 || 1, msg.arg0); continue; }
    throw new Error(`unexpected ${msg.name} during connect`);
  }
}

const SHELL_V2_STDOUT = 1;
const SHELL_V2_STDERR = 2;
const SHELL_V2_EXIT = 3;

/**
 * Decode the shell-v2 frame stream: `[id:1][length:4 LE][payload]`, repeated.
 * The exit frame is what the legacy `shell:`/`exec:` services cannot give us,
 * so this is the only way to learn whether a device-side command failed.
 */
function parseShellV2(bytes) {
  const out = [];
  const err = [];
  let exitCode = null;
  let i = 0;
  while (i + 5 <= bytes.length) {
    const id = bytes[i];
    const view = new DataView(bytes.buffer, bytes.byteOffset + i + 1, 4);
    const length = view.getUint32(0, true);
    if (i + 5 + length > bytes.length) break; // truncated tail — stop cleanly
    const payload = bytes.subarray(i + 5, i + 5 + length);
    if (id === SHELL_V2_STDOUT) out.push(payload);
    else if (id === SHELL_V2_STDERR) err.push(payload);
    else if (id === SHELL_V2_EXIT && length > 0) exitCode = payload[0];
    i += 5 + length;
  }
  return { stdout: concat(out), stderr: concat(err), exitCode };
}

/**
 * Run a device-side command. Uses the shell-v2 protocol when the device
 * advertises it, which separates stdout/stderr and carries a real exit status;
 * `raw` means no pty, so binary output survives. Falls back to `exec:` on
 * devices that predate shell-v2, where the exit status is simply unknowable.
 */
async function runCommand(transport, features, command) {
  if (features.has('shell_v2')) {
    return parseShellV2(await runService(transport, `shell,v2,raw:${command}`));
  }
  const stdout = await runService(transport, `exec:${command}`);
  return { stdout, stderr: new Uint8Array(0), exitCode: null };
}

/** Open a service stream, drain it to completion, return the raw bytes. */
async function runService(transport, service) {
  const localId = 1;
  await transport.writeMessage(A_OPEN, localId, 0, enc.encode(service + '\0'));
  const chunks = [];
  let remoteId = 0;
  for (;;) {
    const msg = await transport.readMessage();
    // arg1 is our local id; frames for a stale stream are not ours.
    if (msg.arg1 && msg.arg1 !== localId) {
      if (msg.cmd === A_WRTE) await transport.writeMessage(A_OKAY, msg.arg1, msg.arg0);
      if (msg.cmd === A_CLSE) await transport.writeMessage(A_CLSE, msg.arg1, msg.arg0);
      continue;
    }
    if (msg.cmd === A_CLSE) {
      if (!remoteId) throw new Error(`device refused service "${service}"`);
      await transport.writeMessage(A_CLSE, localId, msg.arg0);
      break;
    }
    if (msg.cmd === A_OKAY) { remoteId ||= msg.arg0; continue; }
    if (msg.cmd === A_WRTE) {
      chunks.push(msg.data);
      // Every WRTE must be acknowledged or the device stops sending.
      await transport.writeMessage(A_OKAY, localId, msg.arg0);
      continue;
    }
    throw new Error(`unexpected ${msg.name} on stream "${service}"`);
  }
  return concat(chunks);
}

// ── device + key resolution ───────────────────────────────────────────
async function listAdbDevices() {
  const out = [];
  for (const device of await usb.list()) {
    let iface = null;
    try {
      await device.open();
      iface = parseAdbInterface(await readConfigDescriptor(device));
    } catch {
      iface = null;              // busy (host adb server) or not an ADB device
    } finally {
      try { await device.close(); } catch { /* ignore */ }
    }
    out.push({ device, iface });
  }
  return out;
}

async function pickDevice(flags) {
  const found = (await listAdbDevices()).filter((d) => d.iface);
  if (!found.length) {
    cli.die(
      'no granted USB device exposes an ADB interface.\n' +
      "  Grant one with `usb request` (needs a real click), and check the phone's\n" +
      '  USB mode is File transfer with USB debugging enabled.',
      { prefix: 'adb' }
    );
  }
  if (!flags.serial) return found[0];
  const hit = found.find((d) => d.device.serialNumber === flags.serial);
  if (!hit) cli.die(`no ADB device with serial ${flags.serial}`, { prefix: 'adb' });
  return hit;
}

async function loadKey(flags) {
  const configured = (await skill.config()) || {};
  const path = flags.key || configured.keyPath || '/workspace/.adb/adbkey';
  if (!(await fs.exists(path))) {
    cli.die(
      `no private key at ${path}\n` +
      "  Copy the host's ~/.android/adbkey there to inherit its authorization,\n" +
      '  or point at another PKCS#8 key with --key <path>.',
      { prefix: 'adb' }
    );
  }
  try {
    return parseRsaPrivateKey(pemToDer(await fs.readFile(path)));
  } catch (err) {
    cli.die(`could not parse ${path} as a PKCS#8 RSA private key: ${err.message}`, { prefix: 'adb' });
  }
}

/** Connect, run `fn`, always release the interface. */
async function withDevice(flags, fn) {
  const { device } = await pickDevice(flags);
  const key = await loadKey(flags);
  const timeoutMs = Number.isFinite(parseInt(flags.timeout, 10)) ? parseInt(flags.timeout, 10) : 10000;
  const transport = new AdbTransport(device, timeoutMs, { reset: !flags['no-reset'] });
  try {
    await transport.open();
  } catch (err) {
    await transport.close();
    cli.die(
      `could not claim the ADB interface: ${err.message}\n` +
      '  Another ADB client may hold it — stop it (`adb kill-server`) and retry.',
      { prefix: 'adb' }
    );
  }
  try {
    const banner = await handshake(transport, key);
    const { props } = parseBanner(banner);
    const features = new Set((props.features ?? '').split(',').filter(Boolean));
    return await fn(transport, { banner, device, features });
  } finally {
    await transport.close();
  }
}

// ── commands ──────────────────────────────────────────────────────────
function parseBanner(banner) {
  // "device::ro.product.name=x;ro.product.model=y;...;features=..."
  const [type, , rest = ''] = banner.split(':');
  const props = {};
  for (const kv of rest.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) props[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return { type, props };
}

async function cmdDevices(flags) {
  const all = await listAdbDevices();
  // A granted-but-not-ADB device (or one whose interface is busy) has no
  // descriptor; keep it out rather than dereferencing a null below.
  const found = all.filter((d) => d.iface);
  const skipped = all.length - found.length;
  if (flags.json) {
    cli.out(found.map(({ device, iface }) => ({
      serial: device.serialNumber,
      product: device.productName,
      manufacturer: device.manufacturerName,
      vendorId: device.vendorId,
      productId: device.productId,
      handle: device.handle,
      interface: iface.interfaceNumber,
    })));
    return;
  }
  if (!found.length) {
    console.log(color.dim('  No ADB-capable USB devices granted.'));
    if (skipped) {
      console.log(color.dim(`  (${skipped} granted USB device(s) exposed no ADB interface — busy, or not an Android device.)`));
    }
    return;
  }
  console.log();
  for (const { device, iface } of found) {
    console.log(
      `  ${color.cyan(color.bold(device.productName || 'device'))}  ` +
      `${color.dim(`serial:${device.serialNumber}`)}  ` +
      `${color.dim(`handle:${device.handle}`)}  ${color.dim(`iface:${iface.interfaceNumber}`)}`
    );
  }
  if (skipped) {
    console.log(color.dim(`  (${skipped} other granted USB device(s) exposed no ADB interface.)`));
  }
}

async function cmdConnect(flags) {
  const out = await withDevice(flags, async (_t, { banner, device }) => ({ banner, device }));
  const { type, props } = parseBanner(out.banner);
  if (flags.json) { cli.out({ serial: out.device.serialNumber, state: type, banner: out.banner, properties: props }); return; }
  console.log();
  console.log(`  ${color.green('✓')} connected to ${color.cyan(color.bold(props['ro.product.model'] || out.device.productName || 'device'))}`);
  console.log(`  ${color.dim(`serial:${out.device.serialNumber}`)}  ${color.dim(`state:${type}`)}`);
  for (const k of ['ro.product.name', 'ro.product.device']) {
    if (props[k]) console.log(`  ${color.dim(`${k}=${props[k]}`)}`);
  }
}

async function cmdShell(flags, argv) {
  const command = argv.join(' ').trim();
  if (!command) cli.die('usage: adb shell <command...>', { prefix: 'adb' });
  const r = await withDevice(flags, (t, { features }) => runCommand(t, features, command));
  const stdout = dec.decode(r.stdout);
  const stderr = dec.decode(r.stderr);
  if (flags.json) {
    cli.out({ command, stdout, stderr, exitCode: r.exitCode });
  } else {
    if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n');
    if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : stderr + '\n');
  }
  // Propagate the device-side status; a failing remote command must not look
  // like success. Unknown (pre-shell-v2 devices) stays 0.
  if (r.exitCode) process.exit(r.exitCode);
}

async function cmdScreencap(flags, positional) {
  const out = positional[0];
  if (!out) cli.die('usage: adb screencap <out.png>', { prefix: 'adb' });
  // Raw mode (no pty) so PNG bytes survive unmangled.
  const r = await withDevice(flags, (t, { features }) => runCommand(t, features, 'screencap -p'));
  if (r.exitCode) {
    const detail = dec.decode(r.stderr).trim() || `exit ${r.exitCode}`;
    cli.die(`screencap failed on the device: ${detail}`, { prefix: 'adb' });
  }
  const bytes = r.stdout;
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    cli.die(`device did not return a PNG (${bytes.length} bytes)`, { prefix: 'adb' });
  }
  await fs.writeFileBinary(out, bytes);
  if (flags.json) { cli.out({ path: out, bytes: bytes.length }); return; }
  console.log(`  ${color.green('✓')} wrote ${color.cyan(out)} ${color.dim(`(${bytes.length} bytes)`)}`);
}

async function cmdPull(flags, positional) {
  const [remote, local] = positional;
  if (!remote || !local) cli.die('usage: adb pull <remote> <local>', { prefix: 'adb' });
  // `cat` over shell-v2 rather than the sync: protocol — binary-safe, and the
  // exit frame is what makes a missing/unreadable path detectable. Without it
  // a failed read would be written to `local`, silently clobbering a good file.
  const r = await withDevice(flags, async (t, { features }) => {
    if (!features.has('shell_v2')) {
      cli.die(
        'this device does not advertise shell_v2, so a failed read cannot be\n' +
        '  distinguished from a successful one — refusing to risk overwriting\n' +
        `  ${local}. Use \`adb shell cat ...\` and redirect if you accept that.`,
        { prefix: 'adb' }
      );
    }
    return runCommand(t, features, `cat ${shellQuote(remote)}`);
  });
  if (r.exitCode) {
    const detail = dec.decode(r.stderr).trim() || `exit ${r.exitCode}`;
    cli.die(`could not read ${remote} on the device: ${detail}`, { prefix: 'adb' });
  }
  const bytes = r.stdout;
  await fs.writeFileBinary(local, bytes);
  if (flags.json) { cli.out({ remote, local, bytes: bytes.length }); return; }
  console.log(`  ${color.green('✓')} pulled ${color.cyan(remote)} → ${color.cyan(local)} ${color.dim(`(${bytes.length} bytes)`)}`);
}

/** Single-quote for the device's shell; the payload crosses a real sh. */
function shellQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

// ── main ──────────────────────────────────────────────────────────────
// `process.argv.parseFlags()` is the house helper, but it cannot express this
// grammar: everything after the subcommand is an opaque device-side command.
// It consumes long options wherever they appear, so `adb shell pm list
// packages --user 10` would reach the device as `pm list packages`, and
// `adb --json shell ls` would parse `shell` as --json's value. So the
// invocation is split explicitly here: our flags first, then the subcommand,
// then an untouched tail.
const BOOLEAN_FLAGS = new Set(['json', 'no-reset', 'help']);
const VALUE_FLAGS = new Set(['serial', 'key', 'timeout']);

function parseInvocation(argv) {
  const flags = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h') {
      flags.h = true;
      continue;
    }
    if (!token.startsWith('--')) break; // the subcommand
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const name = token.slice(2);
    if (VALUE_FLAGS.has(name)) {
      flags[name] = argv[++i];
      continue;
    }
    if (!BOOLEAN_FLAGS.has(name)) {
      cli.die(`unknown flag --${name}\nRun 'adb --help' for usage.`, { prefix: 'adb' });
    }
    flags[name] = true;
  }
  return { flags, subcommand: argv[i] ?? '', tail: argv.slice(i + 1) };
}

const { flags, subcommand, tail: rawTail } = parseInvocation(process.argv.slice(2));

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  try {
    if (subcommand === 'devices') await cmdDevices(flags);
    else if (subcommand === 'connect') await cmdConnect(flags);
    else if (subcommand === 'shell') await cmdShell(flags, rawTail);
    else if (subcommand === 'screencap') await cmdScreencap(flags, rawTail);
    else if (subcommand === 'pull') await cmdPull(flags, rawTail);
    else cli.die(`unknown command: ${subcommand}\nRun 'adb --help' for usage.`, { prefix: 'adb' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: 'adb' });
  }
}

await main();
