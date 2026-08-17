// Tests for the `immobilienscout24 send` write path.
//
// The skill ships as a single `.jsh` file (relative `require()` of a sibling
// `.js` module is not resolvable in the SLICC jsh runtime), so these tests read
// the script source, evaluate the pure helpers in a sandbox, and assert the
// safety guards statically. Run with `node --test skills/immobilienscout24/tests`.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'immobilienscout24.jsh');
const SKILL_MD = path.join(__dirname, '..', 'SKILL.md');
const ENDPOINTS_MD = path.join(__dirname, '..', 'references', 'endpoints.md');

const source = fs.readFileSync(SCRIPT, 'utf8');

// ── pure helpers, evaluated out of the .jsh source ─────────────────────────

function loadHelpers() {
  const start = source.indexOf('const MAX_MESSAGE_CHARS');
  const end = source.indexOf('async function cmdSend(');
  assert.ok(start > 0, 'MAX_MESSAGE_CHARS block not found');
  assert.ok(end > start, 'cmdSend not found after the helper block');
  const body = source.slice(start, end);

  const dieCalls = [];
  const cli = {
    die: (message) => {
      dieCalls.push(message);
      const err = new Error(message);
      err.name = 'NodeExitError';
      throw err;
    },
  };
  const factory = new Function(
    'WWW',
    'cli',
    'require',
    `${body}
    return { MAX_MESSAGE_CHARS, DEFAULT_SEND_TAGS, SEND_ALIASES, threadUrl, sendUrl,
             readMessageBody, parseTags };`
  );
  return {
    ...factory('https://www.immobilienscout24.de', cli, require),
    dieCalls,
  };
}

test('sendUrl builds the Nachrichten-Manager message endpoint', () => {
  const { sendUrl } = loadHelpers();
  assert.equal(
    sendUrl('166323126', 'b025f04b-f81f-4a01-9f27-9fa0d1b9ab23'),
    'https://www.immobilienscout24.de/nachrichten-manager/api/references/166323126' +
      '/conversations/b025f04b-f81f-4a01-9f27-9fa0d1b9ab23/messages'
  );
});

test('sendUrl percent-encodes path segments', () => {
  const { sendUrl } = loadHelpers();
  assert.ok(sendUrl('1/2', 'a b').includes('/references/1%2F2/conversations/a%20b/messages'));
});

test('send aliases cover send / reply / antworten', () => {
  const { SEND_ALIASES } = loadHelpers();
  for (const alias of ['send', 'reply', 'antworten']) {
    assert.ok(SEND_ALIASES.has(alias), `missing alias ${alias}`);
  }
  assert.equal(SEND_ALIASES.has('messages'), false);
});

test('MAX_MESSAGE_CHARS matches the reply textarea cap', () => {
  const { MAX_MESSAGE_CHARS } = loadHelpers();
  assert.equal(MAX_MESSAGE_CHARS, 100000);
});

test('parseTags defaults to the captured tags and parses overrides', () => {
  const { parseTags } = loadHelpers();
  // The captured 201 send carried ["replied","inbox"].
  assert.deepEqual(parseTags({}), ['replied', 'inbox']);
  assert.deepEqual(parseTags({ tags: true }), ['replied', 'inbox']);
  assert.deepEqual(parseTags({ tags: '' }), ['replied', 'inbox']);
  assert.deepEqual(parseTags({ tags: 'none' }), []);
  assert.deepEqual(parseTags({ tags: 'inbox' }), ['inbox']);
  assert.deepEqual(parseTags({ tags: ' inbox , favourite ,, ' }), ['inbox', 'favourite']);
});

test('readMessageBody takes inline text and normalises CRLF', () => {
  const { readMessageBody } = loadHelpers();
  assert.equal(readMessageBody('Guten Tag', {}), 'Guten Tag');
  assert.equal(readMessageBody('a\r\nb', {}), 'a\nb');
  assert.equal(readMessageBody(undefined, {}), '');
});

test('readMessageBody reads multi-line German text from --file', () => {
  const { readMessageBody } = loadHelpers();
  const file = path.join(os.tmpdir(), `is24-send-${Date.now()}.txt`);
  fs.writeFileSync(file, 'Sehr geehrter Herr Jillich,\r\n\r\nDonnerstag, 18:00 Uhr\n\n\n');
  try {
    assert.equal(
      readMessageBody(null, { file }),
      'Sehr geehrter Herr Jillich,\n\nDonnerstag, 18:00 Uhr'
    );
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

test('readMessageBody refuses inline text together with --file', () => {
  const { readMessageBody, dieCalls } = loadHelpers();
  assert.throws(
    () => readMessageBody('inline', { file: '/tmp/whatever.txt' }),
    /either inline or via --file/
  );
  assert.ok(/either inline or via --file/.test(dieCalls.join('\n')));
});

test('readMessageBody reports an unreadable --file path', () => {
  const { readMessageBody, dieCalls } = loadHelpers();
  assert.throws(() => readMessageBody(null, { file: '/definitely/not/here.txt' }), /cannot read/);
  assert.ok(/cannot read --file/.test(dieCalls.join('\n')));
});

// ── safety guards, asserted statically against the source ──────────────────

test('cmdSend returns before any request when --confirm is absent', () => {
  const start = source.indexOf('async function cmdSend(');
  const guard = source.indexOf('if (!flags.confirm) {', start);
  const firstFetch = source.indexOf('await apiFetch(', start);
  assert.ok(guard > start, 'cmdSend has no !flags.confirm guard');
  assert.ok(firstFetch > guard, 'cmdSend issues a request before the --confirm guard');
  const preview = source.slice(guard, firstFetch);
  assert.ok(/return;/.test(preview), 'the preview branch does not return');
  assert.ok(/DRY RUN/.test(preview), 'the preview branch does not announce a dry run');
});

test('cmdSend rejects an empty body and an over-long body', () => {
  const start = source.indexOf('async function cmdSend(');
  const body = source.slice(start, source.indexOf('async function cmdGeo('));
  assert.ok(/empty message body/.test(body));
  assert.ok(/MAX_MESSAGE_CHARS/.test(body));
  assert.ok(/invalid conversation id/.test(body));
  assert.ok(/invalid listing id/.test(body));
});

test('the dry-run path never needs a browser tab', () => {
  assert.ok(
    /const isSendPreview = SEND_ALIASES\.has\(subcommand\) && !flags\.confirm;/.test(source),
    'main() does not compute isSendPreview'
  );
  assert.ok(
    /const tab = isSendPreview \? null : await getTab\(\);/.test(source),
    'main() looks up a tab even for the send preview'
  );
});

// ── documentation ──────────────────────────────────────────────────────────

test('SKILL.md documents send, --confirm, --file and applicant', () => {
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  const usage = md.slice(md.indexOf('## Usage'), md.indexOf('## Flags'));
  assert.ok(usage.includes('immobilienscout24 send '), 'send missing from the usage block');
  assert.ok(usage.includes('immobilienscout24 applicant '), 'applicant missing from usage block');
  assert.ok(usage.includes('--confirm'), '--confirm missing from the usage block');
  assert.ok(md.includes('--file'), '--file not documented');
});

test('endpoints.md documents the send endpoint and its payload', () => {
  const md = fs.readFileSync(ENDPOINTS_MD, 'utf8');
  assert.ok(md.includes('/conversations/:conversationId/messages'));
  assert.ok(md.includes('recommendedActionName'));
});

test('the HELP text advertises send with --confirm', () => {
  const help = source.slice(source.indexOf('const HELP = `'), source.indexOf('const SEARCH_TYPES'));
  assert.ok(help.includes('immobilienscout24 send <listingId> <conversationId>'));
  assert.ok(help.includes('--confirm'));
  assert.ok(help.includes('--file <path>'));
});

test('DEFAULT_SEND_TAGS matches the captured request body', () => {
  const { DEFAULT_SEND_TAGS } = loadHelpers();
  assert.deepEqual(DEFAULT_SEND_TAGS, ['replied', 'inbox']);
});

test('threadUrl keeps the required messages/ segment', () => {
  const { threadUrl } = loadHelpers();
  assert.equal(
    threadUrl('166323126', 'b025f04b-f81f-4a01-9f27-9fa0d1b9ab23'),
    'https://www.immobilienscout24.de/nachrichten-manager/166323126' +
      '/inbox/messages/b025f04b-f81f-4a01-9f27-9fa0d1b9ab23'
  );
  // the trap: without messages/ the SPA renders no thread
  assert.ok(!/\/inbox\/[0-9a-f-]+$/.test(threadUrl('1', 'b025f04b-f81f-4a01-9f27-9fa0d1b9ab23')));
});

test('writes carry the www double-submit token, reads do not', () => {
  assert.ok(
    /const isWrite = method !== 'GET' && method !== 'HEAD';/.test(source),
    'apiFetch does not classify writes'
  );
  assert.ok(
    /if \(kind === 'nachrichten' && isWrite\) await ensureWwwXsrf\(useTab\);/.test(source),
    'nachrichten writes do not ensure the XSRF-TOKEN cookie'
  );
  assert.ok(
    /headers\['X-XSRF-TOKEN'\] = _wwwXsrf;/.test(source),
    'X-XSRF-TOKEN header is not attached'
  );
});

test('ensureWwwXsrf reads the cookie and fails actionably', () => {
  const fn = source.slice(source.indexOf('async function ensureWwwXsrf('), source.indexOf('async function ensureNachrichtenTokens('));
  assert.ok(/readDocumentCookie\(nTab, 'XSRF-TOKEN'\)/.test(fn), 'cookie is not read');
  assert.ok(/missing XSRF-TOKEN cookie/.test(fn), 'no actionable error message');
  assert.ok(/immobilienscout24\.de \(logged in\)/.test(fn), 'error does not say what to do');
});

test('send re-mints the rotating tokens immediately before the POST', () => {
  const start = source.indexOf('async function cmdSend(');
  const body = source.slice(start, source.indexOf('async function cmdGeo('));
  const refresh = body.indexOf('await refreshNachrichtenTokens(tab);');
  const post = body.indexOf("{ method: 'POST', body: payload }");
  assert.ok(refresh > 0, 'no token refresh before the write');
  assert.ok(post > refresh, 'tokens are refreshed after the POST, not before');
  assert.ok(
    /_hdrTokens\.communicationMgr = null;/.test(source) &&
      /_hdrTokens\.contactProspects = null;/.test(source),
    'refresh does not clear both cached tokens'
  );
});

test('the dry run never prints token values', () => {
  const plan = source.slice(source.indexOf('function sendHeaderPlan()'), source.indexOf('async function cmdSend('));
  assert.ok(/X-XSRF-TOKEN/.test(plan), 'header plan omits X-XSRF-TOKEN');
  // every value in the plan must be a <placeholder>, never a live token
  for (const m of plan.matchAll(/'(<[^']+>)'/g)) assert.ok(m[1].startsWith('<'));
  assert.ok(!/_wwwXsrf|_hdrTokens/.test(plan), 'header plan reaches into live token state');
});

test('success handling matches the captured 201 response shape', () => {
  const start = source.indexOf('async function cmdSend(');
  const body = source.slice(start, source.indexOf('async function cmdGeo('));
  assert.ok(/sent\?\.id \|\| sent\?\.messageId/.test(body), 'response id is not read as .id first');
  assert.ok(/creationDateTime/.test(body), 'server timestamp is not surfaced');
  assert.ok(/threadUrl\(listingId, conversationId\)/.test(body), 'thread deep link not printed');
});

test('endpoints.md documents token provenance and the deep-link trap', () => {
  const md = fs.readFileSync(ENDPOINTS_MD, 'utf8');
  assert.ok(/CSRF token provenance/.test(md));
  assert.ok(/XSRF-TOKEN` cookie/.test(md), 'X-XSRF-TOKEN cookie origin missing');
  assert.ok(/rotates on every response/.test(md), 'token rotation not documented');
  assert.ok(/201 Created/.test(md), '201 status not documented');
  assert.ok(/inbox\/messages\/<conversationId>/.test(md), 'deep-link pattern missing');
  assert.ok(/messages\/` segment is \*\*required\*\*/.test(md), 'deep-link trap not called out');
});

test('unknown conversation ids are detected by payload shape, not status', () => {
  const fn = source.slice(
    source.indexOf('async function loadConversationForSend('),
    source.indexOf('async function cmdSend(')
  );
  assert.ok(/Array\.isArray\(body\.messages\)/.test(fn), 'does not check for a messages array');
  assert.ok(/unknown conversation/.test(fn), 'no actionable unknown-id message');
  assert.ok(/immobilienscout24 conversations/.test(fn), 'does not tell the user how to list ids');
  assert.ok(/lookLikeLogin\(res\)/.test(fn), 'does not detect an expired session');
});

test('the pre-flight runs before the POST in cmdSend', () => {
  const start = source.indexOf('async function cmdSend(');
  const body = source.slice(start, source.indexOf('async function cmdGeo('));
  const pre = body.indexOf('await loadConversationForSend(');
  const post = body.indexOf("{ method: 'POST', body: payload }");
  assert.ok(pre > 0 && post > pre, 'pre-flight does not precede the POST');
});
