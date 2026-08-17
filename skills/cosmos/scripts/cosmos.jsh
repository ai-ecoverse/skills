// cosmos.jsh - Augment Code "Cosmos" agent sessions from the shell.
//
// Cosmos (https://cosmos.augmentcode.com) runs coding agents ("sessions"). Each
// session is created from an "expert" preset (for example "PR Author (GitHub)")
// inside an environment / folder (for example "AI Ecoverse"). This script lists
// experts and environments, reads sessions and their messages, and delegates a
// new session, without driving the UI.
//
// AUTH: session cookie only. Cosmos sends no Authorization header and no API
// key, and SLICC's realm `fetch()` strips cookie headers and cannot set Origin,
// so every request is issued from the page context of an open Cosmos tab via
// `sliccy:browser`. Same pattern as skills/wunderflats.
//
// Wire format captured with the secret-sauce skill (HAR) and re-checked live
// against a logged-in tab on 2026-08-17. Full record: references/api.md.
//
// SAFETY: `delegate` creates a session, which spends real compute on the user's
// account. It is a dry run unless --confirm is passed.

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');

const PREFIX = 'cosmos';
const ORIGIN = 'https://cosmos.augmentcode.com';
const TAB_MATCH = /cosmos\.augmentcode\.com/i;

// Services, so a typo in one place cannot silently address another backend.
const POSEIDON = 'web_rpc_proxy.PoseidonProxyService';
const EXPERTS = 'web_rpc_proxy.ExpertProxyService';
const BOOT = 'web_rpc_proxy.WebappBootService';
const PUBLIC_API = 'public_api.Augment';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i; // ULID-shaped, e.g. 01M07QQF8ZPWVGG1TWEWCK9S9W

const HELP = `
cosmos - Augment Code Cosmos agent sessions (uses browser session)

USAGE
  cosmos me                                  Auth state + boot config
  cosmos experts                             Expert presets you can delegate to
  cosmos environments                        Environments / folders (alias: folders)
  cosmos agents [--limit N]                  Recent sessions, newest first
  cosmos agent <agentId>                     One session in detail
  cosmos messages <agentId> [--limit N]      Transcript, tool results summarised
  cosmos models                              Completion models the API reports
  cosmos delegate "<prompt>" --expert <name|id> [--confirm]
                                             Create a session from an expert

FLAGS
  --json                 Raw API response, no human formatting
  --limit N              agents: sessions (1-100, default 20)
                         messages: exchanges (1-100, default 10); the server
                         returns one user and one assistant message per exchange
  --full                 messages: print whole text and tool results, not summaries
  --expert <name|id>     delegate: expert by id, slug, name or unique substring
  --env <name|id>        delegate: environment by id, display name or substring
  --model <id>           delegate: override the expert's model (e.g. gpt-5-6-sol)
  --visibility <v>       delegate: shared | private (default: expert's own)
  --cpu <cores>          delegate: VM cpu cores, only with --env
  --memory <mib>         delegate: VM memory in MiB, only with --env
  --confirm              delegate: actually create the session
  -h, --help             This help, or help for a single command

REQUIRES
  A https://cosmos.augmentcode.com tab open and logged in. Auth is the session
  cookie, so requests run inside that tab. Nothing is stored on disk.

DELEGATE IS GATED
  Without --confirm, delegate resolves the expert, prints the exact request it
  would send, and exits 0. Creating a session spends compute on your account,
  so the write only happens when you ask for it twice.

EXAMPLES
  cosmos agents --limit 5
  cosmos messages 01M07QQF8ZPWVGG1TWEWCK9S9W --limit 3
  cosmos experts --json
  cosmos delegate "Fix the flaky test in packages/webapp" --expert "PR Author"
  cosmos delegate "Fix issue 2137" --expert pr-author-github-2z4hvjvghl \\
    --env "AI Ecoverse" --confirm

NOTES
  Model ids for --model come from 'cosmos experts' (each expert reports the
  session model it uses). 'cosmos models' lists the completion-model catalogue,
  whose names are opaque hashes and are not session model ids.
  Wire format and known gaps: references/api.md
`.trim();

const COMMAND_HELP = {
  me: `
cosmos me - auth state and boot config

USAGE
  cosmos me [--json]

Calls WebappBootService/IsAuthenticated and WebappBootService/GetBootConfig.
The analytics write key in the boot config is redacted from all output.
`.trim(),
  experts: `
cosmos experts - expert presets available for delegation

USAGE
  cosmos experts [--json]

Calls ExpertProxyService/ListExpertsWithUsage. Expert names are NOT unique
(several experts are called "PR Author (GitHub)"), so prefer the id or the slug
when passing one to 'cosmos delegate --expert'.
`.trim(),
  environments: `
cosmos environments - environments / folders (alias: cosmos folders)

USAGE
  cosmos environments [--json]

Calls PoseidonProxyService/ListEnvironments. The id of a base-image environment
is what 'cosmos delegate --env' puts in override_vm_config.base_image_id.
`.trim(),
  agents: `
cosmos agents - recent sessions, newest first

USAGE
  cosmos agents [--limit N] [--json]

Calls PoseidonProxyService/ListAgents with {"limit": N}. Without a limit the
server returns 100 sessions, which was a 1.2 MB response on a real account, so
--limit defaults to 20. The response carries totalCount, hasMore and
nextPageToken; --json passes them through.
`.trim(),
  agent: `
cosmos agent - one session in detail

USAGE
  cosmos agent <agentId> [--json]

Calls PoseidonProxyService/GetAgent with {"agentId": "<id>"}.
`.trim(),
  messages: `
cosmos messages - session transcript

USAGE
  cosmos messages <agentId> [--limit N] [--full] [--json]

Calls PoseidonProxyService/GetMessages with {"agentId": "<id>", "limit": N}.
limit counts exchanges, not messages: limit 3 returned 6 messages. Full
transcripts reach 300 KB, so thinking blocks, tool calls and tool results are
summarised unless --full is passed.
`.trim(),
  models: `
cosmos models - completion model catalogue

USAGE
  cosmos models [--json]

Calls public_api.Augment/GetModels. The names are opaque 64-hex hashes, not the
session model ids (gpt-5-6-sol, claude-opus-5) that --model expects. Get those
from 'cosmos experts'.
`.trim(),
  delegate: `
cosmos delegate - create a session from an expert

USAGE
  cosmos delegate "<prompt>" --expert <name|id> [--env <name|id>] [--model <id>]
                   [--visibility shared|private] [--cpu N] [--memory MiB]
                   [--confirm] [--json]

Calls ExpertProxyService/CreateAgentFromExpert. Without --confirm nothing is
sent: the resolved ids and the exact request body are printed and the command
exits 0. With --confirm exactly one POST is issued.

The request carries two client-generated UUIDs, idempotency_key and
initial_message_request_id, so a retry after a network failure cannot create a
second session. agentName is the first line of the prompt, capped at 100 chars.

Capabilities are deliberately NOT overridden, so the expert's own capability set
applies. See references/api.md for why.
`.trim(),
};

// ─── args ────────────────────────────────────────────────────────────────────

// Flag parsing is local rather than process.argv.parseFlags(): the runtime
// helper has no boolean allowlist, so it eats the token after a bare boolean as
// that flag's value. `cosmos delegate --confirm "my prompt"` would lose the
// prompt. search.jsh and gh.jsh keep local parsers for the same reason.
const BOOLEAN_FLAGS = new Set(['json', 'confirm', 'full', 'help', 'h']);
const ALIASES = { h: 'help', l: 'limit', e: 'expert', n: 'limit' };
const FLAG_RE = /^--?[A-Za-z]/;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!literal && a === '--') {
      literal = true;
      continue;
    }
    if (literal || !FLAG_RE.test(a)) {
      positional.push(a);
      continue;
    }
    let key = a.slice(a.startsWith('--') ? 2 : 1);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    key = ALIASES[key] || key;
    if (val === undefined) {
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || FLAG_RE.test(next)) val = true;
      else {
        val = next;
        i++;
      }
    }
    flags[key] = val;
  }
  return { positional, flags };
}

const parsed = parseArgs(process.argv.slice(2));
const flags = parsed.flags;
const subcommand = (parsed.positional[0] || '').toLowerCase();
const positional = parsed.positional.slice(1);

/** Bare flags parse to boolean true; only accept a real string value. */
function str(v) {
  return typeof v === 'string' ? v : undefined;
}

function requireValue(name) {
  const v = str(flags[name]);
  if (v === undefined) cli.die(`--${name} expects a value`, { prefix: PREFIX });
  return v;
}

function intFlag(name, def, min, max) {
  const raw = flags[name];
  if (raw === undefined) return def;
  const v = str(raw);
  if (v === undefined) cli.die(`--${name} expects a number`, { prefix: PREFIX });
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) cli.die(`--${name} expects a number, got ${v}`, { prefix: PREFIX });
  return Math.min(Math.max(n, min), max);
}

function numFlag(name) {
  const v = str(flags[name]);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) cli.die(`--${name} expects a number, got ${v}`, { prefix: PREFIX });
  return n;
}

// ─── session ─────────────────────────────────────────────────────────────────

let _tab = null;

async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: TAB_MATCH });
  if (!_tab) {
    cli.die(
      'no Cosmos tab found: open https://cosmos.augmentcode.com in your browser,\n' +
        '  log in, then retry. Auth is the session cookie, so the request has to run\n' +
        '  inside that tab.',
      { prefix: PREFIX }
    );
  }
  return _tab;
}

function authExpired() {
  cli.die('session expired: reload https://cosmos.augmentcode.com, log in, then retry', {
    prefix: PREFIX,
  });
}

/**
 * One POST per RPC. Connect-style JSON: the method lives in the path and the
 * body is a plain JSON message. The two WebappBootService methods are GET in
 * the UI (Connect GET needs ?connect=v1&encoding=json&message=%7B%7D; a bare GET
 * answers 415), but both also answer POST with {} and the same body, so this
 * keeps a single code path. Verified live 2026-08-17.
 */
async function rpc(tab, service, method, body = {}) {
  const path = `/rpc/${service}/${method}`;
  const res = await browser.fetch(tab, `${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  if (res.status === 401 || res.status === 403) authExpired();

  let payload = res.body;
  if (typeof payload === 'string') {
    // A login wall answers HTML where JSON was expected.
    if (/^\s*(<!doctype|<html)/i.test(payload)) authExpired();
    try {
      payload = JSON.parse(payload);
    } catch {
      if (res.ok) {
        cli.die(`${method} returned ${res.status} with a non-JSON body`, { prefix: PREFIX });
      }
    }
  }

  if (!res.ok) {
    const detail =
      payload && typeof payload === 'object'
        ? payload.message || payload.error || JSON.stringify(payload).slice(0, 300)
        : String(payload || '').slice(0, 300);
    const suffix = detail ? `: ${detail}` : '';
    cli.die(`${method} failed with ${res.status}${suffix}`, { prefix: PREFIX });
  }
  return payload || {};
}

// ─── formatting helpers ──────────────────────────────────────────────────────

function trunc(s, max) {
  const t = String(s === undefined || s === null ? '' : s);
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function oneLine(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim();
}

/** "AGENT_STATUS_PROCESSING" → "processing" */
function shortEnum(v, prefix) {
  const s = String(v || '');
  return (s.startsWith(prefix) ? s.slice(prefix.length) : s).toLowerCase() || '—';
}

function statusColor(status) {
  const s = shortEnum(status, 'AGENT_STATUS_');
  if (s === 'processing' || s === 'starting') return color.yellow(s);
  if (s === 'idle' || s === 'completed') return color.green(s);
  if (s.includes('error') || s.includes('fail')) return color.red(s);
  return color.gray(s);
}

function when(iso) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso);
  return new Date(t).toISOString().replace('T', ' ').slice(0, 16);
}

function sessionUrl(agentId) {
  return `${ORIGIN}/session?agentId=${encodeURIComponent(agentId)}`;
}

function rule() {
  console.log(color.dim(`  ${'─'.repeat(56)}`));
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function requireAgentId(id) {
  if (!id) cli.die(`usage: ${PREFIX} ${subcommand} <agentId>`, { prefix: PREFIX });
  if (!AGENT_ID_RE.test(id)) {
    cli.die(`invalid agent id: ${trunc(id, 40)} (expected 26 characters, e.g. 01M07QQF8Z…)`, {
      prefix: PREFIX,
    });
  }
  return id.toUpperCase();
}

// ─── me ──────────────────────────────────────────────────────────────────────

/** The boot config carries an analytics write key. Never print it. (#203) */
function redactBoot(boot) {
  if (!boot || typeof boot !== 'object') return boot;
  const out = { ...boot };
  if (out.segment && typeof out.segment === 'object') {
    out.segment = { ...out.segment };
    if (out.segment.writeKey) out.segment.writeKey = '[redacted]';
  }
  return out;
}

async function cmdMe(tab) {
  const auth = await rpc(tab, BOOT, 'IsAuthenticated');
  const boot = redactBoot(await rpc(tab, BOOT, 'GetBootConfig'));

  if (flags.json) {
    cli.out({ authenticated: auth.authenticated === true, ...auth, bootConfig: boot });
    if (auth.authenticated !== true) process.exit(1);
    return;
  }

  console.log('');
  console.log(`  ${color.cyan(color.bold('Cosmos'))}`);
  rule();
  console.log(
    `  ${color.dim('Authenticated:')}  ${
      auth.authenticated === true ? color.green('yes') : color.red('no')
    }`
  );
  if (auth.homeCosmosHostname) {
    console.log(`  ${color.dim('Home host:')}      ${auth.homeCosmosHostname}`);
  }
  if (boot.authCentralBaseUrl) {
    console.log(`  ${color.dim('Auth central:')}   ${boot.authCentralBaseUrl}`);
  }
  if (boot.segment) {
    console.log(`  ${color.dim('Analytics:')}      segment configured (write key not shown)`);
  }
  console.log('');
  if (auth.authenticated !== true) {
    cli.die('not authenticated: log in at https://cosmos.augmentcode.com and retry', {
      prefix: PREFIX,
    });
  }
}

// ─── experts ─────────────────────────────────────────────────────────────────

/**
 * ListExpertsWithUsage groups experts into recentlyUsed / popular / other, and
 * the same expert can appear in more than one group. Flatten to one row per
 * expertId, first occurrence wins, so ids stay unique for resolution.
 */
function flattenExperts(data) {
  const rows = [];
  const seen = new Set();
  for (const group of ['recentlyUsed', 'popular', 'other']) {
    const entries = Array.isArray(data && data[group]) ? data[group] : [];
    for (const entry of entries) {
      const expert = (entry && entry.expert) || entry || {};
      const id = expert.expertId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const config = expert.config || {};
      const session = config.sessionConfig || {};
      const vm = config.vmConfig || {};
      rows.push({
        expertId: id,
        name: config.name || '(unnamed)',
        description: config.description || '',
        model: session.model || '',
        slug: expert.slug || '',
        scope: expert.scope || '',
        group,
        lastUsedAt: (entry && entry.lastUsedAt) || '',
        baseImageId: vm.baseImageId || '',
      });
    }
  }
  return rows;
}

async function listExperts(tab) {
  const data = await rpc(tab, EXPERTS, 'ListExpertsWithUsage');
  return { data, rows: flattenExperts(data) };
}

async function cmdExperts(tab) {
  const { data, rows } = await listExperts(tab);
  if (flags.json) {
    cli.out(data);
    return;
  }
  console.log('');
  console.log(`  ${color.bold('Experts')}${color.dim(`  (${rows.length})`)}`);
  rule();
  if (!rows.length) {
    console.log(color.dim('  No experts available.'));
    console.log('');
    return;
  }
  for (const e of rows) {
    console.log(`  ${color.cyan(color.bold(e.name))}  ${color.dim(e.group)}`);
    if (e.description) console.log(`     ${trunc(oneLine(e.description), 90)}`);
    const bits = [`id:${e.expertId}`];
    if (e.slug) bits.push(`slug:${e.slug}`);
    if (e.model) bits.push(`model:${e.model}`);
    if (e.lastUsedAt) bits.push(`used:${when(e.lastUsedAt)}`);
    console.log(`     ${color.dim(bits.join('  ·  '))}`);
  }
  console.log('');
  console.log(color.dim('  Names repeat, so pass an id or slug to delegate --expert.'));
  console.log('');
}

// ─── environments ────────────────────────────────────────────────────────────

async function listEnvironments(tab) {
  const data = await rpc(tab, POSEIDON, 'ListEnvironments');
  const rows = Array.isArray(data && data.environments) ? data.environments : [];
  return { data, rows };
}

async function cmdEnvironments(tab) {
  const { data, rows } = await listEnvironments(tab);
  if (flags.json) {
    cli.out(data);
    return;
  }
  console.log('');
  console.log(`  ${color.bold('Environments')}${color.dim(`  (${rows.length})`)}`);
  rule();
  if (!rows.length) {
    console.log(color.dim('  No environments.'));
    console.log('');
    return;
  }
  for (const env of rows) {
    console.log(`  ${color.cyan(color.bold(env.displayName || '(unnamed)'))}`);
    if (env.description) console.log(`     ${trunc(oneLine(env.description), 90)}`);
    const bits = [`id:${env.id}`, shortEnum(env.kind, 'ENVIRONMENT_KIND_')];
    if (env.status) bits.push(shortEnum(env.status, 'IMAGE_STATUS_'));
    if (env.currentVersion) bits.push(`version:${env.currentVersion}`);
    console.log(`     ${color.dim(bits.join('  ·  '))}`);
  }
  console.log('');
}

// ─── agents ──────────────────────────────────────────────────────────────────

async function cmdAgents(tab) {
  const limit = intFlag('limit', 20, 1, 100);
  const data = await rpc(tab, POSEIDON, 'ListAgents', { limit });
  if (flags.json) {
    cli.out(data);
    return;
  }
  const rows = Array.isArray(data.agents) ? data.agents : [];
  console.log('');
  const total = data.totalCount === undefined ? rows.length : data.totalCount;
  console.log(`  ${color.bold('Sessions')}${color.dim(`  showing ${rows.length} of ${total}`)}`);
  rule();
  if (!rows.length) {
    console.log(color.dim('  No sessions.'));
    console.log('');
    return;
  }
  for (const a of rows) {
    console.log(`  ${color.cyan(color.bold(trunc(oneLine(a.agentName) || '(unnamed)', 74)))}`);
    const bits = [`id:${a.agentId}`, statusColor(a.status), when(a.createdAt)];
    const model = a.sessionConfig && a.sessionConfig.model;
    if (model) bits.push(model);
    console.log(`     ${color.dim(bits.join('  ·  '))}`);
  }
  console.log('');
  if (data.hasMore) {
    console.log(color.dim('  More sessions exist: raise --limit (max 100) or use --json.'));
    console.log('');
  }
}

async function cmdAgent(tab) {
  const agentId = requireAgentId(positional[0]);
  const data = await rpc(tab, POSEIDON, 'GetAgent', { agentId });
  if (flags.json) {
    cli.out(data);
    return;
  }
  const a = data.agent || data;
  const session = a.sessionConfig || {};
  console.log('');
  console.log(`  ${color.cyan(color.bold(oneLine(a.agentName) || '(unnamed)'))}`);
  rule();
  console.log(`  ${color.dim('ID:')}            ${a.agentId || agentId}`);
  console.log(`  ${color.dim('Status:')}        ${statusColor(a.status)}`);
  if (a.detailedStatus && a.detailedStatus !== a.status) {
    console.log(`  ${color.dim('Detailed:')}      ${shortEnum(a.detailedStatus, 'AGENT_STATUS_')}`);
  }
  if (session.model) console.log(`  ${color.dim('Model:')}         ${session.model}`);
  if (session.visibility) {
    console.log(
      `  ${color.dim('Visibility:')}    ${shortEnum(session.visibility, 'SESSION_VISIBILITY_')}`
    );
  }
  if (a.expertId) console.log(`  ${color.dim('Expert:')}        ${a.expertId}`);
  if (a.environmentId) console.log(`  ${color.dim('Environment:')}   ${a.environmentId}`);
  console.log(`  ${color.dim('Created:')}       ${when(a.createdAt)}`);
  console.log(`  ${color.dim('Updated:')}       ${when(a.updatedAt)}`);
  if (Array.isArray(a.capabilities) && a.capabilities.length) {
    const caps = a.capabilities.map((c) => shortEnum(c, 'AGENT_CAPABILITY_')).join(', ');
    console.log(`  ${color.dim('Capabilities:')}  ${caps}`);
  }
  if (Array.isArray(a.workspaceFolders) && a.workspaceFolders.length) {
    console.log(`  ${color.dim('Workspace:')}     ${a.workspaceFolders.length} folder(s)`);
  }
  if (a.pendingMessageCount) {
    console.log(`  ${color.dim('Pending:')}       ${a.pendingMessageCount} message(s)`);
  }
  console.log(`  ${color.dim('URL:')}           ${sessionUrl(a.agentId || agentId)}`);
  console.log('');
}

// ─── messages ────────────────────────────────────────────────────────────────

/**
 * A content part is a one-key object naming its kind. Observed kinds: text,
 * thinking {content}, toolUse {id, name, input}, toolResult {toolUseId,
 * content, isError}. The inner shape of `text` was not observed directly, so
 * accept a bare string or a {content} / {text} wrapper.
 */
function partSummary(part, full) {
  if (!part || typeof part !== 'object') return null;
  const kind = Object.keys(part)[0];
  const value = part[kind];

  const inner = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.content || v.text || '';
    return '';
  };

  if (kind === 'text') {
    const text = inner(value);
    if (!text) return null;
    return { kind: 'text', body: full ? text : trunc(oneLine(text), 240) };
  }
  if (kind === 'thinking') {
    const text = inner(value);
    if (full) return { kind: 'thinking', body: text };
    return { kind: 'thinking', body: `${text.length} chars: ${trunc(oneLine(text), 120)}` };
  }
  if (kind === 'toolUse') {
    const name = (value && value.name) || 'tool';
    const input = value && value.input;
    const shown = typeof input === 'string' ? input : JSON.stringify(input || {});
    return { kind: 'tool-use', body: `${name} ${full ? shown : trunc(oneLine(shown), 140)}` };
  }
  if (kind === 'toolResult') {
    const text = inner(value);
    const id = (value && value.toolUseId) || '';
    const state = value && value.isError ? 'error' : 'ok';
    if (full) return { kind: 'tool-result', body: `${id} (${state})\n${text}` };
    const head = trunc(oneLine(text.split('\n')[0] || ''), 120);
    return {
      kind: 'tool-result',
      body: `${trunc(id, 20)} (${state}, ${bytes(text.length)}) ${head}`,
    };
  }
  return { kind, body: full ? JSON.stringify(value) : trunc(JSON.stringify(value), 140) };
}

async function cmdMessages(tab) {
  const agentId = requireAgentId(positional[0]);
  const limit = intFlag('limit', 10, 1, 100);
  const data = await rpc(tab, POSEIDON, 'GetMessages', { agentId, limit });
  if (flags.json) {
    cli.out(data);
    return;
  }
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  const full = flags.full === true;

  console.log('');
  const head = [`${msgs.length} message(s)`];
  if (data.agentStatus) head.push(shortEnum(data.agentStatus, 'AGENT_STATUS_'));
  if (data.hasMore) head.push('older messages exist');
  console.log(`  ${color.bold('Transcript')}${color.dim(`  ${head.join('  ·  ')}`)}`);
  console.log(color.dim(`  ${agentId}`));
  rule();
  if (!msgs.length) {
    console.log(color.dim('  No messages yet.'));
    console.log('');
    return;
  }
  for (const m of msgs) {
    const role = m.role === 'assistant' ? color.cyan('assistant') : color.green(String(m.role));
    console.log(`  ${color.dim(when(m.createdAt))}  ${color.bold(role)}`);
    const parts = Array.isArray(m.content) ? m.content : [];
    let printed = 0;
    for (const p of parts) {
      const s = partSummary(p, full);
      if (!s) continue;
      printed++;
      const label = color.dim(`${s.kind}:`);
      for (const [i, line] of String(s.body).split('\n').entries()) {
        console.log(i === 0 ? `     ${label} ${line}` : `       ${line}`);
      }
    }
    if (!printed) console.log(color.dim('     (no renderable content)'));
  }
  console.log('');
  if (!full) console.log(color.dim('  Tool output summarised. Pass --full for everything.'));
  console.log('');
}

// ─── models ──────────────────────────────────────────────────────────────────

async function cmdModels(tab) {
  const data = await rpc(tab, PUBLIC_API, 'GetModels');
  if (flags.json) {
    cli.out(data);
    return;
  }
  const models = Array.isArray(data.models) ? data.models : [];
  console.log('');
  console.log(`  ${color.bold('Models')}${color.dim(`  (${models.length})`)}`);
  rule();
  if (data.default_model) {
    console.log(`  ${color.dim('Default:')}  ${data.default_model}`);
  }
  for (const m of models.slice(0, 20)) {
    const marks = [];
    if (m.is_default) marks.push('default');
    if (m.max_memorize_size_bytes) marks.push(`memorize:${m.max_memorize_size_bytes}`);
    console.log(`  ${m.name}${marks.length ? color.dim(`  ${marks.join(' · ')}`) : ''}`);
  }
  if (models.length > 20) console.log(color.dim(`  … ${models.length - 20} more (use --json)`));
  console.log('');
  console.log(
    color.dim('  These names are opaque completion-model hashes. Session model ids for')
  );
  console.log(color.dim("  delegate --model come from 'cosmos experts'."));
  console.log('');
}

// ─── delegate ────────────────────────────────────────────────────────────────

function newUuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const groups = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)];
  return groups.join('-');
}

/** First line of the prompt, capped at 100 chars, like the web UI does. */
function deriveAgentName(prompt) {
  const firstLine = oneLine(String(prompt).split('\n')[0] || '');
  const source = firstLine || oneLine(prompt);
  return source.slice(0, 100) || 'Untitled session';
}

/**
 * Resolve a user-supplied expert reference to exactly one id. Expert names are
 * not unique on a real account, so an ambiguous match is an error listing the
 * candidates rather than a silent pick of the first one.
 */
function resolveOne(rows, want, kindLabel, describe) {
  const needle = String(want).trim().toLowerCase();
  const stages = [
    ['id', (r) => r.id.toLowerCase() === needle],
    ['slug', (r) => r.slug && r.slug.toLowerCase() === needle],
    ['name', (r) => r.name.toLowerCase() === needle],
    ['substring', (r) => r.name.toLowerCase().includes(needle)],
  ];
  for (const [stage, test] of stages) {
    const hits = rows.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const list = hits.map((h) => `    ${describe(h)}`).join('\n');
      cli.die(
        `--${kindLabel} "${want}" matches ${hits.length} ${kindLabel}s by ${stage}:\n${list}\n` +
          '  Pass an id to disambiguate.',
        { prefix: PREFIX }
      );
    }
  }
  cli.die(`no ${kindLabel} matches "${want}": run 'cosmos ${kindLabel}s' to list them`, {
    prefix: PREFIX,
  });
}

async function resolveExpert(tab, want) {
  if (UUID_RE.test(want)) return { id: want, name: '(by id)', slug: '', model: '' };
  const { rows } = await listExperts(tab);
  const hit = resolveOne(
    rows.map((r) => ({ id: r.expertId, name: r.name, slug: r.slug, model: r.model })),
    want,
    'expert',
    (h) => `${h.name}  id:${h.id}${h.slug ? `  slug:${h.slug}` : ''}`
  );
  return hit;
}

async function resolveEnvironment(tab, want) {
  if (UUID_RE.test(want)) return { id: want, name: '(by id)', slug: '' };
  const { rows } = await listEnvironments(tab);
  return resolveOne(
    rows.map((r) => ({ id: r.id, name: r.displayName || '', slug: '' })),
    want,
    'environment',
    (h) => `${h.name}  id:${h.id}`
  );
}

const VISIBILITY = {
  shared: 'SESSION_VISIBILITY_SHARED',
  private: 'SESSION_VISIBILITY_PRIVATE',
};

/**
 * Build the CreateAgentFromExpert body. Field naming is reproduced from the
 * capture as-is: camelCase expertId and agentName next to snake_case
 * idempotency_key and initial_message. protojson accepts either spelling, but
 * matching the web client keeps the request indistinguishable from the UI's.
 *
 * Only fields the caller asked for are sent. In particular
 * override_builtin_capabilities and override_capability_instance_ids are
 * omitted: the paired has_override_* booleans prove the server distinguishes
 * "not overriding" from "overriding with an empty list", so omitting both means
 * the expert's own capability set applies. The web UI always sends them because
 * it mirrors its picker widgets, and their values are per-expert enum numbers
 * that cannot be derived safely for an arbitrary expert.
 */
function buildDelegateBody(opts) {
  const body = {
    expertId: opts.expertId,
    agentName: deriveAgentName(opts.prompt),
    idempotency_key: opts.idempotencyKey,
    initial_message: opts.prompt,
    initial_message_request_id: opts.initialMessageRequestId,
  };
  if (opts.model) body.override_model = opts.model;
  if (opts.visibility) body.override_visibility = opts.visibility;
  if (opts.environmentId) {
    const vm = { base_image_id: opts.environmentId };
    if (opts.cpuCores !== undefined || opts.memoryMib !== undefined) {
      vm.resources = {};
      if (opts.cpuCores !== undefined) vm.resources.cpuCores = opts.cpuCores;
      if (opts.memoryMib !== undefined) vm.resources.memoryMib = opts.memoryMib;
    }
    body.override_vm_config = vm;
  }
  return body;
}

async function cmdDelegate(tab) {
  const prompt = positional.join(' ').trim();
  if (!prompt) {
    cli.die('usage: cosmos delegate "<prompt>" --expert <name|id> [--confirm]', { prefix: PREFIX });
  }
  if (flags.expert === undefined) {
    cli.die("--expert is required: run 'cosmos experts' to list them", { prefix: PREFIX });
  }
  const wantExpert = requireValue('expert');

  let visibility;
  if (flags.visibility !== undefined) {
    const v = requireValue('visibility').toLowerCase();
    visibility = VISIBILITY[v];
    if (!visibility) {
      cli.die(`--visibility must be shared or private, got ${v}`, { prefix: PREFIX });
    }
  }
  const cpuCores = numFlag('cpu');
  const memoryMib = numFlag('memory');
  if ((cpuCores !== undefined || memoryMib !== undefined) && flags.env === undefined) {
    cli.die('--cpu and --memory only apply together with --env', { prefix: PREFIX });
  }

  const expert = await resolveExpert(tab, wantExpert);
  const environment =
    flags.env === undefined ? null : await resolveEnvironment(tab, requireValue('env'));

  const body = buildDelegateBody({
    expertId: expert.id,
    prompt,
    idempotencyKey: newUuid(),
    initialMessageRequestId: newUuid(),
    model: str(flags.model),
    visibility,
    environmentId: environment ? environment.id : undefined,
    cpuCores,
    memoryMib,
  });

  const endpoint = `${ORIGIN}/rpc/${EXPERTS}/CreateAgentFromExpert`;

  if (flags.confirm !== true) {
    if (flags.json) {
      cli.out({ dryRun: true, endpoint, method: 'POST', body });
      return;
    }
    console.log('');
    console.log(`  ${color.bold('Delegate (dry run)')}${color.dim('  nothing was sent')}`);
    rule();
    console.log(`  ${color.dim('Expert:')}       ${expert.name}  ${color.dim(`id:${expert.id}`)}`);
    if (environment) {
      console.log(
        `  ${color.dim('Environment:')}  ${environment.name}  ${color.dim(`id:${environment.id}`)}`
      );
    }
    console.log(`  ${color.dim('Session name:')} ${body.agentName}`);
    console.log(`  ${color.dim('POST')}          ${endpoint}`);
    console.log('');
    console.log(JSON.stringify(body, null, 2));
    console.log('');
    console.log(`  ${color.yellow('Dry run.')} Re-run with --confirm to create the session.`);
    console.log(color.dim('  Creating a session spends compute on your Augment account.'));
    console.log('');
    return;
  }

  const data = await rpc(tab, EXPERTS, 'CreateAgentFromExpert', body);
  if (flags.json) {
    cli.out(data);
    return;
  }
  const a = data.agent || {};
  console.log('');
  console.log(`  ${color.green('✓')} Session created`);
  console.log(`  ${color.dim('Name:')}    ${oneLine(a.agentName) || body.agentName}`);
  console.log(`  ${color.dim('ID:')}      ${a.agentId || '—'}`);
  console.log(`  ${color.dim('Status:')}  ${statusColor(a.status)}`);
  if (Array.isArray(a.capabilities) && a.capabilities.length) {
    console.log(
      `  ${color.dim('Caps:')}    ${a.capabilities
        .map((c) => shortEnum(c, 'AGENT_CAPABILITY_'))
        .join(', ')}`
    );
  }
  if (a.agentId) console.log(`  ${color.dim('URL:')}     ${sessionUrl(a.agentId)}`);
  console.log('');
}

// ─── main ────────────────────────────────────────────────────────────────────

const COMMANDS = {
  me: cmdMe,
  experts: cmdExperts,
  environments: cmdEnvironments,
  folders: cmdEnvironments,
  envs: cmdEnvironments,
  agents: cmdAgents,
  sessions: cmdAgents,
  agent: cmdAgent,
  session: cmdAgent,
  messages: cmdMessages,
  models: cmdModels,
  delegate: cmdDelegate,
};

async function main() {
  // Help is side-effect free: no tab lookup, no request, no session created.
  const wantsHelp = flags.help === true || subcommand === 'help';
  if (wantsHelp || !subcommand) {
    const topic = subcommand === 'help' ? (positional[0] || '').toLowerCase() : subcommand;
    cli.help(COMMAND_HELP[topic] || HELP);
  }

  const handler = COMMANDS[subcommand];
  if (!handler) {
    cli.die(`unknown command: ${subcommand}\nRun 'cosmos --help' for usage.`, { prefix: PREFIX });
  }

  const tab = await getTab();
  await handler(tab);
}

await main().catch((err) => {
  if (err && err.name === 'NodeExitError') throw err; // mandatory re-throw
  cli.die(err && err.message ? err.message : String(err), { prefix: PREFIX });
});
