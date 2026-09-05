# The SigV4 signer (`scripts/lib/sigv4.js`)

This file is the reason the skill exists. Every published AWS SigV4 snippet uses
`crypto.createHmac`, **which does not exist in the SLICC runtime**, so the usual
copy-paste fails in a way that looks like a credential problem. `sigv4.js` is a
complete, test-vector-verified signer for this runtime. It has no dependencies
beyond the runtime itself — **copy it verbatim into any other skill** that needs
to sign an AWS request.

## The runtime constraints, measured

`require('crypto')` in SLICC exposes exactly:

```
createHash, getRandomValues, randomBytes, randomFillSync, randomUUID, subtle, webcrypto
```

`typeof crypto.createHmac` is `undefined`. So:

| Need | Use | Sync? |
|---|---|---|
| SHA-256 hash | `crypto.createHash('sha256').update(s).digest('hex')` | sync |
| HMAC-SHA256 | `globalThis.crypto.subtle` (WebCrypto) | **async** |

```js
const subtle = globalThis.crypto.subtle;            // === require('crypto').subtle
async function hmac(keyBytes, msg) {
  const k = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
```

Because HMAC is async, **every signing entry point is async**, and that leads
straight to the trap below.

## The trap that costs a whole session

**This runtime exits before an un-awaited promise settles.** A script that calls
`main()` without `await`, or wraps its work in `(async () => { … })()`, exits
**rc=0 with no output and no error**. A measured case had markers proving
execution entered the async function and never reached the line after the first
`await fetch` — nothing printed, nothing failed, exit code zero.

`.jsh` files support **top-level `await`**. Use it:

```js
await main();          // correct — the last line of aws.jsh
main();                // WRONG: silent, empty, rc=0
(async()=>{…})();      // WRONG: same
foo().then(print);     // WRONG: same
```

This bites hardest when you are *verifying* the signer rather than using it: a
one-off check that wraps its work in an async IIFE prints nothing and exits 0, which
reads as "the signer produced no output" when in fact the process left before
`subtle.sign` resolved. Every HMAC call here is async, so **any** script that touches
this file — a skill, a test, a scratch check — must `await` at top level. It has cost
two separate people two attempts each.

A `.jsh` cannot be checked with `node --check` (unsupported, exits 9). Syntax-check
with `new Function('async function w(){' + src + '\n}')` — the async wrapper is
required because of top-level `await`.

## Requiring it

**Verdict: a relative literal works once installed, and no workaround is needed.**
That is what `aws.jsh` and `aws-ext.jsh` ship:

```js
const sigv4 = require('./lib/sigv4.js');   // works at any install path
```

Two independent constraints combine here, and only one of them is a limitation.

**1. The specifier must be LITERAL.** The runtime pre-registers VFS modules by
statically scanning literal require specifiers in the source, so a computed path
fails even though the file exists and the string is byte-identical:

```js
const p = `${__dirname}/lib/sigv4.js`;
const sigv4 = require(p);                  // FAILS: "Cannot find module"
```

Corollary for anyone writing a generic loader or a test harness: pre-register each
target with a literal `require` first; dynamic forms then hit the module cache and
work.

**2. Resolution is script-relative, not cwd-relative.** Measured by invoking the
same script from two different working directories:

```
$ cd /some/where   && mycmd     → resolved from <script-dir>/lib   (cwd /some/where)
$ cd /else/where   && mycmd     → resolved from <script-dir>/lib   (cwd /else/where)
```

The path is resolved against the requiring file's `__dirname`, exactly like Node
CJS. This is *why* the relative literal is safe: it stays correct whether the skill
lives at `/workspace/skills/aws/scripts/`, in a build tree, or anywhere else, and
no absolute path ever has to be baked into shipped source.

**The one consequence to remember: `lib/` must travel with the script.** A lone copy
of `aws.jsh` dropped into a directory with no sibling `lib/sigv4.js` cannot find the
signer. When copying the signer into another skill, copy it to
`<that-skill>/scripts/lib/sigv4.js` and require it the same relative way — do not
point at this skill's copy with an absolute path, or the borrowing skill breaks the
moment either skill moves.

## API

```js
const signed = await sigv4.sign({
  method: 'POST',
  host: 'ce.us-east-1.amazonaws.com',
  path: '/',                       // default '/'
  query: '',                       // string, object, or [k,v][]
  headers: { 'content-type': 'application/x-amz-json-1.1',
             'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
  body: JSON.stringify(payload),
  service: 'ce',
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey, sessionToken },
});
// → { headers, url, body, authorization, signature, canonicalRequest,
//     stringToSign, signingKeyHex, credentialScope, amzdate, payloadHash, signedHeaders }

const res = await sigv4.request({ /* same opts */ });
// → { status, ok, headers, text, json, signed }   never throws on HTTP status
```

Other exports: `hmacSha256`, `sha256Hex`, `deriveSigningKey`, `amzDate`,
`canonicalUri`, `canonicalQuery`, `canonicalHeaders`, `createCanonicalRequest`,
`createStringToSign`, `rfc3986`, `normalizePath`, `credentialsFromEnv`,
`isExpiredCredentialError`, `EMPTY_PAYLOAD_SHA256`.

Options worth knowing: `amzdate` (sign to a fixed timestamp — what the vector
tests use), `payloadHash` (e.g. `'UNSIGNED-PAYLOAD'`), `signSecurityToken: false`
(services that want `x-amz-security-token` added *after* signing; it is still
sent), `normalize: false` and `doubleEncode` for path handling (see below).

## What the signer does, in the spec's order

1. **Canonical request** — `METHOD \n URI \n QUERY \n HEADERS \n SIGNED_HEADERS \n PAYLOAD_HASH`
   - URI: dot-segments collapsed, each segment percent-encoded (`normalize:false`
     for S3, whose keys may legitimately contain `//` or `/./`).
   - Query: every key and value RFC-3986 encoded, then sorted by encoded key and,
     for repeats, by encoded value.
   - Headers: names lowercased and sorted; values trimmed with internal
     whitespace runs collapsed to one space; repeated names joined with `,` **in
     source order** (not sorted — AWS's `get-header-value-order` vector proves it).
   - Payload hash: `sha256hex(body)`, or the constant `EMPTY_PAYLOAD_SHA256` for
     an empty body.
2. **String to sign** — `AWS4-HMAC-SHA256 \n <amzdate> \n <scope> \n sha256hex(canonicalRequest)`
   where `scope` = `<datestamp>/<region>/<service>/aws4_request`,
   `amzdate` = `new Date().toISOString().replace(/[:-]|\.\d{3}/g,'')`, and
   `datestamp` = its first 8 characters.
3. **Signing key** — `HMAC('AWS4'+secret, datestamp)` → region → service →
   `'aws4_request'`, each step keyed by the previous result.
4. **Signature and header** — `hex(HMAC(signingKey, stringToSign))`, then
   `Authorization: AWS4-HMAC-SHA256 Credential=<akid>/<scope>, SignedHeaders=…, Signature=…`.

Session credentials add `x-amz-security-token`, and it **must be inside
`SignedHeaders`** for `sts` and `ce`. `Authorization`, `Connection`, `Expect`,
`User-Agent` and `Content-Length` are never signed (they are set or rewritten in
transit). A caller-supplied `Host` or `X-Amz-Date` in any casing is dropped and
re-added canonically — otherwise you get a doubled
`x-amz-date:…,…` canonical header and a signature that fails for no visible
reason.

## Verification

`aws-ext sigv4 verify` signs the vectors bundled in `scripts/lib/sigv4-vectors.js`
— a verbatim subset of the official AWS `aws-sig-v4-test-suite` — and compares
all three intermediate artefacts byte-for-byte, offline.

Development ran the **full suite: 34/34 cases pass** (canonical request,
string-to-sign and `Authorization` all exact), including `get-vanilla`,
`post-vanilla`, every `get-vanilla-query-*` ordering case, `get-header-*`
(trim, duplicate keys, value order, multiline folding), `get-utf8`,
`get-unreserved`, all seven `normalize-path` cases, `post-x-www-form-urlencoded`
(+`-parameters`), `get-vanilla-with-session-token` and both `post-sts-token`
cases. The 8 shipped vectors cover the shapes this skill actually sends.

Two extra invariants are also checked, because no single request vector isolates
them:

| Check | Expected |
|---|---|
| `HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")` | `f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8` |
| `deriveSigningKey(wJalrX…, 20150830, us-east-1, iam)` | `c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9` |

Vector credentials are AWS's published examples (`AKIDEXAMPLE` /
`wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`, `20150830T123600Z`, region
`us-east-1`, service `service`) and are not secrets.

## Service specifics used here

| | Cost Explorer | STS |
|---|---|---|
| host | `ce.us-east-1.amazonaws.com` | `sts.amazonaws.com` |
| service / region | `ce` / `us-east-1` | `sts` / `us-east-1` |
| content-type | `application/x-amz-json-1.1` | `application/x-www-form-urlencoded; charset=utf-8` |
| target header | `x-amz-target: AWSInsightsIndexService.GetCostAndUsage` | — |
| body | JSON | `Action=GetCallerIdentity&Version=2011-06-15` |
| reply | JSON | XML |

Cost Explorer is single-region: the endpoint is `us-east-1` no matter where your
resources live, and the SigV4 region must match the endpoint, not your workload.

## Failure modes and what they mean

| AWS says | Meaning |
|---|---|
| `SignatureDoesNotMatch` | The signer or the clock is wrong. Run `aws-ext sigv4 verify`; if it passes, check the system time — an `amzdate` more than 5 minutes off is rejected. |
| `InvalidClientTokenId` / `UnrecognizedClientException` | The access key id is unknown, **or** a session token is missing or stale. Not a signing bug. |
| `ExpiredToken` / `ExpiredTokenException` | Temporary credentials aged out (an Adobe `klam-master-role` session is ~4h). Re-export all three env vars — a refreshed key pair with a stale `AWS_SESSION_TOKEN` fails identically. |
| `Credential should be scoped to a valid region` | Region/service pair does not match the endpoint (e.g. signing `ce` for `eu-west-1`). |
| `AccessDenied` on Cost Explorer | Credentials are fine; `ce:GetCostAndUsage` is missing. For consolidated billing it is granted in the **payer** account. |

`isExpiredCredentialError(bodyOrJson)` matches the stale-credential codes so a
caller can tell "refresh your session" apart from "you lack permission".
