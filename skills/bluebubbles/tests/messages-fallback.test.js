// Regression test for the fallback leak in cmdMessages (Codex P1, :591).
//
// `bluebubbles messages <address>` resolves the address to a chat guid. When no
// existing chat matches, resolveChatGuid() synthesises `iMessage;-;<address>`,
// which some server builds reject for message/query. The retry then asks for a
// *broad* recent-message list (no chatGuid at all) and filters client-side.
//
// The pre-fix filter was applied only `if (filtered.length)`, so a scan with no
// match kept the entire unfiltered list: messages from unrelated conversations
// were rendered under the requested thread's header and returned in `--json`,
// inviting the agent to quote a stranger's text back as if it were this thread.
//
// Post-fix the fallback filter is unconditional: no match ⇒ empty result plus a
// pointer to `bluebubbles chats`.

const assert = require('node:assert/strict');
const test = require('node:test');

const { load } = require('./harness.js');

const TARGET = 'friend@example.com';

// Recent messages from three *other* conversations. None of them belongs to
// TARGET, neither by chat guid nor by handle address.
const UNRELATED = [
  {
    guid: 'm1',
    text: 'boss: are the numbers ready?',
    handle: { address: 'boss@corp.example' },
    chats: [{ guid: 'iMessage;-;boss@corp.example' }],
    dateCreated: 1,
  },
  {
    guid: 'm2',
    text: 'doctor: your results came back',
    handle: { address: '+15550001111' },
    chats: [{ guid: 'iMessage;-;+15550001111' }],
    dateCreated: 2,
  },
  {
    guid: 'm3',
    text: 'group: see you at 8',
    handle: { address: '+15552223333' },
    chats: [{ guid: 'iMessage;+;chat9999' }],
    dateCreated: 3,
  },
];

/**
 * Server that has no chat for TARGET and rejects the synthetic guid, so
 * cmdMessages falls back to the broad scan.
 */
function rejectingServer(recent) {
  return async (method, apiPath, opts) => {
    if (apiPath === '/api/v1/chat/query') return { status: 200, data: [] };
    if (apiPath === '/api/v1/message/query') {
      if (opts?.body?.chatGuid) {
        const err = new Error('BlueBubbles 500 on /api/v1/message/query: bad chat guid');
        err.status = 500;
        throw err;
      }
      return { status: 200, data: recent };
    }
    throw new Error(`unexpected ${method} ${apiPath}`);
  };
}

test('fallback scan with no match returns nothing, not every recent conversation', async () => {
  const bb = await load({ api: rejectingServer(UNRELATED) });

  await bb.cmdMessages([TARGET], { json: true });

  assert.equal(bb.out.length, 1);
  const payload = bb.out[0];

  // The core assertion: zero messages. Pre-fix this was UNRELATED.length (3).
  assert.equal(
    payload.messages.length,
    0,
    `leaked ${payload.messages.length} unrelated message(s): ` +
      JSON.stringify(payload.messages.map((m) => m.text))
  );

  // And nothing from another conversation survived in any shape.
  const blob = JSON.stringify(payload);
  for (const m of UNRELATED) {
    assert.ok(!blob.includes(m.text), `unrelated message leaked into --json: ${m.text}`);
    assert.ok(!blob.includes(m.guid), `unrelated message guid leaked: ${m.guid}`);
  }

  // The user is told why the result is empty and how to recover.
  assert.match(payload.note, /no messages matched/i);
  assert.match(payload.note, /bluebubbles chats/);
  assert.ok(payload.note.includes(TARGET));

  // It really was the fallback path (broad query, no chatGuid).
  const queries = bb.log.filter((e) => e.kind === 'api' && e.apiPath === '/api/v1/message/query');
  assert.equal(queries.length, 2);
  assert.ok(queries[0].body.chatGuid, 'first attempt is scoped by chat guid');
  assert.ok(!queries[1].body.chatGuid, 'retry is the broad scan');
});

test('human output for an empty fallback says so and points at bluebubbles chats', async () => {
  const bb = await load({ api: rejectingServer(UNRELATED) });

  await bb.cmdMessages([TARGET], {});
  const text = bb.text();

  assert.match(text, new RegExp(`No messages found for ${TARGET}`));
  assert.match(text, /bluebubbles chats/);
  for (const m of UNRELATED) {
    assert.ok(!text.includes(m.text), `unrelated message printed: ${m.text}`);
  }
});

test('fallback keeps the messages that do belong to the target', async () => {
  const mine = {
    guid: 'mine1',
    text: 'friend: on my way',
    handle: { address: TARGET },
    chats: [{ guid: `iMessage;-;${TARGET}` }],
    dateCreated: 4,
  };
  const bb = await load({ api: rejectingServer([...UNRELATED, mine]) });

  await bb.cmdMessages([TARGET], { json: true });
  const payload = bb.out[0];

  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].guid, 'mine1');
  assert.equal(payload.note, undefined, 'no note when the scan did match');
});

test('a server-scoped query that returns nothing is still an honest empty result', async () => {
  // Primary path (server accepted the guid) returning an empty list must not be
  // confused with the fallback case, and must not trigger the fallback note.
  const api = async (method, apiPath, opts) => {
    if (apiPath === '/api/v1/chat/query') {
      return { status: 200, data: [{ guid: `any;-;${TARGET}`, participants: [{ address: TARGET }] }] };
    }
    if (apiPath === '/api/v1/message/query') {
      assert.ok(opts.body.chatGuid, 'must stay on the scoped query');
      return { status: 200, data: [] };
    }
    throw new Error(`unexpected ${apiPath}`);
  };
  const bb = await load({ api });

  await bb.cmdMessages([TARGET], { json: true });
  assert.equal(bb.out[0].messages.length, 0);
  assert.equal(bb.out[0].note, undefined);
});
