// bb.jsh — control a bb server (get-bb/bb) over its /api/v1 HTTP API
// Auth: a bb connect machine credential (x-bb-connect-machine), persisted by `bb pair`.
// Verified live against bb 0.38.0 through https://<handle>.getbb.app on 2026-08-18.
//
// Transport: requests run INSIDE a browser tab parked on the bb origin. bb's
// server rejects any request carrying a foreign browser Origin
// (`forbidden_origin`), and the realm's fetch/curl both leave the SLICC origin
// attached, so only a page-origin request is accepted. The connect worker still
// gates /api/v1 on the machine credential header, which travels on each request.
const browser = require('sliccy:browser');
const skill = require('sliccy:skill');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');

const TOOL = 'bb';
const CONNECT_BASE = 'https://getbb.app';
const MACHINE_HEADER = 'x-bb-connect-machine';

const HELP = `
bb — drive a bb server (threads, projects, agents) from SLICC

USAGE
  bb status [--json]
  bb attach [--server <url>]                 Pair with no code (uses your signed-in bb tab)
  bb pair --code <code> [--server <url>] [--connect-url <url>]
  bb unpair
  bb self [<thread-id>]

  bb host list [--json]

  bb project list [--json]
  bb project show <id> [--json]

  bb thread list [--project <id>] [--parent-thread <id>] [--archived]
                 [--include-hidden] [--limit <n>] [--json]
  bb thread show [<id>] [--self] [--json]
  bb thread log [<id>] [--self] [--limit <n>] [--after-seq <n>] [--json]
  bb thread output [<id>] [--self] [--json]
  bb thread tell <id> <message...> [--self] [--mode steer|queue|auto] [--model <m>]
                 [--reasoning-level <l>] [--permission-mode <m>] [--json]
  bb thread spawn --project <id> [--prompt <p>] [--provider <id>] [--model <m>]
                 [--title <t>] [--environment <id>] [--new-environment worktree]
                 [--host <name-or-id>] [--base-branch <b>] [--parent-thread <id>]
                 [--visibility visible|hidden] [--json]
  bb thread stop [<id>] [--self] [--json]
  bb thread wait <id> [--status <status>] [--timeout <seconds>] [--poll-interval <ms>] [--json]
  bb thread search <query> [--limit <n>] [--json]
  bb thread queue list [<id>] [--self] [--json]

GLOBAL FLAGS
  --server <url>   bb origin for this call (also BB_SERVER_URL); overrides the paired one
  --json           Print the raw API response

REQUIRES
  bb attach --server https://<handle>.getbb.app
    Mints and redeems a code itself, using the session in your bb browser tab.
    Sign in to the bb server in the browser first.

  Manual alternative — bb pair --code <code> --server https://<handle>.getbb.app
  Mint the code on the bb server itself:
    curl -s -X POST -H 'content-type: application/json' -d 'null' \\
      http://127.0.0.1:38886/api/v1/plugins/connect/rpc/createMachineCode
  A bb on this machine needs no credential: bb pair --server http://127.0.0.1:38886
`.trim();

// ── args ──────────────────────────────────────────────────────────────
const parsed = process.argv.parseFlags();
const positional = parsed.positional;
const flags = parsed.flags;
const group = positional[0] || '';

function die(message) {
  cli.die(message, { prefix: TOOL });
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function clampInt(raw, fallback, min, max) {
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function normalizeServerUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    die(`invalid --server url: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    die('--server must be an http:// or https:// origin');
  }
  return url.origin;
}

// ── config + client ───────────────────────────────────────────────────
let _config = null;
async function config() {
  // A Promise is always truthy — the fallback only works after the value lands.
  if (_config === null) _config = (await skill.config()) || {};
  return _config;
}

let _api = null;
async function api() {
  if (_api) return _api;
  const stored = await config();
  const serverUrl = firstString(
    typeof flags.server === 'string' ? flags.server : undefined,
    process.env.BB_SERVER_URL,
    stored.serverUrl,
  );
  if (!serverUrl) {
    die(`no bb server configured — run 'bb pair --code <code> --server https://<handle>.getbb.app'`);
  }
  const origin = normalizeServerUrl(serverUrl);
  const headers = { Accept: 'application/json' };
  const credential = typeof stored.credential === 'string' ? stored.credential : '';
  if (credential.length > 0) headers[MACHINE_HEADER] = credential;
  // Match on the exact host, dots escaped: an unescaped `.` in a tab matcher has
  // silently matched the wrong site before (issue #127 family).
  const host = new URL(origin).host.replace(/[.]/gu, '\\.');
  _api = { origin, headers, paired: credential.length > 0, urlMatch: new RegExp(host) };
  return _api;
}

let _tab = null;
async function getTab() {
  if (_tab) return _tab;
  const { origin, urlMatch } = await api();
  _tab = await browser.findTab({ urlMatch });
  if (_tab) return _tab;
  _tab = await browser.ensureTab(`${origin}/`, { matchUrl: urlMatch });
  if (!_tab) die(`could not open a browser tab on ${origin} — is the bb server reachable?`);
  return _tab;
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    // Repeated params must stay repeated — comma-joining silently breaks filters.
    for (const entry of Array.isArray(value) ? value : [value]) search.append(key, String(entry));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

/**
 * One request wrapper so every command reports credential expiry identically.
 * `tolerate` returns null instead of exiting when the server answers non-2xx.
 */
async function request(method, path, options = {}) {
  const { origin, headers, paired } = await api();
  const tab = await getTab();
  const init = { method: method.toUpperCase(), headers: { ...headers } };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    // Explicit stringify: older bridges did not encode plain objects.
    init.body = JSON.stringify(options.body);
  }
  const url = `${origin}/api/v1${path}${queryString(options.params)}`;
  let res;
  try {
    res = await browser.fetch(tab, url, init);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    die(`could not reach ${origin} — ${err.message}`);
  }
  const body = typeof res.body === 'string' ? tryJson(res.body) : res.body;
  if (res.status === 401 || res.status === 403) {
    if (options.tolerate) return null;
    if (typeof body === 'string' && /<html|<!DOCTYPE/iu.test(body)) {
      die(`${origin} answered with a sign-in page — the tunnel no longer accepts this machine; run 'bb pair --code <code>' with a fresh code`);
    }
    die(
      paired
        ? `${origin} rejected the stored credential (${res.status}) — mint a new machine code on the bb server and run 'bb pair --code <code>'`
        : `${origin} requires a credential (${res.status}) — run 'bb pair --code <code> --server ${origin}'`,
    );
  }
  if (!res.ok) {
    if (options.tolerate) return null;
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body ?? '').slice(0, 300);
    die(`${origin} returned ${res.status} for ${path}${detail ? ` — ${detail}` : ''}`);
  }
  return body;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── formatting helpers ────────────────────────────────────────────────
const RULE = color.dim('  ' + '─'.repeat(56));

function line(label, value) {
  if (value === undefined || value === null || value === '') return;
  console.log(`  ${label}: ${value}`);
}

function threadTitle(thread) {
  return thread.title || thread.titleFallback || '(untitled)';
}

function statusIcon(status) {
  if (status === 'working' || status === 'running') return color.yellow('◐');
  if (status === 'error' || status === 'failed') return color.red('✗');
  if (status === 'idle') return color.green('✓');
  return color.dim('·');
}

function printThreadRow(thread) {
  console.log(
    `  ${statusIcon(thread.status)} ${color.cyan(color.bold(fmt.trunc(threadTitle(thread), 48)))}` +
      `  ${color.dim(`id:${thread.id}`)} ${color.dim(`[${thread.status}]`)}`,
  );
  console.log(
    `      ${color.dim(`project:${thread.projectId}`)}` +
      `${thread.providerId ? color.dim(`  provider:${thread.providerId}`) : ''}` +
      `${thread.updatedAt ? color.dim(`  updated:${fmt.date(thread.updatedAt, 'human')}`) : ''}`,
  );
}

function itemSummary(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'agentMessage') return { label: color.green('agent'), text: item.text || '' };
  if (item.type === 'reasoning') {
    const parts = [].concat(item.summary || [], item.content || []);
    return { label: color.dim('think'), text: parts.join(' ') };
  }
  if (item.type === 'commandExecution') {
    const exit = item.exitCode === null || item.exitCode === undefined ? '' : ` (exit ${item.exitCode})`;
    return { label: color.yellow('exec'), text: `${item.command || ''}${exit}` };
  }
  if (item.type === 'toolCall' || item.type === 'fileEdit') {
    return { label: color.yellow(item.type), text: item.title || item.path || item.name || '' };
  }
  return { label: color.dim(item.type || 'item'), text: '' };
}

function promptText(input) {
  if (!Array.isArray(input)) return '';
  return input
    .filter((entry) => entry && entry.type === 'text')
    .map((entry) => entry.text || '')
    .join('\n');
}

function printEventTimeline(events) {
  let printed = 0;
  for (const event of events) {
    const time = color.dim(fmt.date(event.createdAt, 'short'));
    if (event.type === 'client/turn/requested') {
      const text = promptText(event.data?.input);
      console.log(`  ${time} ${color.cyan('user')}  ${fmt.trunc(text.replace(/\s+/gu, ' '), 140)}`);
      printed += 1;
      continue;
    }
    if (event.type === 'item/completed') {
      const summary = itemSummary(event.data?.item);
      if (!summary) continue;
      console.log(`  ${time} ${summary.label}  ${fmt.trunc(summary.text.replace(/\s+/gu, ' '), 140)}`);
      printed += 1;
      continue;
    }
    if (event.type === 'turn/started' || event.type === 'turn/completed' || event.type === 'turn/failed') {
      console.log(`  ${time} ${color.dim(event.type)}`);
      printed += 1;
    }
  }
  if (printed === 0) console.log(color.dim('  No timeline entries in this range.'));
}

// ── thread targeting ──────────────────────────────────────────────────
async function resolveThreadId(explicit, usage) {
  if (typeof explicit === 'string' && explicit.length > 0 && !flags.self) return explicit;
  if (flags.self) {
    const stored = await config();
    const id = firstString(process.env.BB_THREAD_ID, stored.selfThreadId);
    if (!id) die(`--self needs a default thread — run 'bb self <thread-id>' first`);
    return id;
  }
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  die(usage);
}

// ── commands: code-less attach ────────────────────────────────────────
/**
 * Pair without a machine code, for the common case where the human is already
 * signed in to the bb server in this browser.
 *
 * `createMachineCode` is normally reached over loopback from a shell on the
 * machine that owns the bb server — which SLICC does not have. But the RPC is
 * also served on the server's public origin, where the owner's session cookie
 * authorises it, and every bb request here already runs inside a tab parked on
 * that origin. So mint the code in-page and redeem it immediately: one command,
 * nothing to copy, and no shell on the host machine.
 *
 * Codes are one-time and short-lived (~10 minutes), so minting and redeeming
 * must stay a single atomic step — never mint one to use later.
 */
async function cmdAttach() {
  const server = typeof flags.server === 'string' ? normalizeServerUrl(flags.server) : undefined;
  const stored = await config();
  if (!firstString(server, process.env.BB_SERVER_URL, stored.serverUrl)) {
    die('usage: bb attach [--server https://<handle>.getbb.app]');
  }
  const { origin } = await api();
  // `-d null` is what the RPC expects; `tolerate` so a signed-out tab gets a
  // useful message instead of the generic credential error.
  const minted = await request('post', '/plugins/connect/rpc/createMachineCode', {
    body: null,
    tolerate: true,
  });
  const code = typeof minted?.result?.code === 'string' ? minted.result.code : undefined;
  if (!code) {
    die(
      `${origin} would not mint a machine code.\n` +
        `  Open ${origin} in the browser and sign in as the server's owner, then retry —\n` +
        `  minting is authorised by that session, not by a stored credential.\n` +
        `  Fallback: mint one on the bb server itself and use 'bb pair --code <code>'.`,
    );
  }
  const serverUrl = firstString(server, minted?.result?.serverUrl, stored.serverUrl);
  return await redeemMachineCode(code, serverUrl ? normalizeServerUrl(serverUrl) : undefined);
}

// ── hosts ─────────────────────────────────────────────────────────────
/**
 * Enrolled hosts, as `/api/v1/hosts` reports them. Kept in one place because
 * both `bb host list` and worktree spawning need it: a managed worktree is
 * created ON a host, so `--new-environment worktree` cannot be satisfied
 * without one.
 */
async function listHosts() {
  const data = await request('get', '/hosts');
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.hosts) ? data.hosts : [];
}

function hostIsConnected(host) {
  return host?.status === 'connected';
}

function hostLabel(host) {
  return `${host.name || '(unnamed)'} (${host.id})`;
}

/**
 * Resolve `--host` the way the upstream bb CLI's own share-host resolver does:
 * an exact id wins, then a case-insensitive name, and an ambiguous name lists
 * the candidate ids rather than guessing.
 *
 * With no `--host` at all, a single enrolled host is unambiguous, so use it
 * instead of failing — the previous behaviour pointed at `bb thread show` for
 * an id that command never prints, leaving no way to discover one.
 *
 * An explicit `--host` is taken at its word and is NOT connectivity-checked:
 * naming a host is a statement of intent, and it doubles as the override when
 * the automatic path refuses a disconnected one.
 */
async function resolveHostId(explicit) {
  const hosts = await listHosts();
  const query = typeof explicit === 'string' ? explicit.trim() : '';
  if (query.length > 0) {
    const byId = hosts.find((host) => host.id === query);
    if (byId) return byId.id;
    const byName = hosts.filter(
      (host) => String(host.name || '').toLocaleLowerCase() === query.toLocaleLowerCase(),
    );
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) {
      die(`--host "${query}" is ambiguous; pass one of these ids: ${byName.map((host) => host.id).join(', ')}`);
    }
    die(`no enrolled host matches --host "${query}" — run 'bb host list' to see them`);
  }
  // Ambiguity is a property of the ENROLLED set, not of who happens to be online
  // right now. Narrowing to connected hosts first would silently run the agent on
  // a fallback machine just because the intended host was momentarily offline, so
  // decide ambiguity first and check connectivity only afterwards.
  if (hosts.length === 0) {
    die("this bb server has no enrolled hosts — run 'bb host list' to confirm, then enroll one in bb");
  }
  if (hosts.length > 1) {
    die(
      `--new-environment worktree needs --host <name-or-id> — ${hosts.length} enrolled hosts: ` +
        hosts.map((host) => `${hostLabel(host)} [${host.status || 'unknown'}]`).join(', '),
    );
  }
  const only = hosts[0];
  if (!hostIsConnected(only)) {
    die(
      `the only enrolled host, ${hostLabel(only)}, is ${only.status || 'not connected'} — it cannot build a worktree.\n` +
        `  Bring it online, reuse an existing environment with --environment <id>,\n` +
        `  or pass --host ${only.id} to try anyway.`,
    );
  }
  return only.id;
}

async function cmdHostList() {
  const hosts = await listHosts();
  if (flags.json) {
    cli.out(hosts);
    return;
  }
  if (hosts.length === 0) {
    console.log(color.dim('  no enrolled hosts'));
    return;
  }
  console.log('');
  for (const host of hosts) {
    const icon = hostIsConnected(host) ? color.green('✓') : color.dim('·');
    console.log(`  ${icon} ${color.cyan(color.bold(host.name || '(unnamed)'))}  ${color.dim(`id:${host.id}`)}`);
    const bits = [host.type, host.status, host.maxPermissionMode ? `permissions:${host.maxPermissionMode}` : ''];
    console.log(`      ${color.dim(bits.filter(Boolean).join('  '))}`);
  }
}

// ── commands: pairing + status ────────────────────────────────────────
async function cmdPair() {
  const server = typeof flags.server === 'string' ? normalizeServerUrl(flags.server) : undefined;
  const code = typeof flags.code === 'string' ? flags.code : undefined;
  if (!code) {
    if (!server) die('usage: bb pair --code <code> [--server <url>]  |  bb pair --server http://127.0.0.1:38886');
    // Loopback / same-machine bb: origin is enough, no credential exists.
    await skill.config({ serverUrl: server, credential: null, machineId: null });
    _config = null;
    console.log(`  ${color.green('✓')} bb server set to ${color.cyan(server)} ${color.dim('(no credential — local access)')}`);
    return;
  }
  return await redeemMachineCode(code, server);
}

/**
 * Redeem a connect machine code and persist the durable credential. Shared by
 * `bb pair --code` (code pasted by hand) and `bb attach` (code minted here), so
 * both paths store config identically.
 */
async function redeemMachineCode(code, server) {
  const connectUrl = typeof flags['connect-url'] === 'string' ? normalizeServerUrl(flags['connect-url']) : CONNECT_BASE;
  let response;
  try {
    response = await fetch(`${connectUrl}/api/connect/redeem-machine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    die(`could not reach ${connectUrl} — ${err.message}`);
  }
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  if (!response.ok) {
    const reason = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    die(
      `pairing failed (${reason}) — machine codes are one-time and expire.\n` +
        `  Easiest fix: 'bb attach --server https://<handle>.getbb.app' mints and redeems a fresh code itself.\n` +
        `  Or mint one on the bb server:\n` +
        `  curl -s -X POST -H 'content-type: application/json' -d 'null' http://127.0.0.1:38886/api/v1/plugins/connect/rpc/createMachineCode`,
    );
  }
  if (typeof body.credential !== 'string' || !body.credential.startsWith('bbcm_')) {
    die(`${connectUrl} returned an unexpected redeem response`);
  }
  const stored = await config();
  const serverUrl = firstString(server, body.serverUrl, stored.serverUrl);
  if (!serverUrl) die('pairing succeeded but no server url is known — rerun with --server https://<handle>.getbb.app');
  await skill.config({
    serverUrl: normalizeServerUrl(serverUrl),
    credential: body.credential,
    machineId: typeof body.machineId === 'string' ? body.machineId : null,
  });
  _config = null;
  console.log(`  ${color.green('✓')} paired with ${color.cyan(normalizeServerUrl(serverUrl))}`);
  console.log(color.dim('  credential stored in skill config (never printed)'));
}

async function cmdUnpair() {
  await skill.config({ serverUrl: null, credential: null, machineId: null });
  _config = null;
  console.log(`  ${color.green('✓')} forgot the stored bb server and credential`);
}

async function cmdSelf() {
  const id = positional[1];
  if (id) {
    await skill.config({ selfThreadId: id });
    _config = null;
    console.log(`  ${color.green('✓')} default thread set to ${color.dim(`id:${id}`)}`);
    return;
  }
  const stored = await config();
  const current = firstString(process.env.BB_THREAD_ID, stored.selfThreadId);
  if (!current) {
    console.log(color.dim('  No default thread. Set one with: bb self <thread-id>'));
    return;
  }
  console.log(`  ${color.dim(`id:${current}`)}`);
}

/**
 * The list endpoint returns rows, never a total, so a single capped page would
 * report its own page size as the thread count. Page through with offset and
 * say so when the page budget runs out instead of publishing a fake total.
 */
async function collectThreads() {
  const PAGE_SIZE = 200;
  const MAX_PAGES = 25;
  const active = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await request('get', '/threads', {
      params: { limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) },
    });
    const threads = Array.isArray(batch) ? batch : batch.threads || [];
    total += threads.length;
    for (const thread of threads) {
      if (thread.status !== 'idle') active.push(thread);
    }
    if (threads.length < PAGE_SIZE) return { total, truncated: false, active };
  }
  return { total, truncated: true, active };
}

async function cmdStatus() {
  const stored = await config();
  const { origin, paired } = await api();
  const version = await request('get', '/system/version', { tolerate: true });
  const { total, truncated, active } = await collectThreads();
  const payload = {
    serverUrl: origin,
    paired,
    machineId: stored.machineId ?? null,
    selfThreadId: firstString(process.env.BB_THREAD_ID, stored.selfThreadId) ?? null,
    version: version ?? null,
    threadCount: total,
    threadCountTruncated: truncated,
  };
  if (flags.json) {
    cli.out(payload);
    return;
  }
  console.log('');
  console.log(`  ${color.cyan(color.bold('bb'))} ${color.dim(origin)}`);
  console.log(RULE);
  line('Auth', paired ? color.green('machine credential stored') : color.dim('none (local access)'));
  line('Machine', payload.machineId);
  line('Version', version && (version.currentVersion || version.version));
  line('Threads', truncated ? `${total}+ ${color.dim('(counted up to the page budget)')}` : total);
  line('Default thread', payload.selfThreadId);
  if (active.length > 0) {
    console.log('');
    console.log(color.dim('  Active:'));
    for (const thread of active.slice(0, 10)) printThreadRow(thread);
  }
}

// ── commands: projects ────────────────────────────────────────────────
async function cmdProjectList() {
  const data = await request('get', '/projects');
  if (flags.json) {
    cli.out(data);
    return;
  }
  const projects = Array.isArray(data) ? data : data.projects || [];
  if (projects.length === 0) {
    console.log(color.dim('  No projects found.'));
    return;
  }
  console.log('');
  for (const project of projects) {
    console.log(`  ${color.cyan(color.bold(project.name || '(unnamed)'))}  ${color.dim(`id:${project.id}`)}`);
    const source = (project.sources || []).find((entry) => entry.isDefault) || (project.sources || [])[0];
    if (source?.path) console.log(`      ${color.dim(source.path)}`);
  }
}

async function cmdProjectShow() {
  const id = positional[2];
  if (!id) die('usage: bb project show <id>');
  const data = await request('get', `/projects/${encodeURIComponent(id)}`);
  if (flags.json) {
    cli.out(data);
    return;
  }
  const project = data.project || data;
  console.log('');
  console.log(`  ${color.cyan(color.bold(project.name || '(unnamed)'))}  ${color.dim(`id:${project.id ?? id}`)}`);
  console.log(RULE);
  line('Kind', project.kind);
  line('Remote', project.gitRemoteUrl);
  for (const source of project.sources || []) {
    line('Source', `${source.path || source.type} ${color.dim(`id:${source.id}`)}`);
  }
}

// ── commands: threads ─────────────────────────────────────────────────
async function cmdThreadList() {
  const params = {};
  if (typeof flags.project === 'string') params.projectId = flags.project;
  if (typeof flags['parent-thread'] === 'string') params.parentThreadId = flags['parent-thread'];
  if (typeof flags.section === 'string') params.sectionId = flags.section;
  if (flags.archived) params.archived = 'true';
  if (flags.unsectioned) params.unsectioned = 'true';
  if (flags['include-hidden']) params.includeHidden = 'true';
  params.limit = String(clampInt(flags.limit, 20, 1, 200));
  const data = await request('get', '/threads', { params });
  if (flags.json) {
    cli.out(data);
    return;
  }
  const threads = Array.isArray(data) ? data : data.threads || [];
  if (threads.length === 0) {
    console.log(color.dim('  No threads found.'));
    return;
  }
  console.log('');
  for (const thread of threads) printThreadRow(thread);
}

async function cmdThreadShow() {
  const id = await resolveThreadId(positional[2], 'usage: bb thread show <id> | bb thread show --self');
  const data = await request('get', `/threads/${encodeURIComponent(id)}`);
  if (flags.json) {
    cli.out(data);
    return;
  }
  const thread = data.thread || data;
  console.log('');
  console.log(`  ${statusIcon(thread.status)} ${color.cyan(color.bold(threadTitle(thread)))}  ${color.dim(`id:${thread.id ?? id}`)}`);
  console.log(RULE);
  line('Status', thread.status);
  line('Project', thread.projectId);
  line('Environment', thread.environmentId);
  line('Provider', thread.providerId);
  line('Parent', thread.parentThreadId);
  line('Created', thread.createdAt && fmt.date(thread.createdAt, 'human'));
  line('Updated', thread.updatedAt && fmt.date(thread.updatedAt, 'human'));
}

async function cmdThreadLog() {
  const id = await resolveThreadId(positional[2], 'usage: bb thread log <id> | bb thread log --self');
  const params = { limit: String(clampInt(flags.limit, 100, 1, 1000)) };
  if (typeof flags['after-seq'] === 'string') params.afterSeq = flags['after-seq'];
  const data = await request('get', `/threads/${encodeURIComponent(id)}/events`, { params });
  if (flags.json) {
    cli.out(data);
    return;
  }
  const events = Array.isArray(data) ? data : data.events || [];
  console.log('');
  console.log(`  ${color.dim(`id:${id}`)} ${color.dim(`${events.length} events`)}`);
  console.log(RULE);
  printEventTimeline(events);
}

async function cmdThreadOutput() {
  const id = await resolveThreadId(positional[2], 'usage: bb thread output <id> | bb thread output --self');
  const data = await request('get', `/threads/${encodeURIComponent(id)}/output`);
  if (flags.json) {
    cli.out(data);
    return;
  }
  const output = typeof data === 'string' ? data : data.output;
  console.log(output ? output : color.dim('  (no output)'));
}

async function cmdThreadTell() {
  const id = await resolveThreadId(positional[2], 'usage: bb thread tell <id> <message>');
  const words = flags.self ? positional.slice(2) : positional.slice(3);
  const message = words.join(' ').trim();
  if (!message) die('usage: bb thread tell <id> <message>');
  const mode = typeof flags.mode === 'string' ? flags.mode.trim().toLowerCase() : 'steer';
  // The CLI's steer/queue/auto map onto the wire's *-if-active names; the API
  // rejects the short forms outright (verified live 2026-08-18).
  const WIRE_MODES = {
    steer: 'steer-if-active',
    'steer-if-active': 'steer-if-active',
    queue: 'queue-if-active',
    'queue-if-active': 'queue-if-active',
    auto: 'auto',
  };
  const wireMode = WIRE_MODES[mode];
  if (!wireMode) die('--mode must be steer, queue, or auto');
  const body = { input: [{ type: 'text', text: message, mentions: [] }], mode: wireMode };
  if (typeof flags.model === 'string') body.model = flags.model;
  if (typeof flags['service-tier'] === 'string') body.serviceTier = flags['service-tier'];
  if (typeof flags['reasoning-level'] === 'string') body.reasoningLevel = flags['reasoning-level'];
  if (typeof flags['permission-mode'] === 'string') body.permissionMode = flags['permission-mode'];
  const data = await request('post', `/threads/${encodeURIComponent(id)}/send`, { body });
  if (flags.json) {
    cli.out(data);
    return;
  }
  console.log(`  ${color.green('✓')} sent to ${color.dim(`id:${id}`)} ${color.dim(`(mode:${mode})`)}`);
}

async function cmdThreadSpawn() {
  const projectId = typeof flags.project === 'string' ? flags.project : undefined;
  if (!projectId) die('usage: bb thread spawn --project <id> [--prompt <text>]');
  const prompt = firstString(
    typeof flags.prompt === 'string' ? flags.prompt : undefined,
    positional.slice(2).join(' ').trim() || undefined,
  );
  if (!prompt) die('bb thread spawn needs --prompt <text>');
  const body = {
    projectId,
    origin: 'sdk',
    input: [{ type: 'text', text: prompt, mentions: [] }],
    environment: { type: 'project-default' },
  };
  if (typeof flags.environment === 'string') {
    body.environment = { type: 'reuse', environmentId: flags.environment };
  } else if (typeof flags['new-environment'] === 'string') {
    if (flags['new-environment'] !== 'worktree') die('--new-environment currently supports only "worktree"');
    const workspace = {
      type: 'managed-worktree',
      baseBranch:
        typeof flags['base-branch'] === 'string'
          ? { kind: 'named', name: flags['base-branch'] }
          : { kind: 'default' },
    };
    const hostId = await resolveHostId(
      firstString(
        typeof flags.host === 'string' ? flags.host : undefined,
        typeof flags.machine === 'string' ? flags.machine : undefined,
      ),
    );
    body.environment = { type: 'host', hostId, workspace };
  }
  if (typeof flags.provider === 'string') body.providerId = flags.provider;
  if (typeof flags.model === 'string') body.model = flags.model;
  if (typeof flags.title === 'string') body.title = flags.title;
  if (typeof flags['service-tier'] === 'string') body.serviceTier = flags['service-tier'];
  if (typeof flags['reasoning-level'] === 'string') body.reasoningLevel = flags['reasoning-level'];
  if (typeof flags['permission-mode'] === 'string') body.permissionMode = flags['permission-mode'];
  if (typeof flags['parent-thread'] === 'string') body.parentThreadId = flags['parent-thread'];
  if (typeof flags.section === 'string') body.sectionId = flags.section;
  if (typeof flags.visibility === 'string') body.visibility = flags.visibility;
  const data = await request('post', '/threads', { body });
  if (flags.json) {
    cli.out(data);
    return;
  }
  const thread = data.thread || data;
  console.log(`  ${color.green('✓')} spawned ${color.cyan(color.bold(threadTitle(thread)))}  ${color.dim(`id:${thread.id}`)}`);
}

async function cmdThreadStop() {
  const id = await resolveThreadId(positional[2], 'usage: bb thread stop <id> | bb thread stop --self');
  const data = await request('post', `/threads/${encodeURIComponent(id)}/stop`, { body: {} });
  if (flags.json) {
    cli.out(data);
    return;
  }
  console.log(`  ${color.green('✓')} stop requested for ${color.dim(`id:${id}`)}`);
}

async function cmdThreadWait() {
  const id = await resolveThreadId(positional[2], 'usage: bb thread wait <id> [--status idle]');
  const target = typeof flags.status === 'string' ? flags.status : 'idle';
  const timeoutMs = clampInt(flags.timeout, 1200, 1, 86400) * 1000;
  const intervalMs = clampInt(flags['poll-interval'], 1000, 250, 60000);
  const deadline = Date.now() + timeoutMs;
  let thread = null;
  while (Date.now() < deadline) {
    const data = await request('get', `/threads/${encodeURIComponent(id)}`);
    thread = data.thread || data;
    if (thread.status === target) {
      if (flags.json) {
        cli.out({ threadId: id, status: thread.status, reached: true });
        return;
      }
      console.log(`  ${color.green('✓')} ${color.dim(`id:${id}`)} reached ${color.bold(target)}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (flags.json) {
    cli.out({ threadId: id, status: thread?.status ?? null, reached: false });
    process.exit(1);
  }
  die(`timed out after ${timeoutMs / 1000}s — ${id} is ${thread?.status ?? 'unknown'}, not ${target}`);
}

async function cmdThreadQueue() {
  const sub = positional[2] === 'list' ? 'list' : positional[2];
  if (sub !== undefined && sub !== 'list') die('usage: bb thread queue list [<id>] [--self]');
  const id = await resolveThreadId(positional[3], 'usage: bb thread queue list <id> | bb thread queue list --self');
  const data = await request('get', `/threads/${encodeURIComponent(id)}/queued-messages`);
  if (flags.json) {
    cli.out(data);
    return;
  }
  const messages = Array.isArray(data) ? data : data.messages || [];
  console.log('');
  if (messages.length === 0) {
    console.log(color.dim('  No queued messages.'));
    return;
  }
  for (const message of messages) {
    const text = promptText(message.content).replace(/\s+/gu, ' ');
    console.log(`  ${color.dim(`id:${message.id}`)}  ${fmt.trunc(text, 110)}`);
  }
}

async function cmdThreadSearch() {
  const query = positional.slice(2).join(' ').trim();
  if (query.length < 2) die('usage: bb thread search <query>  (2+ characters)');
  const params = { query };
  if (flags.limit !== undefined) params.limitPerGroup = String(clampInt(flags.limit, 10, 1, 100));
  const data = await request('get', '/threads/search', { params });
  if (flags.json) {
    cli.out(data);
    return;
  }
  // Results arrive grouped: {active: {total, results:[{thread, matches}]}, archived: {…}}.
  const groups = Array.isArray(data)
    ? [['results', { results: data }]]
    : Object.entries(data).filter(([, group]) => group && Array.isArray(group.results));
  const total = groups.reduce((sum, [, group]) => sum + group.results.length, 0);
  console.log('');
  if (total === 0) {
    console.log(color.dim('  No matches.'));
    return;
  }
  for (const [name, group] of groups) {
    if (group.results.length === 0) continue;
    console.log(color.dim(`  ${name}:`));
    for (const entry of group.results) {
      printThreadRow(entry.thread || entry);
      for (const match of (entry.matches || []).slice(0, 2)) {
        const snippet = fmt.trunc(String(match.text || '').replace(/\s+/gu, ' '), 110);
        console.log(`      ${color.dim(`${match.sourceKind || 'match'}:`)} ${snippet}`);
      }
    }
    console.log('');
  }
}

// ── dispatch ──────────────────────────────────────────────────────────
const THREAD_COMMANDS = {
  list: cmdThreadList,
  show: cmdThreadShow,
  log: cmdThreadLog,
  output: cmdThreadOutput,
  tell: cmdThreadTell,
  spawn: cmdThreadSpawn,
  stop: cmdThreadStop,
  wait: cmdThreadWait,
  search: cmdThreadSearch,
  queue: cmdThreadQueue,
};

async function main() {
  if (flags.help || flags.h || !group || group === 'help') cli.help(HELP);
  try {
    if (group === 'pair') return await cmdPair();
if (group === 'attach') return await cmdAttach();
    if (group === 'unpair') return await cmdUnpair();
    if (group === 'self') return await cmdSelf();
    if (group === 'status') return await cmdStatus();
    if (group === 'host') {
const sub = positional[1] || 'list';
if (sub === 'list') return await cmdHostList();
die(`unknown command: bb host ${sub}\nRun 'bb --help' for usage.`);
}
if (group === 'project') {
      const sub = positional[1] || '';
      if (sub === 'list') return await cmdProjectList();
      if (sub === 'show') return await cmdProjectShow();
      die(`unknown command: bb project ${sub || '(none)'}\nRun 'bb --help' for usage.`);
    }
    if (group === 'thread') {
      const sub = positional[1] || '';
      const handler = THREAD_COMMANDS[sub];
      if (!handler) die(`unknown command: bb thread ${sub || '(none)'}\nRun 'bb --help' for usage.`);
      return await handler();
    }
    die(`unknown command: ${group}\nRun 'bb --help' for usage.`);
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    die(err.message);
  }
}

await main();
