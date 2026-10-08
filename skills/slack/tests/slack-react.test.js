// slack-react.test.js — tst suite for the react / unreact / reactions commands
// in skills/slack/scripts/slack.jsh.
//
// Run from skills/slack/:
//   tst tests/slack-react.test.js
//
// Strategy (same as slack-ext.test.js): compile the REAL slack.jsh from disk as
// an AsyncFunction body with mocked sliccy:* modules, so no reimplementation can
// drift from the shipped code. Two modes:
//   - pure:    the `// --- Main ---` dispatch tail is cut off and the helpers
//              are returned for direct calls;
//   - runMain: the file runs UNMODIFIED with a simulated argv, exactly as a
//              user typing `slack react ...`, and process.exit() is captured.
// The browser bridge is a stub: every Slack API call is recorded and answered
// from a per-test table, so the suite is offline and deterministic.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';

const SCRIPT = fileURLToPath(new URL('../scripts/slack.jsh', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class NodeExitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NodeExitError';
    this.exitCode = code !== undefined ? code : 1;
  }
}

const WS = 'E06V3987PMY';
const CH = 'C03FG8625AS';
const TS = '1791442410.765389';

/**
 * @param {object} opts
 * @param {string[]} [opts.argv]  words after `slack`; set to run main()
 * @param {object}   [opts.api]   method -> response body
 */
async function load(opts = {}) {
  const calls = [];
  const stdout = [];
  const stderr = [];
  const tab = { id: 'tab1', url: `https://app.slack.com/client/${WS}/${CH}` };

  const browserStub = {
    async findTab() {
      return tab;
    },
    async localStorage(_tab, key) {
      if (key !== 'localConfig_v2') return null;
      return JSON.stringify({ teams: { [WS]: { token: 'xoxc-test-token' } } });
    },
    async fetch(_tab, url, fetchOpts) {
      const method = url.replace('/api/', '');
      const params = {};
      for (const [k, v] of new URLSearchParams(fetchOpts.body)) if (k !== 'token') params[k] = v;
      calls.push({ method, params });
      const api = opts.api || {};
      if (Object.hasOwn(api, method)) return { body: api[method] };
      return { body: { ok: false, error: 'not_mocked' } };
    },
  };

  const mocks = {
    'sliccy:browser': browserStub,
    'sliccy:exec': {
      exec: async () => {
        throw new Error('reaction commands must not shell out');
      },
    },
    fs: {
      readFile: async () => {
        throw new Error('ENOENT');
      },
      writeFile: async () => {
        throw new Error('EACCES');
      },
    },
  };
  const mockRequire = (id) => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    throw new Error('unexpected require(' + id + ')');
  };

  let source = readFileSync(SCRIPT, 'utf8');
  if (!opts.argv) {
    const cut = source.indexOf('\n// --- Main ---');
    if (cut < 0) throw new Error('slack.jsh: "// --- Main ---" marker not found');
    source =
      source.slice(0, cut) +
      '\nreturn { parseReactionTarget, interpretReactionResult, formatReactionLines, normalizeEmojiName, commands };\n';
  }

  const mockProcess = {
    argv: ['node', SCRIPT, ...(opts.argv || [])],
    env: {},
    exit: (code) => {
      throw new NodeExitError('exit', code === undefined ? 0 : code);
    },
  };
  const mockConsole = {
    log: (...a) => stdout.push(a.map(String).join(' ')),
    info: (...a) => stdout.push(a.map(String).join(' ')),
    error: (...a) => stderr.push(a.map(String).join(' ')),
    warn: (...a) => stderr.push(a.map(String).join(' ')),
  };

  const factory = new AsyncFunction('require', 'process', 'console', source);
  let mod = null;
  let exitCode = 0;
  try {
    mod = await factory(mockRequire, mockProcess, mockConsole);
  } catch (e) {
    if (!(e instanceof NodeExitError)) throw e;
    exitCode = e.exitCode;
  }
  return {
    mod,
    exitCode,
    calls,
    out: () => stdout.join('\n'),
    err: () => stderr.join('\n'),
  };
}

// ─── parseReactionTarget (pure) ──────────────────────────────────────────────

test('parseReactionTarget: :ticket: and ticket normalise to the same shortcode', async () => {
  const { mod } = await load();
  is(mod.parseReactionTarget([CH, TS, ':ticket:']), { channel: CH, timestamp: TS, name: 'ticket' });
  is(mod.parseReactionTarget([CH, TS, 'ticket']), { channel: CH, timestamp: TS, name: 'ticket' });
});

test('parseReactionTarget: keeps a skin-tone modifier', async () => {
  const { mod } = await load();
  is(mod.parseReactionTarget([CH, TS, ':+1::skin-tone-3:']).name, '+1::skin-tone-3');
});

test('parseReactionTarget: missing arguments', async () => {
  const { mod } = await load();
  is(mod.parseReactionTarget([]).error, 'missing_args');
  is(mod.parseReactionTarget([CH]).error, 'missing_args');
  is(mod.parseReactionTarget([CH, TS]).error, 'missing_args');
  // reactions does not need an emoji
  is(mod.parseReactionTarget([CH, TS], { needEmoji: false }), {
    channel: CH,
    timestamp: TS,
    name: null,
  });
});

test('parseReactionTarget: rejects a malformed channel, ts, or emoji', async () => {
  const { mod } = await load();
  ok(/Invalid channel ID/.test(mod.parseReactionTarget(['C1;rm', TS, 'ticket']).error));
  ok(/Invalid message ts/.test(mod.parseReactionTarget([CH, '1791442410', 'ticket']).error));
  ok(/Invalid message ts/.test(mod.parseReactionTarget([CH, 'p1791442410765389', 'ticket']).error));
  ok(/Invalid emoji/.test(mod.parseReactionTarget([CH, TS, '::']).error));
  ok(/Invalid emoji/.test(mod.parseReactionTarget([CH, TS, 'two words']).error));
  ok(/Invalid emoji/.test(mod.parseReactionTarget([CH, TS, 'a,b']).error));
});

// ─── interpretReactionResult (pure) ──────────────────────────────────────────

test('interpretReactionResult: ok, no-op, and failure', async () => {
  const { mod } = await load();
  const f = mod.interpretReactionResult;
  is(f('reactions.add', { ok: true }), { ok: true, changed: true });
  is(f('reactions.add', { ok: false, error: 'already_reacted' }), {
    ok: true,
    changed: false,
    note: 'already_reacted',
  });
  is(f('reactions.remove', { ok: false, error: 'no_reaction' }), {
    ok: true,
    changed: false,
    note: 'no_reaction',
  });
  // The no-op error is per-method: no_reaction on ADD is a real failure.
  is(f('reactions.add', { ok: false, error: 'no_reaction' }), { ok: false, error: 'no_reaction' });
  is(f('reactions.remove', { ok: false, error: 'already_reacted' }), {
    ok: false,
    error: 'already_reacted',
  });
  is(f('reactions.add', { ok: false, error: 'invalid_name' }), {
    ok: false,
    error: 'invalid_name',
  });
  is(f('reactions.add', undefined), { ok: false, error: 'unknown_error' });
});

// ─── formatReactionLines (pure) ──────────────────────────────────────────────

test('formatReactionLines: name, count, users; flags unlisted users', async () => {
  const { mod } = await load();
  const lines = mod.formatReactionLines([
    { name: 'ticket', count: 1, users: ['U1'] },
    { name: 'eyes', count: 3, users: ['U2', 'U3'] },
  ]);
  is(lines.length, 2);
  ok(/^:ticket:\s+1\s+U1$/.test(lines[0]), lines[0]);
  ok(/^:eyes:\s+3\s+U2, U3 \(\+1 not listed\)$/.test(lines[1]), lines[1]);
  is(mod.formatReactionLines(undefined), ['No reactions.']);
  is(mod.formatReactionLines([]), ['No reactions.']);
});

// ─── slack react (full CLI path) ─────────────────────────────────────────────

test('react: calls reactions.add with the bare shortcode and exits 0', async () => {
  const h = await load({
    argv: ['react', CH, TS, ':ticket:', `--ws=${WS}`],
    api: { 'reactions.add': { ok: true } },
  });
  is(h.exitCode, 0);
  is(h.calls, [
    { method: 'reactions.add', params: { channel: CH, timestamp: TS, name: 'ticket' } },
  ]);
  ok(h.out().includes(`Reacted :ticket: on ${CH} ts=${TS}`), h.out());
});

test('react: already_reacted is an idempotent success (exit 0, note)', async () => {
  const h = await load({
    argv: ['react', CH, TS, 'ticket'],
    api: { 'reactions.add': { ok: false, error: 'already_reacted' } },
  });
  is(h.exitCode, 0);
  is(h.calls.length, 1);
  ok(/already has :ticket:.*already_reacted.*nothing to do/.test(h.out()), h.out());
  is(h.err(), '');
});

test('react: any other ok:false exits 1 with the Slack error', async () => {
  const h = await load({
    argv: ['react', CH, TS, 'nosuchemoji'],
    api: { 'reactions.add': { ok: false, error: 'invalid_name' } },
  });
  is(h.exitCode, 1);
  ok(h.err().includes('Error: invalid_name'), h.err());
});

test('react: bad arguments exit 1 with usage and make no API call', async () => {
  const missing = await load({ argv: ['react', CH, TS], api: { 'reactions.add': { ok: true } } });
  is(missing.exitCode, 1);
  is(missing.calls.length, 0);
  ok(missing.err().includes('Usage: slack react <channel_id> <message_ts> <emoji>'), missing.err());

  const badTs = await load({
    argv: ['react', CH, 'yesterday', 'ticket'],
    api: { 'reactions.add': { ok: true } },
  });
  is(badTs.exitCode, 1);
  is(badTs.calls.length, 0);
  ok(badTs.err().includes('Invalid message ts'), badTs.err());
});

test('react: auth failure exits 1 through slackApi', async () => {
  const h = await load({
    argv: ['react', CH, TS, 'ticket'],
    api: { 'reactions.add': { ok: false, error: 'invalid_auth' } },
  });
  is(h.exitCode, 1);
  ok(h.err().includes('Auth failed'), h.err());
});

// ─── slack unreact ───────────────────────────────────────────────────────────

test('unreact: calls reactions.remove and exits 0', async () => {
  const h = await load({
    argv: ['unreact', CH, TS, ':eyes:'],
    api: { 'reactions.remove': { ok: true } },
  });
  is(h.exitCode, 0);
  is(h.calls, [
    { method: 'reactions.remove', params: { channel: CH, timestamp: TS, name: 'eyes' } },
  ]);
  ok(h.out().includes(`Removed :eyes: from ${CH} ts=${TS}`), h.out());
});

test('unreact: no_reaction is an idempotent success', async () => {
  const h = await load({
    argv: ['unreact', CH, TS, 'eyes'],
    api: { 'reactions.remove': { ok: false, error: 'no_reaction' } },
  });
  is(h.exitCode, 0);
  ok(/does not have :eyes:.*no_reaction/.test(h.out()), h.out());
});

test('unreact: other errors exit 1', async () => {
  const h = await load({
    argv: ['unreact', CH, TS, 'eyes'],
    api: { 'reactions.remove': { ok: false, error: 'message_not_found' } },
  });
  is(h.exitCode, 1);
  ok(h.err().includes('Error: message_not_found'), h.err());
});

// ─── slack reactions ─────────────────────────────────────────────────────────

const GET_BODY = {
  ok: true,
  type: 'message',
  channel: CH,
  message: { ts: TS, reactions: [{ name: 'ticket', count: 1, users: ['U1'] }] },
};

test('reactions: reactions.get with full=true, one line per reaction', async () => {
  const h = await load({ argv: ['reactions', CH, TS], api: { 'reactions.get': GET_BODY } });
  is(h.exitCode, 0);
  is(h.calls, [{ method: 'reactions.get', params: { channel: CH, timestamp: TS, full: 'true' } }]);
  ok(/^:ticket:\s+1\s+U1$/.test(h.out()), h.out());
});

test('reactions --json prints the raw response', async () => {
  const h = await load({
    argv: ['reactions', CH, TS, '--json'],
    api: { 'reactions.get': GET_BODY },
  });
  is(h.exitCode, 0);
  is(JSON.parse(h.out()), GET_BODY);
});

test('reactions: Slack error exits 1', async () => {
  const h = await load({
    argv: ['reactions', CH, TS],
    api: { 'reactions.get': { ok: false, error: 'channel_not_found' } },
  });
  is(h.exitCode, 1);
  ok(h.err().includes('channel_not_found'), h.err());
});

// ─── help ────────────────────────────────────────────────────────────────────

test('help lists react, unreact, and reactions', async () => {
  const h = await load({ argv: ['help'] });
  is(h.exitCode, 0);
  ok(h.out().includes('react <channel_id> <message_ts> <emoji>'));
  ok(h.out().includes('unreact <channel_id> <message_ts> <emoji>'));
  ok(h.out().includes('reactions <channel_id> <message_ts> [--json]'));
});
