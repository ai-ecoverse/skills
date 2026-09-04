// ephemeral-token.js
// Mints a short-lived xAI realtime client secret via the TRUSTED bridge
// shell (never in sandboxed page JS with any long-lived credential). Pass in
// `execFn`, typically `slicc.exec`, which runs in the worker shell where the
// credential lives. Only the resulting ephemeral value (expires in
// `ttlSeconds`, used once as a WS subprotocol) ever reaches page JS.
//
// Credential: the `xai-grok` OAuth token (`oauth-token xai-grok`), obtained
// via the standard `xai-grok` skill's auth flow. A STANDARD API key is
// enough -- management-api.x.ai is never involved. The raw credential is
// read and used entirely inside the shell command string and never
// returned to the caller.

const CRED_CMD = 'KEY=$(oauth-token xai-grok)';

export async function mintEphemeralToken(execFn, ttlSeconds = 300) {
  const seconds = Math.max(10, Math.round(ttlSeconds));
  const cmd =
    `${CRED_CMD} && curl -s -X POST https://api.x.ai/v1/realtime/client_secrets ` +
    '-H "Content-Type: application/json" -H "Authorization: Bearer $KEY" ' +
    `--data '{"expires_after":{"seconds":${seconds}}}'`;

  const result = await execFn(cmd);
  if (!result || result.exitCode !== 0) {
    throw new Error(`Failed to mint ephemeral token: ${(result && result.stderr) || "unknown error"}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Ephemeral token response was not JSON: ${result.stdout}`);
  }
  if (!parsed.value) {
    throw new Error(`Ephemeral token response missing "value": ${result.stdout}`);
  }
  return parsed; // { value, expires_at }
}

export async function fetchVoices(execFn) {
  const cmd = `${CRED_CMD} && curl -s https://api.x.ai/v1/tts/voices -H "Authorization: Bearer $KEY"`;
  try {
    const result = await execFn(cmd);
    if (!result || result.exitCode !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    return parsed.voices || null;
  } catch (err) {
    return null;
  }
}
