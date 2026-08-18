// Regression test for the `?password=` leak in scripts/bluebubbles.jsh.
//
// The password is sent as a query parameter, so it lands inside the request URL
// *and* inside error strings composed by the HTTP layer
// (`HTTP 530 <url>: <body>`). Before the fix only the `url` field was scrubbed
// (stripPasswordFromUrl), while the error *message* was passed through
// verbatim — so `bluebubbles status` against a dead tunnel printed the password
// in clear text.
//
// Convention: same as skills/github/tests and skills/search/tests — plain
// `node:test` + `node:assert`, run with `node --test skills/bluebubbles/tests`.
// The .jsh script is compiled as an AsyncFunction with stub `sliccy:*` modules
// (the pattern used by skills/github/tests/gh-pr-edit-command.test.js), the
// trailing `await main()` is dropped, and the redaction helpers are returned so
// they can be exercised directly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '../scripts/bluebubbles.jsh');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

const SECRET = 'sup3r-s3cret-pw';

function loadHelpers() {
  let source = fs.readFileSync(SCRIPT, 'utf8');
  source = source.replace(/\nawait main\(\);\s*$/, '\n');
  source += `
return {
  safeErrorText: typeof safeErrorText === 'function' ? safeErrorText : null,
  bbErrorMessage,
  stripPasswordFromUrl,
  registerSecret: typeof registerSecret === 'function' ? registerSecret : null,
};
`;

  const stubs = {
    fs: { readFile: async () => null, exists: () => false },
    os: { homedir: () => '/home/test' },
    path: require('node:path'),
    'sliccy:cli': {
      die: (message) => {
        const err = new Error(String(message));
        err.name = 'NodeExitError';
        throw err;
      },
      help: () => {},
      out: () => {},
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    'sliccy:fmt': {
      trunc: (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s)),
      date: () => '',
    },
    'sliccy:http': { client: () => ({}) },
    'sliccy:exec': { exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
  };

  const requireStub = (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`unexpected require(${id})`);
  };

  const argv = ['node', SCRIPT, 'status'];
  argv.parseFlags = () => ({ subcommand: 'status', positional: ['status'], flags: {} });
  const proc = { argv, env: {}, exit: () => {}, cwd: () => '/workspace' };

  const factory = new AsyncFunction('require', 'process', 'console', 'URL', source);
  return factory(requireStub, proc, { log: () => {} }, URL);
}

test('the formatted error string never carries the password', async () => {
  const { safeErrorText, bbErrorMessage, registerSecret } = await loadHelpers();
  if (registerSecret) registerSecret(SECRET);

  // Exactly the shape observed live: the HTTP layer embeds the full request URL
  // in err.message, and err.body is a JSON object with no message/error field,
  // so bbErrorMessage() falls through to err.message.
  const err = {
    status: 530,
    url: `https://tunnel.example.com/api/v1/contact/query?password=${SECRET}`,
    message:
      `HTTP 530  https://tunnel.example.com/api/v1/contact/query?password=${SECRET}: ` +
      '{"title":"Error 1016: Origin DNS error","status":530}',
    body: { title: 'Error 1016: Origin DNS error', status: 530 },
  };

  const formatted = `Contacts unavailable: ${bbErrorMessage(err)}`;
  assert.ok(!formatted.includes(SECRET), `password leaked: ${formatted}`);
  assert.match(formatted, /password=\*\*\*/);
  assert.match(formatted, /Origin DNS error/, 'the useful diagnostic must survive');

  // The fix is one choke point, so no future call site can bypass it.
  assert.ok(safeErrorText, 'safeErrorText() choke point must exist');
  assert.ok(registerSecret, 'registerSecret() must exist');
});

test('safeErrorText masks password= anywhere, in any case, url-encoded too', async () => {
  const { safeErrorText, registerSecret } = await loadHelpers();
  if (registerSecret) registerSecret(SECRET);

  const cases = [
    `password=${SECRET}`,
    `?password=${SECRET}`,
    `&password=${SECRET}&limit=5`,
    `PASSWORD=${SECRET} trailing text`,
    `fetch failed for url "https://h/api?password=${SECRET}"`,
    `https://h/api?password=${encodeURIComponent('p@ss w/rd+é')}&x=1`,
    `password=${SECRET}\nnext line`,
  ];

  for (const input of cases) {
    const out = safeErrorText(input);
    assert.ok(!out.includes(SECRET), `leaked in: ${input}`);
    assert.ok(!out.includes('p%40ss'), `leaked url-encoded value in: ${input}`);
    assert.match(out, /password=\*\*\*/i, `not masked: ${input}`);
  }

  // Value ends at & — the rest of the query string is preserved.
  assert.equal(safeErrorText(`&password=${SECRET}&limit=5`), '&password=***&limit=5');
});

test('a password field echoed back inside a JSON body is masked', async () => {
  const { safeErrorText } = await loadHelpers();
  const body = JSON.stringify({ error: 'bad request', password: SECRET, limit: 5 });
  const out = safeErrorText(`Send rejected (400): ${body}`);
  assert.ok(!out.includes(SECRET), out);
  assert.match(out, /"password":"\*\*\*"/);
  assert.match(out, /"limit":5/);
});

test('the literal secret is masked even without a password= prefix', async () => {
  const { safeErrorText, registerSecret } = await loadHelpers();
  registerSecret(SECRET);
  const out = safeErrorText(`unexpected echo of credentials: ${SECRET} (sorry)`);
  assert.ok(!out.includes(SECRET), out);
  assert.match(out, /\*\*\*/);
});

test('stripPasswordFromUrl still masks the url field', async () => {
  const { stripPasswordFromUrl } = await loadHelpers();
  const masked = stripPasswordFromUrl(
    `https://tunnel.example.com/api/v1/ping?password=${SECRET}&limit=1`
  );
  assert.ok(!masked.includes(SECRET), masked);
  assert.match(masked, /password=\*\*\*/);
  assert.match(masked, /limit=1/);
  // Non-URL input must not throw and must still be redacted.
  const junk = stripPasswordFromUrl(`not a url password=${SECRET}`);
  assert.ok(!junk.includes(SECRET), junk);
});
