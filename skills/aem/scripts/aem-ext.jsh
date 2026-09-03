// aem-ext.jsh — AEM Edge Delivery Services CLI with long-lived API-key auth.
//
// Why this exists (and why it is a separate script from aem.jsh):
//   aem.jsh authenticates only with an Adobe IMS user token (`skill.token('adobe')`)
//   sent as `Authorization: Bearer <t>`. In practice that token stops working after
//   ~20 minutes, which breaks long content jobs and forces an interactive re-login.
//   AEM also supports *admin API keys* that live up to 365 days — but they use a
//   DIFFERENT auth scheme and, on Helix 6, need an extra registration step that the
//   official documentation says is unnecessary. This script makes them usable.
//   aem.jsh is intentionally left untouched.
//
// ── Wire facts, all verified live 2026-09-03 against ai-ecoverse/slicc-website
//    (Helix 6, api.aem.live, OpenAPI 1.76.0) ──────────────────────────────────
//
// 1. THE HEADER RULE — the schemes do not cross over. All four combinations tested:
//      IMS user token  + `Authorization: Bearer <t>`   → 200
//      IMS user token  + `X-Auth-Token: <t>`            → 401
//      IMS user token  + `Authorization: token <t>`     → 401
//      admin API key   + `X-Auth-Token: <k>`            → 200
//      admin API key   + `Authorization: token <k>`     → 200
//      admin API key   + `Authorization: Bearer <k>`    → 401 (x-error: [AWS] Unauthorized)
//    So the credential *type* decides the header. This script sends X-Auth-Token for
//    API keys and Bearer only for IMS tokens.
//
// 2. MINTING ON HELIX 6 — the Helix 5 helper `POST /config/{org}/sites/{site}/apiKeys.json`
//    on admin.hlx.page 404s on Helix 6. Use the site-config property API instead:
//      POST https://api.aem.live/<org>/sites/<site>/config/apiKeys.json
//      {"description":"...","roles":["admin"]}
//    `expiresIn` MUST be omitted on Helix 6: sending it returns 400 with
//      x-error: [admin] Error updating config: /apiKeys/<id> must NOT have additional properties
//    (verified live; the response body is empty — the message is only in the header,
//    which is why this script reads x-error). Omitting it still yields a 1-year key.
//    Helix 5 does accept expiresIn (1..31536000 seconds) — and so does the Helix 5
//    create helper on admin.hlx.page when it is aimed at a MIGRATED Helix 6 site:
//    verified live, POST https://admin.hlx.page/config/<org>/sites/<site>/apiKeys.json
//    with expiresIn 86400 answered 200, produced expiration = created + 24h, wrote into
//    the same Helix 6 config store, and the key worked on api.aem.live after
//    registration. That host advertises "link: <https://api.aem.live/>;
//    rel=successor-version". So --expires-in is routed there on Helix 6 rather than
//    being dropped.
//
// 3. THE REGISTRATION GOTCHA — https://www.aem.live/docs/admin-apikeys claims a new
//    key is "automatically enabled ... There is no need to manually add the API Key ID
//    to the access.admin.apiKeyId property". That is FALSE on Helix 6. Verified: a
//    freshly minted key returned 401 on every /<org>/sites/<site>/... resource while
//    GET /profile returned 200 with the same key — a false positive that makes the key
//    look healthy. The fix is to add the key's jti to access.admin.apiKeyId. That POST
//    is a WHOLE-OBJECT OVERWRITE, so this script always GETs config.json first and
//    merges (the `role` map holds real people's email addresses; replacing it instead
//    of merging locks them out).
//
// 4. URL-SAFE jti — a raw jti can contain `+` and `/`. The config object key and the
//    DELETE path use the URL-safe form (`+`→`-`, `/`→`_`); deletes 404 without it,
//    and return 204 with it. access.admin.apiKeyId, however, holds the RAW jti, so
//    membership checks here accept either spelling.
//
// 5. The minted `value` (the JWT itself) is returned exactly ONCE by the create call
//    and is never retrievable afterwards — config.json lists metadata only.
//
// ── Implementation note: why plain `fetch` and not `http.client` ───────────────
//   AEM puts its only human-readable error text in the `x-error` response header and
//   frequently answers 4xx with an EMPTY body (verified live: the expiresIn 400 above).
//   `http.client`'s HttpError carries {status, statusText, url, body} but drops the
//   headers, so every one of those failures would surface as a blank "HTTP 400". This
//   script therefore uses the kernel-bridged global `fetch` behind one wrapper
//   (`apiFetch`) that surfaces x-error verbatim. The bridge also unmasks `secret`
//   values server-side for both fetch and curl (verified live), so a masked secret
//   blob works as a credential without ever being readable here.

const exec = require('sliccy:exec');
const fs = require('fs');
const skill = require('sliccy:skill');
const cli = require('sliccy:cli');
const color = require('sliccy:color');

const PREFIX = 'aem-ext';

// Helix 6: one host for everything. Helix 5: operations + content on two hosts.
const AEM_API_BASE = 'https://api.aem.live';
const HLX5_ADMIN_BASE = 'https://admin.hlx.page';
const HLX5_DA_BASE = 'https://admin.da.live';

// Session-secret name searched during credential resolution.
const SECRET_NAME = 'aem.apikey';
// Hosts an API-key secret must be scoped to for the fetch proxy to unmask it.
const SECRET_DOMAINS = 'api.aem.live,admin.hlx.page,admin.aem.live';

// Helix 6 role enum (OpenAPI 1.76.0). Helix 5 additionally allows `view`.
const H6_ROLES = [
  'author', 'publish', 'develop', 'basic_author', 'basic_publish',
  'config', 'config_admin', 'admin',
];
const H5_EXTRA_ROLES = ['view'];

const HELP = `
aem-ext — AEM Edge Delivery Services CLI with long-lived API-key auth

USAGE
  aem-ext auth status [--org <o> --site <s>] [--json]
  aem-ext auth login [--idp google|microsoft|adobe] [--select-account] [--print-url] [--hlx5] [--json]
  aem-ext auth key create --org <o> --site <s> [--roles <r,r>] [--description <d>]
                          [--expires-in <seconds>] [--register] [--save-secret [name]] [--json]
  aem-ext auth key list --org <o> --site <s> [--json]
  aem-ext auth key register --org <o> --site <s> --id <jti> [--json]
  aem-ext auth key delete --org <o> --site <s> --id <jti> [--confirm]

  aem-ext list <url-or-path> [--json]
  aem-ext get <url-or-path> [--output <vfs-path>]
  aem-ext put <url-or-path> <vfs-file>
  aem-ext status <url-or-path> [--json]
  aem-ext preview <url-or-path> [--json]
  aem-ext publish <url-or-path> [--json]

CREDENTIAL RESOLUTION (first match wins)
  1. --api-key <value>, or the AEM_API_KEY environment variable
  2. the '${SECRET_NAME}' secret, or --secret-name <name>
     (secret set ${SECRET_NAME} <key> --domain "${SECRET_DOMAINS}")
  3. an auth_token cookie stored by 'aem-ext auth login'
  4. the Adobe IMS user token from skill.token('adobe')  (expires in ~20 minutes)

THE HEADER RULE (verified live — the schemes do NOT cross over)
  admin API key   ->  X-Auth-Token: <key>            (Authorization: token <key> also works)
  IMS user token  ->  Authorization: Bearer <token>
  login cookie    ->  Cookie: auth_token=<value>
  Using Bearer with an API key, or X-Auth-Token with an IMS token, returns 401.

HELIX 6: A NEW KEY IS 401 UNTIL IT IS REGISTERED
  Contrary to https://www.aem.live/docs/admin-apikeys, a freshly minted key is NOT
  automatically enabled on Helix 6. Its jti must be added to access.admin.apiKeyId.
  Use 'auth key create --register', or 'auth key register' afterwards. Note that
  GET /profile answers 200 with an unregistered key, so it is not a usable probe —
  'auth status --org <o> --site <s>' probes a real site resource instead.

TARGETS
  Content commands accept a full EDS URL (https://main--site--org.aem.page/path)
  or a plain path together with --org and --site.

FLAGS
  --api-key <v>     Use this API key (sent as X-Auth-Token)
  --secret-name <n> Resolve the API key from this secret instead of '${SECRET_NAME}'
  --ims             Ignore API keys and use the Adobe IMS user token
  --org <o>         Organisation
  --site <s>        Site (alias: --repo)
  --ref <r>         Branch for Helix 5 operations (default: main)
  --hlx5            Target the Helix 5 API (admin.hlx.page / admin.da.live)
  --api <host>      Use a different Helix 6 host
  --json            Raw JSON output
  --confirm         Required for destructive operations
  --print-url       'auth login': resolve and print the IDP URL, do not drive a browser
  --select-account  'auth login': use the IDP's _sa link (?selectAccount=true)
  --output <path>   Write 'get' output to a VFS file
  --expires-in <s>  Key lifetime in seconds (1..31536000). On Helix 6 this is minted
                    through the Helix 5 compat route, which is the only one that
                    accepts it; without the flag every key lasts 1 year.

SECURITY
  Nothing secret is printed except the newly minted key in 'auth key create', which
  the API returns exactly once. Prefer '--save-secret' so it goes into the secrets
  manager instead of into this transcript.
`.trim();

// ── args ──────────────────────────────────────────────────────────────────────

const parsed = process.argv.parseFlags();
const flags = parsed.flags;
const words = parsed.positional; // e.g. ['auth','key','create'] — nested subcommands

function flag(...names) {
  for (const n of names) {
    const v = flags[n];
    if (v !== undefined) return v;
  }
  return undefined;
}

// ── generic helpers ───────────────────────────────────────────────────────────

function urlSafeJti(id) {
  // verified live 2026-09-03: the config object key and the DELETE path use the
  // URL-safe spelling; the raw jti (with + and /) 404s on DELETE.
  return String(id).replace(/\+/g, '-').replace(/\//g, '_');
}

function jtiVariants(id) {
  const raw = String(id);
  return new Set([raw, urlSafeJti(raw), raw.replace(/-/g, '+').replace(/_/g, '/')]);
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null; // IMS access tokens are opaque, not JWTs
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// The secrets manager hands back a long repeated-hex blob instead of the value; the
// fetch proxy substitutes the real bytes server-side. Detect it so we never try to
// decode it as a JWT and never present it as a value.
function looksMasked(value) {
  return /^[0-9a-f]{48,}$/i.test(String(value || ''));
}

function relTime(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return null;
  const delta = epochSeconds * 1000 - Date.now();
  const past = delta < 0;
  const s = Math.abs(delta) / 1000;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const label = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return past ? `expired ${label} ago` : `in ${label}`;
}

function isoOrDash(v) {
  if (!v) return '—';
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  return String(v);
}

function section(title) {
  console.log('');
  console.log(`  ${color.cyan(color.bold(title))}`);
}

function kv(label, value) {
  console.log(`    ${label.padEnd(11)} ${value}`);
}

function rule() {
  console.log(color.dim(`  ${'─'.repeat(52)}`));
}

// ── credential resolution ─────────────────────────────────────────────────────

async function readSecretValue(name) {
  const r = await exec.spawn(['secret', 'get', name]);
  if (r.exitCode !== 0) return null;
  // `secret get` prints "<name>=<masked value>" then an indented "domains:" line.
  const line = (r.stdout || '').split('\n')[0] || '';
  const eq = line.indexOf('=');
  if (eq < 0) return null;
  const value = line.slice(eq + 1).trim();
  return value || null;
}

let _cred = null;

async function credential() {
  if (_cred) return _cred;

  const explicit = flag('api-key');
  if (!flags.ims && typeof explicit === 'string' && explicit.trim()) {
    _cred = { kind: 'apikey', source: '--api-key flag', value: explicit.trim() };
    return _cred;
  }
  if (!flags.ims && process.env.AEM_API_KEY) {
    _cred = { kind: 'apikey', source: 'AEM_API_KEY env var', value: process.env.AEM_API_KEY.trim() };
    return _cred;
  }
  if (!flags.ims) {
    const secretName = typeof flag('secret-name') === 'string' && flag('secret-name')
      ? String(flag('secret-name'))
      : SECRET_NAME;
    const secretValue = await readSecretValue(secretName);
    if (secretValue) {
      _cred = {
        kind: 'apikey',
        source: `secret ${secretName}`,
        value: secretValue,
        masked: looksMasked(secretValue),
      };
      return _cred;
    }
    const cfg = (await skill.config()) || {}; // a bare Promise is always truthy
    if (cfg.authToken) {
      _cred = {
        kind: 'cookie',
        source: `auth login cookie (${cfg.authHost || 'api.aem.live'}, saved ${cfg.authTokenSavedAt || 'unknown'})`,
        value: cfg.authToken,
      };
      return _cred;
    }
  }

  let ims = '';
  try {
    ims = ((await skill.token('adobe')) || '').trim();
  } catch {
    ims = '';
  }
  if (ims) {
    _cred = { kind: 'ims', source: "skill.token('adobe')", value: ims };
    return _cred;
  }

  cli.die(
    'no usable credential.\n' +
    `  Long-lived (365 days):  aem-ext auth key create --org <o> --site <s> --register --save-secret\n` +
    `  Existing key:           secret set ${SECRET_NAME} <key> --domain "${SECRET_DOMAINS}"\n` +
    '                          or pass --api-key <key> / set AEM_API_KEY\n' +
    '  Short-lived (~20 min):  oauth-token adobe',
    { prefix: PREFIX },
  );
}

function authHeaders(cred) {
  // THE HEADER RULE — verified live 2026-09-03, see the file header.
  if (cred.kind === 'apikey') return { 'X-Auth-Token': cred.value };
  if (cred.kind === 'cookie') return { Cookie: `auth_token=${cred.value}` };
  return { Authorization: `Bearer ${cred.value}` };
}

function headerDescription(cred) {
  if (cred.kind === 'apikey') return 'X-Auth-Token: <key>';
  if (cred.kind === 'cookie') return 'Cookie: auth_token=<value>';
  return 'Authorization: Bearer <token>';
}

// The IMS token is the only credential that can mint or register keys: an API key is
// scoped to a site and the config-write routes reject it.
async function imsCredential() {
  let ims = '';
  try {
    ims = ((await skill.token('adobe')) || '').trim();
  } catch {
    ims = '';
  }
  if (!ims) {
    cli.die(
      'minting and registering API keys needs an Adobe IMS user token (an API key cannot create keys).\n' +
      '  Run: oauth-token adobe',
      { prefix: PREFIX },
    );
  }
  return { kind: 'ims', source: "skill.token('adobe')", value: ims };
}

// ── HTTP (one wrapper — see the header note on why not http.client) ───────────

async function apiFetch(method, url, opts = {}) {
  const cred = opts.cred || (await credential());
  const headers = { ...authHeaders(cred), ...(opts.headers || {}) };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;

  let res;
  try {
    res = await fetch(url, { method, headers, body: opts.body });
  } catch (err) {
    cli.die(`request to ${url} failed: ${err.message}`, { prefix: PREFIX });
  }

  const text = await res.text();
  const xError = res.headers.get('x-error') || '';
  let json = null;
  const looksHtml = /^\s*(<!DOCTYPE|<html)/i.test(text);
  if (!looksHtml && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    text,
    json,
    looksHtml,
    xError,
    cred,
    url,
    method,
  };
}

// Turn a failed response into one actionable message. `hint` names the operation.
function dieOnError(res, hint) {
  if (res.ok) return res;
  const detail = res.xError || (res.json && (res.json.message || res.json.error)) ||
    (res.text ? res.text.slice(0, 200) : '');

  if (res.looksHtml) {
    cli.die(
      `${hint}: got an HTML page instead of JSON — the session may have expired.\n` +
      '  Re-run with a fresh credential (oauth-token adobe, or aem-ext auth login).',
      { prefix: PREFIX },
    );
  }
  if (res.status === 401 || res.status === 403) {
    if (res.cred.kind === 'apikey') {
      cli.die(
        `${hint}: ${res.status} with the API key from ${res.cred.source}.\n` +
        '  On Helix 6 a key is rejected until its id is in access.admin.apiKeyId, even\n' +
        '  though GET /profile answers 200 for it. Check with:\n' +
        '    aem-ext auth key list --org <org> --site <site>\n' +
        '  and register it with:\n' +
        '    aem-ext auth key register --org <org> --site <site> --id <jti>\n' +
        (detail ? `  server said: ${detail}` : ''),
        { prefix: PREFIX },
      );
    }
    cli.die(
      `${hint}: ${res.status} with the IMS user token (these expire after ~20 minutes).\n` +
      '  Refresh it:  oauth-token adobe\n' +
      '  Or switch to a 365-day key:  aem-ext auth key create --org <o> --site <s> --register --save-secret\n' +
      (detail ? `  server said: ${detail}` : ''),
      { prefix: PREFIX },
    );
  }
  cli.die(`${hint}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`, { prefix: PREFIX });
}

// ── org/site plumbing ─────────────────────────────────────────────────────────

function apiBase() {
  const host = flag('api');
  if (typeof host !== 'string' || !host) return AEM_API_BASE;
  return /^https?:\/\//.test(host) ? host.replace(/\/$/, '') : `https://${host}`;
}

function isHelix5() {
  return flags.hlx5 === true;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireOrgSite(usage) {
  const org = flag('org');
  const site = flag('site', 'repo');
  if (typeof org !== 'string' || typeof site !== 'string' || !org || !site) {
    cli.die(`usage: ${usage}`, { prefix: PREFIX });
  }
  if (!NAME_RE.test(org) || !NAME_RE.test(site)) {
    cli.die(`invalid --org/--site: expected ${NAME_RE} (got "${org}"/"${site}")`, { prefix: PREFIX });
  }
  return { org, site };
}

function siteConfigUrl(org, site) {
  return isHelix5()
    ? `${HLX5_ADMIN_BASE}/config/${org}/sites/${site}.json`
    : `${apiBase()}/${org}/sites/${site}/config.json`;
}

function apiKeysUrl(org, site) {
  // Helix 5 has a dedicated createSiteApiKey helper; on Helix 6 that path 404s and
  // the site-config property API is used instead (verified live 2026-09-03).
  return isHelix5()
    ? `${HLX5_ADMIN_BASE}/config/${org}/sites/${site}/apiKeys.json`
    : `${apiBase()}/${org}/sites/${site}/config/apiKeys.json`;
}

function apiKeyUrl(org, site, id) {
  const safe = urlSafeJti(id);
  return isHelix5()
    ? `${HLX5_ADMIN_BASE}/config/${org}/sites/${site}/apiKeys/${encodeURIComponent(safe)}.json`
    : `${apiBase()}/${org}/sites/${site}/config/apiKeys/${encodeURIComponent(safe)}.json`;
}

function accessConfigUrl(org, site) {
  if (isHelix5()) {
    cli.die(
      'registering a key id in access.admin.apiKeyId is a Helix 6 requirement; on Helix 5 keys are enabled automatically.',
      { prefix: PREFIX },
    );
  }
  return `${apiBase()}/${org}/sites/${site}/config/access.json`;
}

function sourceUrl(org, site, path) {
  return isHelix5()
    ? `${HLX5_DA_BASE}/source/${org}/${site}/${path}`
    : `${apiBase()}/${org}/sites/${site}/source/${path}`;
}

function operationUrl(verb, org, site, ref, path) {
  // Verified live 2026-09-03 with an API key on Helix 6: POST preview/<path> → 200,
  // GET status/<path> → 200, POST live/<path> uses the same shape.
  return isHelix5()
    ? `${HLX5_ADMIN_BASE}/${verb}/${org}/${site}/${ref}/${path}`
    : `${apiBase()}/${org}/sites/${site}/${verb}/${path}`;
}

async function fetchSiteConfig(org, site, cred) {
  const res = await apiFetch('GET', siteConfigUrl(org, site), { cred });
  dieOnError(res, `reading site config for ${org}/${site}`);
  if (!res.json || typeof res.json !== 'object') {
    cli.die(`site config for ${org}/${site} was not JSON`, { prefix: PREFIX });
  }
  return res.json;
}

function apiKeyEntries(config) {
  const keys = (config && config.apiKeys) || {};
  const registered = registeredIds(config);
  return Object.entries(keys).map(([objectKey, meta]) => {
    const id = (meta && meta.id) || objectKey;
    const isRegistered = [...jtiVariants(id)].some((v) => registered.has(v));
    return { objectKey, id, registered: isRegistered, ...(meta || {}) };
  });
}

function registeredIds(config) {
  const admin = (((config || {}).access || {}).admin) || {};
  const ids = Array.isArray(admin.apiKeyId) ? admin.apiKeyId : admin.apiKeyId ? [admin.apiKeyId] : [];
  const out = new Set();
  for (const id of ids) for (const v of jtiVariants(id)) out.add(v);
  return out;
}

// access.json is a WHOLE-OBJECT overwrite: the existing `role` map (real people's
// email addresses) has to be re-sent or it is wiped. Always merge.
function mergeAdminAccess(config, { add, remove }) {
  const access = (config && config.access) || {};
  const admin = { ...(access.admin || {}) };
  const current = Array.isArray(admin.apiKeyId)
    ? [...admin.apiKeyId]
    : admin.apiKeyId ? [admin.apiKeyId] : [];

  let next = current;
  if (add) {
    const already = current.some((c) => jtiVariants(c).has(add) || jtiVariants(add).has(c));
    next = already ? current : [...current, add];
  }
  if (remove) {
    next = current.filter((c) => !(jtiVariants(c).has(remove) || jtiVariants(remove).has(c)));
  }
  admin.apiKeyId = next;
  if (!admin.role) admin.role = {}; // never send an admin object without its role map
  return { admin, previous: current, next };
}

async function writeAdminAccess(org, site, admin, cred) {
  const res = await apiFetch('POST', accessConfigUrl(org, site), {
    cred,
    contentType: 'application/json',
    body: JSON.stringify({ admin }),
  });
  dieOnError(res, `updating access config for ${org}/${site}`);
  return res;
}

function roleSummary(admin) {
  const role = (admin && admin.role) || {};
  const parts = Object.entries(role).map(([r, list]) => `${r}:${Array.isArray(list) ? list.length : 1}`);
  return parts.length ? parts.join(' ') : 'none';
}

// ── auth status ───────────────────────────────────────────────────────────────

async function cmdAuthStatus() {
  const cred = await credential();
  const claims = cred.masked ? null : decodeJwt(cred.value);

  const out = {
    credential: {
      type: cred.kind === 'apikey' ? 'api-key' : cred.kind === 'cookie' ? 'auth_token cookie' : 'ims-user-token',
      source: cred.source,
      header: headerDescription(cred),
      locallyDecodable: !!claims,
      masked: !!cred.masked,
    },
  };
  if (claims) {
    out.credential.subject = claims.sub || null;
    out.credential.email = claims.email || null;
    out.credential.name = claims.name || null;
    out.credential.roles = claims.roles || null;
    out.credential.id = claims.jti || null;
    out.credential.issuer = claims.iss || null;
    out.credential.issued = claims.iat ? new Date(claims.iat * 1000).toISOString() : null;
    out.credential.expires = claims.exp ? new Date(claims.exp * 1000).toISOString() : null;
    out.credential.expiresIn = claims.exp ? relTime(claims.exp) : null;
  }

  // /profile is the whoami that works for BOTH credential types (verified live).
  const profileBase = isHelix5() ? HLX5_ADMIN_BASE : apiBase();
  const profRes = await apiFetch('GET', `${profileBase}/profile`, { cred });
  out.profile = profRes.ok ? ((profRes.json && profRes.json.profile) || profRes.json) : null;
  out.profileStatus = profRes.status;

  // Site access must be probed on a real site resource: GET /profile answers 200 even
  // for an unregistered key (verified live 2026-09-03), so it is a false positive.
  const org = flag('org');
  const site = flag('site', 'repo');
  if (typeof org === 'string' && typeof site === 'string' && org && site) {
    const probe = await apiFetch('GET', sourceUrl(org, site, ''), { cred });
    out.site = {
      org,
      site,
      sourceProbeStatus: probe.status,
      access: probe.ok,
      probedUrl: sourceUrl(org, site, ''),
    };
    if (probe.ok) {
      const cfgRes = await apiFetch('GET', siteConfigUrl(org, site), { cred });
      if (cfgRes.ok && cfgRes.json) {
        const registered = registeredIds(cfgRes.json);
        out.site.registeredKeyIds = registered.size
          ? [...new Set(Object.values(apiKeyEntries(cfgRes.json)).map((e) => e.id))].filter((id) =>
            [...jtiVariants(id)].some((v) => registered.has(v)))
          : [];
        out.site.thisKeyRegistered = claims && claims.jti
          ? [...jtiVariants(claims.jti)].some((v) => registered.has(v))
          : null;
      }
    } else if (!probe.ok && probe.status === 401 && cred.kind === 'apikey') {
      out.site.hint = 'key is probably not registered in access.admin.apiKeyId';
    }
  }

  if (flags.json) {
    cli.out(out);
    if (out.profileStatus !== 200 || (out.site && out.site.access === false)) process.exit(1);
    return;
  }

  section('Credential');
  kv('type', out.credential.type === 'api-key'
    ? `${color.green('admin API key')} (long-lived, up to 365 days)`
    : out.credential.type === 'ims-user-token'
      ? `${color.yellow('Adobe IMS user token')} (short-lived, ~20 minutes in practice)`
      : color.yellow('auth_token cookie (session-scoped)'));
  kv('source', out.credential.source);
  kv('header', out.credential.header);
  if (cred.masked) kv('value', color.dim('masked by the secrets manager — unmasked server-side by the fetch proxy'));
  if (claims) {
    if (claims.sub) kv('subject', claims.sub);
    if (claims.email) kv('email', `${claims.email}${claims.name ? ` (${claims.name})` : ''}`);
    if (claims.roles) kv('roles', [].concat(claims.roles).join(', '));
    if (claims.jti) kv('id', color.dim(claims.jti));
    if (claims.exp) kv('expires', `${new Date(claims.exp * 1000).toISOString()} ${color.dim(`(${relTime(claims.exp)})`)}`);
  } else {
    kv('expiry', color.dim('not decodable locally — reading it from /profile'));
  }

  section(`Identity (${profileBase}/profile)`);
  if (!profRes.ok) {
    kv('status', color.red(`HTTP ${profRes.status}`));
    console.log(color.dim(`    ${profRes.xError || 'credential rejected'}`));
  } else {
    const p = out.profile || {};
    kv('email', p.email || p.user_id || color.dim('—'));
    if (p.name) kv('name', p.name);
    if (p.roles) kv('roles', [].concat(p.roles).join(', '));
    if (p.iss) kv('issuer', p.iss);
    if (Number.isFinite(p.exp)) kv('expires', `${new Date(p.exp * 1000).toISOString()} ${color.dim(`(${relTime(p.exp)})`)}`);
    else if (Number.isFinite(Number(p.ttl))) kv('ttl', `${Number(p.ttl)}s ${color.dim(`(${relTime(Date.now() / 1000 + Number(p.ttl))})`)}`);
  }

  if (out.site) {
    section(`Site access (${out.site.org}/${out.site.site})`);
    if (out.site.access) {
      kv('source/', `${color.green('✓')} HTTP ${out.site.sourceProbeStatus}`);
      if (out.site.thisKeyRegistered === true) kv('registered', `${color.green('✓')} this key is in access.admin.apiKeyId`);
      else if (out.site.thisKeyRegistered === false) kv('registered', color.yellow('✗ this key is NOT in access.admin.apiKeyId'));
      else if (cred.kind === 'apikey') kv('registered', color.dim('unknown — the key id is masked locally; access above proves it works'));
    } else {
      kv('source/', color.red(`✗ HTTP ${out.site.sourceProbeStatus}`));
      if (out.site.hint) console.log(color.dim(`    ${out.site.hint} — aem-ext auth key list --org ${out.site.org} --site ${out.site.site}`));
    }
  } else {
    console.log('');
    console.log(color.dim('  Pass --org <o> --site <s> to probe real site access (GET /profile is not a valid probe).'));
  }

  if (profRes.status !== 200 || (out.site && !out.site.access)) process.exit(1);
}

// ── auth login (best effort) ──────────────────────────────────────────────────

async function cmdAuthLogin() {
  const base = isHelix5() ? HLX5_ADMIN_BASE : apiBase();
  // GET /login answers JSON (not HTML) with one link per IDP — verified live 2026-09-03.
  let linksRes;
  try {
    linksRes = await fetch(`${base}/login`, { headers: { Accept: 'application/json' } });
  } catch (err) {
    cli.die(`could not reach ${base}/login: ${err.message}`, { prefix: PREFIX });
  }
  const text = await linksRes.text();
  let links = null;
  try {
    links = (JSON.parse(text) || {}).links;
  } catch {
    cli.die(`${base}/login did not answer JSON (got ${text.slice(0, 120)})`, { prefix: PREFIX });
  }
  if (!links) cli.die(`${base}/login answered JSON without a links object`, { prefix: PREFIX });

  const idp = typeof flag('idp') === 'string' ? flag('idp') : 'adobe';
  const key = `login_${idp}${flags['select-account'] ? '_sa' : ''}`;
  const loginUrl = links[key] || links[`login_${idp}`];
  if (!loginUrl) {
    cli.die(
      `unknown --idp "${idp}". Available: ${Object.keys(links).filter((k) => !k.endsWith('_sa')).map((k) => k.replace(/^login_/, '')).join(', ')}`,
      { prefix: PREFIX },
    );
  }

  if (flags.json && flags['print-url']) {
    cli.out({ idp, loginUrl, links });
    return;
  }
  if (flags['print-url']) {
    section('Login URL');
    kv('idp', idp);
    kv('url', loginUrl);
    console.log('');
    console.log(color.dim('  Open it, complete the IDP flow, then re-run without --print-url to harvest the cookie.'));
    return;
  }

  // Browser-driven harvest. Marked BEST EFFORT: the cookie flow itself
  // (auth_token, OpenAPI security scheme AuthCookie, in: cookie) is documented and
  // the /login JSON above is verified, but this interactive path was NOT verified
  // live — see the PR body and SKILL.md.
  const browser = require('sliccy:browser');
  console.log('');
  console.log(`  Opening ${loginUrl} — complete the login in the browser.`);
  let tab;
  try {
    tab = await browser.ensureTab(loginUrl, { matchUrl: new RegExp(base.replace(/^https?:\/\//, '').replace(/\./g, '\\.')) });
  } catch (err) {
    cli.die(
      `could not drive the browser (${err.message}).\n` +
      `  Run 'aem-ext auth login --print-url', log in manually, then retry.\n` +
      '  Or skip cookies entirely and use a 365-day key: aem-ext auth key create ... --register --save-secret',
      { prefix: PREFIX },
    );
  }

  const deadlineMs = Date.now() + 120000;
  let cookie = null;
  while (Date.now() < deadlineMs) {
    try {
      cookie = await browser.cookie(tab, 'auth_token');
    } catch {
      cookie = null;
    }
    if (cookie) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!cookie) {
    cli.die(
      'no auth_token cookie appeared within 120s — the login did not complete.\n' +
      '  Retry, or prefer a 365-day API key: aem-ext auth key create --org <o> --site <s> --register --save-secret',
      { prefix: PREFIX },
    );
  }

  const value = typeof cookie === 'string' ? cookie : cookie.value;
  await skill.config({
    authToken: value,
    authTokenSavedAt: new Date().toISOString(),
    authHost: base.replace(/^https?:\/\//, ''),
  });

  if (flags.json) {
    cli.out({ stored: true, host: base, idp, cookie: 'auth_token', length: String(value).length });
    return;
  }
  section('Login');
  kv('idp', idp);
  kv('cookie', `${color.green('✓')} auth_token stored in the skill config (session-scoped)`);
  console.log('');
  console.log(color.dim('  Session cookies still expire. For long jobs use: aem-ext auth key create --register --save-secret'));
}

// ── auth key create ───────────────────────────────────────────────────────────

function parseRoles() {
  const raw = flag('roles');
  const allowed = isHelix5() ? [...H6_ROLES, ...H5_EXTRA_ROLES] : H6_ROLES;
  if (raw === undefined) return ['admin'];
  const roles = String(raw).split(',').map((r) => r.trim()).filter(Boolean);
  if (!roles.length) cli.die('--roles was empty', { prefix: PREFIX });
  for (const r of roles) {
    if (!allowed.includes(r)) {
      cli.die(`unknown role "${r}". Allowed: ${allowed.join(', ')}`, { prefix: PREFIX });
    }
  }
  return roles;
}

async function cmdKeyCreate() {
  const { org, site } = requireOrgSite('aem-ext auth key create --org <org> --site <site> [--roles admin] [--register]');
  const roles = parseRoles();
  const description = typeof flag('description') === 'string' && flag('description')
    ? String(flag('description'))
    : `aem-ext key created ${new Date().toISOString()}`;

  const body = { description, roles };
  const expiresIn = flag('expires-in');
  const warnings = [];
  let createUrl = apiKeysUrl(org, site);
  if (expiresIn !== undefined) {
    const n = parseInt(expiresIn, 10);
    if (!Number.isFinite(n) || n < 1 || n > 31536000) {
      cli.die('--expires-in must be an integer number of seconds between 1 and 31536000', { prefix: PREFIX });
    }
    body.expiresIn = n;
    if (!isHelix5()) {
      // verified live 2026-09-03: the Helix 6 property API rejects expiresIn with
      //   400 x-error: [admin] Error updating config: /apiKeys/<id> must NOT have additional properties
      // The Helix 5 create helper on admin.hlx.page, however, still answers for a
      // migrated Helix 6 site (200, with a "link: <https://api.aem.live/>;
      // rel=successor-version" header) and DOES honour expiresIn — verified live:
      // expiresIn 86400 produced expiration = created + 24h, the key landed in the
      // same Helix 6 config store, and it worked on api.aem.live once registered.
      // So a custom expiry is minted through the compat route instead of dropped.
      createUrl = `${HLX5_ADMIN_BASE}/config/${org}/sites/${site}/apiKeys.json`;
      warnings.push(
        'api.aem.live rejects expiresIn (HTTP 400), so this key was minted through the ' +
        `Helix 5 compat route on ${HLX5_ADMIN_BASE}, which honours it. It lands in the same site config.`,
      );
    }
  }

  // Only an IMS user token can write site config.
  const cred = await imsCredential();
  let res = await apiFetch('POST', createUrl, {
    cred,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  if (!res.ok && body.expiresIn !== undefined && !isHelix5()) {
    // Compat route gone or refusing: fall back to the Helix 6 property API, which
    // only accepts a request without expiresIn (and then always issues a 1-year key).
    warnings.push(
      `the Helix 5 compat route answered ${res.status}${res.xError ? ` (${res.xError})` : ''}; ` +
      'retried on api.aem.live without expiresIn, so the key lasts 1 year.',
    );
    delete body.expiresIn;
    res = await apiFetch('POST', apiKeysUrl(org, site), {
      cred,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }
  dieOnError(res, `creating an API key for ${org}/${site}`);
  const key = res.json || {};
  if (!key.value) {
    cli.die(
      `the create call returned ${res.status} without a "value" — the key secret is only ever returned once and is now unrecoverable. Delete the id and retry: ${key.id || '(no id)'}`,
      { prefix: PREFIX },
    );
  }

  let registered = false;
  let roleMapBefore = null;
  let roleMapAfter = null;
  if (flags.register) {
    if (isHelix5()) {
      warnings.push('--register is a Helix 6 requirement; skipped on Helix 5 where keys are enabled automatically.');
    } else {
      const config = await fetchSiteConfig(org, site, cred);
      roleMapBefore = roleSummary(((config.access || {}).admin) || {});
      const { admin } = mergeAdminAccess(config, { add: key.id });
      await writeAdminAccess(org, site, admin, cred);
      roleMapAfter = roleSummary(admin);
      registered = true;
    }
  }

  let savedSecret = null;
  const saveSecret = flag('save-secret');
  if (saveSecret !== undefined) {
    const name = typeof saveSecret === 'string' && saveSecret.trim() ? saveSecret.trim() : SECRET_NAME;
    if (!NAME_RE.test(name)) cli.die(`invalid --save-secret name "${name}"`, { prefix: PREFIX });
    // exec.spawn — no shell parsing, so the key can never be re-interpreted (§7).
    const r = await exec.spawn(['secret', 'set', name, key.value, '--domain', SECRET_DOMAINS]);
    if (r.exitCode !== 0) {
      warnings.push(`could not store the key in secret "${name}": ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
    } else {
      savedSecret = name;
    }
  }

  if (flags.json) {
    for (const w of warnings) cli.warn(w); // warnings go to stderr, JSON stays clean
    // The value is included in --json exactly once, for the same reason as below:
    // the API never returns it again. Redirect this to a file, do not log it.
    cli.out({ ...key, registered, savedSecret, warnings });
    return;
  }

  section('API key created');
  kv('id', color.dim(key.id || '—'));
  kv('subject', key.subject || `${org}/${site}`);
  kv('roles', [].concat(key.roles || roles).join(', '));
  kv('description', key.description || description);
  kv('created', isoOrDash(key.created));
  kv('expiration', isoOrDash(key.expiration));
  kv('registered', registered
    ? `${color.green('✓')} added to access.admin.apiKeyId`
    : color.yellow('✗ NOT registered — on Helix 6 the key will return 401 until you run: ' +
      `aem-ext auth key register --org ${org} --site ${site} --id '${key.id}'`));
  if (roleMapBefore) kv('role map', `${roleMapBefore} → ${roleMapAfter} ${color.dim('(preserved through the overwrite)')}`);

  if (savedSecret) {
    section('Stored');
    kv('secret', `${color.green('✓')} ${savedSecret} (domains: ${SECRET_DOMAINS})`);
    console.log(color.dim('    The value is NOT printed — aem-ext resolves it from the secrets manager.'));
  } else {
    // DELIBERATE EXCEPTION to "nothing secret to stdout" (repo rule / #203): the AEM
    // API returns this value exactly once and never again, so not printing it would
    // silently discard the credential and make the whole feature useless. `--save-secret`
    // is the recommended path and suppresses this block.
    section('Key value — shown ONCE, never retrievable again');
    console.log(`    ${key.value}`);
    console.log('');
    console.log(color.yellow('    Copy it now. AEM does not return this value a second time; config.json'));
    console.log(color.yellow('    lists metadata only. Next time prefer --save-secret to keep it out of logs:'));
    console.log(color.dim(`      secret set ${SECRET_NAME} <key> --domain "${SECRET_DOMAINS}"`));
  }

  for (const w of warnings) cli.warn(w);
}

// ── auth key list ─────────────────────────────────────────────────────────────

async function cmdKeyList() {
  const { org, site } = requireOrgSite('aem-ext auth key list --org <org> --site <site>');
  const config = await fetchSiteConfig(org, site);
  const entries = apiKeyEntries(config);

  if (flags.json) {
    cli.out({
      org,
      site,
      registeredIds: [...new Set(
        (((config.access || {}).admin || {}).apiKeyId) || [],
      )],
      keys: entries.map((e) => ({
        id: e.id,
        objectKey: e.objectKey,
        description: e.description || null,
        roles: e.roles || null,
        created: e.created || null,
        expiration: e.expiration || null,
        registered: e.registered,
      })),
    });
    return;
  }

  section(`API keys — ${org}/${site}`);
  if (!entries.length) {
    console.log(color.dim('    No API keys. Create one: aem-ext auth key create ' +
      `--org ${org} --site ${site} --register --save-secret`));
    return;
  }
  for (const e of entries) {
    rule();
    kv('id', color.dim(e.id));
    kv('description', e.description || color.dim('—'));
    kv('roles', [].concat(e.roles || []).join(', ') || color.dim('—'));
    kv('created', isoOrDash(e.created));
    kv('expiration', `${isoOrDash(e.expiration)}${e.expiration ? ` ${color.dim(`(${relTime(Date.parse(e.expiration) / 1000)})`)}` : ''}`);
    kv('registered', e.registered
      ? `${color.green('✓')} in access.admin.apiKeyId`
      : color.yellow('✗ not registered — returns 401 on Helix 6 site resources'));
  }
  rule();
  console.log(color.dim('    Secret values are never returned by the API; only the create call shows them.'));
}

// ── auth key register ─────────────────────────────────────────────────────────

async function cmdKeyRegister() {
  const { org, site } = requireOrgSite('aem-ext auth key register --org <org> --site <site> --id <jti>');
  const id = flag('id');
  if (typeof id !== 'string' || !id) cli.die('missing --id <jti>', { prefix: PREFIX });

  const cred = await imsCredential();
  const config = await fetchSiteConfig(org, site, cred);
  const known = apiKeyEntries(config);
  if (known.length && !known.some((e) => jtiVariants(e.id).has(id) || jtiVariants(id).has(e.objectKey))) {
    cli.die(
      `no key with id "${id}" exists on ${org}/${site}.\n` +
      `  List them: aem-ext auth key list --org ${org} --site ${site}`,
      { prefix: PREFIX },
    );
  }

  const before = roleSummary(((config.access || {}).admin) || {});
  const { admin, previous, next } = mergeAdminAccess(config, { add: id });
  if (previous.length === next.length) {
    if (flags.json) { cli.out({ org, site, id, registered: true, changed: false }); return; }
    section('Already registered');
    kv('id', color.dim(id));
    kv('apiKeyId', next.join(', '));
    return;
  }
  await writeAdminAccess(org, site, admin, cred);

  // Read back — the write is a whole-object overwrite, so confirm the role map survived.
  const after = await fetchSiteConfig(org, site, cred);
  const afterAdmin = ((after.access || {}).admin) || {};

  if (flags.json) {
    cli.out({ org, site, id, registered: registeredIds(after).has(id) || registeredIds(after).has(urlSafeJti(id)),
      apiKeyId: afterAdmin.apiKeyId || [], roleMap: afterAdmin.role || {} });
    return;
  }
  section('Registered');
  kv('id', color.dim(id));
  kv('apiKeyId', [].concat(afterAdmin.apiKeyId || []).join(', '));
  kv('role map', `${before} → ${roleSummary(afterAdmin)} ${color.dim('(preserved)')}`);
  console.log('');
  console.log(color.dim('    The key answers 200 on site resources within a few seconds.'));
}

// ── auth key delete ───────────────────────────────────────────────────────────

async function cmdKeyDelete() {
  const { org, site } = requireOrgSite('aem-ext auth key delete --org <org> --site <site> --id <jti> --confirm');
  const id = flag('id');
  if (typeof id !== 'string' || !id) cli.die('missing --id <jti>', { prefix: PREFIX });

  const cred = await imsCredential();
  const config = await fetchSiteConfig(org, site, cred);
  const entry = apiKeyEntries(config).find((e) => jtiVariants(e.id).has(id) || jtiVariants(id).has(e.objectKey));
  if (!entry) {
    cli.die(
      `no key with id "${id}" on ${org}/${site}.\n` +
      `  List them: aem-ext auth key list --org ${org} --site ${site}`,
      { prefix: PREFIX },
    );
  }

  if (!flags.confirm) {
    section('Would revoke (nothing changed)');
    kv('id', color.dim(entry.id));
    kv('description', entry.description || color.dim('—'));
    kv('roles', [].concat(entry.roles || []).join(', ') || color.dim('—'));
    kv('expiration', isoOrDash(entry.expiration));
    kv('registered', entry.registered ? 'yes — will also be removed from access.admin.apiKeyId' : 'no');
    console.log('');
    console.log(color.yellow('  Revoking is immediate and irreversible; any job using this key starts failing.'));
    console.log(color.dim(`  Re-run with --confirm to proceed.`));
    process.exit(1);
  }

  const res = await apiFetch('DELETE', apiKeyUrl(org, site, entry.id), { cred });
  dieOnError(res, `deleting API key ${entry.id}`);

  // Also drop the id from access.admin.apiKeyId, merge-preserving.
  let deregistered = false;
  if (entry.registered && !isHelix5()) {
    const fresh = await fetchSiteConfig(org, site, cred);
    const { admin, previous, next } = mergeAdminAccess(fresh, { remove: entry.id });
    if (previous.length !== next.length) {
      await writeAdminAccess(org, site, admin, cred);
      deregistered = true;
    }
  }

  if (flags.json) {
    cli.out({ org, site, id: entry.id, status: res.status, deleted: true, deregistered });
    return;
  }
  section('Revoked');
  kv('id', color.dim(entry.id));
  kv('status', `${color.green('✓')} HTTP ${res.status}`);
  kv('access', deregistered ? `${color.green('✓')} removed from access.admin.apiKeyId` : color.dim('was not registered'));
}

// ── content verbs (thin mirrors of aem.jsh, on the new credential) ────────────

function parseAemUrl(url) {
  const m = String(url).match(/^https?:\/\/(.+?)--(.+?)--([^.]+)\.(aem|hlx)\.(page|live)\/?(.*)$/);
  if (!m) return null;
  return { ref: m[1], site: m[2], org: m[3], path: m[6] || '' };
}

function resolveTarget(usage) {
  const first = words[1];
  if (typeof first === 'string' && /^https?:\/\//.test(first)) {
    const eds = parseAemUrl(first);
    if (!eds) cli.die(`could not parse "${first}" as an EDS URL`, { prefix: PREFIX });
    return { ...eds };
  }
  const org = flag('org');
  const site = flag('site', 'repo');
  if (!first || typeof org !== 'string' || typeof site !== 'string' || !org || !site) {
    cli.die(`usage: ${usage}`, { prefix: PREFIX });
  }
  if (!NAME_RE.test(org) || !NAME_RE.test(site)) {
    cli.die(`invalid --org/--site: expected ${NAME_RE}`, { prefix: PREFIX });
  }
  const ref = typeof flag('ref') === 'string' ? flag('ref') : 'main';
  return { org, site, ref, path: String(first).replace(/^\//, '') };
}

function documentPath(p) {
  let out = String(p).replace(/^\//, '').replace(/\.html$/, '');
  if (out === '' || out.endsWith('/')) out += 'index';
  return `${out}.html`;
}

function webPath(p) {
  return String(p).replace(/^\//, '').replace(/\.html$/, '');
}

async function cmdList() {
  const t = resolveTarget('aem-ext list <url-or-path> [--org <o> --site <s>]');
  const dir = t.path.replace(/\/$/, '');
  // Helix 6: the TRAILING SLASH is what makes it a listing; without it → 404.
  const url = isHelix5()
    ? `${HLX5_DA_BASE}/list/${t.org}/${t.site}/${dir}`
    : sourceUrl(t.org, t.site, dir ? `${dir}/` : '');
  const res = await apiFetch('GET', url);
  dieOnError(res, `listing ${t.org}/${t.site}/${dir || ''}`);

  const entries = Array.isArray(res.json) ? res.json : (res.json && res.json.entries) || [];
  if (flags.json) { cli.out(res.json); return; }
  section(`${t.org}/${t.site}${dir ? `/${dir}` : ''}`);
  if (!entries.length) { console.log(color.dim('    (empty)')); return; }
  for (const e of entries) {
    const name = e.path || e.name || '';
    const ct = e['content-type'] || '';
    const isDir = ct === 'application/folder' || name.endsWith('/');
    const type = isDir ? 'dir' : (e.ext || ct.split('/').pop() || 'file');
    console.log(`    ${color.dim(type.padEnd(6))} ${isDir ? color.cyan(name) : name}`);
  }
}

async function cmdGet() {
  const t = resolveTarget('aem-ext get <url-or-path> [--output <vfs-path>]');
  const res = await apiFetch('GET', sourceUrl(t.org, t.site, documentPath(t.path)));
  dieOnError(res, `reading ${t.org}/${t.site}/${documentPath(t.path)}`);
  const out = flag('output', 'o');
  if (typeof out === 'string' && out) {
    await fs.writeFile(out, res.text);
    console.log('');
    console.log(`  ${color.green('✓')} saved ${res.text.length} bytes to ${out}`);
    return;
  }
  if (flags.json) { cli.out({ path: documentPath(t.path), bytes: res.text.length, html: res.text }); return; }
  process.stdout.write(res.text);
}

async function cmdPut() {
  const t = resolveTarget('aem-ext put <url-or-path> <vfs-file>');
  const file = words[2];
  if (!file) cli.die('usage: aem-ext put <url-or-path> <vfs-file>', { prefix: PREFIX });
  const html = await fs.readFile(file);
  const path = documentPath(t.path);
  // Source Bus: raw body, Content-Type: text/html, 201 on create AND overwrite.
  const res = await apiFetch('PUT', sourceUrl(t.org, t.site, path), {
    contentType: 'text/html',
    body: html,
  });
  dieOnError(res, `writing ${t.org}/${t.site}/${path}`);
  if (flags.json) { cli.out({ path, status: res.status, bytes: html.length }); return; }
  section('Saved');
  kv('path', path);
  kv('status', `${color.green('✓')} HTTP ${res.status}`);
  kv('bytes', String(html.length));
}

async function cmdOperation(verb, label) {
  const t = resolveTarget(`aem-ext ${label} <url-or-path>`);
  const path = webPath(t.path) || 'index';
  const method = verb === 'status' ? 'GET' : 'POST';
  const res = await apiFetch(method, operationUrl(verb, t.org, t.site, t.ref || 'main', path));
  dieOnError(res, `${label} ${t.org}/${t.site}/${path}`);
  if (flags.json) { cli.out(res.json ?? res.text); return; }
  const data = res.json || {};
  section(label.charAt(0).toUpperCase() + label.slice(1));
  kv('path', data.webPath || `/${path}`);
  for (const bus of ['preview', 'live']) {
    if (data[bus]) {
      const st = data[bus].status;
      const mark = st === 200 ? color.green('✓') : color.dim('·');
      kv(bus, `${mark} ${st} ${data[bus].url || ''}`);
    }
  }
  if (!data.preview && !data.live) kv('status', `${color.green('✓')} HTTP ${res.status}`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────

async function main() {
  const cmd = words[0] || '';
  if (flags.help || flags.h || !cmd || cmd === 'help') cli.help(HELP);

  if (cmd === 'auth') {
    const sub = words[1] || '';
    if (sub === 'status') return cmdAuthStatus();
    if (sub === 'login') return cmdAuthLogin();
    if (sub === 'key') {
      const action = words[2] || '';
      if (action === 'create') return cmdKeyCreate();
      if (action === 'list') return cmdKeyList();
      if (action === 'register') return cmdKeyRegister();
      if (action === 'delete' || action === 'revoke') return cmdKeyDelete();
      cli.die(`unknown command: auth key ${action || '(none)'}\n  Try: create | list | register | delete`, { prefix: PREFIX });
    }
    cli.die(`unknown command: auth ${sub || '(none)'}\n  Try: status | login | key`, { prefix: PREFIX });
  }

  if (cmd === 'list' || cmd === 'ls') return cmdList();
  if (cmd === 'get') return cmdGet();
  if (cmd === 'put') return cmdPut();
  if (cmd === 'status') return cmdOperation('status', 'status');
  if (cmd === 'preview') return cmdOperation('preview', 'preview');
  if (cmd === 'publish') return cmdOperation('live', 'publish');

  cli.die(`unknown command: ${cmd}\n  Run 'aem-ext --help' for usage.`, { prefix: PREFIX });
}

try {
  await main();
} catch (err) {
  if (err?.name === 'NodeExitError') throw err; // MANDATORY — cli.die/process.exit unwind through here
  cli.die(err?.message || String(err), { prefix: PREFIX });
}
