// printful.jsh — Printful REST API CLI (api.printful.com).
//
// Auth: a store-level private token (Developer Portal, or minted via
// dashboard GraphQL). CORS blocks calling api.printful.com from a
// printful.com tab — always call REST from this sandbox script.
// Tokens are never printed.

const cli = require('sliccy:cli');
const skill = require('sliccy:skill');
const browser = require('sliccy:browser');
const exec = require('sliccy:exec');
const fs = require('fs');
const c = require('sliccy:color');

const API = 'https://api.printful.com';
const ALLOWED_HOSTS = new Set(['api.printful.com']);
const DASHBOARD_RE = /(?:www\.)?printful\.com/;
const TOKEN_UI = 'https://developers.printful.com/tokens';
const SKILL_VERSION = '1.0.0';
const DEFAULT_SCOPES = ['orders', 'file_library', 'sync_products'];

const MINT_MUTATION = `mutation devPortalCreateTokenMutation($input: DevPortalTokenInput!) {
  devPortal {
    devPortalCreateToken(input: $input) {
      tokenId name email createdAt expiresAt rawAccessToken
      scopes { scope }
    }
  }
}`;

const HELP = `
printful — Printful REST API (print-on-demand)

USAGE
  printful auth login --token <tok>     Store a private token (Developer Portal)
  printful auth login                   Mint one from a logged-in printful.com tab
  printful auth status | logout
  printful whoami                       Customer stores (token last-4 only)
  printful stores

  printful files list [--limit N]
  printful files get <id>
  printful files add --url <https> [--filename n] [--wait]
  printful files add --path <vfs-file> [--wait]
  printful files wait <id> [--timeout 60]

  printful catalog product <id>         e.g. 71 = Bella + Canvas 3001
  printful catalog variants <id> [--color Black] [--size M] [--in-stock]

  printful store products
  printful store product get <id>
  printful store product create --name T --variant-id N --file-id F --confirm

  printful orders [--status draft]
  printful order get <id>
  printful order create --variant-id N --file-id F --name ... --address1 ... --city ... --country DE --zip ...
  printful order confirm <id> --confirm     CHARGES the account

  printful api [METHOD] <path> [--data <json>]

FLAGS
  --json            Raw API payload
  --token <tok>     One-call override (not persisted)
  --store-id <id>   X-PF-Store-Id (account-level tokens)
  --confirm         Apply a gated mutation (store product create, order confirm)

  Use long flags with a value (--variant-id 4017). Single-dash flags arrive
  as booleans in this runtime.

REQUIRES
  A Printful private token (developers.printful.com/tokens) or a logged-in
  www.printful.com dashboard tab for minting.

NOTES
  • Design Maker file-library uploads do not work from automation — use files add.
  • POST /files needs a URL Printful can GET. --path serves the file for 1 day.
  • order create posts a DRAFT (no charge). order confirm --confirm pays.
  • Sync products are not Design Maker templates (Meine Produkte stays empty).
`.trim();

// ─── flag helpers ────────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' ? v : undefined;
}

function num(v, dflt) {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v) {
  return v === true || v === 'true' || v === '1';
}

function maskToken(tok) {
  if (!tok) return '(none)';
  return `…${String(tok).slice(-4)}`;
}

function isoZulu(days) {
  return new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── config ──────────────────────────────────────────────────────────────────

async function loadConfig() {
  return (await skill.config()) || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

let cachedToken;
let activeToken;

async function getToken(flags) {
  activeToken = await resolveToken(flags);
  return activeToken;
}

async function resolveToken(flags) {
  const override = str(flags && flags.token);
  if (override) return override;
  if (cachedToken) return cachedToken;
  const cfg = await loadConfig();
  if (cfg.token) {
    cachedToken = cfg.token;
    return cachedToken;
  }
  cli.die(
    'Not authenticated.\n' +
      `  1. Create a store-level private token: ${TOKEN_UI}\n` +
      '     scopes: orders, file_library, sync_products\n' +
      '  2. printful auth login --token <token>\n' +
      '  Or open a logged-in www.printful.com dashboard tab and run: printful auth login',
    { prefix: 'printful' },
  );
}

function resolveUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '');
  const full = /^https?:\/\//i.test(raw) ? raw : `${API}${raw.startsWith('/') ? '' : '/'}${raw}`;
  let u;
  try {
    u = new URL(full);
  } catch {
    cli.die(`Invalid URL or path: ${raw}`, { prefix: 'printful' });
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    cli.die(
      `Refusing to send the Printful token to ${u.protocol}//${u.hostname}. ` +
        `Allowed host: api.printful.com.`,
      { prefix: 'printful' },
    );
  }
  return u.toString();
}

function printfulError(text, status) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    if (/<html/i.test(text) || /<!DOCTYPE/i.test(text)) {
      return `HTTP ${status} (HTML — session or URL may be wrong)`;
    }
    return text || `HTTP ${status}`;
  }
  const parts = [];
  if (j.error && typeof j.error === 'object') {
    if (j.error.reason) parts.push(j.error.reason);
    if (j.error.message) parts.push(j.error.message);
  }
  if (typeof j.result === 'string') parts.push(j.result);
  if (j.message && !parts.includes(j.message)) parts.push(j.message);
  return parts.length ? parts.join(' — ') : text || `HTTP ${status}`;
}

async function api(pathOrUrl, opts = {}) {
  const url = resolveUrl(pathOrUrl);
  const flags = opts.flags || {};
  const token = await getToken(flags);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  const storeId = str(flags['store-id'] || flags.storeId);
  if (storeId) headers['X-PF-Store-Id'] = storeId;
  let body = opts.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { method: opts.method || 'GET', headers, body });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) {
      cli.die(
        `Printful rejected the token (401): ${printfulError(text, res.status)}\n` +
          `  Run: printful auth status   (then: printful auth login --token <tok>)`,
        { prefix: 'printful' },
      );
    }
    if (res.status === 403) {
      cli.die(
        `Printful denied the request (403): ${printfulError(text, res.status)}\n` +
          '  Token authenticated — check the store/id, or that the token scope covers this resource.',
        { prefix: 'printful' },
      );
    }
    cli.die(`Printful API ${res.status}: ${printfulError(text, res.status)}`, { prefix: 'printful' });
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function unwrap(res) {
  if (res && Object.prototype.hasOwnProperty.call(res, 'result')) return res.result;
  return res;
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function line() {
  console.log(c.dim('  ' + '─'.repeat(52)));
}

// ─── GraphQL mint (dashboard tab) ────────────────────────────────────────────

function asObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

async function mintViaGraphql(flags) {
  let tab;
  try {
    tab = await browser.findTab({ urlMatch: DASHBOARD_RE });
  } catch {
    tab = null;
  }
  if (!tab) {
    cli.die(
      'No logged-in www.printful.com tab found, so nothing to mint from.\n' +
        `  Open the dashboard, or pass --token from ${TOKEN_UI}.`,
      { prefix: 'printful' },
    );
  }

  const meta = asObject(
    await browser.eval(tab, () => {
      const csrf =
        document.querySelector('meta[name="csrf-token"]')?.content ||
        (window.PF && PF.Config && PF.Config.PUSHER_CONFIG && PF.Config.PUSHER_CONFIG.CSRF_TOKEN) ||
        null;
      const cust = window.PF && window.PF.Customer;
      return {
        csrf,
        email: cust && cust.email,
        storeId: cust && cust.personalOrdersStoreId,
        name: cust && cust.fullName,
      };
    }),
  );
  if (!meta || !meta.csrf) {
    cli.die(
      'Opened a printful.com tab but could not read PF.Config CSRF. Navigate to the dashboard and retry.',
      { prefix: 'printful' },
    );
  }
  if (!meta.storeId) {
    cli.die(
      'Dashboard session has no personalOrdersStoreId — sign in fully, then retry.',
      { prefix: 'printful' },
    );
  }

  const days = num(flags.days, 90);
  const input = {
    name: str(flags.name) || 'slicc-printful',
    email: meta.email || 'unknown@printful.local',
    expiresAt: isoZulu(days),
    tokenType: 'store',
    storeId: Number(meta.storeId),
    scopes: DEFAULT_SCOPES,
  };

  const fetched = await browser.fetch(tab, 'https://www.printful.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-CSRF-Token': meta.csrf,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: JSON.stringify({ query: MINT_MUTATION, variables: { input } }),
  });
  let body = fetched.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      cli.die(`GraphQL mint returned non-JSON (${fetched.status})`, { prefix: 'printful' });
    }
  }
  if (!fetched.ok) {
    cli.die(`GraphQL mint failed (${fetched.status}): ${JSON.stringify(body).slice(0, 300)}`, {
      prefix: 'printful',
    });
  }
  if (body.errors && body.errors.length) {
    cli.die(`GraphQL mint error: ${body.errors.map((e) => e.message).join('; ')}`, {
      prefix: 'printful',
    });
  }
  const created = body.data && body.data.devPortal && body.data.devPortal.devPortalCreateToken;
  if (!created || !created.rawAccessToken) {
    cli.die('GraphQL mint succeeded but returned no rawAccessToken.', { prefix: 'printful' });
  }
  return {
    token: created.rawAccessToken,
    tokenId: created.tokenId,
    name: created.name,
    email: created.email,
    expiresAt: created.expiresAt,
    storeId: input.storeId,
    scopes: (created.scopes || []).map((s) => s.scope),
  };
}

// ─── auth / whoami / stores ──────────────────────────────────────────────────

async function cmdAuthLogin(flags) {
  const tok = str(flags.token);
  if (tok) {
    const stores = unwrap(await api('/stores', { flags: { token: tok, 'store-id': str(flags['store-id']) } }));
    const list = Array.isArray(stores) ? stores : [];
    await saveConfig({
      token: tok,
      token_source: 'private-token',
      token_expires_at: null,
      store_id: list[0] && list[0].id,
    });
    cachedToken = tok;
    console.log('');
    console.log(c.green('✓ Token stored') + c.dim(`  (${maskToken(tok)}, ${list.length} store(s))`));
    for (const s of list) {
      console.log(`    ${c.cyan(String(s.id))}  ${(s.name || '').padEnd(24)} ${c.dim(s.type || '')}`);
    }
    return;
  }

  console.log('');
  console.log(`  ${c.bold('No --token given.')} Minting a store-level token from the dashboard tab…`);
  const minted = await mintViaGraphql(flags);
  const stores = unwrap(await api('/stores', { flags: { token: minted.token } }));
  const list = Array.isArray(stores) ? stores : [];
  await saveConfig({
    token: minted.token,
    token_source: 'graphql-mint',
    token_expires_at: minted.expiresAt || null,
    token_id: minted.tokenId || null,
    store_id: minted.storeId || (list[0] && list[0].id),
  });
  cachedToken = minted.token;
  console.log(
    c.green('✓ Minted a store-level private token') + c.dim(`  (${maskToken(minted.token)})`),
  );
  if (minted.expiresAt) console.log(c.dim(`  expires: ${minted.expiresAt}`));
  console.log(c.dim(`  scopes: ${(minted.scopes || DEFAULT_SCOPES).join(', ')}`));
}

async function cmdAuthLogout() {
  const cfg = await loadConfig();
  await skill.config({
    ...cfg,
    token: null,
    token_source: null,
    token_expires_at: null,
    token_id: null,
  });
  cachedToken = undefined;
  console.log('');
  console.log(c.green('✓ Cleared the stored Printful token.'));
  console.log(
    c.dim('  This only forgets it locally. Delete it in the Developer Portal if it leaked: ') +
      c.cyan(TOKEN_UI),
  );
}

async function cmdAuthStatus(flags) {
  const cfg = await loadConfig();
  if (!cfg.token) {
    if (flags.json) {
      cli.out({ authenticated: false });
      return;
    }
    console.log('');
    console.log(`  ${c.red('not authenticated')}`);
    console.log(c.dim(`  printful auth login --token <tok>   (create one at ${TOKEN_UI})`));
    return;
  }
  let stores = [];
  let valid = true;
  try {
    const res = unwrap(await api('/stores', { flags }));
    stores = Array.isArray(res) ? res : [];
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    valid = false;
  }
  const expired = cfg.token_expires_at ? new Date(cfg.token_expires_at) < new Date() : false;
  if (flags.json) {
    cli.out({
      authenticated: valid,
      token: maskToken(cfg.token),
      source: cfg.token_source || 'unknown',
      expires_at: cfg.token_expires_at || null,
      expired,
      store_id: cfg.store_id || null,
      stores,
    });
    return;
  }
  console.log('');
  console.log(`  ${valid ? c.green('authenticated') : c.red('token rejected')}`);
  console.log(`  token     ${c.dim(maskToken(cfg.token))}`);
  console.log(`  source    ${cfg.token_source || 'unknown'}`);
  if (cfg.token_expires_at) {
    console.log(`  expires   ${cfg.token_expires_at}${expired ? c.red('  EXPIRED') : ''}`);
  }
  for (const s of stores) {
    console.log(`  store     ${c.cyan(s.id)}  ${s.name}  ${c.dim(s.type || '')}`);
  }
}

async function cmdWhoami(flags) {
  const cfg = await loadConfig();
  const stores = unwrap(await api('/stores', { flags }));
  const list = Array.isArray(stores) ? stores : [];
  if (flags.json) {
    cli.out({ token: maskToken(activeToken || cfg.token), source: cfg.token_source, stores: list });
    return;
  }
  console.log('');
  console.log(`  ${c.cyan(c.bold('Printful'))}  ${c.dim(maskToken(activeToken || cfg.token))}`);
  console.log(c.dim(`  source: ${cfg.token_source || 'unknown'}`));
  line();
  if (!list.length) {
    console.log(c.dim('  No stores found.'));
    return;
  }
  for (const s of list) {
    console.log(`  ${c.cyan(c.bold(s.name || '(unnamed)'))}  ${c.dim(`id:${s.id}`)}  ${c.dim(s.type || '')}`);
  }
}

async function cmdStores(flags) {
  const stores = unwrap(await api('/stores', { flags }));
  const list = Array.isArray(stores) ? stores : [];
  if (flags.json) {
    cli.out(list);
    return;
  }
  console.log('');
  if (!list.length) {
    console.log(c.dim('  No stores found.'));
    return;
  }
  for (const s of list) {
    console.log(`  ${c.cyan(String(s.id).padEnd(12))} ${(s.name || '').padEnd(28)} ${c.dim(s.type || '')}`);
  }
}

// ─── files ───────────────────────────────────────────────────────────────────

async function cmdFilesList(flags) {
  const limit = num(flags.limit, 20);
  const offset = num(flags.offset, 0);
  const res = await api(`/files${qs({ limit, offset })}`, { flags });
  const list = unwrap(res);
  const files = Array.isArray(list) ? list : [];
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  if (!files.length) {
    console.log(c.dim('  No files found.'));
    return;
  }
  for (const f of files) {
    const dim = f.width && f.height ? `${f.width}×${f.height}` : '';
    console.log(
      `  ${c.cyan(c.bold(String(f.id)))}  ${(f.filename || f.url || '').slice(0, 40).padEnd(40)}  ` +
        `${c.dim(f.status || '')}  ${c.dim(dim)}`,
    );
  }
}

async function cmdFilesGet(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful files get <id>', { prefix: 'printful' });
  const res = await api(`/files/${encodeURIComponent(id)}`, { flags });
  const f = unwrap(res) || {};
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(`  ${c.cyan(c.bold(f.filename || f.id))}  ${c.dim(`id:${f.id}`)}`);
  console.log(`  status    ${f.status || ''}`);
  console.log(`  size      ${f.size || 0}  ${f.mime_type || ''}  ${f.width || '—'}×${f.height || '—'}`);
  console.log(`  hash      ${c.dim(f.hash || '—')}`);
  if (f.preview_url) console.log(`  preview   ${f.preview_url}`);
  if (f.message) console.log(`  message   ${f.message}`);
}

async function waitForFile(id, flags, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const res = await api(`/files/${encodeURIComponent(id)}`, { flags });
    last = unwrap(res) || {};
    if (last.status === 'ok' || last.status === 'failed') return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

async function cmdFilesWait(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful files wait <id> [--timeout 60]', { prefix: 'printful' });
  const timeout = num(flags.timeout, 60);
  const f = await waitForFile(id, flags, timeout);
  if (flags.json) {
    cli.out(f);
    return;
  }
  if (!f || (f.status !== 'ok' && f.status !== 'failed')) {
    cli.die(`File ${id} still ${f && f.status ? f.status : 'unknown'} after ${timeout}s`, {
      prefix: 'printful',
    });
  }
  if (f.status === 'failed') {
    cli.die(`File ${id} failed: ${f.message || 'no message'}`, { prefix: 'printful' });
  }
  console.log('');
  console.log(c.green('✓ processed') + `  ${c.cyan(f.id)}  ${f.width}×${f.height}  ${c.dim(f.hash || '')}`);
}

async function servePublicUrl(filePath) {
  const pathMod = require('path');
  const abs = pathMod.resolve(filePath);
  const dir = pathMod.dirname(abs);
  const base = pathMod.basename(abs);
  const exists = await fs.exists(abs);
  if (!exists) cli.die(`File not found: ${filePath}`, { prefix: 'printful' });
  const { stdout, stderr, exitCode } = await Promise.resolve(
    exec.spawn(['serve', '--ttl', '1d', '--no-bridge', dir]),
  );
  if (exitCode !== 0) {
    cli.die(
      `serve failed (${exitCode}): ${stderr || stdout}\n` +
        '  Host the PNG yourself and pass --url instead.',
      { prefix: 'printful' },
    );
  }
  const m = String(stdout || '').match(/https:\/\/[^\s)]+/);
  if (!m) {
    cli.die(
      `serve did not print a Preview URL.\n  stdout: ${String(stdout).slice(0, 300)}`,
      { prefix: 'printful' },
    );
  }
  const preview = m[0].replace(/\/index\.html$/i, '');
  return `${preview.replace(/\/$/, '')}/${encodeURIComponent(base)}`;
}

async function cmdFilesAdd(flags) {
  const urlFlag = str(flags.url);
  const pathFlag = str(flags.path);
  if (!urlFlag && !pathFlag) {
    cli.die('usage: printful files add --url <https> | --path <vfs-file> [--filename n] [--wait]', {
      prefix: 'printful',
    });
  }
  let url = urlFlag;
  let filename = str(flags.filename);
  if (pathFlag) {
    url = await servePublicUrl(pathFlag);
    if (!filename) filename = pathFlag.split('/').pop();
  }
  if (!filename) {
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'upload.bin');
    } catch {
      filename = 'upload.bin';
    }
  }
  const res = await api('/files', { method: 'POST', body: { url, filename }, flags });
  let f = unwrap(res) || {};
  if (bool(flags.wait) && f.id) {
    f = (await waitForFile(f.id, flags, num(flags.timeout, 60))) || f;
  }
  if (flags.json) {
    cli.out(res.result ? { ...res, result: f } : f);
    return;
  }
  console.log('');
  console.log(c.green('✓ uploaded') + `  ${c.cyan(c.bold(String(f.id)))}  ${f.filename || filename}`);
  console.log(`  status    ${f.status || 'waiting'}`);
  if (f.width) console.log(`  pixels    ${f.width}×${f.height}`);
  if (f.status === 'waiting') {
    console.log(c.dim(`  poll: printful files wait ${f.id}`));
  }
}

// ─── catalog ─────────────────────────────────────────────────────────────────

async function cmdCatalogProduct(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful catalog product <id>', { prefix: 'printful' });
  const res = await api(`/products/${encodeURIComponent(id)}`, { flags });
  const data = unwrap(res) || {};
  const product = data.product || data;
  const variants = data.variants || [];
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(`  ${c.cyan(c.bold(product.title || product.name || id))}  ${c.dim(`id:${product.id || id}`)}`);
  if (product.brand) console.log(`  brand     ${product.brand}`);
  if (product.type_name) console.log(`  type      ${product.type_name}`);
  console.log(`  variants  ${variants.length}`);
}

async function cmdCatalogVariants(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful catalog variants <product-id> [--color Black] [--size M]', {
    prefix: 'printful',
  });
  const res = await api(`/products/${encodeURIComponent(id)}`, { flags });
  const data = unwrap(res) || {};
  let variants = Array.isArray(data.variants) ? data.variants : [];
  const color = str(flags.color);
  const size = str(flags.size);
  if (color) variants = variants.filter((v) => String(v.color || '').toLowerCase() === color.toLowerCase());
  if (size) variants = variants.filter((v) => String(v.size || '').toLowerCase() === size.toLowerCase());
  if (bool(flags['in-stock'])) variants = variants.filter((v) => v.in_stock);
  if (flags.json) {
    cli.out(variants);
    return;
  }
  console.log('');
  if (!variants.length) {
    console.log(c.dim('  No variants matched.'));
    return;
  }
  for (const v of variants) {
    const stock = v.in_stock ? c.green('in stock') : c.red('out');
    console.log(
      `  ${c.cyan(String(v.id).padEnd(8))} ${(v.size || '').padEnd(5)} ${(v.color || '').padEnd(22)} ${stock}`,
    );
  }
  console.log('');
  console.log(c.dim(`  ${variants.length} variant(s)`));
}

// ─── store products ──────────────────────────────────────────────────────────

async function cmdStoreProducts(flags) {
  const limit = num(flags.limit, 20);
  const offset = num(flags.offset, 0);
  const res = await api(`/store/products${qs({ limit, offset })}`, { flags });
  const list = unwrap(res);
  const products = Array.isArray(list) ? list : [];
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  if (!products.length) {
    console.log(c.dim('  No store products found.'));
    return;
  }
  for (const p of products) {
    console.log(
      `  ${c.cyan(c.bold(p.name || '(unnamed)'))}  ${c.dim(`id:${p.id}`)}  ${c.dim(`${p.variants || 0} variant(s)`)}`,
    );
  }
}

async function cmdStoreProductGet(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful store product get <id>', { prefix: 'printful' });
  const res = await api(`/store/products/${encodeURIComponent(id)}`, { flags });
  const data = unwrap(res) || {};
  if (flags.json) {
    cli.out(res);
    return;
  }
  const sp = data.sync_product || data;
  const variants = data.sync_variants || [];
  console.log('');
  console.log(`  ${c.cyan(c.bold(sp.name || id))}  ${c.dim(`id:${sp.id || id}`)}`);
  line();
  for (const v of variants) {
    console.log(
      `  ${c.cyan(String(v.id))}  ${v.name || ''}  ${c.dim(`${v.currency || ''} ${v.retail_price || ''} · catalog ${v.variant_id}`)}`,
    );
    const preview = (v.files || []).find((f) => f.type === 'preview');
    if (preview && preview.preview_url) console.log(`    preview  ${preview.preview_url}`);
  }
}

async function cmdStoreProductCreate(flags) {
  const name = str(flags.name);
  const variantId = num(flags['variant-id'], undefined);
  const fileId = num(flags['file-id'], undefined);
  const fileUrl = str(flags['file-url']);
  const placement = str(flags.placement) || 'front';
  const retail = str(flags['retail-price']);
  if (!name || !variantId || (!fileId && !fileUrl)) {
    cli.die(
      'usage: printful store product create --name T --variant-id N --file-id F [--retail-price 24.00] --confirm',
      { prefix: 'printful' },
    );
  }
  const file = fileId ? { type: placement, id: fileId } : { type: placement, url: fileUrl };
  const body = {
    sync_product: { name },
    sync_variants: [
      {
        variant_id: variantId,
        ...(retail ? { retail_price: retail } : {}),
        files: [file],
      },
    ],
  };
  if (!bool(flags.confirm)) {
    console.log('');
    console.log(c.yellow('  Preview only (pass --confirm to create).'));
    console.log('');
    console.log(`  POST ${API}/store/products`);
    console.log(`  ${JSON.stringify(body)}`);
    return;
  }
  const res = await api('/store/products', { method: 'POST', body, flags });
  const created = unwrap(res) || {};
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(c.green('✓ created') + `  ${c.cyan(c.bold(created.name || name))}  ${c.dim(`id:${created.id}`)}`);
  console.log(c.dim('  This is a sync product — it will not appear under Meine Produkte (templates).'));
}

// ─── orders ──────────────────────────────────────────────────────────────────

async function cmdOrders(flags) {
  const limit = num(flags.limit, 20);
  const offset = num(flags.offset, 0);
  const status = str(flags.status);
  const res = await api(`/orders${qs({ limit, offset, status })}`, { flags });
  const list = unwrap(res);
  const orders = Array.isArray(list) ? list : [];
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  if (!orders.length) {
    console.log(c.dim('  No orders found.'));
    return;
  }
  for (const o of orders) {
    const cost = o.costs && o.costs.total != null ? o.costs.total : '';
    console.log(
      `  ${c.cyan(c.bold(String(o.id)))}  ${(o.status || '').padEnd(12)}  ${c.dim(cost)}  ${c.dim((o.recipient && o.recipient.name) || '')}`,
    );
  }
}

async function cmdOrderGet(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful order get <id>', { prefix: 'printful' });
  const res = await api(`/orders/${encodeURIComponent(id)}`, { flags });
  const o = unwrap(res) || {};
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(`  ${c.cyan(c.bold('Order ' + (o.id || id)))}  ${o.status || ''}`);
  if (o.costs) console.log(`  costs     ${o.costs.currency || ''} ${o.costs.total || ''}`);
  if (o.recipient) {
    const r = o.recipient;
    console.log(`  ship to   ${r.name || ''} — ${r.city || ''} ${r.country_code || ''}`);
  }
  for (const it of o.items || []) {
    console.log(`  item      ${it.name || it.variant_id}  ×${it.quantity || 1}`);
  }
}

function recipientFromFlags(flags) {
  const name = str(flags.name);
  const address1 = str(flags.address1);
  const city = str(flags.city);
  const country = str(flags.country);
  const zip = str(flags.zip);
  if (!name || !address1 || !city || !country || !zip) return null;
  const rec = {
    name,
    address1,
    city,
    country_code: country,
    zip,
  };
  if (str(flags.address2)) rec.address2 = str(flags.address2);
  if (str(flags.state)) rec.state_code = str(flags.state);
  return rec;
}

async function cmdOrderCreate(flags) {
  const variantId = num(flags['variant-id'], undefined);
  const fileId = num(flags['file-id'], undefined);
  const fileUrl = str(flags['file-url']);
  const quantity = num(flags.quantity, 1);
  const placement = str(flags.placement) || 'front';
  const rec = recipientFromFlags(flags);
  if (!variantId || (!fileId && !fileUrl) || !rec) {
    cli.die(
      'usage: printful order create --variant-id N --file-id F --name "…" --address1 "…" --city C --country DE --zip Z\n' +
        '  Posts a DRAFT (no charge). Then: printful order confirm <id> --confirm',
      { prefix: 'printful' },
    );
  }
  const file = fileId ? { type: placement, id: fileId } : { type: placement, url: fileUrl };
  const body = {
    recipient: rec,
    items: [{ variant_id: variantId, quantity, files: [file] }],
  };
  const res = await api('/orders', { method: 'POST', body, flags });
  const o = unwrap(res) || {};
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(c.green('✓ draft created') + `  ${c.cyan(c.bold(String(o.id)))}  ${c.dim(o.status || 'draft')}`);
  if (o.costs) console.log(`  costs     ${o.costs.currency || ''} ${o.costs.total || ''}  (not charged)`);
  console.log(c.dim(`  charge: printful order confirm ${o.id} --confirm`));
}

async function cmdOrderConfirm(positional, flags) {
  const id = str(positional[0]);
  if (!id) cli.die('usage: printful order confirm <id> --confirm', { prefix: 'printful' });
  const current = unwrap(await api(`/orders/${encodeURIComponent(id)}`, { flags })) || {};
  if (!bool(flags.confirm)) {
    console.log('');
    console.log(c.yellow('  Preview only (pass --confirm to CHARGE the account).'));
    console.log(`  order     ${id}  ${current.status || ''}`);
    if (current.costs) console.log(`  costs     ${current.costs.currency || ''} ${current.costs.total || ''}`);
    if (current.recipient) {
      console.log(`  ship to   ${current.recipient.name || ''} — ${current.recipient.city || ''}`);
    }
    console.log(`  POST ${API}/orders/${id}/confirm`);
    return;
  }
  const res = await api(`/orders/${encodeURIComponent(id)}/confirm`, { method: 'POST', flags });
  const o = unwrap(res) || {};
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(c.green('✓ confirmed') + `  ${c.cyan(String(o.id || id))}  ${o.status || ''}`);
  if (o.costs) console.log(`  charged   ${o.costs.currency || ''} ${o.costs.total || ''}`);
}

// ─── api escape hatch ────────────────────────────────────────────────────────

async function cmdApi(positional, flags) {
  const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  let method = 'GET';
  let path = str(positional[0]);
  if (path && methods.has(path.toUpperCase())) {
    method = path.toUpperCase();
    path = str(positional[1]);
  }
  if (!path) cli.die('usage: printful api [METHOD] <path|url> [--data <json>]', { prefix: 'printful' });
  let body;
  const data = str(flags.data);
  if (data) {
    try {
      body = JSON.parse(data);
    } catch {
      body = data;
    }
  }
  const res = await api(path, { method, body, flags });
  cli.out(res);
}

async function cmdVersion(flags) {
  const cfg = await loadConfig();
  const info = {
    skill: 'printful',
    version: SKILL_VERSION,
    api_base: API,
    docs: 'https://developers.printful.com/docs/',
    authenticated: !!cfg.token,
    token_source: cfg.token_source || null,
  };
  if (flags.json) {
    cli.out(info);
    return;
  }
  console.log('');
  console.log(`  ${c.bold('printful')} ${SKILL_VERSION}`);
  console.log(`  api     ${API}`);
  console.log(`  auth    ${cfg.token ? maskToken(cfg.token) : 'none'}  ${c.dim(cfg.token_source || '')}`);
}

// ─── main ────────────────────────────────────────────────────────────────────

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);

  try {
    const s = subcommand;
    const p0 = str(positional[0]);

    if (s === 'auth') {
      if (p0 === 'login' || p0 === 'add') return await cmdAuthLogin(flags);
      if (p0 === 'logout' || p0 === 'revoke' || p0 === 'delete') return await cmdAuthLogout();
      if (p0 === 'status' || p0 === 'show' || !p0) return await cmdAuthStatus(flags);
      cli.die(`unknown auth subcommand: ${p0}\n  printful auth login | status | logout`, {
        prefix: 'printful',
      });
    }
    if (s === 'login') return await cmdAuthLogin(flags);
    if (s === 'logout') return await cmdAuthLogout();
    if (s === 'whoami') return await cmdWhoami(flags);
    if (s === 'stores' || s === 'store' && !p0) {
      if (s === 'stores') return await cmdStores(flags);
    }
    if (s === 'version') return await cmdVersion(flags);

    if (s === 'files' || s === 'file') {
      if (p0 === 'list' || !p0) return await cmdFilesList(flags);
      if (p0 === 'get') return await cmdFilesGet(positional.slice(1), flags);
      if (p0 === 'add' || p0 === 'upload') return await cmdFilesAdd(flags);
      if (p0 === 'wait') return await cmdFilesWait(positional.slice(1), flags);
      cli.die(`unknown files subcommand: ${p0}\n  printful files list | get | add | wait`, {
        prefix: 'printful',
      });
    }

    if (s === 'catalog') {
      if (p0 === 'product' || p0 === 'get') return await cmdCatalogProduct(positional.slice(1), flags);
      if (p0 === 'variants' || p0 === 'variant') return await cmdCatalogVariants(positional.slice(1), flags);
      cli.die(`unknown catalog subcommand: ${p0}\n  printful catalog product | variants`, {
        prefix: 'printful',
      });
    }

    if (s === 'store') {
      if (p0 === 'products' || (p0 === 'product' && str(positional[1]) === 'list')) {
        return await cmdStoreProducts(flags);
      }
      if (p0 === 'product') {
        const p1 = str(positional[1]);
        if (p1 === 'get') return await cmdStoreProductGet(positional.slice(2), flags);
        if (p1 === 'create' || p1 === 'add') return await cmdStoreProductCreate(flags);
        if (p1 && /^\d+$/.test(p1)) return await cmdStoreProductGet(positional.slice(1), flags);
        cli.die(
          `unknown: printful store product ${p1 || ''}\n  printful store products | product get | product create`,
          { prefix: 'printful' },
        );
      }
      if (!p0) return await cmdStores(flags);
      cli.die(`unknown store subcommand: ${p0}\n  printful store products | product get | product create`, {
        prefix: 'printful',
      });
    }

    if (s === 'orders') return await cmdOrders(flags);
    if (s === 'order') {
      if (p0 === 'list' || !p0) return await cmdOrders(flags);
      if (p0 === 'get') return await cmdOrderGet(positional.slice(1), flags);
      if (p0 === 'create' || p0 === 'add') return await cmdOrderCreate(flags);
      if (p0 === 'confirm') return await cmdOrderConfirm(positional.slice(1), flags);
      if (p0 && /^\d+$/.test(p0)) return await cmdOrderGet(positional, flags);
      cli.die(`unknown order subcommand: ${p0}\n  printful orders | order get | order create | order confirm`, {
        prefix: 'printful',
      });
    }

    if (s === 'api') return await cmdApi(positional, flags);

    cli.die(`unknown command: ${s}\nRun 'printful --help' for usage.`, { prefix: 'printful' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(err.message, { prefix: 'printful' });
  }
}

await main();
