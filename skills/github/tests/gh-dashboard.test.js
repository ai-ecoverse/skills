import fs from 'node:fs';
import test, { is, ok } from 'tst';
import { runGh, scratchDir } from './gh-local-harness.js';

// `gh dashboard update|show|clear` against a scratch reports file under /tmp
// (--file), never the live /shared/sprinkles/github-dashboard/data/reports.json.
// Reads go through the async fs, which is what gh.jsh writes with.

const KEY = 'octocat/Hello-World#1';
const BB_URL = 'https://example.getbb.app/projects/proj_example01/threads/thr_example01';

async function setup(label) {
  const dir = await scratchDir(label);
  return { dir, file: `${dir}/reports.json` };
}
const dash = (s, args, extra = {}) => runGh(['dashboard', ...args, '--file', s.file], extra);
// Each successful write costs about a second: the VFS rename takes its write
// lock and persists metadata. Tests that write several times get room for it.
const T = { timeout: 30000 };
const readJson = async (file) => JSON.parse(await fs.readFile(file));
async function exists(file) {
  return fs.exists(file);
}

test('key must be owner/repo#N; anything else is a usage error and writes nothing', T, async () => {
  const s = await setup('dash-key');
  const good = await dash(s, ['update', KEY, '--status', 'working']);
  is(good.code, 0, good.err);
  ok(Object.hasOwn((await readJson(s.file)).reports, KEY));

  const bad = [
    'octocat/Hello-World',
    'octocat#1',
    'Hello-World#1',
    'octocat/Hello-World#0',
    'octocat/Hello-World#x',
    'octocat/Hello-World#1#2',
    '.octocat/Hello-World#1',
    'https://github.com/octocat/Hello-World/pull/1',
  ];
  const before = await fs.readFile(s.file);
  for (const key of bad) {
    const r = await dash(s, ['update', key, '--status', 'working']);
    is(r.code, 1, `${key}: ${r.err}`);
    ok(/invalid key/.test(r.err) && /usage: gh dashboard update/.test(r.err), `${key}: ${r.err}`);
  }
  const none = await dash(s, ['update', '--status', 'working']);
  is(none.code, 1);
  ok(/<owner\/repo#N> required/.test(none.err), none.err);
  for (const sub of ['show', 'clear']) {
    const r = await dash(s, [sub, 'octocat/Hello-World']);
    is(r.code, 1, `${sub}: ${r.err}`);
    ok(/invalid key/.test(r.err), r.err);
  }
  is(await fs.readFile(s.file), before, 'rejected keys leave the file byte-identical');
});

test('--thread: a URL with a thr_ path segment is bb, a bare name is a scoop', T, async () => {
  const s = await setup('dash-thread');
  const bb = await dash(s, ['update', KEY, '--thread', BB_URL, '--json']);
  is(bb.code, 0, bb.err);
  is(JSON.parse(bb.out).thread, { kind: 'bb', id: 'thr_example01', url: BB_URL });

  // No host is special: any https origin works, and the id may sit mid-path.
  const other = 'https://bb.example.invalid/t/thr_abc123/messages?x=1';
  const bb2 = await dash(s, ['update', KEY, '--thread', other, '--json']);
  is(bb2.code, 0, bb2.err);
  is(JSON.parse(bb2.out).thread, { kind: 'bb', id: 'thr_abc123', url: other });

  for (const name of ['ghd-report-scoop', 'scoop_1', 'Worker2']) {
    const r = await dash(s, ['update', KEY, '--thread', name, '--json']);
    is(r.code, 0, `${name}: ${r.err}`);
    is(JSON.parse(r.out).thread, { kind: 'scoop', name });
  }
});

test('--thread: a bare thr_ id, a URL without thr_ and other shapes are rejected', T, async () => {
  const s = await setup('dash-thread-bad');
  const bare = await dash(s, ['update', KEY, '--thread', 'thr_example01']);
  is(bare.code, 1);
  ok(/bare bb thread id/.test(bare.err) && /thread URL/.test(bare.err), bare.err);

  const cases = [
    ['https://example.getbb.app/projects/proj_example01', /no bb thread id/],
    ['https://example.getbb.app/threads/xthr_example01', /no bb thread id/],
    ['ftp://example.getbb.app/threads/thr_example01', /not an http\(s\) URL/],
    ['octocat/scoop', /neither a bb thread URL/],
    ['my scoop', /neither a bb thread URL/],
    ['-scoop', /neither a bb thread URL/],
  ];
  for (const [value, why] of cases) {
    const r = await dash(s, ['update', KEY, '--thread', value]);
    is(r.code, 1, `${value}: ${r.err}`);
    ok(why.test(r.err), `${value}: ${r.err}`);
  }
  ok(!(await exists(s.file)), 'a rejected --thread writes nothing');
});

test('--pr normalises N, #N, owner/repo#N and PR URLs to owner/repo#N', T, async () => {
  const s = await setup('dash-pr');
  const cases = [
    ['5', 'octocat/Hello-World#5'],
    ['#5', 'octocat/Hello-World#5'],
    ['octocat/Spoon-Knife#9', 'octocat/Spoon-Knife#9'],
    ['https://github.com/octocat/Spoon-Knife/pull/9', 'octocat/Spoon-Knife#9'],
    ['https://github.com/octocat/Spoon-Knife/pull/9/files', 'octocat/Spoon-Knife#9'],
  ];
  for (const [value, want] of cases) {
    const r = await dash(s, ['update', KEY, '--pr', value, '--json']);
    is(r.code, 0, `${value}: ${r.err}`);
    is(JSON.parse(r.out).pr, want, value);
  }
  for (const value of [
    'abc',
    '0',
    'https://github.com/octocat/Spoon-Knife/issues/9',
    'octocat/Spoon-Knife',
  ]) {
    const r = await dash(s, ['update', KEY, '--pr', value]);
    is(r.code, 1, `${value}: ${r.err}`);
    ok(/is not a PR reference/.test(r.err), r.err);
  }
});

test('updates merge: given flags overwrite, the rest are kept; at is restamped', T, async () => {
  const s = await setup('dash-merge');
  const first = await dash(s, [
    'update',
    KEY,
    '--status',
    'working',
    '--thread',
    BB_URL,
    '--pr',
    '2',
    '--note',
    'first pass',
  ]);
  is(first.code, 0, first.err);
  is(
    first.out,
    `✓ ${KEY}: status working, thread bb:thr_example01, pr octocat/Hello-World#2, note "first pass" (at ${(await readJson(s.file)).reports[KEY].at})`,
    'one-line confirmation of what is recorded'
  );
  const at1 = (await readJson(s.file)).reports[KEY].at;
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at1), at1);

  const second = await dash(s, ['update', KEY, '--note', 'waiting on review', '--json']);
  is(second.code, 0, second.err);
  const e = JSON.parse(second.out);
  is(e.status, 'working');
  is(e.thread, { kind: 'bb', id: 'thr_example01', url: BB_URL });
  is(e.pr, 'octocat/Hello-World#2');
  is(e.note, 'waiting on review');
  ok(e.at >= at1);

  const third = await dash(s, ['update', KEY, '--status', 'needs-attention', '--json']);
  const e3 = JSON.parse(third.out);
  is(
    [e3.status, e3.note, e3.pr],
    ['needs-attention', 'waiting on review', 'octocat/Hello-World#2']
  );
  is(Object.keys(e3), ['status', 'thread', 'pr', 'note', 'at', 'history']);
  is(
    e3.history.map((h) => Object.keys(h).filter((k) => k !== 'at')),
    [['status', 'thread', 'pr', 'note'], ['note'], ['status']]
  );
  is(e3.history[0].thread, 'bb:thr_example01', 'history entries are compact');

  const stored = await readJson(s.file);
  is(stored.reports[KEY], e3, '--json prints exactly the stored entry');

  const other = await dash(s, ['update', 'octocat/Hello-World#2', '--status', 'done']);
  is(other.code, 0, other.err);
  is(Object.keys((await readJson(s.file)).reports).sort(), [KEY, 'octocat/Hello-World#2']);
  is((await readJson(s.file)).reports[KEY], e3, 'another key leaves this entry alone');

  const nothing = await dash(s, ['update', KEY]);
  is(nothing.code, 1);
  ok(/nothing to record/.test(nothing.err), nothing.err);
  const badStatus = await dash(s, ['update', KEY, '--status', 'busy']);
  is(badStatus.code, 1);
  ok(
    /--status must be one of working, needs-attention, done, clear/.test(badStatus.err),
    badStatus.err
  );
});

test('history keeps the last 20 updates', T, async () => {
  const s = await setup('dash-history');
  // Seed 19 steps directly (one write, no rename cost), then cross the cap.
  const seeded = Array.from({ length: 19 }, (_, i) => ({
    at: '2026-01-01T00:00:00.000Z',
    note: `step ${i + 1}`,
  }));
  const seed = {
    status: 'working',
    thread: null,
    pr: null,
    note: 'step 19',
    at: '2026-01-01T00:00:00.000Z',
    history: seeded,
  };
  await fs.writeFile(
    s.file,
    `${JSON.stringify({ version: 1, reports: { [KEY]: seed } }, null, 2)}\n`
  );
  const r20 = await dash(s, ['update', KEY, '--note', 'step 20', '--json']);
  is(r20.code, 0, r20.err);
  is(JSON.parse(r20.out).history.length, 20, 'exactly at the cap, nothing dropped yet');
  is(JSON.parse(r20.out).history[0].note, 'step 1');
  const r21 = await dash(s, ['update', KEY, '--note', 'step 21']);
  is(r21.code, 0, r21.err);
  const e = (await readJson(s.file)).reports[KEY];
  is(e.history.length, 20);
  is(e.history[0].note, 'step 2', 'the oldest step is dropped');
  is(e.history[19].note, 'step 21');
  is(e.note, 'step 21');

  const long = 'x'.repeat(300);
  const r = await dash(s, ['update', KEY, '--note', long, '--json']);
  const e2 = JSON.parse(r.out);
  is(e2.note, long, 'the entry keeps the whole note');
  is(e2.history[19].note.length, 120, 'the history copy is truncated');
  is(e2.history.length, 20);
});

test('clear and --status clear delete the entry; clearing nothing is a no-op', T, async () => {
  const s = await setup('dash-clear');
  await dash(s, ['update', KEY, '--status', 'working']);
  await dash(s, ['update', 'octocat/Hello-World#2', '--status', 'done']);

  const c = await dash(s, ['clear', KEY]);
  is(c.code, 0, c.err);
  is(c.out, `✓ ${KEY}: report cleared`);
  is(Object.keys((await readJson(s.file)).reports), ['octocat/Hello-World#2']);

  const viaStatus = await dash(s, ['update', 'octocat/Hello-World#2', '--status', 'clear']);
  is(viaStatus.code, 0, viaStatus.err);
  is((await readJson(s.file)).reports, {});

  const before = await fs.readFile(s.file);
  const again = await dash(s, ['clear', KEY]);
  is(again.code, 0);
  ok(/nothing to clear/.test(again.out), again.out);
  is(await fs.readFile(s.file), before);

  const mixed = await dash(s, ['update', KEY, '--status', 'clear', '--note', 'x']);
  is(mixed.code, 1);
  ok(/cannot go with it/.test(mixed.err), mixed.err);

  const fresh = await setup('dash-clear-absent');
  const absent = await dash(fresh, ['clear', KEY]);
  is(absent.code, 0);
  ok(!(await exists(fresh.file)), 'clearing on an absent file does not create it');
});

test('show lists every report, one report with history, and --json', T, async () => {
  const s = await setup('dash-show');
  const empty = await dash(s, ['show']);
  is(empty.code, 0, empty.err);
  ok(/No reports/.test(empty.out));
  is(JSON.parse((await dash(s, ['show', '--json'])).out), {});

  await dash(s, ['update', KEY, '--status', 'working', '--thread', 'ghd-report-scoop']);
  await dash(s, ['update', 'octocat/Spoon-Knife#3', '--status', 'done', '--pr', '4']);
  const all = await dash(s, ['show']);
  is(all.code, 0, all.err);
  const lines = all.out.split('\n');
  ok(lines[0].startsWith(`${KEY}: status working, thread scoop:ghd-report-scoop`), lines[0]);
  ok(lines[1].startsWith('octocat/Spoon-Knife#3: status done, pr octocat/Spoon-Knife#4'), lines[1]);
  ok(/2 reports/.test(lines[2]), lines[2]);

  const stored = await readJson(s.file);
  is(JSON.parse((await dash(s, ['show', '--json'])).out), stored.reports);
  is(JSON.parse((await dash(s, ['show', KEY, '--json'])).out), stored.reports[KEY]);
  const one = await dash(s, ['show', KEY]);
  ok(one.out.split('\n').length === 2, 'summary line plus one history line');

  const missing = await dash(s, ['show', 'octocat/Hello-World#99']);
  is(missing.code, 1);
  ok(/no report for octocat\/Hello-World#99/.test(missing.err), missing.err);
});

test(
  'the write is whole-file JSON via a sibling temp and rename, and leaves no temp',
  T,
  async () => {
    const s = await setup('dash-atomic');
    const renames = [];
    const wrapped = {
      ...fs,
      rename: async (from, to) => {
        renames.push([from, to]);
        return fs.rename(from, to);
      },
    };
    const r = await dash(s, ['update', KEY, '--status', 'working'], { fs: wrapped });
    is(r.code, 0, r.err);
    is(renames.length, 1);
    ok(renames[0][0].startsWith(`${s.file}.tmp-`), `temp is a sibling: ${renames[0][0]}`);
    is(renames[0][1], s.file);
    const raw = await fs.readFile(s.file);
    const data = JSON.parse(raw);
    is(raw, `${JSON.stringify(data, null, 2)}\n`, 'pretty-printed, newline-terminated');
    is(data.version, 1);
    is(Object.keys(data), ['version', 'reports']);
    is(await fs.readdir(s.dir), ['reports.json'], 'no temp file left behind');
  }
);

test('a failed write leaves the previous file byte-identical and removes the temp', T, async () => {
  const s = await setup('dash-fail');
  await dash(s, ['update', KEY, '--status', 'working']);
  const before = await fs.readFile(s.file);

  const renameFails = {
    ...fs,
    rename: async () => {
      throw new Error('simulated rename failure');
    },
  };
  const r1 = await dash(s, ['update', KEY, '--status', 'done'], { fs: renameFails });
  is(r1.code, 1);
  ok(/could not install the update/.test(r1.err) && /is unchanged/.test(r1.err), r1.err);

  const tornTemp = {
    ...fs,
    readFile: async (p, ...rest) => {
      const text = await fs.readFile(p, ...rest);
      return p.includes('.tmp-') ? text.slice(0, 10) : text;
    },
  };
  const r2 = await dash(s, ['update', KEY, '--status', 'done'], { fs: tornTemp });
  is(r2.code, 1);
  ok(/could not stage the update/.test(r2.err), r2.err);

  is(await fs.readFile(s.file), before);
  is(await fs.readdir(s.dir), ['reports.json']);
});

test('a concurrent update between read and rename is merged, not clobbered', T, async () => {
  const s = await setup('dash-race');
  await dash(s, ['update', KEY, '--status', 'working']);
  let reads = 0;
  const racy = {
    ...fs,
    readFile: async (p, ...rest) => {
      if (p === s.file && ++reads === 2) {
        // Another agent's update lands after this run read the file and
        // before it renames its temp into place.
        const other = JSON.parse(await fs.readFile(s.file));
        other.reports['octocat/Spoon-Knife#7'] = { status: 'done', note: 'written concurrently' };
        await fs.writeFile(s.file, `${JSON.stringify(other, null, 2)}\n`);
      }
      return fs.readFile(p, ...rest);
    },
  };
  const r = await dash(s, ['update', KEY, '--note', 'mine'], { fs: racy });
  is(r.code, 0, r.err);
  const data = await readJson(s.file);
  is(data.reports['octocat/Spoon-Knife#7'], { status: 'done', note: 'written concurrently' });
  is(data.reports[KEY].note, 'mine');
  is(data.reports[KEY].status, 'working');
  is(await fs.readdir(s.dir), ['reports.json']);
});

test('a malformed reports file is refused with exit 2 and left alone', T, async () => {
  const s = await setup('dash-bad');
  for (const text of [
    '{"version": 1, "reports": {',
    '{"version": 2, "reports": {}}',
    '{"version": 1, "reports": []}',
  ]) {
    await fs.writeFile(s.file, text);
    const r = await dash(s, ['update', KEY, '--status', 'working']);
    is(r.code, 2, `${text}: ${r.err}`);
    ok(/is not a valid reports file/.test(r.err), r.err);
    is(await fs.readFile(s.file), text);
  }
});

test('gh dashboard needs no GitHub token and refuses a missing data directory', T, async () => {
  const s = await setup('dash-token');
  const r = await dash(s, ['update', KEY, '--status', 'working']);
  is(r.code, 0, r.err);
  is(r.tokenCalls.length, 0, 'local-only: no token lookup');
  is(r.calls.length, 0, 'no GitHub call');

  const nowhere = { file: `${s.dir}/missing-dir/reports.json` };
  const r2 = await dash(nowhere, ['update', KEY, '--status', 'working']);
  is(r2.code, 1);
  ok(/does not exist/.test(r2.err), r2.err);

  const help = await runGh(['dashboard', '--help']);
  is(help.code, 0);
  for (const verb of ['gh dashboard update', 'gh dashboard show', 'gh dashboard clear']) {
    ok(help.out.includes(verb), verb);
  }
});
