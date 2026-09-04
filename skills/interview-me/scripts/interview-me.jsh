// interview-me.jsh — CLI for the interview-me skill: manage the sprinkle
// install, the prefill config, and the xAI Collections knowledge base.
//
// Requires SLICC >= 6.113.0 (see "Multipart upload" below).
//
// Verified endpoint shapes on api.x.ai (a STANDARD API key is enough --
// management-api.x.ai is not involved for anything here, despite what the
// published reference docs imply about some fields being optional):
//   POST   /v1/collections                          {collection_name, field_definitions}   (BOTH required)
//   POST   /v1/files                    (multipart)  file=@path, purpose=assistants
//   POST   /v1/collections/{cid}/documents/{fid}     {file_id, collection_id, fields}       (ALL THREE required)
//   GET    /v1/collections
//   GET    /v1/collections/{cid}/documents
//   POST   /v1/documents/search                      {query, limit, source:{collection_ids:[...]}}
//   DELETE /v1/collections/{cid}/documents/{fid}      -> {}
//   DELETE /v1/collections/{cid}                      -> {}
//
// Multipart upload: uses a real `FormData` + `Blob` body with `fetch`.
// This REQUIRES SLICC >= 6.113.0 (`feat(webapp): serialize FormData bodies
// as multipart/form-data in jsh fetch`) -- older runtimes' fetch shim
// rejects FormData bodies outright. If `collections ingest`/`collections
// create` followed by a manual upload fails with a FormData-related fetch
// error, that is the runtime version, not a bug in this script.
//
// Auth: `skill.token('xai-grok')` -- set up via the standard `xai-grok`
// skill's own auth flow. The key is never printed, logged, or echoed.
//
// Config storage: `skill.config()` is the authoritative store for this
// CLI. Because the sprinkle is a `.shtml` (not a `.jsh`) it cannot call
// `skill.config()` itself, so every write here also materializes a synced
// copy to the sprinkle's own runtime config path (see SPRINKLE_DIR below)
// -- that copy is what interview-me.shtml actually reads. `install`
// (below) places the sprinkle there in the first place.
//
// Live reload: `brief`, `brief --file`, `set`, and `reset` best-effort push
// `sprinkle send interview-me '{"type":"reloadconfig"}'` after a
// successful write, bounded to 4s, never throws, never blocks the
// command's own exit-0 success path whether or not a sprinkle happens to
// be open right now. `--no-notify` skips it.
//
// Usage: interview-me --help

const cli = require('sliccy:cli');
const fmt = require('sliccy:fmt');
const color = require('sliccy:color');
const http = require('sliccy:http');
const exec = require('sliccy:exec');
const skill = require('sliccy:skill');
const fs = require('fs');

const API_BASE = 'https://api.x.ai/v1';

// Where the installed sprinkle (and everything it reads/writes at
// runtime -- config.json, sessions/, kb/) lives. This is intentionally
// the ONE place that decides that, mirroring interview-me.shtml's own
// single `window.__IM_BASE_DIR__` constant -- if the sprinkle is ever
// installed somewhere else, both need to agree, and this is the line to
// change on the CLI side.
const SPRINKLE_DIR = '/shared/sprinkles/interview-me';
const SPRINKLE_CONFIG_FILE = `${SPRINKLE_DIR}/config.json`;
const KB_DIR = `${SPRINKLE_DIR}/kb`;

// ─── Auth ────────────────────────────────────────────────────────────────

async function authKey() {
  return skill.token('xai-grok');
}

// Single client, built lazily (auth may shell out, which we don't want to
// pay for on --help / a bad subcommand). `token` is lazy per http.client's
// own contract, but we only need the key resolved once per process here,
// so resolve it once and hand back the same string.
let _apiClient = null;
async function api() {
  if (!_apiClient) {
    const key = await authKey();
    _apiClient = http.client({
      baseUrl: API_BASE,
      token: () => key,
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 30000,
    });
  }
  return _apiClient;
}

// ─── Live-reload notify ──────────────────────────────────────────────────
// After this CLI writes the sprinkle's config.json, an already-open
// sprinkle has no way to notice on its own -- so best-effort push a reload
// message via `sprinkle send`. MUST be non-fatal and bounded: if no
// sprinkle is open, `sprinkle send` exits non-zero (per its own contract)
// and this must still let the CLI report its normal success and exit 0,
// never hang, never turn into a CLI error.

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function notifySprinkle() {
  try {
    const result = await withTimeout(exec(`sprinkle send interview-me '{"type":"reloadconfig"}'`), 4000, 'sprinkle send');
    return result.exitCode === 0 ? { notified: true } : { notified: false };
  } catch {
    return { notified: false };
  }
}

async function maybeNotify(notify) {
  if (!notify) return;
  const { notified } = await notifySprinkle();
  console.log(notified ? '(live sprinkle updated)' : '(no open sprinkle to notify)');
}

// ─── config ──────────────────────────────────────────────────────────────
// Shape is fixed by what interview-me.shtml's loadConfig()/applyStaticConfigFields()
// read -- do not rename these keys without updating the sprinkle too.

// Sane bounds for session_minutes / config.json's sessionMinutes, mirrored
// exactly on the sprinkle side (interview-me.shtml's MIN/MAX_SESSION_MINUTES)
// so both halves agree on what "sane" means: below 1 minute there isn't
// enough time for even one real question-and-answer exchange to complete;
// above 10 minutes this stops being the short spoken-interview format the
// rest of the app's copy/instructions assume, and produces a
// proportionally much larger recording.
const MIN_SESSION_MINUTES = 1;
const MAX_SESSION_MINUTES = 10;
const DEFAULT_SESSION_MINUTES = 5; // matches the sprinkle's own fallback when the field is absent

function defaultConfig() {
  return {
    brief: '',
    voice: 'eve',
    webSearch: true,
    xSearch: true,
    webAllowedDomains: [],
    xAllowedHandles: [],
    // Local-context mode (BM25-ranked excerpts from kb/*.md, no extra
    // credentials or setup) is the right default for a fresh install --
    // Collection mode (file_search against a real xAI Collection) needs a
    // collection to be created first (`collections create`) and selected
    // (`set collection=<id>`). No default collection is ever shipped: that
    // would point every installation at whichever account happened to run
    // this script first, which is a privacy bug, not a convenience.
    kbMode: 'local',
    collectionId: null,
    kbPath: `${KB_DIR}/`,
    sessionMinutes: DEFAULT_SESSION_MINUTES,
  };
}

async function readConfig() {
  try {
    const stored = await skill.config();
    return stored && typeof stored === 'object' ? { ...defaultConfig(), ...stored } : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

// Writes through BOTH the skill's own config store (authoritative) and the
// installed sprinkle's runtime config.json (what interview-me.shtml
// actually reads) -- see the file header. The sprinkle-side write is
// best-effort: a config change should not fail just because `install`
// hasn't been run yet.
async function writeConfig(config) {
  const merged = await skill.config(config);
  try {
    await fs.writeFile(SPRINKLE_CONFIG_FILE, JSON.stringify(merged, null, 2));
  } catch {
    // Sprinkle not installed yet (or its directory is otherwise
    // unwritable) -- the skill's own config store above is still the
    // source of truth, and `install` will seed the sprinkle from it later.
  }
  return merged;
}

async function cmdConfig() {
  cli.out(await readConfig());
}

async function cmdReset(notify) {
  const config = await writeConfig(defaultConfig());
  console.log('Reset to defaults:');
  cli.out(config);
  await maybeNotify(notify);
}

async function cmdBrief(args, notify) {
  let text;
  if (args[0] === '--file') {
    const path = args[1];
    if (!path) cli.die('Usage: interview-me brief --file <path>', { prefix: 'interview-me' });
    try {
      text = await fs.readFile(path);
    } catch {
      cli.die(`brief --file: no such file: ${path}`, { prefix: 'interview-me' });
    }
  } else {
    text = args[0];
    if (!text) cli.die('Usage: interview-me brief "<text>" | brief --file <path>', { prefix: 'interview-me' });
  }
  const current = await readConfig();
  current.brief = text;
  await writeConfig(current);
  console.log(`Brief updated (${text.length} chars).`);
  await maybeNotify(notify);
}

const SET_KEYS = ['voice', 'web_search', 'x_search', 'web_domains', 'x_handles', 'kb_mode', 'collection', 'kb_path', 'session_minutes'];

function parseCsv(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

// `set collection=X kb_mode=local` ends with kb_mode=local even though
// setting `collection=` alone implies kb_mode=collection -- keys apply
// left-to-right.
function applyOneSet(config, key, value) {
  switch (key) {
    case 'voice':
      config.voice = value;
      return;
    case 'web_search':
      config.webSearch = value === 'true';
      return;
    case 'x_search':
      config.xSearch = value === 'true';
      return;
    case 'web_domains':
      config.webAllowedDomains = parseCsv(value);
      return;
    case 'x_handles':
      config.xAllowedHandles = parseCsv(value);
      return;
    case 'kb_mode':
      if (value !== 'collection' && value !== 'local') {
        cli.die(`kb_mode must be 'collection' or 'local', got '${value}'`, { prefix: 'interview-me' });
      }
      config.kbMode = value;
      return;
    case 'collection':
      config.collectionId = value;
      config.kbMode = 'collection';
      return;
    case 'kb_path':
      config.kbPath = value;
      return;
    case 'session_minutes': {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        cli.die(`session_minutes must be a positive number, got '${value}'`, { prefix: 'interview-me' });
      }
      if (n < MIN_SESSION_MINUTES || n > MAX_SESSION_MINUTES) {
        cli.die(
          `session_minutes must be between ${MIN_SESSION_MINUTES} and ${MAX_SESSION_MINUTES} (got ${n})`,
          { prefix: 'interview-me' }
        );
      }
      config.sessionMinutes = n;
      return;
    }
    default:
      cli.die(`Unknown set key: '${key}' (want one of: ${SET_KEYS.join(', ')})`, { prefix: 'interview-me' });
  }
}

async function cmdSet(args, notify) {
  if (!args.length) cli.die('Usage: interview-me set key=value [key2=value2 ...]', { prefix: 'interview-me' });
  const config = await readConfig();
  for (const pair of args) {
    const eq = pair.indexOf('=');
    if (eq === -1) cli.die(`Bad argument (want key=value): ${pair}`, { prefix: 'interview-me' });
    applyOneSet(config, pair.slice(0, eq), pair.slice(eq + 1));
  }
  if (config.kbMode === 'collection' && !config.collectionId) {
    cli.warn(
      'kb_mode is "collection" but no collection is set -- interviews will refuse to start until you run `set collection=<id>` (create one first with `collections create <name>`).',
      { prefix: 'interview-me' }
    );
  }
  const merged = await writeConfig(config);
  console.log('Updated:');
  cli.out(merged);
  await maybeNotify(notify);
}

// ─── Sprinkle install ──────────────────────────────────────────────────────
// Sprinkles are discovered under /shared/sprinkles/<name>/, not under this
// skill's own directory -- so getting the sprinkle running is a copy step,
// not just "the skill exists". Safe to re-run: always refreshes
// interview-me.shtml + lib/*.js from this skill's bundled assets (so a
// skill upgrade's fixes reach an already-installed sprinkle), but only
// SEEDS config.json if one doesn't already exist there -- it never
// overwrites a real user's settings, and it never touches anything the
// user has put in kb/ or sessions/.

async function cmdInstall() {
  const assetsDir = `${skill.assets}/sprinkle`;

  // `recursive: true` on every one of these: /shared/sprinkles itself does
  // not exist on a fresh runtime, and a non-recursive mkdir fails on the
  // missing PARENT, not on "already exists" -- which the empty catch below
  // then swallows, so the failure only resurfaced later as a confusing
  // write error against a path that was never created. Recursive mkdir is
  // also idempotent, which is what makes re-running install safe.
  //
  // kb/ is created here too: it is the DEFAULT kbPath
  // (`${KB_DIR}/` -- see defaultConfig()) and the Advanced tab's
  // prefilled ingestion path, and until it exists local-context mode loads
  // an empty corpus (silently: kb.js's loadFromDir() treats an unreadable
  // directory as "no documents") and `collections create` from the
  // prefilled path fails outright.
  for (const dir of [SPRINKLE_DIR, `${SPRINKLE_DIR}/lib`, KB_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }

  const shtml = await fs.readFile(`${assetsDir}/interview-me.shtml`);
  await fs.writeFile(`${SPRINKLE_DIR}/interview-me.shtml`, shtml);

  // fs.readDir() in this runtime returns bare filename strings, not
  // {name,type} objects -- matches the pattern already used below in
  // cmdCollectionsIngest for the exact same reason.
  const libFiles = await fs.readDir(`${assetsDir}/lib`);
  let libCount = 0;
  for (const name of libFiles) {
    if (!/\.js$/i.test(name)) continue;
    const content = await fs.readFile(`${assetsDir}/lib/${name}`);
    await fs.writeFile(`${SPRINKLE_DIR}/lib/${name}`, content);
    libCount++;
  }

  let configExisted = true;
  try {
    await fs.readFile(SPRINKLE_CONFIG_FILE);
  } catch {
    configExisted = false;
  }
  if (!configExisted) {
    const config = await readConfig();
    await fs.writeFile(SPRINKLE_CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  // The bundled kb notes ship as documentation, so they are installed
  // ALONGSIDE kb/ rather than inside it: everything under kbPath that ends
  // in .md/.txt is real interview source material (kb.js chunks and ranks
  // the whole directory, and `collections ingest ${KB_DIR}` uploads it), so
  // a README dropped in there would come back as questions about this
  // skill's own documentation instead of about the user.
  let kbReadme = '';
  try {
    kbReadme = await fs.readFile(`${skill.assets}/kb/README.md`);
  } catch {
    // Bundled notes missing (partial checkout) -- kb/ itself still exists,
    // which is the part the sprinkle actually needs.
  }
  if (kbReadme) await fs.writeFile(`${SPRINKLE_DIR}/KB-README.md`, kbReadme);

  console.log(`Installed interview-me.shtml + ${libCount} lib module(s) to ${SPRINKLE_DIR}`);
  console.log(configExisted ? 'Existing config.json left untouched.' : 'Seeded config.json with defaults.');
  console.log(`Knowledge-base folder ready at ${KB_DIR}/ -- drop .md/.txt files there${kbReadme ? ` (see ${SPRINKLE_DIR}/KB-README.md)` : ''}.`);
  console.log('Open it with: sprinkle open interview-me');
}

// ─── Collections API ─────────────────────────────────────────────────────

async function createCollection(apiClient, name) {
  return apiClient.post('/collections', { body: { collection_name: name, field_definitions: [] } });
}

async function attachDocument(apiClient, collectionId, fileId) {
  return apiClient.post(`/collections/${collectionId}/documents/${fileId}`, {
    body: { file_id: fileId, collection_id: collectionId, fields: {} },
  });
}

function guessMimeType(filename) {
  if (/\.md$/i.test(filename)) return 'text/markdown';
  if (/\.txt$/i.test(filename)) return 'text/plain';
  return 'application/octet-stream';
}

// Real FormData + Blob body -- requires SLICC >= 6.113.0 (see file header).
async function uploadFile(key, path) {
  const fileBytes = Buffer.from(await fs.readFileBinary(path));
  const filename = path.split('/').pop();

  const form = new FormData();
  form.append('file', new Blob([fileBytes], { type: guessMimeType(filename) }), filename);
  form.append('purpose', 'assistants');

  const resp = await fetch(`${API_BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.message || JSON.stringify(json));
  return json;
}

async function cmdCollectionsList() {
  const apiClient = await api();
  const resp = await apiClient.get('/collections');
  const collections = resp.collections || [];
  if (!collections.length) {
    console.log('No collections.');
    return;
  }
  const rows = [['ID', 'NAME', 'DOCS', 'CREATED']];
  for (const c of collections) {
    rows.push([c.collection_id, c.collection_name || '', String(c.documents_count ?? 0), fmt.date(c.created_at, 'short')]);
  }
  console.log(fmt.table(rows));
}

async function cmdCollectionsCreate(args) {
  const name = args[0];
  if (!name) cli.die('Usage: interview-me collections create <name>', { prefix: 'interview-me' });
  const apiClient = await api();
  const resp = await createCollection(apiClient, name);
  if (!resp.collection_id) cli.die(`Create failed: ${JSON.stringify(resp)}`, { prefix: 'interview-me' });
  cli.out(resp);
  console.log(`collection_id: ${resp.collection_id}`);
  console.log(`Next: interview-me set collection=${resp.collection_id}`);
}

async function cmdCollectionsDelete(args) {
  const cid = args[0];
  if (!cid) cli.die('Usage: interview-me collections delete <collection_id>', { prefix: 'interview-me' });
  const apiClient = await api();
  await apiClient.delete(`/collections/${cid}`);
  console.log(`Deleted ${cid}`);
}

async function cmdCollectionsDocs(args) {
  const cid = args[0];
  if (!cid) cli.die('Usage: interview-me collections docs <collection_id>', { prefix: 'interview-me' });
  const apiClient = await api();
  const resp = await apiClient.get(`/collections/${cid}/documents`);
  const docs = resp.documents || [];
  if (!docs.length) {
    console.log('No documents.');
    return;
  }
  const rows = [['FILE_ID', 'NAME', 'STATUS', 'CHUNKS', 'SIZE']];
  for (const d of docs) {
    rows.push([
      d.file_metadata.file_id,
      d.file_metadata.name,
      d.file_metadata.processing_status,
      String(d.chunk_count ?? 0),
      String(d.file_metadata.size_bytes ?? 0),
    ]);
  }
  console.log(fmt.table(rows));
}

async function cmdCollectionsRmDoc(args) {
  const [cid, fid] = args;
  if (!cid || !fid) cli.die('Usage: interview-me collections rm-doc <collection_id> <file_id>', { prefix: 'interview-me' });
  const apiClient = await api();
  await apiClient.delete(`/collections/${cid}/documents/${fid}`);
  console.log(`Removed ${fid} from ${cid}`);
}

// Observed live (not a bug in the upload -- reproduced identically via a
// raw re-query of the same collection): a .txt document's chunk_content
// sometimes comes back as a JSON-encoded array of {page_number, text}
// objects (e.g. `[{"page_number":0,"text":"..."}]`) instead of plain
// text, while .md documents in the same collection come back as plain
// text. Unwrap it so search output is always readable.
function normalizeChunkContent(content) {
  if (typeof content !== 'string') return String(content ?? '');
  const trimmed = content.trim();
  if (trimmed.startsWith('[') && trimmed.includes('"page_number"')) {
    try {
      const pages = JSON.parse(trimmed);
      if (Array.isArray(pages) && pages.length && pages.every((p) => p && typeof p === 'object' && 'text' in p)) {
        return pages.map((p) => p.text).join('\n');
      }
    } catch {
      // not actually the wrapped shape -- fall through to raw content
    }
  }
  return content;
}

async function cmdCollectionsSearch(args) {
  const [cid, query] = args;
  if (!cid || !query) cli.die('Usage: interview-me collections search <collection_id> "<query>"', { prefix: 'interview-me' });
  const apiClient = await api();
  const resp = await apiClient.post('/documents/search', { body: { query, limit: 5, source: { collection_ids: [cid] } } });
  const matches = resp.matches || [];
  if (!matches.length) {
    console.log('No matches.');
    return;
  }
  for (const m of matches) {
    const title = (m.fields && (m.fields.title || m.fields['chroma:uri'])) || m.file_id;
    const score = typeof m.score === 'number' ? m.score.toFixed(2) : String(m.score);
    console.log(`${color.bold(title)}  ${color.dim(`score ${score}`)}`);
    console.log(fmt.trunc(normalizeChunkContent(m.chunk_content || '').replace(/\n/g, ' '), 200));
    console.log('');
  }
}

async function cmdCollectionsIngest(args) {
  const [dir, nameOrId] = args;
  if (!dir) cli.die('Usage: interview-me collections ingest <directory> [collection_name|collection_id]', { prefix: 'interview-me' });

  let entries;
  try {
    entries = await fs.readDir(dir);
  } catch {
    cli.die(`No such directory: ${dir}`, { prefix: 'interview-me' });
  }

  const key = await authKey();
  const apiClient = await api();

  let cid;
  if (nameOrId && nameOrId.startsWith('collection_')) {
    cid = nameOrId;
    console.log(`Using existing collection: ${cid}`);
  } else {
    const name = nameOrId || `interview-me-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    console.log(`Creating collection: ${name}`);
    const resp = await createCollection(apiClient, name);
    cid = resp.collection_id;
    if (!cid) cli.die(`Create collection failed: ${JSON.stringify(resp)}`, { prefix: 'interview-me' });
    console.log(`Created: ${cid}`);
  }

  // fs.readDir() returns bare filename strings here (NOT {name,type}
  // objects like the sprinkle's slicc.readDir bridge). Match by
  // extension, then confirm with fs.stat (isDirectory/isFile/size) since a
  // directory could in principle have a name ending in .md/.txt.
  const candidates = entries.filter((name) => /\.(md|txt)$/i.test(name));
  let count = 0;
  for (const name of candidates) {
    const filePath = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile) continue;

    console.log(`Uploading ${name} ...`);
    let uploadResp;
    try {
      uploadResp = await uploadFile(key, filePath);
    } catch (err) {
      console.error(`  upload failed: ${err.message}`);
      continue;
    }
    const fid = uploadResp.id;
    if (!fid) {
      console.error(`  upload failed: ${JSON.stringify(uploadResp)}`);
      continue;
    }
    console.log(`  attaching ${fid} to ${cid} ...`);
    try {
      await attachDocument(apiClient, cid, fid);
    } catch (err) {
      console.error(`  attach failed: ${err.body?.message || err.message}`);
      continue;
    }
    console.log(`  ok: ${name} -> ${fid}`);
    count++;
  }

  console.log(`Ingested ${count} file(s) into ${cid}`);
  console.log(cid);
  console.log(`Next: interview-me set collection=${cid}`);
}

// ─── Help ────────────────────────────────────────────────────────────────

function showHelp() {
  cli.help(`${color.bold('interview-me')} — CLI for the interview-me voice-interview skill

${color.bold('USAGE')}
  interview-me <command> [args]

${color.bold('SETUP')}
  ${color.cyan('install')}                             Copy the sprinkle into ${color.cyan(SPRINKLE_DIR)}
                                       (safe to re-run after a skill upgrade)

${color.bold('CONFIG')} (writes through skill config + ${color.cyan(SPRINKLE_CONFIG_FILE)})
  ${color.cyan('brief')} "<text>"                    Set the interview briefing text
  ${color.cyan('brief')} --file <path>                Set the briefing from a file's contents
  ${color.cyan('set')} key=value [key2=value2 ...]    Update one or more config fields
      keys: voice, web_search, x_search, web_domains, x_handles,
            kb_mode, collection, kb_path, session_minutes
      session_minutes: ${MIN_SESSION_MINUTES}-${MAX_SESSION_MINUTES}, default ${DEFAULT_SESSION_MINUTES} -- length of the
      recorded interview; applies live to an already-open sprinkle
  ${color.cyan('config')}                              Print the current config
  ${color.cyan('reset')}                               Restore config to defaults (kb_mode: local)

  After brief/set/reset write config, this CLI best-effort pushes a live
  reload to an already-open sprinkle (${color.cyan("sprinkle send interview-me '{\"type\":\"reloadconfig\"}'")}),
  and always reports whether that landed. Pass ${color.cyan('--no-notify')} to skip it
  (e.g. for scripted use): ${color.cyan('interview-me brief "..." --no-notify')}

${color.bold('COLLECTIONS')} (xAI Collections knowledge base -- standard API key, no
Management key needed for anything below)
  ${color.cyan('collections list')}                                    List collections
  ${color.cyan('collections create')} <name>                           Create an empty collection
  ${color.cyan('collections delete')} <collection_id>                  Delete a collection
  ${color.cyan('collections ingest')} <directory> [name|collection_id] Upload+attach every .md/.txt in <directory>
  ${color.cyan('collections docs')} <collection_id>                    List documents in a collection
  ${color.cyan('collections rm-doc')} <collection_id> <file_id>        Remove one document from a collection
  ${color.cyan('collections search')} <collection_id> "<query>"        Test semantic search (verify grounding)

${color.bold('EXAMPLES')}
  interview-me install
  interview-me brief "Ask me about my current project and what's been hardest about it"
  interview-me collections create my-notes
  interview-me collections ingest ${KB_DIR} my-notes
  interview-me set collection=<collection_id>
  interview-me set voice=eve web_search=true x_search=false
  interview-me set session_minutes=3
  interview-me collections search <collection_id> "What is this project?"

${color.bold('AUTH')}
  Uses the ${color.cyan('xai-grok')} skill's OAuth token (${color.cyan("skill.token('xai-grok')")}).
  Set that up first if you haven't already. The key is never printed.`);
}

// ─── Router ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
  showHelp();
  process.exit(0); // defensive: cli.help() already exits 0
}

const cmd = argv[0];
let rest = argv.slice(1);

// --no-notify suppresses the best-effort `sprinkle send` push after
// brief/set/reset write config -- for scripted use where the caller
// doesn't want the CLI touching a live sprinkle, or just doesn't care.
// Can appear anywhere in the remaining args; stripped before the
// command-specific parsing sees it so it's never mistaken for a
// positional value (e.g. `set voice=eve --no-notify`).
let notify = true;
const noNotifyIdx = rest.indexOf('--no-notify');
if (noNotifyIdx !== -1) {
  notify = false;
  rest = rest.slice(0, noNotifyIdx).concat(rest.slice(noNotifyIdx + 1));
}

try {
  switch (cmd) {
    case 'install':
      await cmdInstall();
      break;
    case 'brief':
      await cmdBrief(rest, notify);
      break;
    case 'set':
      await cmdSet(rest, notify);
      break;
    case 'config':
      await cmdConfig();
      break;
    case 'reset':
      await cmdReset(notify);
      break;
    case 'collections': {
      const sub = rest[0];
      const subArgs = rest.slice(1);
      switch (sub) {
        case 'list':
          await cmdCollectionsList();
          break;
        case 'create':
          await cmdCollectionsCreate(subArgs);
          break;
        case 'delete':
          await cmdCollectionsDelete(subArgs);
          break;
        case 'ingest':
          await cmdCollectionsIngest(subArgs);
          break;
        case 'docs':
          await cmdCollectionsDocs(subArgs);
          break;
        case 'rm-doc':
          await cmdCollectionsRmDoc(subArgs);
          break;
        case 'search':
          await cmdCollectionsSearch(subArgs);
          break;
        default:
          cli.die(`Unknown collections subcommand: '${sub || ''}'. Run interview-me --help for usage.`, { prefix: 'interview-me' });
      }
      break;
    }
    default:
      cli.die(`Unknown command: '${cmd}'. Run interview-me --help for usage.`, { prefix: 'interview-me' });
  }
} catch (err) {
  if (err.name === 'NodeExitError') throw err; // re-throw exit signals (cli.die/help use these)
  cli.die(`${cmd} failed: ${err.body?.message || err.message}`, { prefix: 'interview-me' });
}
