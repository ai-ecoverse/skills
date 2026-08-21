// bluebubbles.jsh — BlueBubbles REST client (iMessage/SMS via local server)
//
// Auth: server password as ?password= query param. It is never printed: every
// string that leaves this script passes through safeErrorText() / die(), which
// redact `password=…`, JSON `"password": "…"` and the literal secret value.
// Config order: flags/env → ~/.bluebubbles.json (or BLUEBUBBLES_CONFIG) → defaults.
// Password: BLUEBUBBLES_PASSWORD → passwordFile from config → BLUEBUBBLES_PASSWORD_FILE.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');
const http = require('sliccy:http');
const { exec } = require('sliccy:exec');

const HELP = `
bluebubbles — iMessage/SMS via BlueBubbles server REST API

USAGE
  bluebubbles status|ping              Server info + totals
  bluebubbles chats|inbox [--limit N] [--search Q] [--direct|--group]
  bluebubbles messages <chatGuid|address> [--limit N]
  bluebubbles send <address|chatGuid> <text...>
  bluebubbles search <query> [--limit N] [--in messages|chats|contacts]
  bluebubbles contacts [query] [--limit N]
  bluebubbles handles [query] [--limit N]
  bluebubbles watch --scoop=<name> [--chat=<guid>] [--events=a,b] [--force]
  bluebubbles unwatch [watchId|all]
  bluebubbles watches

FLAGS
  --json              Raw JSON response
  --limit N           Max rows (default varies by command)
  --url <url>         Override server URL
  --local             Prefer urlLocal from config (LAN)
  --direct / --group  chats: only 1:1 or only group threads
  --in <scope>        search: messages (default), chats, or contacts
  --password-file P   Read password from file (single line)
  --scoop <name>      watch: route SLICC webhook licks to this scoop
  --chat <guid>       watch: only events for this chatGuid
  --events <list>     watch: BB event names (default: new-message)
  --force             watch: replace existing watch with same id
  --name <name>       watch: optional SLICC webhook display name

CONFIG
  Env:  BLUEBUBBLES_URL, BLUEBUBBLES_PASSWORD, BLUEBUBBLES_PASSWORD_FILE,
        BLUEBUBBLES_CONFIG
  File: ~/.bluebubbles.json  (also /home/lars/.bluebubbles.json)
        { "url", "urlLocal", "passwordFile" }
  Watch state: ~/.bluebubbles-watches/*.json  (not in the skill repo)
  Password is never echoed or written by this CLI.

GUIDS
  Direct send:  iMessage;-;+15551234567   or   iMessage;-;user@example.com
  From inbox:   any;-;… (1:1)   any;+;… (group) — use guid from chats as-is
`.trim();

const DEFAULT_URL = 'http://localhost:1234';
const CONFIG_CANDIDATES = () => {
  const home = (typeof os.homedir === 'function' && os.homedir()) || process.env.HOME || '';
  const out = [];
  if (process.env.BLUEBUBBLES_CONFIG) out.push(process.env.BLUEBUBBLES_CONFIG);
  if (home) out.push(path.join(home, '.bluebubbles.json'));
  out.push('/home/lars/.bluebubbles.json');
  return out;
};

// ── args ───────────────────────────────────────────────────────────────────

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;

function str(v) {
  return typeof v === 'string' ? v : undefined;
}

function numFlag(v, dflt, { min = 1, max = 500 } = {}) {
  const raw = str(v);
  if (raw === undefined && typeof v !== 'number') return dflt;
  const n = typeof v === 'number' ? v : parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return (os.homedir && os.homedir()) || process.env.HOME || p;
  if (p.startsWith('~/')) {
    const home = (os.homedir && os.homedir()) || process.env.HOME || '';
    return home ? path.join(home, p.slice(2)) : p;
  }
  return p;
}

// ── config / auth ──────────────────────────────────────────────────────────
// fs.readFile is async on the VFS bridge — always await (sync call returns a Promise;
// String(promise) === "[object Promise]").

async function readJsonFile(filePath) {
  try {
    if (!filePath) return null;
    try {
      if (typeof fs.exists === 'function' && !fs.exists(filePath)) return null;
    } catch { /* exists may throw on gated paths — try read anyway */ }
    const raw = await fs.readFile(filePath);
    if (!raw) return null;
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

async function readPasswordFile(filePath) {
  const p = expandHome(filePath);
  if (!p) return null;
  try {
    const raw = String((await fs.readFile(p)) || '');
    const line = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

async function loadFileConfig() {
  for (const candidate of CONFIG_CANDIDATES()) {
    const expanded = expandHome(candidate);
    const cfg = await readJsonFile(expanded);
    if (cfg && typeof cfg === 'object') {
      return { cfg, path: expanded };
    }
  }
  return { cfg: {}, path: null };
}

async function resolveConfig() {
  const { cfg, path: configPath } = await loadFileConfig();
  const preferLocal = !!(flags.local || flags.L);
  const urlOverridden = !!(str(flags.url) || process.env.BLUEBUBBLES_URL);
  const fileUrl = cfg.url ? String(cfg.url).replace(/\/+$/, '') : null;
  const fileLocal = cfg.urlLocal ? String(cfg.urlLocal).replace(/\/+$/, '') : null;

  const url =
    str(flags.url) ||
    process.env.BLUEBUBBLES_URL ||
    (preferLocal && cfg.urlLocal) ||
    cfg.url ||
    cfg.urlLocal ||
    DEFAULT_URL;

  const password =
    str(flags.password) ||
    process.env.BLUEBUBBLES_PASSWORD ||
    (await readPasswordFile(str(flags['password-file']) || process.env.BLUEBUBBLES_PASSWORD_FILE)) ||
    (await readPasswordFile(cfg.passwordFile)) ||
    null;

  if (password) registerSecret(password);

  const primary = String(url).replace(/\/+$/, '');
  // Second base known to be the SAME BlueBubbles server as primary. Used only
  // so send can POST on one host and verify/yield on another (HTTP/1 pin).
  // Never use a stale urlLocal when --url / BLUEBUBBLES_URL pointed elsewhere.
  let companionLocal = null;
  if (!urlOverridden && fileLocal && fileLocal !== primary) {
    if (fileUrl && primary === fileUrl) companionLocal = fileLocal;
    else if (preferLocal && fileUrl && primary === fileLocal) companionLocal = fileUrl;
  }

  return {
    url: primary,
    password,
    configPath,
    urlLocal: fileLocal,
    urlOverridden,
    companionLocal,
  };
}

// ── redaction ──────────────────────────────────────────────────────────────
// The password travels as a `?password=` query parameter, so it appears inside
// request URLs *and* inside error strings composed by the HTTP layer
// (`HTTP 530 <url>: <body>`). Sanitising only the `url` field is not enough —
// anything that can reach the terminal goes through safeErrorText(), and die()
// is the single choke point for fatal output.

const PASSWORD_MASK = '***';

// `password=<value>` anywhere in a string (not only after ? or &), any case.
// The value ends at &, whitespace, a quote/backtick, an angle bracket or the end
// of the string; percent-escapes are part of the value, so URL-encoded secrets
// are covered too.
const PASSWORD_PARAM_RE = /password=[^&\s"'`<>]*/gi;
// `"password": "<value>"` inside a JSON body echoed back by the server.
const PASSWORD_JSON_RE = /("password"\s*:\s*")(?:\\.|[^"\\])*"/gi;

// Literal secrets (the resolved password and its URL-encoded form) so the value
// is masked even when it shows up without a `password=` prefix.
const knownSecrets = new Set();

function registerSecret(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < 4) return; // too short to mask without mangling output
  knownSecrets.add(v);
  try {
    const encoded = encodeURIComponent(v);
    if (encoded !== v) knownSecrets.add(encoded);
  } catch {
    /* ignore */
  }
}

/** Redact every secret-bearing pattern from an arbitrary string. */
function safeErrorText(value) {
  if (value == null) return value;
  let out = String(value)
    .replace(PASSWORD_PARAM_RE, `password=${PASSWORD_MASK}`)
    .replace(PASSWORD_JSON_RE, `$1${PASSWORD_MASK}"`);
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(PASSWORD_MASK);
  }
  return out;
}

/** cli.die with every message forced through the redactor. */
function die(message, opts) {
  return cli.die(safeErrorText(message), opts);
}

// ── HTTP ───────────────────────────────────────────────────────────────────

function stripPasswordFromUrl(u) {
  try {
    const parsedUrl = new URL(u);
    if (parsedUrl.searchParams.has('password')) {
      parsedUrl.searchParams.set('password', PASSWORD_MASK);
    }
    return safeErrorText(parsedUrl.toString());
  } catch {
    return safeErrorText(u);
  }
}

function bbErrorMessage(err) {
  return safeErrorText(rawBbErrorMessage(err));
}

function rawBbErrorMessage(err) {
  if (!err) return 'unknown error';
  const body = err.body;
  if (body && typeof body === 'object') {
    const parts = [];
    if (body.message) parts.push(String(body.message));
    if (body.error) {
      const e = body.error;
      if (typeof e === 'string') parts.push(e);
      else if (e && e.message) parts.push(String(e.message));
    }
    if (parts.length) return parts.join(' — ');
  }
  if (typeof body === 'string' && body.trim()) return fmt.trunc(body.trim(), 200);
  return err.message || `HTTP ${err.status || '?'}`;
}

function authDie(detail) {
  die(
    (detail ? detail + '\n' : '') +
      '  Set BLUEBUBBLES_PASSWORD or passwordFile in ~/.bluebubbles.json\n' +
      '  Config: ~/.bluebubbles.json → { "url", "urlLocal", "passwordFile" }\n' +
      '  Never put the password in SKILL docs or commits.',
    { prefix: 'bluebubbles' },
  );
}

let _client = null;
let _cfg = null;

async function getCfg() {
  if (_cfg) return _cfg;
  _cfg = await resolveConfig();
  if (!_cfg.password) {
    authDie('No BlueBubbles password found.');
  }
  if (!_cfg.url) {
    die('No BlueBubbles URL configured.', { prefix: 'bluebubbles' });
  }
  return _cfg;
}

async function getClient() {
  if (_client) return _client;
  const cfg = await getCfg();
  _client = http.client({
    baseUrl: cfg.url,
    timeoutMs: 30000,
    headers: { Accept: 'application/json' },
    retry: { on: [429, 503], maxAttempts: 3 },
  });
  return _client;
}

async function api(method, apiPath, { body, params, timeoutMs, raw, noRetry } = {}) {
  const cfg = await getCfg();
  // Fresh short-timeout / no-retry client when requested. Default shared client
  // otherwise (retries 429/503, 30s ceiling).
  const client =
    timeoutMs || noRetry
      ? http.client({
          baseUrl: cfg.url,
          timeoutMs: timeoutMs || 30000,
          headers: { Accept: 'application/json' },
          retry: { maxAttempts: 1 },
        })
      : await getClient();
  const q = { password: cfg.password, ...(params || {}) };
  const opts = { params: q };
  if (body !== undefined) opts.body = body;
  // Kept for forward-compat if sliccy:http ever honours it; real deadline is
  // the client constructor timeout above.
  if (timeoutMs) opts.timeoutMs = timeoutMs;
  if (raw) opts.raw = true;

  try {
    const m = String(method || 'GET').toLowerCase();
    if (!client[m]) die(`unsupported method ${method}`, { prefix: 'bluebubbles' });
    const res = await client[m](apiPath, opts);
    return res;
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    const status = err && err.status;
    if (status === 401 || status === 403) {
      authDie(`Auth failed (${status}) for ${apiPath} — check passwordFile / BLUEBUBBLES_PASSWORD.`);
    }
    const msg = bbErrorMessage(err);
    const safeUrl = stripPasswordFromUrl(err.url || cfg.url + apiPath);
    if (!status) {
      // Timeouts / aborts are soft for callers that can verify side effects
      // (send). Hard connection failures still die.
      if (/timeout|abort|Timeout|AbortError/i.test(msg) || err?.name === 'AbortError') {
        const e = new Error(safeErrorText(`BlueBubbles timeout on ${apiPath}: ${msg}`));
        e.status = 408;
        e.timedOut = true;
        e.soft = true;
        e.url = safeUrl;
        throw e;
      }
      die(
        `Could not reach BlueBubbles at ${cfg.url} (${msg}).\n` +
          '  Is the server running? Try --local or set BLUEBUBBLES_URL / config url.',
        { prefix: 'bluebubbles' },
      );
    }
    // Some endpoints 500 on this server build (e.g. handle/query without offset)
    const e = new Error(safeErrorText(`BlueBubbles ${status} on ${apiPath}: ${msg}`));
    e.status = status;
    e.body = err.body;
    e.url = safeUrl;
    e.soft = status >= 500;
    throw e;
  }
}

/** Unwrap { status, message, data } envelopes; pass through otherwise. */
function unwrap(res) {
  if (res && typeof res === 'object' && 'data' in res) return res.data;
  return res;
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  if (data && Array.isArray(data.chats)) return data.chats;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

// ── formatting ─────────────────────────────────────────────────────────────

function fmtTs(ms) {
  if (ms == null || ms === '') return '';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  // BlueBubbles uses ms since epoch; guard against seconds.
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return '';
  return fmt.date(d, 'short') || d.toISOString();
}

function msgText(m) {
  if (!m) return '';
  if (typeof m.text === 'string' && m.text.length) return m.text;
  // attributedBody sometimes carries text when .text is null
  if (typeof m.subject === 'string' && m.subject.length) return m.subject;
  if (m.isSystemMessage) return '(system)';
  if (Array.isArray(m.attachments) && m.attachments.length) {
    return `(${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''})`;
  }
  return '';
}

function oneLine(s, n = 72) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return fmt.trunc(t, n);
}

function chatLabel(chat) {
  if (!chat) return '(unknown)';
  if (chat.displayName) return chat.displayName;
  const parts = (chat.participants || []).map((p) => p.address || p.id).filter(Boolean);
  if (parts.length) return parts.join(', ');
  return chat.guid || '(chat)';
}

function isGroupChat(chat) {
  if (!chat) return false;
  if (typeof chat.guid === 'string' && chat.guid.includes(';+;')) return true;
  const n = (chat.participants || []).length;
  return n > 1;
}

function normalizeAddress(addr) {
  return String(addr || '').trim();
}

/** Build a send/query chatGuid from a phone, email, or existing guid. */
function toChatGuid(target) {
  const t = normalizeAddress(target);
  if (!t) return null;
  if (t.includes(';-;') || t.includes(';+;')) return t;
  // bare address → prefer iMessage direct GUID for send
  return `iMessage;-;${t}`;
}

function looksLikeGuid(s) {
  return /^(any|iMessage|SMS|rc);[+-];/i.test(String(s || ''));
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const cfg = await getCfg();
  const info = await api('GET', '/api/v1/server/info');
  let totals = null;
  try {
    totals = await api('GET', '/api/v1/server/statistics/totals');
  } catch {
    /* optional */
  }
  let ping = null;
  try {
    ping = await api('GET', '/api/v1/ping');
  } catch {
    /* optional */
  }

  const payload = {
    url: cfg.url,
    configPath: cfg.configPath,
    info: unwrap(info) || info,
    totals: unwrap(totals),
    ping: unwrap(ping) ?? ping,
  };

  if (flags.json) {
    cli.out(payload);
    return;
  }

  const d = payload.info || {};
  console.log('');
  console.log(color.bold(color.cyan('  BlueBubbles')) + color.dim(`  ${cfg.url}`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  console.log(`  ${color.dim('server:')}     ${d.server_version || '?'}  ${color.dim('macOS')} ${d.os_version || '?'}`);
  console.log(
    `  ${color.dim('private_api:')} ${d.private_api ? color.green('true') : color.yellow('false')}` +
      `   ${color.dim('helper:')} ${d.helper_connected ? color.green('connected') : color.yellow('not connected')}`,
  );
  if (d.detected_icloud) console.log(`  ${color.dim('icloud:')}     ${d.detected_icloud}`);
  if (d.detected_imessage) console.log(`  ${color.dim('imessage:')}   ${d.detected_imessage}`);
  if (payload.totals && typeof payload.totals === 'object') {
    const t = payload.totals;
    console.log(
      `  ${color.dim('db:')}         ${t.messages ?? '?'} messages · ${t.chats ?? '?'} chats · ${t.handles ?? '?'} handles`,
    );
  }
  if (payload.ping != null) {
    const ok = payload.ping === 'pong' || payload.ping === 'Ping received!' || info?.status === 200;
    console.log(`  ${color.dim('ping:')}       ${ok ? color.green('pong') : String(payload.ping)}`);
  }
  if (cfg.configPath) console.log(`  ${color.dim('config:')}     ${cfg.configPath}`);
  console.log('');
}

async function fetchChats(limit) {
  const res = await api('POST', '/api/v1/chat/query', {
    body: {
      limit,
      offset: 0,
      with: ['lastMessage', 'participants'],
      sort: 'lastmessage',
    },
  });
  return asArray(unwrap(res));
}

async function cmdChats(flags) {
  const limit = numFlag(flags.limit ?? flags.l, 25, { max: 500 });
  const search = str(flags.search) || str(flags.q) || '';
  let chats = await fetchChats(Math.max(limit, search ? 200 : limit));

  if (flags.direct) chats = chats.filter((c) => !isGroupChat(c));
  if (flags.group) chats = chats.filter((c) => isGroupChat(c));
  if (search) {
    const q = search.toLowerCase();
    chats = chats.filter((c) => {
      const blob = [
        c.guid,
        c.displayName,
        ...((c.participants || []).map((p) => p.address || '')),
      ]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }
  chats = chats.slice(0, limit);

  if (flags.json) {
    cli.out(chats);
    return;
  }

  if (!chats.length) {
    console.log(color.dim('  No chats found.'));
    return;
  }

  console.log('');
  console.log(color.bold('  Chats') + color.dim(`  (${chats.length})`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  for (const c of chats) {
    const group = isGroupChat(c);
    const kind = group ? color.yellow('group') : color.green('direct');
    const title = color.cyan(color.bold(oneLine(chatLabel(c), 40)));
    const guid = color.dim(c.guid || '');
    const lm = c.lastMessage || {};
    const when = fmtTs(lm.dateCreated);
    const preview = oneLine(msgText(lm), 48);
    const fromMe = lm.isFromMe ? color.dim('you: ') : '';
    console.log(`  ${title}  ${kind}`);
    console.log(`     ${guid}`);
    if (preview || when) {
      console.log(`     ${color.dim(when)}${when ? '  ' : ''}${fromMe}${preview}`);
    }
    console.log('');
  }
}

async function resolveChatGuid(target) {
  const t = normalizeAddress(target);
  if (!t) return null;
  if (looksLikeGuid(t)) return t;

  // Look up an existing chat whose participant matches the address
  const chats = await fetchChats(300);
  const lower = t.toLowerCase();
  const matches = chats.filter((c) => {
    if ((c.guid || '').toLowerCase().includes(lower)) return true;
    return (c.participants || []).some((p) => String(p.address || '').toLowerCase() === lower);
  });

  // Prefer direct (1:1) chats for bare addresses
  const direct = matches.filter((c) => !isGroupChat(c));
  if (direct.length === 1) return direct[0].guid;
  if (direct.length > 1) return direct[0].guid;
  if (matches.length === 1) return matches[0].guid;
  if (matches.length > 1) return matches[0].guid;

  // Fall back to synthetic iMessage GUID (works for send; message query may need real guid)
  return toChatGuid(t);
}

async function cmdMessages(positional, flags) {
  const target = positional[0];
  if (!target) die('usage: bluebubbles messages <chatGuid|address> [--limit N]', { prefix: 'bluebubbles' });
  const limit = numFlag(flags.limit ?? flags.l, 20, { max: 200 });

  const chatGuid = await resolveChatGuid(target);
  const body = {
    limit,
    offset: 0,
    with: ['handle', 'chats', 'attachment'],
    sort: 'DESC',
    chatGuid,
  };

  let res;
  // The fallback query is scoped to nothing: it returns recent messages across
  // every conversation on the server, so its result is only usable after the
  // client-side filter has been applied unconditionally.
  let usedFallback = false;
  try {
    res = await api('POST', '/api/v1/message/query', { body });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    // Retry without chatGuid using client filter if server rejects synthetic guid
    usedFallback = true;
    res = await api('POST', '/api/v1/message/query', {
      body: { limit: Math.min(limit * 5, 100), offset: 0, with: ['handle', 'chats'], sort: 'DESC' },
    });
  }

  let messages = asArray(unwrap(res));

  // If we got a broad list, filter to the target chat/address
  if (chatGuid || target) {
    const lower = String(target).toLowerCase();
    const guidLower = String(chatGuid || '').toLowerCase();
    const filtered = messages.filter((m) => {
      const guids = (m.chats || []).map((c) => String(c.guid || '').toLowerCase());
      if (guidLower && guids.some((g) => g === guidLower)) return true;
      const addr = String(m.handle?.address || '').toLowerCase();
      if (addr && (addr === lower || guidLower.endsWith(addr))) return true;
      return false;
    });
    if (usedFallback) {
      // Never widen to "everything recent": a non-matching message belongs to a
      // different conversation, and showing it here would attribute someone
      // else's thread to the requested address. No match means no result.
      messages = filtered;
    } else if (filtered.length) {
      // Server-side chatGuid scoping already applied; the client filter only
      // ever narrows, so keep the server list if it recognises nothing.
      messages = filtered;
    }
  }
  messages = messages.slice(0, limit);

  const noFallbackMatch = usedFallback && !messages.length;

  if (flags.json) {
    const payload = { chatGuid, messages };
    if (noFallbackMatch) {
      payload.note =
        `no messages matched "${target}" — the server rejected the chat guid and ` +
        'the recent-message scan contained nothing from this conversation; ' +
        'run "bluebubbles chats" to get the real chat guid';
    }
    cli.out(payload);
    return;
  }

  console.log('');
  console.log(color.bold('  Messages') + color.dim(`  ${chatGuid || target}  (${messages.length})`));
  console.log(color.dim('  ' + '─'.repeat(52)));

  if (!messages.length) {
    if (noFallbackMatch) {
      console.log(color.dim(`  No messages found for ${target}.`));
      console.log(
        color.dim('  The server rejected this chat guid and the recent-message scan'),
      );
      console.log(color.dim('  held nothing from this conversation.'));
      console.log(color.dim('  Find the real guid with: bluebubbles chats --search=' + target));
    } else {
      console.log(color.dim('  No messages found.'));
    }
    console.log('');
    return;
  }

  // Show oldest→newest for reading
  const ordered = [...messages].reverse();
  for (const m of ordered) {
    const when = color.dim(fmtTs(m.dateCreated));
    const who = m.isFromMe
      ? color.green('you')
      : color.cyan(m.handle?.address || m.handle?.id || '?');
    const text = oneLine(msgText(m), 100) || color.dim('(empty)');
    console.log(`  ${when}  ${who}`);
    console.log(`    ${text}`);
    console.log('');
  }
}


/** Yield a macrotask so in-flight fetch callbacks can run.
 * jsh setTimeout is a no-op; MessageChannel still schedules a macrotask.
 */
function yieldMacrotask() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
      return;
    }
    Promise.resolve().then(resolve);
  });
}

/**
 * Wait until deadline or isDone(), without ever awaiting the send host.
 * Optional companionBase (other host, same server) gets a throttled ping so we
 * both yield and keep the LAN path warm — never more often than pingEveryMs.
 */
async function waitUntil(deadline, isDone, { companionBase = null, pingEveryMs = 500 } = {}) {
  let lastPing = 0;
  while (Date.now() < deadline && !isDone()) {
    await yieldMacrotask();
    if (companionBase && Date.now() - lastPing >= pingEveryMs) {
      lastPing = Date.now();
      try {
        await fetch(`${companionBase.replace(/\/$/, '')}/api/v1/ping`);
      } catch {
        /* yield only */
      }
    }
  }
}

/** fetch with a hard wall-clock bound (no AbortController — broken in jsh). */
async function fetchBounded(url, init, maxMs) {
  let settled = null;
  const p = fetch(url, init)
    .then(async (r) => {
      const text = await r.text();
      settled = { status: r.status, text, ok: r.ok };
      return settled;
    })
    .catch((err) => {
      settled = { error: err };
      return settled;
    });
  await waitUntil(Date.now() + maxMs, () => settled != null);
  if (!settled) {
    void p;
    const e = new Error(`timeout after ${maxMs}ms`);
    e.timedOut = true;
    e.status = 408;
    e.soft = true;
    throw e;
  }
  if (settled.error) throw settled.error;
  return settled;
}

/**
 * Fire one POST /message/text, detach at deadline, never HTTP-retry.
 *
 * jsh has no working setTimeout / AbortController (fetch abort is a no-op;
 * sliccy:http timeouts never fire). A hanging BlueBubbles send holds the
 * HTTP/1 connection and starves every later request on the same host — which
 * is how agents ended up retrying and multi-sending. We fire the POST, wait
 * up to maxMs via macrotask yields (+ throttled companion-host pings), then
 * detach and let the caller verify on the companion host.
 */
async function postMessageTextOnce(body, timeoutMs) {
  const cfg = await getCfg();
  const maxMs = Math.max(1000, timeoutMs || 25000);
  const url =
    `${cfg.url.replace(/\/$/, '')}/api/v1/message/text?password=${encodeURIComponent(cfg.password)}`;
  const companion = cfg.companionLocal || null;

  let settled = null;
  const postPromise = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
    .then(async (r) => {
      const text = await r.text();
      settled = { httpStatus: r.status, body: text };
      return settled;
    })
    .catch((err) => {
      settled = {
        httpStatus: 0,
        error: String(err && err.message ? err.message : err),
      };
      return settled;
    });

  // Never await the send host here — that is the hang. Companion is optional.
  await waitUntil(Date.now() + maxMs, () => settled != null, {
    companionBase: companion,
    pingEveryMs: 500,
  });

  if (!settled) {
    // Leave postPromise dangling on purpose — do not await it.
    void postPromise;
    const e = new Error(
      safeErrorText(
        `BlueBubbles timeout on /api/v1/message/text after ${Math.round(maxMs / 1000)}s (detached)`,
      ),
    );
    e.status = 408;
    e.timedOut = true;
    e.soft = true;
    throw e;
  }

  const httpStatus = settled.httpStatus || 0;
  const outBody = settled.body || '';

  if (httpStatus >= 400) {
    const e = new Error(
      safeErrorText(`BlueBubbles ${httpStatus} on /api/v1/message/text: ${outBody.slice(0, 300)}`),
    );
    e.status = httpStatus;
    e.body = outBody;
    e.soft = httpStatus >= 500;
    throw e;
  }
  if (!httpStatus) {
    const e = new Error(
      safeErrorText(`BlueBubbles send transport failed: ${settled.error || 'unknown'}`),
    );
    e.status = 0;
    throw e;
  }
  try {
    return JSON.parse(outBody);
  } catch {
    return { status: httpStatus, raw: outBody };
  }
}

const VERIFY_FETCH_MS = 5000;

/** message/query on companion (same server, other host) first, then primary. Each attempt is bounded. */
async function queryMessagesForVerify(chatGuid) {
  const cfg = await getCfg();
  const bases = [];
  if (cfg.companionLocal) bases.push(String(cfg.companionLocal).replace(/\/$/, ''));
  // Primary last: may still be pinned by a detached send POST on this host.
  bases.push(cfg.url.replace(/\/$/, ''));
  // de-dupe
  const seen = new Set();
  const uniq = bases.filter((b) => {
    if (!b || seen.has(b)) return false;
    seen.add(b);
    return true;
  });

  const body = {
    limit: 25,
    offset: 0,
    chatGuid,
    with: ['handle', 'chats'],
    sort: 'DESC',
  };
  let lastErr = null;
  for (const base of uniq) {
    try {
      const r = await fetchBounded(
        `${base}/api/v1/message/query?password=${encodeURIComponent(cfg.password)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        },
        VERIFY_FETCH_MS,
      );
      if (!r.ok) {
        lastErr = new Error(`HTTP ${r.status}`);
        continue;
      }
      let j;
      try {
        j = JSON.parse(r.text);
      } catch (err) {
        lastErr = err;
        continue;
      }
      return asArray(unwrap(j));
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

// Test seam: harness assigns a fake that goes through stubbed api().
let _sendTransport = null;
async function dispatchSend(body, timeoutMs) {
  if (typeof _sendTransport === 'function') return _sendTransport(body, timeoutMs);
  return postMessageTextOnce(body, timeoutMs);
}


async function cmdSend(positional, flags) {
  const target = positional[0];
  let text = positional.slice(1).join(' ').trim();
  if (!text && str(flags.message)) text = str(flags.message);
  if (!text && str(flags.m)) text = str(flags.m);

  if (!target || !text) {
    die('usage: bluebubbles send <address|chatGuid> <text...> [--force]', { prefix: 'bluebubbles' });
  }

  // Prefer existing direct chat guid when address given
  let chatGuid = looksLikeGuid(target) ? target : null;
  let queryGuid = null; // any;-; form is fine for message/query + dupe checks
  if (!chatGuid) {
    const resolved = await resolveChatGuid(target);
    // For *read* paths, any;-;address is the real thread guid. For *send*,
    // private_api:false builds drive Messages via osascript and choke on
    // service type "any" ("Can't make any into type constant"). Always wire
    // the POST as iMessage;-;<address> (or SMS;-; if that is what we resolved).
    if (resolved && !isGroupGuid(resolved)) {
      queryGuid = resolved;
      const m = String(resolved).match(/^(any|iMessage|SMS|rc);-;(.+)$/i);
      if (m && /^any$/i.test(m[1])) {
        chatGuid = `iMessage;-;${m[2]}`;
      } else {
        chatGuid = resolved;
      }
    } else {
      chatGuid = toChatGuid(target);
    }
  } else if (/^any;-;/i.test(chatGuid)) {
    queryGuid = chatGuid;
    chatGuid = `iMessage;-;${chatGuid.slice('any;-;'.length)}`;
  }
  if (!queryGuid) queryGuid = chatGuid;

  if (chatGuid.includes(';+;') && !flags.confirm && !flags.group) {
    die(
      `Refusing to send to group guid without --confirm (guid: ${chatGuid}).\n` +
        '  Pass --confirm if you really mean the group thread.',
      { prefix: 'bluebubbles' },
    );
  }

  // ── Fire once, forget, check ────────────────────────────────────────────
  // BlueBubbles with private_api:false often returns HTTP 500 *after* the
  // iMessage has already left the Mac. Agents that treat 5xx/timeout as
  // "failed" and re-run `send` produce duplicates (seen 2026-08-21: Anni
  // got four copies). Contract:
  //   1. At most one POST /message/text per invocation (no HTTP retries).
  //   2. Short client deadline — sliccy:http only honours constructor timeout.
  //   3. 5xx and timeout are soft: verify the thread before anyone resends.
  //   4. Identical outbound text inside the dupe window is refused unless --force.
  const SEND_TIMEOUT_MS = 25000;
  const DUPE_WINDOW_MS = 5 * 60 * 1000;
  const VERIFY_WINDOW_MS = 2 * 60 * 1000;

  if (!flags.force) {
    const prior = await findRecentOutbound(queryGuid, text, DUPE_WINDOW_MS);
    if (prior) {
      const payload = {
        chatGuid,
        queryGuid,
        status: 'duplicate',
        verified: true,
        messageGuid: prior.guid || null,
        note:
          'Identical outbound text already in this thread within the last 5 minutes. ' +
          'Not sending again. Pass --force to override, or change the text.',
      };
      if (flags.json) {
        cli.out(payload);
        return;
      }
      console.log('');
      console.log(color.yellow('  ✗ Refusing duplicate send'));
      console.log(`  ${color.dim('to:')}     ${chatGuid}`);
      console.log(`  ${color.dim('text:')}   ${oneLine(text, 80)}`);
      console.log(`  ${color.dim('reason:')} same outbound text already present (use --force to resend)`);
      console.log(`  ${color.dim('check:')}  bluebubbles messages ${queryGuid} --limit 5`);
      console.log('');
      return;
    }
  }

  const tempGuid = `temp-slicc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body = { chatGuid, message: text, tempGuid };

  let httpStatus = null;
  let timedOut = false;
  let soft = false;
  let res = null;
  let postError = null;

  try {
    // curl -m: real wall-clock deadline (jsh timers/abort are broken)
    res = await dispatchSend(body, SEND_TIMEOUT_MS);
    httpStatus = 200;
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    postError = err;
    httpStatus = err.status || null;
    timedOut = !!(err.timedOut || err.status === 408 || /timeout|abort/i.test(String(err.message || '')));
    if (err.status === 400) {
      die(`Send rejected (400): ${bbErrorMessage(err)}`, { prefix: 'bluebubbles' });
    }
    if (err.status === 401 || err.status === 403) throw err;
    // 5xx and timeout: soft — message may already be on the wire
    if (timedOut || (err.status && err.status >= 500) || err.soft) {
      soft = true;
    } else if (!err.status) {
      // true network failure before any response — hard
      throw err;
    } else {
      // other 4xx
      die(`Send failed (${err.status}): ${bbErrorMessage(err)}`, { prefix: 'bluebubbles' });
    }
  }

  // Always check the thread. Soft responses are worthless as delivery proof;
  // a 200 is only slightly better on private_api:false builds.
  const verifiedMsg = await findRecentOutbound(queryGuid, text, VERIFY_WINDOW_MS, { preferLocal: true });
  const verified = !!verifiedMsg;

  let status;
  if (verified) status = 'delivered';
  else if (soft && timedOut) status = 'timeout_unverified';
  else if (soft) status = 'soft_5xx_unverified';
  else status = 'accepted_unverified';

  const payload = {
    chatGuid,
    queryGuid,
    tempGuid,
    status,
    verified,
    httpStatus,
    timedOut,
    soft,
    messageGuid: verifiedMsg?.guid || null,
    response: res,
    error: postError ? safeErrorText(String(postError.message || postError)) : null,
    note: verified
      ? 'Outbound message visible in thread.'
      : soft
        ? 'POST returned 5xx/timeout (common with private_api:false) — message often still lands. ' +
          'Verify with `bluebubbles messages` before any resend. Do NOT retry send blindly.'
        : 'Server accepted the POST but the message is not visible yet. Verify before resending.',
  };

  if (flags.json) {
    cli.out(payload);
    return;
  }

  console.log('');
  if (verified) {
    console.log(color.green('  ✓ Message delivered (verified in thread)'));
  } else if (soft) {
    console.log(color.yellow('  ~ Send soft-failed at HTTP layer — do not resend yet'));
    if (timedOut) {
      console.log(color.dim('    POST timed out (message may already be sending)'));
    } else {
      console.log(color.dim(`    POST returned HTTP ${httpStatus} (private_api:false often 500s after send)`));
    }
  } else {
    console.log(color.green('  ✓ Message accepted by BlueBubbles'));
    console.log(color.dim('    Not yet visible in thread — verify before any resend'));
  }
  console.log(`  ${color.dim('to:')}     ${chatGuid}`);
  console.log(`  ${color.dim('text:')}   ${oneLine(text, 80)}`);
  console.log(`  ${color.dim('status:')} ${status}`);
  console.log(`  ${color.dim('check:')}  bluebubbles messages ${chatGuid} --limit 5`);
  console.log('');
}

/** Recent isFromMe message in chat whose text equals needle (trimmed). */
async function findRecentOutbound(chatGuid, text, windowMs, opts = {}) {
  const needle = String(text || '').trim();
  if (!needle || !chatGuid) return null;
  const now = Date.now();
  let messages = [];
  try {
    // During live post-send verify, prefer urlLocal so the detached tunnel POST
    // cannot starve us. In tests (_sendTransport set) always use stubbed api().
    if (opts.preferLocal && typeof _sendTransport !== 'function') {
      messages = await queryMessagesForVerify(chatGuid);
    } else {
      const res = await api('POST', '/api/v1/message/query', {
        body: {
          limit: 25,
          offset: 0,
          chatGuid,
          with: ['handle', 'chats'],
          sort: 'DESC',
        },
      });
      messages = asArray(unwrap(res));
    }
  } catch {
    try {
      const res = await api('POST', '/api/v1/message/query', {
        body: {
          limit: 40,
          offset: 0,
          with: ['handle', 'chats'],
          sort: 'DESC',
        },
      });
      const all = asArray(unwrap(res));
      const lower = chatGuid.toLowerCase();
      const addr = chatGuid.split(';-;')[1] || chatGuid.split(';+;')[1] || '';
      messages = all.filter((m) => {
        const guids = (m.chats || []).map((c) => String(c.guid || '').toLowerCase());
        if (guids.some((g) => g === lower || (addr && g.includes(addr.toLowerCase())))) return true;
        const h = String(m.handle?.address || '').toLowerCase();
        return addr && h === addr.toLowerCase();
      });
    } catch {
      return null;
    }
  }

  for (const m of messages) {
    if (!m || !m.isFromMe) continue;
    const body = msgText(m).trim();
    if (body !== needle) continue;
    const t = Number(m.dateCreated);
    if (Number.isFinite(t) && now - t > windowMs) continue;
    return m;
  }
  return null;
}

function isGroupGuid(g) {
  return typeof g === 'string' && g.includes(';+;');
}

async function cmdSearch(positional, flags) {
  const query = positional.join(' ').trim() || str(flags.q) || str(flags.query) || '';
  if (!query) die('usage: bluebubbles search <query> [--in messages|chats|contacts]', { prefix: 'bluebubbles' });

  const scope = (str(flags.in) || 'messages').toLowerCase();
  const limit = numFlag(flags.limit ?? flags.l, 20, { max: 100 });
  const q = query.toLowerCase();

  if (scope === 'chats' || scope === 'chat' || scope === 'inbox') {
    let chats = await fetchChats(300);
    chats = chats
      .filter((c) => {
        const blob = [c.guid, c.displayName, ...((c.participants || []).map((p) => p.address || ''))]
          .join(' ')
          .toLowerCase();
        return blob.includes(q);
      })
      .slice(0, limit);

    if (flags.json) {
      cli.out({ query, scope: 'chats', results: chats });
      return;
    }
    console.log('');
    console.log(color.bold('  Chat search') + color.dim(`  “${query}”  (${chats.length})`));
    console.log(color.dim('  ' + '─'.repeat(52)));
    if (!chats.length) {
      console.log(color.dim('  No matching chats.'));
    } else {
      for (const c of chats) {
        console.log(`  ${color.cyan(color.bold(oneLine(chatLabel(c), 40)))}  ${color.dim(c.guid)}`);
      }
    }
    console.log('');
    return;
  }

  if (scope === 'contacts' || scope === 'contact' || scope === 'people') {
    return await cmdContacts([query], flags);
  }

  // messages (default) — page recent history and filter client-side.
  // Server-side WHERE is unreliable on some 1.9.x builds (verified live).
  const pageSize = 100;
  const maxScan = Math.min(numFlag(flags.scan, 500, { min: 100, max: 2000 }), 2000);
  const found = [];
  for (let offset = 0; offset < maxScan && found.length < limit; offset += pageSize) {
    const res = await api('POST', '/api/v1/message/query', {
      body: {
        limit: pageSize,
        offset,
        with: ['handle', 'chats'],
        sort: 'DESC',
      },
    });
    const batch = asArray(unwrap(res));
    if (!batch.length) break;
    for (const m of batch) {
      const text = msgText(m).toLowerCase();
      const addr = String(m.handle?.address || '').toLowerCase();
      if (text.includes(q) || addr.includes(q)) {
        found.push(m);
        if (found.length >= limit) break;
      }
    }
    if (batch.length < pageSize) break;
  }

  if (flags.json) {
    cli.out({ query, scope: 'messages', scannedUpTo: maxScan, results: found });
    return;
  }

  console.log('');
  console.log(
    color.bold('  Message search') +
      color.dim(`  “${query}”  (${found.length} match${found.length === 1 ? '' : 'es'}, scanned ≤${maxScan})`),
  );
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!found.length) {
    console.log(color.dim('  No matches in recent messages. Try a larger --scan or --in chats.'));
  } else {
    for (const m of found) {
      const when = color.dim(fmtTs(m.dateCreated));
      const who = m.isFromMe ? color.green('you') : color.cyan(m.handle?.address || '?');
      const chat = (m.chats && m.chats[0] && m.chats[0].guid) || '';
      console.log(`  ${when}  ${who}  ${color.dim(chat)}`);
      console.log(`    ${oneLine(msgText(m), 100)}`);
      console.log('');
    }
  }
}

async function cmdContacts(positional, flags) {
  const query = positional.join(' ').trim() || str(flags.q) || '';
  const limit = numFlag(flags.limit ?? flags.l, query ? 25 : 50, { max: 500 });

  let res;
  try {
    res = await api('GET', '/api/v1/contact');
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    // Some builds expose POST /contact/query instead
    try {
      res = await api('POST', '/api/v1/contact/query', { body: { limit: 5000 } });
    } catch (err2) {
      if (err2?.name === 'NodeExitError') throw err2;
      die(`Contacts unavailable: ${bbErrorMessage(err2)}`, { prefix: 'bluebubbles' });
    }
  }

  let contacts = asArray(unwrap(res));
  if (query) {
    const q = query.toLowerCase();
    contacts = contacts.filter((c) => {
      const phones = (c.phoneNumbers || []).map((p) => p.address || p).join(' ');
      const emails = (c.emails || []).map((e) => e.address || e).join(' ');
      const blob = [c.displayName, c.firstName, c.lastName, c.nickname, phones, emails]
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }
  contacts = contacts.slice(0, limit);

  if (flags.json) {
    cli.out(contacts);
    return;
  }

  console.log('');
  console.log(
    color.bold('  Contacts') +
      color.dim(query ? `  filter “${query}”  (${contacts.length})` : `  (${contacts.length})`),
  );
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!contacts.length) {
    console.log(color.dim('  No contacts found.'));
    console.log('');
    return;
  }
  for (const c of contacts) {
    const name = color.cyan(color.bold(c.displayName || `${c.firstName || ''} ${c.lastName || ''}`.trim() || '(no name)'));
    const phones = (c.phoneNumbers || []).map((p) => p.address || p).filter(Boolean);
    const emails = (c.emails || []).map((e) => e.address || e).filter(Boolean);
    console.log(`  ${name}`);
    if (phones.length) console.log(`     ${color.dim('tel:')} ${phones.join(', ')}`);
    if (emails.length) console.log(`     ${color.dim('mail:')} ${emails.join(', ')}`);
  }
  console.log('');
}

async function cmdHandles(positional, flags) {
  const query = positional.join(' ').trim() || str(flags.q) || '';
  const limit = numFlag(flags.limit ?? flags.l, query ? 25 : 50, { max: 500 });

  let handles = [];
  try {
    // Live 1.9.9: requires numeric offset — omit → 500
    const res = await api('POST', '/api/v1/handle/query', {
      body: { limit: Math.max(limit, query ? 300 : limit), offset: 0 },
    });
    handles = asArray(unwrap(res));
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    if (flags.json) {
      cli.out({ error: bbErrorMessage(err), handles: [], degraded: true });
      return;
    }
    console.log('');
    console.log(color.yellow('  Handles unavailable on this server build.'));
    console.log(color.dim(`  ${bbErrorMessage(err)}`));
    console.log(color.dim('  Try: bluebubbles contacts <name>'));
    console.log('');
    return;
  }

  if (query) {
    const q = query.toLowerCase();
    handles = handles.filter((h) => {
      const blob = [h.address, h.service, h.uncanonicalizedId, h.country].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }
  handles = handles.slice(0, limit);

  if (flags.json) {
    cli.out(handles);
    return;
  }

  console.log('');
  console.log(color.bold('  Handles') + color.dim(`  (${handles.length})`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!handles.length) {
    console.log(color.dim('  No handles found.'));
  } else {
    for (const h of handles) {
      console.log(
        `  ${color.cyan(h.address || '?')}  ${color.dim(h.service || '')}` +
          (h.country ? color.dim(`  ${h.country}`) : ''),
      );
    }
  }
  console.log('');
}

// ── watch (BB native webhook → SLICC webhook → scoop) ──────────────────────
//
// BlueBubbles POSTs events to a URL we register via POST /api/v1/webhook.
// That URL is a SLICC `webhook create --scoop …` endpoint, so the cone/scoop
// receives licks. State lives under ~/.bluebubbles-watches/ (never in git).

const DEFAULT_WATCH_EVENTS = ['new-message'];

function homeDir() {
  return (typeof os.homedir === 'function' && os.homedir()) || process.env.HOME || '/home/lars';
}

function watchDir() {
  return (
    process.env.BLUEBUBBLES_WATCH_DIR ||
    path.join(homeDir(), '.bluebubbles-watches')
  );
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function validateScoopName(name) {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    die(
      'invalid --scoop name (use letters, digits, _-, max 64, start alnum)',
      { prefix: 'bluebubbles' },
    );
  }
  return name;
}

function sanitizeWatchId(raw) {
  const s = String(raw || 'all')
    .replace(/[^A-Za-z0-9._+-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return s || 'all';
}

function parseEventsFlag(v) {
  if (v == null || v === true) return DEFAULT_WATCH_EVENTS.slice();
  const parts = String(v)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : DEFAULT_WATCH_EVENTS.slice();
}

function watchStatePath(watchId) {
  return path.join(watchDir(), `${sanitizeWatchId(watchId)}.json`);
}

async function ensureWatchDir() {
  const dir = watchDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    /* exists */
  }
  return dir;
}

async function listWatchStateFiles() {
  const dir = watchDir();
  try {
    const names = await fs.readDir(dir);
    return (names || [])
      .filter((n) => n.endsWith('.json'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function readWatchState(file) {
  try {
    const raw = await fs.readFile(file);
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function buildSliccFilter(chatGuid) {
  if (!chatGuid) return null;
  // Keep only events whose payload mentions this chatGuid (BB shapes vary).
  // Evaluated by SLICC webhook runtime against the inbound event.
  return (
    `(e) => {` +
    `const g=${JSON.stringify(chatGuid)};` +
    `const b=e&&e.body;` +
    `if(!b) return false;` +
    `const s=typeof b==='string'?b:JSON.stringify(b);` +
    `return s.indexOf(g)!==-1;` +
    `}`
  );
}

async function createSliccWebhook({ scoop, name, filter }) {
  let cmd = `webhook create --scoop ${shellQuote(scoop)}`;
  if (name) cmd += ` --name ${shellQuote(name)}`;
  if (filter) cmd += ` --filter ${shellQuote(filter)}`;
  const res = await exec(cmd);
  if (res.exitCode !== 0) {
    die(
      `webhook create failed: ${(res.stderr || res.stdout || '').trim() || 'exit ' + res.exitCode}`,
      { prefix: 'bluebubbles' },
    );
  }
  const out = String(res.stdout || '');
  const idMatch = out.match(/^ID:\s*(\S+)/m);
  const urlMatch = out.match(/^URL:\s*(\S+)/m);
  if (!idMatch || !urlMatch) {
    die(`could not parse webhook create output:\n${fmt.trunc(out, 300)}`, {
      prefix: 'bluebubbles',
    });
  }
  return { id: idMatch[1], url: urlMatch[1] };
}

/** Best-effort delete. Returns true when the endpoint is known to be gone. */
async function deleteSliccWebhook(id) {
  if (!id) return true;
  const res = await exec(`webhook delete ${shellQuote(id)}`).catch(() => null);
  return !!(res && res.exitCode === 0);
}

async function registerBbWebhook(hookUrl, events) {
  const body = { url: hookUrl, events: events && events.length ? events : DEFAULT_WATCH_EVENTS };
  const res = await api('POST', '/api/v1/webhook', { body });
  const data = unwrap(res);
  if (!data || data.id == null) {
    die(
      `BlueBubbles webhook create returned unexpected payload: ${fmt.trunc(JSON.stringify(res), 200)}`,
      { prefix: 'bluebubbles' },
    );
  }
  return data;
}

/** Best-effort delete. Returns true when the endpoint is known to be gone. */
async function deleteBbWebhook(id) {
  if (id == null || id === '') return true;
  try {
    await api('DELETE', `/api/v1/webhook/${encodeURIComponent(String(id))}`);
    return true;
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    // best-effort
    return false;
  }
}

async function cmdWatch(flags) {
  const scoop = validateScoopName(str(flags.scoop) || '');
  const chatGuid = str(flags.chat) || str(flags.guid) || null;
  const events = parseEventsFlag(flags.events);
  const force = !!(flags.force || flags.f);
  const name =
    str(flags.name) ||
    `bb-${chatGuid ? 'chat' : 'all'}-${scoop}`.slice(0, 48);

  const watchId = sanitizeWatchId(chatGuid ? `chat-${chatGuid}` : `all-${scoop}`);
  await ensureWatchDir();
  const stateFile = watchStatePath(watchId);

  const existing = await readWatchState(stateFile);
  if (existing && !force) {
    die(
      `already watching ${watchId} → scoop "${existing.scoop}". Use --force to replace.`,
      { prefix: 'bluebubbles' },
    );
  }
  // --force deliberately does NOT retire the old pair here. The existing watch
  // keeps forwarding (and stays recorded in the state file) until the
  // replacement is registered and persisted, so a failure halfway through
  // cannot leave the operator with no monitoring at all. The cost is a short
  // window where both pairs are live and a matching message may lick twice.

  const filter = buildSliccFilter(chatGuid);
  let slicc;
  try {
    slicc = await createSliccWebhook({ scoop, name, filter });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    die(`SLICC webhook create failed: ${err.message || err}`, { prefix: 'bluebubbles' });
  }

  let bb;
  try {
    bb = await registerBbWebhook(slicc.url, events);
  } catch (err) {
    await deleteSliccWebhook(slicc.id);
    if (err?.name === 'NodeExitError') throw err;
    die(`BlueBubbles webhook register failed: ${err.message || err}`, {
      prefix: 'bluebubbles',
    });
  }

  const state = {
    watchId,
    scoop,
    chatGuid: chatGuid || null,
    events,
    sliccWebhookId: slicc.id,
    sliccWebhookUrl: slicc.url,
    bbWebhookId: bb.id,
    createdAt: new Date().toISOString(),
    // never store password
  };
  // Persist before anything else: the two ids only become discoverable to
  // `watches` / `unwatch` once they are on disk. If the write fails, the fresh
  // pair is unreachable, so retire it again rather than leaking a forwarder.
  try {
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    const sliccGone = await deleteSliccWebhook(slicc.id);
    const bbGone = await deleteBbWebhook(bb.id);
    const orphans = [];
    if (!sliccGone) orphans.push(`SLICC webhook ${slicc.id} — remove with: webhook delete ${slicc.id}`);
    if (!bbGone) orphans.push(`BlueBubbles webhook ${bb.id} — DELETE /api/v1/webhook/${bb.id}`);
    const rolled = orphans.length
      ? `  Rollback incomplete. Still active, delete by hand:\n    ${orphans.join('\n    ')}`
      : `  Rolled back: SLICC webhook ${slicc.id} and BlueBubbles webhook ${bb.id} were deleted; no new watch is active.`;
    const kept =
      existing && force
        ? `\n  The previous watch is untouched and still forwarding (slicc ${existing.sliccWebhookId}, bb ${existing.bbWebhookId}).`
        : '';
    die(
      `could not write watch state to ${stateFile}: ${err?.message || err}\n${rolled}${kept}`,
      { prefix: 'bluebubbles' },
    );
  }

  // Replacement is live and recorded — only now retire the pair it supersedes.
  let retired = null;
  if (existing && force) {
    const staleSlicc = existing.sliccWebhookId && existing.sliccWebhookId !== slicc.id;
    const staleBb =
      existing.bbWebhookId != null &&
      String(existing.bbWebhookId) !== String(bb.id);
    if (staleSlicc) await deleteSliccWebhook(existing.sliccWebhookId);
    if (staleBb) await deleteBbWebhook(existing.bbWebhookId);
    retired = {
      sliccWebhookId: staleSlicc ? existing.sliccWebhookId : null,
      bbWebhookId: staleBb ? existing.bbWebhookId : null,
    };
  }

  if (flags.json) {
    cli.out(retired ? { ...state, replaced: retired } : state);
    return;
  }

  console.log('');
  console.log(
    color.bold(color.cyan('  BlueBubbles watch')) +
      color.dim(`  ${watchId}`),
  );
  console.log(color.dim('  ' + '─'.repeat(52)));
  console.log(`  ${color.dim('scoop:')}     ${scoop}`);
  console.log(`  ${color.dim('events:')}    ${events.join(', ')}`);
  if (chatGuid) console.log(`  ${color.dim('chat:')}      ${chatGuid}`);
  else console.log(`  ${color.dim('chat:')}      ${color.dim('(all)')}`);
  console.log(`  ${color.dim('slicc wh:')}  ${slicc.id}`);
  console.log(`  ${color.dim('bb wh:')}     ${bb.id}`);
  console.log(`  ${color.dim('state:')}     ${stateFile}`);
  if (retired && (retired.sliccWebhookId || retired.bbWebhookId)) {
    console.log(
      `  ${color.dim('replaced:')}  ${color.dim(
        [retired.sliccWebhookId && `slicc ${retired.sliccWebhookId}`, retired.bbWebhookId && `bb ${retired.bbWebhookId}`]
          .filter(Boolean)
          .join(', '),
      )}`,
    );
  }
  console.log('');
  console.log(color.dim('  New matching messages arrive as licks on the scoop.'));
  console.log(color.dim(`  Stop with: bluebubbles unwatch ${watchId}`));
  console.log('');
}

async function cmdUnwatch(positional, flags) {
  const target = positional[0] || str(flags.id) || 'all';
  await ensureWatchDir();
  const files = await listWatchStateFiles();
  if (!files.length) {
    if (flags.json) {
      cli.out({ removed: [] });
      return;
    }
    console.log(color.dim('  No active BlueBubbles watches.'));
    return;
  }

  const removed = [];
  for (const file of files) {
    const st = await readWatchState(file);
    if (!st) continue;
    const id = st.watchId || path.basename(file, '.json');
    if (target !== 'all' && target !== id && sanitizeWatchId(target) !== id) {
      continue;
    }
    await deleteSliccWebhook(st.sliccWebhookId);
    await deleteBbWebhook(st.bbWebhookId);
    try {
      await fs.rm(file);
    } catch {
      /* ignore */
    }
    removed.push(id);
  }

  if (!removed.length) {
    die(`no watch matched "${target}" (try bluebubbles watches)`, {
      prefix: 'bluebubbles',
    });
  }

  if (flags.json) {
    cli.out({ removed });
    return;
  }
  console.log('');
  for (const id of removed) {
    console.log(`  ${color.green('✓')} stopped ${id}`);
  }
  console.log('');
}

async function cmdWatches(flags) {
  const files = await listWatchStateFiles();
  const rows = [];
  for (const file of files) {
    const st = await readWatchState(file);
    if (st) rows.push({ ...st, _file: file });
  }

  if (flags.json) {
    cli.out(rows.map(({ _file, ...r }) => r));
    return;
  }

  console.log('');
  console.log(color.bold('  Active BlueBubbles watches') + color.dim(`  (${rows.length})`));
  console.log(color.dim('  ' + '─'.repeat(52)));
  if (!rows.length) {
    console.log(color.dim('  None. Start with: bluebubbles watch --scoop=<name>'));
    console.log('');
    return;
  }
  for (const st of rows) {
    console.log(
      `  ${color.cyan(color.bold(st.watchId || '?'))}  →  scoop ${color.bold(st.scoop || '?')}`,
    );
    console.log(
      `     ${color.dim('events:')} ${(st.events || []).join(', ') || '—'}` +
        (st.chatGuid ? color.dim(`  chat: ${st.chatGuid}`) : color.dim('  chat: all')),
    );
    console.log(
      `     ${color.dim('bb:')} ${st.bbWebhookId}  ${color.dim('slicc:')} ${st.sliccWebhookId}`,
    );
    if (st.createdAt) console.log(`     ${color.dim(st.createdAt)}`);
  }
  console.log('');
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') {
    cli.help(HELP);
  }

  try {
    if (subcommand === 'status' || subcommand === 'ping' || subcommand === 'info') {
      await cmdStatus(flags);
    } else if (subcommand === 'chats' || subcommand === 'inbox' || subcommand === 'chat') {
      await cmdChats(flags);
    } else if (subcommand === 'messages' || subcommand === 'history' || subcommand === 'msg') {
      await cmdMessages(positional, flags);
    } else if (subcommand === 'send' || subcommand === 'post' || subcommand === 'text') {
      await cmdSend(positional, flags);
    } else if (subcommand === 'search' || subcommand === 'find') {
      await cmdSearch(positional, flags);
    } else if (subcommand === 'contacts' || subcommand === 'contact' || subcommand === 'people') {
      await cmdContacts(positional, flags);
    } else if (subcommand === 'handles' || subcommand === 'handle') {
      await cmdHandles(positional, flags);
    } else if (subcommand === 'watch') {
      await cmdWatch(flags);
    } else if (subcommand === 'unwatch' || subcommand === 'watch-stop') {
      await cmdUnwatch(positional, flags);
    } else if (subcommand === 'watches' || subcommand === 'watch-list') {
      await cmdWatches(flags);
    } else {
      die(`unknown command: ${subcommand}\nRun 'bluebubbles --help' for usage.`, {
        prefix: 'bluebubbles',
      });
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    die(err.message || String(err), { prefix: 'bluebubbles' });
  }
}

await main();
