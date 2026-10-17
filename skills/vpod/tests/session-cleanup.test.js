import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// withSession, cut out of the shipped vpod.jsh and run against stubs. Under
// Node exit semantics (slicc-jsh, SLICC 7) nothing runs after cli.die, so the
// contract is: by the time the command dies, the sandbox is closed and the
// session lock is released. The stub die records whether that was true.
const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/vpod.jsh'), 'utf8');

function extract(signature) {
  const start = SOURCE.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const end = SOURCE.indexOf('\n}\n', start);
  return SOURCE.slice(start, end + 2);
}

class DeadlineError extends Error {}

function harness({ fn, boot }) {
  const events = [];
  const scope = {
    DeadlineError,
    TOOL: 'vpod',
    WEDGED_HINT: (name) => `run: vpod rm ${name}`,
    DEFAULT_TIMEOUT_S: 1,
    RUN_GRACE_MS: 1,
    BOOT_DEADLINE_MS: 1,
    SUSPEND_DEADLINE_MS: 1,
    LOCK_SLACK_MS: 1,
    requireName: () => {},
    loadSdk: async () => ({}),
    acquireLock: async () => 'tok',
    releaseLock: async () => events.push('releaseLock'),
    openSession: async () => {
      if (boot) throw boot;
      return { sandbox: { id: 'sb' }, snapshotId: 'snap' };
    },
    withDeadline: (p) => p,
    saveSession: async () => events.push('saveSession'),
    markWedged: async () => events.push('markWedged'),
    closeQuietly: async () => events.push('closeQuietly'),
    cli: {
      die: (msg) => {
        events.push({ die: msg, cleanedUp: events.includes('releaseLock') });
        throw Object.assign(new Error(msg), { name: 'NodeExitError' });
      },
    },
  };
  const proxy = new Proxy(scope, {
    has: (t, k) => k in t || !(k in globalThis),
    get: (t, k) => (k in t ? t[k] : globalThis[k]),
  });
  const withSession = new Function(
    'scope',
    `with (scope) { ${extract('async function withSession(')}\nreturn withSession; }`
  )(proxy);
  return { events, run: () => withSession('dev', {}, fn) };
}

async function outcome(h) {
  try {
    await h.run();
    return null;
  } catch (e) {
    return e;
  }
}

test('a guest that stops answering: cleanup runs, then the error reaches main() (no die inside)', async () => {
  const h = harness({
    fn: async () => {
      throw new DeadlineError('guest did not answer within 1s');
    },
  });
  const err = await outcome(h);
  ok(
    err && err.name !== 'NodeExitError',
    'withSession throws an error for main(), it does not exit'
  );
  ok(err.message.includes("guest did not answer within 1s for session 'dev'"), err.message);
  ok(err.message.includes('run: vpod rm dev'));
  is(h.events, ['markWedged', 'closeQuietly', 'releaseLock']);
});

test('a slow boot: the lock is released before the error surfaces', async () => {
  const h = harness({ boot: new DeadlineError('boot took longer than 1s'), fn: async () => 1 });
  const err = await outcome(h);
  ok(err && err.name !== 'NodeExitError');
  ok(err.message.includes('Check the connection and the registry'), err.message);
  is(h.events, ['releaseLock']);
});

test('a normal run suspends the session, closes the sandbox and releases the lock', async () => {
  const h = harness({ fn: async () => 'ok' });
  is(await h.run(), 'ok');
  is(h.events, ['saveSession', 'closeQuietly', 'releaseLock']);
});
