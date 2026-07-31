// replicate.jsh — Replicate.com CLI client.
//
// Auth (priority order): --token flag | REPLICATE_API_TOKEN env | skill config
// Store a token with: replicate auth login <token>
//
// USAGE
//   replicate auth login <token>         Store API token in skill config
//   replicate auth logout                Remove stored token
//   replicate auth token                 Show masked stored token
//
//   replicate account                    Authenticated account info (GET /v1/account)
//
//   replicate model get <owner/name>     Model details
//   replicate model versions <owner/name>    List versions
//   replicate model schema <owner/name>  Input/output schema from OpenAPI spec
//   replicate models list [--cursor c]   List public models (paginated)
//   replicate models search <query>      Search public models (beta)
//
//   replicate prediction get <id>        Prediction details
//   replicate prediction list            Your predictions (paginated)
//   replicate prediction cancel <id>     Cancel a running prediction
//
//   replicate training get <id>          Training details
//   replicate training list              Your trainings
//
//   replicate deployment list            Your deployments
//
//   replicate hardware list              Available hardware SKUs
//
//   replicate collections list           Curated model collections
//   replicate collections get <slug>     Models in a collection
//
//   replicate run <owner/name[:version]> [key=value ...]   Create prediction + wait
//     Flags: --json  --no-wait  --version <id>  --token <t>
//     Input values: bare strings, numbers, booleans, or JSON objects/arrays.
//     Values starting with { or [ are parsed as JSON.
//
//   replicate api <METHOD> <path> [--data '<json>'] [--query k=v]
//     Raw authenticated HTTP call. METHOD defaults to GET.

const cli   = require('sliccy:cli');
const fmt   = require('sliccy:fmt');
const skill = require('sliccy:skill');
const c     = require('sliccy:color');

const BASE = 'https://api.replicate.com/v1';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Coerce flag values: parseFlags returns boolean true for bare flags;
 *  only return a value when it's actually a string. */
function str(v) { return typeof v === 'string' ? v : undefined; }

// ─── config ──────────────────────────────────────────────────────────────────

async function loadConfig() {
  // skill.config() returns a Promise — always await before `|| {}`.
  return (await skill.config()) || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

async function getToken(explicit) {
  const t = (typeof explicit === 'string' && explicit) ||
            process.env.REPLICATE_API_TOKEN ||
            (await loadConfig()).token;
  if (!t) {
    throw new Error(
      'No Replicate API token found.\n' +
      '  Option 1: replicate auth login <token>\n' +
      '  Option 2: export REPLICATE_API_TOKEN=r8_...\n' +
      '  Option 3: pass --token <token>\n' +
      '  Get a token at https://replicate.com/account/api-tokens'
    );
  }
  return t;
}

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Authenticated JSON fetch against api.replicate.com.
 * method: HTTP verb (GET/POST/PATCH/DELETE)
 * path:   e.g. '/account' or full URL
 * opts.body:    JS object → sent as JSON
 * opts.headers: extra headers (e.g. Prefer)
 * opts.query:   object merged into query string
 * Returns parsed JSON or throws with the API error message.
 */
async function api(token, method, path, { body, headers: extraHeaders, query } = {}) {
  let url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path);
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        'application/json',
    ...extraHeaders,
  };

  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetch(url, { method: method || 'GET', headers, body: payload });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.detail || json?.message || json?.error || text || res.statusText;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Paginate a Replicate list endpoint (cursor-based pagination).
 * Fetches up to maxPages pages; each page has .results[] and optional .next URL.
 * Returns all results concatenated.
 */
async function listAll(token, path, { maxPages = 20, query = {} } = {}) {
  const out = [];
  let url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path);
  if (query && Object.keys(query).length) {
    url += (url.includes('?') ? '&' : '?') + new URLSearchParams(query).toString();
  }
  for (let i = 0; i < maxPages; i++) {
    const data = await api(token, 'GET', url);
    const items = data.results || data.models || [];
    out.push(...items);
    if (!data.next) break;
    url = data.next;
  }
  return out;
}

// ─── input parsing (for `run`) ───────────────────────────────────────────────

/**
 * Parse positional key=value inputs into an object.
 * Values are coerced:
 *   - 'true'/'false' → boolean
 *   - numeric strings → number
 *   - values starting with { or [ → JSON.parse
 *   - everything else → string
 */
function parseInputs(args) {
  const inputs = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq < 0) {
      throw new Error(`Invalid input "${arg}" — expected key=value format`);
    }
    const key = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    let val;
    if (raw === 'true') val = true;
    else if (raw === 'false') val = false;
    else if (raw !== '' && !isNaN(Number(raw))) val = Number(raw);
    else if (raw.startsWith('{') || raw.startsWith('[')) {
      try { val = JSON.parse(raw); } catch { val = raw; }
    } else val = raw;
    inputs[key] = val;
  }
  return inputs;
}

/**
 * Parse <owner/name[:version]> into { owner, name, version }.
 * Accepts:
 *   owner/name
 *   owner/name:version
 *   owner/name:v1.0  (short tags — passed as-is to the API)
 */
function parseModelRef(ref) {
  const m = ref.match(/^([^/]+)\/([^:/]+)(?::(.+))?$/);
  if (!m) throw new Error(`Invalid model reference "${ref}". Expected owner/name[:version].`);
  return { owner: m[1], name: m[2], version: m[3] || null };
}

// ─── poll ────────────────────────────────────────────────────────────────────

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'canceled']);

/**
 * Poll a prediction until it reaches a terminal state.
 * Prints a progress indicator to stderr.
 */
async function pollPrediction(token, prediction, { intervalMs = 2000, timeoutMs = 300_000 } = {}) {
  const start = Date.now();
  let pred = prediction;
  if (TERMINAL_STATES.has(pred.status)) return pred;

  process.stderr.write(c.dim(`Waiting for prediction ${pred.id}…`));
  let dots = 0;
  while (!TERMINAL_STATES.has(pred.status)) {
    if (Date.now() - start > timeoutMs) {
      process.stderr.write('\n');
      throw new Error(`Timed out waiting for prediction ${pred.id} after ${timeoutMs / 1000}s`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
    pred = await api(token, 'GET', `/predictions/${pred.id}`);
    dots++;
    if (dots % 5 === 0) process.stderr.write(c.dim('.'));
  }
  process.stderr.write('\n');
  return pred;
}

// ─── formatters ──────────────────────────────────────────────────────────────

function statusIcon(status) {
  if (status === 'succeeded')  return c.green('✓');
  if (status === 'failed')     return c.red('✗');
  if (status === 'canceled')   return c.yellow('⊘');
  if (status === 'processing') return c.cyan('⟳');
  return c.dim('○');
}

function fmtPrediction(p) {
  const lines = [
    `  ${statusIcon(p.status)} ${c.bold(p.id)}  ${c.dim(p.status)}`,
    `  ${c.dim('model')}    ${p.model || ''}` + (p.version ? c.dim(`  v:${p.version.slice(0, 8)}`) : ''),
    `  ${c.dim('created')}  ${p.created_at || ''}`,
  ];
  if (p.urls?.get) lines.push(`  ${c.dim('url')}      ${p.urls.get}`);
  if (p.error) lines.push(`  ${c.red('error')}    ${p.error}`);
  return lines.join('\n');
}

function printOutput(output) {
  if (output === null || output === undefined) return;
  if (typeof output === 'string') { console.log(output); return; }
  if (Array.isArray(output)) {
    for (const item of output) console.log(typeof item === 'string' ? item : JSON.stringify(item));
    return;
  }
  console.log(JSON.stringify(output, null, 2));
}

// ─── subcommands ─────────────────────────────────────────────────────────────

async function cmdAuth(positional, flags) {
  const sub = positional[0];
  if (sub === 'login' || sub === 'store') {
    const token = str(flags.token) || positional[1];
    if (!token) return cli.die('usage: replicate auth login <token>  (get one at https://replicate.com/account/api-tokens)');
    if (!token.startsWith('r8_')) {
      process.stderr.write(c.yellow('Warning: token does not start with r8_ — verify it is a valid Replicate API token.\n'));
    }
    await saveConfig({ token });
    return console.log(c.green('✓ API token saved to skill config.'));
  }
  if (sub === 'logout') {
    const cfg = await loadConfig();
    if (!cfg.token) return console.log(c.dim('No token stored.'));
    await saveConfig({ token: undefined });
    return console.log(c.green('✓ Token removed from skill config.'));
  }
  if (sub === 'token' || sub === 'status' || sub === 'show') {
    const cfg = await loadConfig();
    const t = cfg.token;
    if (!t) return console.log(c.dim('No token stored. Run: replicate auth login <token>'));
    return console.log(`Stored token: ${c.cyan(t.slice(0, 6))}…${c.dim(t.slice(-4))}`);
  }
  // bare `replicate auth` → show status
  const cfg = await loadConfig();
  const stored = !!cfg.token;
  const envSet = !!process.env.REPLICATE_API_TOKEN;
  console.log('');
  console.log(`  ${c.dim('token stored')}  ${stored ? c.green('yes') : c.dim('no')}`);
  console.log(`  ${c.dim('env var set')}   ${envSet  ? c.green('yes') : c.dim('no')}`);
  if (!stored && !envSet) {
    console.log(`\n  ${c.yellow('Not authenticated.')} Run: replicate auth login <token>`);
  }
}

async function cmdAccount(token, flags) {
  const data = await api(token, 'GET', '/account');
  if (flags.json) return cli.out(data);
  console.log('');
  console.log(`  ${c.cyan(c.bold(data.username || data.name || '?'))}`);
  if (data.name && data.name !== data.username) console.log(`  ${c.dim(data.name)}`);
  console.log(`  ${c.dim('type')}  ${data.type || '?'}`);
  if (data.github_url) console.log(`  ${c.dim('github')} ${data.github_url}`);
}

async function cmdModelGet(token, ref, flags) {
  const { owner, name } = parseModelRef(ref);
  const m = await api(token, 'GET', `/models/${owner}/${name}`);
  if (flags.json) return cli.out(m);
  console.log('');
  console.log(`  ${c.cyan(c.bold(`${m.owner}/${m.name}`))}`);
  if (m.description) console.log(`  ${c.dim(m.description)}`);
  console.log(`  ${c.dim('url')}            ${m.url || ''}`);
  console.log(`  ${c.dim('visibility')}     ${m.visibility || ''}`);
  console.log(`  ${c.dim('run_count')}      ${(m.run_count || 0).toLocaleString()}`);
  if (m.latest_version) {
    console.log(`  ${c.dim('latest_version')} ${m.latest_version.id}`);
    console.log(`  ${c.dim('version_date')}   ${m.latest_version.created_at || ''}`);
  }
}

async function cmdModelVersions(token, ref, flags) {
  const { owner, name } = parseModelRef(ref);
  const data = await api(token, 'GET', `/models/${owner}/${name}/versions`);
  const versions = data.results || [];
  if (flags.json) return cli.out(versions);
  if (!versions.length) return console.log(c.dim('  No versions found.'));
  console.log('');
  const rows = [['version_id', 'created_at']];
  for (const v of versions) rows.push([v.id, v.created_at || '']);
  console.log(fmt.table(rows));
}

async function cmdModelSchema(token, ref, flags) {
  const { owner, name, version: versionArg } = parseModelRef(ref);
  let versionId = versionArg;

  if (!versionId) {
    const m = await api(token, 'GET', `/models/${owner}/${name}`);
    versionId = m.latest_version?.id;
    if (!versionId) throw new Error(`No latest_version found for ${owner}/${name}. Specify a version: ${owner}/${name}:<version_id>`);
  }

  const v = await api(token, 'GET', `/models/${owner}/${name}/versions/${versionId}`);
  if (flags.json) return cli.out(v.openapi_schema || {});

  const inputProps  = v.openapi_schema?.components?.schemas?.Input?.properties  || {};
  const outputProps = v.openapi_schema?.components?.schemas?.Output?.properties || {};
  const required    = v.openapi_schema?.components?.schemas?.Input?.required    || [];

  console.log('');
  console.log(`  ${c.cyan(c.bold(`${owner}/${name}`))}  ${c.dim(`v:${versionId.slice(0, 16)}…`)}`);
  console.log('');
  console.log(`  ${c.bold('Inputs:')}`);
  if (!Object.keys(inputProps).length) {
    console.log(`  ${c.dim('  (no documented inputs)')}`);
  } else {
    for (const [key, prop] of Object.entries(inputProps)) {
      const req  = required.includes(key) ? c.yellow(' *required') : '';
      const type = prop.type || prop.allOf?.[0]?.type || '?';
      const desc = prop.description ? c.dim(`  — ${prop.description.split('\n')[0].slice(0, 60)}`) : '';
      const def  = prop.default !== undefined ? c.dim(`  default=${JSON.stringify(prop.default)}`) : '';
      console.log(`    ${c.cyan(key.padEnd(28))} ${c.dim(type.padEnd(10))}${req}${def}${desc}`);
    }
  }
  console.log('');
  console.log(`  ${c.bold('Output:')}`);
  const outputType = v.openapi_schema?.components?.schemas?.Output?.type || 'unknown';
  console.log(`    ${c.dim('type: ' + outputType)}`);
  if (Object.keys(outputProps).length) {
    for (const [k, p] of Object.entries(outputProps)) {
      console.log(`    ${c.cyan(k)}  ${c.dim(p.type || '?')}`);
    }
  }
}

async function cmdModelsList(token, flags) {
  const models = await listAll(token, '/models', { maxPages: 1 });
  if (flags.json) return cli.out(models);
  if (!models.length) return console.log(c.dim('  No models found.'));
  console.log('');
  const rows = [['owner/name', 'run_count', 'visibility', 'description']];
  for (const m of models) {
    rows.push([
      `${m.owner}/${m.name}`,
      (m.run_count || 0).toLocaleString(),
      m.visibility || '',
      fmt.trunc(m.description || '', 50),
    ]);
  }
  console.log(fmt.table(rows));
}

async function cmdModelsSearch(token, query, flags) {
  if (!query) return cli.die('usage: replicate models search <query>');
  const limit = str(flags.limit) || '10';
  const data = await api(token, 'GET', '/search', { query: { query, limit } });
  const models = data.models || [];
  if (flags.json) return cli.out(data);
  if (!models.length) {
    console.log(c.dim(`  No results for "${query}".`));
    return;
  }
  console.log('');
  for (const { model: m, metadata } of models) {
    const score = metadata?.score ? c.dim(` score=${metadata.score.toFixed(2)}`) : '';
    console.log(`  ${c.cyan(c.bold(`${m.owner}/${m.name}`))}${score}`);
    if (m.description) console.log(`    ${c.dim(m.description.slice(0, 80))}`);
    if (metadata?.tags?.length) console.log(`    ${c.dim('tags: ' + metadata.tags.join(', '))}`);
  }
}

async function cmdPredictionGet(token, id, flags) {
  if (!id) return cli.die('usage: replicate prediction get <id>');
  const p = await api(token, 'GET', `/predictions/${id}`);
  if (flags.json) return cli.out(p);
  console.log('');
  console.log(fmtPrediction(p));
  if (p.output) {
    console.log(`\n  ${c.bold('Output:')}`);
    if (Array.isArray(p.output)) {
      p.output.forEach((o, i) => console.log(`    [${i}] ${o}`));
    } else {
      console.log('  ' + (typeof p.output === 'string' ? p.output : JSON.stringify(p.output, null, 2)));
    }
  }
  if (p.logs) {
    console.log(`\n  ${c.dim('─── logs ───')}`);
    const lines = p.logs.split('\n').slice(-10);
    for (const l of lines) console.log(`  ${c.dim(l)}`);
  }
}

async function cmdPredictionList(token, flags) {
  const preds = await listAll(token, '/predictions', { maxPages: 1 });
  if (flags.json) return cli.out(preds);
  if (!preds.length) return console.log(c.dim('  No predictions found.'));
  console.log('');
  const rows = [['id', 'status', 'model', 'created_at']];
  for (const p of preds) {
    rows.push([p.id, p.status || '', p.model || '', p.created_at?.slice(0, 19) || '']);
  }
  console.log(fmt.table(rows));
}

async function cmdPredictionCancel(token, id, flags) {
  if (!id) return cli.die('usage: replicate prediction cancel <id>');
  const p = await api(token, 'POST', `/predictions/${id}/cancel`);
  if (flags.json) return cli.out(p);
  console.log(c.green(`✓ Prediction ${id} cancel requested`) + c.dim(`  status: ${p.status}`));
}

async function cmdTrainingGet(token, id, flags) {
  if (!id) return cli.die('usage: replicate training get <id>');
  const t = await api(token, 'GET', `/trainings/${id}`);
  if (flags.json) return cli.out(t);
  console.log('');
  const icon = statusIcon(t.status);
  console.log(`  ${icon} ${c.bold(t.id)}  ${c.dim(t.status)}`);
  if (t.model) console.log(`  ${c.dim('model')}    ${t.model}`);
  if (t.version) console.log(`  ${c.dim('version')}  ${t.version}`);
  console.log(`  ${c.dim('created')}  ${t.created_at || ''}`);
  if (t.output) {
    console.log(`\n  ${c.bold('Output (weights/version):')}`);
    console.log('  ' + JSON.stringify(t.output, null, 2));
  }
  if (t.error) console.log(`  ${c.red('error')}    ${t.error}`);
}

async function cmdTrainingList(token, flags) {
  const trainings = await listAll(token, '/trainings', { maxPages: 1 });
  if (flags.json) return cli.out(trainings);
  if (!trainings.length) return console.log(c.dim('  No trainings found.'));
  console.log('');
  const rows = [['id', 'status', 'model', 'created_at']];
  for (const t of trainings) {
    rows.push([t.id, t.status || '', t.model || '', t.created_at?.slice(0, 19) || '']);
  }
  console.log(fmt.table(rows));
}

async function cmdDeploymentList(token, flags) {
  const deps = await listAll(token, '/deployments', { maxPages: 1 });
  if (flags.json) return cli.out(deps);
  if (!deps.length) return console.log(c.dim('  No deployments found.'));
  console.log('');
  const rows = [['name', 'owner', 'current_release.model', 'current_release.hardware']];
  for (const d of deps) {
    const cr = d.current_release || {};
    rows.push([
      d.name || '',
      d.owner || '',
      cr.model || '',
      cr.hardware || '',
    ]);
  }
  console.log(fmt.table(rows));
}

async function cmdHardwareList(token, flags) {
  const hw = await api(token, 'GET', '/hardware');
  if (flags.json) return cli.out(hw);
  console.log('');
  const rows = [['sku', 'name']];
  for (const h of (hw || [])) rows.push([h.sku || '', h.name || '']);
  console.log(fmt.table(rows));
}

async function cmdCollectionsList(token, flags) {
  const data = await api(token, 'GET', '/collections');
  const cols = data.results || [];
  if (flags.json) return cli.out(cols);
  if (!cols.length) return console.log(c.dim('  No collections found.'));
  console.log('');
  const rows = [['slug', 'name', 'description']];
  for (const col of cols) {
    rows.push([col.slug || '', col.name || '', fmt.trunc(col.description || '', 60)]);
  }
  console.log(fmt.table(rows));
}

async function cmdCollectionsGet(token, slug, flags) {
  if (!slug) return cli.die('usage: replicate collections get <slug>');
  const data = await api(token, 'GET', `/collections/${slug}`);
  if (flags.json) return cli.out(data);
  const models = data.models || [];
  console.log('');
  console.log(`  ${c.cyan(c.bold(data.name || slug))}`);
  if (data.description) console.log(`  ${c.dim(data.description)}`);
  console.log('');
  if (!models.length) { console.log(c.dim('  (no models)')); return; }
  const rows = [['owner/name', 'run_count', 'description']];
  for (const m of models) {
    rows.push([`${m.owner}/${m.name}`, (m.run_count || 0).toLocaleString(), fmt.trunc(m.description || '', 55)]);
  }
  console.log(fmt.table(rows));
}

async function cmdRun(token, positional, flags) {
  // positional[0] = owner/name[:version], rest = key=value inputs
  const ref = positional[0];
  if (!ref) return cli.die('usage: replicate run <owner/name[:version]> [key=value ...]\n       replicate run black-forest-labs/flux-schnell prompt="a cat"');

  const { owner, name, version: versionFromRef } = parseModelRef(ref);
  const versionOverride = str(flags.version) || versionFromRef;

  // Parse key=value inputs from remaining positional args
  const inputArgs = positional.slice(1);
  const inputs = parseInputs(inputArgs);

  // Determine version: explicit > from ref > from model latest_version
  let versionId = versionOverride;
  if (!versionId) {
    // Fetch model to get latest version — needed for POST /v1/predictions body
    try {
      const model = await api(token, 'GET', `/models/${owner}/${name}`);
      versionId = model.latest_version?.id;
    } catch (e) {
      // Non-fatal: model lookup failed, try without version (official model API path)
    }
  }

  // Build request body
  let reqBody;
  let endpoint;
  if (versionId) {
    // Standard path: POST /v1/predictions with explicit version
    reqBody = { version: versionId, input: inputs };
    endpoint = '/predictions';
  } else {
    // Official model path: POST /v1/models/<owner>/<name>/predictions
    reqBody = { input: inputs };
    endpoint = `/models/${owner}/${name}/predictions`;
  }

  const noWait = Boolean(flags['no-wait']);
  const preferHeader = noWait ? {} : { 'Prefer': 'wait=60' };

  console.log(c.dim(`Creating prediction for ${owner}/${name}${versionId ? ` (v:${versionId.slice(0, 12)}…)` : ''}…`));

  let prediction = await api(token, 'POST', endpoint, {
    body: reqBody,
    headers: preferHeader,
  });

  if (noWait) {
    if (flags.json) return cli.out(prediction);
    console.log(`Prediction created: https://replicate.com/p/${prediction.id}  ${c.dim('(not waiting — use: replicate prediction get ' + prediction.id + ')')}`);
    return;
  }

  // If the Prefer: wait=60 sync response didn't finish, poll
  if (!TERMINAL_STATES.has(prediction.status)) {
    prediction = await pollPrediction(token, prediction);
  }

  if (flags.json) return cli.out(prediction);

  if (prediction.status === 'succeeded') {
    printOutput(prediction.output);
  } else if (prediction.status === 'failed') {
    console.error(c.red('Prediction failed') + (prediction.error ? `: ${prediction.error}` : ''));
    if (prediction.logs) {
      const logLines = prediction.logs.split('\n').slice(-20);
      console.error(c.dim(logLines.join('\n')));
    }
    process.exit(1);
  } else if (prediction.status === 'canceled') {
    console.error(c.yellow('Prediction was canceled.'));
    process.exit(1);
  }
}

async function cmdApi(token, positional, flags) {
  let method = 'GET', path;
  if (positional.length >= 2 && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(positional[0])) {
    method = positional[0].toUpperCase();
    path = positional[1];
  } else {
    path = positional[0];
  }
  if (!path) return cli.die('usage: replicate api [METHOD] <path-or-url> [--data <json>] [--query k=v]');

  let body;
  const rawData = str(flags.data) || str(flags.d);
  if (rawData) {
    try { body = JSON.parse(rawData); } catch { body = rawData; }
  }

  const query = {};
  const queryFlag = str(flags.query) || str(flags.q);
  if (queryFlag) {
    const [k, ...rest] = queryFlag.split('=');
    query[k] = rest.join('=');
  }

  const result = await api(token, method, path, { body, query });
  cli.out(result);
}

// ─── HELP ─────────────────────────────────────────────────────────────────────

const HELP = `
replicate — Replicate.com CLI client

USAGE
  replicate auth login <token>         Store API token in skill config
  replicate auth logout                Remove stored token
  replicate auth token                 Show masked stored token

  replicate account                    Authenticated account info

  replicate model get <owner/name>     Model details
  replicate model versions <owner/name>    List versions
  replicate model schema <owner/name>  Input/output schema
  replicate models list                List public models (first page)
  replicate models search <query>      Search public models (beta)

  replicate prediction get <id>        Prediction details
  replicate prediction list            Your predictions
  replicate prediction cancel <id>     Cancel a prediction

  replicate training get <id>          Training details
  replicate training list              Your trainings

  replicate deployment list            Your deployments

  replicate hardware list              Available hardware SKUs

  replicate collections list           Curated model collections
  replicate collections get <slug>     Models in a collection

  replicate run <owner/name[:version]> [key=value ...]
    Create a prediction and wait for output.
    Input values: strings, numbers (auto-detected), booleans (true/false),
    or JSON objects/arrays (values starting with { or [).
    Example: replicate run black-forest-labs/flux-schnell prompt="a cat"
    Flags: --json (emit raw JSON)  --no-wait (return immediately)
           --version <id> (override version)  --token <t>

  replicate api [METHOD] <path-or-url> [--data '<json>'] [--query k=v]
    Authenticated raw API call. METHOD defaults to GET.
    Example: replicate api /account
    Example: replicate api GET /models/stability-ai/sdxl

AUTH
  Token priority: --token <t>  |  REPLICATE_API_TOKEN env  |  stored config
  Get a token at https://replicate.com/account/api-tokens

FLAGS
  --json       Output raw JSON
  --token <t>  Override token for this call
  --help       Show this help
`.trim();

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags, subcommand } = process.argv.parseFlags();
  // positional includes all positional words starting with the command.
  // subcommand is an alias for positional[0] (the first word after the script name).
  // rest = everything after the first word (sub-action + args).
  const cmd = positional[0] || subcommand;
  const rest = positional.slice(1);

  if (!cmd || flags.help || flags.h) return cli.help(HELP);

  // auth does not need a token
  if (cmd === 'auth') return await cmdAuth(rest, flags);

  // all other commands need a token — resolve it
  // --token may appear as a flag value; str() guards against bare boolean true
  const token = await getToken(str(flags.token));

  // normalize aliases so `replicate predictions` → `replicate prediction list`
  // and `replicate models` → `replicate model list`
  const sub0 = rest[0]; // first positional after the subcommand (e.g. "list", "get", …)

  try {
    switch (cmd) {
      // ── account ──
      case 'account':
      case 'whoami':
        return await cmdAccount(token, flags);

      // ── model(s) ──
      case 'model':
      case 'models': {
        const action = sub0;
        if (!action || action === 'list') return await cmdModelsList(token, flags);
        if (action === 'search')          return await cmdModelsSearch(token, rest[1], flags);
        if (action === 'get')             return await cmdModelGet(token, rest[1], flags);
        if (action === 'versions')        return await cmdModelVersions(token, rest[1], flags);
        if (action === 'schema')          return await cmdModelSchema(token, rest[1], flags);
        // `replicate models <owner/name>` — treat bare owner/name as "get"
        if (action && action.includes('/') && !['list','search','get','versions','schema'].includes(action))
          return await cmdModelGet(token, action, flags);
        return cli.die(`unknown model subcommand: ${action}\nRun 'replicate model --help' for usage.`);
      }

      // ── prediction(s) ──
      case 'prediction':
      case 'predictions': {
        const action = sub0;
        if (!action || action === 'list') return await cmdPredictionList(token, flags);
        if (action === 'get')             return await cmdPredictionGet(token, rest[1], flags);
        if (action === 'cancel')          return await cmdPredictionCancel(token, rest[1], flags);
        // bare id — treat as "get"
        if (action && /^[a-z0-9]{25,30}$/.test(action)) return await cmdPredictionGet(token, action, flags);
        return cli.die(`unknown prediction subcommand: ${action}`);
      }

      // ── training(s) ──
      case 'training':
      case 'trainings': {
        const action = sub0;
        if (!action || action === 'list') return await cmdTrainingList(token, flags);
        if (action === 'get')             return await cmdTrainingGet(token, rest[1], flags);
        if (action && /^[a-z0-9]{25,30}$/.test(action)) return await cmdTrainingGet(token, action, flags);
        return cli.die(`unknown training subcommand: ${action}`);
      }

      // ── deployment(s) ──
      case 'deployment':
      case 'deployments':
        return await cmdDeploymentList(token, flags);

      // ── hardware ──
      case 'hardware':
        return await cmdHardwareList(token, flags);

      // ── collections ──
      case 'collection':
      case 'collections': {
        const action = sub0;
        if (!action || action === 'list') return await cmdCollectionsList(token, flags);
        if (action === 'get')             return await cmdCollectionsGet(token, rest[1], flags);
        // bare slug
        if (action && !['list','get'].includes(action)) return await cmdCollectionsGet(token, action, flags);
        return cli.die(`unknown collections subcommand: ${action}`);
      }

      // ── run (alias for prediction create) ──
      case 'run':
        return await cmdRun(token, rest, flags);

      // ── raw API ──
      case 'api':
        return await cmdApi(token, rest, flags);

      default:
        // If the first positional looks like owner/name, treat as `model get`
        if (cmd.includes('/')) return await cmdModelGet(token, cmd, flags);
        return cli.die(`unknown command: ${cmd}\nRun 'replicate --help' for usage.`);
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err; // mandatory re-throw
    cli.die(err.message + (err.status ? ` (HTTP ${err.status})` : ''), { prefix: 'replicate' });
  }
}

await main().catch((e) => {
  if (e?.name === 'NodeExitError') throw e;
  require('sliccy:cli').die(e.message, { prefix: 'replicate' });
});
