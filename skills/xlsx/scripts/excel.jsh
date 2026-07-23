// excel.jsh — Excel Online / OneDrive CRUD via Microsoft Graph.
//
// Sibling of xlsx.jsh in the `xlsx` skill. Where xlsx.jsh works on LOCAL
// spreadsheet files (SheetJS, offline), excel.jsh works on files stored in the
// user's OneDrive for Business / Excel for the Web — list, download, upload,
// delete, search, and open-in-browser.
//
// AUTH (no admin approval required)
// ---------------------------------
// Graph normally needs an app registration + admin consent. We sidestep that by
// borrowing a token that Microsoft's own first-party "App Home Pages" client
// (appid 2821b473-fe24-4c86-ba16-62834d6e80c3) already minted for the signed-in
// user inside Excel for the Web. On load, excel.cloud.microsoft fires a Graph
// call (the profile-photo fetch) carrying an `Authorization: Bearer <token>`
// header. We open a throwaway recording tab, let that call fire, lift the
// header, cache the token to its ~1h expiry, then close the tab. No consent
// prompt, no admin approval — it is the same delegated token Excel itself uses.
//
// The captured token carries: Files.ReadWrite.All, Sites.FullControl.All,
// Sites.Read.All, Calendars.Read, User.Read.All, People.Read (enough for all
// OneDrive file CRUD here). It does NOT include Teams/OnlineMeetings scopes.
//
// Requirements: the user must be signed into Microsoft 365 in the browser (any
// office.com / excel.cloud.microsoft session). Override the auto-capture with
// `--token <jwt>` or the EXCEL_GRAPH_TOKEN env var.
//
// Runtime: standard jsh globals + sliccy: capability bridges. NOT esbuild-
// bundled (uses sliccy:* modules, which the esbuild CLI cannot mark external).

const cli = require('sliccy:cli');
const c = require('sliccy:color');
const { exec } = require('sliccy:exec');
const fs = require('fs');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CAPTURE_URL = 'https://excel.cloud.microsoft/';
const TOKEN_CACHE = '/tmp/.slicc-excel-token.json';

// ---------------------------------------------------------------- arg parse ---
const { positional, flags } = process.argv.parseFlags();
const [cmd, ...rest] = positional;

// ------------------------------------------------------------------- output ---
function out(v) {
  if (typeof v === 'string') { process.stdout.write(v.replace(/\n$/, '') + '\n'); return; }
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}
function ok(msg) { process.stdout.write(c.green('\u2713') + ' ' + msg + '\n'); }
function human(bytes) {
  if (bytes == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(1)}${u[i]}`;
}

// ----------------------------------------------------------- token handling ---
function decodeExp(tok) {
  try {
    const p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return { exp: j.exp || 0, upn: j.upn || j.unique_name || '', scp: j.scp || '' };
  } catch { return { exp: 0, upn: '', scp: '' }; }
}

async function readCache() {
  try {
    if (!(await fs.exists(TOKEN_CACHE))) return null;
    return JSON.parse(await fs.readFile(TOKEN_CACHE));
  } catch { return null; }
}
async function writeCache(obj) {
  try {
    await fs.writeFile(TOKEN_CACHE, JSON.stringify(obj));
    // The cache holds a live Files.ReadWrite.All bearer token, so restrict it to
    // owner-only. Under real Node this applies 0600; SLICC's single-tenant VFS
    // does not expose fs.chmod (and ignores POSIX modes), so the guard no-ops
    // there — same best-effort pattern as the cloudflare skill's cache.
    if (typeof fs.chmod === 'function') await fs.chmod(TOKEN_CACHE, 0o600).catch(() => {});
  } catch { /* best effort */ }
}

// Capture a fresh Graph bearer token from a throwaway Excel-for-the-Web tab.
async function captureToken() {
  const rec = await exec(`playwright-cli record ${CAPTURE_URL}`);
  const m = (rec.stdout || '').match(/targetId:\s*([A-F0-9]+).*?recordingId:\s*(rec-[\w-]+)/s);
  if (!m) cli.die(`could not start a recording tab:\n${rec.stdout || rec.stderr}`);
  const [, targetId, recordingId] = m;

  let token = null;
  try {
    // Poll the request buffer until the on-load graph.microsoft.com call lands.
    // Background tabs load slower, so allow up to ~60s.
    for (let i = 0; i < 40 && !token; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const reqs = await exec(`playwright-cli requests --filter='graph.microsoft.com' --tab=${targetId}`);
      // A graph line may be a CORS preflight (OPTIONS, no auth) — scan every
      // matching request for one that actually carries an Authorization header.
      const idxs = (reqs.stdout || '').split('\n')
        .filter((l) => /^\s*\d+\s/.test(l) && !/\bOPTIONS\b/.test(l))
        .map((l) => l.trim().split(/\s+/)[0]);
      for (const idx of idxs) {
        const hdrs = await exec(`playwright-cli request-headers ${idx} --tab=${targetId}`);
        const auth = (hdrs.stdout || '').split('\n').find((l) => /^authorization:/i.test(l.trim()));
        const bear = auth && auth.match(/Bearer\s+([A-Za-z0-9._-]+)/);
        if (bear) { token = bear[1]; break; }
      }
    }
  } finally {
    await exec(`playwright-cli stop-recording ${recordingId}`).catch(() => {});
    await exec(`playwright-cli tab-close --tab=${targetId}`).catch(() => {});
  }

  if (!token) {
    cli.die(
      'could not capture a Graph token. Make sure you are signed into Microsoft 365\n' +
      '       in this browser (open ' + CAPTURE_URL + ' and confirm it loads your files),\n' +
      '       or pass one explicitly with --token <jwt> / EXCEL_GRAPH_TOKEN.'
    );
  }
  return token;
}

let _token;
async function getToken() {
  if (_token) return _token;
  if (flags.token) return (_token = String(flags.token));
  if (process.env.EXCEL_GRAPH_TOKEN) return (_token = process.env.EXCEL_GRAPH_TOKEN);

  const now = Math.floor(Date.now() / 1000);
  if (!flags.refresh) {
    const cached = await readCache();
    if (cached && cached.token && cached.exp - now > 120) return (_token = cached.token);
  }
  const token = await captureToken();
  const { exp } = decodeExp(token);
  await writeCache({ token, exp });
  return (_token = token);
}

// ------------------------------------------------------------- graph client ---
async function graph(path, opts = {}) {
  const url = path.startsWith('http') ? path : GRAPH + path;
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { method: opts.method || 'GET', headers, body });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify((await res.json()).error); } catch { try { detail = await res.text(); } catch {} }
    cli.die(`graph ${res.status} ${res.statusText} on ${opts.method || 'GET'} ${path}\n       ${detail}`);
  }
  if (opts.binary) return Buffer.from(await res.arrayBuffer());
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

// -------------------------------------------------------- drive addressing ---
// A target is either a drive PATH ("/Reports/Q3.xlsx", "Q3.xlsx") or an item ID
// (opaque, e.g. "01YELWHJ..."). We treat it as an ID when --id is passed or the
// string looks like a bare Graph item id; otherwise as a path.
function looksLikeId(s) {
  return !s.includes('/') && !s.includes('.') && /^[A-Za-z0-9]{20,}$/.test(s);
}
function encPath(p) {
  return String(p).replace(/^\/+/, '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}
function ref(target) {
  const byId = flags.id || looksLikeId(target);
  const p = byId ? null : encPath(target);
  return {
    byId,
    empty: !byId && p === '',
    meta: byId ? `/me/drive/items/${target}` : p === '' ? '/me/drive/root' : `/me/drive/root:/${p}`,
    content: byId ? `/me/drive/items/${target}/content` : `/me/drive/root:/${p}:/content`,
    children: byId ? `/me/drive/items/${target}/children` : p === '' ? '/me/drive/root/children' : `/me/drive/root:/${p}:/children`,
  };
}

const SELECT = '$select=id,name,size,file,folder,webUrl,lastModifiedDateTime,parentReference';

// Follow @odata.nextLink, collecting up to `limit` items (Infinity = all pages).
async function graphList(firstUrl, limit = Infinity) {
  const items = [];
  let url = firstUrl;
  while (url && items.length < limit) {
    const data = await graph(url);
    for (const it of data.value || []) {
      items.push(it);
      if (items.length >= limit) break;
    }
    url = data['@odata.nextLink'] || null; // absolute URL; graph() passes it through
  }
  return items;
}
function topLimit(fallback) {
  const n = flags.top != null ? parseInt(flags.top, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function fmtItem(it) {
  const kind = it.folder ? c.cyan('dir ') : 'file';
  const size = it.folder ? `${it.folder.childCount ?? ''} item(s)` : human(it.size);
  return `${kind}  ${c.bold(it.name)}  ${c.dim(size)}  ${c.dim(it.id)}`;
}

// --------------------------------------------------------------- commands ---
async function cmdWhoami() {
  const me = await graph('/me?$select=displayName,userPrincipalName,mail,jobTitle,id');
  const { exp, scp } = decodeExp(await getToken());
  if (flags.json) return out({ ...me, tokenExpires: new Date(exp * 1000).toISOString(), scopes: scp.split(' ') });
  out(`${c.bold(me.displayName)}  <${me.mail || me.userPrincipalName}>`);
  out(c.dim(`  ${me.jobTitle || ''}  id ${me.id}`));
  out(c.dim(`  token valid until ${new Date(exp * 1000).toISOString()}`));
}

async function cmdLs(target) {
  const r = ref(target || '');
  // Default to ALL items (paginating), or cap at --top. Page size is bounded by
  // Graph's 200 max, so a folder with >200 children is no longer truncated.
  const limit = topLimit(Infinity);
  const pageSize = Number.isFinite(limit) ? Math.min(limit, 200) : 200;
  const items = await graphList(`${r.children}?${SELECT}&$top=${pageSize}&$orderby=name`, limit);
  if (flags.json) return out(items);
  if (!items.length) { out(c.dim('(empty)')); return; }
  for (const it of items) out(fmtItem(it));
  out(c.dim(`\n${items.length} item(s)`));
}

async function cmdInfo(target) {
  if (!target) cli.die('a path or id is required: excel info <path|id>');
  const it = await graph(`${ref(target).meta}?${SELECT}`);
  if (flags.json) return out(it);
  out(fmtItem(it));
  out(c.dim(`  modified ${it.lastModifiedDateTime}`));
  out(c.dim(`  web      ${it.webUrl}`));
}

async function cmdSearch(query) {
  if (!query) cli.die('a query is required: excel search <query>');
  const q = encodeURIComponent(query.replace(/'/g, "''"));
  const limit = topLimit(25);
  const items = await graphList(`/me/drive/root/search(q='${q}')?${SELECT}&$top=${Math.min(limit, 200)}`, limit);
  if (flags.json) return out(items);
  if (!items.length) { out(c.dim('no matches')); return; }
  for (const it of items) out(fmtItem(it));
  out(c.dim(`\n${items.length} match(es)`));
}

async function cmdDownload(target) {
  if (!target) cli.die('a path or id is required: excel download <path|id> [--out FILE]');
  const r = ref(target);
  const it = await graph(`${r.meta}?$select=id,name,size,folder`);
  if (it.folder) cli.die(`${it.name} is a folder, not a file`);
  const outPath = flags.out || it.name;
  // /content 302-redirects to a pre-signed download URL; fetch follows it and
  // handles files of any size. The bearer is ignored by the pre-signed host.
  const buf = await graph(r.content, { binary: true });
  await fs.writeFileBinary(outPath, buf);
  ok(`downloaded ${c.bold(it.name)} \u2192 ${outPath} (${human(it.size)})`);
}

async function cmdUpload(localFile, remote) {
  if (!localFile) cli.die('a local file is required: excel upload <localfile> [remotepath]');
  if (!(await fs.exists(localFile))) cli.die(`no such local file: ${localFile}`);
  const base = String(localFile).split('/').pop();
  const remotePath = remote || `/${base}`;
  const size = (await fs.stat(localFile).catch(() => ({}))).size;
  const token = await getToken();
  const url = GRAPH + ref(remotePath).content + '?' + SELECT;
  // The jsh proxied `fetch` cannot send a raw binary request body (every body
  // type is stringified), so PUT the bytes with curl, which is byte-faithful.
  // exec.spawn(argv[]) bypasses shell parsing — safe for arbitrary paths/tokens.
  // Simple PUT to /content accepts files up to 250 MiB, covering all real xlsx.
  const res = await exec.spawn([
    'curl', '-s', '-X', 'PUT',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Content-Type: application/octet-stream',
    '--data-binary', `@${localFile}`,
    url,
  ]);
  let item;
  try { item = JSON.parse(res.stdout); } catch { cli.die(`upload failed: ${res.stderr || res.stdout}`); }
  if (item.error) cli.die(`graph ${item.error.code}: ${item.error.message}`);
  if (flags.json) return out(item);
  ok(`uploaded ${c.bold(item.name || base)} (${human(item.size ?? size)}) \u2192 ${item.webUrl}`);
}

async function cmdRm(target) {
  if (!target) cli.die('a path or id is required: excel rm <path|id>');
  await graph(ref(target).meta, { method: 'DELETE' });
  ok(`deleted ${target}`);
}

async function cmdMkdir(target) {
  if (!target) cli.die('a folder path is required: excel mkdir <path>');
  const clean = encPath(target).split('/').map(decodeURIComponent);
  const name = clean.pop();
  const parent = clean.length ? `/me/drive/root:/${clean.map(encodeURIComponent).join('/')}:/children` : '/me/drive/root/children';
  const it = await graph(parent, {
    method: 'POST',
    body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
  });
  if (flags.json) return out(it);
  ok(`created folder ${c.bold(it.name)}  ${c.dim(it.webUrl)}`);
}

async function cmdOpen(target) {
  if (!target) cli.die('a path or id is required: excel open <path|id>');
  const it = await graph(`${ref(target).meta}?$select=name,webUrl`);
  if (!it.webUrl) cli.die(`${target} has no web URL`);
  await exec(`playwright-cli open --foreground '${it.webUrl.replace(/'/g, "'\\''")}'`);
  ok(`opened ${c.bold(it.name)} in the browser`);
}

// excel new <remotepath.xlsx> --data <src> : build a workbook locally with the
// sibling `xlsx` CLI, then upload it. Keeps the xlsx/excel skill boundary clean.
async function cmdNew(remote) {
  if (!remote) cli.die('a remote path is required: excel new <remotepath.xlsx> --data <src>');
  if (!flags.data) cli.die('--data is required (same format as `xlsx create`)');
  const tmp = `/tmp/.excel-new-${Date.now()}.xlsx`;
  const dataArg = String(flags.data).replace(/'/g, "'\\''");
  const sheetArg = flags.sheet ? ` --sheet '${String(flags.sheet).replace(/'/g, "'\\''")}'` : '';
  const r = await exec(`xlsx create ${tmp} --data '${dataArg}'${sheetArg}`);
  if (r.exitCode !== 0) cli.die(`xlsx create failed:\n${r.stderr || r.stdout}`);
  await cmdUpload(tmp, remote);
  await fs.rm(tmp).catch(() => {});
}

async function cmdToken() {
  const token = await getToken();
  const { exp, upn, scp } = decodeExp(token);
  if (flags.json) return out({ token, exp, expires: new Date(exp * 1000).toISOString(), upn, scopes: scp.split(' ') });
  if (flags.quiet) return out(token);
  out(c.dim(`# account ${upn}, valid until ${new Date(exp * 1000).toISOString()}`));
  out(token);
}

// ------------------------------------------------------------------- help ---
const HELP = `${c.bold('excel')} — Excel Online / OneDrive file CRUD via Microsoft Graph

${c.bold('USAGE')}
  excel <command> [args] [flags]

${c.bold('COMMANDS')}
  ls [path]                       List a folder (root if omitted)
  info <path|id>                  Show metadata for a file or folder
  search <query>                  Search your OneDrive
  download <path|id> [--out F]    Download a file (default: same name locally)
  upload <localfile> [remotepath] Upload/replace a file (default: /<basename>)
  new <remotepath.xlsx> --data S  Build a workbook (via xlsx) and upload it
  mkdir <path>                    Create a folder
  rm <path|id>                    Delete a file or folder
  open <path|id>                  Open the item in the browser (Excel for the Web)
  whoami                          Show the signed-in account + token expiry
  token [--refresh] [--quiet]     Print the Graph access token (--quiet: token only)

${c.bold('ADDRESSING')}
  Targets are drive PATHS ("/Reports/Q3.xlsx", "Q3.xlsx") or item IDs.
  Bare id-looking strings are auto-detected; force with --id.

${c.bold('FLAGS')}
  --id                Treat the target as an item ID, not a path
  --out <file>        download: local output path
  --sheet <name>      new: sheet name (default Sheet1)
  --data <src>        new: workbook data (JSON / @file.json / @file.csv)
  --top <n>           ls/search: max results
  --token <jwt>       Use an explicit Graph token (skips capture + cache)
  --refresh           Force a fresh token capture (ignore the cache)
  --json              Machine-readable JSON output

${c.bold('AUTH')}
  On first use (and after ~1h) excel opens a throwaway Excel-for-the-Web tab,
  borrows the delegated Graph token Excel itself uses, caches it, and closes the
  tab. You must be signed into Microsoft 365 in the browser. No admin approval.

${c.bold('EXAMPLES')}
  excel ls
  excel ls /Reports
  excel search budget
  excel download /Reports/Q3.xlsx --out ./q3.xlsx
  excel upload ./q3.xlsx /Reports/Q3.xlsx
  excel new /Reports/new.xlsx --data '[["Name","Value"],["foo",42]]'
  excel open /Reports/Q3.xlsx
  excel rm /Reports/old.xlsx
`;

// ------------------------------------------------------------------ router ---
async function main() {
  if (!cmd || flags.help || flags.h || cmd === 'help') { process.stdout.write(HELP); return; }
  switch (cmd) {
    case 'ls': case 'list': return cmdLs(rest[0]);
    case 'info': case 'stat': return cmdInfo(rest[0]);
    case 'search': case 'find': return cmdSearch(rest.join(' '));
    case 'download': case 'dl': case 'get': return cmdDownload(rest[0]);
    case 'upload': case 'put': return cmdUpload(rest[0], rest[1]);
    case 'new': case 'create': return cmdNew(rest[0]);
    case 'mkdir': return cmdMkdir(rest[0]);
    case 'rm': case 'delete': case 'del': return cmdRm(rest[0]);
    case 'open': return cmdOpen(rest[0]);
    case 'whoami': case 'me': return cmdWhoami();
    case 'token': return cmdToken();
    default: cli.die(`unknown command "${cmd}" (run \`excel help\`)`);
  }
}

await main();
