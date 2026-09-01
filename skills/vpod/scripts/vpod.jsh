// vpod.jsh — real Linux (RISC-V/WASM) sandboxes inside SLICC.
//
// The whole engine is an ipk-installed `@capsule-run/vpod` in the VFS
// node_modules — nothing is bundled here and there is no CDN fallback.
// See references/wasm-in-slicc.md for why the SDK loads the way it does
// and references/snapshots.md for snapshot sourcing/creation.

const fs = require('fs');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const exec = require('sliccy:exec');
const fmt = require('sliccy:fmt');

const TOOL = 'vpod';
const PACKAGE = '@capsule-run/vpod';
const PINNED_VERSION = '0.8.1';
const PKG_DIR = '/workspace/node_modules/@capsule-run/vpod';

const STATE_DIR = '/workspace/.vpod';
const SESSION_DIR = `${STATE_DIR}/sessions`;
const SNAPSHOT_DIR = `${STATE_DIR}/snapshots`;
// A lock is held for as long as the operation it guards could legitimately run
// (boot + the guest's own timeout + suspend, plus slack), never a flat window --
// a 3600s guest command must not have its lock judged stale at 15 minutes and
// stolen by a second invocation that then suspends over the same delta.
const LOCK_SLACK_MS = 60 * 1000;
const BOOT_DEADLINE_MS = 5 * 60 * 1000;
const SUSPEND_DEADLINE_MS = 60 * 1000;
// Host-side grace on top of the guest's own --timeout, so a guest that stops
// answering surfaces as an error instead of an infinite spin.
const RUN_GRACE_MS = 30 * 1000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 3600;
const NAME_RE = /^[A-Za-z0-9._-]+$/;
// The tray exec wire caps one message at 8 MiB (TRAY_MAX_MESSAGE_BYTES), and
// base64 inflates by 4/3, so 3 MiB of payload per `ssh` round trip stays clear.
const REMOTE_CHUNK_BYTES = 3 * 1024 * 1024;

const NOT_INSTALLED =
  `${PACKAGE} is not installed — run \`${TOOL} install\`` +
  ` (equivalent: ipk add ${PACKAGE}@${PINNED_VERSION}, ~30 MB into the VFS node_modules)`;

const HELP = `
vpod — a real Linux guest (RISC-V, Alpine) running as WebAssembly in SLICC

USAGE
  vpod run [-n NAME] [-s SNAP] [-t SECS] [--fresh] [--no-network]
           [--cors-proxy URL] <command...>
  vpod python [-n NAME] [-t SECS] <code>
  vpod put <vfs-src> <guest-dst> [-n NAME]
  vpod get <guest-src> <vfs-dst> [-n NAME]
  vpod ls [--json]
  vpod rm <NAME|--all>
  vpod snapshots [--json]
  vpod pull <SNAPSHOT>
  vpod import <NAME> <vfs-path|url>
  vpod remote <target> check
  vpod remote <target> build -f <Dockerfile> -n <NAME> [--ram MB] [--repo DIR] [-t SECS]
  vpod remote <target> pull <remote-path> <NAME>
  vpod info [--json]
  vpod clean [--snapshots] [--sessions]
  vpod install [--fresh]
  vpod --help

SESSIONS
  Every command runs against a named session (default: "default"). A session is
  a suspended machine — filesystem, processes and shell environment — kept as a
  delta file under ${STATE_DIR}/sessions. Each invocation resumes it, runs, and
  suspends it back, so state survives between calls and between agent turns:

    vpod run 'export TOKEN=abc'
    vpod run 'echo $TOKEN'          # -> abc

  First run downloads the snapshot (~59 MB, ~15 s). After that a resume costs
  about 0.4 s and a command a few hundred ms. --fresh discards the session and
  boots from the snapshot again.

NETWORK
  Guest networking rides SharedArrayBuffer, so it needs a cross-origin-isolated
  leader (Document-Isolation-Policy). Where that holds, outbound HTTP works
  through the browser's fetch: port 80/443 only, no raw TCP, no UDP, and normal
  CORS rules -- so a host that sends no Access-Control-Allow-Origin (Alpine's
  CDN, PyPI file downloads) needs --cors-proxy. \`vpod info\` reports what this
  instance can actually do.

SNAPSHOTS
  \`vpod snapshots\` lists the public registry, the OPFS cache and any local
  .snap files under ${SNAPSHOT_DIR}. \`vpod import\` lands a .snap built
  elsewhere; \`vpod run -s <NAME>\` boots it. Building one needs Docker/riscv64,
  Zig and a Rust toolchain — none of which exist in the browser — so \`vpod
  remote\` drives the build on a connected \`slicc … follow\` machine over ssh
  and pulls the artifact back. See references/snapshots.md.

FLAGS
  -n, --name <NAME>      Session name (run/python/put/get) — default "default"
  -s, --snapshot <SNAP>  Snapshot id, or a name registered with \`vpod import\`
  -t, --timeout <SECS>   Guest command timeout — default 120
      --fresh            (run/python) discard the session and boot from the snapshot;
                         (install) reinstall even when the package is present
      --no-network       Boot the guest with networking off
      --cors-proxy <URL> Relay for hosts that send no CORS headers, as
                         <URL>/<full-target-url>. Needed for apk/pip installs.
      --json             Machine-readable output
      --all              (rm) delete every session
      --snapshots        (clean) drop the downloaded snapshot cache + local .snap files
      --sessions         (clean) drop every saved session

EXAMPLES
  vpod install
  vpod run uname -a
  vpod run python3 -c "print(6*7)"
  vpod run --cors-proxy https://my-relay.example 'apk add --no-cache jq'
  vpod python 'data = [1, 2, 3]'
  vpod python 'print(sum(data))'
  vpod put /workspace/report.csv /root/report.csv
  vpod run 'python3 -c "import csv; print(len(open(\\"/root/report.csv\\").readlines()))"'
  vpod get /root/out.json /workspace/out.json
  vpod ls
  vpod snapshots
  vpod remote follower-abc123 check
`.trim();

// ── argv ──────────────────────────────────────────────────────────────
// Hand-rolled instead of process.argv.parseFlags(): everything after the
// first bare word of `run`/`python` belongs to the GUEST, and a shared
// parser would eat `-c` out of `python3 -c ...` (the bug PR #2029 hit live).
const ARG_FLAGS = new Set(['-n', '--name', '-s', '--snapshot', '-t', '--timeout', '-f', '--file',
  '--ram', '--repo', '--cors-proxy']);
const BOOL_FLAGS = new Set(['--fresh', '--no-network', '--json', '--all', '--snapshots',
  '--sessions', '--help', '-h']);

function parseArgs(argv, { stopAtBareWord = false } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (stopAtBareWord && positional.length > 0) {
      positional.push(...argv.slice(i));
      break;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      // Validate the --key=value form too, or `--timeot=10` is silently dropped
      // and the command runs with a default the user did not ask for.
      const key = arg.slice(0, eq);
      if (!ARG_FLAGS.has(key)) {
        cli.die(
          BOOL_FLAGS.has(key)
            ? `${key} takes no value\nRun '${TOOL} --help' for usage.`
            : `unknown flag: ${key}\nRun '${TOOL} --help' for usage.`,
          { prefix: TOOL }
        );
      }
      flags[key.slice(2)] = arg.slice(eq + 1);
    } else if (ARG_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) cli.die(`${arg} needs a value`, { prefix: TOOL });
      flags[arg.replace(/^-+/, '')] = value;
      i++;
    } else if (BOOL_FLAGS.has(arg)) {
      flags[arg.replace(/^-+/, '')] = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      cli.die(`unknown flag: ${arg}\nRun '${TOOL} --help' for usage.`, { prefix: TOOL });
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/** POSIX single-quote a token so the guest /bin/sh sees it verbatim. */
function shQuote(token) {
  return `'${String(token).replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a path destined for a REMOTE shell, keeping a leading ~ expandable.
 * shQuote alone turns the default ~/vpod into cd '~/vpod', and POSIX shells do
 * not expand a tilde inside single quotes -- so the documented remote build
 * failed unless a directory literally named "~" existed. The remainder stays
 * single-quoted, so this buys expansion without giving up injection safety.
 */
function shQuotePath(path) {
  const value = String(path);
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) return `"$HOME"/${shQuote(value.slice(2))}`;
  return shQuote(value);
}

/**
 * Rejoin argv into one guest command line. A single argument is passed
 * through untouched so `vpod run 'a && b'` keeps its shell operators;
 * multiple arguments are re-quoted, because the HOST shell already ate the
 * user's quotes and `python3 -c print(6*7)` is a guest syntax error.
 */
function guestCommand(words) {
  return words.length === 1 ? words[0] : words.map(shQuote).join(' ');
}

function requireName(name, what) {
  if (!name || !NAME_RE.test(name)) {
    cli.die(`invalid ${what}: ${JSON.stringify(name)} — use letters, digits, dot, dash, underscore`,
      { prefix: TOOL });
  }
  return name;
}

// ── SDK loader ────────────────────────────────────────────────────────
// The vpod SDK MUST load as real ESM: it imports sibling chunks by relative
// URL, spawns `new Worker(url, { type: 'module' })`, and its jco-transpiled
// component fetches a 27 MB core wasm relative to its own import.meta.url.
// Two consequences:
//
//   1. It cannot be require()d. The realm's entry transpiler lowers a literal
//      dynamic-import call in a .jsh to require (ipk/resolver.ts,
//      hasDynamicImport), so the call is built with new Function instead --
//      the specifier then lives in a string, which the detector masks out,
//      and the entry passes through untranspiled.
//   2. It cannot be wrapped in a blob URL either: blob URLs are not
//      hierarchical, so the SDK's relative chunk imports have nothing to
//      resolve against. Instead it is imported through the preview service
//      worker, which serves VFS bytes at real same-origin hierarchical URLs.
//      The realm worker is same-origin with the leader and SW-controlled, so
//      relative imports, worker spawning and the wasm fetch all resolve
//      natively from here.
//
// Note: the detector blanks // comments before scanning, but a backticked span
// inside one survives as live source. Never write import(, export or
// import.meta inside backticks in a comment -- that is how this file first
// tripped the CJS lowering it exists to avoid. Backticks are otherwise fine.
// See references/wasm-in-slicc.md for the one-line way to verify a script.
const importEsm = new Function('url', 'return import(url);');

const previewUrl = (vfsPath) => `${globalThis.location.origin}/preview${vfsPath}`;

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = doLoadSdk().catch((err) => { sdkPromise = null; throw err; });
  return sdkPromise;
}

async function doLoadSdk() {
  if (!(await fs.exists(`${PKG_DIR}/dist/index.js`))) cli.die(NOT_INSTALLED, { prefix: TOOL });
  const sdk = await importEsm(previewUrl(`${PKG_DIR}/dist/index.js`));
  if (typeof sdk?.Sandbox?.create !== 'function') {
    cli.die(`installed ${PACKAGE} does not export Sandbox.create() — reinstall with \`${TOOL} install\``,
      { prefix: TOOL });
  }
  return sdk;
}

/**
 * Installed version, or null. Gated on dist/index.js -- the same file the
 * loader imports -- so `vpod info` can never report "installed" for a package
 * whose entry is missing and then die when a command tries to load it.
 */
async function installedVersion() {
  try {
    if (!(await fs.exists(`${PKG_DIR}/dist/index.js`))) return null;
    return String(JSON.parse(await fs.readFile(`${PKG_DIR}/package.json`)).version || 'unknown');
  } catch { return null; }
}

// ── session store ─────────────────────────────────────────────────────
const metaPath = (name) => `${SESSION_DIR}/${name}.json`;
const deltaPath = (name) => `${SESSION_DIR}/${name}.delta`;
const lockPath = (name) => `${SESSION_DIR}/${name}.lock`;

async function readJson(path) {
  try { return JSON.parse(await fs.readFile(path)); } catch { return null; }
}

async function listSessions() {
  if (!(await fs.exists(SESSION_DIR))) return [];
  const names = (await fs.readDir(SESSION_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  const out = [];
  for (const name of names) {
    const meta = await readJson(metaPath(name));
    if (!meta) continue;
    let size = 0;
    try { size = (await fs.stat(deltaPath(name))).size || 0; } catch { /* delta gone */ }
    out.push({ ...meta, name, deltaBytes: size, locked: await isLocked(name) });
  }
  return out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

async function isLocked(name) {
  const lock = await readJson(lockPath(name));
  if (!lock) return false;
  const expiresAt = Number(lock.expiresAt) || (Number(lock.at) || 0) + LOCK_SLACK_MS;
  return Date.now() < expiresAt;
}

/**
 * Advisory lock. Two concurrent runs against one session would each resume the
 * same delta and race to overwrite it, silently losing one side's work.
 * `holdMs` is the caller's own worst-case runtime; the token lets the holder
 * release only its OWN lock, so a run that outlives its expiry can never delete
 * the lock of whoever legitimately took over.
 */
async function acquireLock(name, holdMs) {
  if (await isLocked(name)) {
    cli.die(
      `session '${name}' is busy — another vpod command is using it.\n` +
      `If that command died, clear it with: rm ${lockPath(name)}`,
      { prefix: TOOL }
    );
  }
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await fs.mkdir(SESSION_DIR, { recursive: true });
  await fs.writeFile(lockPath(name), JSON.stringify({
    at: Date.now(), expiresAt: Date.now() + holdMs, token,
  }));
  return token;
}

async function releaseLock(name, token) {
  try {
    const lock = await readJson(lockPath(name));
    if (lock && token && lock.token !== token) return; // someone else's lock now
    await fs.rm(lockPath(name));
  } catch { /* best effort */ }
}

/**
 * Resume the named session, or boot a fresh one. Sandbox.resume() consumes an
 * OPFS instance record, so sessions are kept as delta BYTES in the VFS instead
 * and resumed from an object — the stored delta stays valid until a clean
 * suspend replaces it, so a crashed run loses the run, never the session.
 */
async function openSession(sdk, name, flags) {
  const snapshot = flags.snapshot || flags.s;
  const options = {};
  if (flags['no-network']) options.network = false;
  // The guest's HTTP runs on the browser's own fetch in a worker the SDK spawns
  // -- NOT SLICC's CORS-bypassing bridged fetch -- so a host that sends no
  // Access-Control-Allow-Origin (Alpine's CDN, PyPI files) is unreachable
  // without a relay. --cors-proxy is the SDK's escape hatch: it retries such a
  // host as <proxy>/<full-url>.
  if (flags['cors-proxy']) {
    const proxy = String(flags['cors-proxy']);
    if (!/^https?:\/\//.test(proxy)) {
      cli.die(`--cors-proxy must be an http(s) URL, got ${JSON.stringify(proxy)}`, { prefix: TOOL });
    }
    options.corsProxy = proxy;
  }

  const meta = flags.fresh ? null : await readJson(metaPath(name));
  if (meta?.wedgedAt) {
    cli.die(
      `session '${name}' stopped responding at ${new Date(meta.wedgedAt).toISOString()} ` +
      `(${meta.wedgedReason || 'no detail'}).\n${WEDGED_HINT(name)}`,
      { prefix: TOOL }
    );
  }
  if (meta && (await fs.exists(deltaPath(name)))) {
    if (snapshot && snapshot !== meta.snapshotId) {
      cli.die(
        `session '${name}' was created from snapshot '${meta.snapshotId}', not '${snapshot}'.\n` +
        `Use a different -n NAME, or start over with: ${TOOL} run -n ${name} --fresh -s ${snapshot} <cmd>`,
        { prefix: TOOL }
      );
    }
    const delta = await fs.readFileBinary(deltaPath(name));
    const sandbox = await sdk.Sandbox.resume({ id: name, snapshotId: meta.snapshotId, delta }, options);
    return { sandbox, resumed: true, snapshotId: meta.snapshotId };
  }

  const resolved = snapshot ? await resolveSnapshot(snapshot) : undefined;
  if (resolved) options.snapshot = resolved.source;
  const sandbox = await sdk.Sandbox.create(options);
  return { sandbox, resumed: false, snapshotId: sandbox.snapshotId };
}

async function markWedged(name, reason) {
  const meta = (await readJson(metaPath(name))) || { name };
  meta.wedgedAt = Date.now();
  meta.wedgedReason = reason;
  try { await fs.writeFile(metaPath(name), JSON.stringify(meta, null, 2)); } catch { /* best effort */ }
}

async function saveSession(sandbox, name, snapshotId) {
  const delta = await sandbox.suspend();
  await fs.mkdir(SESSION_DIR, { recursive: true });
  // Write the bytes before the manifest: a torn write leaves the OLD manifest
  // pointing at a NEW delta of the same snapshot, which still resumes.
  await fs.writeFileBinary(deltaPath(name), delta);
  await fs.writeFile(metaPath(name), JSON.stringify({
    name, snapshotId, savedAt: Date.now(), deltaBytes: delta.byteLength,
  }, null, 2));
  return delta.byteLength;
}

/**
 * Run `fn` against a locked session and suspend it back on success.
 * `guestTimeoutMs` is the deadline `fn` itself will apply, so the lock outlives
 * the work it guards.
 */
async function withSession(name, flags, fn, guestTimeoutMs = DEFAULT_TIMEOUT_S * 1000 + RUN_GRACE_MS) {
  requireName(name, 'session name');
  // Load the SDK BEFORE taking the lock: it touches no session state, and a
  // failure here (the not-installed gate) must not leave a lock behind that
  // blocks the session until the lock expires.
  const sdk = await loadSdk();
  const holdMs = BOOT_DEADLINE_MS + guestTimeoutMs + SUSPEND_DEADLINE_MS + LOCK_SLACK_MS;
  const token = await acquireLock(name, holdMs);
  let sandbox = null;
  try {
    let opened;
    try {
      // A cold boot downloads a ~59 MB snapshot; a warm resume is sub-second.
      opened = await withDeadline(openSession(sdk, name, flags), BOOT_DEADLINE_MS, 'boot');
    } catch (err) {
      // A boot that runs long is a slow or failing download, NOT a dead guest
      // shell -- do not mark the session wedged and send the user to --fresh
      // for something that is not broken.
      if (err instanceof DeadlineError) {
        cli.die(`${err.message} for session '${name}'.\n` +
          `Check the connection and the registry, then retry; ${TOOL} pull <SNAPSHOT> ` +
          `downloads on its own so you can see it make progress.`, { prefix: TOOL });
      }
      throw err;
    }
    sandbox = opened.sandbox;
    try {
      const result = await fn(sandbox, opened);
      await withDeadline(saveSession(sandbox, name, opened.snapshotId), SUSPEND_DEADLINE_MS, 'suspend');
      return result;
    } catch (err) {
      if (err instanceof DeadlineError) {
        // The guest stopped answering after it was already up. Record it so the
        // NEXT call fails in milliseconds instead of burning another full
        // deadline against the same dead shell.
        await markWedged(name, err.message);
        cli.die(`${err.message} for session '${name}'.\n${WEDGED_HINT(name)}`, { prefix: TOOL });
      }
      throw err;
    }
  } finally {
    if (sandbox) await closeQuietly(sandbox);
    await releaseLock(name, token);
  }
}

// ── snapshots ─────────────────────────────────────────────────────────
const localSnapPath = (name) => `${SNAPSHOT_DIR}/${name}.snap`;

async function listLocalSnapshots() {
  if (!(await fs.exists(SNAPSHOT_DIR))) return [];
  const out = [];
  for (const file of await fs.readDir(SNAPSHOT_DIR)) {
    if (!file.endsWith('.snap')) continue;
    let size = 0;
    try { size = (await fs.stat(`${SNAPSHOT_DIR}/${file}`)).size || 0; } catch { /* raced */ }
    out.push({ name: file.slice(0, -5), path: `${SNAPSHOT_DIR}/${file}`, bytes: size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A -s value is either a locally imported .snap or a registry id/tag. Local
 * wins, so an imported snapshot shadows a same-named registry entry rather
 * than silently downloading something else.
 */
async function resolveSnapshot(spec) {
  requireName(spec, 'snapshot name');
  if (await fs.exists(localSnapPath(spec))) {
    const bytes = await fs.readFileBinary(localSnapPath(spec));
    return { source: { bytes, name: spec }, origin: 'local' };
  }
  return { source: spec, origin: 'registry' };
}

// ── guest file transfer ───────────────────────────────────────────────
// Bytes cross as base64 over the guest's stdin/stdout rather than as argv:
// argv caps out around 1 MB, and a base64 payload on the command line would
// also have to survive the guest shell's own parsing.
const B64_CHUNK = 0x8000;

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── commands ──────────────────────────────────────────────────────────
async function cmdInstall(flags) {
  const existing = await installedVersion();
  // Only an EXACT match short-circuits. Every API this skill drives was verified
  // against the pinned build, so silently accepting some other installed version
  // would hand the user a runtime the rest of the script does not know.
  if (existing === PINNED_VERSION && !flags.fresh) {
    console.log(`  ${color.green('✓')} ${PACKAGE}@${existing} already installed`);
    return;
  }
  if (existing) {
    console.log(color.yellow(`  ${PACKAGE}@${existing} is installed; this skill is pinned to ${PINNED_VERSION} — replacing it.`));
  }
  console.log(color.dim(`  Installing ${PACKAGE}@${PINNED_VERSION} (~30 MB) …`));
  const res = await exec.spawn(['ipk', 'add', `${PACKAGE}@${PINNED_VERSION}`]);
  if (res.exitCode !== 0) {
    cli.die(`ipk add failed (exit ${res.exitCode})\n${res.stderr || res.stdout}`, { prefix: TOOL });
  }
  console.log(`  ${color.green('✓')} ${(res.stdout || '').trim() || 'installed'}`);
}

async function cmdRun(argv) {
  const { flags, positional } = parseArgs(argv, { stopAtBareWord: true });
  if (!positional.length) cli.die(`usage: ${TOOL} run [-n NAME] <command...>`, { prefix: TOOL });
  const name = flags.name || flags.n || 'default';
  const timeout = clampTimeout(flags.timeout || flags.t);
  const command = guestCommand(positional);

  const started = Date.now();
  const outcome = await withSession(name, flags, async (sandbox, opened) => {
    const result = await withDeadline(
      sandbox.commands.run(command, { timeout }), timeout * 1000 + RUN_GRACE_MS, 'the guest command'
    );
    return { result, opened };
  }, timeout * 1000 + RUN_GRACE_MS);
  const { result, opened } = outcome;

  if (flags.json) {
    cli.out({
      session: name,
      snapshot: opened.snapshotId,
      resumed: opened.resumed,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      elapsedMs: Date.now() - started,
    });
  } else {
    if (result.stdout) process.stdout.write(endWithNewline(result.stdout));
    if (result.stderr) process.stderr.write(endWithNewline(result.stderr));
  }
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

async function cmdPython(argv) {
  const { flags, positional } = parseArgs(argv, { stopAtBareWord: true });
  if (!positional.length) cli.die(`usage: ${TOOL} python [-n NAME] <code>`, { prefix: TOOL });
  const name = flags.name || flags.n || 'default';
  const timeout = clampTimeout(flags.timeout || flags.t);
  const code = positional.join(' ');

  const { result } = await withSession(name, flags, async (sandbox) => ({
    result: await withDeadline(sandbox.code.run(code, { timeout }), timeout * 1000 + RUN_GRACE_MS, 'the guest command'),
  }), timeout * 1000 + RUN_GRACE_MS);

  if (flags.json) { cli.out({ session: name, code, ...plainCodeResult(result) }); return; }
  const text = result.text ?? result.stdout ?? '';
  if (text) process.stdout.write(endWithNewline(String(text)));
  if (result.stderr) process.stderr.write(endWithNewline(String(result.stderr)));
  if (result.exitCode) process.exit(result.exitCode);
}

async function cmdPut(argv) {
  const { flags, positional } = parseArgs(argv);
  const [src, dst] = positional;
  if (!src || !dst) cli.die(`usage: ${TOOL} put <vfs-src> <guest-dst> [-n NAME]`, { prefix: TOOL });
  if (!(await fs.exists(src))) cli.die(`no such file: ${src}`, { prefix: TOOL });
  const name = flags.name || flags.n || 'default';
  const bytes = await fs.readFileBinary(src);
  const timeout = clampTimeout(flags.timeout || flags.t);

  const { result } = await withSession(name, flags, async (sandbox) => ({
    result: await withDeadline(
      sandbox.commands.run(
        `mkdir -p "$(dirname ${shQuote(dst)})" && base64 -d > ${shQuote(dst)}`,
        { stdin: bytesToBase64(bytes), timeout }
      ),
      timeout * 1000 + RUN_GRACE_MS, 'the guest write'
    ),
  }), timeout * 1000 + RUN_GRACE_MS);
  if (result.exitCode !== 0) {
    cli.die(`guest write failed (exit ${result.exitCode}): ${result.stderr.trim()}`, { prefix: TOOL });
  }
  if (flags.json) { cli.out({ session: name, src, dst, bytes: bytes.length }); return; }
  console.log(`  ${color.green('✓')} ${src} → ${color.cyan(dst)} ${color.dim(`(${fmtBytes(bytes.length)})`)}`);
}

async function cmdGet(argv) {
  const { flags, positional } = parseArgs(argv);
  const [src, dst] = positional;
  if (!src || !dst) cli.die(`usage: ${TOOL} get <guest-src> <vfs-dst> [-n NAME]`, { prefix: TOOL });
  const name = flags.name || flags.n || 'default';
  const timeout = clampTimeout(flags.timeout || flags.t);

  const { result } = await withSession(name, flags, async (sandbox) => ({
    result: await withDeadline(
      sandbox.commands.run(`base64 < ${shQuote(src)}`, { timeout }),
      timeout * 1000 + RUN_GRACE_MS, 'the guest read'
    ),
  }), timeout * 1000 + RUN_GRACE_MS);
  if (result.exitCode !== 0) {
    cli.die(`guest read failed (exit ${result.exitCode}): ${result.stderr.trim()}`, { prefix: TOOL });
  }
  const bytes = base64ToBytes(result.stdout);
  const parent = dst.slice(0, dst.lastIndexOf('/'));
  if (parent) await fs.mkdir(parent, { recursive: true });
  await fs.writeFileBinary(dst, bytes);
  if (flags.json) { cli.out({ session: name, src, dst, bytes: bytes.length }); return; }
  console.log(`  ${color.green('✓')} ${color.cyan(src)} → ${dst} ${color.dim(`(${fmtBytes(bytes.length)})`)}`);
}

async function cmdLs(argv) {
  const { flags } = parseArgs(argv);
  const sessions = await listSessions();
  if (flags.json) { cli.out(sessions); return; }
  console.log('');
  if (!sessions.length) {
    console.log(color.dim('  No sessions yet. Start one with: vpod run uname -a'));
    return;
  }
  for (const s of sessions) {
    const age = s.savedAt ? fmt.date(new Date(s.savedAt), 'human') : 'unknown';
    console.log(
      `  ${color.cyan(color.bold(s.name))}  ${color.dim(`snapshot:${s.snapshotId}`)}` +
      `  ${color.dim(fmtBytes(s.deltaBytes))}  ${color.dim(age)}` +
      (s.wedgedAt ? `  ${color.red('wedged')}` : '') +
      (s.locked ? `  ${color.yellow('busy')}` : '')
    );
  }
}

async function cmdRm(argv) {
  const { flags, positional } = parseArgs(argv);
  const targets = flags.all ? (await listSessions()).map((s) => s.name) : positional;
  if (!targets.length) cli.die(`usage: ${TOOL} rm <NAME|--all>`, { prefix: TOOL });
  for (const name of targets) {
    requireName(name, 'session name');
    if (!(await fs.exists(metaPath(name)))) cli.die(`no such session: ${name}`, { prefix: TOOL });
    if (await isLocked(name)) {
      cli.die(`session '${name}' is busy — nothing was removed.\n` +
        `If that command died, clear it with: rm ${lockPath(name)}`, { prefix: TOOL });
    }
  }
  const removed = [];
  for (const name of targets) {
    for (const path of [metaPath(name), deltaPath(name), lockPath(name)]) {
      if (await fs.exists(path)) await fs.rm(path);
    }
    removed.push(name);
  }
  if (flags.json) { cli.out({ removed }); return; }
  console.log(`  ${color.green('✓')} removed ${removed.map((n) => color.cyan(n)).join(', ')}`);
}

async function cmdSnapshots(argv) {
  const { flags } = parseArgs(argv);
  const sdk = await loadSdk();
  const [catalog, cached, local] = await Promise.all([
    sdk.snapshots.catalog().catch((err) => ({ error: err.message })),
    sdk.snapshots.cached().catch(() => []),
    listLocalSnapshots(),
  ]);
  if (flags.json) { cli.out({ catalog, cached, local }); return; }

  const cachedIds = new Set((cached || []).map((c) => c.id));
  console.log(`\n  ${color.bold('Registry')} ${color.dim('registry.vpod.sh')}`);
  if (catalog?.error) {
    console.log(color.dim(`    unavailable: ${catalog.error}`));
  } else {
    for (const e of catalog) {
      const mark = cachedIds.has(e.id) ? color.green('✓') : color.dim('·');
      console.log(`  ${mark} ${color.cyan(color.bold(e.id))}  ${color.dim(`${e.name}:${e.tag}`)}` +
        `  ${color.dim(e.memory_label)}  ${color.dim(fmtBytes(e.size))}`);
    }
    console.log(color.dim(`    ${color.green('✓')} = already cached in origin-private storage`));
  }

  console.log(`\n  ${color.bold('Local')} ${color.dim(SNAPSHOT_DIR)}`);
  if (!local.length) {
    console.log(color.dim('    none — land one with: vpod import <NAME> <path-or-url>'));
  } else {
    for (const s of local) {
      console.log(`  ${color.green('✓')} ${color.cyan(color.bold(s.name))}  ${color.dim(fmtBytes(s.bytes))}`);
    }
  }
  console.log('');
}

async function cmdPull(argv) {
  const { flags, positional } = parseArgs(argv);
  const spec = positional[0];
  if (!spec) cli.die(`usage: ${TOOL} pull <SNAPSHOT>\nNames come from: ${TOOL} snapshots`, { prefix: TOOL });
  const sdk = await loadSdk();
  const started = Date.now();
  // pullSnapshot takes an options object, not a bare name.
  const pulled = await withDeadline(
    sdk.snapshots.pullSnapshot({ name: spec }), BOOT_DEADLINE_MS, `pulling ${spec}`
  );
  const info = {
    id: pulled?.entry?.id ?? spec,
    bytes: pulled?.bytes?.byteLength ?? pulled?.entry?.size ?? 0,
    source: pulled?.source ?? 'unknown',
    elapsedMs: Date.now() - started,
  };
  if (flags.json) { cli.out(info); return; }
  console.log(`  ${color.green('✓')} cached ${color.cyan(info.id)} ${color.dim(`(${fmtBytes(info.bytes)}, from ${info.source}, ${(info.elapsedMs / 1000).toFixed(1)}s)`)}`);
}

async function cmdImport(argv) {
  const { flags, positional } = parseArgs(argv);
  const [name, source] = positional;
  if (!name || !source) cli.die(`usage: ${TOOL} import <NAME> <vfs-path|url>`, { prefix: TOOL });
  requireName(name, 'snapshot name');

  let bytes;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) cli.die(`download failed: ${res.status} ${res.statusText} for ${source}`, { prefix: TOOL });
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    if (!(await fs.exists(source))) cli.die(`no such file: ${source}`, { prefix: TOOL });
    bytes = await fs.readFileBinary(source);
  }
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.writeFileBinary(localSnapPath(name), bytes);
  const digest = await sha256Hex(bytes);
  if (flags.json) { cli.out({ name, path: localSnapPath(name), bytes: bytes.length, sha256: digest }); return; }
  console.log(`  ${color.green('✓')} imported ${color.cyan(color.bold(name))} ${color.dim(`(${fmtBytes(bytes.length)})`)}`);
  console.log(color.dim(`    sha256 ${digest}`));
  console.log(color.dim(`    boot it with: ${TOOL} run -s ${name} --fresh uname -a`));
}

// ── remote (snapshot building on a follower) ──────────────────────────
// Snapshot builds need Docker/riscv64, Zig and a Rust wasm32-wasip2 toolchain.
// None of that exists in a browser, so the work runs on a machine connected
// with `slicc <join-url> follow sh -c` and reached through the `ssh` builtin.
const PREFLIGHT = [
  ['docker', 'docker buildx version'],
  ['container', 'container --version'],
  ['zig', 'zig version'],
  ['bsdtar', 'bsdtar --version'],
  ['rustup', 'rustup target list --installed | grep -c wasm32-wasip2'],
  ['git', 'git --version'],
];

async function ssh(target, command, timeoutSeconds = 120) {
  const res = await exec.spawn(['ssh', '--timeout', String(timeoutSeconds), target, command]);
  return { stdout: res.stdout || '', stderr: res.stderr || '', exitCode: res.exitCode };
}

async function cmdRemote(argv) {
  const target = argv[0];
  const action = argv[1];
  if (!target || target.startsWith('-')) {
    cli.die(`usage: ${TOOL} remote <target> check|build|pull …\nList targets with: ssh --list`,
      { prefix: TOOL });
  }
  requireName(target, 'follower id');
  const { flags, positional } = parseArgs(argv.slice(2));

  if (action === 'check') return remoteCheck(target, flags);
  if (action === 'build') return remoteBuild(target, flags);
  if (action === 'pull') return remotePull(target, positional, flags);
  cli.die(`unknown remote action: ${action ?? '(none)'} — expected check, build or pull`, { prefix: TOOL });
}

async function remoteCheck(target, flags) {
  const script = PREFLIGHT
    .map(([tool, probe]) => `printf '%s\\t' ${shQuote(tool)}; { ${probe}; } 2>/dev/null | head -1 || echo -`)
    .join('; ');
  const res = await ssh(target, script, 120);
  if (res.exitCode !== 0 && !res.stdout.trim()) {
    cli.die(`ssh to '${target}' failed (exit ${res.exitCode}): ${res.stderr.trim() || 'no output'}\n` +
      `List exec-capable followers with: ssh --list`, { prefix: TOOL });
  }
  const found = {};
  for (const line of res.stdout.split('\n')) {
    const [tool, ...rest] = line.split('\t');
    if (tool) found[tool.trim()] = rest.join('\t').trim();
  }
  const builder = found.docker || found.container;
  const ready = Boolean(builder && found.zig && found.bsdtar && found.rustup && found.rustup !== '0');
  if (flags.json) { cli.out({ target, ready, tools: found }); return; }
  console.log(`\n  ${color.bold(target)} ${ready ? color.green('ready to build snapshots') : color.yellow('missing prerequisites')}`);
  for (const [tool] of PREFLIGHT) {
    const value = found[tool];
    const ok = value && value !== '-' && value !== '0';
    console.log(`  ${ok ? color.green('✓') : color.red('✗')} ${tool.padEnd(10)} ${color.dim(ok ? value : 'not found')}`);
  }
  if (!ready) console.log(color.dim('\n    See references/snapshots.md for what each prerequisite is for.'));
  console.log('');
}

async function remoteBuild(target, flags) {
  const dockerfile = flags.file || flags.f;
  const name = flags.name || flags.n;
  const repo = flags.repo || '~/vpod';
  const ram = flags.ram || '256';
  if (!dockerfile || !name) {
    cli.die(`usage: ${TOOL} remote <target> build -f <Dockerfile> -n <NAME> [--ram MB] [--repo DIR]`,
      { prefix: TOOL });
  }
  requireName(name, 'snapshot name');
  if (!/^[0-9]+$/.test(String(ram))) cli.die(`--ram must be a number of MB, got ${ram}`, { prefix: TOOL });
  const timeout = Number(flags.timeout || flags.t || 3600);

  const out = `/tmp/vpod-${name}.snap`;
  const script =
    `cd ${shQuotePath(repo)} && ./scripts/build-custom-snapshot.sh ` +
    `-f ${shQuotePath(dockerfile)} -n ${shQuote(name)} --ram ${ram} --out ${shQuote(out)}`;
  console.log(color.dim(`  ${target}: ${script}`));
  console.log(color.dim(`  (a riscv64 image build takes many minutes — timeout ${timeout}s)`));

  const res = await ssh(target, script, timeout);
  if (res.stdout) process.stdout.write(endWithNewline(res.stdout));
  if (res.exitCode !== 0) {
    cli.die(`remote build failed (exit ${res.exitCode})\n${res.stderr.trim()}`, { prefix: TOOL });
  }
  console.log(`  ${color.green('✓')} built ${color.cyan(out)} on ${target}`);
  console.log(color.dim(`    bring it back with: ${TOOL} remote ${target} pull ${out} ${name}`));
}

async function remotePull(target, positional, flags) {
  const [remotePath, name] = positional;
  if (!remotePath || !name) {
    cli.die(`usage: ${TOOL} remote <target> pull <remote-path> <NAME>`, { prefix: TOOL });
  }
  requireName(name, 'snapshot name');

  const sizeRes = await ssh(target, `wc -c < ${shQuotePath(remotePath)}`, 60);
  const total = Number(String(sizeRes.stdout).trim());
  if (sizeRes.exitCode !== 0 || !Number.isFinite(total) || total <= 0) {
    cli.die(`cannot stat ${remotePath} on ${target}: ${sizeRes.stderr.trim() || 'no size'}`, { prefix: TOOL });
  }

  const chunks = Math.ceil(total / REMOTE_CHUNK_BYTES);
  console.log(color.dim(`  pulling ${fmtBytes(total)} from ${target} in ${chunks} chunk(s)`));
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks; i++) {
    const res = await ssh(
      target,
      `dd if=${shQuotePath(remotePath)} bs=${REMOTE_CHUNK_BYTES} skip=${i} count=1 2>/dev/null | base64 | tr -d '\\n'`,
      600
    );
    if (res.exitCode !== 0) {
      cli.die(`chunk ${i + 1}/${chunks} failed (exit ${res.exitCode}): ${res.stderr.trim()}`, { prefix: TOOL });
    }
    const bytes = base64ToBytes(res.stdout);
    if (offset + bytes.length > total) {
      cli.die(`chunk ${i + 1}/${chunks} overran the reported size — did ${remotePath} change mid-pull?`,
        { prefix: TOOL });
    }
    buffer.set(bytes, offset);
    offset += bytes.length;
  }
  if (offset !== total) {
    cli.die(`transfer short: got ${offset} of ${total} bytes`, { prefix: TOOL });
  }

  // Verify against the source rather than trusting 20 shell round trips.
  const localDigest = await sha256Hex(buffer);
  const remoteDigest = await ssh(target,
    `sha256sum ${shQuotePath(remotePath)} 2>/dev/null || shasum -a 256 ${shQuotePath(remotePath)}`, 300);
  const expected = String(remoteDigest.stdout).trim().split(/\s+/)[0];
  if (expected && expected !== localDigest) {
    cli.die(`sha256 mismatch — remote ${expected}, local ${localDigest}. Nothing was written.`, { prefix: TOOL });
  }

  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.writeFileBinary(localSnapPath(name), buffer);
  if (flags.json) { cli.out({ target, remotePath, name, bytes: total, sha256: localDigest, verified: Boolean(expected) }); return; }
  console.log(`  ${color.green('✓')} ${color.cyan(color.bold(name))} ${color.dim(`(${fmtBytes(total)})`)}` +
    (expected ? color.dim(' — sha256 verified') : color.yellow(' — UNVERIFIED (no sha256 on the follower)')));
  console.log(color.dim(`    boot it with: ${TOOL} run -s ${name} --fresh uname -a`));
}

/**
 * Reclaim space. Snapshots re-download on demand and sessions are throwaway by
 * nature, so nothing here is unrecoverable -- but both are opt-in, because
 * dropping a session loses work the guest did.
 */
async function cmdClean(argv) {
  const { flags } = parseArgs(argv);
  const wantSnapshots = Boolean(flags.snapshots);
  const wantSessions = Boolean(flags.sessions);
  if (!wantSnapshots && !wantSessions) {
    cli.die(`usage: ${TOOL} clean [--snapshots] [--sessions]\n` +
      `  --snapshots  drop the origin-private snapshot cache and ${SNAPSHOT_DIR}\n` +
      `  --sessions   delete every saved session (their guest state is lost)`,
      { prefix: TOOL });
  }
  const freed = { cacheBytes: 0, localBytes: 0, sessions: [] };

  if (wantSessions) {
    const sessions = await listSessions();
    const busy = sessions.filter((session) => session.locked).map((session) => session.name);
    if (busy.length) {
      cli.die(`busy session(s): ${busy.join(', ')} — nothing was removed.\n` +
        `Wait for them to finish, or clear a dead one with: rm ${SESSION_DIR}/<name>.lock`,
        { prefix: TOOL });
    }
    for (const session of sessions) {
      for (const path of [metaPath(session.name), deltaPath(session.name), lockPath(session.name)]) {
        if (await fs.exists(path)) await fs.rm(path);
      }
      freed.sessions.push(session.name);
      freed.localBytes += session.deltaBytes || 0;
    }
  }

  if (wantSnapshots) {
    const sdk = await loadSdk();
    // The SDK's clear() keeps suspended OPFS instances unless told otherwise;
    // this skill never stores sessions there, so the default is right.
    freed.cacheBytes = Number(await sdk.snapshots.clear()) || 0;
    for (const snap of await listLocalSnapshots()) {
      await fs.rm(snap.path);
      freed.localBytes += snap.bytes;
    }
  }

  if (flags.json) { cli.out(freed); return; }
  if (wantSnapshots) {
    console.log(`  ${color.green('✓')} snapshot cache cleared ${color.dim(`(${fmtBytes(freed.cacheBytes)} reclaimed; they re-download on demand)`)}`);
  }
  if (wantSessions) {
    console.log(`  ${color.green('✓')} removed ${freed.sessions.length} session(s)` +
      (freed.sessions.length ? ` ${color.dim(freed.sessions.join(', '))}` : ''));
  }
}

async function cmdInfo(argv) {
  const { flags } = parseArgs(argv);
  const version = await installedVersion();
  const info = {
    installed: Boolean(version),
    version,
    pinnedVersion: PINNED_VERSION,
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    sharedArrayBuffer: typeof globalThis.SharedArrayBuffer === 'function',
    stateDir: STATE_DIR,
    sessions: (await listSessions()).length,
    localSnapshots: (await listLocalSnapshots()).length,
  };
  if (info.installed) {
    const sdk = await loadSdk();
    try { info.networkAvailability = sdk.networkAvailability(); } catch (err) { info.networkAvailability = { error: err.message }; }
    try { info.network = sdk.capabilitiesOf(sdk.socketBackendName()); } catch { /* backend not chosen until boot */ }
    try { info.cachedSnapshots = (await sdk.snapshots.cached()).map((c) => c.id); } catch { info.cachedSnapshots = []; }
  }
  if (flags.json) { cli.out(info); return; }

  console.log(`\n  ${color.bold('vpod')}  ${info.installed ? color.green(`${PACKAGE}@${info.version}`) : color.red('not installed')}`);
  if (!info.installed) { console.log(color.dim(`    ${NOT_INSTALLED}`)); return; }
  if (info.version !== PINNED_VERSION) {
    console.log(color.yellow(`  ! pinned to ${PINNED_VERSION} — run \`${TOOL} install\` to match`));
  }
  console.log(`  ${info.crossOriginIsolated ? color.green('✓') : color.yellow('✗')} cross-origin isolated` +
    color.dim(info.crossOriginIsolated ? '' : ' — guest networking needs it (Document-Isolation-Policy)'));
  const backend = info.network?.backend ?? (info.networkAvailability?.available ? 'fetch (on boot)' : 'none');
  console.log(`  ${color.dim('network backend')} ${backend}`);
  if (info.network) {
    console.log(color.dim(`    rawTcp=${info.network.rawTcp} udp=${info.network.udp} ` +
      `arbitraryPorts=${info.network.arbitraryPorts} corsRestricted=${info.network.corsRestricted}`));
  }
  console.log(`  ${color.dim('cached snapshots')} ${info.cachedSnapshots.join(', ') || color.dim('none')}`);
  console.log(`  ${color.dim('sessions')} ${info.sessions}  ${color.dim('local snapshots')} ${info.localSnapshots}`);
  console.log('');
}

// ── helpers ───────────────────────────────────────────────────────────
class DeadlineError extends Error {}

/**
 * Every guest interaction gets a HOST-side deadline. The SDK's exec loop
 * (Sandbox._execSliced) spins until the guest reports an exit code and has no
 * deadline of its own, so a guest whose session shell has died -- the shell
 * that `vpod run exit 1` terminates -- would otherwise spin the realm forever
 * and wedge the kernel shell behind it. Verified live on 2026-09-01 against
 * @capsule-run/vpod@0.8.1.
 */
function withDeadline(promise, ms, what) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what} did not finish within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

const WEDGED_HINT = (name) =>
  `The guest may be wedged: a command that runs 'exit' (or kills the session shell) ends the\n` +
  `session's shell for good, and later commands never return. Start over with:\n` +
  `  ${TOOL} run -n ${name} --fresh <command>      (keeps the snapshot, drops the state)\n` +
  `  ${TOOL} rm ${name}                            (delete the session entirely)`;

/** Best-effort teardown: a wedged sandbox can hang close() too. */
async function closeQuietly(sandbox) {
  try { await withDeadline(sandbox.close(), 15_000, 'close'); } catch { /* the realm exit reaps it */ }
}

function clampTimeout(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_S;
  return Math.min(Math.max(parsed, 1), MAX_TIMEOUT_S);
}

function endWithNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plainCodeResult(result) {
  return {
    text: result.text ?? null,
    stdout: result.stdout ?? null,
    stderr: result.stderr ?? null,
    exitCode: result.exitCode ?? 0,
  };
}

async function sha256Hex(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    cli.help(HELP);
  }
  const rest = argv.slice(1);
  // `vpod run --help` means help; `vpod run echo --help` means the guest gets
  // it. Only flags BEFORE the first bare word are ours, in every subcommand.
  for (const arg of rest) {
    if (arg === '--help' || arg === '-h') cli.help(HELP);
    if (!arg.startsWith('-')) break;
    if (ARG_FLAGS.has(arg)) break;
  }
  try {
    if (subcommand === 'run') await cmdRun(rest);
    else if (subcommand === 'python') await cmdPython(rest);
    else if (subcommand === 'put') await cmdPut(rest);
    else if (subcommand === 'get') await cmdGet(rest);
    else if (subcommand === 'ls') await cmdLs(rest);
    else if (subcommand === 'rm') await cmdRm(rest);
    else if (subcommand === 'snapshots') await cmdSnapshots(rest);
    else if (subcommand === 'pull') await cmdPull(rest);
    else if (subcommand === 'import') await cmdImport(rest);
    else if (subcommand === 'remote') await cmdRemote(rest);
    else if (subcommand === 'info') await cmdInfo(rest);
    else if (subcommand === 'clean') await cmdClean(rest);
    else if (subcommand === 'install') await cmdInstall(parseArgs(rest).flags);
    else cli.die(`unknown command: ${subcommand}\nRun '${TOOL} --help' for usage.`, { prefix: TOOL });
  } catch (err) {
    // cli.die / process.exit unwind by throwing NodeExitError — re-throwing it
    // keeps the intended exit code and avoids printing a second, wrong error.
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err?.message || String(err), { prefix: TOOL });
  }
}

return main();
