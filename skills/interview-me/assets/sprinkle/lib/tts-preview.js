// tts-preview.js
// Wrapper around xAI's Text-to-Speech REST endpoint (api.x.ai — a STANDARD
// API key is enough), used ONLY for the Advanced tab's "audition a voice"
// feature. Entirely independent of the realtime speech-to-speech session
// itself (which has its own `voice` field in session.update) -- this is a
// separate, simpler endpoint that returns a one-shot MP3 rather than a
// streamed conversation. All calls run through `execFn` (typically
// `slicc.exec`), which executes in the TRUSTED worker shell where the API
// key lives -- the raw key never reaches this module's return values or any
// client-side JS.
//
// Endpoint: POST /v1/tts { text, voice_id, language } -> raw MP3 bytes (NOT
// a JSON envelope) on success. On failure (e.g. an unknown voice_id),
// verified live to return a JSON `{"error": "..."}` body instead -- this
// module detects success/failure from the CONTENT (MP3 frame-sync bytes vs.
// a leading `{`), not the HTTP status code, since the only way to get
// binary bytes back into page JS through a captured-stdout shell command is
// to base64-encode them in the shell and decode on the JS side (there is no
// separate channel here for a status code the way a real HTTP client would
// give one) -- see the round-trip below.

const CRED_CMD = 'KEY=$(oauth-token xai-grok)';
const API_BASE = "https://api.x.ai/v1";

function shellSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'"'"'`)}'`;
}

/**
 * @param {(cmd: string) => Promise<{stdout:string, stderr:string, exitCode:number}>} execFn
 * @param {{text: string, voiceId: string, language?: string}} opts
 * @returns {Promise<Uint8Array>} raw MP3 bytes. Throws with the API's own
 *   error message (or a clear fallback) on any failure -- never returns a
 *   non-audio byte array.
 */
export async function synthesizeVoicePreview(execFn, { text, voiceId, language = "en" } = {}) {
  if (!text || !text.trim()) throw new Error("No preview text given");
  if (!voiceId) throw new Error("No voice selected");

  const body = JSON.stringify({ text, voice_id: voiceId, language });
  const cmd =
    `${CRED_CMD} && curl -s -X POST ${API_BASE}/tts ` +
    '-H "Authorization: Bearer $KEY" -H "Content-Type: application/json" ' +
    `--data ${shellSingleQuote(body)} | base64`;

  const result = await execFn(cmd);
  if (!result || result.exitCode !== 0) {
    throw new Error(`TTS request failed: ${(result && result.stderr) || "unknown error"}`);
  }

  const trimmed = (result.stdout || "").replace(/\s+/g, "");
  if (!trimmed) throw new Error("Empty response from TTS API");

  let bytes;
  try {
    const binary = atob(trimmed);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (err) {
    throw new Error(`TTS response was not valid base64: ${err.message}`);
  }

  // MP3 frame sync: 0xFF followed by a byte whose top 3 bits are all set
  // (mask 0xE0) -- true across every MPEG version/layer combination, and a
  // cheap, reliable way to confirm this is really audio without a full
  // decode. (See AudioPlayer/recorder.js's own use of format sniffing
  // elsewhere in this app for the same "trust the bytes, not the label"
  // principle.)
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return bytes;
  }

  // Not audio -- almost certainly the API's own {"error": "..."} body.
  let message = null;
  try {
    const asText = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(asText);
    message = parsed && parsed.error;
  } catch (err) {
    // fall through to the generic message below
  }
  throw new Error(message || `Unexpected TTS response (${bytes.length} bytes, not a recognizable MP3)`);
}
