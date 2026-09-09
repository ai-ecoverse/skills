// sigv4.js — AWS Signature Version 4 request signer for the SLICC .jsh runtime.
//
// WHY THIS FILE EXISTS
// -------------------
// SLICC's runtime is not stock Node. `require('crypto')` exposes only
// randomFillSync, randomBytes, randomUUID, getRandomValues, createHash,
// webcrypto and subtle — there is **no crypto.createHmac**, which every
// published SigV4 snippet depends on. So:
//
//   hashing  → crypto.createHash('sha256')        (sync, present)
//   HMAC     → globalThis.crypto.subtle           (async WebCrypto)
//
// Because WebCrypto HMAC is async, every signing entry point here is async.
// The SLICC runtime **exits before an un-awaited promise settles**, so callers
// must `await` these functions from `.jsh` top-level await. A bare `main()` or
// `(async()=>{…})()` exits rc=0 with no output and no error.
//
// Verified against the official AWS `aws-sig-v4-test-suite` (34 cases, incl.
// post-x-www-form-urlencoded and post-sts-token) — see
// references/sigv4.md. Copy this file verbatim into any other SLICC skill that
// needs to talk to an AWS API.
//
// Usage:
//   const sigv4 = require('./lib/sigv4.js');   // literal path — see note below
//   const signed = await sigv4.sign({
//     method: 'POST', host: 'ce.us-east-1.amazonaws.com', path: '/',
//     service: 'ce', region: 'us-east-1',
//     headers: { 'content-type': 'application/x-amz-json-1.1',
//                'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
//     body: JSON.stringify(payload),
//     credentials: { accessKeyId, secretAccessKey, sessionToken },
//   });
//   const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
//
// NOTE on require(): this runtime pre-registers VFS modules by statically
// scanning **literal** require specifiers. `require(somePathVariable)` fails
// with "Cannot find module" even when the file exists. Always require this file
// with a literal string.

const nodeCrypto = require('node:crypto');

/** WebCrypto SubtleCrypto. Present as globalThis.crypto.subtle in the CLI
 *  server and in the extension sandbox; crypto.subtle is the same object. */
const subtle = globalThis.crypto?.subtle || nodeCrypto.subtle;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const TERMINATOR = 'aws4_request';
/** sha256('') — the payload hash of every request with an empty body. */
const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** Headers a signer must never sign: they are set or rewritten in transit. */
const NEVER_SIGN = new Set(['authorization', 'connection', 'expect', 'user-agent', 'content-length']);

// ─── Primitives ──────────────────────────────────────────────────────────────

/** Lowercase hex of a byte sequence. */
function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** UTF-8 encode a string to Uint8Array. */
function utf8(s) {
  return new TextEncoder().encode(s);
}

/** Hex SHA-256 of a string or byte sequence. Uses createHash, which exists. */
function sha256Hex(data) {
  const h = nodeCrypto.createHash('sha256');
  h.update(typeof data === 'string' ? data : Buffer.from(data));
  return h.digest('hex');
}

/** HMAC-SHA256 via WebCrypto. `keyBytes` is a Uint8Array, `msg` a string or
 *  Uint8Array. Returns Uint8Array. Async because subtle.sign is async — this
 *  is the whole reason the signer is async. */
async function hmacSha256(keyBytes, msg) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await subtle.sign('HMAC', key, typeof msg === 'string' ? utf8(msg) : msg);
  return new Uint8Array(sig);
}

/** The four-step SigV4 key derivation:
 *  kDate = HMAC('AWS4'+secret, datestamp) → kRegion → kService → kSigning. */
async function deriveSigningKey(secretAccessKey, datestamp, region, service) {
  const kDate = await hmacSha256(utf8(`AWS4${secretAccessKey}`), datestamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return await hmacSha256(kService, TERMINATOR);
}

// ─── Time ────────────────────────────────────────────────────────────────────

/** ISO basic-format timestamp AWS wants: 20150830T123600Z. */
function amzDate(date) {
  return (date || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** The YYYYMMDD part of an amzdate. */
function datestampOf(amzdate) {
  return String(amzdate).slice(0, 8);
}

function credentialScope(datestamp, region, service) {
  return `${datestamp}/${region}/${service}/${TERMINATOR}`;
}

// ─── Canonicalisation ────────────────────────────────────────────────────────

/** RFC 3986 percent-encoding. encodeURIComponent leaves !'()* alone, which AWS
 *  requires encoded; it also encodes ~, which AWS requires left alone. */
function rfc3986(str) {
  return encodeURIComponent(String(str))
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/gi, '~');
}

/** Collapse . and .. segments, as SigV4 requires for every service except S3
 *  (an S3 key may legitimately contain "//" or "/./" — pass normalize:false). */
function normalizePath(path) {
  const trailingSlash = path.length > 1 && path.endsWith('/');
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}${out.length && trailingSlash ? '/' : ''}`;
}

/** Canonical URI: normalised, then each segment percent-encoded.
 *  `doubleEncode: true` encodes twice, which some newer AWS services expect;
 *  the published test suite (and ce/sts, which only ever use "/") use single
 *  encoding, so that is the default. */
function canonicalUri(path, opts) {
  const o = opts || {};
  let p = path || '/';
  if (p === '') p = '/';
  if (o.normalize !== false) p = normalizePath(p);
  const enc = (seg) => (o.doubleEncode ? rfc3986(rfc3986(seg)) : rfc3986(seg));
  return p
    .split('/')
    .map((seg) => enc(decodeURIComponentSafe(seg)))
    .join('/');
}

/** decodeURIComponent that tolerates a raw, un-encoded segment (a literal "%"
 *  in a path would otherwise throw URIError and kill the whole request). */
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Canonical query string: every key and value RFC-3986 encoded, then sorted
 *  by encoded key and, for repeated keys, by encoded value. Accepts a raw
 *  query string ("a=1&b=2", with or without a leading "?"), an object, or an
 *  array of [k, v] pairs. */
function canonicalQuery(query) {
  if (!query) return '';
  let pairs = [];
  if (typeof query === 'string') {
    const q = query.replace(/^\?/, '');
    if (!q) return '';
    for (const part of q.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = i === -1 ? part : part.slice(0, i);
      const v = i === -1 ? '' : part.slice(i + 1);
      pairs.push([rfc3986(decodeURIComponentSafe(k)), rfc3986(decodeURIComponentSafe(v))]);
    }
  } else if (Array.isArray(query)) {
    pairs = query.map(([k, v]) => [rfc3986(k), rfc3986(v === undefined ? '' : v)]);
  } else {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const one of v) pairs.push([rfc3986(k), rfc3986(one)]);
      else pairs.push([rfc3986(k), rfc3986(v)]);
    }
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/** Canonical headers + signed-header list.
 *  - names lowercased, sorted
 *  - values trimmed with internal whitespace runs collapsed to one space
 *  - repeated names joined with "," in the order they were supplied
 *    (the AWS suite's get-header-value-order expects source order, NOT sorted)
 *  Accepts an object (values may be arrays) or an array of [name, value]. */
function canonicalHeaders(headers) {
  const entries = Array.isArray(headers) ? headers : Object.entries(headers || {});
  const byName = new Map();
  for (const [rawName, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null) continue;
    const name = String(rawName).trim().toLowerCase();
    if (NEVER_SIGN.has(name)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const v of values) {
      const value = String(v).trim().replace(/\s+/g, ' ');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(value);
    }
  }
  const names = Array.from(byName.keys()).sort();
  const canonical = names.map((n) => `${n}:${byName.get(n).join(',')}\n`).join('');
  return { canonicalHeaders: canonical, signedHeaders: names.join(';') };
}

/** Task 1 of the SigV4 spec — the canonical request:
 *    METHOD \n URI \n QUERY \n HEADERS \n SIGNED_HEADERS \n PAYLOAD_HASH  */
function createCanonicalRequest(parts) {
  const { canonicalHeaders: ch, signedHeaders } = canonicalHeaders(parts.headers);
  return {
    canonicalRequest: [
      String(parts.method || 'GET').toUpperCase(),
      canonicalUri(parts.path, parts),
      canonicalQuery(parts.query),
      ch,
      signedHeaders,
      parts.payloadHash,
    ].join('\n'),
    signedHeaders,
  };
}

/** Task 2 — the string to sign. */
function createStringToSign(amzdate, scope, canonicalRequest) {
  return [ALGORITHM, amzdate, scope, sha256Hex(canonicalRequest)].join('\n');
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Sign a request. Returns everything needed to send it, plus the intermediate
 * strings so a caller (or a test) can compare them against AWS's examples.
 *
 * opts:
 *   method, host, path, query, headers, body   — the request
 *   service, region                            — SigV4 scope
 *   credentials: { accessKeyId, secretAccessKey, sessionToken? }
 *   date?         Date to sign with (default now)
 *   amzdate?      pre-formatted timestamp; wins over `date` (used by tests)
 *   payloadHash?  override (e.g. 'UNSIGNED-PAYLOAD')
 *   signSecurityToken?  include x-amz-security-token in the canonical request
 *                       (default true — required by sts, ce and most services)
 *   protocol?     default 'https:'
 */
async function sign(opts) {
  const creds = opts.credentials || {};
  if (!creds.accessKeyId || !creds.secretAccessKey) {
    throw new Error('sigv4.sign: credentials.accessKeyId and credentials.secretAccessKey are required');
  }
  if (!opts.service) throw new Error('sigv4.sign: service is required');
  if (!opts.region) throw new Error('sigv4.sign: region is required');

  // Keep the caller's headers as a PAIR LIST, never an object: a header name
  // may legitimately repeat, and the AWS suite (get-header-value-order) checks
  // that repeats are joined in source order. An object would silently drop all
  // but the last.
  const incoming = Array.isArray(opts.headers) ? opts.headers.slice() : Object.entries(opts.headers || {});
  const findHeader = (name) => incoming.find(([k]) => String(k).trim().toLowerCase() === name);

  const host = opts.host || (findHeader('host') || [])[1];
  if (!host) throw new Error('sigv4.sign: host is required');

  // A caller-supplied X-Amz-Date wins over "now" (so a pre-built request signs
  // to the timestamp it already advertises), but an explicit amzdate/date opt
  // wins over the header.
  let amzdate = opts.amzdate;
  if (!amzdate && !opts.date) {
    const hdr = findHeader('x-amz-date');
    if (hdr) amzdate = String(hdr[1]).trim();
  }
  amzdate = amzdate || amzDate(opts.date);

  const datestamp = datestampOf(amzdate);
  const scope = credentialScope(datestamp, opts.region, opts.service);
  const body = opts.body === undefined || opts.body === null ? '' : opts.body;
  const payloadHash = opts.payloadHash || (body === '' ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body));
  const signToken = opts.signSecurityToken !== false;

  // Drop the headers the signature owns, then re-add them canonically, so a
  // caller passing `Host`/`X-Amz-Date` in any casing cannot produce a doubled
  // "x-amz-date:...,..." canonical header (which silently breaks the signature).
  const entries = [];
  for (const [k, v] of incoming) {
    if (v === undefined || v === null) continue;
    const lk = String(k).trim().toLowerCase();
    if (lk === 'host' || lk === 'x-amz-date') continue;
    if (lk === 'x-amz-security-token' && creds.sessionToken) continue;
    entries.push([k, v]);
  }
  entries.push(['host', host]);
  entries.push(['x-amz-date', amzdate]);
  if (creds.sessionToken && signToken) entries.push(['x-amz-security-token', creds.sessionToken]);

  const { canonicalRequest, signedHeaders } = createCanonicalRequest({
    method: opts.method,
    path: opts.path,
    query: opts.query,
    headers: entries,
    payloadHash,
    normalize: opts.normalize,
    doubleEncode: opts.doubleEncode,
  });
  const stringToSign = createStringToSign(amzdate, scope, canonicalRequest);
  const signingKey = await deriveSigningKey(creds.secretAccessKey, datestamp, opts.region, opts.service);
  const signature = hex(await hmacSha256(signingKey, stringToSign));

  const authorization =
    `${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // fetch() needs a plain object, so fold repeated names into comma-joined
  // values — the same joining rule the canonical request used.
  const wireHeaders = {};
  for (const [k, v] of entries) {
    const name = String(k).trim();
    wireHeaders[name] = wireHeaders[name] === undefined ? String(v) : `${wireHeaders[name]},${String(v)}`;
  }
  wireHeaders.Authorization = authorization;
  // Services that want the token *outside* the signature still need it sent.
  if (creds.sessionToken && !signToken) wireHeaders['x-amz-security-token'] = creds.sessionToken;

  const qs = canonicalQuery(opts.query);
  const url = `${opts.protocol || 'https:'}//${host}${canonicalUri(opts.path, opts) || '/'}${qs ? `?${qs}` : ''}`;

  return {
    algorithm: ALGORITHM,
    amzdate,
    datestamp,
    credentialScope: scope,
    canonicalRequest,
    stringToSign,
    signingKeyHex: hex(signingKey),
    signature,
    authorization,
    signedHeaders,
    payloadHash,
    headers: wireHeaders,
    body,
    url,
  };
}

/** Sign and send. Returns { status, ok, headers, text, json } — never throws on
 *  an HTTP error status, so callers can render AWS's own error shape. */
async function request(opts) {
  const signed = await sign(opts);
  const res = await fetch(signed.url, {
    method: String(opts.method || 'GET').toUpperCase(),
    headers: signed.headers,
    body: ['GET', 'HEAD'].includes(String(opts.method || 'GET').toUpperCase()) ? undefined : signed.body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const headers = {};
  if (res.headers && typeof res.headers.forEach === 'function') {
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
  }
  return { status: res.status, ok: res.ok, headers, text, json, signed };
}

// ─── Credentials ─────────────────────────────────────────────────────────────

/** Read credentials from a process env-like object. Returns null when the pair
 *  is incomplete, so a caller can fall back to stored config. */
function credentialsFromEnv(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  const accessKeyId = e.AWS_ACCESS_KEY_ID || e.AWS_ACCESS_KEY;
  const secretAccessKey = e.AWS_SECRET_ACCESS_KEY || e.AWS_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: e.AWS_SESSION_TOKEN || e.AWS_SECURITY_TOKEN || undefined,
    source: 'environment',
  };
}

/** Recognise the AWS error codes that mean "your credentials are stale",
 *  as opposed to "you lack permission". Accepts a body string or parsed JSON. */
function isExpiredCredentialError(bodyOrJson) {
  const s = typeof bodyOrJson === 'string' ? bodyOrJson : JSON.stringify(bodyOrJson || {});
  return /ExpiredToken|ExpiredTokenException|InvalidClientTokenId|TokenRefreshRequired|RequestExpired|SignatureDoesNotMatch/.test(
    s,
  );
}

module.exports = {
  ALGORITHM,
  EMPTY_PAYLOAD_SHA256,
  amzDate,
  datestampOf,
  credentialScope,
  hex,
  utf8,
  sha256Hex,
  hmacSha256,
  deriveSigningKey,
  rfc3986,
  normalizePath,
  canonicalUri,
  canonicalQuery,
  canonicalHeaders,
  createCanonicalRequest,
  createStringToSign,
  sign,
  request,
  credentialsFromEnv,
  isExpiredCredentialError,
};
