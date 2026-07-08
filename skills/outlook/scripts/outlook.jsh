// outlook.jsh — Microsoft Outlook CLI for SLICC agents
// Uses MSAL tokens from the Outlook browser tab's localStorage.
//
// Usage: outlook <command> [args] [--flags]
//
// Commands:
//   mail      List inbox messages
//   calendar  List calendar events
//   send      Send an email
//   monday    Aggregated inbox for monday dispatcher
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ FIX — explicit sliccy: module imports (this commit, PR #143)               │
// │                                                                             │
// │ The `.jsh` runtime no longer injects `exec` (or `skill`/`cli`/`fmt`/`c`/    │
// │ `http`/`time`/`pool`, none of which this script happens to use) as a bare  │
// │ global. It still exists and works exactly as before — it must now be      │
// │ obtained explicitly via `require('sliccy:exec')`. Concretely:             │
// │  • Added `const exec = require('sliccy:exec');` at the top of the file.   │
// │    This script does not use `skill`, `cli`, `fmt`, `c`/`color`, `http`,   │
// │    `time`, or `pool` anywhere (checked via grep before importing anything  │
// │    — same discipline as the gh.jsh port in PR #150), so none of those      │
// │    were imported.                                                          │
// │  • Added `const fs = require('fs');` (plain node-ish builtin, not a       │
// │    `sliccy:` module). This script's `fs.writeFile(...)` / `fs.readFile(...)│
// │    ` call sites needed no further changes beyond the import — those        │
// │    methods exist directly on the `require('fs')` object, not only under   │
// │    `.promises` (verified against this file's exact old call shapes, same  │
// │    finding as the gh.jsh port).                                            │
// │  • `process.argv.parseFlags()` is NOT used anywhere in this script — its   │
// │    argument parsing was already a fully manual local loop (see            │
// │    "Argument Parsing" below), so no local replacement was needed here.    │
// │  • The local `C` object (ANSI color helpers) a few dozen lines down is a   │
// │    script-local `const`, not the removed bare `c` global — it is          │
// │    unrelated to the `sliccy:color` rename that `gh.jsh` needed and was     │
// │    left untouched.                                                         │
// │  • No other call sites changed. Every command, subcommand, and flag       │
// │    behaves exactly as before — this is a runtime-API port, not a feature   │
// │    or logic change. PR #143's own new `captureTokenFromNetwork` /          │
// │    `extractTokenFromCache` two-strategy token logic is unchanged beyond    │
// │    what was needed to make it run (the `exec`/`fs` imports above).        │
// ├─────────────────────────────────────────────────────────────────────────────┤
// │ FIX — revalidate captured tokens before reusing them (review comment,      │
// │ chatgpt-codex-connector[bot], P2)                                          │
// │                                                                             │
// │ `captureTokenFromNetwork()`'s poll loop read `window.__owaTok` and only    │
// │ checked that it LOOKED like a JWT (three dot-separated parts) before       │
// │ accepting it — not that it was still valid. `__owaTok` is a page-global    │
// │ set by the injected `consider()` hook and persists across multiple calls   │
// │ into the same tab (the hook itself only installs once, guarded by         │
// │ `__owaHooked`, by design — that part is correct and unchanged). If a       │
// │ previous call's captured token was still sitting in `__owaTok` when a      │
// │ later call started polling, and it had since expired, the old loop would  │
// │ return that stale token on its very first iteration, before the freshly   │
// │ (re)triggered fetch had any chance to produce a genuinely new one.        │
// │ Fixed both ways the review comment suggested, together rather than        │
// │ either alone:                                                              │
// │  • `window.__owaTok=null;` is now the first thing the injection script     │
// │    does on every call, before the `__owaHooked` check — this clears only   │
// │    the captured *value*, not the one-time hook installation, so a stale    │
// │    value from a prior call can never leak into a new call's poll loop.    │
// │  • Added `decodeJwtPayload()` / `isFreshBearerCandidate()` on the Node      │
// │    side, mirroring the injected script's own `dec()`/`consider()` claim-   │
// │    checking logic (aud must target outlook.office.com, exp must be in the  │
// │    future) rather than reinventing it, plus a 60s safety margin so a       │
// │    token that's about to expire isn't handed back only to expire before    │
// │    it's actually used for a real API call. The poll loop now calls this    │
// │    instead of the old `candidate.split('.').length === 3` shape-only       │
// │    check.                                                                  │
// │ Scope: entirely inside `captureTokenFromNetwork()` (strategy 2, the        │
// │ encrypted-cache path) — `extractTokenFromCache()` (strategy 1, legacy      │
// │ plaintext cache) is untouched by this fix.                                │
// └─────────────────────────────────────────────────────────────────────────────┘

const exec = require('sliccy:exec');
const fs = require('fs'); // plain node-ish builtin, not a sliccy: module

const OWA_BASE = 'https://outlook.office.com/api/v2.0';
const TOKEN_PATH = '/shared/.outlook-token';
const OUTLOOK_DOMAIN = 'outlook.office.com';
// Microsoft has split Outlook across several hostnames as part of the migration to
// the Microsoft 365 unified shell. Any of these tabs carries the same MSAL token
// keyed for outlook.office.com / graph.microsoft.com in localStorage.
const OUTLOOK_DOMAINS = ['outlook.office.com', 'outlook.cloud.microsoft', 'outlook.live.com'];

// ─── Argument Parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0] || '';
const positional = [];
const flags = {};

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  } else {
    positional.push(arg);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function parseDuration(dur) {
  if (!dur) return null;
  const match = dur.match(/^(\d+)(h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = { h: 3600000, d: 86400000, w: 604800000 };
  return ms[unit] * n;
}

function dateRange(dur, defaultDays) {
  const ms = dur ? parseDuration(dur) : defaultDays * 86400000;
  if (!ms) die(`Invalid duration: ${dur}. Use format like 24h, 7d, 2w`);
  const now = new Date();
  const start = new Date(now.getTime() - ms);
  return { start: start.toISOString(), end: now.toISOString() };
}

function futureRange(dur, defaultDays) {
  const ms = dur ? parseDuration(dur) : defaultDays * 86400000;
  if (!ms) die(`Invalid duration: ${dur}. Use format like 24h, 1d, 2w`);
  const now = new Date();
  const end = new Date(now.getTime() + ms);
  return { start: now.toISOString(), end: end.toISOString() };
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ─── Tab & Token Management ─────────────────────────────────────────────────

let _tabId = null;

async function findOutlookTab() {
  if (_tabId) return _tabId;
  const result = await exec('playwright-cli tab-list');
  if (result.exitCode !== 0) die('Failed to list browser tabs.');
  const lines = result.stdout.split('\n');
  for (const line of lines) {
    if (OUTLOOK_DOMAINS.some(d => line.includes(d))) {
      const m = line.match(/^\[([^\]]+)\]/);
      if (m) { _tabId = m[1]; return _tabId; }
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a JS expression in the Outlook tab via playwright-cli eval-file and return
// the trimmed stdout (or null on error / empty result).
async function evalInTab(tabId, scriptStr) {
  const tmpFile =
    '/tmp/.outlook-eval-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.js';
  await fs.writeFile(tmpFile, scriptStr);
  const r = await exec(`playwright-cli eval-file ${tmpFile} --tab=${tabId}`);
  await fs.writeFile(tmpFile, '').catch(() => {}); // clean up
  if (r.exitCode !== 0) return null;
  const raw = (r.stdout || '').trim();
  if (!raw || raw === 'null' || raw === 'undefined') return null;
  return raw;
}

function unwrapEvalString(raw) {
  // playwright-cli returns string results JSON-quoted; unwrap one layer.
  if (raw && raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw;
}

// Strategy 1 — legacy plaintext MSAL cache (old outlook.office.com client).
// The classic MSAL cache stores access tokens as JSON objects with a readable
// `.secret` field. Newer clients (outlook.cloud.microsoft) encrypt the cache
// ({id,nonce,data,lastUpdatedAt}), so this returns null there — see strategy 2.
async function extractTokenFromCache(tabId) {
  const extractScript = [
    '(function(){',
    'var best=null,bestScopes=0;',
    'var keys=Object.keys(localStorage);',
    'for(var i=0;i<keys.length;i++){',
    'var k=keys[i];',
    'if(k.indexOf("accesstoken")===-1)continue;',
    'if(k.indexOf("outlook.office.com")===-1&&k.indexOf("graph.microsoft.com")===-1)continue;',
    'try{var e=JSON.parse(localStorage.getItem(k));',
    'if(!e||!e.secret)continue;',
    'var scopes=(e.target||"").split(" ").length;',
    'var exp=parseInt(e.expiresOn||0);',
    'if(exp*1000<Date.now())continue;',  // skip expired
    'if(scopes>bestScopes){best=e;bestScopes=scopes;}}catch(x){}}',
    'if(best)return JSON.stringify({secret:best.secret,expiresOn:best.expiresOn,resource:best.target?best.target.split(" ")[0].split("/").slice(0,3).join("/"):"unknown"});',
    'return null})()',
  ].join('');

  const raw = await evalInTab(tabId, extractScript);
  if (!raw) return null;
  try {
    let parsed = unwrapEvalString(raw);
    const data = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    if (data && data.secret) return data.secret;
  } catch { /* fall through */ }
  return null;
}

// Decode a JWT's payload (base64url, no signature check — we only need the
// claims, not verification, since this token was captured straight from the
// page's own outgoing Authorization header). Returns null on any parse
// failure or malformed input. Mirrors the injected `dec()` helper's logic
// below, translated to the Node/.jsh side (no `atob` here — use
// Buffer.from(..., 'base64') instead).
function decodeJwtPayload(tok) {
  try {
    const parts = tok.split('.');
    if (parts.length !== 3) return null;
    let s = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '===='.slice(pad);
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Revalidate a captured bearer token candidate before trusting it: require a
// well-formed JWT, an `aud` targeting outlook.office.com (same check as the
// injected `consider()` below), and `exp` at least SAFETY_MARGIN_MS in the
// future. Without this, a stale `window.__owaTok` left over from a *previous*
// call into the same tab (the hook only installs once via `__owaHooked` and
// the page-global `__owaTok` can outlive its own token's validity) would be
// accepted on the very first poll iteration, before the freshly (re)installed
// hook ever gets a chance to observe a genuinely new Authorization header.
const TOKEN_EXP_SAFETY_MARGIN_MS = 60 * 1000;

function isFreshBearerCandidate(candidate) {
  if (!candidate || candidate.split('.').length !== 3) return false;
  const claims = decodeJwtPayload(candidate);
  if (!claims) return false;
  if (!claims.aud || String(claims.aud).indexOf('outlook.office.com') === -1) return false;
  if (!claims.exp) return false; // no exp claim — cannot prove freshness, reject
  return claims.exp * 1000 > Date.now() + TOKEN_EXP_SAFETY_MARGIN_MS;
}

// Strategy 2 — live network capture (new outlook.cloud.microsoft client).
// When the MSAL cache is encrypted we cannot read the token at rest, but the SPA
// constantly sends it as an `Authorization: Bearer` header. We hook fetch and
// XMLHttpRequest, nudge a background sync (focus/visibilitychange — OWA refreshes
// on these), and poll for a captured Bearer whose decoded JWT `aud` targets
// outlook.office.com.
async function captureTokenFromNetwork(tabId) {
  const injectScript = [
    '(function(){',
    // Clear any previously captured token value up front, on every call, so a
    // stale value from an earlier invocation into this same tab can never be
    // read by this call's poll loop below — regardless of the exp/aud check
    // in isFreshBearerCandidate(), belt-and-suspenders per the review comment.
    // This does NOT touch `__owaHooked` — the fetch/XHR hook installation
    // below must stay one-time-per-page-load (re-wrapping window.fetch/XHR on
    // every call would stack duplicate wrappers), only the *captured value*
    // is reset here.
    'window.__owaTok=null;',
    'function dec(t){try{var p=t.replace(/^Bearer\\s+/,"");var b=p.split(".")[1];var s=b.replace(/-/g,"+").replace(/_/g,"/");var pad=s.length%4;if(pad)s+="====".slice(pad);return JSON.parse(atob(s));}catch(e){return null;}}',
    'function consider(a){if(!a||!/^Bearer /.test(a))return;var j=dec(a);if(j&&j.aud&&String(j.aud).indexOf("outlook.office.com")!==-1&&(!j.exp||j.exp*1000>Date.now())){window.__owaTok=a.replace(/^Bearer\\s+/,"");}}',
    'if(!window.__owaHooked){window.__owaHooked=true;',
    'var of=window.fetch;window.fetch=function(input,init){try{var h=(init&&init.headers)||(input&&input.headers);var a=null;if(h){if(typeof h.get==="function")a=h.get("Authorization");else a=h.Authorization||h.authorization;}consider(a);}catch(e){}return of.apply(this,arguments);};',
    'var ox=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(/^authorization$/i.test(k))consider(v);}catch(e){}return ox.apply(this,arguments);};}',
    'try{document.dispatchEvent(new Event("visibilitychange"));window.dispatchEvent(new Event("focus"));window.dispatchEvent(new Event("online"));}catch(e){}',
    'return window.__owaTok?"have":"hooked";})()',
  ].join('');

  await evalInTab(tabId, injectScript);

  // Click a module-nav entry by accessible label to force the SPA to issue an
  // authenticated request (passive focus/visibility events alone don't reliably
  // trigger a sync). Switching Calendar <-> Mail each fires token-bearing calls;
  // we always return to Mail at the end to restore the user's view.
  const clickNav = (label) =>
    evalInTab(
      tabId,
      '(function(){try{var el=document.querySelector(\'[aria-label="' +
        label +
        '"]\');if(el){(el.closest("button,[role=button],a")||el).click();return "c";}}catch(e){}return "n"})()'
    );

  let tok = null;
  for (let i = 0; i < 15; i++) {
    const raw = await evalInTab(tabId, '(window.__owaTok||null)');
    if (raw) {
      const candidate = unwrapEvalString(raw);
      // Revalidate exp/aud here rather than trusting the three-dot-parts shape
      // check alone — see isFreshBearerCandidate() above for why.
      if (isFreshBearerCandidate(candidate)) {
        tok = candidate;
        break;
      }
    }
    await clickNav(i % 2 === 0 ? 'Calendar' : 'Mail');
    await sleep(1000);
  }

  await clickNav('Mail'); // restore Mail view
  return tok;
}

async function extractTokenFromBrowser() {
  const tabId = await findOutlookTab();
  if (!tabId) return null;

  // 1. Legacy plaintext MSAL cache.
  const cached = await extractTokenFromCache(tabId);
  if (cached) {
    await fs.writeFile(TOKEN_PATH, cached);
    return cached;
  }

  // 2. Encrypted-cache clients (outlook.cloud.microsoft): capture from network.
  const captured = await captureTokenFromNetwork(tabId);
  if (captured) {
    await fs.writeFile(TOKEN_PATH, captured);
    return captured;
  }

  return null;
}

async function getToken() {
  // 1. Try extracting from browser
  const browserToken = await extractTokenFromBrowser();
  if (browserToken) return browserToken;

  // 2. Fallback to saved token file
  try {
    const saved = (await fs.readFile(TOKEN_PATH)).trim();
    if (saved) return saved;
  } catch { /* no file */ }

  die(
    'Could not extract Outlook token. Open Outlook at https://outlook.office.com (or https://outlook.cloud.microsoft) in your browser and try again.'
  );
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function owaGet(token, path, params) {
  let url = path.startsWith('http') ? path : `${OWA_BASE}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    let msg;
    try { msg = JSON.parse(body).error?.message || body; } catch { msg = body; }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.json();
}

async function owaPost(token, path, body) {
  const url = path.startsWith('http') ? path : `${OWA_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { msg = JSON.parse(text).error?.message || text; } catch { msg = text; }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  // 202 Accepted for sendMail (no body)
  if (res.status === 202 || res.headers.get('content-length') === '0') return {};
  return res.json();
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
};

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdMail() {
  const token = await getToken();
  const limit = parseInt(flags.limit || '20', 10);
  const unread = flags.unread === true || flags.unread === 'true';
  const search = flags.search || null;
  const date = flags.date || null;

  const params = {
    '$top': String(limit),
    '$orderby': 'ReceivedDateTime desc',
    '$select': 'Id,Subject,From,ReceivedDateTime,IsRead,BodyPreview,ToRecipients,Importance,HasAttachments,WebLink',
  };

  // Build filter conditions
  const filters = [];
  if (unread) filters.push('IsRead eq false');
  if (date) {
    const range = dateRange(date, 7);
    filters.push(`ReceivedDateTime ge ${range.start}`);
  }
  if (filters.length > 0) params['$filter'] = filters.join(' and ');

  let path = '/me/mailFolders/inbox/messages';
  if (search) {
    // Use /me/messages with $search for search across all folders
    path = '/me/messages';
    params['$search'] = `"${search}"`;
    delete params['$filter'];   // $search and $filter don't mix
    delete params['$orderby'];  // $search and $orderby don't mix
  }

  try {
    const data = await owaGet(token, path, params);
    const messages = data.value || [];

    if (flags.json === true || flags.json === 'true') {
      out(messages);
      return;
    }

    if (messages.length === 0) {
      console.log('No messages found.');
      return;
    }

    console.log(`${C.bold('Inbox')} — ${messages.length} message${messages.length !== 1 ? 's' : ''}\n`);

    for (const msg of messages) {
      const read = msg.IsRead ? C.gray('○') : C.green('●');
      const date = formatDate(msg.ReceivedDateTime);
      const from = msg.From?.EmailAddress?.Name || msg.From?.EmailAddress?.Address || 'unknown';
      const subj = trunc(msg.Subject || '(no subject)', 80);
      const imp = msg.Importance === 'High' ? C.red(' !') : '';
      const attach = msg.HasAttachments ? C.yellow(' 📎') : '';
      console.log(`  ${read} ${C.gray(date)} ${C.cyan(from)}`);
      console.log(`    ${subj}${imp}${attach}`);
      if (msg.BodyPreview) console.log(`    ${C.gray(trunc(msg.BodyPreview, 120))}`);
      console.log('');
    }
  } catch (e) {
    die(`outlook: mail failed: ${e.message}`);
  }
}

async function cmdCalendar() {
  const token = await getToken();
  const limit = parseInt(flags.limit || '20', 10);
  const date = flags.date || '2d';

  const range = futureRange(date, 2);

  const params = {
    '$top': String(limit),
    'startDateTime': range.start,
    'endDateTime': range.end,
    '$orderby': 'Start/DateTime asc',
    '$select': 'Id,Subject,Start,End,Organizer,IsAllDay,ResponseStatus,Location,BodyPreview,WebLink,IsCancelled,OnlineMeetingUrl,Attendees,Categories',
  };

  try {
    const data = await owaGet(token, '/me/calendarview', params);
    const events = data.value || [];

    if (flags.json === true || flags.json === 'true') {
      out(events);
      return;
    }

    if (events.length === 0) {
      console.log('No calendar events found.');
      return;
    }

    console.log(`${C.bold('Calendar')} — ${events.length} event${events.length !== 1 ? 's' : ''} in next ${date}\n`);

    for (const ev of events) {
      const cancelled = ev.IsCancelled ? C.red(' [CANCELLED]') : '';
      const allDay = ev.IsAllDay ? C.yellow(' [All day]') : '';
      const start = ev.Start?.DateTime ? formatDate(ev.Start.DateTime + 'Z') : '';
      const end = ev.End?.DateTime ? formatDate(ev.End.DateTime + 'Z') : '';
      const org = ev.Organizer?.EmailAddress?.Name || ev.Organizer?.EmailAddress?.Address || '';
      const loc = ev.Location?.DisplayName ? ` @ ${ev.Location.DisplayName}` : '';
      const response = ev.ResponseStatus?.Response || '';
      const responseTag = response === 'Accepted' ? C.green(' ✓') :
                          response === 'Declined' ? C.red(' ✗') :
                          response === 'TentativelyAccepted' ? C.yellow(' ?') :
                          response === 'NotResponded' ? C.yellow(' [needs response]') : '';

      console.log(`  ${C.cyan(trunc(ev.Subject || '(no title)', 70))}${cancelled}${allDay}${responseTag}`);
      console.log(`    ${C.gray(start)} → ${C.gray(end)}${loc}`);
      if (org) console.log(`    ${C.gray('Organizer:')} ${org}`);
      console.log('');
    }
  } catch (e) {
    die(`outlook: calendar failed: ${e.message}`);
  }
}

async function cmdSend() {
  const token = await getToken();
  const to = flags.to;
  const subject = flags.subject || flags.subj;
  const body = flags.body || positional[0];

  if (!to) die('outlook send: --to is required');
  if (!subject) die('outlook send: --subject is required');
  if (!body) die('outlook send: --body is required (flag or positional arg)');

  const recipients = to.split(',').map(email => ({
    EmailAddress: { Address: email.trim() }
  }));

  const payload = {
    Message: {
      Subject: subject,
      Body: { ContentType: 'Text', Content: body },
      ToRecipients: recipients,
    },
    SaveToSentItems: true,
  };

  try {
    await owaPost(token, '/me/sendMail', payload);
    console.log(C.green('✓') + ` Email sent to ${to}`);
  } catch (e) {
    die(`outlook: send failed: ${e.message}`);
  }
}

async function cmdMonday() {
  const token = await getToken();
  const limit = parseInt(flags.limit || '50', 10);
  const date = flags.date || '7d';
  const depth = parseInt(flags.depth || '5', 10);

  const items = [];

  // 1. Unread inbox messages
  try {
    const mailParams = {
      '$top': String(Math.min(limit, 50)),
      '$orderby': 'ReceivedDateTime desc',
      '$filter': 'IsRead eq false',
      '$select': 'Id,Subject,From,ReceivedDateTime,IsRead,BodyPreview,ToRecipients,Importance,WebLink',
    };
    const mailData = await owaGet(token, '/me/mailFolders/inbox/messages', mailParams);
    for (const msg of (mailData.value || [])) {
      items.push({
        source: 'outlook',
        type: 'email',
        id: `outlook-mail-${msg.Id}`,
        title: msg.Subject || '(no subject)',
        body: trunc(msg.BodyPreview || '', 300),
        url: msg.WebLink || `https://outlook.office.com/mail/id/${encodeURIComponent(msg.Id)}`,
        from: msg.From?.EmailAddress?.Address || '',
        date: msg.ReceivedDateTime || '',
        importance: msg.Importance || 'Normal',
        repo: null,
        number: null,
      });
    }
  } catch (e) {
    console.error(`[outlook monday] WARNING: failed to fetch unread mail: ${e.message}`);
  }

  // 2. Calendar events for today + tomorrow (2 days ahead)
  try {
    const now = new Date();
    const start = now.toISOString();
    const end = new Date(now.getTime() + 2 * 86400000).toISOString();

    const calParams = {
      '$top': String(Math.min(limit, 30)),
      'startDateTime': start,
      'endDateTime': end,
      '$orderby': 'Start/DateTime asc',
      '$select': 'Id,Subject,Start,End,Organizer,IsAllDay,ResponseStatus,Location,BodyPreview,WebLink,IsCancelled,OnlineMeetingUrl',
    };
    const calData = await owaGet(token, '/me/calendarview', calParams);
    for (const ev of (calData.value || [])) {
      if (ev.IsCancelled) continue;

      const response = ev.ResponseStatus?.Response || '';
      const type = response === 'NotResponded' ? 'meeting' : 'calendar';

      items.push({
        source: 'outlook',
        type,
        id: `outlook-cal-${ev.Id}`,
        title: ev.Subject || '(no title)',
        body: trunc(ev.BodyPreview || '', 300),
        url: ev.WebLink || `https://outlook.office.com/calendar/item/${encodeURIComponent(ev.Id)}`,
        from: ev.Organizer?.EmailAddress?.Address || '',
        date: ev.Start?.DateTime ? ev.Start.DateTime + 'Z' : '',
        location: ev.Location?.DisplayName || null,
        response: response || null,
        repo: null,
        number: null,
      });
    }
  } catch (e) {
    console.error(`[outlook monday] WARNING: failed to fetch calendar: ${e.message}`);
  }

  console.log(JSON.stringify(items, null, 2));
}

async function cmdView() {
  const token = await getToken();
  const id = positional[0];
  if (!id) die('outlook view: provide a message ID');

  try {
    const msg = await owaGet(token, `/me/messages/${encodeURIComponent(id)}`, {
      '$select': 'Id,Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,Body,Importance,HasAttachments,WebLink',
    });

    console.log(C.bold(msg.Subject || '(no subject)'));
    console.log(`${C.gray('From:')} ${msg.From?.EmailAddress?.Name || ''} <${msg.From?.EmailAddress?.Address || ''}>`);
    const to = (msg.ToRecipients || []).map(r => r.EmailAddress?.Address).join(', ');
    if (to) console.log(`${C.gray('To:')} ${to}`);
    const cc = (msg.CcRecipients || []).map(r => r.EmailAddress?.Address).join(', ');
    if (cc) console.log(`${C.gray('Cc:')} ${cc}`);
    console.log(`${C.gray('Date:')} ${formatDate(msg.ReceivedDateTime)}`);
    if (msg.Importance && msg.Importance !== 'Normal') console.log(`${C.gray('Importance:')} ${msg.Importance}`);
    console.log(`${C.gray('Link:')} ${msg.WebLink || ''}`);
    console.log('');

    // Strip HTML tags for plain-text display
    const bodyContent = msg.Body?.Content || '';
    const plainBody = bodyContent
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(trunc(plainBody, 2000));
  } catch (e) {
    die(`outlook: view failed: ${e.message}`);
  }
}

// ─── Calendar Response Commands ──────────────────────────────────────────────

const RESPOND_LABELS = {
  accept: { progressive: 'Accepting', past: 'Accepted' },
  decline: { progressive: 'Declining', past: 'Declined' },
  tentativelyAccept: { progressive: 'Tentatively accepting', past: 'Tentative' },
};

async function cmdRespond(action) {
  const token = await getToken();
  const comment = flags.comment || flags.message || '';
  const silent = flags.silent === true || flags.silent === 'true';
  const labels = RESPOND_LABELS[action];

  // Collect event IDs: positional args or --all pending events
  let eventIds = [...positional];
  const subjectsById = new Map();

  if (eventIds.length === 0 && flags.all) {
    // Respond to all pending events in the calendar window, paging through results
    const date = flags.date || '2d';
    const range = futureRange(date, 2);
    let page = await owaGet(token, '/me/calendarview', {
      '$top': '50',
      'startDateTime': range.start,
      'endDateTime': range.end,
      '$select': 'Id,Subject,ResponseStatus',
    });
    const pending = [];
    while (true) {
      for (const ev of page.value || []) {
        if (ev.ResponseStatus?.Response === 'NotResponded') {
          pending.push(ev);
        }
      }
      const next = page['@odata.nextLink'];
      if (!next) break;
      page = await owaGet(token, next);
    }
    if (pending.length === 0) {
      console.log('No pending events to respond to.');
      return;
    }
    for (const ev of pending) {
      eventIds.push(ev.Id);
      if (ev.Subject) subjectsById.set(ev.Id, ev.Subject);
    }
    console.log(`${C.bold(labels.progressive)} ${pending.length} pending event(s)...\n`);
  }

  if (eventIds.length === 0) {
    die(`outlook ${action}: provide one or more event IDs, or use --all`);
  }

  const body = { SendResponse: !silent };
  if (comment) body.Comment = comment;

  let success = 0;
  let failed = 0;

  for (const id of eventIds) {
    try {
      await owaPost(token, `/me/events/${encodeURIComponent(id)}/${action}`, body);
      success++;
      // Use the subject from the initial fetch when available; fall back to a lookup otherwise
      let subject = subjectsById.get(id);
      if (!subject) {
        try {
          const ev = await owaGet(token, `/me/events/${encodeURIComponent(id)}`, { '$select': 'Subject' });
          subject = ev.Subject;
        } catch { /* ignore */ }
      }
      const display = subject || `${id.slice(0, 20)}...`;
      console.log(`  ${C.green('✓')} ${labels.past}: ${display}`);
    } catch (e) {
      failed++;
      const msg = e.message || '';
      if (msg.includes('organizer') || msg.includes('response')) {
        console.log(`  ${C.yellow('⚠')} Skipped (no response allowed): ${id.slice(0, 20)}...`);
      } else {
        console.log(`  ${C.red('✗')} Failed: ${msg}`);
      }
    }
  }

  console.log(`\n${success} responded, ${failed} failed/skipped.`);
}

function showHelp() {
  console.log(`outlook — Microsoft Outlook CLI for SLICC

Usage: outlook <command> [options]

Commands:
  mail       List inbox messages
  calendar   List calendar events
  accept     Accept calendar event(s)
  decline    Decline calendar event(s)
  tentative  Tentatively accept calendar event(s)
  send       Send an email
  view       View a single message
  monday     Aggregated inbox items for monday dispatcher

Mail options:
  --limit N          Number of messages (default: 20)
  --date PERIOD      Filter by age (e.g. 1d, 7d, 2w)
  --unread           Show only unread messages
  --search QUERY     Search across all folders
  --json             Output raw JSON

Calendar options:
  --limit N          Number of events (default: 20)
  --date PERIOD      How far ahead to look (default: 2d)
  --json             Output raw JSON

Respond options (accept/decline/tentative):
  outlook accept <event-id> [<event-id>...]
  outlook decline <event-id> --comment "Can't make it"
  outlook accept --all              Accept all pending events
  outlook decline --all --date 7d   Decline all pending in next week
  --comment TEXT    Optional message to organizer
  --silent          Don't send response to organizer
  --all             Act on all NotResponded events in date range
  --date PERIOD     With --all, calendar window to scan (default: 2d)

Send options:
  --to EMAIL         Recipient(s), comma-separated
  --subject TEXT     Email subject
  --body TEXT        Email body

View:
  outlook view <message-id>

Monday options:
  --limit N          Max items per source (default: 50)
  --date PERIOD      Date range (default: 7d)
  --depth N          Detail depth (default: 5)

Authentication:
  Token is extracted automatically from the Outlook browser tab
  (MSAL localStorage). Falls back to /workspace/.outlook-token.
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  switch (subcommand) {
    case 'mail':
    case 'inbox':
      await cmdMail();
      break;
    case 'calendar':
    case 'cal':
      await cmdCalendar();
      break;
    case 'accept':
      await cmdRespond('accept');
      break;
    case 'decline':
      await cmdRespond('decline');
      break;
    case 'tentative':
    case 'maybe':
      await cmdRespond('tentativelyAccept');
      break;
    case 'send':
      await cmdSend();
      break;
    case 'view':
      await cmdView();
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
      console.error(`Unknown command: ${subcommand}`);
      showHelp();
      process.exit(1);
  }
} catch (e) {
  console.error(`outlook: ${e.message}`);
  process.exit(1);
}
