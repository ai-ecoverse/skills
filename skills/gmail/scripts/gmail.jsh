#!/usr/bin/env jsh
// gmail.jsh — Gmail CLI for SLICC agents
// Token precedence:
//   1. GWS_CLIENT_ID / GWS_CLIENT_SECRET / GWS_REFRESH_TOKEN env vars
//      (refresh_token grant; wins when all three are present)
//   2. `jerk gmail get --reveal` (sign in once with `gmail login`, which runs
//      `jerk gmail create`)
//   3. Legacy persisted skill config (`skill.config()`), still read
//
// Usage: gmail <command> [args] [--flags]
//
// Commands:
//   login     Sign in to Google through jerk
//   auth      Show which credential source is active
//   logout    Clear persisted credentials
//   mail      List inbox messages
//   view      View a single message (full body)
//   send      Send an email
//   reply     Reply to a message
//   monday    Aggregated inbox for monday dispatcher
//
// ┌─ MIGRATION NOTES (jsh runtime extensions — issue #170) ────────────────────┐
// │ Bespoke bare globals are hard-cut; capability bridges come via             │
// │ require('sliccy:<name>'). Mechanical port, behavior preserved:             │
// │  • Arg parsing → process.argv.parseFlags(); positional drops the leading   │
// │    subcommand so view/reply ID indices are unchanged.                      │
// │  • Colors → require('sliccy:color') (kept the `C` name). Identical ANSI by │
// │    default; now also honors NO_COLOR. No raw escape codes remain.          │
// │  • list/get/send API → one http.client(); non-2xx errors are reformatted  │
// │    to the original `HTTP <status>: <message>` text.                        │
// │ KEPT (deliberate): manual OAuth refresh over fetch (no sliccy:skill        │
// │  provider backs GWS_* creds); local durationToDate (sliccy:time `m` =      │
// │  minutes, but this CLI's `--date 1m` = one month); local die/out (sliccy:  │
// │  cli would add an `Error:` prefix and change output).                      │
// └────────────────────────────────────────────────────────────────────────────┘

const http = require('sliccy:http');
const skill = require('sliccy:skill');
const exec = require('sliccy:exec');
const fs = require('fs');

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_WEB = 'https://mail.google.com/mail/u/0/#inbox';

// ─── OAuth constants ─────────────────────────────────────────────────────────

// Thunderbird's public desktop OAuth client. Desktop clients are
// non-confidential — Google protects them with loopback redirect-URI matching,
// not secrecy of the "secret" — and this one is verified by Google for Gmail's
// restricted scopes (https://mail.google.com/). The Google Cloud SDK public
// client is NOT verified for those scopes and gets blocked, which is why the
// gcloud skill's client is deliberately not reused here.
const OAUTH_CLIENT_ID = '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = 'kSmqreRr0qwBWJgbf5Y-PjSU';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const OAUTH_SCOPE = 'https://mail.google.com/';

// ─── Argument Parsing ────────────────────────────────────────────────────────

// `process.argv.parseFlags()` yields { positional, flags, subcommand }. Drop the
// leading subcommand from `positional` so downstream index math (view/reply
// message IDs) matches the previous hand-rolled parser exactly.
const parsed = process.argv.parseFlags();
const flags = parsed.flags;
const subcommand = flags.help || flags.h ? 'help' : parsed.subcommand || '';
const positional = parsed.positional.slice(1);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Parse a duration string like 1d, 7d, 2w, 1m into a Gmail after: date.
 * Returns YYYY/MM/DD for use in Gmail search queries.
 */
function durationToDate(dur) {
  if (!dur) return null;
  const match = dur.match(/^(\d+)(h|d|w|m)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
  const cutoff = new Date(Date.now() - ms[unit] * n);
  const yyyy = cutoff.getFullYear();
  const mm = String(cutoff.getMonth() + 1).padStart(2, '0');
  const dd = String(cutoff.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = require('sliccy:color');

// ─── Auth ────────────────────────────────────────────────────────────────────

let _accessToken = null;

/**
 * Where the persisted config lives. Under jsh (SLICC 7 and the host) it is a
 * per-user file, $GMAIL_STATE_DIR, $XDG_STATE_HOME/gmail or
 * ~/.local/state/gmail, `config.json`, 0600 in a 0700 directory: the skill
 * folder is usually root's (/usr/share/skills, or a pnpm global link to it),
 * and writing `scripts/.config` there failed with EACCES. SLICC 6 has no
 * process.versions.jsh and keeps skill.config(). Same rule as slack's stateDir.
 */
function stateDir(env, jsh) {
  if (!jsh) return null;
  if (env.GMAIL_STATE_DIR) return env.GMAIL_STATE_DIR;
  if (env.XDG_STATE_HOME) return `${env.XDG_STATE_HOME}/gmail`;
  const home = env.HOME || require('os').homedir();
  return `${home}/.local/state/gmail`;
}

const STATE_DIR = stateDir(process.env || {}, !!(process.versions && process.versions.jsh));

/**
 * Read the skill's persisted config: the per-user file, else (read-only) the
 * legacy skill.config() from before it moved, so an existing sign-in keeps
 * working and is copied over on the next save.
 *
 * GOTCHA (same one documented in gcloud.jsh): skill.config() returns a Promise,
 * which is always truthy — so `skill.config() || {}` never falls back, and
 * reading a property off the *resolved* null config then throws. Always await
 * before the `|| {}`.
 */
async function loadConfig() {
  if (STATE_DIR) {
    try {
      return JSON.parse(await fs.promises.readFile(`${STATE_DIR}/config.json`, 'utf8')) || {};
    } catch (err) {
      if (err && err.code !== 'ENOENT') throw err;
    }
    try { return (await skill.config()) || {}; } catch { return {}; }
  }
  return (await skill.config()) || {};
}

async function writeConfig(cfg) {
  if (!STATE_DIR) return skill.config(cfg);
  await fs.promises.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = `${STATE_DIR}/config.json`;
  const tmp = `${file}.${process.pid || 0}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, file);
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await writeConfig({ ...cur, ...updates });
}

function envCredentials() {
  const clientId = process.env.GWS_CLIENT_ID;
  const clientSecret = process.env.GWS_CLIENT_SECRET;
  const refreshToken = process.env.GWS_REFRESH_TOKEN;
  if (!(clientId && clientSecret && refreshToken)) return null;
  return { clientId, clientSecret, refreshToken, source: 'env' };
}

async function configCredentials() {
  const cfg = await loadConfig();
  if (!cfg.refresh_token) return null;
  return {
    clientId: cfg.client_id || OAUTH_CLIENT_ID,
    clientSecret: cfg.client_secret || OAUTH_CLIENT_SECRET,
    refreshToken: cfg.refresh_token,
    source: 'config',
    account: cfg.account || '',
  };
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0].slice(0, 200);
}

async function jerkToken() {
  let r;
  try {
    r = await exec.spawn(['jerk', 'gmail', 'get', '--reveal']);
  } catch (e) {
    return { status: 'missing', detail: firstLine(e && e.message) };
  }
  const token = String(r.stdout || '').trim();
  if (r.exitCode === 0 && token && !/[\s…]/.test(token)) return { token };
  if (r.exitCode === 127) return { status: 'missing', detail: 'jerk is not installed' };
  const status = r.exitCode === 3 ? 'signin' : r.exitCode === 4 ? 'unavailable' : 'error';
  return { status, detail: firstLine(r.stderr) };
}

async function resolveSource() {
  const env = envCredentials();
  if (env) return { source: 'env', creds: env };
  const jerk = await jerkToken();
  if (jerk.token) return { source: 'jerk', token: jerk.token };
  const config = await configCredentials();
  if (config) return { source: 'config', creds: config };
  return { source: null, jerk };
}

function noCredentialsMessage(jerk) {
  const why = jerk && jerk.status === 'missing'
    ? 'jerk is not installed (npm i -g @ai-ecoverse/slicc-jerk)'
    : jerk && jerk.status === 'unavailable'
      ? `jerk cannot sign in here${jerk.detail ? `: ${jerk.detail}` : ''}`
      : 'no Gmail sign-in found';
  return `gmail: ${why}. Run \`gmail login\` (it runs \`jerk gmail create\`), or set GWS_CLIENT_ID, GWS_CLIENT_SECRET and GWS_REFRESH_TOKEN.`;
}

async function refreshAccessToken(creds) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  return await res.json();
}

async function getAccessToken() {
  if (_accessToken) return _accessToken;

  const resolved = await resolveSource();
  if (!resolved.source) die(noCredentialsMessage(resolved.jerk));
  if (resolved.source === 'jerk') {
    _accessToken = resolved.token;
    return _accessToken;
  }
  const creds = resolved.creds;

  if (creds.source === 'config') {
    const cfg = await loadConfig();
    if (cfg.access_token && cfg.expires_at && Date.now() < cfg.expires_at - 60_000) {
      _accessToken = cfg.access_token;
      return _accessToken;
    }
  }

  const data = await refreshAccessToken(creds);
  if (!data.access_token) {
    die(`gmail: token refresh failed: ${JSON.stringify(data)}`);
  }

  if (creds.source === 'config') {
    const updates = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };
    if (data.refresh_token) updates.refresh_token = data.refresh_token;
    await saveConfig(updates);
  }

  _accessToken = data.access_token;
  return _accessToken;
}

// ─── API Client ──────────────────────────────────────────────────────────────

// Single http.client for all Gmail REST calls. `token` is lazy (resolved per
// request) and injected as `Authorization: Bearer …`; object bodies are
// JSON-encoded and querystrings are built from `params` (undefined/null skipped)
// — matching the previous hand-rolled fetch wrappers.
const gmailApi = http.client({
  baseUrl: GMAIL_BASE,
  token: () => getAccessToken(),
  headers: { 'Accept': 'application/json' },
});

// http.client throws HttpError on non-2xx. Reformat it back to the original
// `HTTP <status>: <message>` text (Gmail nests its detail under error.message)
// so the per-command `gmail: <cmd> failed: …` wrappers are unchanged.
function toGmailError(e) {
  if (e && e.name === 'HttpError') {
    const b = e.body;
    const msg = (b && typeof b === 'object')
      ? (b.error?.message || JSON.stringify(b))
      : String(b == null ? '' : b);
    return new Error(`HTTP ${e.status}: ${msg}`);
  }
  return e;
}

async function gmailGet(path, params) {
  try {
    return await gmailApi.get(path, { params });
  } catch (e) {
    throw toGmailError(e);
  }
}

async function gmailPost(path, body) {
  try {
    return await gmailApi.post(path, { body });
  } catch (e) {
    throw toGmailError(e);
  }
}

// ─── MIME Helpers ─────────────────────────────────────────────────────────────

/**
 * Decode Gmail's base64url-encoded body data to a UTF-8 string.
 */
function decodeBase64Url(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Decode Gmail's base64url-encoded data to raw bytes (Uint8Array) — for
 * binary attachments (PDF, images) that must not be UTF-8 mangled.
 */
function decodeBase64UrlBytes(data) {
  if (!data) return new Uint8Array(0);
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Recursively collect attachment parts (those with a filename + attachmentId)
 * from a Gmail message payload.
 */
function collectAttachments(payload, acc = []) {
  if (!payload) return acc;
  if (payload.filename && payload.body && payload.body.attachmentId) {
    acc.push({
      filename: payload.filename,
      attachmentId: payload.body.attachmentId,
      mimeType: payload.mimeType,
      size: payload.body.size,
    });
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) collectAttachments(p, acc);
  }
  return acc;
}

/**
 * Encode a string to base64url (for sending messages via Gmail API).
 */
function encodeBase64Url(str) {
  const encoded = btoa(unescape(encodeURIComponent(str)));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Extract the value of a header by name from a Gmail message payload.
 */
function getHeader(payload, name) {
  if (!payload || !payload.headers) return '';
  const h = payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * Recursively extract body text from a Gmail message payload.
 * Prefers text/plain, falls back to text/html (stripped of tags).
 */
function extractBody(payload) {
  if (!payload) return '';

  // Simple body (no parts)
  if (payload.body && payload.body.data) {
    if (payload.mimeType === 'text/html') {
      return stripHtml(decodeBase64Url(payload.body.data));
    }
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — recurse through parts
  if (payload.parts && payload.parts.length > 0) {
    // First pass: text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Second pass: text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
    // Third pass: recurse into nested multipart
    for (const part of payload.parts) {
      if (part.mimeType && part.mimeType.startsWith('multipart/')) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

/**
 * Strip HTML tags and decode common entities for plain-text display.
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse email from "Name <email@example.com>" format.
 */
function parseEmail(str) {
  if (!str) return '';
  const m = str.match(/<([^>]+)>/);
  return m ? m[1] : str.trim();
}

/**
 * Parse display name from email header string.
 */
function parseDisplayName(str) {
  if (!str) return '';
  const m = str.match(/^"?([^"<]+)"?\s*</);
  return m ? m[1].trim() : str.replace(/<[^>]+>/, '').trim() || parseEmail(str);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function importCredentialsFile(fromFile) {
  const fs = require('node:fs');
  let raw;
  try {
    raw = fs.readFileSync(fromFile, 'utf8');
  } catch (e) {
    die(`gmail login: cannot read ${fromFile}: ${e.message}`);
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    die(`gmail login: ${fromFile} is not valid JSON: ${e.message}`);
  }
  // Tolerate the "installed"/"web" wrapper Google's console downloads use.
  if (creds.installed || creds.web) creds = { ...(creds.installed || creds.web), ...creds };
  const refreshToken = creds.refresh_token || creds.refreshToken;
  const clientId = creds.client_id || creds.clientId;
  const clientSecret = creds.client_secret || creds.clientSecret;
  // A refresh token is bound to the OAuth client that issued it, so we must not
  // substitute this skill's built-in client for a missing one — the result would
  // be unusable AND would have overwritten a working stored config.
  const missing = [
    !refreshToken && 'refresh_token',
    !clientId && 'client_id',
    !clientSecret && 'client_secret',
  ].filter(Boolean);
  if (missing.length) {
    die(
      `gmail login: ${fromFile} is missing required field(s): ${missing.join(', ')}\n` +
      '  A refresh token only works with the client_id/client_secret that issued it.\n' +
      '  Existing stored credentials were left untouched.'
    );
  }
  // Validate the imported credentials BEFORE persisting anything, and validate
  // them *directly* — going through gmailGet()/getAccessToken() would resolve
  // credentials env-first, so with GWS_* set we would "verify" a different
  // identity and store an unusable token while reporting success.
  const imported = { clientId, clientSecret, refreshToken };
  let tokenData;
  try {
    tokenData = await refreshAccessToken(imported);
  } catch (e) {
    die(`gmail login: could not reach Google to validate credentials: ${e.message}`);
  }
  if (!tokenData?.access_token) {
    die(
      `gmail login: the credentials in ${fromFile} were rejected by Google: ` +
      `${JSON.stringify(tokenData)}\n  Existing stored credentials were left untouched.`
    );
  }

  // Only now that the refresh token demonstrably works do we overwrite config.
  let email = creds.account || '';
  try {
    const res = await fetch(`${GMAIL_BASE}/profile`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (res.ok) {
      const profile = await res.json();
      email = profile.emailAddress || email;
    }
  } catch { /* identity is cosmetic here; the token itself already validated */ }

  await saveConfig({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope: creds.scope || OAUTH_SCOPE,
    account: email,
    access_token: tokenData.access_token,
    expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
  });
  process.stdout.write(`${C.green('✓')} Credentials imported from ${fromFile}${email ? ` (${email})` : ''}\n`);
  process.stdout.write(`  ${C.gray(`Stored in ${STATE_DIR ? `${STATE_DIR}/config.json` : 'skill config'}; access tokens auto-refresh.`)}\n`);
}

async function cmdLogin() {
  const fromFile = typeof flags['from-file'] === 'string'
    ? flags['from-file']
    : (typeof flags.from === 'string' ? flags.from : null);
  if (fromFile) {
    await importCredentialsFile(fromFile);
    return;
  }

  const argv = ['jerk', 'gmail', 'create'];
  if (flags.force === true) argv.push('--force');
  let r;
  try {
    r = await exec.spawn(argv);
  } catch (e) {
    r = { exitCode: 127, stdout: '', stderr: '' };
  }
  if (r.exitCode === 127) {
    process.stderr.write('gmail login: jerk is not installed. Install it with: npm i -g @ai-ecoverse/slicc-jerk\n');
    process.exit(4);
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.exitCode !== 0) process.exit(r.exitCode);
  process.stdout.write(`${C.green('✓')} Signed in to Gmail through jerk\n`);
  process.stdout.write(`  ${C.gray('jerk keeps the grant and refreshes it; check it with: gmail auth')}\n`);
}

/** `gmail auth` — show which credential source is active (never prints secrets). */
async function cmdAuth() {
  const resolved = await resolveSource();
  const creds = resolved.creds || null;
  const cfg = await loadConfig();
  const configActive = resolved.source === 'config';
  let account = creds?.account || (configActive ? cfg.account : '') || null;
  let scope = configActive ? cfg.scope || OAUTH_SCOPE : null;
  if (resolved.source === 'env' || resolved.source === 'jerk') {
    try {
      const profile = await gmailGet('/profile');
      account = profile.emailAddress || null;
    } catch { /* leave unknown rather than borrow the inactive config's identity */ }
    scope = resolved.source === 'jerk' ? OAUTH_SCOPE : process.env.GWS_SCOPE || null;
  }
  const info = {
    authenticated: !!resolved.source,
    source: resolved.source,
    account,
    client_id: creds ? creds.clientId : null,
    refresh_token_length: creds ? creds.refreshToken.length : 0,
    scope,
  };
  if (!resolved.source && resolved.jerk && resolved.jerk.status) info.jerk = resolved.jerk.status;
  if (flags.json === true || flags.json === 'true') { out(info); return; }
  const tokenLine = resolved.source === 'jerk'
    ? 'held by jerk'
    : info.refresh_token_length ? `present (${info.refresh_token_length} chars)` : C.red('absent');
  process.stdout.write('\n');
  process.stdout.write(`  ${C.gray('authenticated')}  ${info.authenticated ? C.green('yes') : C.red('no')}\n`);
  process.stdout.write(`  ${C.gray('source')}         ${info.source || C.gray('(none — run: gmail login)')}\n`);
  process.stdout.write(`  ${C.gray('account')}        ${info.account || C.gray('(unknown)')}\n`);
  process.stdout.write(`  ${C.gray('scope')}          ${info.scope || C.gray('(unknown — set by the env credentials)')}\n`);
  process.stdout.write(`  ${C.gray('refresh token')}  ${tokenLine}\n`);
}

/** `gmail logout` — revoke (best effort) and clear persisted credentials. */
async function cmdLogout() {
  const cfg = await loadConfig();
  if (cfg.refresh_token && flags['no-revoke'] !== true) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: cfg.refresh_token }).toString(),
      });
    } catch { /* best effort */ }
  }
  await writeConfig({
    client_id: '', client_secret: '', refresh_token: '',
    access_token: '', expires_at: 0, account: '',
  });
  process.stdout.write(`${C.green('✓')} Persisted Gmail credentials cleared.\n`);
}

async function cmdMail() {
  const limit = parseInt(flags.limit || '20', 10);
  const unread = flags.unread === true || flags.unread === 'true';
  const search = flags.search || null;
  const date = flags.date || null;

  // Build Gmail search query.
  // Only scope to the inbox when the caller hasn't supplied an explicit search
  // query — otherwise archived/labelled mail (e.g. auto-filed receipts) would be
  // invisible. A caller who wants to restrict to the inbox can pass `in:inbox`
  // (or `is:unread`) as part of --search.
  const queryParts = [];
  if (!search) queryParts.push('in:inbox');
  if (unread) queryParts.push('is:unread');
  if (date) {
    const afterDate = durationToDate(date);
    if (afterDate) queryParts.push(`after:${afterDate}`);
  }
  if (search) queryParts.push(search);

  const q = queryParts.join(' ');

  try {
    // Step 1: List message IDs
    const listData = await gmailGet('/messages', {
      maxResults: String(limit),
      q: q,
    });

    const messageStubs = listData.messages || [];
    if (messageStubs.length === 0) {
      if (flags.json === true || flags.json === 'true') {
        out([]);
      } else {
        process.stdout.write('No messages found.\n');
      }
      return;
    }

    // Step 2: Fetch each message with metadata
    const messages = await Promise.all(
      messageStubs.map(stub =>
        // Gmail's metadataHeaders param is an array-typed query param -- it
        // must be sent as repeated `metadataHeaders=X&metadataHeaders=Y`,
        // not a single comma-joined string. Confirmed live (pre-existing
        // bug, not introduced by this migration -- the pre-migration
        // manual querystring builder had the exact same issue):
        // encodeURIComponent('From,Subject,Date') produces
        // `metadataHeaders=From%2CSubject%2CDate`, which Gmail treats as
        // one (non-existent) header name, so every message rendered with
        // blank From/Date and "(no subject)". http.client's params DOES
        // support arrays correctly (repeats the key per element) --
        // confirmed via a live test against a controllable echo endpoint.
        gmailGet(`/messages/${stub.id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
      )
    );

    if (flags.json === true || flags.json === 'true') {
      out(messages);
      return;
    }

    process.stdout.write(`${C.bold('Inbox')} — ${messages.length} message${messages.length !== 1 ? 's' : ''}\n\n`);

    for (const msg of messages) {
      const isUnread = (msg.labelIds || []).includes('UNREAD');
      const dot = isUnread ? C.green('●') : C.gray('○');
      const from = parseDisplayName(getHeader(msg.payload, 'From'));
      const subject = trunc(getHeader(msg.payload, 'Subject') || '(no subject)', 80);
      const dateStr = formatDate(getHeader(msg.payload, 'Date'));
      const snippet = trunc(msg.snippet || '', 120);

      process.stdout.write(`  ${dot} ${C.gray(dateStr)} ${C.cyan(from)}\n`);
      process.stdout.write(`    ${subject}\n`);
      if (snippet) process.stdout.write(`    ${C.gray(snippet)}\n`);
      process.stdout.write(`    ${C.gray('ID: ' + msg.id)}\n\n`);
    }
  } catch (e) {
    // die() (called deep inside, e.g. by getAccessToken() on missing
    // GWS_* env vars) prints its message and throws NodeExitError to
    // unwind in this realm -- there's no true synchronous process exit
    // inside an async function. Without this check, this catch treats
    // that already-printed, already-finalized exit as a fresh error and
    // re-wraps it into a second, confusing "mail failed: Process exited
    // with code 1" line on top of the real message (confirmed live: this
    // file, unguarded, printed THREE lines for one error -- this catch's
    // wrap, plus the outer dispatch catch's wrap on top of that).
    if (e && e.name === 'NodeExitError') throw e;
    die(`gmail: mail failed: ${e.message}`);
  }
}

async function cmdView() {
  const id = positional[0];
  if (!id) die('gmail view: provide a message ID');

  try {
    const msg = await gmailGet(`/messages/${id}`, { format: 'full' });

    const subject = getHeader(msg.payload, 'Subject') || '(no subject)';
    const from = getHeader(msg.payload, 'From');
    const to = getHeader(msg.payload, 'To');
    const cc = getHeader(msg.payload, 'Cc');
    const date = getHeader(msg.payload, 'Date');
    const labels = (msg.labelIds || []).join(', ');

    // `--json` is honoured here for parity with `mail`/`attachments`; the body
    // is NOT truncated in this mode, and attachments are listed so a caller can
    // go straight to `gmail download`.
    if (flags.json) {
      out({
        id: msg.id,
        threadId: msg.threadId || null,
        subject, from, to: to || null, cc: cc || null, date,
        labels: msg.labelIds || [],
        snippet: msg.snippet || null,
        link: `${GMAIL_WEB}/${id}`,
        body: extractBody(msg.payload),
        attachments: collectAttachments(msg.payload),
      });
      return;
    }

    process.stdout.write(`${C.bold(subject)}\n`);
    process.stdout.write(`${C.gray('From:')} ${from}\n`);
    if (to) process.stdout.write(`${C.gray('To:')} ${to}\n`);
    if (cc) process.stdout.write(`${C.gray('Cc:')} ${cc}\n`);
    process.stdout.write(`${C.gray('Date:')} ${date}\n`);
    process.stdout.write(`${C.gray('Labels:')} ${labels}\n`);
    process.stdout.write(`${C.gray('Link:')} ${GMAIL_WEB}/${id}\n`);
    process.stdout.write('\n');

    const body = extractBody(msg.payload);
    process.stdout.write(body ? trunc(body, 5000) + '\n' : C.gray('(empty body)') + '\n');
  } catch (e) {
    // See the note in cmdMail()'s catch: must re-throw an already-finalized
    // NodeExitError instead of re-wrapping it into a second error line.
    if (e && e.name === 'NodeExitError') throw e;
    die(`gmail: view failed: ${e.message}`);
  }
}

async function cmdAttachments() {
  const id = positional[0];
  if (!id) die('gmail attachments: provide a message ID');
  try {
    const msg = await gmailGet(`/messages/${id}`, { format: 'full' });
    const atts = collectAttachments(msg.payload);
    if (flags.json === true || flags.json === 'true') { out(atts); return; }
    if (!atts.length) { process.stdout.write(C.gray('(no attachments)\n')); return; }
    process.stdout.write(`${C.bold('Attachments')} — ${atts.length}\n\n`);
    for (const a of atts) {
      process.stdout.write(`  ${C.cyan(a.filename)}  ${C.gray(a.mimeType)}  ${C.gray((a.size || 0) + ' bytes')}\n`);
      process.stdout.write(`    ${C.gray('attachmentId:')} ${a.attachmentId}\n`);
    }
  } catch (e) {
    if (e && e.name === 'NodeExitError') throw e;
    die(`gmail: attachments failed: ${e.message}`);
  }
}

async function cmdDownload() {
  const fs = require('fs');
  const id = positional[0];
  if (!id) die('gmail download: usage: gmail download <messageId> [attachmentId] --out=<path>');
  const out = flags.out || flags.o;
  if (!out) die('gmail download: --out=<path> is required (file path for a single attachment, or dir when downloading all)');
  try {
    const msg = await gmailGet(`/messages/${id}`, { format: 'full' });
    const atts = collectAttachments(msg.payload);
    if (!atts.length) die('gmail download: message has no attachments');
    let targets, asDir;
    const explicitId = positional[1];
    if (explicitId) {
      targets = atts.filter(a => a.attachmentId === explicitId);
      if (!targets.length) die(`gmail download: attachmentId not found on message`);
      asDir = /\/$/.test(out);
    } else {
      targets = atts;
      asDir = true; // download all into out dir
    }
    const written = [];
    for (const a of targets) {
      const att = await gmailGet(`/messages/${id}/attachments/${a.attachmentId}`);
      const bytes = decodeBase64UrlBytes(att.data);
      const path = asDir ? `${out.replace(/\/$/, '')}/${a.filename}` : out;
      await fs.promises.writeFile(path, bytes);
      written.push({ filename: a.filename, path, bytes: bytes.length });
    }
    if (flags.json === true || flags.json === 'true') { process.stdout.write(JSON.stringify(written, null, 2) + '\n'); return; }
    for (const w of written) process.stdout.write(`${C.green('✓')} ${w.filename} → ${w.path} (${w.bytes} bytes)\n`);
  } catch (e) {
    if (e && e.name === 'NodeExitError') throw e;
    die(`gmail: download failed: ${e.message}`);
  }
}

async function cmdSend() {
  const to = flags.to;
  const subject = flags.subject;
  const body = flags.body;
  const isHtml = flags.html === true || flags.html === 'true';
  const cc = flags.cc || null;
  const bcc = flags.bcc || null;

  if (!to) die('gmail send: --to is required');
  if (!subject) die('gmail send: --subject is required');
  if (!body) die('gmail send: --body is required');

  // Build RFC 5322 message
  const lines = [];
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  if (isHtml) {
    lines.push('Content-Type: text/html; charset=UTF-8');
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8');
  }
  lines.push('MIME-Version: 1.0');
  lines.push('');
  lines.push(body);

  const raw = encodeBase64Url(lines.join('\r\n'));

  try {
    const result = await gmailPost('/messages/send', { raw });
    process.stdout.write(`${C.green('✓')} Email sent to ${to} (ID: ${result.id})\n`);
  } catch (e) {
    // See the note in cmdMail()'s catch: must re-throw an already-finalized
    // NodeExitError instead of re-wrapping it into a second error line.
    if (e && e.name === 'NodeExitError') throw e;
    die(`gmail: send failed: ${e.message}`);
  }
}

async function cmdReply() {
  const id = flags.id || positional[0];
  const body = flags.body;
  const isHtml = flags.html === true || flags.html === 'true';

  if (!id) die('gmail reply: --id MESSAGE_ID is required');
  if (!body) die('gmail reply: --body is required');

  try {
    // Fetch original message headers
    // See the note on the mail-list metadataHeaders fetch: must be an
    // array, not a comma-joined string, or Gmail silently returns none of
    // these headers.
    const orig = await gmailGet(`/messages/${id}`, {
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Message-Id', 'References', 'In-Reply-To'],
    });

    const origFrom = getHeader(orig.payload, 'From');
    const origSubject = getHeader(orig.payload, 'Subject') || '';
    const origMessageId = getHeader(orig.payload, 'Message-Id');
    const origReferences = getHeader(orig.payload, 'References');
    const threadId = orig.threadId;

    // Reply goes to the original sender
    const replyTo = parseEmail(origFrom);
    const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

    // Build References header (original refs + original message-id)
    const refs = origReferences
      ? `${origReferences} ${origMessageId}`
      : origMessageId;

    // Build RFC 5322 message
    const lines = [];
    lines.push(`To: ${replyTo}`);
    lines.push(`Subject: ${subject}`);
    if (origMessageId) lines.push(`In-Reply-To: ${origMessageId}`);
    if (refs) lines.push(`References: ${refs}`);
    if (isHtml) {
      lines.push('Content-Type: text/html; charset=UTF-8');
    } else {
      lines.push('Content-Type: text/plain; charset=UTF-8');
    }
    lines.push('MIME-Version: 1.0');
    lines.push('');
    lines.push(body);

    const raw = encodeBase64Url(lines.join('\r\n'));

    const result = await gmailPost('/messages/send', { raw, threadId });
    process.stdout.write(`${C.green('✓')} Reply sent to ${replyTo} (ID: ${result.id}, thread: ${threadId})\n`);
  } catch (e) {
    // See the note in cmdMail()'s catch: must re-throw an already-finalized
    // NodeExitError instead of re-wrapping it into a second error line.
    if (e && e.name === 'NodeExitError') throw e;
    die(`gmail: reply failed: ${e.message}`);
  }
}

async function cmdMonday() {
  const limit = parseInt(flags.limit || '20', 10);
  const date = flags.date || '1d';
  const depth = parseInt(flags.depth || '0', 10);

  const items = [];

  try {
    // Build query for unread inbox messages within the date range
    const queryParts = ['in:inbox', 'is:unread'];
    const afterDate = durationToDate(date);
    if (afterDate) queryParts.push(`after:${afterDate}`);
    const q = queryParts.join(' ');

    // Step 1: List message IDs
    const listData = await gmailGet('/messages', {
      maxResults: String(limit),
      q: q,
    });

    const stubs = listData.messages || [];
    if (stubs.length === 0) {
      process.stdout.write('[]');
      return;
    }

    // Step 2: Fetch each message (full if depth > 0, otherwise metadata + snippet)
    const format = depth > 0 ? 'full' : 'metadata';
    const fetchParams = depth > 0
      ? { format: 'full' }
      // See the note on the mail-list metadataHeaders fetch: must be an
      // array, not a comma-joined string.
      : { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] };

    const messages = await Promise.all(
      stubs.map(stub => gmailGet(`/messages/${stub.id}`, fetchParams))
    );

    // Step 3: Transform to monday protocol items
    for (const msg of messages) {
      const from = getHeader(msg.payload, 'From');
      const subject = getHeader(msg.payload, 'Subject') || '(no subject)';
      const dateHeader = getHeader(msg.payload, 'Date');
      const isUnread = (msg.labelIds || []).includes('UNREAD');
      const labels = msg.labelIds || [];

      let bodyText = msg.snippet || '';
      if (depth > 0) {
        const full = extractBody(msg.payload);
        bodyText = full ? full.slice(0, 500) : bodyText;
      }

      const fromEmail = parseEmail(from);
      let ts;
      if (dateHeader) {
        const parsed = new Date(dateHeader);
        ts = isNaN(parsed.getTime())
          ? new Date(parseInt(msg.internalDate, 10)).toISOString()
          : parsed.toISOString();
      } else {
        ts = new Date(parseInt(msg.internalDate, 10)).toISOString();
      }

      items.push({
        id: `gmail-${msg.id}`,
        source: 'gmail',
        type: 'email',
        title: subject,
        subtitle: `From: ${fromEmail}`,
        url: `${GMAIL_WEB}/${msg.id}`,
        ts: ts,
        body: trunc(bodyText, 500),
        participants: [fromEmail],
        meta: {
          unread: isUnread,
          labels: labels,
          threadId: msg.threadId || '',
        },
      });
    }
  } catch (e) {
    // See the note in cmdMail()'s catch. Here it matters even more: unlike
    // the other commands, cmdMonday intentionally downgrades a genuine
    // fetch failure to a warning and still emits JSON on stdout -- but an
    // unguarded NodeExitError (e.g. from missing GWS_* creds) would get
    // swallowed into that same warning ("...failed to fetch mail: Process
    // exited with code 1") and then this function would carry on to print
    // an empty JSON array on stdout as if nothing were wrong, instead of
    // exiting non-zero. Re-throw so a real auth/config failure still
    // surfaces as a hard error.
    if (e && e.name === 'NodeExitError') throw e;
    process.stderr.write(`[gmail monday] WARNING: failed to fetch mail: ${e.message}\n`);
  }

  // Output ONLY the JSON array to stdout
  process.stdout.write(JSON.stringify(items));
}

// ─── Help ────────────────────────────────────────────────────────────────────

function showHelp() {
  process.stdout.write(`gmail — Gmail CLI for SLICC

Usage: gmail <command> [options]

Commands:
  login      Sign in to Google through jerk (jerk gmail create)
  auth       Show which credential source is active (no secrets printed)
  logout     Revoke and clear legacy persisted credentials (jerk: jerk gmail drop)
  mail       List inbox messages
  view       View a single message (full body)
  attachments List a message's attachments (name, type, size, attachmentId)
  download   Download a message's attachments to disk
  send       Send an email
  reply      Reply to a message
  monday     Aggregated inbox items for monday dispatcher

Login options:
  --force            Sign in again even when jerk already holds a grant
  --from-file PATH   Legacy: import credentials from a JSON file into the skill
                     config instead of signing in through jerk. Fields: client_id, client_secret,
                     refresh_token (required), token_uri, scope, account.

Mail options:
  --limit N          Number of messages (default: 20)
  --date PERIOD      Filter by age (e.g. 1d, 7d, 2w, 1m)
  --unread           Show only unread messages
  --search QUERY     Gmail search query
  --json             Output raw JSON

View:
  gmail view <message-id> [--json]
  --json             Structured output: headers, labels, the UNTRUNCATED body
                     and the attachment list (the text view truncates at 5000).

Attachments:
  gmail attachments <message-id> [--json]
  gmail download <message-id> [attachmentId] --out=<path>
                     With an attachmentId, --out is the target FILE; without
                     one, every attachment is written into the --out DIRECTORY
                     under its original filename.

Send options:
  --to EMAIL         Recipient(s), comma-separated (required)
  --subject TEXT     Email subject (required)
  --body TEXT        Email body (required)
  --html             Send as HTML instead of plain text
  --cc EMAIL         CC recipients, comma-separated
  --bcc EMAIL        BCC recipients, comma-separated

Reply options:
  --id MESSAGE_ID    Message to reply to (required)
  --body TEXT        Reply body (required)
  --html             Send reply as HTML

Monday options:
  --limit N          Max messages (default: 20)
  --date PERIOD      Date range (default: 1d)
  --depth N          0 = snippet only, >0 = full body (default: 0)

Authentication (precedence):
  1. GWS_CLIENT_ID + GWS_CLIENT_SECRET + GWS_REFRESH_TOKEN env vars
     (all three must be set; takes precedence when present)
  2. jerk — \`jerk gmail get --reveal\`, signed in with \`gmail login\`; jerk
     refreshes the token (in SLICC 7 it is a placeholder the vault fills in)
  3. Legacy persisted skill config (\`gmail login --from-file creds.json\`)
  Env and config credentials mint an access token with the OAuth2
  refresh_token grant on demand; config-sourced tokens are cached until expiry.

Gmail API:
  Base URL: https://gmail.googleapis.com/gmail/v1/users/me
  GET  /messages           List messages
  GET  /messages/{id}      Get message (format=full|metadata)
  POST /messages/send      Send message (raw base64url RFC 5322)
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  switch (subcommand) {
    case 'login':
      await cmdLogin();
      break;
    case 'auth':
    case 'whoami':
      await cmdAuth();
      break;
    case 'logout':
      await cmdLogout();
      break;
    case 'mail':
    case 'inbox':
      await cmdMail();
      break;
    case 'attachments':
      await cmdAttachments();
      break;
    case 'download':
      await cmdDownload();
      break;
    case 'view':
      await cmdView();
      break;
    case 'send':
      await cmdSend();
      break;
    case 'reply':
      await cmdReply();
      break;
    case 'monday':
      await cmdMonday();
      break;
    case 'help':
    case '--help':
    case '-h':
    case '':
      showHelp();
      break;
    default:
      process.stderr.write(`Unknown command: ${subcommand}\n`);
      showHelp();
      process.exit(1);
  }
} catch (e) {
  // See the note in cmdMail()'s catch. This is the outermost handler, so an
  // already-finalized NodeExitError reaching here (e.g. re-thrown from one
  // of the per-command catches above, or from showHelp()'s own die() path)
  // should just propagate uncaught rather than be wrapped again --
  // rethrowing here lets it surface as a clean, single, already-printed
  // exit instead of adding a second "gmail: Process exited with code 1"
  // line on top of the real message.
  if (e && e.name === 'NodeExitError') throw e;
  process.stderr.write(`gmail: ${e.message}\n`);
  process.exit(1);
}
