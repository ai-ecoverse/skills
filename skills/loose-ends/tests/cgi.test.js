import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { parseCgi, run, SCRIPT, sandbox } from './run.js';

async function withStore(fn) {
  const box = sandbox();
  fs.writeFileSync(
    box.store,
    JSON.stringify({
      tasks: [
        { id: 'le-call-mom', title: 'Call mom', created: '2026-11-01T10:00:00Z', skills: [] },
        {
          id: 'le-call-the-bank',
          title: 'Call the bank',
          created: '2026-11-01T11:00:00Z',
          skills: [],
        },
      ],
    })
  );
  const request = async (
    action,
    { method = 'POST', body, type = 'application/json', env = {}, socket = true } = {}
  ) => {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const r = await run(['cgi', action], {
      root: box.root,
      stdin: text,
      socket,
      env: {
        HOME: box.home,
        LOOSE_ENDS_FILE: box.store,
        GATEWAY_INTERFACE: 'CGI/1.1',
        REQUEST_METHOD: method,
        CONTENT_TYPE: type,
        CONTENT_LENGTH: String(Buffer.byteLength(text, 'utf8')),
        ...env,
      },
    });
    is(r.exitCode, 0, `cgi ${action} exits 0`);
    return { ...parseCgi(r.stdout), spawned: r.spawned };
  };
  try {
    await fn(request, box);
  } finally {
    box.cleanup();
  }
}

const stored = (box) => JSON.parse(fs.readFileSync(box.store, 'utf8')).tasks;

test('GET items answers 200 JSON with the marker header', async () => {
  await withStore(async (request) => {
    const r = await request('items', { method: 'GET' });
    is(r.status, 200);
    is(r.headers['content-type'], 'application/json');
    is(r.headers['x-loose-ends'], '2');
    is(
      r.body.tasks.map((t) => t.id),
      ['le-call-mom', 'le-call-the-bank']
    );
  });
});

test('POST done writes the store first and answers with the new items', async () => {
  await withStore(async (request, box) => {
    const r = await request('done', { body: { id: 'call-mom' } });
    is(r.status, 200);
    is(r.body.id, 'le-call-mom');
    ok(stored(box)[0].done, 'done is in the store');
    ok(r.body.tasks[0].done, 'and in the answer');
  });
});

test('reopen, snooze and wake change the store', async () => {
  await withStore(async (request, box) => {
    await request('done', { body: { id: 'le-call-mom' } });
    await request('reopen', { body: { id: 'le-call-mom' } });
    is(stored(box)[0].done, undefined);
    await request('snooze', { body: { id: 'le-call-mom', when: 'tomorrow' } });
    is(new Date(stored(box)[0].snoozedUntil).getHours(), 9);
    await request('wake', { body: { id: 'le-call-mom' } });
    is(stored(box)[0].snoozedUntil, undefined);
  });
});

test('the body is read as exactly CONTENT_LENGTH bytes, never to EOF', async () => {
  await withStore(async (request, box) => {
    const r = await request('done', { body: { id: 'le-call-mom' } });
    is(r.status, 200, JSON.stringify(r.body));
    ok(stored(box)[0].done, 'done');
  });
});

test('a multibyte body is counted in bytes', async () => {
  await withStore(async (request, box) => {
    const r = await request('snooze', {
      body: { id: 'le-call-the-bank', when: 'tomorrow', note: 'Grüße' },
    });
    is(r.status, 200, JSON.stringify(r.body));
    ok(stored(box)[1].snoozedUntil, 'snoozed');
  });
});

test('a hostile cross-site form submission changes nothing', async () => {
  await withStore(async (request, box) => {
    const before = fs.readFileSync(box.store, 'utf8');
    const hostile = {
      HTTP_ORIGIN: 'https://attacker.example',
      HTTP_SEC_FETCH_SITE: 'cross-site',
      HTTP_HOST: 'localhost:8080',
    };
    const form = { body: 'id=call-mom', type: 'application/x-www-form-urlencoded' };
    is((await request('done', { ...form, env: hostile })).status, 403);
    is(
      (await request('done', { ...form, env: { HTTP_SEC_FETCH_SITE: 'cross-site' } })).status,
      403
    );
    is(
      (
        await request('done', {
          ...form,
          env: { HTTP_ORIGIN: 'https://attacker.example', HTTP_HOST: 'localhost:8080' },
        })
      ).status,
      403
    );
    is(
      (
        await request('done', {
          ...form,
          env: { HTTP_ORIGIN: 'null', HTTP_HOST: 'localhost:8080' },
        })
      ).status,
      403
    );
    is((await request('done', form)).status, 415);
    is((await request('done', { body: 'id=call-mom', type: 'text/plain' })).status, 415);
    is(
      (await request('snooze', { body: { id: 'call-mom', when: 'tomorrow' }, env: hostile }))
        .status,
      403
    );
    is(fs.readFileSync(box.store, 'utf8'), before, 'the store is untouched');
  });
});

test('a same-origin JSON request with Origin and Sec-Fetch-Site still works', async () => {
  await withStore(async (request, box) => {
    const env = {
      HTTP_ORIGIN: 'http://localhost:8080',
      HTTP_HOST: 'localhost:8080',
      HTTP_SEC_FETCH_SITE: 'same-origin',
    };
    const r = await request('done', {
      body: { id: 'call-the-bank' },
      type: 'application/json; charset=utf-8',
      env,
    });
    is(r.status, 200, JSON.stringify(r.body));
    ok(stored(box)[1].done, 'done');
  });
});

test('wrong method, unknown action, unknown and ambiguous ids, bad times and bad JSON get HTTP errors and change nothing', async () => {
  await withStore(async (request, box) => {
    const before = fs.readFileSync(box.store, 'utf8');
    is((await request('done', { method: 'GET' })).status, 405);
    is((await request('items', { body: {} })).status, 405);
    is((await request('frobnicate', { body: {} })).status, 404);
    is((await request('done', { body: { id: 'nope' } })).status, 404);
    const amb = await request('done', { body: { id: 'call' } });
    is(amb.status, 409);
    is(amb.body.ok, false);
    is((await request('done', { body: {} })).status, 400);
    is((await request('snooze', { body: { id: 'le-call-mom', when: 'someday' } })).status, 400);
    is((await request('done', { body: '{nope' })).status, 400);
    is(fs.readFileSync(box.store, 'utf8'), before);
  });
});

test('after a change it tells the owner with agent send --lick=sprinkle, argv only', async () => {
  await withStore(async (request) => {
    const quiet = await request('done', { body: { id: 'le-call-mom' } });
    is(quiet.spawned, []);
    const told = await request('reopen', {
      body: { id: 'le-call-mom' },
      env: { SLICC_OWNER: 'cone' },
    });
    is(told.spawned.length, 1);
    is(told.spawned[0].cmd, 'agent');
    is(told.spawned[0].args, ['send', 'cone', '--lick=sprinkle', '--source', 'loose-ends', '-']);
    is(told.spawned[0].input, 'reopen le-call-mom: Call mom');
    const hostile = await request('done', {
      body: { id: 'le-call-mom' },
      env: { SLICC_OWNER: 'cone; rm -rf ~' },
    });
    is(hostile.spawned, []);
  });
});

test('sprinkle installs the panel and a cgi-bin/ that runs this script for this store', async () => {
  const box = sandbox();
  try {
    const dir = path.join(box.home, 'sprinkles', 'loose-ends');
    const store = path.join(box.root, "it's store.json");
    const r = await run(['sprinkle'], {
      root: box.root,
      env: { HOME: box.home, LOOSE_ENDS_FILE: store },
    });
    is(r.exitCode, 0, r.stderr);
    const html = fs.readFileSync(path.join(dir, 'loose-ends.shtml'), 'utf8');
    ok(html.includes(`content="${store}"`), 'store path in the panel');
    ok(!html.includes('__STORE__'), 'no placeholder left');
    is(fs.readdirSync(path.join(dir, 'cgi-bin')).sort(), [
      'done',
      'items',
      'reopen',
      'snooze',
      'wake',
    ]);
    const done = fs.readFileSync(path.join(dir, 'cgi-bin', 'done'), 'utf8');
    ok(done.startsWith('#!/bin/sh\n'), 'a sh script');
    ok(done.includes(`LOOSE_ENDS_FILE='${store.replace(/'/g, "'\\''")}'`), 'store quoted for sh');
    ok(done.includes(`exec jsh '${SCRIPT}' cgi done`), 'runs this script with jsh');
    ok(done.includes(`exec node '${SCRIPT}' cgi done`), 'or with node');
  } finally {
    box.cleanup();
  }
});

test('sprinkle replaces an old single-file loose-ends panel, and nothing else', async () => {
  const box = sandbox();
  try {
    const sprinkles = path.join(box.home, 'sprinkles');
    fs.mkdirSync(sprinkles, { recursive: true });
    fs.writeFileSync(
      path.join(sprinkles, 'loose-ends.shtml'),
      '<meta name="loose-ends-store" content="/x">'
    );
    const r = await run(['sprinkle'], {
      root: box.root,
      env: { HOME: box.home, LOOSE_ENDS_FILE: box.store },
    });
    ok(r.stdout.includes('removed'), r.stdout);
    ok(!fs.existsSync(path.join(sprinkles, 'loose-ends.shtml')), 'old file removed');
    fs.writeFileSync(path.join(sprinkles, 'loose-ends.shtml'), '<title>someone else</title>');
    await run(['sprinkle'], {
      root: box.root,
      env: { HOME: box.home, LOOSE_ENDS_FILE: box.store },
    });
    ok(fs.existsSync(path.join(sprinkles, 'loose-ends.shtml')), 'a foreign file is kept');
  } finally {
    box.cleanup();
  }
});
