import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';
import { readScript } from './script.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.resolve(here, '../scripts');
const requireReal = createRequire(path.join(scripts, 'support-args.js'));
const aura = requireReal('./sfhelp-aura.js');
const messenger = requireReal('./intercom-messenger.js');
const args = requireReal('./support-args.js');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const CASE_NUMBER = '400000003';
const CASE_ID = '500000000000003AAA';
const CONV = '215470000000001';

function exitError(code, message = `exit ${code}`) {
  const err = new Error(message);
  err.name = 'NodeExitError';
  err.code = code;
  return err;
}

function conversation(messages, { open = true, canReply = open } = {}) {
  return { id: CONV, open, canReply, messages };
}

const user = (text) => ({ isUser: true, from: 'You', text });
const fin = (text) => ({ isUser: false, from: 'Fin', text });

function fakes({
  replies = [],
  resolve = CASE_ID,
  current = conversation([user('earlier')]),
} = {}) {
  const sent = [];
  const queue = [...replies];
  const sf = {
    async resolveCaseId(ref) {
      sent.push(['resolveCaseId', ref]);
      return resolve;
    },
    async addComment(caseId, html) {
      sent.push(['addComment', caseId, html]);
      return { isSuccess: true, caseComment: { id: '00a000000000001AAA' } };
    },
  };
  const ic = {
    async start(text) {
      sent.push(['start', text]);
      return { conversation_id: CONV };
    },
    async reply(id, text) {
      sent.push(['reply', id, text]);
      return { conversation_id: id };
    },
    async conversation(id) {
      sent.push(['conversation', id]);
      return current;
    },
    async waitForReply(id, opts) {
      sent.push(['waitForReply', id, opts.afterCount]);
      const next = queue.shift();
      if (!next) throw new Error('waitForReply called more often than scripted');
      return next;
    },
  };
  return { sf, ic, sent };
}

async function runCommand(file, argv, { sf, ic, stdin = '' } = {}) {
  const stdout = [];
  const outs = [];
  const tab = { targetId: 'TAB-1' };
  const stubs = {
    'sliccy:browser': {
      findTab: async () => tab,
      evalAsync: async () => {
        throw new Error('the page is faked at the client level in this suite');
      },
    },
    'sliccy:cli': {
      die: (message, opts = {}) => {
        throw exitError(opts.exitCode ?? 1, String(message));
      },
      help: (text) => {
        stdout.push(text);
        throw exitError(0);
      },
      out: (value) => {
        outs.push(value);
      },
    },
    'sliccy:color': new Proxy({}, { get: () => (s) => String(s) }),
    './sfhelp-aura.js': { ...aura, makeClient: () => sf },
    './intercom-messenger.js': { ...messenger, makeClient: () => ic },
    './support-args.js': args,
    fs: { readFileSync: (fd) => (fd === 0 ? stdin : requireReal('fs').readFileSync(fd)) },
  };
  const requireStub = (id) => {
    if (id in stubs) return stubs[id];
    throw new Error(`unexpected require(${id})`);
  };
  const proc = {
    argv: ['node', path.join(scripts, file), ...argv],
    env: {},
    exit: (code) => {
      throw exitError(code ?? 0);
    },
  };
  const consoleStub = {
    log: (...a) => stdout.push(a.join(' ')),
    error: (...a) => stdout.push(a.join(' ')),
    warn: (...a) => stdout.push(a.join(' ')),
  };
  const body = readScript(path.join(scripts, file));
  const fn = new AsyncFunction('require', 'process', 'console', body);
  let code = 0;
  let message = '';
  try {
    await fn(requireStub, proc, consoleStub);
  } catch (err) {
    if (err?.name !== 'NodeExitError') throw err;
    code = err.code;
    message = err.message;
  }
  return { code, message, text: stdout.join('\n'), outs };
}

const sends = (sent) => sent.filter(([kind]) => ['start', 'reply', 'addComment'].includes(kind));

test('messenger client: start posts the text as blocks to the new-message endpoint', async () => {
  const calls = [];
  const client = messenger.makeClient(async (src) => {
    calls.push(src);
    return { ok: true, value: { conversation_id: CONV } };
  });
  const r = await client.start('Hello <Fin>\n\nSecond paragraph');
  is(r, { conversation_id: CONV });
  is(calls.length, 1);
  const req = JSON.parse(/\)\((\{[\s\S]*\})\)$/.exec(calls[0])[1]);
  is(req.path, '/messenger/web/messages');
  is(JSON.parse(req.params.blocks), messenger.textToBlocks('Hello <Fin>\n\nSecond paragraph'));
  ok(
    JSON.parse(req.params.blocks).every((b) => !String(b.text).includes('<Fin>')),
    'markup is escaped'
  );
  ok(/^[0-9a-f-]{36}$/.test(req.params.client_assigned_uuid), req.params.client_assigned_uuid);
  is(req.params.self_serve_suggestions_match, 'false');
});

test('messenger client: reply posts to the conversation reply endpoint and refuses a bad id before sending', async () => {
  const calls = [];
  const client = messenger.makeClient(async (src) => {
    calls.push(src);
    return { ok: true, value: { conversation_id: CONV } };
  });
  await client.reply(CONV, 'Please create the case.');
  const req = JSON.parse(/\)\((\{[\s\S]*\})\)$/.exec(calls[0])[1]);
  is(req.path, `/messenger/web/conversations/${CONV}/reply`);
  is(JSON.parse(req.params.blocks), messenger.textToBlocks('Please create the case.'));
  let caught = null;
  try {
    await client.reply('1; drop', 'x');
  } catch (err) {
    caught = err;
  }
  ok(caught && caught.code === 'usage', String(caught));
  is(calls.length, 1, 'nothing was sent for the bad id');
});

test('slack-support create without --confirm previews, exits 3 and sends nothing', async () => {
  const f = fakes();
  const r = await runCommand(
    'slack-support',
    ['create', '--subject=Login loop', '--severity=2', 'The', 'app', 'logs', 'me', 'out'],
    f
  );
  is(r.code, 3);
  ok(r.text.includes('Subject: Login loop'), r.text);
  ok(r.text.includes('The app logs me out'), r.text);
  ok(r.text.includes('Nothing sent'), r.text);
  is(f.sent, []);
});

test('slack-support create --confirm: Fin opens the case, then the description is posted verbatim', async () => {
  const f = fakes({
    replies: [
      conversation([user('opening'), fin(`Thanks! Case #${CASE_NUMBER} has been opened for you.`)]),
    ],
  });
  const description = 'Line one with <b>markup</b>\n\nLine two & more';
  const r = await runCommand(
    'slack-support',
    ['create', '--subject=Login loop', '--severity=2', '--confirm', '--json', '-'],
    {
      ...f,
      stdin: `${description}\n`,
    }
  );
  is(r.code, 0, r.message);
  is(sends(f.sent), [
    [
      'start',
      `I'd like to open a support case (Severity 2). Subject: Login loop\n\n${description}`,
    ],
    ['addComment', CASE_ID, aura.textToCommentHtml(`Login loop\n\n${description}`)],
  ]);
  ok(
    f.sent.some(([k, ref]) => k === 'resolveCaseId' && ref === CASE_NUMBER),
    JSON.stringify(f.sent)
  );
  is(r.outs, [
    {
      caseNumber: CASE_NUMBER,
      caseId: CASE_ID,
      link: `${aura.ORIGIN}/s/case-view?caseId=${CASE_ID}`,
      conversationId: CONV,
      commentId: '00a000000000001AAA',
    },
  ]);
});

test('slack-support create --confirm nudges Fin past live chat, and --no-comment skips the comment', async () => {
  const f = fakes({
    replies: [
      conversation([user('opening'), fin('Would you like to chat with a support engineer?')]),
      conversation([
        user('opening'),
        fin('Would you like to chat?'),
        user('nudge'),
        fin(`Done: case number ${CASE_NUMBER}.`),
      ]),
    ],
  });
  const r = await runCommand(
    'slack-support',
    ['create', '--subject=S', '--severity=4', '--confirm', '--no-comment', 'details'],
    f
  );
  is(r.code, 0, r.message);
  const kinds = sends(f.sent).map(([k]) => k);
  is(kinds, ['start', 'reply']);
  ok(/prefer a case/.test(sends(f.sent)[1][2]), 'the reply is the nudge');
  is(
    f.sent.filter(([k]) => k === 'waitForReply').map(([, , after]) => after),
    [1, 3]
  );
  ok(r.text.includes(`case #${CASE_NUMBER} opened`), r.text);
});

test('slack-support create --confirm exits 1 and posts no comment when Fin names no case', async () => {
  const f = fakes({
    replies: [
      conversation([user('opening'), fin('I can help with that here instead.')], { open: false }),
    ],
  });
  const r = await runCommand(
    'slack-support',
    ['create', '--subject=S', '--severity=3', '--confirm', 'details'],
    f
  );
  is(r.code, 1);
  is(
    sends(f.sent).map(([k]) => k),
    ['start']
  );
  ok(r.text.includes(`intercom read ${CONV}`), r.text);
});

test('slack-support create rejects a missing subject, severity or description with exit 2', async () => {
  for (const argv of [
    ['create', '--severity=2', '--confirm', 'x'],
    ['create', '--subject=S', '--confirm', 'x'],
    ['create', '--subject=S', '--severity=2', '--confirm'],
  ]) {
    const f = fakes();
    const r = await runCommand('slack-support', argv, f);
    is(r.code, 2, argv.join(' '));
    is(f.sent, [], argv.join(' '));
  }
});

test('slack-support comment previews with exit 3, and posts the text with --confirm', async () => {
  const preview = fakes();
  const p = await runCommand('slack-support', ['comment', CASE_NUMBER, 'Any', 'update?'], preview);
  is(p.code, 3);
  is(sends(preview.sent), []);
  const f = fakes();
  const r = await runCommand(
    'slack-support',
    ['comment', CASE_NUMBER, 'Any', 'update?', '--confirm'],
    f
  );
  is(r.code, 0, r.message);
  is(sends(f.sent), [['addComment', CASE_ID, aura.textToCommentHtml('Any update?')]]);
});

test('slack-support: a malformed --confirm is a usage error, never a send', async () => {
  const f = fakes();
  const r = await runCommand('slack-support', ['comment', CASE_NUMBER, 'hi', '--confirm=maybe'], f);
  is(r.code, 2);
  is(sends(f.sent), []);
});

test('intercom new and reply preview with exit 3 and send nothing', async () => {
  for (const argv of [
    ['new', 'Hello', 'there'],
    ['reply', CONV, 'Hello'],
  ]) {
    const f = fakes();
    const r = await runCommand('intercom', argv, f);
    is(r.code, 3, argv.join(' '));
    ok(r.text.includes('Nothing sent'), r.text);
    is(f.sent, [], argv.join(' '));
  }
});

test('intercom new --confirm --wait starts a conversation and returns the answers', async () => {
  const f = fakes({ replies: [conversation([user('Hello there'), fin('Hi! How can I help?')])] });
  const r = await runCommand(
    'intercom',
    ['new', 'Hello', 'there', '--confirm', '--wait=30', '--json'],
    f
  );
  is(r.code, 0, r.message);
  is(sends(f.sent), [['start', 'Hello there']]);
  is(
    f.sent.find(([k]) => k === 'waitForReply'),
    ['waitForReply', CONV, 1]
  );
  is(r.outs[0].conversationId, CONV);
  is(
    r.outs[0].replies.map((m) => m.text),
    ['Hi! How can I help?']
  );
});

test('intercom reply --confirm sends to an open conversation, and refuses a closed one', async () => {
  const f = fakes({ current: conversation([user('a'), fin('b')]) });
  const r = await runCommand('intercom', ['reply', CONV, 'Thanks', '--confirm'], f);
  is(r.code, 0, r.message);
  is(sends(f.sent), [['reply', CONV, 'Thanks']]);
  const closed = fakes({ current: conversation([user('a')], { open: false }) });
  const c = await runCommand('intercom', ['reply', CONV, 'Thanks', '--confirm'], closed);
  is(c.code, 1);
  ok(c.message.includes('closed to replies'), c.message);
  is(sends(closed.sent), []);
});
