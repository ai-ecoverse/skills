// outlook.jsh — Microsoft Outlook CLI for SLICC agents
// Uses MSAL tokens from the Outlook browser tab's localStorage.
//
// Usage: outlook <command> [args] [--flags]
//
// Commands:
//   mail      List inbox messages
//   calendar  List calendar events
//   event     Show one calendar event in full (body, Teams join info, recurrence)
//   send      Send an email
//   monday    Aggregated inbox for monday dispatcher
//
// ─── jsh runtime migration (issue #167) ─────────────────────────
// This script was ported to the current SLICC .jsh runtime:
//  • Browser access uses the sliccy:browser bridge (findTab / eval) instead
//    of the legacy tab-list / eval-file browser CLI shell-outs.
//  • Colored output uses require('sliccy:color') instead of raw ANSI escapes
//    (auto-disabled on non-TTY / NO_COLOR).
//  • Argument parsing uses process.argv.parseFlags() instead of a manual loop.
//  • Every capability bridge is obtained explicitly via require('sliccy:<name>');
//    Node builtins (fs) still come from require('fs').
// ┌─────────────────────────────────────────────────────────────────────────────┐
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

const browser = require('sliccy:browser');
const C = require('sliccy:color');
const fs = require('fs'); // plain node-ish builtin, not a sliccy: module

const OWA_BASE = 'https://outlook.office.com/api/v2.0';
const TOKEN_PATH = '/shared/.outlook-token';
// Cached mailbox timezone (GET /me/MailboxSettings → .TimeZone). Calendar times
// are requested in this zone via the `Prefer: outlook.timezone` header; without
// it OWA answers in UTC and an 11:30 CEST meeting prints as 09:30.
const TZ_PATH = '/shared/.outlook-timezone';
const OUTLOOK_DOMAIN = 'outlook.office.com';
// Microsoft has split Outlook across several hostnames as part of the migration to
// the Microsoft 365 unified shell. Any of these tabs carries the same MSAL token
// keyed for outlook.office.com / graph.microsoft.com in localStorage.
const OUTLOOK_DOMAINS = ['outlook.office.com', 'outlook.cloud.microsoft', 'outlook.live.com'];

// ─── Argument Parsing ────────────────────────────────────────────────────────

const { positional: _allPositional, flags } = process.argv.parseFlags();
const subcommand = _allPositional[0] || '';
const positional = _allPositional.slice(1);

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

// Event Start/End are wall-clock times in the timezone we asked OWA for (see
// `Prefer: outlook.timezone` in owaGet) — they carry no offset, so they must NOT
// be re-parsed as UTC. `2026-08-04T11:30:00.0000000` → `2026-08-04 11:30`.
function formatEventTime(slot) {
  const dt = slot && slot.DateTime;
  if (!dt) return '';
  return String(dt)
    .replace('T', ' ')
    .replace(/:\d{2}(\.\d+)?$/, '')
    .trim();
}

// Render an end stamp relative to its start: same day → time only, otherwise the
// full `YYYY-MM-DD HH:MM`. Both arguments are already-formatted strings.
function endLabel(start, end) {
  if (!end) return '';
  const startDate = String(start).split(' ')[0];
  const [endDate, endTime] = String(end).split(' ');
  return startDate && endDate === startDate && endTime ? endTime : end;
}

// ─── HTML → plain text ───────────────────────────────────────────────────────
// Invite bodies come back as HTML (`Body.ContentType: "HTML"`); BodyPreview is
// truncated mid-invite, so details always fetch `Body` and render it here.
// Deliberately dependency-free: no python3 / html-to-markdown in this runtime.

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(?:quot|ldquo|rdquo);/gi, '"')
    .replace(/&(?:apos|lsquo|rsquo);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&(?:ndash|mdash);/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&'); // last, so &amp;lt; doesn't become '<'
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function htmlToText(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Raw newlines are insignificant whitespace in HTML — collapse them before
    // tags introduce the real line breaks, otherwise labels and values get cut
    // apart at arbitrary points ("Join\n the meeting now").
    .replace(/\n+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|tr|li|ul|ol|h[1-6]|blockquote|table|section|header|footer|pre)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// ─── Conferencing (Teams / Webex VTC / PSTN) extraction ──────────────────────
// Teams invites put the label and its value in SEPARATE inline tags, so after
// htmlToText() they land on consecutive lines ("Meeting ID:" / "220 ..."). Match
// both shapes: value on the same line, or on the next one.

// Labels are localised (the mailbox may render invites in German) and Teams has
// shipped several invite layouts, so every field accepts a few aliases. `kind`
// controls how the captured value is tidied: 'id' values are digit groups that
// are often followed by unrelated link text on the same line.
const CONF_LABELS = [
  ['meetingId', 'id', /^(?:meeting|besprechungs)[\s-]*(?:id|kennung)\s*:?\s*(.*)$/i],
  ['passcode', 'raw', /^(?:passcode|password|kenncode|passwort)\s*:?\s*(.*)$/i],
  ['tenantKey', 'raw', /^(?:tenant key|mandantenschl(?:ü|ue)ssel)\s*:?\s*(.*)$/i],
  ['videoId', 'id', /^video(?:[\s-]conference)?[\s-]*id\s*:?\s*(.*)$/i],
  ['videoId', 'id', /^video-?konferenz[\s-]*id\s*:?\s*(.*)$/i],
  [
    'conferenceId',
    'id',
    /^(?:phone conference id|conference id|telefonkonferenz[\s-]*id|konferenz[\s-]*id)\s*:?\s*(.*)$/i,
  ],
];

const PHONE_RE = /(\+\d[\d\s\u00a0().-]{5,}\d)/;
const WEBEX_TENANT_RE = /^[\w.+-]+@[\w.-]*webex\.com$/i;

function tidyConfValue(value, kind) {
  let s = String(value).split('|')[0].trim();
  if (kind === 'id') {
    // e.g. "399 774 325# Find a local number" → "399 774 325#"
    const digits = s.match(/^[\d\s\u00a0]{3,}#?/);
    if (digits) s = digits[0].trim();
  }
  return s.replace(/\s{2,}/g, ' ').trim();
}

function labelledValue(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const inline = (m[1] || '').trim();
    if (inline) return inline;
    // Label-only line — Teams puts label and value in separate inline tags, so
    // the value is the next non-empty line, unless that is itself a label.
    const next = (lines[i + 1] || '').trim();
    if (!next) continue;
    if (CONF_LABELS.some(([, , labelRe]) => labelRe.test(next))) continue;
    return next;
  }
  return null;
}

function extractPhones(lines) {
  const phones = [];
  const seen = new Set();
  for (const line of lines) {
    const m = line.match(PHONE_RE);
    if (!m) continue;
    const number = m[1].replace(/[\u00a0\s]+/g, ' ').trim();
    const digits = number.replace(/\D/g, '');
    if (digits.length < 7) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    // What's left of the line is the region label, minus the ",,<pin># " prefix.
    const label = line
      .replace(m[1], '')
      .replace(/^[\s,]*\d+#/, '')
      .replace(/^[\s,#()]+|[\s,|]+$/g, '')
      .split('|')[0]
      .trim();
    phones.push(label ? { number, label } : { number });
  }
  return phones;
}

// `OnlineMeetingUrl` is frequently null even for Teams meetings, so fall back to
// `OnlineMeeting.JoinUrl` and finally to the invite body's join anchor. Prefer
// the anchor's `originalsrc` — `href` is a Safelinks wrapper.
function joinUrlFromHtml(html) {
  if (!html) return null;
  const anchors = String(html).match(/<a\b[^>]*>/gi) || [];
  for (const tag of anchors) {
    if (!/join_link|Meeting join link/i.test(tag)) continue;
    const orig = tag.match(/originalsrc="([^"]+)"/i);
    if (orig) return decodeEntities(orig[1]);
    const href = tag.match(/href="([^"]+)"/i);
    if (href) return decodeEntities(href[1]);
  }
  const direct = String(html).match(
    /https:\/\/(?:teams\.microsoft\.com\/l\/meetup-join|[\w.-]*zoom\.us\/j|meet\.google\.com|[\w.-]*webex\.com\/[^"'\s<>]*j\.php)[^"'\s<>]*/i
  );
  return direct ? decodeEntities(direct[0]) : null;
}

function parseConferencing(ev, textLines) {
  const conf = {};
  const provider = ev.OnlineMeetingProvider;
  if (provider && provider !== 'Unknown') conf.provider = provider;

  const joinUrl =
    (ev.OnlineMeeting && ev.OnlineMeeting.JoinUrl) ||
    ev.OnlineMeetingUrl ||
    joinUrlFromHtml(ev.Body && ev.Body.Content);
  if (joinUrl) conf.joinUrl = joinUrl;

  for (const [key, kind, re] of CONF_LABELS) {
    if (conf[key]) continue; // first alias that matches wins
    const value = labelledValue(textLines, re);
    if (value) conf[key] = tidyConfValue(value, kind);
  }

  // Older Teams layouts print the Webex tenant key as a bare line under
  // "Join with a video conferencing device", with no label at all.
  if (!conf.tenantKey) {
    const bare = textLines.find((line) => WEBEX_TENANT_RE.test(line.trim()));
    if (bare) conf.tenantKey = bare.trim();
  }

  const phones = extractPhones(textLines);
  if (phones.length) conf.phones = phones;

  return conf;
}

// ─── Recurrence ──────────────────────────────────────────────────────────────

function summarizeRecurrence(rec) {
  if (!rec) return null;
  const p = rec.Pattern || {};
  const r = rec.Range || {};
  const n = p.Interval || 1;
  const every = (unit) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
  const days = (p.DaysOfWeek || []).join(', ');
  const index = (p.Index || '').toLowerCase();

  let s;
  switch (p.Type) {
    case 'Daily':
      s = every('day');
      break;
    case 'Weekly':
      s = every('week') + (days ? ` on ${days}` : '');
      break;
    case 'AbsoluteMonthly':
      s = every('month') + (p.DayOfMonth ? ` on day ${p.DayOfMonth}` : '');
      break;
    case 'RelativeMonthly':
      s = every('month') + ` on the ${index} ${days}`.replace(/\s+/g, ' ');
      break;
    case 'AbsoluteYearly':
      s = every('year') + (p.DayOfMonth ? ` on ${p.Month}-${p.DayOfMonth}` : '');
      break;
    case 'RelativeYearly':
      s = every('year') + ` on the ${index} ${days} of month ${p.Month}`.replace(/\s+/g, ' ');
      break;
    default:
      s = p.Type ? String(p.Type) : 'recurring';
  }

  const from = r.StartDate ? String(r.StartDate).slice(0, 10) : null;
  if (r.Type === 'NoEnd') s += from ? `, from ${from} (no end)` : ', no end date';
  else if (r.Type === 'Numbered') s += `, ${from ? from + ' → ' : ''}${r.NumberOfOccurrences} occurrences`;
  else if (r.EndDate) s += `, ${from ? from + ' → ' : ''}${String(r.EndDate).slice(0, 10)}`;
  else if (from) s += `, from ${from}`;
  return s.trim();
}

// ─── Tab & Token Management ─────────────────────────────────────────────────

let _tabId = null;

async function findOutlookTab() {
  if (_tabId) return _tabId;
  for (const domain of OUTLOOK_DOMAINS) {
    const tab = await browser.findTab({ domain });
    if (tab) {
      _tabId = tab;
      return _tabId;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a JS expression in the Outlook tab via the sliccy:browser bridge and
// return the trimmed string result (or null on error / empty result).
async function evalInTab(tabId, scriptStr) {
  try {
    const result = await browser.eval(tabId, scriptStr);
    if (result === null || result === undefined) return null;
    const raw = String(result).trim();
    if (!raw || raw === 'null' || raw === 'undefined') return null;
    return raw;
  } catch {
    return null;
  }
}

function unwrapEvalString(raw) {
  // browser.eval returns raw values; defensively unwrap a JSON-quoted string.
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

  // 2. Fallback to saved token file — only if it is still fresh. A stale
  // on-disk token would otherwise be returned and cause confusing downstream
  // API failures (401s / empty-body parse errors) instead of the actionable
  // "open Outlook" guidance below. Mirrors the revalidation already applied to
  // network-captured tokens (see isFreshBearerCandidate).
  try {
    const saved = (await fs.readFile(TOKEN_PATH)).trim();
    if (saved && isFreshBearerCandidate(saved)) return saved;
  } catch { /* no file */ }

  die(
    'Could not extract Outlook token. Open Outlook at https://outlook.office.com (or https://outlook.cloud.microsoft) in your browser and try again.'
  );
}

// ─── API Client ──────────────────────────────────────────────────────────────

// opts.timezone → `Prefer: outlook.timezone="<Windows tz name>"`, which makes OWA
// return Start/End as wall-clock times in that zone instead of UTC.
async function owaGet(token, path, params, opts) {
  let url = path.startsWith('http') ? path : `${OWA_BASE}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (opts && opts.timezone) headers['Prefer'] = `outlook.timezone="${opts.timezone}"`;
  const res = await fetch(url, { headers });
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

// ─── Mailbox timezone ────────────────────────────────────────────────────────
// `--timezone` wins; otherwise use the mailbox's own zone (cached in TZ_PATH so
// the extra round-trip happens once), falling back to UTC if it can't be read.

let _timezone = null;

async function getTimezone(token) {
  if (_timezone) return _timezone;
  if (flags.timezone) {
    _timezone = String(flags.timezone);
    return _timezone;
  }
  try {
    const cached = (await fs.readFile(TZ_PATH)).trim();
    if (cached) {
      _timezone = cached;
      return _timezone;
    }
  } catch { /* no cache yet */ }
  try {
    const settings = await owaGet(token, '/me/MailboxSettings', { '$select': 'TimeZone' });
    if (settings && settings.TimeZone) {
      _timezone = settings.TimeZone;
      try { await fs.writeFile(TZ_PATH, _timezone); } catch { /* cache is best-effort */ }
      return _timezone;
    }
  } catch { /* fall through to UTC */ }
  _timezone = 'UTC';
  return _timezone;
}

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
  const details = flags.details === true || flags.details === 'true';
  const tz = await getTimezone(token);

  const range = futureRange(date, 2);

  const params = {
    '$top': String(limit),
    'startDateTime': range.start,
    'endDateTime': range.end,
    '$orderby': 'Start/DateTime asc',
    '$select': 'Id,Subject,Start,End,Organizer,IsAllDay,ResponseStatus,Location,BodyPreview,WebLink,IsCancelled,OnlineMeetingUrl,Attendees,Categories,Type,SeriesMasterId',
  };

  try {
    const data = await owaGet(token, '/me/calendarview', params, { timezone: tz });
    const events = data.value || [];

    // --details re-fetches each event with Body/OnlineMeeting/Recurrence so the
    // full invite and parsed join info are available (the list projection only
    // carries the truncated BodyPreview).
    if (details) {
      const full = [];
      for (const ev of events) {
        try {
          full.push(eventDetails(await fetchEvent(token, ev.Id, tz), tz));
        } catch (e) {
          console.error(`outlook: calendar --details: ${ev.Id.slice(0, 20)}...: ${e.message}`);
        }
      }
      if (flags.json === true || flags.json === 'true') {
        out(full);
        return;
      }
      if (full.length === 0) {
        console.log('No calendar events found.');
        return;
      }
      full.forEach((d, i) => {
        if (i > 0) console.log('');
        printEventDetails(d);
      });
      return;
    }

    if (flags.json === true || flags.json === 'true') {
      out(events);
      return;
    }

    if (events.length === 0) {
      console.log('No calendar events found.');
      return;
    }

    console.log(
      `${C.bold('Calendar')} — ${events.length} event${events.length !== 1 ? 's' : ''} in next ${date} ${C.gray(`(times in ${tz})`)}\n`
    );

    for (const ev of events) {
      const cancelled = ev.IsCancelled ? C.red(' [CANCELLED]') : '';
      const allDay = ev.IsAllDay ? C.yellow(' [All day]') : '';
      const start = formatEventTime(ev.Start);
      const end = endLabel(start, formatEventTime(ev.End));
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
      console.log(`    ${C.gray('id:')} ${C.gray(ev.Id)}`);
      console.log('');
    }
  } catch (e) {
    die(`outlook: calendar failed: ${e.message}`);
  }
}

// ─── Event Details ───────────────────────────────────────────────────────────

const EVENT_SELECT =
  'Id,Subject,Start,End,IsAllDay,IsCancelled,Type,SeriesMasterId,Recurrence,Organizer,Attendees,' +
  'Location,Locations,ResponseStatus,ShowAs,Importance,Sensitivity,Categories,Body,BodyPreview,' +
  'WebLink,OnlineMeetingUrl,OnlineMeeting,IsOnlineMeeting,OnlineMeetingProvider';

function fetchEvent(token, id, tz) {
  return owaGet(token, `/me/events/${encodeURIComponent(id)}`, { '$select': EVENT_SELECT }, { timezone: tz });
}

function eventDetails(ev, tz) {
  const raw = ev.Body?.Content || '';
  const body = ev.Body?.ContentType === 'Text' ? normalizeText(raw) : htmlToText(raw);
  const lines = body ? body.split('\n') : [];
  const attendees = (ev.Attendees || []).map((a) => ({
    name: a.EmailAddress?.Name || '',
    address: a.EmailAddress?.Address || '',
    type: a.Type || '',
    response: a.Status?.Response || '',
  }));

  const details = {
    id: ev.Id,
    subject: ev.Subject || '(no title)',
    type: ev.Type || '',
    timeZone: tz,
    start: formatEventTime(ev.Start),
    end: formatEventTime(ev.End),
    isAllDay: !!ev.IsAllDay,
    isCancelled: !!ev.IsCancelled,
    organizer: {
      name: ev.Organizer?.EmailAddress?.Name || '',
      address: ev.Organizer?.EmailAddress?.Address || '',
    },
    location: ev.Location?.DisplayName || null,
    locations: (ev.Locations || []).map((l) => l.DisplayName).filter(Boolean),
    response: ev.ResponseStatus?.Response || null,
    showAs: ev.ShowAs || null,
    importance: ev.Importance || null,
    sensitivity: ev.Sensitivity || null,
    categories: ev.Categories || [],
    attendees,
    conferencing: parseConferencing(ev, lines),
    webLink: ev.WebLink || null,
    body,
  };

  if (ev.SeriesMasterId) details.seriesMasterId = ev.SeriesMasterId;
  if (ev.Recurrence) {
    details.recurrence = {
      summary: summarizeRecurrence(ev.Recurrence),
      pattern: ev.Recurrence.Pattern || null,
      range: ev.Recurrence.Range || null,
      // The series' own authoring zone — NOT the display zone above.
      timeZone: ev.Recurrence.Range?.RecurrenceTimeZone || null,
    };
  }
  return details;
}

function printEventDetails(d) {
  const cancelled = d.isCancelled ? C.red(' [CANCELLED]') : '';
  const allDay = d.isAllDay ? C.yellow(' [All day]') : '';
  console.log(`${C.bold(C.cyan(d.subject))}${cancelled}${allDay}`);
  console.log(`${C.gray('When:')} ${d.start} → ${endLabel(d.start, d.end)} ${C.gray(`(${d.timeZone})`)}`);
  if (d.organizer.name || d.organizer.address) {
    console.log(`${C.gray('Organizer:')} ${d.organizer.name}${d.organizer.address ? ` <${d.organizer.address}>` : ''}`);
  }
  if (d.location) console.log(`${C.gray('Location:')} ${d.location}`);
  if (d.response) console.log(`${C.gray('Your response:')} ${d.response}`);
  if (d.showAs) console.log(`${C.gray('Show as:')} ${d.showAs}`);
  if (d.categories.length) console.log(`${C.gray('Categories:')} ${d.categories.join(', ')}`);
  if (d.type) console.log(`${C.gray('Type:')} ${d.type}`);
  if (d.seriesMasterId) console.log(`${C.gray('Series master id:')} ${d.seriesMasterId}`);
  if (d.recurrence?.summary) {
    console.log(`${C.gray('Recurrence:')} ${d.recurrence.summary}`);
    if (d.recurrence.timeZone && d.recurrence.timeZone !== d.timeZone) {
      console.log(`${C.gray('Recurrence timezone:')} ${d.recurrence.timeZone} ${C.gray('(series authoring zone)')}`);
    }
  }
  if (d.attendees.length) {
    console.log(`${C.gray('Attendees:')} ${d.attendees.length}`);
    const shown = d.attendees.slice(0, 12);
    for (const a of shown) {
      const who = a.name || a.address;
      const resp = a.response && a.response !== 'None' ? C.gray(` — ${a.response}`) : '';
      console.log(`  ${who}${resp}`);
    }
    if (d.attendees.length > shown.length) {
      console.log(C.gray(`  … ${d.attendees.length - shown.length} more (use --json for all)`));
    }
  }
  console.log(`${C.gray('id:')} ${d.id}`);
  if (d.webLink) console.log(`${C.gray('Link:')} ${d.webLink}`);

  const c = d.conferencing || {};
  const hasJoinInfo = Object.keys(c).length > 0;
  if (hasJoinInfo) {
    console.log(`\n${C.bold('Join info')}${c.provider ? ` ${C.gray(`(${c.provider})`)}` : ''}`);
    if (c.joinUrl) console.log(`  ${C.gray('Join URL:')} ${c.joinUrl}`);
    if (c.meetingId) console.log(`  ${C.gray('Meeting ID:')} ${c.meetingId}`);
    if (c.passcode) console.log(`  ${C.gray('Passcode:')} ${c.passcode}`);
    if (c.tenantKey) console.log(`  ${C.gray('Video tenant key:')} ${c.tenantKey}`);
    if (c.videoId) console.log(`  ${C.gray('Video ID:')} ${c.videoId}`);
    if (c.phones?.length) {
      for (const p of c.phones) {
        console.log(`  ${C.gray('Dial-in:')} ${p.number}${p.label ? ` ${C.gray(`(${p.label})`)}` : ''}`);
      }
      if (c.conferenceId) console.log(`  ${C.gray('Phone conference ID:')} ${c.conferenceId}`);
    } else if (c.joinUrl || c.meetingId) {
      console.log(`  ${C.gray('Dial-in:')} ${C.gray('none in invite (no PSTN number)')}`);
    }
  }

  if (d.body) {
    console.log(`\n${C.bold('Invite')}`);
    console.log(d.body);
  }
}

async function cmdEvent() {
  const token = await getToken();
  const id = positional[0];
  if (!id) die('outlook event: provide a calendar event ID (see `outlook calendar --json`)');
  const tz = await getTimezone(token);

  try {
    let ev = await fetchEvent(token, id, tz);
    // --series shows the whole series instead of this single occurrence.
    if ((flags.series === true || flags.series === 'true') && ev.SeriesMasterId) {
      ev = await fetchEvent(token, ev.SeriesMasterId, tz);
    }
    const details = eventDetails(ev, tz);
    if (flags.json === true || flags.json === 'true') {
      out(details);
      return;
    }
    printEventDetails(details);
  } catch (e) {
    die(`outlook: event failed: ${e.message}`);
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
    // Calendar event ids live in a different store, so /me/messages/<eventId>
    // answers a bare 404 ("The specified object was not found in the store.").
    // Probe the event store and point at the right command instead.
    if (/404/.test(e.message || '') && (await looksLikeEvent(token, id))) {
      die(`outlook view: that ID is a calendar event, not a message — use: outlook event ${id}`);
    }
    die(`outlook: view failed: ${e.message}`);
  }
}

async function looksLikeEvent(token, id) {
  try {
    const ev = await owaGet(token, `/me/events/${encodeURIComponent(id)}`, { '$select': 'Id' });
    return !!(ev && ev.Id);
  } catch {
    return false;
  }
}

// ─── Attachment Commands ─────────────────────────────────────────────────────

// Standard base64 (OWA ContentBytes) → raw bytes (Uint8Array).
function decodeBase64Bytes(b64) {
  if (!b64) return new Uint8Array(0);
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function cmdAttachments() {
  const token = await getToken();
  const id = positional[0];
  if (!id) die('outlook attachments: provide a message ID');
  try {
    const res = await owaGet(token, `/me/messages/${encodeURIComponent(id)}/attachments`, {
      '$select': 'Id,Name,ContentType,Size',
    });
    const atts = (res.value || []).map(a => ({ id: a.Id, name: a.Name, contentType: a.ContentType, size: a.Size }));
    if (flags.json === true || flags.json === 'true') { out(atts); return; }
    if (!atts.length) { console.log(C.gray('(no attachments)')); return; }
    console.log(`${C.bold('Attachments')} — ${atts.length}\n`);
    for (const a of atts) {
      console.log(`  ${C.cyan(a.name)}  ${C.gray(a.contentType)}  ${C.gray((a.size || 0) + ' bytes')}`);
      console.log(`    ${C.gray('id:')} ${a.id}`);
    }
  } catch (e) {
    die(`outlook: attachments failed: ${e.message}`);
  }
}

async function cmdDownload() {
  const token = await getToken();
  const id = positional[0];
  if (!id) die('outlook download: usage: outlook download <messageId> [attachmentId] --out=<path>');
  const outPath = flags.out || flags.o;
  if (!outPath) die('outlook download: --out=<path> required (file path for one attachment, or dir for all)');
  try {
    // Fetch attachments with ContentBytes (fileAttachment payloads).
    const res = await owaGet(token, `/me/messages/${encodeURIComponent(id)}/attachments`);
    let atts = res.value || [];
    if (!atts.length) die('outlook download: message has no attachments');
    const explicitId = positional[1];
    let asDir;
    if (explicitId) {
      atts = atts.filter(a => a.Id === explicitId);
      if (!atts.length) die('outlook download: attachmentId not found on message');
      asDir = /\/$/.test(outPath);
    } else {
      asDir = true;
    }
    const written = [];
    for (const a of atts) {
      if (!a.ContentBytes) continue; // skip item/reference attachments
      const bytes = decodeBase64Bytes(a.ContentBytes);
      const p = asDir ? `${outPath.replace(/\/$/, '')}/${a.Name}` : outPath;
      await fs.writeFileBinary(p, bytes);
      written.push({ name: a.Name, path: p, bytes: bytes.length });
    }
    if (flags.json === true || flags.json === 'true') { console.log(JSON.stringify(written, null, 2)); return; }
    for (const w of written) console.log(`${C.green('✓')} ${w.name} → ${w.path} (${w.bytes} bytes)`);
  } catch (e) {
    die(`outlook: download failed: ${e.message}`);
  }
}

// ─── Calendar Response Commands ──────────────────────────────────────────────

const RESPOND_LABELS = {
  accept: { progressive: 'Accepting', past: 'Accepted' },
  decline: { progressive: 'Declining', past: 'Declined' },
  tentativelyAccept: { progressive: 'Tentatively accepting', past: 'Tentative' },
};

// Resolve an occurrence/exception id to its series master so a single response
// covers the whole series. SeriesMaster ids pass through; single instances warn
// and are left alone.
async function resolveSeriesId(token, id) {
  const ev = await owaGet(token, `/me/events/${encodeURIComponent(id)}`, {
    '$select': 'Id,Type,SeriesMasterId,Subject',
  });
  if (ev.SeriesMasterId) return { id: ev.SeriesMasterId, type: ev.Type, subject: ev.Subject, resolved: true };
  return { id: ev.Id || id, type: ev.Type, subject: ev.Subject, resolved: false };
}

async function cmdRespond(action) {
  const token = await getToken();
  const comment = flags.comment || flags.message || '';
  const silent = flags.silent === true || flags.silent === 'true';
  const series = flags.series === true || flags.series === 'true';
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true' || flags.dryRun === true;
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

  if (series) {
    const resolved = [];
    for (const id of eventIds) {
      try {
        const master = await resolveSeriesId(token, id);
        if (master.resolved) {
          console.log(`  ${C.gray('↳ series master for')} ${master.subject || id.slice(0, 20) + '...'}`);
        } else {
          console.log(
            `  ${C.yellow('⚠')} ${master.subject || id.slice(0, 20) + '...'} is ${master.type || 'not part of a series'} — responding to the single event`
          );
        }
        if (!resolved.includes(master.id)) resolved.push(master.id);
        if (master.subject) subjectsById.set(master.id, master.subject);
      } catch (e) {
        console.log(`  ${C.red('✗')} Could not resolve series for ${id.slice(0, 20)}...: ${e.message}`);
      }
    }
    if (resolved.length === 0) die(`outlook ${action}: no event IDs left after --series resolution`);
    eventIds = resolved;
  }

  if (dryRun) {
    console.log(`${C.bold('Dry run')} — would ${action} ${eventIds.length} event(s), no response sent:\n`);
    for (const id of eventIds) {
      console.log(`  ${subjectsById.get(id) || '(subject unknown)'}`);
      console.log(`    ${C.gray('id:')} ${id}`);
    }
    return;
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
  event      Show one calendar event in full (invite body + join info)
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
  --details          Full details (invite body + join info) for every event
  --timezone TZ      Windows timezone name for displayed times
                     (default: mailbox timezone from MailboxSettings)
  --json             Output raw JSON

Event options:
  outlook event <event-id>   Invite body, parsed Teams/VTC join info, type,
                             series master id, recurrence summary
  --series           Show the series master instead of this occurrence
  --timezone TZ      Windows timezone name for displayed times
  --json             Structured JSON (includes parsed join info)

Respond options (accept/decline/tentative):
  outlook accept <event-id> [<event-id>...]
  outlook decline <event-id> --comment "Can't make it"
  outlook accept --all              Accept all pending events
  outlook decline --all --date 7d   Decline all pending in next week
  --comment TEXT    Optional message to organizer
  --silent          Don't send response to organizer
  --all             Act on all NotResponded events in date range
  --date PERIOD     With --all, calendar window to scan (default: 2d)
  --series          Resolve occurrence IDs to their series master and respond
                    to the whole series
  --dry-run         Print the events that would be responded to, send nothing

Send options:
  --to EMAIL         Recipient(s), comma-separated
  --subject TEXT     Email subject
  --body TEXT        Email body

View:
  outlook view <message-id>    Mail only — for calendar events use: outlook event

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
    case 'event':
      await cmdEvent();
      break;
    case 'attachments':
      await cmdAttachments();
      break;
    case 'download':
      await cmdDownload();
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
