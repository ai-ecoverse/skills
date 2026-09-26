// Regression tests for the two watch-lifecycle defects (Codex P2, :1073 and :1112).
//
// A "watch" is a pair of endpoints plus one state file:
//   BlueBubbles webhook  →  SLICC webhook  →  scoop lick
// The state file under ~/.bluebubbles-watches/ is the *only* record of the two
// ids, so `watches` and `unwatch` can reach an endpoint pair if and only if it
// is on disk.
//
// :1073 — `watch --force` deleted both live endpoints and removed the state file
//   before creating the replacement, so any failure in the create path left the
//   operator with no monitoring and no ids to clean up. Order is now
//   create → persist → retire.
//
// :1112 — a state write that failed after both endpoints were registered left an
//   active, undiscoverable forwarding pair. The write is now wrapped and both
//   fresh endpoints are deleted before the error propagates.

import test, { is, ok } from 'tst';
import * as _mod_0 from './harness.js';

const { load } = _mod_0.default || _mod_0;
const WATCH_DIR = '/home/test/.bluebubbles-watches';
const STATE_FILE = `${WATCH_DIR}/all-imsg-inbox.json`;

const OLD_STATE = {
  watchId: 'all-imsg-inbox',
  scoop: 'imsg-inbox',
  chatGuid: null,
  events: ['new-message'],
  sliccWebhookId: 'slicc-OLD',
  sliccWebhookUrl: 'https://slicc.example/hook/OLD',
  bbWebhookId: 41,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** SLICC `webhook create` succeeding with a fresh id. */
function execOk(id = 'slicc-NEW') {
  return async (cmd) => {
    if (cmd.startsWith('webhook create')) {
      return { exitCode: 0, stdout: `ID: ${id}\nURL: https://slicc.example/hook/${id}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

/** SLICC `webhook create` failing the way a broken runtime would. */
const execCreateFails = async (cmd) => {
  if (cmd.startsWith('webhook create')) {
    return { exitCode: 1, stdout: '', stderr: 'webhook: daemon unreachable' };
  }
  return { exitCode: 0, stdout: '', stderr: '' };
};

/** BlueBubbles server that registers webhook id 77 and accepts deletes. */
const bbOk = async (method, apiPath) => {
  if (method === 'POST' && apiPath === '/api/v1/webhook') {
    return { status: 200, data: { id: 77, url: 'https://slicc.example/hook/slicc-NEW' } };
  }
  if (method === 'DELETE') return { status: 200, data: {} };
  throw new Error(`unexpected ${method} ${apiPath}`);
};

/** BlueBubbles server that refuses to register the replacement webhook. */
const bbRegisterFails = async (method, apiPath) => {
  if (method === 'POST' && apiPath === '/api/v1/webhook') {
    const err = new Error('BlueBubbles 500 on /api/v1/webhook: helper disconnected');
    err.status = 500;
    throw err;
  }
  if (method === 'DELETE') return { status: 200, data: {} };
  throw new Error(`unexpected ${method} ${apiPath}`);
};

const withOldState = () => ({ [STATE_FILE]: JSON.stringify(OLD_STATE) });

async function expectDie(fn) {
  try {
    await fn();
  } catch (err) {
    is(err.name, 'NodeExitError', `expected a die(), got: ${err.stack}`);
    return err.message;
  }
  throw new Error('expected the command to die, it returned normally');
}

// ── :1073 — preserve the existing watch until the replacement succeeds ──────

test('--force keeps the old watch alive when the SLICC webhook cannot be created', async () => {
  const bb = await load({ api: bbOk, exec: execCreateFails, files: withOldState() });

  const message = await expectDie(() => bb.cmdWatch({ scoop: 'imsg-inbox', force: true }));
  ok((/webhook create failed/).test(message));

  // Nothing was retired. Pre-fix: 1 `webhook delete slicc-OLD` + 1 DELETE
  // /api/v1/webhook/41 + 1 rm of the state file, all before this point.
  const deletes = bb.execCommands().filter((c) => c.startsWith('webhook delete'));
  is(deletes, [], `old SLICC webhook was deleted: ${deletes.join(', ')}`);
  is(
    bb.apiCalls().filter((c) => c.startsWith('DELETE')),
    [],
    'old BlueBubbles webhook was deleted'
  );
  is(
    bb.log.filter((e) => e.kind === 'rm'),
    [],
    'state file was removed'
  );

  // The old watch is still discoverable to `watches` / `unwatch`.
  ok(bb.files.has(STATE_FILE), 'state file must survive a failed replacement');
  is(JSON.parse(bb.files.get(STATE_FILE)), OLD_STATE);
});

test('--force keeps the old watch alive when the BlueBubbles webhook cannot be registered', async () => {
  const bb = await load({ api: bbRegisterFails, exec: execOk(), files: withOldState() });

  const message = await expectDie(() => bb.cmdWatch({ scoop: 'imsg-inbox', force: true }));
  ok((/BlueBubbles webhook register failed/).test(message));

  // The half-created *new* SLICC webhook is cleaned up …
  is(bb.execCommands().filter((c) => c.includes('webhook delete')), [
    "webhook delete 'slicc-NEW'",
  ]);
  // … and the *old* pair is untouched and still recorded.
  ok(!bb.execCommands().some((c) => c.includes('slicc-OLD')), 'old SLICC webhook retired');
  is(JSON.parse(bb.files.get(STATE_FILE)), OLD_STATE);
});

test('--force retires the old pair only after the replacement is persisted', async () => {
  const bb = await load({ api: bbOk, exec: execOk(), files: withOldState() });

  await bb.cmdWatch({ scoop: 'imsg-inbox', force: true, json: true });

  // Ordering is the whole point of the fix.
  const order = bb.log
    .filter(
      (e) =>
        (e.kind === 'writeFile' && e.file === STATE_FILE) ||
        (e.kind === 'exec' && e.cmd.includes('webhook delete')) ||
        (e.kind === 'api' && e.method === 'DELETE')
    )
    .map((e) => (e.kind === 'writeFile' ? 'persist' : e.kind === 'exec' ? 'retire-slicc' : 'retire-bb'));
  is(order, ['persist', 'retire-slicc', 'retire-bb']);

  // The old endpoints are gone, the new ones are on disk.
  ok(bb.execCommands().includes("webhook delete 'slicc-OLD'"));
  ok(bb.apiCalls().includes('DELETE /api/v1/webhook/41'));
  const persisted = JSON.parse(bb.files.get(STATE_FILE));
  is(persisted.sliccWebhookId, 'slicc-NEW');
  is(persisted.bbWebhookId, 77);
  is(persisted.password, undefined, 'state must never carry a password');
  is(bb.out[0].replaced, { sliccWebhookId: 'slicc-OLD', bbWebhookId: 41 });
});

// ── :1112 — roll back both webhooks when persistence fails ─────────────────

test('a failed state write deletes both freshly created webhooks', async () => {
  const bb = await load({
    api: bbOk,
    exec: execOk(),
    onWriteFile: () => {
      throw Object.assign(new Error("EACCES: permission denied, open '" + STATE_FILE + "'"), {
        code: 'EACCES',
      });
    },
  });

  const message = await expectDie(() => bb.cmdWatch({ scoop: 'imsg-inbox' }));

  // Pre-fix: 0 deletes, and the raw EACCES reached the top-level handler while
  // both endpoints stayed live and unrecorded. Post-fix: 2 deletes.
  is(bb.execCommands().filter((c) => c.includes('webhook delete')), [
    "webhook delete 'slicc-NEW'",
  ]);
  is(bb.apiCalls().filter((c) => c.startsWith('DELETE')), [
    'DELETE /api/v1/webhook/77',
  ]);

  // The message says what happened and what was rolled back.
  ok((/could not write watch state/).test(message));
  ok((/Rolled back/).test(message));
  ok(message.includes('slicc-NEW'), 'names the SLICC webhook it removed');
  ok(message.includes('77'), 'names the BlueBubbles webhook it removed');
  ok(!bb.files.has(STATE_FILE), 'no state file for a watch that does not exist');
});

test('when rollback itself fails the ids are printed so the pair can be cleaned up by hand', async () => {
  const api = async (method, apiPath) => {
    if (method === 'POST' && apiPath === '/api/v1/webhook') {
      return { status: 200, data: { id: 77 } };
    }
    if (method === 'DELETE') {
      const err = new Error('BlueBubbles 503 on /api/v1/webhook/77: unavailable');
      err.status = 503;
      throw err;
    }
    throw new Error(`unexpected ${method} ${apiPath}`);
  };
  const exec = async (cmd) => {
    if (cmd.startsWith('webhook create')) {
      return { exitCode: 0, stdout: 'ID: slicc-NEW\nURL: https://slicc.example/hook/slicc-NEW\n', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: 'webhook: daemon unreachable' };
  };
  const bb = await load({
    api,
    exec,
    onWriteFile: () => {
      throw new Error('ENOSPC: no space left on device');
    },
  });

  const message = await expectDie(() => bb.cmdWatch({ scoop: 'imsg-inbox' }));

  ok((/Rollback incomplete/).test(message));
  ok((/webhook delete slicc-NEW/).test(message));
  ok((/DELETE \/api\/v1\/webhook\/77/).test(message));
});

test('a rolled-back state write leaves an existing --force watch explicitly intact', async () => {
  const bb = await load({
    api: bbOk,
    exec: execOk(),
    files: withOldState(),
    onWriteFile: () => {
      throw new Error('ENOSPC: no space left on device');
    },
  });

  const message = await expectDie(() =>
    bb.cmdWatch({ scoop: 'imsg-inbox', force: true })
  );

  ok((/previous watch is untouched/).test(message));
  ok(message.includes('slicc-OLD'));
  // The old pair was never retired, and its state is still the file on disk.
  ok(!bb.execCommands().some((c) => c.includes('slicc-OLD')));
  is(JSON.parse(bb.files.get(STATE_FILE)), OLD_STATE);
});

test('no watch error message can carry the server password', async () => {
  const SECRET = 'sup3r-s3cret-pw';
  const bb = await load({
    api: bbOk,
    exec: execOk(),
    onWriteFile: () => {
      // Worst case: the underlying error quotes the request URL verbatim.
      throw new Error(
        `EACCES writing state after POST https://bb.example/api/v1/webhook?password=${SECRET}`
      );
    },
  });

  const message = await expectDie(() => bb.cmdWatch({ scoop: 'imsg-inbox' }));
  ok(!message.includes(SECRET), `password leaked: ${message}`);
  ok((/password=\*\*\*/).test(message));
});
