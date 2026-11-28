import test, { is, ok } from 'tst';

/* Tests for the one-shot GET retry in gh() of ../mirror-comments.mjs.

   The gh section is evaluated OUT OF THE FILE UNDER TEST, between its 8</>8
   markers, with `spawnSync`, `console` and `Atomics` injected, so no process is
   spawned, nothing reaches GitHub, and the 2 s wait is observed rather than
   slept (except in the one test that checks the real wait). The mirror itself
   is never imported: loading it runs a reconcile.

   MIRROR_UNDER_TEST overrides the file, so the same suite can be pointed at
   the unmodified mirror (markers added, nothing else) or a broken copy to show
   each case red. */
const fs = require('fs');
const FILE = (typeof process !== 'undefined' && process.env && process.env.MIRROR_UNDER_TEST)
  || ['../scripts/mirror-comments.mjs', '../mirror-comments.mjs'].map((p) => new URL(p, import.meta.url).pathname).find((p) => require('fs').existsSync(p));
const SRC = fs.readFileSync(FILE, 'utf8');
const START = '/* ---- 8< gh ';
const END = '/* ---- >8 end gh ';
const i = SRC.indexOf(START);
const j = SRC.indexOf(END);
if (i < 0 || j < 0) throw new Error('gh markers not found in ' + FILE);
const BLOCK = SRC.slice(i, j);
console.log('# file under test: ' + FILE);

/** Evaluate the fenced gh section against a scripted `gh`. `script` is the
    ordered list of results the fake spawnSync returns, one per request. */
function load(script, { realWait = false } = {}) {
  const calls = [];
  const lines = [];
  const waits = [];
  const fakeSpawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (calls.length > 10) throw new Error('runaway: more than 10 requests for one call');
    const r = script[Math.min(calls.length, script.length) - 1];
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const fakeConsole = { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const fakeAtomics = realWait ? Atomics : { wait: (_a, _i, _v, ms) => { waits.push(ms); return 'timed-out'; } };
  const mod = new Function(
    'spawnSync', 'console', 'Atomics',
    BLOCK + '\nreturn { gh, requests: () => requests, retries: () => (typeof retries === "undefined" ? 0 : retries) };',
  )(fakeSpawn, fakeConsole, fakeAtomics);
  return { ...mod, calls, lines, waits };
}

/** Run gh(args); return { value } or { error: message }. */
function run(m, args) {
  try {
    return { value: m.gh(args) };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

/* ── Fixtures ─────────────────────────────────────────────────────────────
   INCIDENT_STDERR and INCIDENT_MESSAGE are verbatim from the 13:26Z / 17:36Z
   2026-09-23 poll log ("unexpected failure: Error: <INCIDENT_MESSAGE>"). */
const INCIDENT_STDERR =
  'gh: api /user failed: HTTP 502 Bad Gateway https://api.github.com/user: {"error":"Proxy fetch failed: The operation couldn\'t be completed. (AsyncHTTPClient.HTTPClientError error 1.)"}';
const INCIDENT_MESSAGE = 'gh api /user --jq failed (status 1): ' + INCIDENT_STDERR;

const fail = (stderr) => ({ status: 1, stderr });
const okOut = (stdout) => ({ status: 0, stdout });
const http = (code, text, path) =>
  fail(`gh: api ${path} failed: HTTP ${code} ${text} https://api.github.com${path}: {"message":"${text}"}`);

/* The argv of every call site, verbatim from mirror-comments.mjs. */
const SLUG = 'ai-ecoverse/slicc';
const GET_USER = ['api', '/user', '--jq', '.login'];
const COMMENTS_PATH = `/repos/${SLUG}/issues/42/comments?per_page=100`;
const GET_COMMENTS = ['api', COMMENTS_PATH, '--jq', '[.[] | {id, login: .user.login, body}]'];
const DELETE = ['api', '--method', 'DELETE', `/repos/${SLUG}/issues/comments/99`];
const PATCH = ['api', '--method', 'PATCH', `/repos/${SLUG}/issues/comments/99`, '-f', 'body=x'];
const CREATE = ['issue', 'comment', '42', '--body-file', '/tmp/ghd-mirror-slicc-42.md', '-R', SLUG];
const retryLines = (m) => m.lines.filter((l) => /^\s*retry\b/.test(l));

// 1. THE INCIDENT, recovered: GET /user 502 then OK.
test('GET /user: 502 then OK succeeds after exactly one retry', () => {
  const m = load([fail(INCIDENT_STDERR), okOut('octocat\n')]);
  const r = run(m, GET_USER);
  ok(!r.error, 'did not throw: ' + (r.error || ''));
  is(r.value && r.value.stdout.trim(), 'octocat', 'second attempt\'s login returned');
  is(m.calls.length, 2, 'two requests (original + one retry)');
  is(m.requests(), 2, 'request counter counts the retry');
  is(retryLines(m).length, 1, 'one retry line logged: ' + JSON.stringify(m.lines));
  ok(/HTTP 502/.test(retryLines(m)[0] || ''), 'retry line names the failure');
  is(JSON.stringify(m.waits), '[2000]', 'waited once, 2000 ms');
});

// 2. THE INCIDENT, not recovered: the message must be exactly what it was.
test('GET /user: 502 twice fails with the unchanged message, no second retry', () => {
  const m = load([fail(INCIDENT_STDERR), fail(INCIDENT_STDERR)]);
  const r = run(m, GET_USER);
  is(r.error, INCIDENT_MESSAGE, 'message byte-identical to the incident line');
  is(m.calls.length, 2, 'exactly one retry, then give up');
  is(retryLines(m).length, 1, 'one retry line');
});

// 3. NON-TRANSIENT: 4xx is final and must not be retried.
test('GET: 401/403/404/422 are not retried', () => {
  for (const [code, text] of [[401, 'Bad credentials'], [403, 'Forbidden'], [404, 'Not Found'], [422, 'Validation Failed']]) {
    const res = http(code, text, COMMENTS_PATH);
    const m = load([res, okOut('[]')]);
    const r = run(m, GET_COMMENTS);
    is(r.error, `gh api ${COMMENTS_PATH} --jq failed (status 1): ${res.stderr}`, `${code}: fails, message unchanged`);
    is(m.calls.length, 1, `${code}: one request only`);
    is(retryLines(m).length + m.waits.length, 0, `${code}: no retry line, no wait`);
  }
});

// 4. A 4xx whose body happens to mention a network phrase is still final.
test('GET: 404 with "Proxy fetch failed" in the body is not retried', () => {
  const m = load([fail(`gh: api /user failed: HTTP 404 Not Found https://api.github.com/user: {"message":"Proxy fetch failed"}`), okOut('x')]);
  ok(run(m, GET_USER).error, 'fails');
  is(m.calls.length, 1, 'one request only');
});

// 5. WRITES: never retried, whatever the failure.
test('POST (gh issue comment, the create) 502: NOT retried, fails', () => {
  const m = load([fail(`gh: issue comment failed: HTTP 502 Bad Gateway: {"error":"Proxy fetch failed"}`), okOut('')]);
  const r = run(m, CREATE);
  ok(r.error && r.error.startsWith('gh issue comment 42 failed (status 1): '), 'fails: ' + r.error);
  is(m.calls.length, 1, 'one request only: a lost POST may already have posted');
  is(retryLines(m).length + m.waits.length, 0, 'no retry line, no wait');
});

test('POST via gh api (explicit --method POST, and implicit via -f) 502: NOT retried', () => {
  for (const args of [
    ['api', '--method', 'POST', `/repos/${SLUG}/issues/42/comments`, '-f', 'body=x'],
    ['api', `/repos/${SLUG}/issues/42/comments`, '-f', 'body=x'],
    ['api', `/repos/${SLUG}/issues/42/comments`, '--input', '/tmp/body.json'],
  ]) {
    const m = load([fail(INCIDENT_STDERR), okOut('{}')]);
    ok(run(m, args).error, args.join(' ') + ': fails');
    is(m.calls.length, 1, args.join(' ') + ': one request only');
  }
});

test('PATCH 502: NOT retried, fails', () => {
  const m = load([fail(INCIDENT_STDERR), okOut('{}')]);
  const r = run(m, PATCH);
  is(r.error, `gh api --method PATCH failed (status 1): ${INCIDENT_STDERR}`, 'fails, message unchanged');
  is(m.calls.length, 1, 'one request only');
  is(retryLines(m).length + m.waits.length, 0, 'no retry line, no wait');
});

test('DELETE 502: NOT retried, fails', () => {
  const m = load([fail(INCIDENT_STDERR), okOut('')]);
  const r = run(m, DELETE);
  is(r.error, `gh api --method DELETE failed (status 1): ${INCIDENT_STDERR}`, 'fails, message unchanged');
  is(m.calls.length, 1, 'one request only');
  is(retryLines(m).length + m.waits.length, 0, 'no retry line, no wait');
});

// 6. The other transient shapes on the other GET call site.
test('GET comments: 503, 504 and a status-less network failure are each retried once', () => {
  for (const stderr of [
    http(503, 'Service Unavailable', COMMENTS_PATH).stderr,
    http(504, 'Gateway Timeout', COMMENTS_PATH).stderr,
    `gh: api ${COMMENTS_PATH} failed: Proxy fetch failed: The network connection was lost.`,
    `gh: api ${COMMENTS_PATH} failed: TypeError: Failed to fetch`,
  ]) {
    const m = load([fail(stderr), okOut('[]')]);
    const r = run(m, GET_COMMENTS);
    ok(!r.error, 'recovered: ' + stderr.slice(0, 70));
    is(m.calls.length, 2, 'two requests: ' + stderr.slice(0, 70));
  }
});

// 7. Steady state: a good GET is one request and says nothing extra.
test('GET OK: one request, no retry line (regression guard)', () => {
  const m = load([okOut('octocat')]);
  ok(!run(m, GET_USER).error, 'ok');
  is(m.calls.length, 1, 'one request');
  is(m.lines.length, 0, 'no output');
});

// 8. The wait is real in this runtime (Atomics.wait works here), and bounded.
test('real wait: 502 then OK takes about 2 s, not more', () => {
  const m = load([fail(INCIDENT_STDERR), okOut('octocat')], { realWait: true });
  const t0 = Date.now();
  const r = run(m, GET_USER);
  const ms = Date.now() - t0;
  ok(!r.error, 'recovered');
  ok(ms >= 1900 && ms < 4000, 'elapsed ' + ms + ' ms in [1900, 4000)');
});
