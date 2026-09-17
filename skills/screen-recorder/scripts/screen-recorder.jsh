// screen-recorder — install the recording panel and inspect takes.
//
// `install` copies the panel (and its esbuild sources) into
// /shared/sprinkles/recording-setup/, preserving anything already there that
// belongs to the user: captures live under /workspace/captures/ and are never
// touched by this script.
//
// A recording itself cannot be started from here: getDisplayMedia needs a real
// user gesture plus a human pick in Chrome's share dialog. This script sets the
// panel up; the human clicks it.

const fs = require('sliccy:fs');
const cli = require('sliccy:cli');

const SPRINKLE_DIR = '/shared/sprinkles/recording-setup';
const CAPTURES = '/workspace/captures';
const ASSETS = __dirname + '/../assets/sprinkle';

const args = process.argv.slice(2);
const flags = process.argv.parseFlags();
const cmd = args.find((a) => !a.startsWith('-')) || 'help';

async function copyIfChanged(from, to) {
  const src = await fs.readFile(from);
  let same = false;
  if (await fs.exists(to)) {
    const cur = await fs.readFile(to);
    same = cur === src;
  }
  if (!same) await fs.writeFile(to, src);
  return same ? 'unchanged' : 'written';
}

async function install() {
  await fs.mkdir(SPRINKLE_DIR);
  await fs.mkdir(SPRINKLE_DIR + '/src');
  await fs.mkdir(CAPTURES);

  const results = [];
  // The .shtml already contains the built bundle inline, so a fresh install
  // works without running esbuild.
  for (const f of ['recording-setup.shtml', 'build.sh', 'splice.js']) {
    results.push([f, await copyIfChanged(ASSETS + '/' + f, SPRINKLE_DIR + '/' + f)]);
  }
  const srcDir = await fs.readDir(ASSETS + '/src');
  for (const e of srcDir) {
    if (!e.name.endsWith('.js') || e.name === 'bundle.js') continue;
    results.push(['src/' + e.name, await copyIfChanged(ASSETS + '/src/' + e.name, SPRINKLE_DIR + '/src/' + e.name)]);
  }

  const written = results.filter((r) => r[1] === 'written').length;
  cli.out(
    'installed to ' + SPRINKLE_DIR + '\n' +
    '  ' + written + ' file(s) written, ' + (results.length - written) + ' unchanged\n' +
    '  captures dir: ' + CAPTURES + ' (never modified by install)\n\n' +
    'next:  sprinkle open recording-setup',
  );
}

async function listTakes() {
  if (!(await fs.exists(CAPTURES))) return cli.out('no captures yet');
  const entries = await fs.readDir(CAPTURES);
  const rows = [];
  for (const e of entries) {
    if (e.type !== 'directory' || e.name === 'drivers') continue;
    const mpath = CAPTURES + '/' + e.name + '/manifest.json';
    if (!(await fs.exists(mpath))) {
      rows.push({ take: e.name, status: 'no manifest' });
      continue;
    }
    let m;
    try {
      m = JSON.parse(await fs.readFile(mpath));
    } catch (err) {
      rows.push({ take: e.name, status: 'unreadable manifest' });
      continue;
    }
    rows.push({
      take: e.name,
      mode: m.mode,
      seconds: m.durationMs == null ? null : Math.round(m.durationMs / 1000),
      frame: m.capture && m.capture.width ? m.capture.width + 'x' + m.capture.height : null,
      tracks: (m.tracks || []).length,
      // An unverified track means the files may be SHORT — surface it here
      // rather than making the caller dig for it.
      unverified: m.unverifiedTracks || null,
    });
  }
  if (flags.json) return cli.out(rows);
  if (!rows.length) return cli.out('no takes yet');
  cli.out(
    rows
      .map((r) =>
        [
          r.take,
          r.mode || '-',
          r.seconds == null ? '-' : r.seconds + 's',
          r.frame || '-',
          r.tracks == null ? '-' : r.tracks + ' track(s)',
          r.unverified ? 'UNVERIFIED: ' + r.unverified.join(',') : '',
        ]
          .filter(Boolean)
          .join('  '),
      )
      .join('\n'),
  );
}

if (cmd === 'install') {
  await install();
} else if (cmd === 'takes' || cmd === 'list') {
  await listTakes();
} else {
  cli.out(
    'screen-recorder — screen/window/tab recording with mic and webcam\n\n' +
      'usage:\n' +
      '  screen-recorder install     copy the panel into /shared/sprinkles/recording-setup/\n' +
      '  screen-recorder takes       list capture folders and their manifests [--json]\n\n' +
      'then:\n' +
      '  sprinkle open recording-setup\n\n' +
      'A recording needs a human click: getDisplayMedia requires a user gesture\n' +
      'and a pick in the browser share dialog.',
  );
}
