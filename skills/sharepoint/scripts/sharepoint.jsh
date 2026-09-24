// sharepoint.jsh — Microsoft SharePoint CLI for SLICC agents (read-only)
// Uses MSAL tokens from an open Microsoft 365 browser tab, same extraction
// strategy as the `outlook` skill's outlook.jsh, retargeted at the Graph API
// (graph.microsoft.com) instead of the Outlook REST API.
//
// Usage: sharepoint <command> [args] [--flags]
//
// Commands:
//   sites        Search sites by name
//   site         Resolve a SharePoint URL to a site id
//   drives       List document libraries on a site
//   files        List files/folders in a library
//   read         Read a file's content as text
//   download     Download a file to the VFS
//   search       Search files/pages/list items
//   lists        List SharePoint lists on a site
//   list-items   List items in a SharePoint list

const browser = require('sliccy:browser');
const C = require('sliccy:color');
const fs = require('fs');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_PATH = '/shared/.sharepoint-token';
// Any of these tabs can carry an MSAL token whose audience includes
// graph.microsoft.com — SharePoint and the M365 app launcher mint one
// directly, and an open Outlook tab's token frequently does too (same tenant,
// overlapping scope grant), so it's included as a fallback discovery target.
//
// `browser.findTab({ domain })` matches the tab's hostname EXACTLY — it does
// NOT do suffix/substring matching. That's fine for fixed hosts like
// outlook.office.com, but every SharePoint tenant has a different hostname
// (<tenant>.sharepoint.com), so a literal 'sharepoint.com' entry here never
// matches a real tab. Use `urlMatch` (regex) for the wildcard SharePoint case
// instead, and exact `domain` for the fixed Microsoft hosts.
const M365_EXACT_DOMAINS = [
  'outlook.office.com',
  'outlook.cloud.microsoft',
  'myapps.microsoft.com',
  'office.com',
];
const SHAREPOINT_URL_MATCH = /(^https:\/\/[^/]+\.sharepoint\.com)|(^https:\/\/[^/]+\.sharepoint-df\.com)/i;

// ─── Argument parsing ─────────────────────────────────────────────────────────

const { positional: _allPositional, flags } = process.argv.parseFlags();
const subcommand = _allPositional[0] || '';
const positional = _allPositional.slice(1);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtBytes(n) {
  if (n == null) return '';
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = num;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Browser tab discovery ────────────────────────────────────────────────────

let _tabId = null;

async function findM365Tab() {
  if (_tabId) return _tabId;
  // Wildcard SharePoint tenant hostname first — this is the common case for
  // this skill.
  const spTab = await browser.findTab({ urlMatch: SHAREPOINT_URL_MATCH });
  if (spTab) {
    _tabId = spTab;
    return _tabId;
  }
  for (const domain of M365_EXACT_DOMAINS) {
    const tab = await browser.findTab({ domain });
    if (tab) {
      _tabId = tab;
      return _tabId;
    }
  }
  return null;
}

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
  if (raw && raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw;
}

// ─── Token extraction (mirrors outlook.jsh's two-strategy approach) ──────────
// Strategy 1: legacy plaintext MSAL cache — read localStorage entries whose key
// mentions an accesstoken and whose target/resource includes graph.microsoft.com.
// Strategy 2: encrypted-cache clients — hook fetch/XHR and capture a live
// Authorization header whose decoded JWT `aud` targets graph.microsoft.com.

async function extractTokenFromCache(tabId) {
  const extractScript = [
    '(function(){',
    'var best=null,bestScopes=0;',
    'var keys=Object.keys(localStorage);',
    'for(var i=0;i<keys.length;i++){',
    'var k=keys[i];',
    'if(k.indexOf("accesstoken")===-1)continue;',
    'if(k.indexOf("graph.microsoft.com")===-1)continue;',
    'try{var e=JSON.parse(localStorage.getItem(k));',
    'if(!e||!e.secret)continue;',
    'var scopes=(e.target||"").split(" ").length;',
    'var exp=parseInt(e.expiresOn||0);',
    'if(exp*1000<Date.now())continue;',
    'if(scopes>bestScopes){best=e;bestScopes=scopes;}}catch(x){}}',
    'if(best)return JSON.stringify({secret:best.secret});',
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

const TOKEN_EXP_SAFETY_MARGIN_MS = 60 * 1000;

// A Graph-audience token can still lack Sites/Files scopes (e.g. a
// Mail.Read-only token from Outlook that happens to be minted against
// `.default` for the same tenant). A token with no `scp` claim is still
// accepted — nothing to judge it by — mirroring outlook.jsh's own gate.
const SITE_SCOPE_RES = [
  /^sites\./i,
  /^files\./i,
  /(?:^|\/)\.default$/i,
];

function hasSiteScope(claims) {
  const scp = claims && claims.scp;
  if (!scp) return true;
  return String(scp)
    .split(/\s+/)
    .filter(Boolean)
    .some((scope) => SITE_SCOPE_RES.some((re) => re.test(scope)));
}

function isFreshBearerCandidate(candidate) {
  if (!candidate || candidate.split('.').length !== 3) return false;
  const claims = decodeJwtPayload(candidate);
  if (!claims) return false;
  if (!claims.aud || String(claims.aud).indexOf('graph.microsoft.com') === -1) return false;
  if (!hasSiteScope(claims)) return false;
  if (!claims.exp) return false;
  return claims.exp * 1000 > Date.now() + TOKEN_EXP_SAFETY_MARGIN_MS;
}

// Strategy 2 — CDP-level network capture, NOT an in-page fetch/XHR hook.
//
// An in-page hook (patch window.fetch / XMLHttpRequest.prototype and read
// back a page-global) was the first approach tried here, mirroring
// outlook.jsh's own strategy 2. It does not port over: Outlook's SPA fires a
// Calendar<->Mail nav click reliably into an authenticated fetch every time,
// but SharePoint's classic UI talks to its OWN `_api/web/...` REST surface
// for most navigation (cookie/SPO-context auth, no bearer JWT at all) and
// only touches `graph.microsoft.com` for specific panels (Build, OneDrive,
// search-as-you-type). Empirically, clicking the SAME nav item twice often do
// NOT re-trigger a Graph call once the SPA has cached that panel's data
// client-side, and a `location.reload()` wipes the injected hook before the
// reload's own fetches happen (reinstalling after the fact misses them
// entirely) — so the in-page hook produced a token on maybe one try in three.
//
// The fix: capture at the CDP layer via `playwright-cli requests` /
// `request-headers`, which observes network traffic regardless of in-page JS
// state. This still needs SOMETHING to trigger a fresh authenticated Graph
// call, and here SharePoint diverges from Outlook in a way that matters:
//
// - The classic SharePoint site UI (the page the user actually has open)
//   talks almost entirely to its own `_api/web/...` REST surface —
//   cookie/SPO-context authenticated, no bearer JWT at all — and only
//   touches `graph.microsoft.com` incidentally, from specific panels
//   (search-box telemetry, the Build/OneDrive shell chrome) that fire
//   unpredictably. An early prototype of this function clicked through the
//   page's own nav elements by aria-label to force one of those panels open.
//   That is NOT safe to ship: it visibly navigates whatever tab it targets
//   (confirmed empirically — clicking "Build" sent a live user's own
//   SharePoint tab into the tenant's admin "Build" panel), which is an
//   unacceptable side effect for what must be a transparent, read-only auth
//   step. Never resurrect a click-based nudge against the user's own tab.
// - The SharePoint "shell" pages under `/_layouts/15/sharepoint.aspx/*`
//   (Build, admin panels, etc.) DO reliably call
//   `GET https://graph.microsoft.com/v1.0/me?...` once on load, as part of
//   their own boot sequence — confirmed empirically, deterministic across
//   repeated navigations to that URL.
//
// So: open a DEDICATED scratch tab (tiny, unfocused, via `browser.openWindow`)
// on `https://<tenant-hostname>/_layouts/15/sharepoint.aspx/build` — same
// tenant hostname as whatever tab findM365Tab() actually found, so the MSAL
// session cookie applies — let its boot sequence mint the Graph call, capture
// the token from THAT tab's own request log, then close it. The user's own
// tab is never touched: no eval, no clicks, no navigation.
async function captureTokenFromNetwork(tabId) {
  const exec = require('sliccy:exec');

  const currentUrl = await evalInTab(tabId, 'location.href');
  let hostname;
  try {
    hostname = new URL(unwrapEvalString(currentUrl) || '').hostname;
  } catch {
    return null; // can't determine the tenant hostname — nothing safe to do
  }
  if (!hostname) return null;

  const scratch = await browser.openWindow(`https://${hostname}/_layouts/15/sharepoint.aspx/build`, {
    focus: false,
    width: 100,
    height: 100,
  });
  const scratchId = scratch.targetId || scratch;

  let token = null;
  try {
    for (let i = 0; i < 10; i++) {
      await sleep(700);
      const listRes = await exec(`playwright-cli requests --tab=${scratchId} --filter="graph.microsoft.com"`);
      const lines = (listRes.stdout || '').trim().split('\n').filter(Boolean);
      if (!lines.length) continue;
      for (let j = lines.length - 1; j >= 0; j--) {
        const m = lines[j].match(/^(\d+)\s/);
        if (!m) continue;
        const headersRes = await exec(`playwright-cli request-headers --tab=${scratchId} ${m[1]}`);
        const authLine = (headersRes.stdout || '').split('\n').find((l) => /^authorization:/i.test(l));
        if (!authLine) continue;
        const candidate = authLine.replace(/^authorization:\s*bearer\s*/i, '').trim();
        if (isFreshBearerCandidate(candidate)) {
          token = candidate;
          break;
        }
      }
      if (token) break;
    }
  } finally {
    // Always close the scratch tab, even if capture failed or threw — it
    // must never linger as a leaked window in the user's browser.
    try {
      await exec(`playwright-cli tab-close --tab=${scratchId}`);
    } catch { /* tab may already be gone */ }
  }

  return token;
}

async function extractTokenFromBrowser() {
  const tabId = await findM365Tab();
  if (!tabId) return null;

  const cached = await extractTokenFromCache(tabId);
  if (cached) {
    await fs.writeFile(TOKEN_PATH, cached);
    return cached;
  }

  const captured = await captureTokenFromNetwork(tabId);
  if (captured) {
    await fs.writeFile(TOKEN_PATH, captured);
    return captured;
  }

  return null;
}

async function getToken() {
  const browserToken = await extractTokenFromBrowser();
  if (browserToken) return browserToken;

  try {
    const saved = (await fs.readFile(TOKEN_PATH)).trim();
    if (saved && isFreshBearerCandidate(saved)) return saved;
  } catch { /* no file */ }

  die(
    'Could not extract a SharePoint/Graph token. Open a SharePoint site (e.g. ' +
    'https://<tenant>.sharepoint.com) or https://outlook.office.com in your ' +
    'browser and try again. If a tab is open and this still fails, the ' +
    'signed-in token may lack Sites.Read.All/Files.Read.All — check with your ' +
    'tenant admin.'
  );
}

// ─── API client (auth-retry mirrors outlook.jsh's withAuthRetry) ─────────────

const AUTH_RETRY_STATUSES = [401, 403];
const _rejectedTokens = new Set();
let _refreshedToken = null;

function effectiveToken(token) {
  return _refreshedToken && _rejectedTokens.has(token) ? _refreshedToken : token;
}

async function reacquireToken(badToken) {
  if (badToken) {
    _rejectedTokens.add(badToken);
    try {
      if ((await fs.readFile(TOKEN_PATH)).trim() === badToken) {
        await fs.writeFile(TOKEN_PATH, '');
      }
    } catch { /* no cache file, or not writable */ }
  }
  let fresh = null;
  try {
    fresh = await extractTokenFromBrowser();
  } catch { /* no usable tab */ }
  if (!fresh || _rejectedTokens.has(fresh)) return null;
  _refreshedToken = fresh;
  return fresh;
}

async function httpError(res) {
  const body = await res.text();
  let msg = body;
  let code = null;
  try {
    const parsed = JSON.parse(body);
    msg = parsed.error?.message || body;
    code = parsed.error?.code || null;
  } catch { /* non-JSON error body */ }
  if (!String(msg).trim()) msg = res.statusText || 'request failed';
  const err = new Error(`HTTP ${res.status}: ${msg}`);
  err.status = res.status;
  err.code = code;
  return err;
}

async function withAuthRetry(token, attempt) {
  const first = effectiveToken(token);
  let res = await attempt(first);
  if (!res.ok && AUTH_RETRY_STATUSES.includes(res.status)) {
    const fresh = await reacquireToken(first);
    if (fresh) {
      try { await res.text(); } catch { /* drain discarded body */ }
      res = await attempt(fresh);
    }
  }
  return res;
}

async function graphGet(token, path, params) {
  let url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await withAuthRetry(token, (bearer) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'application/json',
      },
    })
  );
  if (!res.ok) throw await httpError(res);
  return res.json();
}

// Raw bytes — used by `download` and non-JSON `read` content fetches.
async function graphGetBinary(token, path) {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const res = await withAuthRetry(token, (bearer) =>
    fetch(url, { headers: { Authorization: `Bearer ${bearer}` } })
  );
  if (!res.ok) throw await httpError(res);
  return res;
}

async function graphPost(token, path, body) {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const res = await withAuthRetry(token, (bearer) =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  );
  if (!res.ok) throw await httpError(res);
  return res.json();
}

// ─── URL parsing ──────────────────────────────────────────────────────────────
// https://contoso.sharepoint.com/sites/Marketing → hostname + server-relative
// path, used with Graph's /sites/{hostname}:{server-relative-path} shorthand.
function parseSiteUrl(input) {
  let s = String(input).trim();
  if (!/^https?:\/\//i.test(s) && s.includes(':')) {
    // already in "hostname:/path" form
    const [hostname, ...rest] = s.split(':');
    return { hostname, path: rest.join(':') || '' };
  }
  try {
    const u = new URL(s);
    return { hostname: u.hostname, path: u.pathname.replace(/\/$/, '') };
  } catch {
    die(`Could not parse SharePoint URL: ${input}`);
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdSites() {
  const token = await getToken();
  const query = flags.search;
  if (!query) die('sharepoint sites requires --search "<query>"');
  const data = await graphGet(token, '/sites', { search: query });
  const sites = data.value || [];
  if (flags.json) return out(sites);
  if (!sites.length) {
    console.log('No matching sites.');
    return;
  }
  for (const s of sites) {
    console.log(`${C.bold(s.displayName || s.name || '(unnamed)')}  ${C.dim(s.id)}`);
    console.log(`  ${s.webUrl || ''}`);
  }
}

async function cmdSite() {
  const token = await getToken();
  const input = positional[0];
  if (!input) die('sharepoint site requires a URL, e.g. https://contoso.sharepoint.com/sites/Marketing');
  const { hostname, path } = parseSiteUrl(input);
  const graphPath = path ? `/sites/${hostname}:${path}` : `/sites/${hostname}`;
  const site = await graphGet(token, graphPath);
  if (flags.json) return out(site);
  console.log(`${C.bold(site.displayName || site.name)}`);
  console.log(`id:     ${site.id}`);
  console.log(`webUrl: ${site.webUrl}`);
}

async function cmdDrives() {
  const token = await getToken();
  const siteId = positional[0];
  if (!siteId) die('sharepoint drives requires a site id (see: sharepoint site <url>)');
  const data = await graphGet(token, `/sites/${siteId}/drives`);
  const drives = data.value || [];
  if (flags.json) return out(drives);
  if (!drives.length) {
    console.log('No document libraries on this site.');
    return;
  }
  for (const d of drives) {
    const used = d.quota ? fmtBytes(d.quota.used) : '';
    console.log(`${C.bold(d.name)}  ${C.dim(d.id)}${used ? `  (${used} used)` : ''}`);
    console.log(`  ${d.webUrl || ''}`);
  }
}

async function resolveItemByPath(token, siteId, driveId, itemPath) {
  const encoded = itemPath.split('/').map(encodeURIComponent).join('/');
  const item = await graphGet(token, `/sites/${siteId}/drives/${driveId}/root:/${encoded}`);
  return item.id;
}

async function cmdFiles() {
  const token = await getToken();
  const siteId = positional[0];
  if (!siteId) die('sharepoint files requires a site id');
  const driveId = flags.drive;
  if (!driveId) die('sharepoint files requires --drive <drive-id> (see: sharepoint drives <site-id>)');

  let basePath;
  if (flags.item) {
    basePath = `/sites/${siteId}/drives/${driveId}/items/${flags.item}/children`;
  } else if (flags.path) {
    const encoded = String(flags.path).split('/').map(encodeURIComponent).join('/');
    basePath = `/sites/${siteId}/drives/${driveId}/root:/${encoded}:/children`;
  } else {
    basePath = `/sites/${siteId}/drives/${driveId}/root/children`;
  }

  const results = [];
  const MAX_ITEMS = 5000;

  async function walk(path, prefix) {
    if (results.length >= MAX_ITEMS) return;
    const data = await graphGet(token, path, { $top: 200 });
    for (const item of data.value || []) {
      const isFolder = !!item.folder;
      results.push({
        name: prefix ? `${prefix}/${item.name}` : item.name,
        id: item.id,
        type: isFolder ? 'folder' : 'file',
        size: item.size,
        lastModifiedDateTime: item.lastModifiedDateTime,
        webUrl: item.webUrl,
      });
      if (flags.recursive && isFolder && results.length < MAX_ITEMS) {
        await walk(`/sites/${siteId}/drives/${driveId}/items/${item.id}/children`, results[results.length - 1].name);
      }
    }
  }

  await walk(basePath, '');

  if (results.length >= MAX_ITEMS) {
    console.error(`(stopped after ${MAX_ITEMS} items — narrow with --path or drop --recursive)`);
  }

  if (flags.json) return out(results);
  if (!results.length) {
    console.log('No files/folders found.');
    return;
  }
  for (const r of results) {
    const marker = r.type === 'folder' ? C.dim('[dir] ') : '      ';
    const size = r.type === 'folder' ? '' : fmtBytes(r.size);
    console.log(`${marker}${r.name}  ${C.dim(r.id)}${size ? `  ${size}` : ''}`);
  }
}

const TEXT_EXTS = ['.txt', '.md', '.csv', '.json', '.html', '.htm'];
const OFFICE_PREVIEW_EXTS = ['.docx', '.pptx', '.pdf'];

async function cmdRead() {
  const token = await getToken();
  const siteId = positional[0];
  if (!siteId) die('sharepoint read requires a site id');
  const driveId = flags.drive;
  if (!driveId) die('sharepoint read requires --drive <drive-id>');

  let itemId = flags.item;
  if (!itemId && flags.path) {
    itemId = await resolveItemByPath(token, siteId, driveId, String(flags.path));
  }
  if (!itemId) die('sharepoint read requires --item <item-id> or --path "<path>"');

  const meta = await graphGet(token, `/sites/${siteId}/drives/${driveId}/items/${itemId}`);
  const name = meta.name || '';
  const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();

  if (ext === '.xlsx') {
    const sheetName = flags.sheet;
    let worksheet = sheetName;
    if (!worksheet) {
      const sheets = await graphGet(token, `/sites/${siteId}/drives/${driveId}/items/${itemId}/workbook/worksheets`);
      worksheet = (sheets.value && sheets.value[0] && sheets.value[0].name) || 'Sheet1';
    }
    const range = await graphGet(
      token,
      `/sites/${siteId}/drives/${driveId}/items/${itemId}/workbook/worksheets/${encodeURIComponent(worksheet)}/usedRange`
    );
    if (flags.json) return out(range.values || []);
    for (const row of range.values || []) {
      console.log(row.map((c) => trunc(c, 30)).join('  |  '));
    }
    return;
  }

  if (TEXT_EXTS.includes(ext)) {
    const res = await graphGetBinary(token, `/sites/${siteId}/drives/${driveId}/items/${itemId}/content`);
    const text = await res.text();
    if (flags.json) return out({ name, text });
    console.log(text);
    return;
  }

  if (OFFICE_PREVIEW_EXTS.includes(ext)) {
    try {
      const res = await graphGetBinary(
        token,
        `/sites/${siteId}/drives/${driveId}/items/${itemId}/content?format=text`
      );
      const text = await res.text();
      if (flags.json) return out({ name, text });
      console.log(text);
    } catch (e) {
      die(
        `Could not get a text preview of "${name}" (${e.message}). This tenant may have ` +
        `format conversion disabled. Use: sharepoint download <site-id> --drive ${driveId} ` +
        `--item ${itemId} --out /workspace/${name}`
      );
    }
    return;
  }

  die(
    `"${name}" is not a text-convertible format (detected: ${ext || 'unknown'}). ` +
    `Use: sharepoint download <site-id> --drive ${driveId} --item ${itemId} --out /workspace/${name}`
  );
}

async function cmdDownload() {
  const token = await getToken();
  const siteId = positional[0];
  if (!siteId) die('sharepoint download requires a site id');
  const driveId = flags.drive;
  if (!driveId) die('sharepoint download requires --drive <drive-id>');
  const outPath = flags.out;
  if (!outPath) die('sharepoint download requires --out <vfs-path>');

  let itemId = flags.item;
  if (!itemId && flags.path) {
    itemId = await resolveItemByPath(token, siteId, driveId, String(flags.path));
  }
  if (!itemId) die('sharepoint download requires --item <item-id> or --path "<path>"');

  const res = await graphGetBinary(token, `/sites/${siteId}/drives/${driveId}/items/${itemId}/content`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFileBinary(outPath, buf);
  console.log(`Downloaded ${fmtBytes(buf.length)} to ${outPath}`);
}

async function cmdSearch() {
  const token = await getToken();
  const query = positional[0];
  if (!query) die('sharepoint search requires a query string');
  const entities = flags.entity
    ? [].concat(flags.entity)
    : ['driveItem', 'listItem', 'site'];
  const limit = positiveInt(flags.limit, 25);

  const request = {
    entityTypes: entities,
    query: { queryString: query },
    from: 0,
    size: limit,
  };
  if (flags.site) {
    // Graph search scoping by site works via a queryString region filter on
    // driveItem/listItem entities; sites are matched separately.
    request.query.queryString = `${query} path:"${flags.site}"`;
  }

  const data = await graphPost(token, '/search/query', { requests: [request] });
  const hits = (data.value && data.value[0] && data.value[0].hitsContainers && data.value[0].hitsContainers[0] && data.value[0].hitsContainers[0].hits) || [];

  if (flags.json) return out(hits);
  if (!hits.length) {
    console.log('No results.');
    return;
  }
  for (const h of hits) {
    const r = h.resource || {};
    const title = r.name || r.title || r.displayName || '(untitled)';
    console.log(`${C.bold(title)}`);
    if (r.webUrl) console.log(`  ${r.webUrl}`);
    if (h.summary) console.log(`  ${C.dim(trunc(h.summary, 160))}`);
  }
}

async function cmdLists() {
  const token = await getToken();
  const siteId = positional[0];
  if (!siteId) die('sharepoint lists requires a site id');
  const data = await graphGet(token, `/sites/${siteId}/lists`);
  const lists = data.value || [];
  if (flags.json) return out(lists);
  if (!lists.length) {
    console.log('No lists on this site.');
    return;
  }
  for (const l of lists) {
    console.log(`${C.bold(l.displayName)}  ${C.dim(l.id)}`);
  }
}

async function cmdListItems() {
  const token = await getToken();
  const siteId = positional[0];
  if (!siteId) die('sharepoint list-items requires a site id');
  const listId = flags.list;
  if (!listId) die('sharepoint list-items requires --list <list-id>');
  const limit = positiveInt(flags.limit, 50);

  const data = await graphGet(token, `/sites/${siteId}/lists/${listId}/items`, {
    expand: 'fields',
    $top: limit,
  });
  const items = data.value || [];
  if (flags.json) return out(items.map((i) => i.fields || {}));
  if (!items.length) {
    console.log('No items in this list.');
    return;
  }
  for (const item of items) {
    const f = item.fields || {};
    const title = f.Title || f.LinkTitle || item.id;
    const rest = Object.entries(f)
      .filter(([k]) => !['Title', 'LinkTitle', '@odata.etag', 'id'].includes(k))
      .slice(0, 4)
      .map(([k, v]) => `${k}=${trunc(v, 24)}`)
      .join('  ');
    console.log(`${C.bold(String(title))}  ${C.dim(item.id)}`);
    if (rest) console.log(`  ${rest}`);
  }
}

function showHelp() {
  console.log(`
sharepoint — read-only Microsoft SharePoint CLI (via Microsoft Graph)

Usage: sharepoint <command> [args] [--flags]

Commands:
  sites --search <query>            Search sites by name
  site <url>                        Resolve a URL to a site id
  drives <site-id>                  List document libraries on a site
  files <site-id> --drive <id>      List files/folders in a library
  read <site-id> --drive <id>       Read a file as text
  download <site-id> --drive <id>   Download a file to the VFS
  search <query>                    Search files/pages/list items
  lists <site-id>                   List SharePoint lists on a site
  list-items <site-id> --list <id>  List items in a SharePoint list

Full reference: references/COMMANDS.md in this skill folder.

Authentication:
  Token is extracted automatically from an open SharePoint/Outlook/M365
  browser tab (MSAL). Falls back to /shared/.sharepoint-token.
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  switch (subcommand) {
    case 'sites':
      await cmdSites();
      break;
    case 'site':
      await cmdSite();
      break;
    case 'drives':
      await cmdDrives();
      break;
    case 'files':
      await cmdFiles();
      break;
    case 'read':
      await cmdRead();
      break;
    case 'download':
      await cmdDownload();
      break;
    case 'search':
      await cmdSearch();
      break;
    case 'lists':
      await cmdLists();
      break;
    case 'list-items':
      await cmdListItems();
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
  console.error(`sharepoint: ${e.message}`);
  process.exit(1);
}
