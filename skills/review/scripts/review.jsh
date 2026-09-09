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
    '                    [--org ORG --site SITE] (for aem-ext)',
    '       review sources',
    '       review sweep --org ORG --site SITE [--never-published] [--stale]',
    '                   [--include-assets] [--dry-run]',
    '',
    'Discover review-compatible commands and attach their findings to the',
    'review sprinkle. Protocol: skills/review/references/SOURCE_PROTOCOL.md',
    '',
    'review sweep populates the backlog from an AEM site by diffing the',
    'preview/ and live/ partition trees. Requires aem-ext on PATH and a',
    'valid AEM credential (aem-ext auth status).',
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
  if (r.exitCode === 0) return true;
  // SLICC registers .jsh commands without always exposing them to nested `which`.
  try {
    const probe = await exec.spawn([cmd, '--help']);
    return probe.exitCode !== 127;
  } catch (e) {
    return false;
  }
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
  if (cmd === 'aem-ext') {
    const org = flags.org || flags.o;
    const site = flags.site || flags.repo;
    if (org) argv.push('--org', String(org));
    if (site) argv.push('--site', String(site));
  }
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

function stableCardId(filePath, sources) {
  const org = flags.org || flags.o;
  const site = flags.site || flags.repo;
  if (sources.includes('aem-ext') && org && site) {
    const relPath = String(filePath).replace(/^\//, '').replace(/\.(md|html|docx)$/, '');
    return 'aem:' + encodeURIComponent(org) + '/' + encodeURIComponent(site) + ':' + relPath;
  }
  // Full path so /a/README.md and /b/README.md never share a card.
  return 'review:' + String(filePath);
}

// ── review sweep ──────────────────────────────────────────────────────────────
//
// Enumerate AEM pages as review cards by calling `aem-ext sweep` and mapping
// its NDJSON output into ensure-item + add-findings sprinkle messages.
//
// This is the enumeration half of the review-AEM integration. The per-path
// enrichment half is `aem-ext review --path PATH` (review SOURCE_PROTOCOL.md).
// See skills/review/references/AEM-SOURCE.md for the design rationale.

async function cmdSweep() {
  const org = flags.org || flags.o;
  const site = flags.site || flags.repo;
  if (!org || !site) {
    process.stderr.write('[review sweep] error: --org ORG and --site SITE are required\n');
    process.exit(2);
  }
  const isDryRun = flags['dry-run'] || flags.dryRun;

  // Build aem-ext sweep argv
  const sweepArgs = ['aem-ext', 'sweep', '--org', String(org), '--site', String(site)];
  if (flags['never-published']) sweepArgs.push('--never-published');
  if (flags['stale']) sweepArgs.push('--stale');
  if (flags['include-assets']) sweepArgs.push('--include-assets');

  process.stderr.write('[review sweep] running: ' + sweepArgs.join(' ') + '\n');

  const result = await exec.spawn(sweepArgs);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').toString().trim().slice(0, 300);
    process.stderr.write('[review sweep] aem-ext sweep failed: ' + detail + '\n');
    process.exit(1);
  }

  // Print aem-ext stderr through to our stderr
  if (result.stderr) process.stderr.write(String(result.stderr));

  const lines = String(result.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));

  if (lines.length === 0) {
    process.stderr.write('[review sweep] no cards emitted — backlog is clean\n');
    process.exit(0);
  }

  if (isDryRun) {
    process.stderr.write('[review sweep] dry-run: ' + lines.length + ' card(s):\n');
    for (const line of lines) process.stdout.write(line + '\n');
    process.exit(0);
  }

  let pushed = 0;
  let failed = 0;
  for (const line of lines) {
    let card;
    try {
      card = JSON.parse(line);
    } catch {
      process.stderr.write('[review sweep] WARNING: skipping non-JSON line\n');
      failed++;
      continue;
    }
    if (!card || typeof card !== 'object' || !card.id) {
      process.stderr.write('[review sweep] WARNING: skipping card without id\n');
      failed++;
      continue;
    }

    try {
      await sprinkleSend({
        action: 'ensure-item',
        id: card.id,
        title: card.title || card.id,
        path: card.path || '',
        previewUrl: card.previewUrl || '',
        liveUrl: card.liveUrl || '',
      });
      await sprinkleSend({
        action: 'add-findings',
        id: card.id,
        source: card.source || 'aem-source',
        summary: card.summary || '',
        severity: card.severity || 'info',
        findings: Array.isArray(card.findings) ? card.findings : [],
        ts: card.ts,
      });
      pushed++;
    } catch (err) {
      process.stderr.write(
        '[review sweep] failed to push card ' + card.id + ': ' +
        (err && err.message ? err.message : String(err)) + '\n',
      );
      failed++;
    }
  }

  process.stderr.write(
    '[review sweep] pushed ' + pushed + ' card(s) to sprinkle' +
    (failed ? '; ' + failed + ' failed' : '') + '\n',
  );
  if (failed > 0) process.exit(1);
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

  if (cmd === 'sweep') {
    await cmdSweep();
    process.exit(0);
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

  // Pin the card id before any source runs so a failed Pangram cannot change
  // which card the cliché source (or a later retry) attaches to.
  const id = flags.id ? String(flags.id) : stableCardId(filePath, sources);

  const contributions = [];
  const jobs = sources.map((s) => invokeSource(s, filePath, id));
  const results = await Promise.all(jobs);
  for (const c of results) if (c) contributions.push(c);
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
  if (err && err.name === 'NodeExitError') throw err;
  process.stderr.write((err && err.message ? err.message : String(err)) + '\n');
  process.exit(2);
}
