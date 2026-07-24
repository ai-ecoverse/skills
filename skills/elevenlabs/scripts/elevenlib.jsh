// elevenlib.jsh — shared helpers for the ElevenLabs skill.
// Required (not run directly) by eleven.jsh, say-11.jsh, hear-11.jsh.
//
// Auth: the API key is read (in priority order) from an explicit key arg,
// the ELEVENLABS_API_KEY env var, or skill config (`eleven auth <key>`).
// Never hard-code the key.

const skill = require('sliccy:skill');
const { exec } = require('sliccy:exec');

const BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // "Rachel" (premade)
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const DEFAULT_STT_MODEL = 'scribe_v1';

// ─── config ──────────────────────────────────────────────────────────────
async function loadConfig() {
  // skill.config() returns a Promise (always truthy) — await before `|| {}`.
  return (await skill.config()) || {};
}
async function saveConfig(updates) {
  await skill.config({ ...(await loadConfig()), ...updates });
}

async function getKey(explicit) {
  const k = (typeof explicit === 'string' && explicit) ||
            process.env.ELEVENLABS_API_KEY ||
            (await loadConfig()).apiKey;
  if (!k) {
    throw new Error(
      'No ElevenLabs API key. Set one with `eleven auth <key>`, ' +
      'or pass --key, or export ELEVENLABS_API_KEY.');
  }
  return k;
}

// ─── raw JSON api ──────────────────────────────────────────────────────────
// method/path e.g. ('GET', '/voices'). body: object (JSON) or undefined.
// Returns parsed JSON, or throws Error with the API message on non-2xx.
async function api(key, method, path, { body, query } = {}) {
  let url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? path : '/' + path);
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'xi-api-key': key };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  // Non-JSON responses (e.g. audio/mpeg from text-to-speech) must NOT be run
  // through res.text() or they get corrupted. Return the raw bytes instead so
  // the caller (e.g. `eleven api`) can write a usable file.
  if (!ct.includes('json')) {
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      const err = new Error(buffer.slice(0, 300).toString() || res.statusText);
      err.status = res.status;
      throw err;
    }
    return { __binary: true, contentType: ct, buffer, status: res.status };
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.detail?.message || json?.detail || json?.message || text || res.statusText;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return json;
}

// ─── voices ─────────────────────────────────────────────────────────────────
async function listVoices(key) {
  const j = await api(key, 'GET', '/voices');
  return j.voices || [];
}

// Accept a raw voice_id (20-char token) or resolve a (partial, case-insensitive)
// name to an id via /voices. Falls back to the configured/default voice.
function looksLikeVoiceId(v) { return /^[A-Za-z0-9]{20}$/.test(v || ''); }

async function resolveVoice(key, nameOrId) {
  const cfg = await loadConfig();
  if (!nameOrId) return cfg.defaultVoice || DEFAULT_VOICE;
  if (looksLikeVoiceId(nameOrId)) return nameOrId;
  const voices = await listVoices(key);
  const q = String(nameOrId).toLowerCase();
  const exact = voices.find((v) => v.name?.toLowerCase() === q);
  if (exact) return exact.voice_id;
  const partial = voices.find((v) => v.name?.toLowerCase().includes(q));
  if (partial) return partial.voice_id;
  throw new Error(`No voice matching "${nameOrId}". Try \`eleven voices --search ${nameOrId}\`.`);
}

// ─── TTS (binary response is faithful over the proxied fetch) ────────────────
// Returns a Buffer of audio bytes.
async function tts(key, { text, voiceId, modelId, outputFormat, voiceSettings, languageCode }) {
  const q = outputFormat ? { output_format: outputFormat } : undefined;
  const url = `${BASE}/text-to-speech/${voiceId || DEFAULT_VOICE}` +
    (q ? '?' + new URLSearchParams(q).toString() : '');
  const payload = { text, model_id: modelId || DEFAULT_MODEL };
  if (voiceSettings && Object.keys(voiceSettings).length) payload.voice_settings = voiceSettings;
  // Enforce a language when requested (-l). Supported by Turbo/Flash v2.5 and v3;
  // accepted (no-op) by multilingual v2.
  if (languageCode) payload.language_code = languageCode;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let msg; try { const j = JSON.parse(await res.text()); msg = j?.detail?.message || j?.detail || j?.message; } catch {}
    const err = new Error(msg || `TTS failed (HTTP ${res.status})`);
    err.status = res.status; throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

// ─── STT (multipart binary upload — proxied fetch can't send binary bodies,
//     so shell out to curl via exec.spawn; args are not shell-interpolated) ──
async function stt(key, { file, modelId, languageCode, diarize, numSpeakers }) {
  const args = ['-s', '-X', 'POST', `${BASE}/speech-to-text`,
    '-H', `xi-api-key: ${key}`,
    '-F', `model_id=${modelId || DEFAULT_STT_MODEL}`,
    '-F', `file=@${file}`];
  if (languageCode) args.push('-F', `language_code=${languageCode}`);
  if (diarize) args.push('-F', 'diarize=true');
  if (numSpeakers) args.push('-F', `num_speakers=${numSpeakers}`);
  const { stdout, exitCode } = await exec.spawn(['curl', ...args]);
  if (exitCode !== 0) throw new Error(`curl failed (exit ${exitCode}): ${stdout}`);
  let j; try { j = JSON.parse(stdout); } catch { throw new Error(`Unexpected STT response: ${stdout.slice(0, 300)}`); }
  if (j?.detail) {
    const msg = j.detail?.message || j.detail;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return j;
}

async function play(file, { rate, volume } = {}) {
  const args = ['afplay'];
  if (volume != null) args.push('-v', String(volume));
  if (rate != null) args.push('-r', String(rate));
  args.push(file);
  return exec.spawn(args);
}

module.exports = {
  BASE, DEFAULT_VOICE, DEFAULT_MODEL, DEFAULT_STT_MODEL,
  loadConfig, saveConfig, getKey, api,
  listVoices, resolveVoice, looksLikeVoiceId,
  tts, stt, play,
};
