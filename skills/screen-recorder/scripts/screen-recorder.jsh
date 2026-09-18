// screen-recorder — companion CLI for the recording-setup sprinkle.
//
// Pre-populates the panel's fields and reads back what a take actually produced,
// so an agent can drive a recording without clicking: set the config, tell the
// human to press the two buttons, then read the manifest.
//
// WHY A CLI AT ALL: the panel is the only thing that can call getDisplayMedia
// (it needs a real user gesture), so this cannot start a recording. What it CAN
// do is remove every other reason to touch the UI -- typing a URL, a size, a
// duration -- and turn the manifest into something greppable.
//
// Mirrors the interview-me CLI's shape: a config.json next to the sprinkle,
// plus a best-effort `sprinkle send` so an already-open panel live-reloads.

const cli = require('sliccy:cli');
const fs = require('fs');

// ─── paths ───────────────────────────────────────────────────────────────
// The ONE place that decides where the sprinkle's runtime config lives. The
// panel has the same constant (CONFIG_FILE in recording-setup.shtml) and the
// two MUST agree -- if the sprinkle is ever installed elsewhere, change both.
const SPRINKLE_DIR = '/shared/sprinkles/recording-setup';
const CONFIG_FILE = `${SPRINKLE_DIR}/config.json`;
const CAPTURES_DIR = '/workspace/captures';

// ─── config schema ───────────────────────────────────────────────────────
// Deliberately small and flat. Every key maps to one panel field; the panel
// ignores anything it does not recognise, so an unknown key here is a CLI
// error rather than a silent no-op in the UI.
//
// MEASURED CONSTRAINTS, enforced here so a bad value is rejected before it
// reaches the panel (see references/window-sizing.md):
//   * width  < 500 is silently widened by Chrome to 500 (minimum window width).
//   * height > screen.availHeight is silently clamped (841 on a 1470x956 Mac).
// availHeight is per-machine so it cannot be validated here -- the panel warns.
const MIN_WINDOW_WIDTH = 500;

const FIELDS = {
  startUrl: { type: 'url', help: 'URL the target window opens' },
  width: { type: 'int', min: 1, help: `target window FRAME width (Chrome minimum ${MIN_WINDOW_WIDTH})` },
  height: { type: 'int', min: 1, help: 'target window FRAME height (incl. chrome)' },
  countdownSec: { type: 'int', min: 0, max: 60, help: 'recorded countdown, trimmed via manifest countdownMs' },
  maxDurationSec: { type: 'int', min: 0, help: 'auto-stop after N seconds (0 = single screenshot)' },
  driver: { type: 'str', help: 'driver script path, run against the target window' },
};

function parseValue(key, raw) {
  const spec = FIELDS[key];
  if (!spec) {
    cli.die(`unknown config key '${key}'. Known: ${Object.keys(FIELDS).join(', ')}`);
  }
  if (spec.type === 'int') {
    const n = Number(raw);
    if (!Number.isInteger(n)) cli.die(`${key} must be an integer, got '${raw}'`);
    if (spec.min != null && n < spec.min) cli.die(`${key} must be >= ${spec.min}, got ${n}`);
    if (spec.max != null && n > spec.max) cli.die(`${key} must be <= ${spec.max}, got ${n}`);
    return n;
  }
  if (spec.type === 'url') {
    if (!/^https?:\/\//i.test(raw)) cli.die(`${key} must be an http(s) URL, got '${raw}'`);
    return raw;
  }
  return String(raw);
}

// ─── config read/write ───────────────────────────────────────────────────

async function readConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE);
    if (!raw) return {};
    return JSON.parse(String(raw));
  } catch {
    return {}; // absent or malformed -> empty, never fatal
  }
}

async function writeConfig(cfg) {
  await fs.mkdir(SPRINKLE_DIR).catch(() => {});
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

// ─── live-reload notify ──────────────────────────────────────────────────
// After writing config.json an already-open panel has no way to notice, so
// push a message. MUST be non-fatal and bounded: `sprinkle send` exits
// non-zero when nothing is open (its documented contract), and that is a
// normal outcome here, not a CLI failure.

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function notifyPanel() {
  try {
    const r = await withTimeout(
      exec(`sprinkle send recording-setup '{"type":"reloadconfig"}'`),
      4000,
      'sprinkle send'
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// ─── captures ────────────────────────────────────────────────────────────

/**
 * Capture folders only -- NOT everything in the directory.
 *
 * MEASURED: `/workspace/captures/` also holds `drivers/` and a
 * `sync.example.json`, and taking the lexically-last entry picked the stray
 * JSON file, so `manifest` died with ENOTDIR. A take is identified by having a
 * manifest.json inside it; anything else is not a capture.
 */
async function listCaptures() {
  let entries;
  try {
    entries = await fs.readDir(CAPTURES_DIR);
  } catch {
    return [];
  }
  const names = (entries || []).map((e) => (typeof e === 'string' ? e : e && e.name)).filter(Boolean);
  const out = [];
  for (const n of names) {
    // The ISO-ish folder name is what makes a lexical sort chronological; a
    // capture must also actually contain a manifest.
    if (!/^\d{4}-\d{2}-\d{2}T/.test(n)) continue;
    if (await fs.exists(`${CAPTURES_DIR}/${n}/manifest.json`)) out.push(n);
  }
  return out.sort();
}

async function readManifest(folder) {
  const path = `${CAPTURES_DIR}/${folder}/manifest.json`;
  try {
    const raw = await fs.readFile(path);
    return JSON.parse(String(raw));
  } catch (e) {
    cli.die(`cannot read ${path}: ${(e && e.message) || e}`);
  }
}

/**
 * The fields that actually answer "did this take come out right?".
 *
 * capture.width/height is the ONLY authoritative frame size -- settingsWidth/
 * Height reports the whole display, and predictedFrame (outer x dpr) has been
 * measured wrong on a popup window (outer 841 -> captured 809). Lead with the
 * real one and label the prediction as such.
 */
function summarise(m, folder) {
  const cap = m.capture || {};
  const tw = m.targetWindow || {};
  const lines = [];
  lines.push(`folder        ${folder}`);
  lines.push(`mode          ${m.mode}  (${m.stopReason}, ${Math.round((m.durationMs || 0) / 1000)}s)`);
  lines.push(`CAPTURED      ${cap.width}x${cap.height} @ ${cap.frameRate}fps   <- authoritative frame`);
  if (tw.predictedFrame && tw.predictedFrame !== `${cap.width}x${cap.height}`) {
    lines.push(`  predicted   ${tw.predictedFrame}  (DISAGREES with captured — trust captured)`);
  }
  lines.push(`window        requested ${tw.requested || '-'} -> outer ${tw.outerAfter || '-'} @ dpr ${tw.dpr ?? '-'}`);
  lines.push(`opened via    ${tw.openedVia || '-'}${tw.sized ? ' (sized)' : ' (UNSIZED)'}`);
  if (tw.fitsDisplay === false) lines.push(`  NOTE        request did not fit: ${tw.note || 'clamped'}`);
  const tracks = m.tracks || [];
  for (const t of tracks) {
    lines.push(
      `track ${String(t.name).padEnd(7)} ${t.file}  ${t.bytes} B  ${t.containerDurationSec}s  ` +
        `${t.verified ? 'verified' : '*** UNVERIFIED ***'}`
    );
  }
  if (m.trackDurationSpreadMs != null) {
    lines.push(`A/V spread    ${m.trackDurationSpreadMs}ms (inherent; mux with ffmpeg -shortest)`);
  }
  const b = m.beeps || {};
  if (b.stopChimesScheduled) {
    lines.push(`stop chime    ${b.stopChimesPlayed}/${b.stopChimesScheduled} played`);
  }
  // A failed part or a dropped chunk means the file may be short -- surface it
  // rather than letting a green-looking summary hide it.
  const fl = m.flusher || {};
  for (const name of Object.keys(fl)) {
    const f = fl[name] || {};
    if (f.failedParts || f.droppedForBackpressure || (f.assembly && f.assembly.ok === false)) {
      lines.push(
        `!! ${name}: failedParts=${f.failedParts} dropped=${f.droppedForBackpressure} ` +
          `assembly=${f.assembly && f.assembly.ok}`
      );
    }
  }
  return lines.join('\n');
}

// ─── commands ────────────────────────────────────────────────────────────

const HELP = `screen-recorder — companion CLI for the recording-setup sprinkle

  config get [<key>]          print the stored config (or one key)
  config set <key=value> …    set fields, then live-reload an open panel
  config clear                delete the stored config
  config keys                 list settable keys
  open                        open the sprinkle panel
  captures                    list capture folders, newest last
  manifest [<folder>]         summarise a take (default: newest)
  manifest <folder> --json    the raw manifest

Cannot start a recording: getDisplayMedia needs a real user gesture, so the
two buttons stay human. This removes every OTHER reason to touch the panel.

Keys:
${Object.entries(FIELDS).map(([k, v]) => `  ${k.padEnd(15)} ${v.help}`).join('\n')}`;

async function main(argv) {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    cli.help(HELP);
    return;
  }

  if (cmd === 'config') {
    const sub = rest[0];
    if (!sub || sub === 'get') {
      const cfg = await readConfig();
      const key = rest[1];
      if (key) {
        if (!FIELDS[key]) cli.die(`unknown config key '${key}'`);
        console.log(cfg[key] === undefined ? '' : String(cfg[key]));
        return;
      }
      if (!Object.keys(cfg).length) {
        console.log('(no config set)');
        return;
      }
      for (const k of Object.keys(FIELDS)) {
        if (cfg[k] !== undefined) console.log(`${k.padEnd(15)} ${cfg[k]}`);
      }
      return;
    }
    if (sub === 'keys') {
      for (const [k, v] of Object.entries(FIELDS)) console.log(`${k.padEnd(15)} ${v.help}`);
      return;
    }
    if (sub === 'clear') {
      await fs.rm(CONFIG_FILE).catch(() => {});
      const notified = await notifyPanel();
      console.log(`config cleared${notified ? ' (live panel updated)' : ''}`);
      return;
    }
    if (sub === 'set') {
      const pairs = rest.slice(1);
      if (!pairs.length) cli.die('config set needs at least one key=value');
      const cfg = await readConfig();
      const applied = [];
      for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq < 1) cli.die(`expected key=value, got '${p}'`);
        const key = p.slice(0, eq);
        const val = parseValue(key, p.slice(eq + 1));
        cfg[key] = val;
        applied.push(`${key}=${val}`);
      }
      // Warn (do not refuse) on a width Chrome will widen: the value is legal,
      // it just will not be honoured, and the panel says so too.
      if (cfg.width != null && cfg.width < MIN_WINDOW_WIDTH) {
        cli.warn(
          `width ${cfg.width} is below Chrome's ${MIN_WINDOW_WIDTH}px minimum window width — ` +
            `it will be silently widened to ${MIN_WINDOW_WIDTH} (measured)`
        );
      }
      await writeConfig(cfg);
      const notified = await notifyPanel();
      console.log(`set ${applied.join(' ')}${notified ? ' (live panel updated)' : ''}`);
      return;
    }
    cli.die(`unknown config subcommand '${sub}'`);
  }

  if (cmd === 'open') {
    const r = await exec('sprinkle open recording-setup');
    if (r.exitCode !== 0) cli.die(`sprinkle open failed: ${r.stderr || r.stdout}`);
    console.log((r.stdout || '').trim() || 'opened');
    return;
  }

  if (cmd === 'captures') {
    const list = await listCaptures();
    if (!list.length) {
      console.log('(no captures yet)');
      return;
    }
    for (const f of list) console.log(f);
    return;
  }

  if (cmd === 'manifest') {
    const wantJson = rest.includes('--json');
    let folder = rest.find((a) => !a.startsWith('--'));
    if (!folder) {
      const list = await listCaptures();
      if (!list.length) cli.die('no captures yet');
      folder = list[list.length - 1]; // ISO names sort chronologically
    }
    const m = await readManifest(folder);
    if (wantJson) {
      console.log(JSON.stringify(m, null, 2));
      return;
    }
    console.log(summarise(m, folder));
    return;
  }

  cli.die(`unknown command '${cmd}'. Try --help`);
}

await main(process.argv.slice(2));
