// gcloud.jsh — a subset of the Google Cloud API, authenticated via the
// gcloud CLI's own public "Cloud SDK" OAuth client through oauth-token --intercept.
//
// Auth model (mirrors `gcloud auth login`): the Google Cloud SDK ships a public
// "desktop app" OAuth client whose id/secret are baked into the gcloud source
// (googlecloudsdk/core/config.py: CLOUDSDK_CLIENT_ID / CLOUDSDK_CLIENT_NOTSOSECRET).
// Desktop clients are non-confidential — Google protects them with loopback
// redirect-URI matching, not secrecy of the "secret". We reuse that client so a
// human completing the standard Google consent screen yields a real
// cloud-platform-scoped token, exchanged + refreshed exactly like gcloud does.

const cli   = require('sliccy:cli');
const fmt   = require('sliccy:fmt');
const skill = require('sliccy:skill');
const exec  = require('sliccy:exec');
const c     = require('sliccy:color');

// ─── Constants ─────────────────────────────────────────────────────────────

// Public Cloud SDK OAuth client (see header). If Google ever rotates these,
// re-check the gcloud source constants CLOUDSDK_CLIENT_ID /
// CLOUDSDK_CLIENT_NOTSOSECRET.
const CLIENT_ID     = '32555940559.apps.googleusercontent.com';
const CLIENT_SECRET = 'ZmssLNjJy2998hD4CTg2ejr2';
const AUTH_URL      = 'https://accounts.google.com/o/oauth2/auth';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const REVOKE_URL    = 'https://oauth2.googleapis.com/revoke';
// Loopback redirect. Desktop-app clients accept 127.0.0.1 on any port; we fix
// a port so the redirect-pattern below matches deterministically.
const REDIRECT_PORT = 8085;
const REDIRECT_URI  = `http://127.0.0.1:${REDIRECT_PORT}/`;
const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');

// ─── Token management ────────────────────────────────────────────────────────

async function loadConfig() {
  // Must await before the `|| {}` fallback — skill.config() returns a Promise
  // (always truthy); `skill.config() || {}` never falls back and reading a
  // property off a null resolved config throws (confirmed-live garmin bug).
  return (await skill.config()) || {};
}

async function saveConfig(updates) {
  const cur = await loadConfig();
  await skill.config({ ...cur, ...updates });
}

/** Flag values are strings only when a value was actually supplied; single-dash
 *  short flags and value-less long flags come back as boolean true. Coerce those
 *  to undefined so they never leak into URLs or config. */
function str(v) { return typeof v === 'string' ? v : undefined; }

async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
  });
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) {
    cli.die(`Code exchange failed (${res.status}): ${await res.text()}`, { prefix: 'gcloud' });
  }
  return await res.json();
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Refresh failed (${res.status}): ${await res.text()}`);
  }
  return await res.json();
}

/** Returns a valid access token, refreshing if needed. Dies actionably otherwise. */
async function getAccessToken() {
  const cfg = await loadConfig();
  if (!cfg.refresh_token) {
    cli.die('Not logged in. Run: gcloud login', { prefix: 'gcloud' });
  }
  const now = Date.now();
  if (cfg.access_token && cfg.expires_at && now < cfg.expires_at - 60_000) {
    return cfg.access_token;
  }
  try {
    const tok = await refreshAccessToken(cfg.refresh_token);
    const updates = {
      access_token: tok.access_token,
      expires_at:   Date.now() + (tok.expires_in || 3600) * 1000,
    };
    if (tok.refresh_token) updates.refresh_token = tok.refresh_token;
    await saveConfig(updates);
    return updates.access_token;
  } catch (err) {
    cli.die(`Could not refresh token: ${err.message}\nRun: gcloud login`, { prefix: 'gcloud' });
  }
}

/**
 * Guard against leaking the account's cloud-platform Bearer token to arbitrary
 * hosts (e.g. `gcloud api https://attacker.example/`). Every credentialed call
 * funnels through gfetch, so validating here covers the raw `api` passthrough
 * and every built-in command. Allow only HTTPS Google API hosts.
 */
function assertGoogleHost(url) {
  let u;
  try { u = new URL(url); }
  catch { cli.die(`Invalid URL: ${url}`, { prefix: 'gcloud' }); }
  const okHost = u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com');
  if (u.protocol !== 'https:' || !okHost) {
    cli.die(
      `Refusing to send Google credentials to ${u.protocol}//${u.hostname}. ` +
      `Only HTTPS *.googleapis.com hosts are allowed.`,
      { prefix: 'gcloud' },
    );
  }
}

/** Authenticated JSON fetch against any Google API host. Full URL in, parsed body out. */
async function gfetch(url, opts = {}) {
  assertGoogleHost(url);
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        'application/json',
    ...(opts.headers || {}),
  };
  let body = opts.body;
  if (body && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  const res = await fetch(url, { method: opts.method || 'GET', headers, body });
  const text = await res.text();
  if (res.ok) {
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { raw: text }; }
  }

  // Error path — parse Google's structured error to give a targeted message
  // rather than a raw JSON dump or a blanket "session expired" for every 403.
  let err = {};
  try { err = (JSON.parse(text).error) || {}; } catch { /* non-JSON */ }
  const msg = err.message || text || res.statusText;
  // Gather every reason string Google scatters across status/errors[]/details[].
  const reasons = [
    err.status,
    ...(err.errors || []).map(e => e?.reason),
    ...(err.details || []).map(d => d?.reason),
  ].filter(Boolean);
  const has = re => reasons.some(r => re.test(r)) || re.test(msg);
  const label = err.status || reasons[0] || '';

  // Credential problems (vs. project/IAM state) — the only case that warrants re-login.
  if (res.status === 401 || has(/UNAUTHENTICATED|ACCESS_TOKEN|authError|invalid.?token/i)) {
    cli.die(`Google rejected the token (${res.status}). Run: gcloud login`, { prefix: 'gcloud' });
  }
  if (has(/SERVICE_DISABLED|accessNotConfigured/)) {
    const svc = err.details?.find(d => d?.metadata?.service)?.metadata?.service || 'the required API';
    cli.die(
      `${svc} is not enabled on this project.\nEnable it, then retry:\n  gcloud services enable ${svc} --confirm\n(or enable it in the Cloud Console).`,
      { prefix: 'gcloud' },
    );
  }
  cli.die(`Google returned ${res.status}${label ? ' (' + label + ')' : ''}: ${msg}`, { prefix: 'gcloud' });
}

/** Fully paginate a Google list endpoint that uses ?pageToken / .nextPageToken. */
async function gfetchAll(url, itemsKey) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    const sep = url.includes('?') ? '&' : '?';
    const pageUrl = pageToken ? `${url}${sep}pageToken=${encodeURIComponent(pageToken)}` : url;
    const data = await gfetch(pageUrl);
    const items = data[itemsKey] || data.items || [];
    if (Array.isArray(items)) out.push(...items);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

/** Resolve the active project: --project flag > stored config. Dies if unset. */
async function requireProject(flags) {
  const cfg = await loadConfig();
  // parseFlags returns boolean true for single-dash flags and never captures
  // their value, so only the long --project form is honored here; str() also
  // stops a bare --project (no value → true) from leaking "true" into a URL.
  const proj = str(flags.project) || cfg.project;
  if (!proj) {
    cli.die(
      'No project set. Pass --project <id> or run: gcloud config set-project <id>',
      { prefix: 'gcloud' },
    );
  }
  return proj;
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function cmdLogin() {
  console.log(c.cyan('Opening Google sign-in…'));
  console.log(c.dim('A browser tab will open. Complete the Google consent screen, then return here.'));

  const authorizeUrl =
    `${AUTH_URL}?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&access_type=offline&prompt=consent` +
    `&scope=${encodeURIComponent(SCOPES)}`;

  const { stdout, stderr, exitCode } = await exec.spawn([
    'oauth-token', '--intercept',
    '--authorize-url', authorizeUrl,
    '--redirect-pattern', `http://127.0.0.1:${REDIRECT_PORT}/*`,
  ]);

  if (exitCode !== 0) {
    cli.die(`oauth-token intercept failed:\n${stderr}`, { prefix: 'gcloud' });
  }

  const redirectUrl = (stdout || '').trim();
  const m = redirectUrl.match(/[?&]code=([^&\s]+)/);
  if (!m) {
    cli.die(`Could not find authorization code in redirect URL.\nGot: ${redirectUrl}`, { prefix: 'gcloud' });
  }
  const code = decodeURIComponent(m[1]);

  console.log(c.cyan('Exchanging authorization code for tokens…'));
  const tok = await exchangeCode(code);
  if (!tok.refresh_token) {
    cli.die(
      'No refresh_token returned. Re-run gcloud login and ensure you approve the consent screen (access_type=offline&prompt=consent).',
      { prefix: 'gcloud' },
    );
  }

  await saveConfig({
    refresh_token: tok.refresh_token,
    access_token:  tok.access_token,
    expires_at:    Date.now() + (tok.expires_in || 3600) * 1000,
  });

  // Resolve and show the authenticated identity.
  let email = '';
  try {
    const info = await gfetch('https://openidconnect.googleapis.com/v1/userinfo');
    email = info.email || '';
  } catch { /* non-fatal */ }

  console.log(c.green('✓ Logged in to Google Cloud') + (email ? c.dim(`  (${email})`) : ''));
  console.log(c.dim('  Refresh token stored in skill config. Access tokens auto-refresh.'));
}

async function cmdWhoami(flags) {
  const cfg = await loadConfig();
  if (!cfg.refresh_token) cli.die('Not logged in. Run: gcloud login', { prefix: 'gcloud' });
  const info = await gfetch('https://openidconnect.googleapis.com/v1/userinfo');
  if (flags.json) { cli.out({ ...info, project: cfg.project || null }); return; }
  console.log('');
  console.log(`  ${c.cyan(c.bold(info.email || info.sub || 'unknown'))}`);
  if (info.name) console.log(`  ${c.dim(info.name)}`);
  console.log(`  ${c.dim('project: ' + (cfg.project || '(unset — gcloud config set-project <id>)'))}`);
}

async function cmdLogout() {
  const cfg = await loadConfig();
  if (cfg.refresh_token) {
    try {
      await fetch(REVOKE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ token: cfg.refresh_token }).toString(),
      });
    } catch { /* best effort */ }
  }
  await skill.config({ project: cfg.project }); // keep project, drop tokens
  console.log(c.green('✓ Logged out (tokens revoked and cleared).'));
}

async function cmdConfig(positional, flags) {
  const cfg = await loadConfig();
  const sub = positional[0];
  // `gcloud config set-project <id>` or `gcloud config set project <id>`
  if (sub === 'set-project' || (sub === 'set' && positional[1] === 'project')) {
    const id = sub === 'set-project' ? positional[1] : positional[2];
    if (!id) cli.die('usage: gcloud config set-project <project-id>', { prefix: 'gcloud' });
    await saveConfig({ project: id });
    console.log(c.green(`✓ Active project set to ${c.bold(id)}`));
    return;
  }
  // show
  if (flags.json) { cli.out({ project: cfg.project || null, logged_in: !!cfg.refresh_token }); return; }
  console.log('');
  console.log(`  ${c.dim('project')}    ${cfg.project || c.dim('(unset)')}`);
  console.log(`  ${c.dim('logged in')}  ${cfg.refresh_token ? c.green('yes') : c.red('no')}`);
}

async function cmdProjectsList(flags) {
  const projects = await gfetchAll('https://cloudresourcemanager.googleapis.com/v1/projects', 'projects');
  if (flags.json) { cli.out(projects); return; }
  if (!projects.length) { console.log(c.dim('  No projects found.')); return; }
  console.log('');
  for (const p of projects) {
    const state = p.lifecycleState === 'ACTIVE' ? c.green('●') : c.dim('○');
    console.log(`  ${state} ${c.cyan(c.bold(p.projectId))}  ${c.dim(p.name || '')}  ${c.dim('num:' + (p.projectNumber || '?'))}`);
  }
}

async function cmdComputeInstances(flags) {
  const project = await requireProject(flags);
  // aggregatedList spans all zones, but large fleets are paginated: the
  // response carries a nextPageToken and .items is a zone-keyed OBJECT (not an
  // array), so gfetchAll can't be used directly — follow the tokens by hand.
  const base = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/aggregated/instances`;
  const rows = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    const pageUrl = pageToken ? `${base}?pageToken=${encodeURIComponent(pageToken)}` : base;
    const data = await gfetch(pageUrl);
    for (const [zoneKey, bucket] of Object.entries(data.items || {})) {
      for (const inst of (bucket.instances || [])) {
        rows.push({ ...inst, _zone: (inst.zone || zoneKey).split('/').pop() });
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  const zoneFilter = str(flags.zone);
  const filtered = zoneFilter ? rows.filter(r => r._zone === zoneFilter) : rows;
  if (flags.json) { cli.out(filtered); return; }
  if (!filtered.length) { console.log(c.dim('  No instances found.')); return; }
  console.log('');
  for (const i of filtered) {
    const up = i.status === 'RUNNING' ? c.green('●') : c.dim('○');
    const machine = (i.machineType || '').split('/').pop();
    console.log(`  ${up} ${c.cyan(c.bold(i.name))}  ${c.dim(i._zone)}  ${c.dim(machine)}  ${c.dim(i.status)}`);
  }
}

async function cmdComputeZones(flags) {
  const project = await requireProject(flags);
  const zones = await gfetchAll(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/zones`, 'items');
  if (flags.json) { cli.out(zones); return; }
  if (!zones.length) { console.log(c.dim('  No zones found.')); return; }
  console.log('');
  for (const z of zones) {
    const up = z.status === 'UP' ? c.green('●') : c.dim('○');
    console.log(`  ${up} ${c.cyan(z.name)}  ${c.dim((z.region || '').split('/').pop())}`);
  }
}

async function cmdBuckets(flags) {
  const project = await requireProject(flags);
  const buckets = await gfetchAll(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(project)}`, 'items');
  if (flags.json) { cli.out(buckets); return; }
  if (!buckets.length) { console.log(c.dim('  No buckets found.')); return; }
  console.log('');
  for (const b of buckets) {
    console.log(`  ${c.cyan(c.bold('gs://' + b.name))}  ${c.dim(b.location || '')}  ${c.dim(b.storageClass || '')}`);
  }
}

async function cmdServicesEnable(positional, flags) {
  const project = await requireProject(flags);
  const api = positional[1]; // positional[0] === 'enable'
  if (!api || !/^[a-z0-9.-]+\.googleapis\.com$/.test(api)) {
    cli.die('usage: gcloud services enable <api.googleapis.com> --confirm', { prefix: 'gcloud' });
  }
  if (!flags.confirm) {
    console.log('');
    console.log(c.yellow(`  Would enable ${c.bold(api)} on project ${c.bold(project)}.`));
    console.log(c.dim('  Re-run with --confirm to apply.'));
    return;
  }
  await gfetch(`https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project)}/services/${encodeURIComponent(api)}:enable`, { method: 'POST', body: {} });
  console.log(c.green(`✓ Enabled ${c.bold(api)} on ${project}`) + c.dim('  (may take a minute to propagate)'));
}

async function cmdServices(positional, flags) {
  if (positional[0] === 'enable') return await cmdServicesEnable(positional, flags);
  const project = await requireProject(flags);
  const svcs = await gfetchAll(
    `https://serviceusage.googleapis.com/v1/projects/${encodeURIComponent(project)}/services?filter=state:ENABLED`,
    'services',
  );
  if (flags.json) { cli.out(svcs); return; }
  if (!svcs.length) { console.log(c.dim('  No enabled services found.')); return; }
  console.log('');
  for (const s of svcs) {
    const name = (s.config?.name) || s.name.split('/').pop();
    console.log(`  ${c.green('✓')} ${c.cyan(name)}  ${c.dim(s.config?.title || '')}`);
  }
}

async function cmdRun(flags) {
  const project = await requireProject(flags);
  const region = str(flags.region) || '-'; // '-' = all regions
  const svcs = await gfetchAll(
    `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/services`,
    'services',
  );
  if (flags.json) { cli.out(svcs); return; }
  if (!svcs.length) { console.log(c.dim('  No Cloud Run services found.')); return; }
  console.log('');
  for (const s of svcs) {
    const name = (s.name || '').split('/').pop();
    const loc  = (s.name || '').split('/locations/')[1]?.split('/')[0] || '';
    console.log(`  ${c.cyan(c.bold(name))}  ${c.dim(loc)}  ${c.dim(s.uri || '')}`);
  }
}

// ── Cloud DNS ────────────────────────────────────────────────────────────────

const DNS_BASE = 'https://dns.googleapis.com/dns/v1';

/** Ensure a DNS name is a FQDN with the trailing dot Cloud DNS requires. */
function fqdn(name) {
  return name.endsWith('.') ? name : `${name}.`;
}

/** TXT rrdatas must be double-quoted; quote any value that isn't already. */
function normalizeRrdata(type, data) {
  if (type.toUpperCase() === 'TXT' && !/^".*"$/.test(data)) {
    return `"${data.replace(/"/g, '\\"')}"`;
  }
  return data;
}

/** Parse --routing-policy-data "WEIGHT:rrdata[,rrdata];WEIGHT:rrdata…" into
 *  weighted-round-robin items. Each ';'-separated segment is one weighted
 *  target group; ','-separated rrdatas share that weight. */
function parseWrrData(type, dataStr) {
  const items = dataStr.split(';').map(s => s.trim()).filter(Boolean).map(seg => {
    const ci = seg.indexOf(':');
    if (ci < 0) {
      cli.die(`Invalid --routing-policy-data segment "${seg}" (expected WEIGHT:rrdata[,rrdata]).`, { prefix: 'gcloud' });
    }
    const weight = Number(seg.slice(0, ci).trim());
    if (!Number.isFinite(weight)) cli.die(`Invalid weight in "${seg}".`, { prefix: 'gcloud' });
    const rrdatas = seg.slice(ci + 1).split(',').map(x => x.trim()).filter(Boolean)
      .map(d => normalizeRrdata(type, d));
    if (!rrdatas.length) cli.die(`No rrdata in segment "${seg}".`, { prefix: 'gcloud' });
    return { weight, rrdatas };
  });
  if (!items.length) cli.die('--routing-policy-data produced no items.', { prefix: 'gcloud' });
  return items;
}

/** Plain (uncolored) per-line description of an rrset's data for change
 *  previews — renders routingPolicy targets, not just top-level rrdatas. */
function changeDetailLines(r) {
  if (Array.isArray(r.rrdatas) && r.rrdatas.length) return r.rrdatas.slice();
  const rp = r.routingPolicy;
  if (!rp) return ['(no data)'];
  const lines = [];
  if (rp.wrr?.items) {
    lines.push('routing: weighted (wrr)');
    let i = 0;
    for (const it of rp.wrr.items) {
      const tgt = (it.rrdatas || []).join(', ') || '(empty)';
      const w = it.weight ?? 0;
      lines.push(`  [${i}] weight ${w}${w === 0 ? ' (inactive)' : ''}: ${tgt}`);
      i++;
    }
  } else if (rp.geo?.items) {
    lines.push('routing: geo');
    for (const it of rp.geo.items) {
      lines.push(`  ${it.location || '?'}: ${(it.rrdatas || []).join(', ') || '(empty)'}`);
    }
  } else if (rp.primaryBackup) {
    lines.push('routing: primary/backup (failover)');
  } else {
    lines.push('routing policy: ' + JSON.stringify(rp));
  }
  return lines;
}

async function cmdDnsZonesList(flags) {
  const project = await requireProject(flags);
  const zones = await gfetchAll(`${DNS_BASE}/projects/${encodeURIComponent(project)}/managedZones`, 'managedZones');
  if (flags.json) { cli.out(zones); return; }
  if (!zones.length) { console.log(c.dim('  No managed zones found.')); return; }
  console.log('');
  for (const z of zones) {
    const vis = z.visibility && z.visibility !== 'public' ? c.dim(`[${z.visibility}]`) : '';
    console.log(`  ${c.cyan(c.bold(z.name))}  ${c.dim(z.dnsName)}  ${vis}`.trimEnd());
    if (z.description) console.log(`      ${c.dim(z.description)}`);
    if (Array.isArray(z.nameServers) && z.nameServers.length) {
      console.log(`      ${c.dim('NS: ' + z.nameServers.join(', '))}`);
    }
  }
}

async function cmdDnsZonesCreate(positional, flags) {
  const project = await requireProject(flags);
  const name = positional[0];
  const dnsName = str(flags['dns-name']) || str(flags.dnsName);
  if (!name || !dnsName) {
    cli.die('usage: gcloud dns zones create <zone-name> --dns-name <domain.> [--description <text>] --confirm', { prefix: 'gcloud' });
  }
  const body = {
    name,
    dnsName: fqdn(dnsName),
    description: flags.description || `Managed by gcloud.jsh`,
    visibility: flags.private ? 'private' : 'public',
  };
  if (!flags.confirm) {
    console.log('');
    console.log(c.yellow('  Would create managed zone:'));
    console.log(`    ${c.bold(name)}  dnsName=${body.dnsName}  visibility=${body.visibility}`);
    console.log(c.dim('  Re-run with --confirm to apply.'));
    return;
  }
  const z = await gfetch(`${DNS_BASE}/projects/${encodeURIComponent(project)}/managedZones`, { method: 'POST', body });
  console.log(c.green(`✓ Created zone ${c.bold(z.name)}`) + c.dim(`  (${z.dnsName})`));
  if (Array.isArray(z.nameServers)) console.log(`  ${c.dim('NS: ' + z.nameServers.join(', '))}`);
}

async function cmdDnsRecordsList(positional, flags) {
  const project = await requireProject(flags);
  const zone = positional[0];
  if (!zone) cli.die('usage: gcloud dns records list <zone> [--name N] [--type T]', { prefix: 'gcloud' });
  let url = `${DNS_BASE}/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(zone)}/rrsets`;
  const qs = [];
  if (str(flags.name)) qs.push(`name=${encodeURIComponent(fqdn(flags.name))}`);
  if (str(flags.type)) qs.push(`type=${encodeURIComponent(str(flags.type).toUpperCase())}`);
  if (qs.length) url += `?${qs.join('&')}`;
  const rrsets = await gfetchAll(url, 'rrsets');
  if (flags.json) { cli.out(rrsets); return; }
  if (!rrsets.length) { console.log(c.dim('  No records found.')); return; }
  console.log('');
  for (const r of rrsets) {
    console.log(`  ${c.cyan(c.bold(r.type.padEnd(6)))} ${r.name}  ${c.dim('ttl:' + r.ttl)}`);
    for (const line of rrdataLines(r)) console.log(`      ${line}`);
  }
}

/**
 * Render an rrset's data. Plain records expose `rrdatas`, but records with a
 * routing policy (WRR / GEO / failover) leave `rrdatas` empty and stash the
 * real targets under `routingPolicy` — surface those instead of a blank line.
 */
function rrdataLines(r) {
  if (Array.isArray(r.rrdatas) && r.rrdatas.length) return r.rrdatas.slice();
  const rp = r.routingPolicy;
  if (!rp) return [];
  const lines = [];
  // Weighted round-robin
  if (rp.wrr?.items) {
    lines.push(c.dim('routing: weighted (wrr)'));
    rp.wrr.items.forEach((it, i) => {
      const targets = (it.rrdatas || []).join(', ') || c.dim('(empty)');
      const w = it.weight ?? 0;
      const tag = w === 0 ? c.dim(`weight ${w} — inactive`) : `weight ${w}`;
      lines.push(`[${i}] ${tag}: ${targets}`);
    });
  }
  // Geo-location
  if (rp.geo?.items) {
    lines.push(c.dim('routing: geo'));
    rp.geo.items.forEach(it => {
      const targets = (it.rrdatas || []).join(', ') || c.dim('(empty)');
      lines.push(`${it.location || '?'}: ${targets}`);
    });
  }
  // Primary/backup failover
  if (rp.primaryBackup) {
    const pb = rp.primaryBackup;
    lines.push(c.dim('routing: primary/backup (failover)'));
    const prim = pb.primaryTargets?.internalLoadBalancers?.map(l => l.ipAddress).filter(Boolean)
      || pb.primaryTargets?.rrdatas || [];
    if (prim.length) lines.push(`primary: ${prim.join(', ')}`);
    const backup = pb.backupGeoTargets?.items || [];
    for (const it of backup) {
      lines.push(`backup ${it.location || '?'}: ${(it.rrdatas || []).join(', ')}`);
    }
  }
  // Fallback: unknown policy shape — show something rather than nothing.
  if (!lines.length) lines.push(c.dim('routing policy: ' + JSON.stringify(rp)));
  return lines;
}

/** add = upsert (replace existing rrset of same name+type); remove = delete it. */
async function cmdDnsRecordsChange(positional, flags, mode) {
  const project = await requireProject(flags);
  const zone = positional[0];
  const rawName = positional[1];
  const type = (positional[2] || '').toUpperCase();
  const data = positional.slice(3);
  // Routing-policy support (add only): create a weighted round-robin rrset
  // instead of a plain one. This is what makes a WRR record reproducible —
  // e.g. rolling back a flattened wildcard back to its weighted policy.
  const rpType = str(flags['routing-policy']);
  const rpData = str(flags['routing-policy-data']);
  const usingRP = mode === 'add' && !!rpType;
  if (!zone || !rawName || !type || (mode === 'add' && !usingRP && !data.length)) {
    cli.die(
      mode === 'add'
        ? 'usage:\n' +
          '  gcloud dns records add <zone> <name> <type> <data> [<data>...] [--ttl 300] --confirm\n' +
          '  gcloud dns records add <zone> <name> <type> --routing-policy wrr \\\n' +
          '         --routing-policy-data "WEIGHT:rrdata[,rrdata];WEIGHT:rrdata" [--ttl 300] --confirm'
        : 'usage: gcloud dns records remove <zone> <name> <type> --confirm',
      { prefix: 'gcloud' },
    );
  }
  const name = fqdn(rawName);
  const base = `${DNS_BASE}/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(zone)}`;

  // Look up the existing rrset (name+type) so we can replace/delete it correctly.
  // The fetched object carries any routingPolicy verbatim, so pushing it into
  // deletions correctly removes a weighted/geo record (whose top-level rrdatas
  // are empty) — this is what lets `add` flatten a WRR record to a plain one.
  const existing = await gfetchAll(`${base}/rrsets?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, 'rrsets');
  const change = { additions: [], deletions: [] };
  if (existing.length) change.deletions.push(existing[0]);
  if (mode === 'add') {
    const ttl = Number.isFinite(parseInt(flags.ttl, 10)) ? parseInt(flags.ttl, 10) : 300;
    if (usingRP) {
      if (rpType.toLowerCase() !== 'wrr') {
        cli.die('Only --routing-policy wrr (weighted round-robin) is supported.', { prefix: 'gcloud' });
      }
      if (!rpData) {
        cli.die('--routing-policy wrr requires --routing-policy-data "WEIGHT:rrdata[,rrdata];WEIGHT:rrdata".', { prefix: 'gcloud' });
      }
      // A routing-policy rrset carries no top-level rrdatas.
      change.additions.push({ name, type, ttl, routingPolicy: { wrr: { items: parseWrrData(type, rpData) } } });
    } else {
      change.additions.push({ name, type, ttl, rrdatas: data.map(d => normalizeRrdata(type, d)) });
    }
  } else if (!existing.length) {
    cli.die(`No ${type} record found for ${name} in zone ${zone}.`, { prefix: 'gcloud' });
  }

  // Preview — render rrdatas AND routing policies so a weighted record no longer
  // shows a misleading blank target.
  console.log('');
  if (change.deletions.length) {
    const d = change.deletions[0];
    console.log(c.red(`  - ${d.type} ${d.name} ttl:${d.ttl}`));
    for (const line of changeDetailLines(d)) console.log(c.red(`      ${line}`));
  }
  if (change.additions.length) {
    const a = change.additions[0];
    console.log(c.green(`  + ${a.type} ${a.name} ttl:${a.ttl}`));
    for (const line of changeDetailLines(a)) console.log(c.green(`      ${line}`));
  }
  if (!flags.confirm) {
    console.log(c.dim('\n  Re-run with --confirm to apply this change.'));
    return;
  }
  const res = await gfetch(`${base}/changes`, { method: 'POST', body: change });
  console.log(c.green(`✓ Change ${res.id || ''} submitted`) + c.dim(`  status: ${res.status || 'pending'}`));
}

async function cmdDnsLoggingStatus(positional, flags) {
  const project = await requireProject(flags);
  const zone = positional[0];
  if (!zone) cli.die('usage: gcloud dns logging status <zone> [--project P]', { prefix: 'gcloud' });
  const z = await gfetch(`${DNS_BASE}/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(zone)}`);
  const enabled = z.cloudLoggingConfig?.enableLogging || false;
  if (flags.json) { cli.out(z.cloudLoggingConfig || { enableLogging: enabled }); return; }
  console.log('');
  const state = enabled ? c.green('enabled') : c.dim('disabled');
  console.log(`  ${c.cyan(c.bold(zone))}  logging: ${state}`);
}

/** enable = turn query logging on; disable = turn it off. */
async function cmdDnsLoggingSet(positional, flags, mode) {
  const project = await requireProject(flags);
  const zone = positional[0];
  if (!zone) cli.die(`usage: gcloud dns logging ${mode} <zone> [--project P] --confirm`, { prefix: 'gcloud' });
  const enable = mode === 'enable';
  if (!flags.confirm) {
    console.log('');
    console.log(c.yellow(`  Would ${enable ? 'ENABLE' : 'DISABLE'} query logging on zone ${c.bold(zone)} (project ${c.bold(project)}).`));
    if (enable) {
      console.log(c.dim('  Note: DNS query logs bill through Cloud Logging ingestion at $0.50/GiB'));
      console.log(c.dim('  after the first 50 GiB/project/month (free tier).'));
    }
    console.log(c.dim('  Re-run with --confirm to apply.'));
    return;
  }
  const body = { cloudLoggingConfig: { enableLogging: enable } };
  const z = await gfetch(
    `${DNS_BASE}/projects/${encodeURIComponent(project)}/managedZones/${encodeURIComponent(zone)}`,
    { method: 'PATCH', body },
  );
  const applied = z.cloudLoggingConfig?.enableLogging || false;
  console.log(c.green(`✓ Query logging ${applied ? 'enabled' : 'disabled'} on zone ${c.bold(zone)}`) + c.dim(`  (enableLogging: ${applied})`));
}

async function cmdDns(positional, flags) {
  const group = positional[0];
  const action = positional[1];
  const rest = positional.slice(2);
  if (group === 'zones' && (action === 'list' || !action)) return await cmdDnsZonesList(flags);
  if (group === 'zones' && action === 'create') return await cmdDnsZonesCreate(rest, flags);
  if (group === 'records' && (action === 'list' || !action)) return await cmdDnsRecordsList(rest, flags);
  if (group === 'records' && action === 'add') return await cmdDnsRecordsChange(rest, flags, 'add');
  if (group === 'records' && (action === 'remove' || action === 'delete')) return await cmdDnsRecordsChange(rest, flags, 'remove');
  if (group === 'logging' && (action === 'status' || !action)) return await cmdDnsLoggingStatus(rest, flags);
  if (group === 'logging' && action === 'enable') return await cmdDnsLoggingSet(rest, flags, 'enable');
  if (group === 'logging' && action === 'disable') return await cmdDnsLoggingSet(rest, flags, 'disable');
  cli.die(
    'usage:\n  gcloud dns zones list\n  gcloud dns zones create <name> --dns-name <domain.> --confirm\n  gcloud dns records list <zone> [--name N] [--type T]\n  gcloud dns records add <zone> <name> <type> <data>... [--ttl 300] --confirm\n  gcloud dns records add <zone> <name> <type> --routing-policy wrr --routing-policy-data "W:rrdata;W:rrdata" [--ttl 300] --confirm\n  gcloud dns records remove <zone> <name> <type> --confirm\n  gcloud dns logging status <zone>\n  gcloud dns logging enable <zone> --confirm\n  gcloud dns logging disable <zone> --confirm',
    { prefix: 'gcloud' },
  );
}

// ── Cloud Billing ────────────────────────────────────────────────────────────

const BILLING_BASE = 'https://cloudbilling.googleapis.com/v1';

/** Normalize an account id to the bare XXXX-XXXX-XXXX form (strip prefix). */
function billingAccountId(raw) {
  return (raw || '').replace(/^billingAccounts\//, '');
}

async function cmdBillingAccountsList(flags) {
  const accounts = await gfetchAll(`${BILLING_BASE}/billingAccounts`, 'billingAccounts');
  if (flags.json) { cli.out(accounts); return; }
  if (!accounts.length) { console.log(c.dim('  No billing accounts accessible.')); return; }
  console.log('');
  for (const a of accounts) {
    const open = a.open ? c.green('open') : c.dim('closed');
    console.log(`  ${c.cyan(c.bold(a.displayName || a.name))}  ${c.dim(a.name)}  ${open}`);
  }
}

async function cmdBillingAccountsDescribe(positional, flags) {
  const id = billingAccountId(positional[0]);
  if (!id) cli.die('usage: gcloud billing accounts describe <ACCOUNT_ID>', { prefix: 'gcloud' });
  const a = await gfetch(`${BILLING_BASE}/billingAccounts/${encodeURIComponent(id)}`);
  if (flags.json) { cli.out(a); return; }
  console.log('');
  console.log(`  ${c.cyan(c.bold(a.displayName || a.name))}`);
  console.log(`  ${c.dim('name')}         ${a.name}`);
  console.log(`  ${c.dim('open')}         ${a.open ? c.green('yes') : c.red('no')}`);
  if (a.masterBillingAccount) console.log(`  ${c.dim('master')}       ${a.masterBillingAccount}`);
}

async function cmdBillingAccountsGetIamPolicy(positional, flags) {
  const id = billingAccountId(positional[0]);
  if (!id) cli.die('usage: gcloud billing accounts get-iam-policy <ACCOUNT_ID>', { prefix: 'gcloud' });
  const policy = await gfetch(`${BILLING_BASE}/billingAccounts/${encodeURIComponent(id)}:getIamPolicy`, { method: 'POST', body: {} });
  if (flags.json) { cli.out(policy); return; }
  const bindings = policy.bindings || [];
  if (!bindings.length) { console.log(c.dim('  No IAM bindings.')); return; }
  console.log('');
  for (const b of bindings) {
    console.log(`  ${c.cyan(c.bold(b.role))}`);
    for (const m of (b.members || [])) console.log(`      ${c.dim(m)}`);
  }
}

async function cmdBillingProjectsList(positional, flags) {
  const id = billingAccountId(positional[0]);
  if (!id) cli.die('usage: gcloud billing projects list <ACCOUNT_ID>', { prefix: 'gcloud' });
  const projects = await gfetchAll(`${BILLING_BASE}/billingAccounts/${encodeURIComponent(id)}/projects`, 'projectBillingInfo');
  if (flags.json) { cli.out(projects); return; }
  if (!projects.length) { console.log(c.dim('  No linked projects.')); return; }
  console.log('');
  for (const p of projects) {
    const on = p.billingEnabled ? c.green('●') : c.dim('○');
    console.log(`  ${on} ${c.cyan(c.bold(p.projectId))}  ${c.dim(p.billingAccountName || '')}`);
  }
}

async function cmdBillingProjectsDescribe(positional, flags) {
  const projectId = positional[0];
  if (!projectId) cli.die('usage: gcloud billing projects describe <PROJECT_ID>', { prefix: 'gcloud' });
  const info = await gfetch(`${BILLING_BASE}/projects/${encodeURIComponent(projectId)}/billingInfo`);
  if (flags.json) { cli.out(info); return; }
  console.log('');
  console.log(`  ${c.cyan(c.bold(info.projectId || projectId))}`);
  console.log(`  ${c.dim('billingAccountName')}  ${info.billingAccountName || c.dim('(none)')}`);
  console.log(`  ${c.dim('billingEnabled')}      ${info.billingEnabled ? c.green('yes') : c.red('no')}`);
}

async function cmdBillingProjectsLink(positional, flags) {
  const projectId = positional[0];
  const account = billingAccountId(str(flags['billing-account']));
  if (!projectId || !account) {
    cli.die('usage: gcloud billing projects link <PROJECT_ID> --billing-account <ACCOUNT_ID> --confirm', { prefix: 'gcloud' });
  }
  const billingAccountName = `billingAccounts/${account}`;
  if (!flags.confirm) {
    console.log('');
    console.log(c.yellow(`  Would LINK project ${c.bold(projectId)} to ${c.bold(billingAccountName)}.`));
    console.log(c.dim('  Re-run with --confirm to apply.'));
    return;
  }
  const info = await gfetch(
    `${BILLING_BASE}/projects/${encodeURIComponent(projectId)}/billingInfo`,
    { method: 'PUT', body: { billingAccountName } },
  );
  console.log(c.green(`✓ Linked ${c.bold(projectId)} to ${info.billingAccountName || billingAccountName}`) + c.dim(`  (billingEnabled: ${!!info.billingEnabled})`));
}

async function cmdBillingProjectsUnlink(positional, flags) {
  const projectId = positional[0];
  if (!projectId) cli.die('usage: gcloud billing projects unlink <PROJECT_ID> --confirm', { prefix: 'gcloud' });
  if (!flags.confirm) {
    console.log('');
    console.log(c.yellow(`  Would UNLINK billing from project ${c.bold(projectId)} (disables billing).`));
    console.log(c.dim('  Re-run with --confirm to apply.'));
    return;
  }
  const info = await gfetch(
    `${BILLING_BASE}/projects/${encodeURIComponent(projectId)}/billingInfo`,
    { method: 'PUT', body: { billingAccountName: '' } },
  );
  console.log(c.green(`✓ Unlinked billing from ${c.bold(projectId)}`) + c.dim(`  (billingEnabled: ${!!info.billingEnabled})`));
}

async function cmdBilling(positional, flags) {
  const group = positional[0];
  const action = positional[1];
  const rest = positional.slice(2);
  if (group === 'accounts' && (action === 'list' || !action)) return await cmdBillingAccountsList(flags);
  if (group === 'accounts' && action === 'describe') return await cmdBillingAccountsDescribe(rest, flags);
  if (group === 'accounts' && action === 'get-iam-policy') return await cmdBillingAccountsGetIamPolicy(rest, flags);
  if (group === 'projects' && (action === 'list' || !action)) return await cmdBillingProjectsList(rest, flags);
  if (group === 'projects' && action === 'describe') return await cmdBillingProjectsDescribe(rest, flags);
  if (group === 'projects' && action === 'link') return await cmdBillingProjectsLink(rest, flags);
  if (group === 'projects' && action === 'unlink') return await cmdBillingProjectsUnlink(rest, flags);
  cli.die(
    'usage:\n  gcloud billing accounts list\n  gcloud billing accounts describe <ACCOUNT_ID>\n  gcloud billing accounts get-iam-policy <ACCOUNT_ID>\n  gcloud billing projects list <ACCOUNT_ID>\n  gcloud billing projects describe <PROJECT_ID>\n  gcloud billing projects link <PROJECT_ID> --billing-account <ACCOUNT_ID> --confirm\n  gcloud billing projects unlink <PROJECT_ID> --confirm',
    { prefix: 'gcloud' },
  );
}

async function cmdApi(positional, flags) {
  // gcloud api <METHOD> <url> [--data <json>]
  let method = 'GET', url;
  if (positional.length >= 2 && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(positional[0])) {
    method = positional[0].toUpperCase();
    url = positional[1];
  } else {
    url = positional[0];
  }
  if (!url) cli.die('usage: gcloud api [METHOD] <full-url> [--data <json>]', { prefix: 'gcloud' });
  let body;
  if (flags.data) {
    try { body = JSON.parse(flags.data); }
    catch { body = flags.data; }
  }
  const data = await gfetch(url, { method, body });
  cli.out(data);
}

// ─── args + main ─────────────────────────────────────────────────────────────

const HELP = `
gcloud — a subset of the Google Cloud API, authenticated via the gcloud CLI's
         own public OAuth client (oauth-token --intercept).

USAGE
  gcloud login                          Sign in with Google (browser consent)
  gcloud whoami                         Show the authenticated identity
  gcloud logout                         Revoke + clear stored tokens

  gcloud config                         Show active config
  gcloud config set-project <id>        Set the default project

  gcloud projects list                  List accessible projects
  gcloud instances list  [--project P] [--zone Z]   Compute Engine instances
  gcloud zones list      [--project P]              Compute Engine zones
  gcloud buckets list    [--project P]              Cloud Storage buckets
  gcloud services list   [--project P]              Enabled APIs
  gcloud run list        [--project P] [--region R] Cloud Run services
  gcloud services enable <api.googleapis.com> [--project P] --confirm

  gcloud dns zones list                             Managed DNS zones
  gcloud dns zones create <name> --dns-name <domain.> --confirm
  gcloud dns records list <zone> [--name N] [--type T]
  gcloud dns records add    <zone> <name> <type> <data>... [--ttl 300] --confirm
  gcloud dns records add    <zone> <name> <type> --routing-policy wrr
         --routing-policy-data "W:rrdata;W:rrdata" [--ttl 300] --confirm
  gcloud dns records remove <zone> <name> <type> --confirm
  gcloud dns logging status  <zone> [--project P]   Query-logging state for a zone
  gcloud dns logging enable  <zone> [--project P] --confirm
  gcloud dns logging disable <zone> [--project P] --confirm

  gcloud billing accounts list                      Billing accounts you can access
  gcloud billing accounts describe <ACCOUNT_ID>
  gcloud billing accounts get-iam-policy <ACCOUNT_ID>
  gcloud billing projects list <ACCOUNT_ID>         Projects linked to a billing account
  gcloud billing projects describe <PROJECT_ID>     A project's billing link + state
  gcloud billing projects link   <PROJECT_ID> --billing-account <ACCOUNT_ID> --confirm
  gcloud billing projects unlink <PROJECT_ID> --confirm

  gcloud api [METHOD] <full-url> [--data <json>]    Authenticated raw call

FLAGS
  --project <id>       Override the active project for this call
  --confirm            Actually apply a create/add/remove/enable (else preview only)
  --json               Output raw JSON

  (Use long flags with a value: --project X, --zone X, --region X, --type X.
   Single-dash short flags are not supported.)

REQUIRES
  Run 'gcloud login' once. A human completes the Google consent screen in the
  browser; tokens are then stored in skill config and auto-refresh.
`.trim();

const parsed      = process.argv.parseFlags();
const subcommand  = parsed.subcommand || '';
const positional  = parsed.positional.slice(1);
const flags       = parsed.flags;

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);

  try {
    // normalize gcloud-style two-word forms
    const s = subcommand;
    const p0 = positional[0];

    if (s === 'login' || (s === 'auth' && p0 === 'login')) return await cmdLogin();
    if (s === 'whoami' || (s === 'auth' && p0 === 'status')) return await cmdWhoami(flags);
    if (s === 'logout' || (s === 'auth' && p0 === 'revoke')) return await cmdLogout();
    if (s === 'config') return await cmdConfig(positional, flags);

    if (s === 'projects') return await cmdProjectsList(flags);
    if (s === 'instances' || (s === 'compute' && p0 === 'instances')) return await cmdComputeInstances(flags);
    if (s === 'zones' || (s === 'compute' && p0 === 'zones')) return await cmdComputeZones(flags);
    if (s === 'buckets' || s === 'storage') return await cmdBuckets(flags);
    if (s === 'services') return await cmdServices(positional, flags);
    if (s === 'run') return await cmdRun(flags);
    if (s === 'dns') return await cmdDns(positional, flags);
    if (s === 'billing') return await cmdBilling(positional, flags);
    if (s === 'api') return await cmdApi(positional, flags);

    cli.die(`unknown command: ${s}\nRun 'gcloud --help' for usage.`, { prefix: 'gcloud' });
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err; // MANDATORY re-throw
    cli.die(err.message, { prefix: 'gcloud' });
  }
}

await main();
