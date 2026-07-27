// firefly.jsh — Adobe Firefly Services image generation CLI
// Auth: Adobe IMS server-to-server (client_credentials) — token cached in
// skill.config(), lives ~24h. Generate is async: submit → poll statusUrl.
//
// Wire format verified live 2026-07-24 against firefly-api.adobe.io/v3:
//  • IMS token: POST ims-na1.adobelogin.com/ims/token/v3 (form-urlencoded,
//    scope is a COMMA-separated string; response.scope may be null — ignore).
//  • generate-async returns a region-specific statusUrl (host differs from
//    firefly-api.adobe.io, e.g. firefly-epo853211.adobe.io) — ALWAYS use the
//    returned statusUrl verbatim; it cannot be reconstructed from the jobId.
//  • output image URLs are ~1h pre-signed S3 links — use --download to keep them.

const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');
const skill = require('sliccy:skill');
const fs = require('fs');

// ─── Constants ─────────────────────────────────────────────────────────────

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3';
const GENERATE_URL = 'https://firefly-api.adobe.io/v3/images/generate-async';
const CUSTOM_MODELS_URL = 'https://firefly-api.adobe.io/v3/custom-models';

// Firefly returns region-specific status hosts (e.g. firefly-epo853211.adobe.io),
// so the status URL cannot be a fixed constant. Restrict it to HTTPS on a Firefly
// Adobe host before attaching the bearer token + API key — otherwise a hostile
// status URL (e.g. `firefly status https://attacker.example/...`) would exfiltrate
// the caller's credentials. Accept `firefly-api.adobe.io` and `firefly-<region>.adobe.io`.
const FIREFLY_HOST_RE = /^firefly(-[a-z0-9]+)?\.adobe\.io$/i;

// Validate an untrusted status URL BEFORE building the authenticated request.
// Returns the normalized URL string; dies with an actionable message otherwise.
function assertFireflyStatusUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    cli.die('firefly status needs the full status URL (https://firefly-<region>.adobe.io/v3/status/<jobId>).', { prefix: 'firefly' });
  }
  if (u.protocol !== 'https:') {
    cli.die(`refusing to send credentials over ${u.protocol || 'a non-https'} URL — the status URL must be https.`, { prefix: 'firefly' });
  }
  if (!FIREFLY_HOST_RE.test(u.hostname)) {
    cli.die(`refusing to send credentials to untrusted host "${u.hostname}". The status URL must be an Adobe Firefly host (firefly-<region>.adobe.io), exactly as returned by generate.`, { prefix: 'firefly' });
  }
  return u.toString();
}

// Model selection is done via the `x-model-version` request HEADER (NOT a body
// field — body model fields are silently ignored). Verified live 2026-07-24:
// only these four header values are accepted; anything else (image4, image5,
// partner names like runway/luma/imagen/gpt-image-1) → HTTP 404. image4_custom
// additionally requires the body field `customModelId` (a custom-model assetId).
// Omitting the header entirely = server default (image4_standard).
const VALID_MODELS = ['image3', 'image4_standard', 'image4_ultra', 'image4_custom'];

// Default server-to-server scopes for Firefly Services (comma-separated string).
const DEFAULT_SCOPES = [
  'openid',
  'AdobeID',
  'session',
  'additional_info',
  'firefly_api',
  'ff_apis',
  'read_organizations',
  'additional_info.projectedProductContext',
  'creative_sdk',
  'ee.express_api',
  'indesign_services',
].join(',');

const VALID_SIZES = ['1024x1024', '2048x2048', '1792x1024', '1024x1792', '1344x768', '768x1344'];

// ─── Help ────────────────────────────────────────────────────────────────────

const HELP = `
${color.bold(color.cyan('firefly'))} — Adobe Firefly Services image generation

${color.bold('USAGE')}
  firefly login [options]
  firefly generate <prompt> [options]
  firefly models [--json]
  firefly status <statusUrl> [options]

${color.bold('COMMANDS')}
  ${color.cyan('login')}                      Store Adobe IMS credentials and verify them
    ${color.gray('--client-id <id>')}         IMS client id
    ${color.gray('--client-secret <secret>')} IMS client secret
    ${color.gray('--org-id <org>')}           Adobe org id (optional)
    ${color.gray('--scopes <a,b,c>')}         Comma-separated scopes (has a sensible default)
    ${color.gray('--from <path.json>')}       Load {client_id, client_secret, org_id?, scopes?} from a JSON file
  ${color.cyan('generate <prompt>')}          Generate image(s) from a text prompt
    ${color.gray('--size <WxH>')}             Image size (default 1024x1024)
    ${color.gray('--n <1..4>')}               Number of variations (default 1)
    ${color.gray('--seed <int>')}             Seed (repeatable — one per variation)
    ${color.gray('--content-class <c>')}      photo | art
    ${color.gray('--negative <text>')}        Negative prompt
    ${color.gray('--model <v>')}              image3 | image4_standard | image4_ultra | image4_custom
    ${color.gray('--custom-model <id>')}      Custom model assetId (implies --model image4_custom)
    ${color.gray('--download [dir]')}         Download outputs (default dir /workspace)
    ${color.gray('--json')}                   Output raw job result
  ${color.cyan('models')}                     List the org's trained custom models
    ${color.gray('--json')}                   Output raw response
  ${color.cyan('status <statusUrl>')}         Poll a generate job by its full status URL
    ${color.gray('--download [dir]')}         Download outputs on success
    ${color.gray('--json')}                   Output raw status response
  ${color.cyan('--help')}                     Show this help

${color.bold('EXAMPLES')}
  firefly login --client-id XXX --client-secret YYY
  firefly login --from /workspace/firefly-creds.json
  firefly generate "a red panda astronaut, photorealistic" --size 1024x1024 --n 1
  firefly generate "neon city skyline" --n 2 --content-class art --download /shared
  firefly generate "a tiny robot watering a plant" --model image4_ultra --download /shared
  firefly models
  firefly generate "portrait in my brand style" --custom-model <assetId> --download /shared
  firefly generate "a calm forest" --json | jq -r '.result.outputs[0].image.url'
  firefly status "https://firefly-epo853211.adobe.io/v3/status/urn:ff:jobs:..."

${color.bold('AUTH')}
  Run ${color.cyan('firefly login')} once. Credentials are stored in skill config; the
  IMS access token is cached and auto-refreshed (~24h lifetime).

${color.bold('MODELS')}
  ${color.gray('--model')} sets the x-model-version header. Valid: ${VALID_MODELS.join(', ')}.
  Omit it for the server default (image4_standard). image4_custom needs a custom
  model id — list yours with ${color.cyan('firefly models')} and pass ${color.gray('--custom-model <id>')}.
  Partner models (Runway, Luma, OpenAI, Google, etc.) are NOT available here.

${color.bold('NOTE')}
  Output image URLs are pre-signed S3 links that expire in ~1 hour — pass
  ${color.gray('--download')} to save the PNGs locally.

${color.bold('SIZES')}
  ${VALID_SIZES.join('  ')}
`.trim();

// ─── Config / token lifecycle ──────────────────────────────────────────────

async function loadConfig() {
  // MUST await before the `|| {}` fallback: skill.config() returns a Promise,
  // which is always truthy, so `skill.config() || {}` never falls back to {}.
  return (await skill.config()) || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

/** Exchange client_credentials for an IMS bearer token. Throws on failure. */
async function exchangeToken(clientId, clientSecret, scopes) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: scopes,
  });
  const res = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    let detail = await res.text();
    try {
      const j = JSON.parse(detail);
      detail = j.error_description || j.error || detail;
    } catch { /* keep raw text */ }
    throw new Error(`IMS token exchange failed (${res.status}): ${detail}`);
  }
  return await res.json(); // {token_type, expires_in, access_token, scope?}
}

/** Returns a valid access token, exchanging + caching when needed. */
async function getToken() {
  const cfg = await loadConfig();
  if (!cfg.client_id || !cfg.client_secret) {
    cli.die('Not logged in. Run: firefly login --client-id <id> --client-secret <secret>', { prefix: 'firefly' });
  }
  const now = Date.now();
  if (cfg.access_token && cfg.token_expires_at && now < cfg.token_expires_at - 60_000) {
    return cfg.access_token;
  }
  const scopes = cfg.scopes || DEFAULT_SCOPES;
  const tok = await exchangeToken(cfg.client_id, cfg.client_secret, scopes);
  await saveConfig({
    access_token: tok.access_token,
    token_expires_at: Date.now() + (tok.expires_in || 86399) * 1000,
  });
  return tok.access_token;
}

/** Standard Firefly request headers. */
async function fireflyHeaders() {
  const cfg = await loadConfig();
  const token = await getToken();
  return {
    Authorization: `Bearer ${token}`,
    'x-api-key': cfg.client_id,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseSize(raw) {
  if (!raw) return { width: 1024, height: 1024 };
  const m = String(raw).trim().match(/^(\d+)\s*[x*]\s*(\d+)$/i);
  if (!m) cli.die(`Invalid --size "${raw}". Use WxH, e.g. 1024x1024. Valid: ${VALID_SIZES.join(', ')}`, { prefix: 'firefly' });
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function shortJobId(jobId) {
  if (!jobId) return 'job';
  const parts = String(jobId).split(':');
  return (parts[parts.length - 1] || 'job').slice(0, 12);
}

async function downloadOutputs(outputs, dir, jobId) {
  const target = dir && typeof dir === 'string' ? dir : '/workspace';
  try { await fs.mkdir(target); } catch { /* exists */ }
  const saved = [];
  const short = shortJobId(jobId);
  for (let i = 0; i < outputs.length; i++) {
    const url = outputs[i]?.image?.url;
    if (!url) continue;
    const res = await fetch(url);
    if (!res.ok) {
      cli.warn(`Failed to download output ${i + 1} (${res.status})`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const path = `${target.replace(/\/$/, '')}/firefly-${short}-${i + 1}.png`;
    await fs.writeFileBinary(path, buf);
    saved.push(path);
  }
  return saved;
}

function printOutputs(result, savedPaths, model) {
  const outputs = result?.outputs || [];
  const size = result?.size;
  console.log();
  console.log(`  ${color.cyan(color.bold('Firefly image' + (outputs.length === 1 ? '' : 's')))} ${color.dim(`(${outputs.length})`)}`);
  if (size) console.log(`  ${color.dim(`${size.width}x${size.height}`)}${result.contentClass ? color.dim(`  ${result.contentClass}`) : ''}${model ? color.dim(`  model:${model}`) : ''}`);
  console.log();
  for (let i = 0; i < outputs.length; i++) {
    const o = outputs[i];
    console.log(`  ${color.bold(`#${i + 1}`)}  ${color.dim(`seed:${o.seed ?? '—'}`)}`);
    if (o.image?.url) console.log(`      ${color.dim(o.image.url)}`);
    if (savedPaths && savedPaths[i]) console.log(`      ${color.green('✓')} ${savedPaths[i]}`);
    console.log();
  }
  if (!savedPaths) {
    console.log(color.dim('  URLs expire in ~1h — re-run with --download to save the PNGs.'));
    console.log();
  }
}

/** Poll a statusUrl until terminal state or timeout. Returns the final body. */
async function pollStatus(statusUrl, headers, { intervalMs = 2000, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const res = await fetch(statusUrl, { headers });
    if (!res.ok) {
      let detail = await res.text();
      try { const j = JSON.parse(detail); detail = j.message || j.error_code || detail; } catch { /* raw */ }
      throw new Error(`Status poll failed (${res.status}): ${detail}`);
    }
    const body = await res.json();
    const status = body.status;
    if (status === 'succeeded') return body;
    if (status === 'failed') {
      throw new Error(`Job failed: ${body.error?.message || body.message || JSON.stringify(body)}`);
    }
    // running / pending / in_progress → keep polling
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${status || 'unknown'}). Retry with: firefly status "${statusUrl}"`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdLogin(flags) {
  let clientId = flags['client-id'];
  let clientSecret = flags['client-secret'];
  let orgId = flags['org-id'];
  let scopes = flags.scopes;

  if (flags.from) {
    let raw;
    try {
      raw = await fs.readFile(flags.from);
    } catch (err) {
      cli.die(`Could not read --from file: ${flags.from}`, { prefix: 'firefly' });
    }
    let creds;
    try {
      creds = JSON.parse(raw);
    } catch {
      cli.die(`--from file is not valid JSON: ${flags.from}`, { prefix: 'firefly' });
    }
    clientId = clientId || creds.client_id;
    clientSecret = clientSecret || creds.client_secret;
    orgId = orgId || creds.org_id;
    scopes = scopes || creds.scopes;
  }

  if (!clientId || !clientSecret) {
    cli.die('Missing credentials. Provide --client-id and --client-secret, or --from <path.json>.', { prefix: 'firefly' });
  }

  // Normalize scopes to a comma-separated string.
  if (Array.isArray(scopes)) scopes = scopes.join(',');
  scopes = scopes || DEFAULT_SCOPES;

  // Verify the credentials by exchanging a token (do NOT print it).
  let tok;
  try {
    tok = await exchangeToken(clientId, clientSecret, scopes);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(`Credential verification failed. ${err.message}`, { prefix: 'firefly' });
  }

  await saveConfig({
    client_id: clientId,
    client_secret: clientSecret,
    org_id: orgId || null,
    scopes,
    access_token: tok.access_token,
    token_expires_at: Date.now() + (tok.expires_in || 86399) * 1000,
  });

  if (flags.json) {
    cli.out({ ok: true, verified: true, expires_in: tok.expires_in ?? null });
    return;
  }

  console.log();
  console.log(`  ${color.green('✓')} Logged in to Adobe Firefly Services`);
  console.log(`  ${color.dim(`client id: ${clientId}`)}`);
  if (orgId) console.log(`  ${color.dim(`org: ${orgId}`)}`);
  console.log(`  ${color.dim(`token valid for ~${Math.round((tok.expires_in || 86399) / 3600)}h`)}`);
  console.log();
}

async function cmdGenerate(positional, flags) {
  const prompt = positional.join(' ').trim();
  if (!prompt) cli.die('Usage: firefly generate <prompt>', { prefix: 'firefly' });

  const size = parseSize(flags.size);

  const parsedN = parseInt(flags.n, 10);
  const numVariations = Number.isFinite(parsedN) ? Math.min(Math.max(parsedN, 1), 4) : 1;

  const payload = { prompt, numVariations, size };

  // --seed is repeatable → seeds array (one per variation).
  if (flags.seed != null) {
    const seedArr = Array.isArray(flags.seed) ? flags.seed : [flags.seed];
    const seeds = seedArr.map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
    if (seeds.length) payload.seeds = seeds;
  }

  if (flags['content-class']) {
    const cc = String(flags['content-class']).toLowerCase();
    if (cc !== 'photo' && cc !== 'art') cli.die('--content-class must be "photo" or "art"', { prefix: 'firefly' });
    payload.contentClass = cc;
  }

  if (flags.negative) payload.negativePrompt = String(flags.negative);

  // ── Model selection (x-model-version header) ──
  // --custom-model implies image4_custom and supplies the customModelId body field.
  let model = flags.model != null ? String(flags.model).toLowerCase() : null;
  const customModel = flags['custom-model'] != null ? String(flags['custom-model']) : null;

  if (customModel) {
    if (model && model !== 'image4_custom') {
      cli.die(`--custom-model implies --model image4_custom, but --model ${model} was given. Drop --model or set it to image4_custom.`, { prefix: 'firefly' });
    }
    model = 'image4_custom';
    payload.customModelId = customModel;
  }

  if (model) {
    if (!VALID_MODELS.includes(model)) {
      cli.die(
        `Invalid --model "${flags.model}". Valid: ${VALID_MODELS.join(', ')}.\n` +
        `Partner models (Runway, Luma, OpenAI, Google, etc.) are NOT available through this API — use the Firefly app / Creative Production layer for those.`,
        { prefix: 'firefly' }
      );
    }
    if (model === 'image4_custom' && !payload.customModelId) {
      cli.die('--model image4_custom requires a custom model id. Pass --custom-model <assetId> (list them with: firefly models).', { prefix: 'firefly' });
    }
  }

  const headers = await fireflyHeaders();
  if (model) headers['x-model-version'] = model;

  const submitRes = await fetch(GENERATE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!submitRes.ok) {
    let detail = await submitRes.text();
    try { const j = JSON.parse(detail); detail = j.message || j.error_code || detail; } catch { /* raw */ }
    if (submitRes.status === 401 || submitRes.status === 403) {
      cli.die(`Firefly auth error (${submitRes.status}). Run: firefly login`, { prefix: 'firefly' });
    }
    cli.die(`Generate request failed (${submitRes.status}): ${detail}`, { prefix: 'firefly' });
  }
  const job = await submitRes.json();
  const statusUrl = job.statusUrl;
  if (!statusUrl) cli.die(`No statusUrl in response: ${JSON.stringify(job)}`, { prefix: 'firefly' });

  const final = await pollStatus(statusUrl, headers);

  if (flags.json) { cli.out(final); return; }

  const result = final.result || final;
  let saved = null;
  if (flags.download != null) {
    const dir = typeof flags.download === 'string' ? flags.download : '/workspace';
    saved = await downloadOutputs(result.outputs || [], dir, final.jobId || job.jobId);
  }
  printOutputs(result, saved, model);
}

async function cmdStatus(positional, flags) {
  const rawUrl = positional[0] || flags['status-url'];
  if (!rawUrl) {
    cli.die('Usage: firefly status <statusUrl>\nPass the full status URL returned by generate (the region host cannot be reconstructed from a bare jobId).', { prefix: 'firefly' });
  }
  // P1: validate the host/scheme BEFORE attaching the bearer token + API key so
  // credentials can never be sent to an attacker-controlled URL.
  const statusUrl = assertFireflyStatusUrl(rawUrl);

  const headers = await fireflyHeaders();

  // Poll to a terminal state (matches documented behavior and reuses the same
  // terminal-state + failure handling as generate). pollStatus throws on
  // failure/timeout/auth error — map those to actionable, non-zero exits.
  let body;
  try {
    body = await pollStatus(statusUrl, headers);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    const msg = String(err?.message || err);
    if (/\(401\)|\(403\)/.test(msg)) {
      cli.die(`Firefly auth error. Run: firefly login`, { prefix: 'firefly' });
    }
    cli.die(msg, { prefix: 'firefly' });
  }

  if (flags.json) { cli.out(body); return; }

  const result = body.result || body;
  let saved = null;
  if (flags.download != null) {
    const dir = typeof flags.download === 'string' ? flags.download : '/workspace';
    saved = await downloadOutputs(result.outputs || [], dir, body.jobId);
  }
  printOutputs(result, saved);
}

async function cmdModels(flags) {
  const headers = await fireflyHeaders();
  const res = await fetch(CUSTOM_MODELS_URL, { headers });
  if (!res.ok) {
    let detail = await res.text();
    try { const j = JSON.parse(detail); detail = j.message || j.error_code || detail; } catch { /* raw */ }
    if (res.status === 401 || res.status === 403) cli.die(`Firefly auth error (${res.status}). Run: firefly login`, { prefix: 'firefly' });
    cli.die(`Custom models request failed (${res.status}): ${detail}`, { prefix: 'firefly' });
  }
  const body = await res.json();

  if (flags.json) { cli.out(body); return; }

  // Defensive wrapper normalization — the array may be under any of these keys.
  const models = Array.isArray(body)
    ? body
    : (body.customModels || body.models || body.items || body.custom_models || []);

  if (!models.length) {
    console.log();
    console.log(color.dim('  No custom models found for this org. Train one in the Firefly Custom Models UI.'));
    console.log();
    return;
  }

  console.log();
  console.log(`  ${color.cyan(color.bold('Firefly custom models'))} ${color.dim(`(${models.length})`)}`);
  console.log();
  for (const m of models) {
    const name = m.displayName || m.name || m.title || 'Untitled model';
    const assetId = m.assetId || m.assetID || m.id || m.customModelId;
    const mode = m.trainingMode || m.mode;
    const published = m.publishedState || m.published || m.state;
    const base = m.baseModel?.name || m.baseModel?.version || m.baseModel;
    console.log(`  ${color.cyan(color.bold(name))}`);
    if (assetId) console.log(`    ${color.dim(`id:${assetId}`)}`);
    const meta = [];
    if (mode) meta.push(String(mode));
    if (published) meta.push(String(published));
    if (base) meta.push(String(base));
    if (meta.length) console.log(`    ${color.dim(meta.join('  •  '))}`);
    if (m.samplePrompt) console.log(`    ${color.gray(fmt.trunc(String(m.samplePrompt), 72))}`);
    console.log();
  }
  console.log(color.dim('  Use an id with: firefly generate "<prompt>" --custom-model <id>'));
  console.log();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const { positional, flags, subcommand } = process.argv.parseFlags();
const cmd = subcommand || positional[0];
const rest = positional.slice(1); // drop the leading subcommand

if (!cmd || flags.help || flags.h || cmd === 'help') {
  cli.help(HELP);
}

try {
  switch (cmd) {
    case 'login':
      await cmdLogin(flags);
      break;
    case 'generate':
      await cmdGenerate(rest, flags);
      break;
    case 'status':
      await cmdStatus(rest, flags);
      break;
    case 'models':
      await cmdModels(flags);
      break;
    default:
      cli.die(`Unknown command: ${cmd}\nRun: firefly --help`, { prefix: 'firefly' });
  }
} catch (err) {
  if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw — CLAUDE.md §6
  cli.die(err?.message || String(err), { prefix: 'firefly' });
}
