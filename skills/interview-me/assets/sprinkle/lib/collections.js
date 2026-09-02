// collections.js
// Wrapper around the xAI Collections + Search REST endpoints (api.x.ai — a
// STANDARD API key is enough; management-api.x.ai is not involved). All
// calls run through `execFn` (typically `slicc.exec`), which executes in the
// TRUSTED worker shell where the API key lives — the raw key never reaches
// this module's return values or any client-side JS.
//
// Endpoint shapes below are the VERIFIED ones from BRIEF.md's addendum,
// which differ from what the published reference docs mark as optional:
//   - POST /v1/collections requires BOTH collection_name and field_definitions.
//   - POST /v1/collections/{id}/documents/{file_id} requires file_id,
//     collection_id, AND fields in the body, even though the ids are also
//     in the URL path. Omitting any of the three 422s.
//   - GET .../documents can report processing_status:"Processing" forever
//     even once chunk_count > 0 and search already works — do not poll for
//     "Complete".

const CRED_CMD = 'KEY=$(oauth-token xai-grok)';
const API_BASE = "https://api.x.ai/v1";

// No default collection is shipped: pointing every installation at one
// account's private collection would be a real security/privacy bug, not a
// convenience. Callers MUST resolve a real collection id from configuration
// (see interview-me.jsh's `set collection=<id>` / config.json's
// `collectionId`) and fail clearly when it is unset -- never fall back to a
// baked-in id here.

function shellSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'"'"'`)}'`;
}

async function runJson(execFn, cmd) {
  const result = await execFn(cmd);
  if (!result || result.exitCode !== 0) {
    throw new Error(`Command failed: ${(result && result.stderr) || "unknown error"}`);
  }
  const trimmed = (result.stdout || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Response was not JSON: ${trimmed.slice(0, 300)}`);
  }
}

export async function createCollection(execFn, collectionName) {
  const body = JSON.stringify({ collection_name: collectionName, field_definitions: [] });
  const cmd =
    `${CRED_CMD} && curl -s -X POST ${API_BASE}/collections ` +
    '-H "Authorization: Bearer $KEY" -H "Content-Type: application/json" ' +
    `--data ${shellSingleQuote(body)}`;
  const data = await runJson(execFn, cmd);
  if (!data.collection_id) throw new Error(`Create collection failed: ${JSON.stringify(data)}`);
  return data.collection_id;
}

export async function listCollections(execFn) {
  const cmd = `${CRED_CMD} && curl -s ${API_BASE}/collections -H "Authorization: Bearer $KEY"`;
  const data = await runJson(execFn, cmd);
  return data.collections || [];
}

export async function uploadFile(execFn, filePath, purpose = "assistants") {
  const cmd =
    `${CRED_CMD} && curl -s -X POST ${API_BASE}/files ` +
    '-H "Authorization: Bearer $KEY" ' +
    `-F ${shellSingleQuote(`file=@${filePath}`)} -F ${shellSingleQuote(`purpose=${purpose}`)}`;
  const data = await runJson(execFn, cmd);
  if (!data.id) throw new Error(`Upload failed for ${filePath}: ${JSON.stringify(data)}`);
  return data.id;
}

/** Requires file_id + collection_id + fields in the body, per BRIEF.md addendum — do not simplify. */
export async function attachFile(execFn, collectionId, fileId, fields = {}) {
  const body = JSON.stringify({ file_id: fileId, collection_id: collectionId, fields });
  const cmd =
    `${CRED_CMD} && curl -s -X POST ${API_BASE}/collections/${collectionId}/documents/${fileId} ` +
    '-H "Authorization: Bearer $KEY" -H "Content-Type: application/json" ' +
    `--data ${shellSingleQuote(body)}`;
  return runJson(execFn, cmd); // {} on success
}

export async function listDocuments(execFn, collectionId) {
  const cmd = `${CRED_CMD} && curl -s ${API_BASE}/collections/${collectionId}/documents -H "Authorization: Bearer $KEY"`;
  const data = await runJson(execFn, cmd);
  return data.documents || [];
}

export async function searchCollection(execFn, collectionId, query, limit = 5) {
  const body = JSON.stringify({ query, limit, source: { collection_ids: [collectionId] } });
  const cmd =
    `${CRED_CMD} && curl -s -X POST ${API_BASE}/documents/search ` +
    '-H "Authorization: Bearer $KEY" -H "Content-Type: application/json" ' +
    `--data ${shellSingleQuote(body)}`;
  const data = await runJson(execFn, cmd);
  return data.matches || [];
}

/**
 * Walks a VFS directory and does the upload -> attach loop for each
 * .md/.txt file, creating a new collection first if `collectionId` is not
 * given. `listDir` should resolve like `slicc.readDir` (Array<{name,type}>).
 */
export async function ingestDirectory(execFn, dirPath, { collectionId, collectionName, listDir, onProgress } = {}) {
  let id = collectionId;
  if (!id) {
    id = await createCollection(execFn, collectionName || `interview-me-${Date.now()}`);
    if (onProgress) onProgress({ stage: "created-collection", collectionId: id });
  }

  const entries = await listDir(dirPath);
  const files = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (!/\.(md|txt)$/i.test(entry.name)) continue;
    files.push(entry.name);
  }

  const results = [];
  for (const name of files) {
    const filePath = dirPath.endsWith("/") ? `${dirPath}${name}` : `${dirPath}/${name}`;
    if (onProgress) onProgress({ stage: "uploading", filename: name });
    const fileId = await uploadFile(execFn, filePath);
    if (onProgress) onProgress({ stage: "attaching", filename: name, fileId });
    await attachFile(execFn, id, fileId);
    if (onProgress) onProgress({ stage: "done", filename: name, fileId });
    results.push({ filename: name, fileId });
  }

  return { collectionId: id, files: results };
}
