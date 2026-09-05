// fx.jsh — run Vercel's fx coding agent (https://fx.sh) inside SLICC on fx-core.wasm.
//
// Hosts the headless fx agent from the ipk-installed `libfx` package in this
// realm. Model traffic goes through this realm's fetch (Vercel AI Gateway);
// fx's shell tool runs through require('sliccy:exec') on the SLICC VFS;
// config and sessions persist as JSON under /workspace/.fx/.
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const exec = require('sliccy:exec');
const fs = require('fs');

const LIBFX_SPEC = 'libfx@0.0.4';
const ESBUILD_SPEC = 'esbuild-wasm@0.28.2'; // libfx ships ESM; the realm transpiles it with esbuild
const STATE_DIR = '/workspace/.fx';
const WORKSPACE_ROOT = '/workspace';
const PREFIX = 'fx';

const HELP = `
fx — run Vercel's fx coding agent in-process (fx-core.wasm, JSPI)

USAGE
  fx "<prompt>"                  one-shot turn; the answer streams to stdout
  fx --model <id> "<prompt>"     pick a Gateway model (see --models)
  fx --session <id> "<prompt>"   continue a stored session
  fx --sessions                  list stored sessions
  fx --models                    list models the Gateway offers (* = current)

FLAGS
  --json       Raw ACP session updates, one JSON object per line

REQUIRES
  ipk add ${ESBUILD_SPEC} && ipk add ${LIBFX_SPEC}
  AI_GATEWAY_API_KEY — seeded by SLICC when the selected provider is
  vercel-ai-gateway; or pass AI_GATEWAY_API_KEY=… fx …
`.trim();

// ── args ──────────────────────────────────────────────────────────────
const parsed = process.argv.parseFlags();
const flags = parsed.flags;
const prompt = parsed.positional.join(' ').trim();
const listSessions = flags.sessions === true;
const listModels = flags.models === true;

if (flags.help || flags.h || (!prompt && !listSessions && !listModels)) cli.help(HELP);

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) {
  cli.die(
    'AI_GATEWAY_API_KEY is not set — add a "Vercel AI Gateway" account in SLICC and select one of its models, or run `AI_GATEWAY_API_KEY=… fx …`',
    { prefix: PREFIX }
  );
}

// ── runtime ───────────────────────────────────────────────────────────
let sdk;
try {
  sdk = require('libfx/wasm');
} catch (err) {
  cli.die(`cannot load libfx (run: ipk add ${ESBUILD_SPEC} && ipk add ${LIBFX_SPEC}). ${err.message}`, {
    prefix: PREFIX,
  });
}
if (typeof sdk.supportsJspi === 'function' && !sdk.supportsJspi()) {
  cli.die('this runtime has no WebAssembly JSPI (needs Chrome 137+)', { prefix: PREFIX });
}

// fx-core.wasm lives next to fx-sdk.js in the installed package. Prefer the
// kernel-side compile bridge (2.3 MB module, high-headroom context); fall back
// to raw bytes when the bridge is absent.
function findWasmPath() {
  const candidates = [
    `${process.cwd()}/node_modules/libfx/fx-core.wasm`,
    `${WORKSPACE_ROOT}/node_modules/libfx/fx-core.wasm`,
    '/shared/node_modules/libfx/fx-core.wasm',
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[1];
}
async function loadWasm() {
  const path = findWasmPath();
  if (typeof globalThis.__slicc_compileWasm === 'function') {
    return globalThis.__slicc_compileWasm(path);
  }
  const bytes = fs.readFileSync(path);
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

// ── stores (JSON files under /workspace/.fx) ──────────────────────────
function readJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value));
}
const configPath = `${STATE_DIR}/config.json`;
const configStore = {
  get: (id) => {
    const v = readJson(configPath, {})[id];
    return typeof v === 'string' ? v : null;
  },
  set: (id, value) => {
    const all = readJson(configPath, {});
    all[id] = value;
    writeJson(configPath, all);
  },
};

// libfx session contract (fx-sdk.js, libfx 0.0.4): load → {bytes, revision} | null;
// commit(id, bytes, expectedRevision) → {revision}, throws code
// FX_SESSION_REVISION_CONFLICT on mismatch; list → [{id, updatedAtMs}] newest first.
const sessionPath = (id) => `${STATE_DIR}/sessions/${encodeURIComponent(id)}.json`;
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const sessionStore = {
  load: (id) => {
    const rec = readJson(sessionPath(id), null);
    return rec ? { bytes: unb64(rec.value), revision: rec.revision } : null;
  },
  commit: (id, bytes, expectedRevision) => {
    const rec = readJson(sessionPath(id), null);
    if (rec?.revision !== expectedRevision) {
      const err = new Error('fx session revision conflict');
      err.code = 'FX_SESSION_REVISION_CONFLICT';
      throw err;
    }
    const revision = String((Number(rec?.revision) || 0) + 1);
    writeJson(sessionPath(id), { revision, updatedAtMs: Date.now(), value: b64(bytes) });
    return { revision };
  },
  list: () => {
    let names = [];
    try {
      names = fs.readdirSync(`${STATE_DIR}/sessions`);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        const id = decodeURIComponent(n.slice(0, -5));
        const rec = readJson(sessionPath(id), null);
        return rec ? { id, updatedAtMs: rec.updatedAtMs || 0 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  },
  remove: (id) => {
    try {
      fs.unlinkSync(sessionPath(id));
    } catch {
      /* already gone */
    }
  },
};

// ── workspace: fx's shell tool → this SLICC shell ─────────────────────
// libfx validates this shape strictly: cwd === root, gitAvailable false,
// ephemeral true, permission 'allow-sandboxed' | 'prompt'. The command string
// comes from the model and is MEANT to run in a real shell — SLICC's sandbox
// (VFS + sudo policy) is the boundary, exactly as for the cone's own bash tool.
const workspace = {
  info: {
    version: 1,
    root: WORKSPACE_ROOT,
    cwd: WORKSPACE_ROOT,
    home: WORKSPACE_ROOT,
    gitAvailable: false,
    ephemeral: true,
  },
  permission: 'allow-sandboxed',
  exec: async ({ command }) => {
    const r = await exec(`cd ${WORKSPACE_ROOT} && ${command}`);
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  },
};

function pickPermission(request) {
  const options = Array.isArray(request?.options) ? request.options : [];
  const allow = options.find((o) => /allow/i.test(String(o.kind || o.name || '')));
  return (allow || options[0])?.optionId ?? null;
}

// ── main ──────────────────────────────────────────────────────────────
async function runTurn(session) {
  if (flags.model) await session.setModel(String(flags.model));
  const turn = session.prompt(prompt);
  let wroteText = false;
  for await (const update of turn) {
    if (flags.json) {
      console.log(JSON.stringify(update));
      continue;
    }
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      process.stdout.write(update.content.text);
      wroteText = true;
    } else if (update.sessionUpdate === 'tool_call') {
      process.stderr.write(color.dim(`[tool] ${update.title || update.kind || 'call'}\n`));
    }
  }
  if (wroteText) process.stdout.write('\n');
  const stop = await turn.stopReason;
  if (stop !== 'end_turn') cli.warn(`${PREFIX}: stopped (${stop})`);
}

function printModels(session) {
  const modelOpt = (session.configOptions || []).find((o) => o.id === 'model');
  if (flags.json) {
    cli.out(modelOpt?.options || []);
    return;
  }
  for (const o of modelOpt?.options || []) {
    console.log(o.value === modelOpt.currentValue ? color.green(`* ${o.value}`) : `  ${o.value}`);
  }
}

async function main() {
  const agent = await sdk.createFxAgent({
    wasm: await loadWasm(),
    // HOME silences fx's "project instructions omitted: home unavailable" notice.
    env: { AI_GATEWAY_API_KEY: apiKey, HOME: WORKSPACE_ROOT },
    fetch: (url, init) => fetch(url, init),
    onPermission: async (request) => pickPermission(request),
    configStore,
    sessionStore,
    workspace,
  });
  try {
    if (listSessions) {
      const list = await agent.listSessions();
      if (flags.json) cli.out(list);
      else if (!list.length) console.log(color.dim('  No stored sessions.'));
      else for (const s of list) console.log(`  ${JSON.stringify(s)}`);
      return;
    }
    const session = flags.session
      ? await agent.openSession(String(flags.session))
      : await agent.createSession();
    try {
      if (listModels) printModels(session);
      else await runTurn(session);
    } finally {
      await session.close();
    }
  } finally {
    await agent.close();
  }
}

try {
  await main();
} catch (err) {
  if (err?.name === 'NodeExitError') throw err;
  cli.die(err?.message || String(err), { prefix: PREFIX });
}
