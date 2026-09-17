// aem.jsh — AEM Edge Delivery Services CLI
// Accepts full EDS URLs: https://main--repo--org.aem.page/path
// Auth via skill.token('adobe') (user OAuth, no manual config needed)
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ MIGRATION NOTES (ai-ecoverse/slicc#786, issue #118)                        │
// │                                                                             │
// │ The `.jsh` runtime no longer injects `exec`, `fs`, `skill` as bare         │
// │ globals — they now must be obtained explicitly via                         │
// │ `require('sliccy:<name>')` / `require('fs')`. Changes made:                │
// │  • Added explicit imports: `const exec = require('sliccy:exec')`,          │
// │    `const skill = require('sliccy:skill')`, `const fs = require('fs')`,    │
// │    `const cli = require('sliccy:cli')`, `const http = require('sliccy:http')`. │
// │  • `exec` is used directly (callable), NOT destructured as                 │
// │    `const { exec } = require('sliccy:exec')`.                              │
// │  • Auth: `exec('oauth-token adobe')` → `skill.token('adobe')`. Simpler,    │
// │    no shell round-trip, and propagates a real Error on failure instead of  │
// │    an empty stdout string.                                                 │
// │  • Read-only/no-body HTTP calls (list, get, preview, publish) migrated to  │
// │    a single `http.client()` — GET for list/get, POST (no body) for        │
// │    preview/publish. This eliminates the hand-rolled `shellQuote()` +      │
// │    `curl` exec wrapper and its manual 401/403 body-sniffing (http.client   │
// │    throws HttpError with `{ status, body }` on any non-2xx natively).      │
// │  • Multipart file upload (`put`, `upload` — AEM/DA `/source` PUT with      │
// │    `data=@file;type=...`) is a documented known gap (#4 in the tracking    │
// │    issue): http.client's FormData pass-through is unproven for this       │
// │    binary-file-from-VFS case, so the existing `exec('curl ... -F ...')`   │
// │    pattern is KEPT as-is for those two subcommands. Judgment call per      │
// │    task guidance — curl -F remains simpler and is already known-working.   │
// │  • `fs.writeFile` / `fs.readFile` / `fs.rm` — same VFS bridge, only the    │
// │    `require('fs')` import needed to be added; call sites unchanged.       │
// │  • Error reporting: `process.stderr.write(...); process.exit(1);` usage   │
// │    error sites left as-is (matches existing per-subcommand usage text     │
// │    exactly — this is a mechanical API port, not a UX rewrite). Auth       │
// │    failures now surface via a thrown Error from `skill.token()` /         │
// │    `HttpError` rather than manual string-sniffing.                        │
// │  • No `process.argv.parseFlags()` used — manual arg parsing (getFlag,     │
// │    resolveTarget, positional filtering) is unchanged, per runtime notes   │
// │    confirming there is no such helper in this runtime.                    │
// │  • No color/table/time formatting was used by the original script, so     │
// │    `sliccy:color` / `sliccy:fmt` / `sliccy:time` were not needed.         │
// └─────────────────────────────────────────────────────────────────────────────┘

const exec = require('sliccy:exec');
const fs = require('fs');
const skill = require('sliccy:skill');
const cli = require('sliccy:cli');
const http = require('sliccy:http');

// Helix 5 (default for most sites)
const DA_ADMIN_BASE = 'https://admin.da.live';
const AEM_ADMIN_BASE = 'https://admin.hlx.page';
// Helix 6 — one host for everything, paths are /<org>/sites/<site>/<verb>/<path>
const AEM_API_BASE = 'https://api.aem.live';

// Flags that consume the following argument. Needed so a flag value is never
// mistaken for a positional (e.g. `aem put --api api.aem.live <url> <file>`).
const VALUE_FLAGS = new Set(['--org', '--repo', '--site', '--ref', '--output', '-o', '--api']);

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) { i++; continue; }
    if (args[i].startsWith('-')) continue;
    out.push(args[i]);
  }
  return out;
}

// ── URL Parsing ────────────────────────────────────────────────

function parseAemUrl(url) {
  const m = url.match(/^https?:\/\/(.+?)--(.+?)--([^.]+)\.(aem|hlx)\.(page|live)\/?(.*)$/);
  if (!m) return null;
  return { ref: m[1], repo: m[2], org: m[3], path: m[6] || '' };
}

function resolveTarget(args) {
  // Find the first positional arg (not a flag)
  let urlOrPath = null;
  let org = null, repo = null, ref = 'main';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--org' && args[i + 1]) { org = args[++i]; continue; }
    if ((args[i] === '--repo' || args[i] === '--site') && args[i + 1]) { repo = args[++i]; continue; }
    if (args[i] === '--ref' && args[i + 1]) { ref = args[++i]; continue; }
    if (VALUE_FLAGS.has(args[i])) { i++; continue; }
  }

  const positional = positionals(args);
  urlOrPath = positional[0] || null;
  if (!urlOrPath) return null;

  // Try parsing as EDS URL
  const eds = parseAemUrl(urlOrPath);
  if (eds) {
    return { org: eds.org, repo: eds.repo, ref: eds.ref, path: eds.path };
  }

  // Fall back to flags
  if (org && repo) {
    const path = urlOrPath.replace(/^\//, '');
    return { org, repo, ref, path };
  }

  return null;
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return null;
}

// ── Auth ───────────────────────────────────────────────────────

let _cachedToken = null;

async function getToken() {
  if (_cachedToken) return _cachedToken;
  try {
    const token = (await skill.token('adobe') || '').trim();
    if (!token) throw new Error('empty token');
    _cachedToken = token;
    return token;
  } catch {
    process.stderr.write('aem: not authenticated. Run: oauth-token adobe\n');
    process.exit(1);
  }
}

// ── HTTP (list/get/preview/publish — JSON/text, no file bodies) ────────────

const aemApi = http.client({
  token: () => getToken(),
});

async function aemRequest(method, url) {
  try {
    const resp = await aemApi[method.toLowerCase()](url, { raw: true });
    return typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      process.stderr.write('aem: authentication failed (token may be expired). Run: oauth-token adobe\n');
      process.exit(1);
    }
    throw new Error((err && (err.body?.message || err.message)) || `HTTP ${method} failed`);
  }
}

// ── Backend selection (Helix 5 vs Helix 6) ─────────────────────
//
// Helix 5 keeps content behind admin.da.live/source/<org>/<site>/<path> and
// operations behind admin.hlx.page/<verb>/<org>/<site>/<ref>/<path>.
// Helix 6 serves both from api.aem.live/<org>/sites/<site>/<verb>/<path>.
//
// A site that has been upgraded is NOT readable through admin.da.live any more:
// the old endpoint answers with unrelated content instead of an error, which is
// why the default here is to probe rather than to assume.
//
// Override with --hlx6 / --hlx5, or point somewhere else with --api <host>.

function apiBase(args) {
  const host = getFlag(args, '--api');
  if (!host) return AEM_API_BASE;
  return /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `https://${host}`;
}

function sourceUrl(base, target, path) {
  return `${base}/${target.org}/sites/${target.repo}/source/${path}`;
}

// Verified probe: on Helix 6 a site answers a source listing at its root, and
// the trailing slash is what makes it a listing. Helix 5 sites have no such
// route, so a 404 here means "not Helix 6".
async function probeHelix6(base, target) {
  try {
    await aemApi.get(sourceUrl(base, target, ''), { raw: true });
    return true;
  } catch (err) {
    const status = err && err.status;
    if (status === 401 || status === 403) {
      process.stderr.write('aem: authentication failed (token may be expired). Run: oauth-token adobe\n');
      process.exit(1);
    }
    return false;
  }
}

const _backendCache = new Map();

async function resolveBackend(target, args) {
  if (args.includes('--hlx5')) return { version: 5 };
  if (args.includes('--hlx6') || getFlag(args, '--api')) {
    return { version: 6, base: apiBase(args) };
  }
  const key = `${target.org}/${target.repo}`;
  if (_backendCache.has(key)) return _backendCache.get(key);
  const base = apiBase(args);
  const backend = (await probeHelix6(base, target)) ? { version: 6, base } : { version: 5 };
  _backendCache.set(key, backend);
  return backend;
}

// ── HTTP (put/upload — multipart file body; known gap #4, curl -F kept) ────

function shellQuote(a) {
  if (/[^a-zA-Z0-9_.\/:\-=]/.test(a)) {
    return "'" + a.replace(/'/g, "'\\''") + "'";
  }
  return a;
}

async function aemFetchMultipart(method, url, token, extraArgs) {
  const args = [
    'curl', '-sS', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
  ];
  if (extraArgs) args.push(...extraArgs);
  args.push(url);
  const cmd = args.map(shellQuote).join(' ');
  const r = await exec(cmd);
  const body = r.stdout;
  // Check auth errors BEFORE exit code — curl returns 0 on HTTP 401
  if (body && (body.includes('"status":401') || body.includes('"status":403') ||
      body.includes('401 Unauthorized') || body.includes('Forbidden'))) {
    process.stderr.write('aem: authentication failed (token may be expired). Run: oauth-token adobe\n');
    process.exit(1);
  }
  if (r.exitCode !== 0) {
    throw new Error(r.stderr || body || `HTTP ${method} failed`);
  }
  return body;
}

// ── HTTP (Helix 6 writes — raw body PUT, no multipart) ─────────
//
// The Source Bus takes the bytes directly: PUT <url> with Content-Type and the
// file as the body, answering 201 both on create and on overwrite. curl is used
// for the same reason as above (file bodies straight from the VFS), and the
// status code is read back explicitly because curl exits 0 on a 4xx.

async function aemPutRaw(url, token, filePath, contentType) {
  const args = [
    'curl', '-sS', '-X', 'PUT',
    '-H', `Authorization: Bearer ${token}`,
    '-H', `Content-Type: ${contentType}`,
    '--data-binary', `@${filePath}`,
    '-w', '\\n%{http_code}',
    url,
  ];
  const r = await exec(args.map(shellQuote).join(' '));
  if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || 'HTTP PUT failed');
  const out = (r.stdout || '').split('\n');
  const status = parseInt(out.pop(), 10);
  const body = out.join('\n');
  if (status === 401 || status === 403) {
    process.stderr.write('aem: authentication failed (token may be expired). Run: oauth-token adobe\n');
    process.exit(1);
  }
  if (!status || status >= 400) {
    throw new Error(`HTTP PUT ${status || '(no status)'}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  return { status, body };
}

// ── Preview / publish / delete routing ────────────────
//
// Helix 6 shape: /<org>/sites/<site>/<verb>/<path> on api.aem.live.
// POST preview|live is still unverified design intent here, so an auto-detected
// Helix 6 site refuses those and asks for --hlx6.
// DELETE live, then preview, then source WAS verified (12/12 HTTP 204, empty
// body) on 2026-09-17 against ai-ecoverse/slicc-website, so delete passes
// { verified: true } and does not require --hlx6.

function explicitHelix6(args) {
  return args.includes('--hlx6') || !!getFlag(args, '--api');
}

async function operationUrl(verb, target, args, path, opts = {}) {
  const backend = await resolveBackend(target, args);
  if (backend.version === 6) {
    if (!opts.verified && !explicitHelix6(args)) {
      process.stderr.write(
        `aem: ${target.org}/${target.repo} answers on the Helix 6 API, and the Helix 6 '${verb}' route is unverified design intent.\n` +
        `     Re-run with --hlx6 to try it anyway, or with --hlx5 to use ${AEM_ADMIN_BASE}.\n`,
      );
      process.exit(1);
    }
    return `${backend.base}/${target.org}/sites/${target.repo}/${verb}/${path}`;
  }
  return `${AEM_ADMIN_BASE}/${verb}/${target.org}/${target.repo}/${target.ref}/${path}`;
}

// Helix 5 always answers JSON here. On Helix 6 the response shape is unknown, so
// a non-JSON body is not treated as a failure — the caller falls back to the
// conventional aem.page / aem.live URL.
function parseOperationResponse(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    if (body && body.trim()) {
      process.stderr.write(`aem: non-JSON response from ${label} API: ${body.slice(0, 200)}\n`);
    }
    return null;
  }
}

// DELETE against the admin API. Success is HTTP 204 with an empty body
// (verified 2026-09-17, 12/12 on ai-ecoverse/slicc-website). Do NOT run that
// body through JSON.parse — parseOperationResponse is for POST preview/publish
// payloads. http.client with { raw: true } already returns { status, body }
// and treats an empty JSON body as null rather than throwing.
async function aemDelete(url) {
  try {
    const resp = await aemApi.delete(url, { raw: true });
    return { status: resp.status };
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    if (err && (err.status === 401 || err.status === 403)) {
      process.stderr.write('aem: authentication failed (token may be expired). Run: oauth-token adobe\n');
      process.exit(1);
    }
    return {
      status: (err && err.status) || 0,
      error: (err && (err.body?.message || err.message)) || 'HTTP DELETE failed',
    };
  }
}

// ── Path normalization ─────────────────────────────────────────

function normalizeAemPath(pagePath) {
  let p = pagePath.replace(/^\//, '').replace(/\.html$/, '');
  if (p.endsWith('/')) p += 'index';
  return p + '.html';
}

// preview/publish (and DELETE live|preview) strip a trailing .html; the Source
// Bus stores pages as *.html (cmdGet/cmdPut) and assets with their own
// extension (cmdUpload). Mixing those up 404s the source DELETE and leaves
// the document in place (hit live 2026-09-17 on a drafts/*.html scratch page).
function operationPath(pagePath) {
  return pagePath.replace(/^\//, '').replace(/\.html$/, '');
}

function sourceContentPath(pagePath) {
  const p = pagePath.replace(/^\//, '');
  if (/\.[a-z0-9]+$/i.test(p) && !/\.html$/i.test(p)) return p;
  return normalizeAemPath(pagePath);
}

// ── Subcommands ────────────────────────────────────────────────

async function cmdList(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem list <eds-url-or-path> [--org <org> --repo <repo>]\n');
    process.exit(1);
  }
  await getToken();
  const dirPath = target.path.replace(/\/$/, '');
  const backend = await resolveBackend(target, args);
  const url = backend.version === 6
    ? sourceUrl(backend.base, target, dirPath ? `${dirPath}/` : '')
    : `${DA_ADMIN_BASE}/list/${target.org}/${target.repo}/${dirPath}`;
  const body = await aemRequest('GET', url);

  let entries;
  try { entries = JSON.parse(body); } catch {
    process.stderr.write(`aem: unexpected response from API: ${body.slice(0, 200)}\n`);
    process.exit(1);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    process.stdout.write('(empty)\n');
    return;
  }
  for (const e of entries) {
    // Helix 5 returns { path, ext }; Helix 6 returns { name, size, content-type,
    // last-modified }, with folders as { name: "blog/", content-type: "application/folder" }.
    const name = e.path || e.name || '';
    const contentType = e['content-type'] || '';
    const isFolder = contentType === 'application/folder' || name.endsWith('/');
    const type = isFolder
      ? 'dir'
      : (e.ext || contentType.split('/').pop() || 'file');
    process.stdout.write(`${type.padEnd(6)} ${name}\n`);
  }
}

async function cmdGet(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem get <eds-url-or-path> [--output <vfs-path>]\n');
    process.exit(1);
  }
  await getToken();
  const path = normalizeAemPath(target.path);
  const backend = await resolveBackend(target, args);
  const url = backend.version === 6
    ? sourceUrl(backend.base, target, path)
    : `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${path}`;
  const html = await aemRequest('GET', url);

  const outputPath = getFlag(args, '--output') || getFlag(args, '-o');
  if (outputPath) {
    await fs.writeFile(outputPath, html);
    process.stdout.write(`Saved to ${outputPath} (${html.length} bytes)\n`);
  } else {
    process.stdout.write(html);
  }
}

async function cmdPut(args) {
  const target = resolveTarget(args);
  // Second positional arg is the VFS file
  const positional = positionals(args);
  const vfsFile = positional[1] || null;

  if (!target || !vfsFile) {
    process.stderr.write('Usage: aem put <eds-url-or-path> <vfs-file>\n');
    process.exit(1);
  }

  const filePath = vfsFile.startsWith('/') ? vfsFile : process.cwd() + '/' + vfsFile;
  const token = await getToken();
  const aemPath = normalizeAemPath(target.path);
  const backend = await resolveBackend(target, args);

  if (backend.version === 6) {
    // Source Bus: the bytes go in the body, no multipart and no temp copy.
    const { status } = await aemPutRaw(
      sourceUrl(backend.base, target, aemPath), token, filePath, 'text/html',
    );
    process.stdout.write(`Saved: ${aemPath} (HTTP ${status})\n`);
    return;
  }

  const html = await fs.readFile(filePath);
  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${aemPath}`;

  // Write HTML to a temp file, then use curl -F to upload
  const tmpPath = process.cwd() + '/_aem_put_' + Date.now() + '.html';
  await fs.writeFile(tmpPath, html);
  await aemFetchMultipart('PUT', url, token, ['-F', `data=@${tmpPath};type=text/html`]);
  await fs.rm(tmpPath);

  process.stdout.write(`Saved: ${aemPath}\n`);
}

async function cmdPreview(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem preview <eds-url-or-path>\n');
    process.exit(1);
  }
  await getToken();
  const path = target.path.replace(/^\//, '').replace(/\.html$/, '');
  const url = await operationUrl('preview', target, args, path);
  const body = await aemRequest('POST', url);

  const data = parseOperationResponse(body, 'preview');
  const previewUrl = (data && data.preview && data.preview.url) ||
    `https://${target.ref}--${target.repo}--${target.org}.aem.page/${path}`;
  process.stdout.write(`Preview: ${previewUrl}\n`);
}

async function cmdPublish(args) {
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem publish <eds-url-or-path>\n');
    process.exit(1);
  }
  await getToken();
  const path = target.path.replace(/^\//, '').replace(/\.html$/, '');
  const url = await operationUrl('live', target, args, path);
  const body = await aemRequest('POST', url);

  const data = parseOperationResponse(body, 'publish');
  const liveUrl = (data && data.live && data.live.url) ||
    `https://${target.ref}--${target.repo}--${target.org}.aem.live/${path}`;
  process.stdout.write(`Published: ${liveUrl}\n`);
}

async function cmdUpload(args) {
  const positional = positionals(args);
  const vfsFile = positional[0] || null;

  if (!vfsFile || positional.length < 2) {
    process.stderr.write('Usage: aem upload <vfs-file> <eds-url-or-path>\n');
    process.exit(1);
  }

  // Drop the local file from the positionals, keep every flag together with its value.
  const targetArgs = [];
  let droppedLocalFile = false;
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      targetArgs.push(args[i]);
      if (args[i + 1] !== undefined) targetArgs.push(args[++i]);
      continue;
    }
    if (args[i].startsWith('-')) { targetArgs.push(args[i]); continue; }
    if (!droppedLocalFile) { droppedLocalFile = true; continue; }
    targetArgs.push(args[i]);
  }

  const target = resolveTarget(targetArgs);
  if (!target) {
    process.stderr.write('Usage: aem upload <vfs-file> <eds-url-or-path> [--org <org> --repo <repo>]\n');
    process.exit(1);
  }

  const filePath = vfsFile.startsWith('/') ? vfsFile : process.cwd() + '/' + vfsFile;
  const token = await getToken();
  const aemPath = target.path.replace(/^\//, '');

  // Guess MIME type from extension
  const ext = filePath.split('.').pop().toLowerCase();
  const mimeMap = {
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
    'gif': 'image/gif', 'svg': 'image/svg+xml', 'webp': 'image/webp',
    'pdf': 'application/pdf', 'mp4': 'video/mp4',
  };
  const mime = mimeMap[ext] || 'application/octet-stream';

  const backend = await resolveBackend(target, args);

  if (backend.version === 6) {
    // Same raw PUT as text content. Verified for text/html; binary media through
    // the Source Bus is untested here, so report the status code rather than
    // claiming success on a body nobody looked at.
    const { status } = await aemPutRaw(
      sourceUrl(backend.base, target, aemPath), token, filePath, mime,
    );
    process.stdout.write(`Uploaded: ${filePath} -> ${aemPath} (HTTP ${status})\n`);
    return;
  }

  const url = `${DA_ADMIN_BASE}/source/${target.org}/${target.repo}/${aemPath}`;
  await aemFetchMultipart('PUT', url, token, ['-F', `data=@${filePath};type=${mime}`]);

  process.stdout.write(`Uploaded: ${filePath} -> ${aemPath}\n`);
}

// delete/unpublish only. Other verbs still swallow unknown flags via
// positionals(); tightening that is a separate decision. A mistyped safety
// flag on a destructive verb must not fail open (e.g. `--yes --dry-runn`
// must not delete). Checked before resolveBackend / any network call.
const DELETE_BOOL_FLAGS = new Set([
  '--yes', '--dry-run', '--unpublish-only', '--verify', '--hlx6', '--hlx5',
]);
const DELETE_VALUE_FLAGS = new Set(['--org', '--repo', '--site', '--ref', '--api']);

function rejectUnknownDeleteFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) continue;
    if (DELETE_BOOL_FLAGS.has(a)) continue;
    if (DELETE_VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    process.stderr.write(`error: unknown option ${a}\n`);
    process.stderr.write("See 'aem --help'.\n");
    process.exit(1);
  }
}

async function cmdDelete(args) {
  rejectUnknownDeleteFlags(args);
  const target = resolveTarget(args);
  if (!target) {
    process.stderr.write('Usage: aem delete <eds-url-or-path> [--yes] [--dry-run] [--unpublish-only] [--verify]\n');
    process.exit(1);
  }

  // live/preview: same path as cmdPreview/cmdPublish (strip trailing .html).
  // source: same path as cmdGet/cmdPut/cmdUpload (pages are *.html; assets keep
  // .pdf/.png/...). Using the operation path for source 404s and leaves the file.
  const path = operationPath(target.path);
  const srcPath = sourceContentPath(target.path);
  if (!path) {
    process.stderr.write('aem: refusing to delete the site root. Pass a specific path.\n');
    process.exit(1);
  }

  const backend = await resolveBackend(target, args);
  if (backend.version === 5) {
    process.stderr.write(
      'aem: delete is not supported on Helix 5.\n' +
      `     DELETE has not been tested against ${AEM_ADMIN_BASE} or ${DA_ADMIN_BASE}, and this CLI will not guess a destructive route.\n` +
      '     If this site is actually Helix 6, re-run with --hlx6.\n',
    );
    process.exit(1);
  }

  const unpublishOnly = args.includes('--unpublish-only');
  const stages = unpublishOnly ? ['live', 'preview'] : ['live', 'preview', 'source'];
  const planned = [];
  for (const verb of stages) {
    const stagePath = verb === 'source' ? srcPath : path;
    planned.push({ verb, url: await operationUrl(verb, target, args, stagePath, { verified: true }) });
  }

  const dryRun = args.includes('--dry-run');
  const yes = args.includes('--yes');

  if (dryRun) {
    process.stdout.write('aem delete --dry-run: would DELETE in this order (no requests sent):\n');
    for (const { verb, url } of planned) {
      process.stdout.write(`  ${verb.padEnd(8)} ${url}\n`);
    }
    return;
  }

  if (!yes) {
    process.stderr.write('aem: delete is destructive; nothing was changed. Re-run with --yes to DELETE in this order:\n');
    for (const { verb, url } of planned) {
      process.stderr.write(`  ${verb.padEnd(8)} ${url}\n`);
    }
    process.stderr.write('     Or pass --dry-run to print the URLs and exit 0 without changes.\n');
    process.exit(1);
  }

  await getToken();

  // Order is mandatory: unpublish live, then preview, then remove source.
  // Deleting source first can strand a published copy whose source is gone
  // (verified 2026-09-17 against ai-ecoverse/slicc-website).
  let unpublishFailed = false;
  let anyFailed = false;
  for (const { verb, url } of planned) {
    if (verb === 'source' && unpublishFailed) {
      process.stderr.write(
        `  ${'source'.padEnd(8)} skipped (live or preview failed; source left intact to avoid stranding a published copy)\n`,
      );
      anyFailed = true;
      continue;
    }
    const result = await aemDelete(url);
    // 2xx succeeds. 404 means already gone — still safe to continue, so it
    // does not skip the source stage the way a real unpublish failure would.
    const ok = (result.status >= 200 && result.status < 300) || result.status === 404;
    const extra = result.status === 404
      ? ' (already gone)'
      : (result.error ? `  ${String(result.error).slice(0, 160)}` : '');
    const line = `  ${verb.padEnd(8)} HTTP ${result.status || 'error'}  ${url}${extra}\n`;
    if (ok) process.stdout.write(line);
    else process.stderr.write(line);
    if (!ok) {
      anyFailed = true;
      if (verb === 'live' || verb === 'preview') unpublishFailed = true;
    }
  }

  if (args.includes('--verify')) {
    // CRITICAL TRAP (verified 2026-09-17 on ai-ecoverse/slicc-website): after a
    // successful 204, GET .../live/<path> and GET .../preview/<path> on the
    // admin API still return 200, while GET .../source/<path> correctly returns
    // 404. Only the delivery hosts tell the truth. Never use an admin GET as
    // the success oracle — that would report a false failure and invite a
    // destructive retry.
    const delivery = [
      { label: 'preview', url: `https://${target.ref}--${target.repo}--${target.org}.aem.page/${path}` },
      { label: 'live', url: `https://${target.ref}--${target.repo}--${target.org}.aem.live/${path}` },
    ];
    const attempts = 4;
    for (const d of delivery) {
      let status = 0;
      for (let i = 0; i < attempts; i++) {
        try {
          const resp = await fetch(d.url, { method: 'GET', redirect: 'follow' });
          status = resp.status;
        } catch {
          status = 0;
        }
        if (status === 404) break;
        if (i + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      const line = `  verify   ${d.label.padEnd(8)} HTTP ${status || 'error'}  ${d.url}\n`;
      if (status === 404) process.stdout.write(line);
      else {
        process.stderr.write(line);
        anyFailed = true;
      }
    }
  }

  if (anyFailed) process.exit(1);
}

function cmdHelp() {
  process.stdout.write(`aem -- AEM Edge Delivery Services CLI

Usage: aem <command> <eds-url-or-path> [options]

All commands accept full EDS URLs:
  https://main--repo--org.aem.page/path
Or use --org/--repo flags with a plain path.

Commands:
  list <url>                  List pages in a directory
  get <url> [--output <path>] Get page HTML
  put <url> <vfs-file>        Write HTML (from VFS file)
  preview <url>               Trigger AEM preview
  publish <url>               Trigger AEM publish
  upload <vfs-file> <url>     Upload a VFS file (media)
  delete <url> --yes          Unpublish live & preview, then delete source
  unpublish <url> --yes       Alias for delete --unpublish-only (leave source)
  help                        Show this help

Delete flags:
  --yes            Required to actually delete. Without it, print the plan and exit 1.
  --dry-run        Print the DELETE URLs, make no mutating calls, exit 0
  --unpublish-only live + preview only; do not delete source
  --verify         After deleting, poll aem.page / aem.live for 404. Do not GET
                   the admin API — it keeps returning 200 after a successful 204.
  Unknown flags are rejected. A typo of --dry-run must not delete.

Architecture version:
  Sites on Helix 6 answer on https://api.aem.live with paths of the shape
  /<org>/sites/<site>/<verb>/<path>; Helix 5 sites use admin.da.live for
  content and admin.hlx.page for operations. Which one applies is detected
  per site, because a Helix 6 site queried through admin.da.live returns
  unrelated content instead of an error.

  --hlx6           Force the Helix 6 API
  --hlx5           Force the Helix 5 API
  --api <host>     Use a different Helix 6 host (implies --hlx6)
  --site <name>    Alias for --repo

  get, put, list, upload and delete are verified against Helix 6. preview and
  publish use the documented Helix 6 route but it is unverified, so on a Helix 6
  site they require an explicit --hlx6. delete on Helix 5 is refused: the
  destructive route has not been tested against admin.hlx.page / admin.da.live.

Authentication:
  Uses oauth-token adobe (auto-triggers login if needed).
  No manual configuration required.

Examples:
  aem list https://main--myrepo--myorg.aem.page/
  aem get https://main--myrepo--myorg.aem.page/products/overview
  aem get https://main--myrepo--myorg.aem.page/page --output /workspace/page.html
  aem put https://main--myrepo--myorg.aem.page/page /workspace/page.html
  aem preview https://main--myrepo--myorg.aem.page/page
  aem publish https://main--myrepo--myorg.aem.page/page
  aem upload /workspace/image.png https://main--myrepo--myorg.aem.page/media_123.png
  aem delete https://main--myrepo--myorg.aem.page/assets/old.pdf --dry-run
  aem delete https://main--myrepo--myorg.aem.page/assets/old.pdf --yes
  aem unpublish https://main--myrepo--myorg.aem.page/page --yes

  # Or with flags:
  aem list /products --org myorg --repo myrepo

  # Helix 6 (api.aem.live):
  aem list https://main--aem-website--adobe.aem.page/blog
  aem get https://main--aem-website--adobe.aem.page/blog/my-post --output /shared/post.html
  aem put https://main--aem-website--adobe.aem.page/blog/my-post /shared/post.html
  aem list /blog --org adobe --site aem-website --hlx6
`);
}

// ── Main ───────────────────────────────────────────────────────

const args = process.argv.slice(2); // argv[0] is interpreter, argv[1] is script path
const command = args[0] || 'help';
const subArgs = args.slice(1);

switch (command) {
  case 'list':
  case 'ls':
    await cmdList(subArgs);
    break;
  case 'get':
    await cmdGet(subArgs);
    break;
  case 'put':
    await cmdPut(subArgs);
    break;
  case 'preview':
    await cmdPreview(subArgs);
    break;
  case 'publish':
    await cmdPublish(subArgs);
    break;
  case 'upload':
    await cmdUpload(subArgs);
    break;
  case 'delete':
    await cmdDelete(subArgs);
    break;
  case 'unpublish':
    await cmdDelete(['--unpublish-only', ...subArgs]);
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  default:
    process.stderr.write(`aem: '${command}' is not an aem command. See 'aem help'.\n`);
    process.exit(1);
}
