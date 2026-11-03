import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { run, sandbox } from './run.js';

async function withStore(fn) {
  const box = sandbox();
  const le = (words, opts = {}) =>
    run(words, { root: box.root, ...opts, env: { HOME: box.home, LOOSE_ENDS_FILE: box.store, ...(opts.env || {}) } });
  try {
    await fn(le, box);
  } finally {
    box.cleanup();
  }
}

const ids = (r) => r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')[0]);

test('--help and -h print usage and exit 0', async () => {
  for (const words of [['--help'], ['-h'], ['help'], ['done', '--help']]) {
    const r = await run(words);
    is(r.exitCode, 0, words.join(' '));
    ok(r.stdout.startsWith('loose-ends — a plain to-do list'), 'usage on stdout');
    is(r.stderr, '');
  }
});

test('an empty store lists nothing and exits 0', async () => {
  await withStore(async (le) => {
    const r = await le([]);
    is(r.exitCode, 0);
    is(r.stdout, '');
  });
});

test('add prints a slug id, and a repeated title gets a suffix', async () => {
  await withStore(async (le, box) => {
    is((await le(['add', 'Call', 'the', 'bank', '-s', 'about the card', '-t', 'outlook, slack'])).stdout, 'le-call-the-bank\n');
    is((await le(['add', 'Call the bank'])).stdout, 'le-call-the-bank-2\n');
    const store = JSON.parse(fs.readFileSync(box.store, 'utf8'));
    is(store.version, 1);
    is(store.tasks[0].summary, 'about the card');
    is(store.tasks[0].skills, ['outlook', 'slack']);
    is(fs.readdirSync(box.root).filter((f) => f.endsWith('.tmp')), []);
  });
});

test('ls prints id<TAB>title with tags, and --json the raw items', async () => {
  await withStore(async (le) => {
    await le(['add', 'Call the bank', '-t', 'outlook']);
    is((await le(['ls'])).stdout, 'le-call-the-bank\tCall the bank  [outlook]\n');
    const json = JSON.parse((await le(['ls', '--json'])).stdout);
    is(json.length, 1);
    is(json[0].title, 'Call the bank');
  });
});

test('-d - reads the detail from stdin', async () => {
  await withStore(async (le) => {
    await le(['add', 'Brief me']);
    await le(['edit', 'brief', '-d', '-'], { stdin: 'line one\nline two\n' });
    is(JSON.parse((await le(['show', 'brief-me', '--json'])).stdout).detail, 'line one\nline two');
  });
});

test('an ambiguous prefix exits 1, names the matches and changes nothing', async () => {
  await withStore(async (le, box) => {
    await le(['add', 'Call the bank']);
    await le(['add', 'Call mom']);
    const before = fs.readFileSync(box.store, 'utf8');
    const r = await le(['done', 'call']);
    is(r.exitCode, 1);
    ok(r.stderr.includes('le-call-the-bank') && r.stderr.includes('le-call-mom'), r.stderr);
    is(fs.readFileSync(box.store, 'utf8'), before);
  });
});

test('done hides an item, ls --done lists it, reopen brings it back', async () => {
  await withStore(async (le) => {
    await le(['add', 'Call the bank']);
    await le(['add', 'Call mom']);
    is((await le(['done', 'call-the-bank'])).stdout, 'le-call-the-bank\n');
    is(ids(await le(['ls'])), ['le-call-mom']);
    is(ids(await le(['ls', '--done'])), ['le-call-the-bank']);
    await le(['reopen', 'le-call-the-bank']);
    is(ids(await le(['ls'])), ['le-call-the-bank', 'le-call-mom']);
  });
});

test('done with one unknown id among several changes nothing', async () => {
  await withStore(async (le) => {
    await le(['add', 'Call mom']);
    is((await le(['done', 'call-mom', 'nope'])).exitCode, 1);
    is(ids(await le(['ls'])), ['le-call-mom']);
  });
});

test('snooze hides until 09:00 local time, wake ends it', async () => {
  await withStore(async (le, box) => {
    await le(['add', 'Call mom']);
    is((await le(['snooze', 'call-mom', 'tomorrow'])).exitCode, 0);
    is(ids(await le(['ls'])), []);
    is(ids(await le(['ls', '--snoozed'])), ['le-call-mom']);
    const until = new Date(JSON.parse(fs.readFileSync(box.store, 'utf8')).tasks[0].snoozedUntil);
    is([until.getHours(), until.getMinutes()], [9, 0]);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    is(until.getDate(), tomorrow.getDate());
    await le(['wake', 'call-mom']);
    is(ids(await le(['ls'])), ['le-call-mom']);
  });
});

test('snooze understands weekdays, +Nd, +Nw and dates, and refuses the rest with exit 2', async () => {
  await withStore(async (le, box) => {
    await le(['add', 'Call mom']);
    const at = async (when) => {
      is((await le(['snooze', 'call-mom', when])).exitCode, 0, when);
      return new Date(JSON.parse(fs.readFileSync(box.store, 'utf8')).tasks[0].snoozedUntil);
    };
    const mon = await at('monday');
    is(mon.getDay(), 1);
    ok(mon.getTime() > Date.now(), 'next monday is in the future');
    const plus3 = new Date();
    plus3.setDate(plus3.getDate() + 3);
    is((await at('+3d')).getDate(), plus3.getDate());
    const plus2w = new Date();
    plus2w.setDate(plus2w.getDate() + 14);
    is((await at('+2w')).getDate(), plus2w.getDate());
    const date = await at('2099-03-04');
    is([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()], [2099, 2, 4, 9]);
    const bad = await le(['snooze', 'call-mom', 'someday']);
    is(bad.exitCode, 2);
    ok(bad.stderr.includes("can't read the time"), bad.stderr);
  });
});

test('an expired snooze counts as open again', async () => {
  await withStore(async (le, box) => {
    fs.writeFileSync(
      box.store,
      JSON.stringify({ tasks: [{ id: 'le-old', title: 'Old', created: '2026-10-01T00:00:00Z', snoozedUntil: '2026-10-02T07:00:00Z' }] })
    );
    is(ids(await le(['ls'])), ['le-old']);
  });
});

test('rm deletes for good; unknown ids exit 1; unknown commands exit 2', async () => {
  await withStore(async (le) => {
    await le(['add', 'Call mom']);
    is((await le(['rm', 'call-mom'])).stdout, 'le-call-mom\n');
    is(ids(await le(['ls', '-a'])), []);
    is((await le(['show', 'nope'])).exitCode, 1);
    const r = await le(['frobnicate']);
    is(r.exitCode, 2);
    ok(r.stderr.includes("try 'loose-ends --help'"), r.stderr);
  });
});

test('a store that is not JSON exits 1 and is left alone', async () => {
  await withStore(async (le, box) => {
    fs.writeFileSync(box.store, '{ nope');
    const r = await le(['add', 'x']);
    is(r.exitCode, 1);
    ok(r.stderr.includes('not valid JSON'), r.stderr);
    is(fs.readFileSync(box.store, 'utf8'), '{ nope');
  });
});

test('add stamps the filing cone from SLICC_AGENT, else from a SLICC 6 TMPDIR', async () => {
  await withStore(async (le, box) => {
    await le(['add', 'Seven'], { env: { SLICC_AGENT: 'cone:cone-2' } });
    await le(['add', 'Six'], { env: { TMPDIR: '/tmp/cone-helix/scoop-a' } });
    await le(['add', 'Mac']);
    const tasks = JSON.parse(fs.readFileSync(box.store, 'utf8')).tasks;
    is(tasks.map((t) => t.cone), ['cone-2', 'cone-helix', undefined]);
  });
});

test('monday prints open items in the source protocol shape', async () => {
  await withStore(async (le) => {
    await le(['add', 'Call mom', '-s', 'about Sunday']);
    await le(['add', 'Later', '--snooze', '2099-01-01']);
    const items = JSON.parse((await le(['monday', '--limit', '5'])).stdout);
    is(items.length, 1);
    is([items[0].id, items[0].source, items[0].body], ['le-call-mom', 'loose-ends', 'about Sunday']);
  });
});

test('the store defaults to $XDG_DATA_HOME, then ~/.local/share, then %LOCALAPPDATA% on Windows', async () => {
  const box = sandbox();
  try {
    is((await run(['path'], { root: box.root, env: { HOME: '/h' } })).stdout, '/h/.local/share/loose-ends/loose-ends.json\n');
    is((await run(['path'], { root: box.root, env: { HOME: '/h', XDG_DATA_HOME: '/x' } })).stdout, '/x/loose-ends/loose-ends.json\n');
    const win = await run(['path'], { root: box.root, platform: 'win32', env: { USERPROFILE: 'C:/u', LOCALAPPDATA: '/appdata' } });
    is(win.stdout, `${path.join('/appdata', 'loose-ends', 'loose-ends.json')}\n`);
  } finally {
    box.cleanup();
  }
});

test('a SLICC 6 store at /shared/loose-ends.json is used until the default store exists', async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.root, 'shared'), { recursive: true });
    fs.writeFileSync(
      path.join(box.root, 'shared', 'loose-ends.json'),
      JSON.stringify({ updated: '2026-10-28T10:29:56.737Z', tasks: [{ id: 'le-six', title: 'From six', created: '2026-10-27T10:18:47.053Z', skills: [], cone: 'cone' }] })
    );
    const env = { HOME: box.home };
    is((await run(['path'], { root: box.root, env })).stdout, '/shared/loose-ends.json\n');
    is(ids(await run(['ls'], { root: box.root, env })), ['le-six']);
    const own = path.join(box.home, '.local', 'share', 'loose-ends', 'loose-ends.json');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, '{"tasks":[]}');
    is((await run(['path'], { root: box.root, env })).stdout, `${own}\n`);
  } finally {
    box.cleanup();
  }
});
