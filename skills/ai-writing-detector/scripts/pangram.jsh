// pangram.jsh — Pangram AI-text detection CLI
// Docs: https://docs.pangram.com/api-reference/ai-detection
//
// Usage:
//   pangram <file|-> [--json] [--model <selector>] [--dashboard] [--no-wait]
//   pangram review --path <file> [--id <id>]
//   pangram models
//   pangram login
//
// Auth: PANGRAM_API_KEY, else skill.config().apiKey (pangram login).
// Never pass the key on the command line.

const fs = require('fs');
const skill = require('sliccy:skill');
const cli = require('sliccy:cli');

const BASE = 'https://text.external-api.pangram.com';
const DEFAULT_MODEL = 'pangram-4';
const MAX_POLLS = 60;
const POLL_MS = 500;

// jsh setTimeout never fires. Spin so MAX_POLLS is an elapsed-time window
// (~30s) rather than a burst of back-to-back GETs.
function pause(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

function helpText() {
  return [
    'Usage: pangram <file|-> [--json] [--model <selector>] [--dashboard] [--no-wait]',
    '       pangram review --path <file> [--id <id>]',
    '       pangram models',
    '       pangram login',
    '',
    'Detect AI-generated text via Pangram (async POST /task, poll GET /task/{id}).',
    '',
    '  --json         machine-readable result',
    '  --model NAME   selector from `pangram models` (default: pangram-4)',
    '  --dashboard    request a public dashboard link',
    '  --no-wait      print task_id and exit without polling',
    '',
    'Auth: export PANGRAM_API_KEY, or run `pangram login` with that env set.',
  ].join('\n') + '\n';
}

async function loadConfig() {
  return (await skill.config()) || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  return await skill.config({ ...cur, ...updates });
}

async function apiKey() {
  const env = (process.env.PANGRAM_API_KEY || '').trim();
  if (env) return env;
  const cfg = await loadConfig();
  const stored = (cfg.apiKey || cfg.api_key || '').trim();
  if (stored) return stored;
  return '';
}

function requireKey(key) {
  if (key) return;
  cli.die(
    'No Pangram API key. Export PANGRAM_API_KEY or run `pangram login` with that env set.',
    { exitCode: 2, prefix: '' }
  );
}

async function pangramFetch(path, key, opts) {
  const res = await fetch(BASE + path, {
    method: (opts && opts.method) || 'GET',
    headers: {
      'x-api-key': key,
      ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  if (!res.ok) {
    const msg =
      (json && (json.message || json.error || json.headline)) ||
      text.slice(0, 240) ||
      ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

async function submit(key, text, model, dashboard) {
  return pangramFetch('/task', key, {
    method: 'POST',
    body: {
      text,
      model: model || DEFAULT_MODEL,
      public_dashboard_link: !!dashboard,
    },
  });
}

async function poll(key, taskId) {
  let last = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    last = await pangramFetch('/task/' + encodeURIComponent(taskId), key);
    const stage = last && last.stage;
    if (stage === 'STAGE_SUCCESS' || stage === 'STAGE_FAILED') return last;
    pause(POLL_MS);
  }
  const err = new Error(
    'Pangram task ' + taskId + ' still ' + ((last && last.stage) || 'unknown') + ' after ' + MAX_POLLS + ' polls'
  );
  err.body = last;
  throw err;
}

function severityOf(result) {
  const short = (result && result.prediction_short) || '';
  if (short === 'AI') return 'fail';
  if (short === 'Mixed') return 'warn';
  return 'info';
}

function pct(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 'n/a';
  return Math.round(n * 100) + '%';
}

function findingsFrom(result) {
  const windows = (result && result.windows) || [];
  return windows
    .filter((w) => w && w.label && w.label !== 'Human Written')
    .map((w) => ({
      severity: w.confidence === 'High' ? 'fail' : 'warn',
      title: w.label,
      body:
        (w.confidence ? w.confidence + ' confidence' : '') +
        (typeof w.ai_assistance_score === 'number'
          ? ' · score ' + w.ai_assistance_score.toFixed(2)
          : ''),
      start: w.start_index,
      end: w.end_index,
      line: undefined,
    }));
}

function formatMarkdown(filePath, result) {
  const lines = [];
  lines.push('# Pangram analysis');
  lines.push('');
  lines.push('**File:** `' + filePath + '`');
  lines.push('**Headline:** ' + (result.headline || result.prediction_short || '—'));
  lines.push('**Prediction:** ' + (result.prediction_short || '—'));
  if (result.prediction) lines.push('**Detail:** ' + result.prediction);
  lines.push(
    '**Mix:** AI ' +
      pct(result.fraction_ai) +
      ' · assisted ' +
      pct(result.fraction_ai_assisted) +
      ' · human ' +
      pct(result.fraction_human)
  );
  if (result.dashboard_link) lines.push('**Dashboard:** ' + result.dashboard_link);
  lines.push('');
  const windows = result.windows || [];
  if (windows.length) {
    lines.push('## Windows');
    lines.push('');
    for (const w of windows) {
      const score =
        typeof w.ai_assistance_score === 'number' ? w.ai_assistance_score.toFixed(2) : '—';
      lines.push(
        '- ' +
          (w.label || 'n/a') +
          ' (' +
          (w.confidence || '?') +
          ', ' +
          score +
          ') [' +
          w.start_index +
          ',' +
          w.end_index +
          ')'
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function contribution(filePath, id, result) {
  const short = result.prediction_short || result.headline || 'unknown';
  return {
    source: 'pangram',
    id: id || ('pangram:' + filePath),
    path: filePath,
    title: String(filePath).split('/').pop(),
    summary:
      short +
      ' · AI ' +
      pct(result.fraction_ai) +
      ' · assisted ' +
      pct(result.fraction_ai_assisted) +
      ' · human ' +
      pct(result.fraction_human),
    severity: severityOf(result),
    findings: findingsFrom(result),
    ts: new Date().toISOString(),
    meta: {
      prediction_short: result.prediction_short,
      headline: result.headline,
      fraction_ai: result.fraction_ai,
      fraction_ai_assisted: result.fraction_ai_assisted,
      fraction_human: result.fraction_human,
      version: result.version,
    },
  };
}

async function readInput(filePath) {
  if (filePath === '-') {
    const chunk = await process.stdin.read();
    return chunk == null ? '' : String(chunk);
  }
  return await fs.readFile(filePath, 'utf8');
}

async function analyseFile(filePath, flags) {
  const key = await apiKey();
  requireKey(key);
  const text = await readInput(filePath);
  if (!String(text).trim()) cli.die('Input is empty.', { exitCode: 2, prefix: '' });
  const submitted = await submit(key, text, flags.model, flags.dashboard);
  const taskId = submitted && submitted.task_id;
  if (!taskId) cli.die('Pangram POST /task returned no task_id', { exitCode: 1, prefix: '' });
  if (flags['no-wait'] || flags.noWait) {
    return { task_id: taskId, stage: 'submitted' };
  }
  process.stderr.write('[pangram] task ' + taskId + '\n');
  const result = await poll(key, taskId);
  if (result.stage === 'STAGE_FAILED') {
    const err = new Error(result.headline || 'Pangram task failed');
    err.body = result;
    throw err;
  }
  return result;
}

const parsed = process.argv.parseFlags();
const { positional, flags, subcommand } = parsed;
const cmd = subcommand || positional[0];

try {
  if (flags.help || flags.h || cmd === 'help') {
    process.stdout.write(helpText());
    process.exit(0);
  }

  if (cmd === 'login') {
    const env = (process.env.PANGRAM_API_KEY || '').trim();
    if (!env) {
      cli.die(
        'Set PANGRAM_API_KEY in the environment, then re-run `pangram login`. The key is not accepted as a flag.',
        { exitCode: 2, prefix: '' }
      );
    }
    await saveConfig({ apiKey: env });
    process.stderr.write('[pangram] stored API key in skill config (gitignored).\n');
    process.exit(0);
  }

  if (cmd === 'models') {
    const key = await apiKey();
    requireKey(key);
    const body = await pangramFetch('/models', key);
    if (flags.json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    else process.stdout.write(((body && body.models) || []).join('\n') + '\n');
    process.exit(0);
  }

  if (cmd === 'review') {
    const filePath = flags.path || positional[1];
    if (!filePath) cli.die('usage: pangram review --path PATH [--id ID]', { exitCode: 2, prefix: '' });
    const result = await analyseFile(filePath, flags);
    process.stdout.write(JSON.stringify(contribution(filePath, flags.id, result)) + '\n');
    process.exit(0);
  }

  const filePath = cmd === 'pangram' ? positional[1] : positional[0];
  if (!filePath) {
    process.stderr.write(helpText());
    process.exit(2);
  }
  const result = await analyseFile(filePath, flags);
  if (flags.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(formatMarkdown(filePath, result));
} catch (err) {
  if (err && err.name === 'NodeExitError') throw err;
  const extra = err && err.status ? ' (HTTP ' + err.status + ')' : '';
  process.stderr.write((err && err.message ? err.message : String(err)) + extra + '\n');
  process.exit(err && err.status === 401 ? 2 : 1);
}
