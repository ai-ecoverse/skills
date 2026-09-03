// wavespeed.jsh — WaveSpeed AI API client for SLICC.
//
//   wavespeed auth <key>                              store API key in skill config
//   wavespeed auth --show                              show masked stored key
//   wavespeed models [term] [--json] [--limit N] [--all]
//   wavespeed schema <model_id> [--json]
//   wavespeed upload <file>
//   wavespeed run <model_id> [--input k=v ...] [--json-input <file>] [--wait]
//                [--webhook [name]] [--poll-interval s] [--timeout s] [--out path] [--json]
//   wavespeed status <task_id> [--json]
//   wavespeed get <task_id> [--out path] [--index n] [--json]
//   wavespeed reconcile [--status s] [--model id] [--since 24h] [--page-size n] [--json]
//   wavespeed webhook create [--name name] | list | secret
//   wavespeed api <METHOD> <path> [--data '<json>'] [--query k=v]
//
// Auth priority: --key | WAVESPEED_API_KEY | skill config (`wavespeed auth <key>`) |
//                /shared/.secrets/wavespeed-api-key (read-only fallback).
//
// Callbacks: WaveSpeedAI supports a `?webhook=<url>` query param on task submission
// (see /docs/how-to-use-webhooks). This CLI wires it up via `wavespeed webhook create`
// (a thin wrapper over the SLICC `webhook` shell command) + `run --webhook [name]`.
// The URL is re-resolved from `webhook list` at submit time — NEVER cached — because
// webhook URLs embed the tray id and a tray reset makes a saved string 410
// TRAY_EXPIRED while the WaveSpeed job still reports success. `reconcile` is the
// polling-based backstop for a callback that never arrives (long jobs can outlive
// the tray that issued the URL).

const cli = require('sliccy:cli');
const fmt = require('sliccy:fmt');
const color = require('sliccy:color');
const http = require('sliccy:http');
const skill = require('sliccy:skill');
const time = require('sliccy:time');
const { exec } = require('sliccy:exec');
const fs = require('fs');

const BASE = 'https://api.wavespeed.ai';
const SECRETS_FALLBACK = '/shared/.secrets/wavespeed-api-key';
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout', 'deleted']);

function str(v) { return typeof v === 'string' ? v : undefined; }
function asList(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }

const HELP = `wavespeed — WaveSpeed AI API client

  wavespeed auth <key> | --show
  wavespeed models [term] [--json] [--limit N] [--all]
  wavespeed schema <model_id> [--json]
  wavespeed upload <file>
  wavespeed run <model_id> [--input k=v ...] [--json-input <file>] [--wait]
                [--webhook [name]] [--poll-interval s] [--timeout s] [--out path] [--json]
  wavespeed status <task_id> [--json]
  wavespeed get <task_id> [--out path] [--index n] [--json]
  wavespeed reconcile [--status s] [--model id] [--since 24h] [--page-size n] [--json]
  wavespeed webhook create [--name name] | list | secret
  wavespeed api <METHOD> <path> [--data '<json>'] [--query k=v]

Auth: --key <k> | WAVESPEED_API_KEY | \`wavespeed auth <key>\` | ${SECRETS_FALLBACK}

Webhooks: pass --webhook (or --webhook <name>, default "wavespeed") to \`run\` to
attach a callback URL instead of polling. Create it once with
\`wavespeed webhook create\`. The URL is re-read from \`webhook list\` on every
submit — never cached — since a tray reset invalidates old URLs silently.
If a callback is lost, \`wavespeed reconcile\` recovers it from task history.`;

// ─── config / auth ──────────────────────────────────────────────────────────

async function loadConfig() {
  return (await skill.config()) || {};
}

async function getKey(explicit) {
  if (typeof explicit === 'string' && explicit) return explicit;
  if (process.env.WAVESPEED_API_KEY) return process.env.WAVESPEED_API_KEY;
  const cfg = await loadConfig();
  if (cfg.apiKey) return cfg.apiKey;
  try {
    const fromFile = (await fs.readFile(SECRETS_FALLBACK)).trim();
    if (fromFile) return fromFile;
  } catch { /* no fallback file — fall through to the error below */ }
  throw new Error(
    'No WaveSpeed API key. Set one with `wavespeed auth <key>`, pass --key, ' +
    `export WAVESPEED_API_KEY, or place one at ${SECRETS_FALLBACK}.`);
}

function client(key) {
  return http.client({
    baseUrl: BASE,
    token: () => key,
    retry: { on: [429, 500, 502, 503, 504], maxAttempts: 4 },
    timeoutMs: 120000,
  });
}

// ─── model catalog ──────────────────────────────────────────────────────────
// `?search=` on GET /api/v3/models is silently ignored by the API (verified —
// it returns the unfiltered catalog regardless), and `page`/`size` turned out
// to be no-ops too: every page/size combination we tried returned the same
// ~1018-model catalog in one response. We still pass page/size (in case that
// ever changes) and paginate defensively, but the practical behavior today is
// "one ~1.8MB fetch, filter client-side."
async function fetchModels(api) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= 10; page++) {
    const j = await api.get('/api/v3/models', { params: { page, size: 500 } });
    const data = (j && j.data) || [];
    if (!data.length) break;
    let added = 0;
    for (const m of data) {
      if (!seen.has(m.model_id)) { seen.add(m.model_id); all.push(m); added++; }
    }
    if (added === 0) break; // server ignored pagination and handed back the same set
    if (data.length < 500) break;
  }
  return all;
}

function findModel(models, modelId) {
  return models.find((m) => m.model_id === modelId);
}

function requestSchemaOf(model) {
  return model && model.api_schema && model.api_schema.api_schemas
    && model.api_schema.api_schemas[0] && model.api_schema.api_schemas[0].request_schema;
}

// ─── input coercion (CLI strings → JSON-typed request body) ───────────────

function coerceScalar(v, propSchema) {
  if (typeof v !== 'string') return v;
  const t = propSchema && propSchema.type;
  if (t === 'boolean') { if (v === 'true') return true; if (v === 'false') return false; return v; }
  if (t === 'integer') { const n = parseInt(v, 10); return Number.isNaN(n) ? v : n; }
  if (t === 'number') { const n = parseFloat(v); return Number.isNaN(n) ? v : n; }
  return v;
}

function coerceValue(raw, propSchema) {
  const isArrayField = propSchema && propSchema.type === 'array';
  if (Array.isArray(raw)) return raw.map((v) => coerceScalar(v, propSchema && propSchema.items));
  if (isArrayField) return [coerceScalar(raw, propSchema.items)];
  return coerceScalar(raw, propSchema);
}

function parseInputFlags(inputFlag) {
  const out = {};
  for (const item of asList(inputFlag)) {
    const eq = String(item).indexOf('=');
    if (eq === -1) throw new Error(`--input must be key=value (got "${item}")`);
    const k = item.slice(0, eq);
    const v = item.slice(eq + 1);
    if (k in out) { if (Array.isArray(out[k])) out[k].push(v); else out[k] = [out[k], v]; }
    else out[k] = v;
  }
  return out;
}

// ─── webhooks: create/list wrap the SLICC `webhook` shell command ─────────

async function shWebhook(args) {
  const { stdout, stderr, exitCode } = await exec.spawn(['webhook', ...args]);
  if (exitCode !== 0) throw new Error(`webhook ${args.join(' ')} failed: ${(stdout || stderr || '').trim()}`);
  return stdout;
}

// Parses the plain-text `webhook list` table. There is no --json form of the
// shell command, so this is a defensive line parser, not a stable API.
function parseWebhookList(stdout) {
  const entries = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^Active webhooks:/i.test(trimmed) || /^No /i.test(trimmed)) continue;
    const parts = trimmed.split(/\s{2,}/);
    if (parts.length < 3) continue;
    const [id, name, url] = parts;
    if (!/^https?:\/\//.test(url)) continue;
    entries.push({ id, name, url });
  }
  return entries;
}

// Deliberately NOT cached across calls: webhook URLs embed the tray id, and a
// tray reset makes a saved URL fail with a silent HTTP 410 TRAY_EXPIRED while
// the WaveSpeed job itself still reports success. Always re-read `webhook
// list` right before using the URL.
async function resolveWebhookUrl(name) {
  const stdout = await shWebhook(['list']);
  const entries = parseWebhookList(stdout);
  return entries.find((e) => e.name === name) || null;
}

// ─── polling (the callback backstop, and the only path when no webhook) ────
// Bounded (timeoutMs), resumable (throws with the task id so the caller can
// re-check later via `wavespeed status`/`get` instead of losing the job), and
// prints a progress line on every status change.
async function pollResult(api, id, { intervalMs = 3000, timeoutMs = 300000 } = {}) {
  const start = Date.now();
  let lastStatus;
  while (true) {
    const j = await api.get(`/api/v3/predictions/${id}/result`);
    const data = j && j.data;
    const status = data && data.status;
    if (!status) throw new Error(`unexpected poll response for ${id}: ${JSON.stringify(j)}`);
    if (status !== lastStatus) {
      process.stderr.write(`[${new Date().toISOString()}] ${id}: ${status}\n`);
      lastStatus = status;
    }
    if (TERMINAL_STATUSES.has(status)) return data;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting on task ${id} ` +
        `(last status: ${status}). It may still complete — check later with ` +
        `\`wavespeed status ${id}\` or \`wavespeed get ${id}\`.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.[a-zA-Z0-9]+$/);
    return m ? m[0] : '';
  } catch { return ''; }
}

async function main() {
  const { positional, flags } = process.argv.parseFlags();
  const [cmd] = positional;

  if (!cmd || flags.help || flags.h) return cli.help(HELP);

  if (cmd === 'auth') {
    if (flags.show) {
      const cfg = await loadConfig();
      if (!cfg.apiKey) return cli.out('No key stored in skill config (falls back to WAVESPEED_API_KEY / ' + SECRETS_FALLBACK + ' at request time).');
      const k = cfg.apiKey;
      return cli.out(`Stored key: ${k.slice(0, 8)}…${k.slice(-4)}`);
    }
    const key = str(flags.key) || positional[1];
    if (!key) return cli.die('usage: wavespeed auth <key>  (or: wavespeed auth --show)');
    await skill.config({ apiKey: key });
    return cli.out('API key saved to skill config.');
  }

  // `webhook create` doesn't need a WaveSpeed key at all (it's a SLICC-side
  // call); `webhook secret` does, so it's handled after key resolution below.
  if (cmd === 'webhook' && (positional[1] === 'create' || positional[1] === 'list')) {
    if (positional[1] === 'create') {
      const name = str(flags.name) || 'wavespeed';
      const stdout = await shWebhook(['create', '--name', name]);
      return cli.out(stdout.trim());
    }
    const stdout = await shWebhook(['list']);
    return cli.out(stdout.trim());
  }

  const key = await getKey(str(flags.key));
  const api = client(key);

  switch (cmd) {
    case 'webhook': {
      const sub = positional[1];
      if (sub === 'secret') {
        const j = await api.get('/api/v3/webhook/secret');
        if (flags.json) return cli.out(j);
        return cli.out(j?.data?.secret || j);
      }
      return cli.die('usage: wavespeed webhook create [--name <name>] | list | secret');
    }

    case 'models': {
      const term = positional[1];
      const models = await fetchModels(api);
      let filtered = models;
      if (term) {
        const q = term.toLowerCase();
        filtered = models.filter((m) => (m.model_id || '').toLowerCase().includes(q));
      }
      const limit = flags.all ? filtered.length : (Number(flags.limit) || 40);
      const shown = filtered.slice(0, limit);
      if (flags.json) return cli.out(shown);
      const rows = [['model_id', 'base_price', 'description']];
      for (const m of shown) {
        rows.push([m.model_id, m.base_price != null ? `$${m.base_price}` : '', fmt.trunc(m.description || '', 70)]);
      }
      cli.out(fmt.table(rows));
      if (shown.length < filtered.length) {
        console.log(color.gray(
          `\n… ${filtered.length - shown.length} more (of ${filtered.length} matching, ${models.length} total). ` +
          `Narrow the term, raise --limit, or pass --all.`));
      } else {
        console.log(color.gray(`\n${filtered.length} model(s)${term ? ` matching "${term}"` : ''} (${models.length} total in the catalog).`));
      }
      return;
    }

    case 'schema': {
      const modelId = positional[1];
      if (!modelId) return cli.die('usage: wavespeed schema <model_id>');
      const models = await fetchModels(api);
      const model = findModel(models, modelId);
      if (!model) return cli.die(`unknown model_id: ${modelId} (try \`wavespeed models ${modelId.split('/')[0]}\`)`);
      const schema = requestSchemaOf(model);
      if (!schema) return cli.die(`model ${modelId} has no published request schema`);
      if (flags.json) return cli.out(schema);
      console.log(color.bold(modelId) + color.gray(`  ($${model.base_price} / run)`));
      if (model.description) console.log(fmt.trunc(model.description, 300));
      console.log();
      const required = new Set(schema.required || []);
      const order = schema['x-order-properties'] || Object.keys(schema.properties || {});
      for (const name of order) {
        const p = (schema.properties || {})[name];
        if (!p) continue;
        const reqLabel = required.has(name) ? color.yellow('required') : color.gray('optional');
        let typeLabel = p.type || 'any';
        if (p.type === 'array') {
          typeLabel = `array<${(p.items && p.items.type) || 'any'}>`;
          if (p.maxItems !== undefined) typeLabel += ` maxItems=${p.maxItems}`;
        }
        if (p.enum) typeLabel += ` enum=[${p.enum.join(', ')}]`;
        const bits = [typeLabel, reqLabel];
        if (p.default !== undefined) bits.push(`default=${JSON.stringify(p.default)}`);
        if (p.minimum !== undefined || p.maximum !== undefined) bits.push(`range=${p.minimum ?? '-inf'}..${p.maximum ?? '+inf'}`);
        console.log(`  ${color.cyan(name)}  ${bits.join('  ')}`);
        if (p.description) console.log(`      ${color.gray(p.description)}`);
      }
      return;
    }

    case 'upload': {
      const file = positional[1];
      if (!file) return cli.die('usage: wavespeed upload <file>');
      const buf = await fs.readFileBinary(file);
      const blob = new Blob([buf]);
      const fd = new FormData();
      fd.append('file', blob, file.split('/').pop());
      const j = await api.post('/api/v3/media/upload/binary', { body: fd });
      if (flags.json) return cli.out(j);
      cli.out(j?.data?.download_url || j);
      console.error(color.gray('Note: uploaded files expire after 7 days.'));
      return;
    }

    case 'run': {
      const modelId = positional[1];
      if (!modelId) return cli.die('usage: wavespeed run <model_id> [--input k=v ...] [--wait]');

      let body = {};
      const jsonInputFile = str(flags['json-input']);
      if (jsonInputFile) {
        const raw = await fs.readFile(jsonInputFile);
        try { body = JSON.parse(raw); } catch (e) { return cli.die(`--json-input ${jsonInputFile} is not valid JSON: ${e.message}`); }
      }

      let schema;
      try {
        const models = await fetchModels(api);
        const model = findModel(models, modelId);
        if (!model) cli.warn(`model_id "${modelId}" not found in the catalog — submitting anyway (may be new/unlisted).`, { prefix: 'wavespeed' });
        else schema = requestSchemaOf(model);
      } catch { /* schema lookup is best-effort; submit proceeds without coercion */ }

      const overrides = parseInputFlags(flags.input);
      for (const [k, v] of Object.entries(overrides)) {
        body[k] = coerceValue(v, schema && schema.properties && schema.properties[k]);
      }

      const webhookFlag = flags.webhook !== undefined ? flags.webhook : flags.notify;
      let webhookUrl;
      if (webhookFlag !== undefined) {
        const name = typeof webhookFlag === 'string' ? webhookFlag : 'wavespeed';
        const wh = await resolveWebhookUrl(name);
        if (!wh) return cli.die(`no webhook named "${name}" — create one first: \`wavespeed webhook create --name ${name}\` (then \`wavespeed webhook list\` to confirm).`);
        webhookUrl = wh.url;
      }

      const path = `/api/v3/${modelId}` + (webhookUrl ? `?webhook=${encodeURIComponent(webhookUrl)}` : '');
      const j = await api.post(path, { body });
      const id = j && j.data && j.data.id;
      if (!id) return cli.die(`unexpected submit response: ${JSON.stringify(j)}`);

      if (flags.json && !flags.wait) return cli.out(j);
      cli.out(`Submitted ${modelId} → task ${id}` + (webhookUrl ? `  (webhook: ${webhookUrl})` : ''));
      if (!flags.wait) return;

      const intervalMs = Number(flags['poll-interval'] || 3) * 1000;
      const timeoutMs = Number(flags.timeout || 300) * 1000;
      const data = await pollResult(api, id, { intervalMs, timeoutMs });

      if (flags.json) return cli.out(data);
      if (data.status !== 'completed') {
        return cli.die(`task ${id} ended with status "${data.status}"` + (data.error ? `: ${data.error}` : ''));
      }
      cli.out(data.outputs && data.outputs[0]);
      const outPath = str(flags.out);
      if (outPath && data.outputs && typeof data.outputs[0] === 'string' && /^https?:\/\//.test(data.outputs[0])) {
        await fs.fetchToFile(data.outputs[0], outPath);
        console.error(color.gray(`Saved to ${outPath}`));
      }
      return;
    }

    case 'status': {
      const id = positional[1];
      if (!id) return cli.die('usage: wavespeed status <task_id>');
      const j = await api.get(`/api/v3/predictions/${id}/result`);
      if (flags.json) return cli.out(j);
      const d = j && j.data || {};
      cli.out(`${d.id}  ${d.model || ''}  ${d.status}` + (d.error ? `  error=${d.error}` : ''));
      return;
    }

    case 'get': {
      const id = positional[1];
      if (!id) return cli.die('usage: wavespeed get <task_id> [--out path] [--index n]');
      const j = await api.get(`/api/v3/predictions/${id}/result`);
      const d = j && j.data || {};
      if (d.status !== 'completed') {
        if (flags.json) return cli.out(j);
        return cli.die(`task ${id} is "${d.status}", not completed` + (d.error ? `: ${d.error}` : '') +
          ' — poll with `wavespeed status`, or use `wavespeed reconcile` if a webhook callback may have been lost.');
      }
      const idx = Number(flags.index || 0);
      const output = d.outputs && d.outputs[idx];
      if (output === undefined) return cli.die(`task ${id} has no output at index ${idx} (outputs: ${(d.outputs || []).length})`);
      if (flags.json) return cli.out({ ...j, selected: output });
      if (typeof output === 'string' && /^https?:\/\//.test(output)) {
        const outPath = str(flags.out) || `/tmp/wavespeed-${id}${extFromUrl(output) || ''}`;
        await fs.fetchToFile(output, outPath);
        return cli.out(`Saved ${outPath}`);
      }
      return cli.out(output);
    }

    case 'reconcile': {
      // Backstop for a lost webhook callback: list recent predictions by
      // status/model/time instead of needing to remember the task id.
      const body = {
        page: Number(flags.page || 1),
        page_size: Math.min(100, Number(flags['page-size'] || flags.limit || 20)),
      };
      if (str(flags.status)) body.status = flags.status;
      if (str(flags.model)) body.model = flags.model;
      if (str(flags.since)) body.created_after = time.ago(flags.since).toISOString();
      const j = await api.post('/api/v3/predictions', { body });
      if (flags.json) return cli.out(j);
      const items = (j && j.data && j.data.items) || [];
      if (!items.length) return cli.out('No matching predictions.');
      const rows = [['id', 'model', 'status', 'created_at']];
      for (const it of items) rows.push([it.id, fmt.trunc(it.model || '', 34), it.status, fmt.date(it.created_at, 'short')]);
      return cli.out(fmt.table(rows));
    }

    case 'api': {
      const method = (positional[1] || 'GET').toUpperCase();
      const path = positional[2];
      if (!path) return cli.die("usage: wavespeed api <METHOD> <path> [--data '<json>'] [--query k=v]");
      let reqBody;
      if (str(flags.data)) { try { reqBody = JSON.parse(flags.data); } catch { reqBody = flags.data; } }
      const params = {};
      for (const q of asList(flags.query)) {
        const eq = String(q).indexOf('=');
        if (eq === -1) continue;
        params[q.slice(0, eq)] = q.slice(eq + 1);
      }
      const fn = api[method.toLowerCase()];
      if (!fn) return cli.die(`unsupported method: ${method}`);
      const j = await fn(path, { body: reqBody, params });
      return cli.out(j);
    }

    default:
      return cli.die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

await main().catch((e) => cli.die((e && e.message) || String(e), { prefix: 'wavespeed' }));
