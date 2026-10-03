// System 1 over the network: Cloudflare's Clef decision models on Workers
// AI. Clef (Qwen 3.8-27B) and Clef-flash (Qwen 3.5-9B) answer the same
// System One request as kev ({ state, questions }) and take images as data
// URLs in `images` (probed 2026-10-02: `image` is rejected).
//
// The token is a slicc secret scoped to api.cloudflare.com: the caller
// sends its masked value and the fetch proxy swaps in the real one, so the
// token never reaches the script, its log or its trace. Shared by webrunner
// (--model clef) and intent.

const REMOTE_MODELS = { clef: '@cf/cloudflare/clef', 'clef-flash': '@cf/cloudflare/clef-flash' };
const API = 'https://api.cloudflare.com/client/v4';

/** The masked CLOUDFLARE_API_TOKEN: the environment, else `secret get`. '' when there is none. */
async function cloudflareToken(exec, env = {}) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const got = await exec.spawn(['secret', 'get', 'CLOUDFLARE_API_TOKEN']);
  const m = /CLOUDFLARE_API_TOKEN=(\S+)/.exec(got.stdout || '');
  return m ? m[1] : '';
}

/**
 * The Workers AI account: the one given, else the only account the token
 * can see. A token that sees several needs it named; none is guessed.
 * → { account } or { error }
 */
async function cloudflareAccount(fetchFn, token, given) {
  if (given) return { account: String(given) };
  const res = await fetchFn(`${API}/accounts?per_page=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  let data = null;
  try {
    data = JSON.parse(await res.text());
  } catch {
    data = null;
  }
  if (res.status === 401 || res.status === 403) {
    return { error: `Cloudflare refused the token (HTTP ${res.status}) when listing its accounts` };
  }
  const accounts = (data && Array.isArray(data.result) && data.result) || [];
  if (accounts.length === 1) return { account: accounts[0].id };
  if (!accounts.length) return { error: 'the Cloudflare token sees no account' };
  return {
    error: `the Cloudflare token sees ${accounts.length} accounts (${accounts.map((a) => `${a.id} ${a.name}`).join(', ')}); name one with --cf-account or CLOUDFLARE_ACCOUNT_ID`,
  };
}

/**
 * One System One call to Clef: body is { state, questions, images? }.
 * Retries 429 and 5xx twice. → the result ({ answers }).
 */
function remoteSystemOne({ fetchFn, account, token, size }) {
  if (!REMOTE_MODELS[size]) throw new Error(`no remote model ${size}`);
  const url = `${API}/accounts/${encodeURIComponent(account)}/ai/run/${REMOTE_MODELS[size]}`;
  return async function ask(body) {
    const payload = JSON.stringify({ model: size, ...body });
    for (let attempt = 1; ; attempt++) {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: payload,
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (res.ok && data && data.success) return data.result;
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Workers AI refused the token (HTTP ${res.status}); check the CLOUDFLARE_API_TOKEN secret and the account id`
        );
      }
      const why = data && data.errors && data.errors[0] ? data.errors[0].message : text.slice(0, 200);
      throw new Error(`Workers AI ${size}: HTTP ${res.status}: ${why}`);
    }
  };
}

module.exports = { REMOTE_MODELS, cloudflareToken, cloudflareAccount, remoteSystemOne };
