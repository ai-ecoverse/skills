// review.jsh — ingest review-compatible sources into the sprinkle backlog
// Protocol: references/SOURCE_PROTOCOL.md
//
// Usage:
//   review ingest [sources...] --path PATH [--id ID] [--title T]
//                [--preview-url URL] [--live-url URL] [--dry-run]
//   review sources
//
// Sources write one JSON object to stdout. This command ensure-item + add-findings.

const { exec } = require('sliccy:exec');
const cli = require('sliccy:cli');

const KNOWN_INTEGRATIONS = ['pangram', 'check-llm-cliches'];

function helpText() {
  return [
    'Usage: review ingest [sources...] --path PATH [--id ID] [--title T]',
    '                    [--preview-url URL] [--live-url URL] [--dry-run]',
    '       review sources',
    '',
    'Discover review-compatible commands and attach their findings to the',
    'review sprinkle. Protocol: skills/review/references/SOURCE_PROTOCOL.md',
    '',
    'Default sources (if installed): ' + KNOWN_INTEGRATIONS.join(', '),
    'Missing sources are skipped. The queue works with none of them.',
  ].join('\n') + '\n';
}

function escapeShellArg(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

async function which(cmd) {
  const r = await exec('which ' + escapeShellArg(cmd) + ' 2>/dev/null');
  return r.exitCode === 0;
}

async function discover(named) {
  const wanted = named.length ? named : KNOWN_INTEGRATIONS;
  const found = [];
  for (const cmd of wanted) {
    if (cmd === 'review' || cmd === 'ingest' || cmd === 'sources') continue;
    if (await which(cmd)) found.push(cmd);
    else process.stderr.write('[review] skip ' + cmd + ' (not on PATH)\n');
  }
  return found;
}

async function invokeSource(cmd, filePath, id) {
  const argv = [cmd, 'review', '--path', filePath];
  if (id) argv.push('--id', id);
  process.stderr.write('[review] invoking: ' + argv.join(' ') + '\n');
  const result = await exec.spawn(argv);
  if (result.exitCode !== 0) {
    process.stderr.write(
      '[review] WARNING: ' + cmd + ' review exited ' + result.exitCode + '\n'
    );
    if (result.stderr) process.stderr.write('  stderr: ' + String(result.stderr).trim() + '\n');
    return null;
  }
  const out = String(result.stdout || '').trim();
  if (!out) {
    process.stderr.write('[review] WARNING: ' + cmd + ' review produced empty stdout\n');
    return null;
  }
  let json;
  try {
    json = JSON.parse(out);
  } catch (e) {
    process.stderr.write('[review] WARNING: ' + cmd + ' review emitted invalid JSON\n');
    process.stderr.write('  preview: ' + out.slice(0, 200) + '\n');
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    process.stderr.write('[review] WARNING: ' + cmd + ' review did not emit a JSON object\n');
    return null;
  }
  if (!json.source) {
    process.stderr.write('[review] WARNING: ' + cmd + ' review missing source field\n');
    return null;
  }
  return json;
}

async function sprinkleSend(msg) {
  const r = await exec.spawn(['sprinkle', 'send', 'review', JSON.stringify(msg)]);
  if (r.exitCode !== 0) {
    const err = new Error(
      (r.stderr || r.stdout || 'sprinkle send failed').toString().trim() ||
        'sprinkle send review exited ' + r.exitCode
    );
    err.exitCode = r.exitCode;
    throw err;
  }
  return r;
}

function cardId(flags, contributions, filePath) {
  if (flags.id) return String(flags.id);
  for (const c of contributions) {
    if (c && c.id) return String(c.id);
  }
  const base = String(filePath).split('/').pop() || 'item';
  return 'review-' + base.replace(/\s+/g, '-');
}

const parsed = process.argv.parseFlags();
const { positional, flags, subcommand } = parsed;
const cmd = subcommand || positional[0];

try {
  if (flags.help || flags.h || cmd === 'help') {
    process.stdout.write(helpText());
    process.exit(0);
  }
  if (!cmd) {
    process.stderr.write(helpText());
    process.exit(2);
  }

  if (cmd === 'sources') {
    const found = [];
    for (const name of KNOWN_INTEGRATIONS) {
      found.push({ name, installed: await which(name) });
    }
    if (flags.json) process.stdout.write(JSON.stringify(found, null, 2) + '\n');
    else {
      for (const s of found) {
        process.stdout.write(s.name + '\t' + (s.installed ? 'on PATH' : 'not installed') + '\n');
      }
    }
    process.exit(0);
  }

  if (cmd !== 'ingest') {
    cli.die('unknown command: ' + cmd + '\n' + helpText(), { exitCode: 2, prefix: '' });
  }

  const filePath = flags.path;
  if (!filePath) cli.die('review ingest requires --path PATH', { exitCode: 2, prefix: '' });

  const named = positional.filter((p) => p !== 'ingest' && p !== 'review');
  const sources = await discover(named);
  if (sources.length === 0) {
    process.stderr.write('[review] no review-compatible sources on PATH\n');
  }

  const contributions = [];
  const jobs = sources.map((s) => invokeSource(s, filePath, flags.id));
  const results = await Promise.all(jobs);
  for (const c of results) if (c) contributions.push(c);

  const id = cardId(flags, contributions, filePath);
  const title =
    flags.title ||
    (contributions.find((c) => c.title) || {}).title ||
    String(filePath).split('/').pop();

  const payload = {
    id,
    title,
    path: filePath,
    previewUrl: flags['preview-url'] || flags.previewUrl || '',
    liveUrl: flags['live-url'] || flags.liveUrl || '',
    contributions,
  };

  if (flags['dry-run'] || flags.dryRun) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exit(0);
  }

  try {
    await sprinkleSend({
      action: 'ensure-item',
      id,
      title,
      path: filePath,
      previewUrl: payload.previewUrl || undefined,
      liveUrl: payload.liveUrl || undefined,
    });
    for (const c of contributions) {
      await sprinkleSend({
        action: 'add-findings',
        id,
        source: c.source,
        summary: c.summary || '',
        severity: c.severity || 'info',
        findings: Array.isArray(c.findings) ? c.findings : [],
        ts: c.ts,
      });
    }
  } catch (err) {
    process.stderr.write(
      '[review] sprinkle send failed: ' + (err && err.message ? err.message : String(err)) + '\n'
    );
    process.stderr.write('[review] open the review sprinkle, then re-run. Dumping payload:\n');
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exit(1);
  }

  process.stderr.write(
    '[review] attached ' + contributions.length + ' source(s) to card ' + id + '\n'
  );
  if (flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} catch (err) {
  process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
  process.exit(2);
}
