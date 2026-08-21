// Regression: send must fire once, treat 5xx/timeout as soft, verify the thread,
// and refuse identical re-sends. Root cause of the 2026-08-21 Anni quadruple-send:
// private_api:false returns HTTP 500 after the iMessage already left the Mac;
// agents that treated that as failure re-ran `bluebubbles send` and duplicated.
//
// Contract under test:
//   1. Exactly one POST /message/text per invocation (even on 5xx).
//   2. 5xx / timeout → status soft_*_unverified (exit path does not throw).
//   3. When the outbound text is already in-thread, status=delivered / verified.
//   4. A second send of the same text inside the dupe window is refused with
//      zero additional POSTs (unless --force).

const assert = require('node:assert/strict');
const test = require('node:test');

const { load } = require('./harness.js');

const TARGET = 'lars@trieloff.net';
const GUID = `iMessage;-;${TARGET}`;
const TEXT = 'bb-send-fire-forget self-test — ignore';

function outbound(text, ageMs = 5_000) {
  return {
    guid: `msg-${Math.random().toString(36).slice(2, 8)}`,
    text,
    isFromMe: true,
    dateCreated: Date.now() - ageMs,
    handle: { address: TARGET },
    chats: [{ guid: GUID }],
  };
}

/**
 * @param {object} opts
 * @param {number} [opts.sendStatus] HTTP status for POST /message/text (default 200)
 * @param {boolean} [opts.sendTimeout]
 * @param {object[]} [opts.thread] messages returned by message/query
 * @param {object[]} [opts.chats]
 */
function server(opts = {}) {
  const thread = opts.thread || [];
  let posts = 0;
  return {
    posts: () => posts,
    api: async (method, apiPath, o) => {
      if (apiPath === '/api/v1/chat/query') {
        return { status: 200, data: opts.chats || [{ guid: GUID, participants: [{ address: TARGET }] }] };
      }
      if (apiPath === '/api/v1/message/query') {
        // Scoped or broad — return current thread snapshot
        return { status: 200, data: thread.slice() };
      }
      if (apiPath === '/api/v1/message/text' && method === 'POST') {
        posts += 1;
        if (opts.sendTimeout) {
          const err = new Error('BlueBubbles timeout on /api/v1/message/text: timeout');
          err.status = 408;
          err.timedOut = true;
          err.soft = true;
          throw err;
        }
        const st = opts.sendStatus ?? 200;
        if (st >= 400) {
          const err = new Error(`BlueBubbles ${st} on /api/v1/message/text: boom`);
          err.status = st;
          err.soft = st >= 500;
          throw err;
        }
        // Simulate "lands after accept": push into thread so verify sees it
        if (opts.landOnAccept !== false) {
          thread.unshift(outbound(o.body.message, 500));
        }
        return { status: 200, data: { guid: 'new-msg' } };
      }
      throw new Error(`unexpected ${method} ${apiPath}`);
    },
  };
}

test('200 accept + verify → delivered, single POST', async () => {
  const srv = server({ sendStatus: 200, thread: [] });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, TEXT], { json: true });
  assert.equal(srv.posts(), 1);
  assert.equal(bb.out.length, 1);
  assert.equal(bb.out[0].status, 'delivered');
  assert.equal(bb.out[0].verified, true);
  assert.equal(bb.out[0].httpStatus, 200);
});

test('HTTP 500 after send + message visible → delivered, single POST (no retry)', async () => {
  // private_api:false shape: POST 500s but the text is already on the wire.
  // force skips the pre-send dupe guard; verify still sees the pre-seeded row.
  const thread = [outbound(TEXT, 1_000)];
  const srv = server({ sendStatus: 500, thread, landOnAccept: false });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, TEXT], { json: true, force: true });
  assert.equal(srv.posts(), 1, 'must not retry the POST on 5xx');
  assert.equal(bb.out[0].status, 'delivered');
  assert.equal(bb.out[0].verified, true);
  assert.equal(bb.out[0].soft, true);
  assert.equal(bb.out[0].httpStatus, 500);
});

test('HTTP 500 and nothing in thread → soft_5xx_unverified, does not throw', async () => {
  const srv = server({ sendStatus: 500, thread: [], landOnAccept: false });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, 'never-lands-text'], { json: true });
  assert.equal(srv.posts(), 1);
  assert.equal(bb.out[0].status, 'soft_5xx_unverified');
  assert.equal(bb.out[0].verified, false);
  assert.equal(bb.out[0].soft, true);
  assert.match(bb.out[0].note, /do NOT retry send blindly/i);
});

test('timeout → timeout_unverified, single POST', async () => {
  const srv = server({ sendTimeout: true, thread: [] });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, 'timeout-text'], { json: true });
  assert.equal(srv.posts(), 1);
  assert.equal(bb.out[0].status, 'timeout_unverified');
  assert.equal(bb.out[0].timedOut, true);
  assert.equal(bb.out[0].verified, false);
});

test('duplicate outbound text within window is refused with zero POSTs', async () => {
  const thread = [outbound(TEXT, 30_000)];
  const srv = server({ thread });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, TEXT], { json: true });
  assert.equal(srv.posts(), 0, 'must not POST when duplicate is already in thread');
  assert.equal(bb.out[0].status, 'duplicate');
  assert.equal(bb.out[0].verified, true);
  assert.match(bb.out[0].note, /--force/);
});

test('--force bypasses the duplicate guard and POSTs once', async () => {
  const thread = [outbound(TEXT, 30_000)];
  const srv = server({ sendStatus: 200, thread });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, TEXT], { json: true, force: true });
  assert.equal(srv.posts(), 1);
  assert.ok(['delivered', 'accepted_unverified'].includes(bb.out[0].status));
});

test('HTTP 400 is a hard failure (throws), no soft path', async () => {
  const srv = server({ sendStatus: 400, thread: [] });
  const bb = await load({ api: srv.api });
  await assert.rejects(
    () => bb.cmdSend([TARGET, 'bad'], { json: true }),
    (err) => err.name === 'NodeExitError' && /400/.test(err.message),
  );
  assert.equal(srv.posts(), 1);
});

test('human output on soft 5xx tells the operator to verify, not resend', async () => {
  const srv = server({ sendStatus: 503, thread: [], landOnAccept: false });
  const bb = await load({ api: srv.api });
  await bb.cmdSend([TARGET, 'human-soft'], {});
  const text = bb.text();
  assert.match(text, /soft-failed|do not resend/i);
  assert.match(text, /bluebubbles messages/);
  assert.match(text, /soft_5xx_unverified|status:/i);
});
