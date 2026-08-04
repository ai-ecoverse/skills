// fastly.jsh — a working subset of the official `fastly` CLI
// (https://github.com/fastly/cli), implemented directly against the Fastly API
// at https://api.fastly.com.
//
// Design rule: command and flag names mirror the upstream Go CLI EXACTLY
// (`fastly service list`, `--service-id`, `--per-page`, `--by`, …) so muscle
// memory and copy-pasted docs transfer. Anything the upstream CLI does NOT have
// — notably billing/invoices, which has no command group upstream — lives in the
// sibling binary `fastly-ext` (scripts/fastly-ext.jsh) so that `fastly` stays
// command-compatible.
//
// Auth model (mirrors `fastly auth login`): a long-lived Fastly API token sent
// as the `Fastly-Key` header. `fastly auth login --token <tok>` validates and
// persists it via skill.config(). With no --token we fall back to harvesting the
// short-lived (~12h) API token that the manage.fastly.com SPA keeps in
// sessionStorage under `fastly-auth__session__active-token`. Tokens are never
// printed to stdout.

const cli = require('sliccy:cli');
const skill = require('sliccy:skill');
const browser = require('sliccy:browser');
const fs = require('fs');
const c = require('sliccy:color');

// ─── Constants ───────────────────────────────────────────────────────────────

const API = 'https://api.fastly.com';
// Realtime stats live on a different host but take the same Fastly-Key.
const ALLOWED_HOSTS = new Set(['api.fastly.com', 'rt.fastly.com']);
const MANAGE_URL = 'https://manage.fastly.com';
const TOKEN_UI_URL = 'https://manage.fastly.com/account/personal/tokens';
// sessionStorage key used by the manage.fastly.com SPA for its live API token.
const SESSION_TOKEN_KEY = 'fastly-auth__session__active-token';
const SKILL_VERSION = '1.0.0';

// ─── Config / token plumbing ─────────────────────────────────────────────────

async function loadConfig() {
  // MUST await before the `|| {}` fallback: skill.config() returns a Promise
  // (always truthy), so `skill.config() || {}` never falls back and reading a
  // property off a null resolved config throws.
  return (await skill.config()) || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

/** Flag values are strings only when a value was actually supplied; single-dash
 *  short flags and value-less long flags come back as boolean `true`. Coerce
 *  those to undefined so they never leak into URLs, headers or config. */
function str(v) {
  return typeof v === 'string' ? v : undefined;
}

function num(v, dflt) {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
}

/** Last 4 characters only — enough to tell two tokens apart, useless if leaked. */
function maskToken(tok) {
  if (!tok) return '(none)';
  return `…${String(tok).slice(-4)}`;
}

/** Read the live manage.fastly.com session token out of the browser tab.
 *  Returns the parsed session object, or null when unavailable. */
async function harvestSessionToken() {
  let tab;
  try {
    tab = await browser.findTab({ urlMatch: /manage\.fastly\.com/ });
  } catch {
    tab = null;
  }
  if (!tab) return null;
  let raw;
  try {
    raw = await browser.eval(tab, `sessionStorage.getItem(${JSON.stringify(SESSION_TOKEN_KEY)})`);
  } catch {
    return null;
  }
  if (!raw) return null;
  // browser.eval JSON-parses page results opportunistically, so the
  // sessionStorage string may already arrive as an object. Handle both.
  let sess = raw;
  if (typeof raw === 'string') {
    try {
      sess = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return sess && typeof sess === 'object' && sess.accessToken ? sess : null;
}

/** Token resolution order: --token flag > stored config > one-shot browser harvest. */
let cachedToken;
let reharvested = false;
// The token the last request actually used — including a `--token` override,
// which is deliberately never cached or persisted. Only ever rendered masked.
let activeToken;

/** Resolve a token and record which one was used, so `whoami` masks the token
 *  that authenticated the call rather than whatever happens to be cached. */
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
  const sess = await harvestSessionToken();
  if (sess) {
    cachedToken = sess.accessToken;
    await saveConfig({
      token: sess.accessToken,
      token_source: 'browser-session',
      token_expires_at: sess.expiresAt || null,
      customer_id: sess.customerId || null,
    });
    cli.warn(
      `no stored token — harvested the manage.fastly.com browser session token (expires ${sess.expiresAt || 'unknown'}).\n` +
        `  For a durable setup create a personal API token at ${TOKEN_UI_URL} and run: fastly auth login --token <tok>`,
      { prefix: 'fastly' },
    );
    return cachedToken;
  }
  cli.die(
    'Not authenticated.\n' +
      `  1. Create a personal API token: ${TOKEN_UI_URL}\n` +
      '  2. fastly auth login --token <token>\n' +
      `  Or open a logged-in ${MANAGE_URL} tab and retry — the browser session token is harvested automatically.`,
    { prefix: 'fastly' },
  );
}

/** Guard against sending the account's API token to an arbitrary host. */
function resolveUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '');
  const full = /^https?:\/\//i.test(raw) ? raw : `${API}${raw.startsWith('/') ? '' : '/'}${raw}`;
  let u;
  try {
    u = new URL(full);
  } catch {
    cli.die(`Invalid URL or path: ${raw}`, { prefix: 'fastly' });
  }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) {
    cli.die(
      `Refusing to send the Fastly API token to ${u.protocol}//${u.hostname}. ` +
        `Allowed hosts: ${[...ALLOWED_HOSTS].join(', ')}.`,
      { prefix: 'fastly' },
    );
  }
  return u.toString();
}

/** Fastly packs errors into several different shapes; extract the useful text. */
function fastlyError(text, status) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return text || `HTTP ${status}`;
  }
  const parts = [];
  if (j.msg) parts.push(j.msg);
  if (j.title) parts.push(j.title);
  if (j.detail && j.detail !== j.msg) parts.push(j.detail);
  if (Array.isArray(j.errors)) {
    for (const e of j.errors) parts.push(e?.detail || e?.title || JSON.stringify(e));
  }
  return parts.length ? parts.join(' — ') : text;
}

/** Authenticated JSON request against api.fastly.com / rt.fastly.com.
 *  On 401 with a harvested browser token, re-harvest once and retry. */
async function api(pathOrUrl, opts = {}) {
  const url = resolveUrl(pathOrUrl);
  const flags = opts.flags;
  const token = await getToken(flags);
  const headers = {
    'Fastly-Key': token,
    Accept: 'application/json',
    ...(opts.headers || {}),
  };
  let body = opts.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { method: opts.method || 'GET', headers, body });
  const text = await res.text();

  if (res.status === 401 && !reharvested && !str(flags && flags.token)) {
    reharvested = true;
    const cfg = await loadConfig();
    if (cfg.token_source === 'browser-session') {
      const sess = await harvestSessionToken();
      if (sess && sess.accessToken !== cfg.token) {
        cachedToken = sess.accessToken;
        await saveConfig({ token: sess.accessToken, token_expires_at: sess.expiresAt || null });
        return await api(pathOrUrl, opts);
      }
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      cli.die(
        `Fastly rejected the token (401): ${fastlyError(text, res.status)}\n` +
          '  Run: fastly auth status   (then: fastly auth login --token <tok>)',
        { prefix: 'fastly' },
      );
    }
    if (res.status === 403) {
      // Fastly answers 403 (not 404) for resources outside your customer
      // account, so this is usually "wrong id", not "bad credential".
      cli.die(
        `Fastly denied the request (403): ${fastlyError(text, res.status)}\n` +
          '  The token authenticated fine — check the id belongs to your account, or that\n' +
          '  the token scope covers this resource (fastly auth status shows the scope).',
        { prefix: 'fastly' },
      );
    }
    cli.die(`Fastly API ${res.status}: ${fastlyError(text, res.status)}`, { prefix: 'fastly' });
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function human(n) {
  const x = Number(n) || 0;
  const abs = Math.abs(x);
  if (abs >= 1e12) return `${(x / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
  return String(x);
}

function bytes(n) {
  const x = Number(n) || 0;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = x;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function ts(epochSeconds) {
  if (!epochSeconds) return '';
  return new Date(Number(epochSeconds) * 1000).toISOString().replace('T', ' ').slice(0, 16);
}

/** Build a query string, dropping unset / boolean-only flags. */
function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ─── auth / whoami ───────────────────────────────────────────────────────────

async function cmdAuthLogin(flags) {
  const tok = str(flags.token);
  if (tok) {
    // Validate before persisting so a typo fails loudly instead of silently.
    const self = await api('/tokens/self', { flags: { token: tok } });
    await saveConfig({
      token: tok,
      token_source: 'api-token',
      token_expires_at: self.expires_at || null,
      customer_id: self.customer_id || null,
    });
    cachedToken = tok;
    console.log(c.green('✓ Token stored') + c.dim(`  (${self.name || 'unnamed'}, scope: ${self.scope || self.scopes || 'n/a'}, ${maskToken(tok)})`));
    if (self.expires_at) console.log(c.dim(`  expires: ${self.expires_at}`));
    return;
  }

  console.log('');
  console.log(`  ${c.bold('No --token given.')} A long-lived personal API token is the durable option:`);
  console.log(`    1. Open ${c.cyan(TOKEN_UI_URL)}`);
  console.log('    2. Create a token (scope "global" for full access, or read-only if you only query)');
  console.log(`    3. ${c.cyan('fastly auth login --token <token>')}`);
  console.log('');
  console.log(c.dim('  Trying the browser-session fallback…'));

  const sess = await harvestSessionToken();
  if (!sess) {
    cli.die(
      `No logged-in ${MANAGE_URL} tab found, so nothing to harvest.\n` +
        '  Either open one, or pass --token <token>.',
      { prefix: 'fastly' },
    );
  }
  const self = await api('/tokens/self', { flags: { token: sess.accessToken } });
  await saveConfig({
    token: sess.accessToken,
    token_source: 'browser-session',
    token_expires_at: sess.expiresAt || self.expires_at || null,
    customer_id: sess.customerId || self.customer_id || null,
  });
  cachedToken = sess.accessToken;
  console.log(
    c.green('✓ Harvested the manage.fastly.com browser session token') +
      c.dim(`  (${maskToken(sess.accessToken)})`),
  );
  console.log(
    c.yellow(`  This token expires ${sess.expiresAt || self.expires_at || 'soon'} — it is a session token, not a durable credential.`),
  );
}

async function cmdAuthLogout() {
  const cfg = await loadConfig();
  await skill.config({ ...cfg, token: null, token_source: null, token_expires_at: null });
  cachedToken = undefined;
  console.log(c.green('✓ Cleared the stored Fastly token.'));
  console.log(c.dim('  Note: this only forgets it locally. Revoke it in the UI if it leaked: ') + c.cyan(TOKEN_UI_URL));
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
    console.log(c.dim(`  fastly auth login --token <tok>   (create one at ${TOKEN_UI_URL})`));
    return;
  }
  let self = null;
  let valid = true;
  try {
    self = await api('/tokens/self', { flags });
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
      expires_at: cfg.token_expires_at || self?.expires_at || null,
      expired,
      name: self?.name || null,
      scope: self?.scope || null,
      customer_id: self?.customer_id || cfg.customer_id || null,
    });
    return;
  }
  console.log('');
  console.log(`  ${valid ? c.green('● valid') : c.red('● rejected')}  ${c.dim(maskToken(cfg.token))}`);
  console.log(`  ${c.dim('source')}      ${cfg.token_source || 'unknown'}`);
  if (self?.name) console.log(`  ${c.dim('name')}        ${self.name}`);
  if (self?.scope) console.log(`  ${c.dim('scope')}       ${self.scope}`);
  const exp = cfg.token_expires_at || self?.expires_at;
  if (exp) console.log(`  ${c.dim('expires')}     ${expired ? c.red(exp) : exp}`);
  else console.log(`  ${c.dim('expires')}     ${c.green('never')}`);
}

async function cmdWhoami(flags) {
  const user = await api('/current_user', { flags });
  let self = null;
  try {
    self = await api('/tokens/self', { flags });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
  }
  if (flags.json) {
    cli.out({ user, token: self ? { ...self, id: self.id } : null });
    return;
  }
  console.log('');
  console.log(`  ${c.cyan(c.bold(user.login || user.id || 'unknown'))}  ${c.dim(user.name || '')}`);
  console.log(`  ${c.dim('role')}         ${user.role || '?'}${user.locked ? c.red('  (locked)') : ''}`);
  console.log(`  ${c.dim('user id')}      ${user.id || '?'}`);
  console.log(`  ${c.dim('customer id')}  ${user.customer_id || '?'}`);
  console.log(`  ${c.dim('2FA')}          ${user.two_factor_auth_enabled ? c.green('enabled') : c.yellow('disabled')}`);
  if (self) {
    console.log('');
    console.log(`  ${c.dim('token')}        ${self.name || 'unnamed'}  ${c.dim(maskToken(activeToken))}`);
    console.log(`  ${c.dim('token scope')}  ${self.scope || (self.scopes || []).join(',') || 'n/a'}`);
    console.log(`  ${c.dim('token expiry')} ${self.expires_at ? self.expires_at : c.green('never')}`);
  }
}

// ─── service ─────────────────────────────────────────────────────────────────

/** --service-id, or the upstream alias --service; --service-name resolves by name. */
async function resolveServiceId(flags, { required = true } = {}) {
  const id = str(flags['service-id']) || str(flags.service);
  if (id) return id;
  const name = str(flags['service-name']);
  if (name) {
    const svc = await api(`/service/search${qs({ name })}`, { flags });
    if (!svc || !svc.id) cli.die(`No service named "${name}".`, { prefix: 'fastly' });
    return svc.id;
  }
  if (required) {
    cli.die('--service-id <id> (or --service-name <name>) is required.', { prefix: 'fastly' });
  }
  return undefined;
}

async function cmdServiceList(flags) {
  const page = num(flags.page);
  const perPage = num(flags['per-page']);
  const query = qs({
    page,
    per_page: perPage,
    sort: str(flags.sort),
    direction: str(flags.direction),
  });
  const services = await api(`/service${query}`, { flags });
  const list = Array.isArray(services) ? services : [];
  if (flags.json) {
    cli.out(list);
    return;
  }
  if (!list.length) {
    console.log(c.dim('  No services found.'));
    return;
  }
  console.log('');
  for (const s of list) {
    const active = (s.environments || []).map((e) => e.active_version).find((v) => v);
    console.log(
      `  ${c.cyan(c.bold(s.id))}  ${c.dim((s.type || 'vcl').padEnd(7))} ` +
        `${c.dim(`v${s.version ?? '?'}${active ? ` active:${active}` : ''}`.padEnd(18))} ${s.name || ''}`,
    );
  }
  console.log('');
  console.log(c.dim(`  ${list.length} service(s)`));
}

async function cmdServiceDescribe(positional, flags) {
  const id = str(positional[0]) || (await resolveServiceId(flags));
  const s = await api(`/service/${encodeURIComponent(id)}/details`, { flags });
  if (flags.json) {
    cli.out(s);
    return;
  }
  const versions = Array.isArray(s.versions) ? s.versions : [];
  const active = versions.find((v) => v.active);
  console.log('');
  console.log(`  ${c.cyan(c.bold(s.name || s.id))}`);
  console.log(`  ${c.dim('id')}           ${s.id}`);
  console.log(`  ${c.dim('type')}         ${s.type || 'vcl'}`);
  console.log(`  ${c.dim('customer')}     ${s.customer_id || '?'}`);
  console.log(`  ${c.dim('created')}      ${s.created_at || '?'}`);
  console.log(`  ${c.dim('updated')}      ${s.updated_at || '?'}`);
  console.log(`  ${c.dim('versions')}     ${versions.length} total, active: ${active ? active.number : c.yellow('none')}`);
  if (s.comment) console.log(`  ${c.dim('comment')}      ${s.comment}`);
  const v = s.version || active;
  const domains = (v && v.domains) || [];
  const backends = (v && v.backends) || [];
  if (domains.length) {
    console.log('');
    console.log(`  ${c.bold('domains')}`);
    for (const d of domains.slice(0, 25)) console.log(`    ${d.name}${d.comment ? c.dim(`  ${d.comment}`) : ''}`);
    if (domains.length > 25) console.log(c.dim(`    … ${domains.length - 25} more`));
  }
  if (backends.length) {
    console.log('');
    console.log(`  ${c.bold('backends')}`);
    for (const b of backends.slice(0, 25)) {
      console.log(`    ${c.cyan(b.name)}  ${c.dim(`${b.address || b.hostname || ''}:${b.port ?? ''}`)}`);
    }
    if (backends.length > 25) console.log(c.dim(`    … ${backends.length - 25} more`));
  }
}

async function cmdServiceSearch(flags) {
  const name = str(flags.name);
  if (!name) cli.die('usage: fastly service search --name <name>', { prefix: 'fastly' });
  const s = await api(`/service/search${qs({ name })}`, { flags });
  if (flags.json) {
    cli.out(s);
    return;
  }
  // /service/search returns the full service object but no top-level `version`;
  // derive the active version from the embedded versions array.
  const versions = Array.isArray(s.versions) ? s.versions : [];
  const active = versions.find((v) => v.active);
  console.log('');
  console.log(
    `  ${c.cyan(c.bold(s.id))}  ${s.name || ''}  ` +
      c.dim(`${versions.length} version(s), active: ${active ? active.number : 'none'}`),
  );
}

async function cmdServiceVersionList(flags) {
  const id = await resolveServiceId(flags);
  const versions = await api(`/service/${encodeURIComponent(id)}/version`, { flags });
  const list = Array.isArray(versions) ? versions : [];
  if (flags.json) {
    cli.out(list);
    return;
  }
  // Newest first — services can accumulate thousands of versions.
  const sorted = [...list].sort((a, b) => (b.number || 0) - (a.number || 0));
  console.log('');
  for (const v of sorted.slice(0, 30)) {
    const mark = v.active ? c.green('● active') : v.locked ? c.dim('  locked') : c.dim('  draft ');
    console.log(`  ${String(v.number).padStart(6)}  ${mark}  ${c.dim(v.updated_at || '')}  ${v.comment || ''}`);
  }
  if (sorted.length > 30) console.log(c.dim(`  … ${sorted.length - 30} older version(s) (use --json for all)`));
  console.log('');
  console.log(c.dim(`  ${sorted.length} version(s)`));
}

/** Resolve 'active' | 'latest' | 'staged' | <number> to a concrete version number.
 *  'active' is a single cheap call; 'latest'/'staged' need the full version list,
 *  which is large on services with thousands of versions. */
async function resolveVersion(serviceId, spec, flags) {
  const want = (str(spec) || 'active').toLowerCase();
  if (/^\d+$/.test(want)) return Number(want);
  if (want === 'active') {
    const v = await api(`/service/${encodeURIComponent(serviceId)}/version/active`, { flags });
    if (!v || !v.number) cli.die(`Service ${serviceId} has no active version.`, { prefix: 'fastly' });
    return v.number;
  }
  const list = await api(`/service/${encodeURIComponent(serviceId)}/version`, { flags });
  const arr = Array.isArray(list) ? list : [];
  if (want === 'latest') {
    const max = arr.reduce((m, v) => Math.max(m, v.number || 0), 0);
    if (!max) cli.die(`Service ${serviceId} has no versions.`, { prefix: 'fastly' });
    return max;
  }
  if (want === 'staged') {
    const st = arr.find((v) => v.staging);
    if (!st) cli.die(`Service ${serviceId} has no staged version.`, { prefix: 'fastly' });
    return st.number;
  }
  cli.die(`--version must be 'active', 'latest', 'staged' or a version number (got: ${want}).`, {
    prefix: 'fastly',
  });
}

async function cmdServiceDomainList(flags) {
  const id = await resolveServiceId(flags);
  const version = await resolveVersion(id, flags.version, flags);
  const domains = await api(`/service/${encodeURIComponent(id)}/version/${version}/domain`, { flags });
  const list = Array.isArray(domains) ? domains : [];
  if (flags.json) {
    cli.out(list);
    return;
  }
  console.log('');
  console.log(`  ${c.dim(`service ${id} · version ${version}`)}`);
  console.log('');
  if (!list.length) {
    console.log(c.dim('  No domains on this version.'));
    return;
  }
  for (const d of list) console.log(`  ${c.cyan(d.name)}${d.comment ? c.dim(`  ${d.comment}`) : ''}`);
  console.log('');
  console.log(c.dim(`  ${list.length} domain(s)`));
}

async function cmdServicePurge(flags) {
  const id = await resolveServiceId(flags, { required: !str(flags.url) });
  const url = str(flags.url);
  const key = str(flags.key);
  const file = str(flags.file);
  const soft = !!flags.soft;
  const modes = [flags.all ? '--all' : null, url ? '--url' : null, key ? '--key' : null, file ? '--file' : null].filter(Boolean);
  if (modes.length !== 1) {
    cli.die('Pick exactly one of --all, --url <url>, --key <surrogate-key>, --file <path>.', {
      prefix: 'fastly',
    });
  }

  let target;
  let request;
  if (flags.all) {
    target = `EVERYTHING cached by service ${id}`;
    request = { path: `/service/${encodeURIComponent(id)}/purge_all`, method: 'POST' };
  } else if (url) {
    // Documented single-URL purge form; keeps the token on api.fastly.com
    // instead of sending it to an arbitrary edge host.
    const stripped = url.replace(/^https?:\/\//i, '');
    target = `URL ${url}`;
    request = { path: `/purge/${stripped}`, method: 'POST' };
  } else if (key) {
    target = `surrogate key "${key}" on service ${id}`;
    request = { path: `/service/${encodeURIComponent(id)}/purge/${encodeURIComponent(key)}`, method: 'POST' };
  } else {
    let raw;
    try {
      raw = await fs.readFile(file);
    } catch {
      cli.die(`Cannot read --file ${file}`, { prefix: 'fastly' });
    }
    const keys = String(raw)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!keys.length) cli.die(`No surrogate keys found in ${file}.`, { prefix: 'fastly' });
    target = `${keys.length} surrogate key(s) from ${file} on service ${id}`;
    request = {
      path: `/service/${encodeURIComponent(id)}/purge`,
      method: 'POST',
      body: { surrogate_keys: keys },
    };
  }

  if (!flags.confirm) {
    console.log('');
    console.log(`  ${c.yellow('would purge')} ${c.bold(target)}${soft ? c.dim('  (soft — mark stale)') : ''}`);
    console.log(c.dim(`  ${request.method} ${API}${request.path}`));
    console.log('');
    console.log(c.dim('  Re-run with --confirm to actually purge.'));
    return;
  }
  const headers = soft ? { 'Fastly-Soft-Purge': '1' } : {};
  const out = await api(request.path, { method: request.method, body: request.body, headers, flags });
  if (flags.json) {
    cli.out(out);
    return;
  }
  console.log(c.green(`✓ Purged ${target}`) + (soft ? c.dim(' (soft)') : ''));
  if (out && out.id) console.log(c.dim(`  purge id: ${out.id}`));
}

// ─── domain (Domains v1 — account-wide, not version-scoped) ──────────────────

async function cmdDomainList(flags) {
  // `--version` implies the caller means the version-scoped domain list, which
  // upstream spells `fastly service domain list`. Route there so both work.
  if (flags.version !== undefined) return await cmdServiceDomainList(flags);
  const query = qs({
    service_id: str(flags['service-id']) || str(flags.service),
    fqdn: str(flags.fqdn),
    limit: num(flags.limit),
    cursor: str(flags.cursor),
    sort: str(flags.sort),
  });
  const res = await api(`/domains/v1${query}`, { flags });
  const list = Array.isArray(res.data) ? res.data : [];
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  if (!list.length) {
    console.log(c.dim('  No domains found.'));
    return;
  }
  for (const d of list) {
    const state = d.activated ? c.green('●') : c.dim('○');
    const ver = d.verified ? c.dim(' verified') : c.yellow(' unverified');
    console.log(`  ${state} ${c.cyan(d.fqdn)}${ver}  ${c.dim(d.service_id || 'no service')}`);
  }
  console.log('');
  console.log(c.dim(`  ${list.length} domain(s)${res.meta?.total ? ` of ${res.meta.total}` : ''}`));
  if (res.meta?.next_cursor) console.log(c.dim(`  next page: --cursor ${res.meta.next_cursor}`));
}

async function cmdDomainDescribe(positional, flags) {
  const id = str(positional[0]) || str(flags['domain-id']);
  if (!id) cli.die('usage: fastly domain describe <domain-id>', { prefix: 'fastly' });
  const d = await api(`/domains/v1/${encodeURIComponent(id)}`, { flags });
  if (flags.json) {
    cli.out(d);
    return;
  }
  console.log('');
  console.log(`  ${c.cyan(c.bold(d.fqdn || d.id))}`);
  console.log(`  ${c.dim('id')}          ${d.id}`);
  console.log(`  ${c.dim('service')}     ${d.service_id || c.yellow('(none)')}`);
  console.log(`  ${c.dim('activated')}   ${d.activated ? c.green('yes') : c.yellow('no')}`);
  console.log(`  ${c.dim('verified')}    ${d.verified ? c.green('yes') : c.yellow('no')}`);
  console.log(`  ${c.dim('created')}     ${d.created_at || '?'}`);
  console.log(`  ${c.dim('updated')}     ${d.updated_at || '?'}`);
}

// ─── stats ───────────────────────────────────────────────────────────────────

function statsRow(label, d) {
  const hitRatio =
    d.hit_ratio !== undefined && d.hit_ratio !== null
      ? d.hit_ratio
      : (d.hits || 0) + (d.miss || 0) > 0
        ? (d.hits || 0) / ((d.hits || 0) + (d.miss || 0))
        : null;
  return (
    `  ${c.dim(label.padEnd(18))} ${human(d.requests).padStart(9)} req  ` +
    `${bytes(d.bandwidth).padStart(11)}  ` +
    `hit ${hitRatio === null ? ' n/a' : `${(hitRatio * 100).toFixed(1)}%`}  ` +
    `${c.dim(`4xx ${human(d.status_4xx)} 5xx ${human(d.status_5xx)} err ${human(d.errors)}`)}`
  );
}

function sumStats(rows) {
  const total = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number' && k !== 'start_time' && k !== 'hit_ratio') {
        total[k] = (total[k] || 0) + v;
      }
    }
  }
  return total;
}

function statsQuery(flags) {
  return qs({
    from: str(flags.from),
    to: str(flags.to),
    by: str(flags.by) || 'day',
    region: str(flags.region),
  });
}

async function cmdStatsHistorical(flags) {
  const serviceId = str(flags['service-id']) || str(flags.service);
  const field = str(flags.field);
  const query = statsQuery(flags);

  if (serviceId) {
    const path = field
      ? `/stats/service/${encodeURIComponent(serviceId)}/field/${encodeURIComponent(field)}${query}`
      : `/stats/service/${encodeURIComponent(serviceId)}${query}`;
    const res = await api(path, { flags });
    if (flags.json) {
      cli.out(res);
      return;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    console.log('');
    console.log(`  ${c.bold(serviceId)}  ${c.dim(`${res.meta?.from} → ${res.meta?.to}  by ${res.meta?.by}`)}`);
    console.log('');
    if (!rows.length) {
      console.log(c.dim('  No stats in this window (service may have had no traffic).'));
      return;
    }
    for (const r of rows.slice(-31)) {
      if (field) console.log(`  ${c.dim(ts(r.start_time).padEnd(18))} ${human(r[field]).padStart(12)} ${c.dim(field)}`);
      else console.log(statsRow(ts(r.start_time), r));
    }
    if (!field) {
      console.log('');
      console.log(statsRow('TOTAL', sumStats(rows)));
    }
    return;
  }

  // Account-wide, per service. The raw payload is megabytes, so summarise.
  const path = field ? `/stats/field/${encodeURIComponent(field)}${query}` : `/stats${query}`;
  const res = await api(path, { flags });
  if (flags.json) {
    cli.out(res);
    return;
  }
  const byService = res.data && !Array.isArray(res.data) ? res.data : {};
  const entries = Object.entries(byService).map(([sid, rows]) => [sid, sumStats(Array.isArray(rows) ? rows : [])]);
  entries.sort((a, b) => (b[1][field || 'requests'] || 0) - (a[1][field || 'requests'] || 0));
  console.log('');
  console.log(`  ${c.bold('all services')}  ${c.dim(`${res.meta?.from} → ${res.meta?.to}  by ${res.meta?.by}`)}`);
  console.log('');
  for (const [sid, t] of entries.slice(0, 20)) {
    if (field) console.log(`  ${c.cyan(sid)}  ${human(t[field]).padStart(12)} ${c.dim(field)}`);
    else console.log(statsRow(sid, t));
  }
  if (entries.length > 20) console.log(c.dim(`  … ${entries.length - 20} more service(s) (use --json for all)`));
  console.log('');
  const grand = sumStats(entries.map(([, t]) => t));
  if (field) console.log(`  ${c.bold('TOTAL'.padEnd(24))} ${human(grand[field]).padStart(12)} ${c.dim(field)}`);
  else console.log(statsRow('TOTAL', grand));
  console.log(c.dim(`  ${entries.length} service(s) with traffic`));
}

async function cmdStatsAggregate(flags) {
  const res = await api(`/stats/aggregate${statsQuery(flags)}`, { flags });
  if (flags.json) {
    cli.out(res);
    return;
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  console.log('');
  console.log(`  ${c.bold('account aggregate')}  ${c.dim(`${res.meta?.from} → ${res.meta?.to}  by ${res.meta?.by}  region ${res.meta?.region}`)}`);
  console.log('');
  if (!rows.length) {
    console.log(c.dim('  No data in this window.'));
    return;
  }
  for (const r of rows.slice(-31)) console.log(statsRow(ts(r.start_time), r));
  console.log('');
  console.log(statsRow('TOTAL', sumStats(rows)));
  const nFields = Object.keys(rows[0]).filter((k) => typeof rows[0][k] === 'number').length;
  console.log(c.dim(`  ${rows.length} period(s); ${nFields} metrics per period available via --json`));
}

async function cmdStatsUsage(flags) {
  const res = await api(`/stats/usage${qs({ from: str(flags.from), to: str(flags.to) })}`, { flags });
  if (flags.json) {
    cli.out(res);
    return;
  }
  const data = res.data || {};
  console.log('');
  console.log(`  ${c.bold('usage by region')}  ${c.dim(`${res.meta?.from} → ${res.meta?.to}`)}`);
  console.log('');
  const rows = Object.entries(data).sort((a, b) => (b[1].requests || 0) - (a[1].requests || 0));
  let tReq = 0;
  let tBw = 0;
  for (const [region, v] of rows) {
    tReq += v.requests || 0;
    tBw += v.bandwidth || 0;
    console.log(
      `  ${c.cyan(region.padEnd(20))} ${human(v.requests).padStart(9)} req  ${bytes(v.bandwidth).padStart(11)}` +
        (v.compute_requests ? c.dim(`  ${human(v.compute_requests)} compute`) : ''),
    );
  }
  console.log('');
  console.log(`  ${c.bold('TOTAL'.padEnd(20))} ${human(tReq).padStart(9)} req  ${bytes(tBw).padStart(11)}`);
}

async function cmdStatsRegions(flags) {
  const res = await api('/stats/regions', { flags });
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  for (const r of res.data || []) console.log(`  ${c.cyan(r)}`);
}

async function cmdStats(positional, flags) {
  const sub = str(positional[0]);
  if (!sub || sub === 'historical') return await cmdStatsHistorical(flags);
  if (sub === 'aggregate') return await cmdStatsAggregate(flags);
  if (sub === 'usage') return await cmdStatsUsage(flags);
  if (sub === 'regions') return await cmdStatsRegions(flags);
  cli.die(
    `unknown stats subcommand: ${sub}\n` +
      '  fastly stats historical | aggregate | usage | regions\n' +
      '  (realtime / domain-inspector / origin-inspector: use `fastly api`)',
    { prefix: 'fastly' },
  );
}

// ─── pops / ip-list / version ────────────────────────────────────────────────

async function cmdPops(flags) {
  const pops = await api('/datacenters', { flags });
  const list = Array.isArray(pops) ? pops : [];
  if (flags.json) {
    cli.out(list);
    return;
  }
  console.log('');
  const groups = {};
  for (const p of list) {
    const g = p.group || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(p);
  }
  for (const [group, items] of Object.entries(groups).sort()) {
    console.log(`  ${c.bold(group)}  ${c.dim(`(${items.length})`)}`);
    for (const p of items.sort((a, b) => (a.code || '').localeCompare(b.code || ''))) {
      console.log(`    ${c.cyan(String(p.code).padEnd(5))} ${(p.name || '').padEnd(24)} ${c.dim(`${p.region || ''} · ${p.billing_region || ''}`)}`);
    }
  }
  console.log('');
  console.log(c.dim(`  ${list.length} POP(s)`));
}

async function cmdIpList(flags) {
  const res = await api('/public-ip-list', { flags });
  if (flags.json) {
    cli.out(res);
    return;
  }
  console.log('');
  console.log(`  ${c.bold('IPv4')}  ${c.dim(`(${(res.addresses || []).length})`)}`);
  for (const a of res.addresses || []) console.log(`    ${a}`);
  console.log('');
  console.log(`  ${c.bold('IPv6')}  ${c.dim(`(${(res.ipv6_addresses || []).length})`)}`);
  for (const a of res.ipv6_addresses || []) console.log(`    ${a}`);
}

async function cmdVersion(flags) {
  const cfg = await loadConfig();
  const info = {
    skill: 'fastly',
    version: SKILL_VERSION,
    implementation: 'SLICC .jsh reimplementation of the fastly CLI (not the Go binary)',
    api_base: API,
    upstream_cli: 'https://github.com/fastly/cli',
    authenticated: !!cfg.token,
    token_source: cfg.token_source || null,
    extension_binary: 'fastly-ext (billing — no upstream command group)',
  };
  if (flags.json) {
    cli.out(info);
    return;
  }
  console.log('');
  console.log(`  ${c.bold('fastly')} ${info.version}  ${c.dim('(SLICC skill)')}`);
  console.log(c.dim(`  reimplements ${info.upstream_cli} against ${API}`));
  console.log(c.dim(`  billing lives in the sibling binary: fastly-ext`));
  console.log(c.dim(`  authenticated: ${info.authenticated ? `yes (${info.token_source})` : 'no'}`));
}

// ─── raw API passthrough ─────────────────────────────────────────────────────

async function cmdApi(positional, flags) {
  let method = 'GET';
  let target;
  if (positional.length >= 2 && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(String(positional[0]))) {
    method = String(positional[0]).toUpperCase();
    target = positional[1];
  } else {
    target = positional[0];
  }
  if (!target) {
    cli.die('usage: fastly api [METHOD] <path-or-url> [--data <json>]', { prefix: 'fastly' });
  }
  let body;
  const data = str(flags.data);
  if (data !== undefined) {
    try {
      body = JSON.parse(data);
    } catch {
      body = data;
    }
  }
  const res = await api(target, { method, body, flags });
  cli.out(res);
}

// ─── args + main ─────────────────────────────────────────────────────────────

const HELP = `
fastly — a working subset of the official Fastly CLI (github.com/fastly/cli),
         implemented against https://api.fastly.com.

USAGE
  fastly whoami [--json]                       Authenticated user + token details
  fastly auth login [--token <tok>]            Store a Fastly API token
  fastly auth status [--json]                  Show stored token state + validity
  fastly auth logout                           Forget the stored token

  fastly service list [--per-page N] [--page N] [--sort F] [--direction ascend|descend]
  fastly service describe [<id>] [--service-id ID | --service-name NAME]
  fastly service search --name <name>
  fastly service version list --service-id ID
  fastly service domain list --service-id ID [--version active|latest|staged|N]
  fastly service purge --service-id ID (--all | --key K | --file F) [--soft] --confirm
  fastly service purge --url <url> [--soft] --confirm

  fastly domain list [--service-id ID] [--fqdn F] [--limit N] [--cursor C]
  fastly domain describe <domain-id>

  fastly stats [historical] [--service-id ID] [--from T] [--to T]
               [--by day|hour|minute] [--region R] [--field F]
  fastly stats aggregate [--from T] [--to T] [--by day|hour|minute] [--region R]
  fastly stats usage [--from T] [--to T]       Bandwidth + requests per region
  fastly stats regions                         Valid --region values

  fastly pops                                  Fastly POPs / datacenters
  fastly ip-list                               Fastly's public IP ranges
  fastly version                               Skill version + auth state

  fastly api [METHOD] <path-or-url> [--data <json>]
                                               Authenticated raw call — the escape
                                               hatch for every command group this
                                               subset does not wrap.

FLAGS
  --json            Raw JSON instead of the summarised view
  --token <tok>     Use this token for one call (does not persist it)
  --confirm         Actually apply a purge (without it, purge previews only)

  (Use long flags with a value: --service-id X, --by day. Single-dash short flags
   arrive as booleans in this runtime and are not supported.)

NOTES
  • /stats and /stats/aggregate payloads are megabytes; the default view
    summarises and only --json dumps everything.
  • Billing and invoices are NOT part of the upstream CLI, so they live in the
    sibling binary: fastly-ext billing --help
  • Auth: prefer a long-lived personal API token
    (${TOKEN_UI_URL}). With no stored token, a
    logged-in manage.fastly.com tab is harvested as a ~12h fallback.
`.trim();

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
      if (p0 === 'status' || p0 === 'show' || p0 === 'list' || !p0) return await cmdAuthStatus(flags);
      cli.die(`unknown auth subcommand: ${p0}\n  fastly auth login | status | logout`, { prefix: 'fastly' });
    }
    if (s === 'login') return await cmdAuthLogin(flags);
    if (s === 'logout') return await cmdAuthLogout();
    if (s === 'whoami') return await cmdWhoami(flags);

    if (s === 'service') {
      const rest = positional.slice(1);
      if (p0 === 'list' || !p0) return await cmdServiceList(flags);
      if (p0 === 'describe' || p0 === 'get') return await cmdServiceDescribe(rest, flags);
      if (p0 === 'search') return await cmdServiceSearch(flags);
      if (p0 === 'purge') return await cmdServicePurge(flags);
      if (p0 === 'version') {
        if (str(rest[0]) === 'list' || !rest.length) return await cmdServiceVersionList(flags);
        cli.die(`unknown: fastly service version ${rest[0]}\n  fastly service version list --service-id ID`, {
          prefix: 'fastly',
        });
      }
      if (p0 === 'domain') {
        if (str(rest[0]) === 'list' || !rest.length) return await cmdServiceDomainList(flags);
        cli.die(`unknown: fastly service domain ${rest[0]}\n  fastly service domain list --service-id ID --version active`, {
          prefix: 'fastly',
        });
      }
      cli.die(
        `unknown service subcommand: ${p0}\n` +
          '  fastly service list | describe | search | version list | domain list | purge\n' +
          '  (acl, backend, vcl, dictionary, logging, …: use `fastly api`)',
        { prefix: 'fastly' },
      );
    }

    if (s === 'domain') {
      if (p0 === 'list' || !p0) return await cmdDomainList(flags);
      if (p0 === 'describe' || p0 === 'get') return await cmdDomainDescribe(positional.slice(1), flags);
      cli.die(`unknown domain subcommand: ${p0}\n  fastly domain list | describe <id>`, { prefix: 'fastly' });
    }

    if (s === 'stats') return await cmdStats(positional, flags);
    if (s === 'pops' || s === 'datacenters') return await cmdPops(flags);
    if (s === 'ip-list' || s === 'ips') return await cmdIpList(flags);
    if (s === 'version') return await cmdVersion(flags);
    if (s === 'api') return await cmdApi(positional, flags);

    if (s === 'billing' || s === 'invoices' || s === 'invoice') {
      cli.die(
        'The upstream Fastly CLI has no billing command group, so billing lives in a separate binary.\n' +
          '  Try: fastly-ext billing invoices | invoice <id> | mtd | forecast | summary',
        { prefix: 'fastly' },
      );
    }

    cli.die(`unknown command: ${s}\nRun 'fastly --help' for usage.`, { prefix: 'fastly' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err.message, { prefix: 'fastly' });
  }
}

await main();
