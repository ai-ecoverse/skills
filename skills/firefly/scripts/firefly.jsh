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
    ${color.gray('--download [dir]')}         Download outputs (default dir /workspace)
    ${color.gray('--json')}                   Output raw job result
  ${color.cyan('status <statusUrl>')}         Poll a generate job by its full status URL
    ${color.gray('--download [dir]')}         Download outputs on success
    ${color.gray('--json')}                   Output raw status response
  ${color.cyan('--help')}                     Show this help

${color.bold('EXAMPLES')}
  firefly login --client-id XXX --client-secret YYY
  firefly login --from /workspace/firefly-creds.json
  firefly generate "a red panda astronaut, photorealistic" --size 1024x1024 --n 1
  firefly generate "neon city skyline" --n 2 --content-class art --download /shared
  firefly generate "a calm forest" --json | jq -r '.result.outputs[0].image.url'
  firefly status "https://firefly-epo853211.adobe.io/v3/status/urn:ff:jobs:..."

${color.bold('AUTH')}
  Run ${color.cyan('firefly login')} once. Credentials are stored in skill config; the
  IMS access token is cached and auto-refreshed (~24h lifetime).

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

function printOutputs(result, savedPaths) {
  const outputs = result?.outputs || [];
  const size = result?.size;
  console.log();
  console.log(`  ${color.cyan(color.bold('Firefly image' + (outputs.length === 1 ? '' : 's')))} ${color.dim(`(${outputs.length})`)}`);
  if (size) console.log(`  ${color.dim(`${size.width}x${size.height}`)}${result.contentClass ? color.dim(`  ${result.contentClass}`) : ''}`);
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

  const headers = await fireflyHeaders();

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
  printOutputs(result, saved);
}

async function cmdStatus(positional, flags) {
  const statusUrl = positional[0] || flags['status-url'];
  if (!statusUrl) {
    cli.die('Usage: firefly status <statusUrl>\nPass the full status URL returned by generate (the region host cannot be reconstructed from a bare jobId).', { prefix: 'firefly' });
  }
  if (!/^https?:\/\//i.test(statusUrl)) {
    cli.die('firefly status needs the full status URL (https://firefly-<region>.adobe.io/v3/status/<jobId>).', { prefix: 'firefly' });
  }

  const headers = await fireflyHeaders();
  const res = await fetch(statusUrl, { headers });
  if (!res.ok) {
    let detail = await res.text();
    try { const j = JSON.parse(detail); detail = j.message || j.error_code || detail; } catch { /* raw */ }
    if (res.status === 401 || res.status === 403) cli.die(`Firefly auth error (${res.status}). Run: firefly login`, { prefix: 'firefly' });
    cli.die(`Status request failed (${res.status}): ${detail}`, { prefix: 'firefly' });
  }
  const body = await res.json();

  if (flags.json) { cli.out(body); return; }

  if (body.status !== 'succeeded') {
    console.log();
    console.log(`  ${color.yellow(body.status || 'unknown')}${body.jobId ? '  ' + color.dim(body.jobId) : ''}`);
    console.log();
    return;
  }

  const result = body.result || body;
  let saved = null;
  if (flags.download != null) {
    const dir = typeof flags.download === 'string' ? flags.download : '/workspace';
    saved = await downloadOutputs(result.outputs || [], dir, body.jobId);
  }
  printOutputs(result, saved);
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
    default:
      cli.die(`Unknown command: ${cmd}\nRun: firefly --help`, { prefix: 'firefly' });
  }
} catch (err) {
  if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw — CLAUDE.md §6
  cli.die(err?.message || String(err), { prefix: 'firefly' });
}
