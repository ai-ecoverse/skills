/* thread-poll.jsh: writes data/threads.json ONLY when the content changed,
   atomically, and survives bb failures without killing the loop or losing the
   last good file.

   Evaluates the FENCED "THREAD-POLL CORE" block of the poller (never the whole
   script: loading it starts the loop) against a fake `bb` and a scratch
   directory under /tmp. The shared module is injected the way the script
   require()s it.

     cd skills/github-dashboard && tst tests/thread-poll.test.js
     GHD_THREAD_POLL=/path/to/thread-poll.jsh tst tests/thread-poll.test.js */
const { default: test, is, ok } = require('tst');
const crypto = require('crypto');
const { fs, paths, fenced, sharedModule } = require('./thread-helpers.js');

let CORE = null;
function core() {
  if (CORE) return CORE;
  const src = fs.readFileSync(paths.poll(), 'utf8');
  const block = fenced(src, '---- 8< THREAD-POLL CORE', '---- >8 end THREAD-POLL CORE', paths.poll());
  CORE = new Function('shared', block + '\nreturn { parseArgs, projectsFrom, canonicalJson, runOnce, loop, readLastGood, summaryLine };')(sharedModule());
  return CORE;
}

// Measured 2026-09-25: one fs.promises.rename on this VFS takes ~1.5 s (writeFile
// ~60 ms), so a test that writes a few times needs more than tst's 5 s default.
const SLOW = { timeout: 60000 };
const DIR = '/tmp/ghd-threads-tst';
let seq = 0;
function scratch() {
  const d = `${DIR}/t${++seq}`;
  fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(d)) fs.unlinkSync(`${d}/${f}`);
  const config = { version: 1, repos: [{ slug: 'octocat/hello-world', bbProject: 'proj_example01' }, { slug: 'octocat/spoon-knife', bbProject: 'proj_example02' }] };
  fs.writeFileSync(`${d}/config.json`, JSON.stringify(config));
  return d;
}

const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const raw = (id, over) => ({
  id, projectId: 'proj_example01', title: `Example ${id} (#101)`, status: 'idle', archivedAt: null, deletedAt: null,
  updatedAt: T0 - 3600e3, queuedWork: 'none', hasPendingInteraction: false,
  activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  visibility: 'visible', environmentBranchName: `bb/example-${id}`, ...over,
});

/** A fake bb: per project, a list, or { fail } / { throws } / { text } / { hang }. */
function fakeBb(plan) {
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    const m = cmd.match(/--project (\S+)/);
    const p = plan[m && m[1]];
    if (p === undefined) return { exitCode: 1, stdout: '', stderr: 'bb: project_not_found' };
    if (p.throws) throw new Error(p.throws);
    if (p.fail) return { exitCode: p.fail, stdout: '', stderr: '\u001b[31mbb:\u001b[0m transport failure' };
    if (p.hang) return new Promise(() => {});
    if (p.text !== undefined) return { exitCode: 0, stdout: p.text, stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify(p), stderr: '' };
  };
  return { exec, calls };
}

/** Node fs with the two write calls counted. */
function spyFs() {
  const ops = [];
  return {
    ops,
    promises: {
      readFile: (...a) => fs.promises.readFile(...a),
      writeFile: (p, t) => { ops.push(['writeFile', p]); return fs.promises.writeFile(p, t); },
      rename: (a, b) => { ops.push(['rename', a, b]); return fs.promises.rename(a, b); },
    },
  };
}

function ctxFor(dir, bb, over) {
  let clock = T0;
  const logs = [];
  const sleeps = [];
  const sfs = spyFs();
  const ctx = {
    exec: bb.exec,
    fs: sfs,
    sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    now: () => (clock += 1000),
    sleep: async (ms) => { sleeps.push(ms); },
    log: (l) => logs.push(l),
    opts: { out: `${dir}/threads.json`, config: `${dir}/config.json`, intervalMs: 60000, limit: 200, runs: 0, stats: null, bbTimeoutMs: 200, ...over },
  };
  return { ctx, logs, sleeps, ops: sfs.ops };
}
const writes = (ops) => ops.filter((o) => o[0] === 'rename').length;

const PLAN_A = () => ({
  proj_example01: [raw('thr_example01'), raw('thr_example02', { status: 'active' }), raw('thr_example03', { archivedAt: T0 - 7200e3 })],
  proj_example02: [raw('thr_example11', { projectId: 'proj_example02', status: 'error' })],
});

test('P1 first run writes: live threads only, keyed by id, state fields only, tmp then rename, no tmp left', async () => {
  const d = scratch();
  const { ctx, ops } = ctxFor(d, fakeBb(PLAN_A()));
  const st = { last: null, running: false };
  const r = await core().runOnce(ctx, st);
  is(r.ok, true);
  is(r.wrote, true);
  const f = JSON.parse((await fs.promises.readFile(`${d}/threads.json`, 'utf8')));
  is(JSON.stringify(Object.keys(f.threads).sort()), JSON.stringify(['thr_example01', 'thr_example02', 'thr_example11']), 'archived thr_example03 is not in the file');
  is(JSON.stringify(Object.keys(f.threads.thr_example01).sort()), JSON.stringify(['archived', 'busy', 'hasPendingInteraction', 'live', 'project', 'queuedWork', 'state', 'updatedAt']));
  is(f.threads.thr_example02.busy, true, 'status "active" is busy');
  is(f.threads.thr_example11.state, 'error');
  ok(/^[0-9a-f]{64}$/.test(f.contentHash), 'sha256 content hash');
  ok(typeof f.generatedAt === 'string', 'generatedAt');
  is(JSON.stringify(ops.map((o) => o[0])), JSON.stringify(['writeFile', 'rename']), 'write the tmp, then rename it');
  is(ops[0][1], `${d}/threads.json.tmp`);
  ok(!fs.existsSync(`${d}/threads.json.tmp`), 'no tmp file left behind');
}, SLOW);

test('P2 an unchanged run writes NOTHING: file byte-identical, generatedAt kept', async () => {
  const d = scratch();
  const run1 = ctxFor(d, fakeBb(PLAN_A()));
  const st = { last: null, running: false };
  await core().runOnce(run1.ctx, st);
  const before = (await fs.promises.readFile(`${d}/threads.json`, 'utf8'));
  // Same content, different listing order and key order: still unchanged.
  const plan = PLAN_A();
  plan.proj_example01.reverse();
  plan.proj_example01[0] = Object.fromEntries(Object.entries(plan.proj_example01[0]).reverse());
  const run2 = ctxFor(d, fakeBb(plan));
  const r = await core().runOnce(run2.ctx, st);
  is(r.ok, true);
  is(r.unchanged, true);
  is(r.wrote, false);
  is(writes(run2.ops), 0, 'no write, no rename');
  is((await fs.promises.readFile(`${d}/threads.json`, 'utf8')), before, 'byte-identical');
}, SLOW);

test('P3 a changed thread state writes, with a new hash', async () => {
  const d = scratch();
  const st = { last: null, running: false };
  await core().runOnce(ctxFor(d, fakeBb(PLAN_A())).ctx, st);
  const h1 = JSON.parse((await fs.promises.readFile(`${d}/threads.json`, 'utf8'))).contentHash;
  const plan = PLAN_A();
  plan.proj_example01[1] = raw('thr_example02', { status: 'idle', updatedAt: T0 });
  const run = ctxFor(d, fakeBb(plan));
  const r = await core().runOnce(run.ctx, st);
  is(r.wrote, true);
  const f = JSON.parse((await fs.promises.readFile(`${d}/threads.json`, 'utf8')));
  ok(f.contentHash !== h1, 'hash moved');
  is(f.threads.thr_example02.busy, false, 'settled now');
}, SLOW);

test('P4 one project FAILS (exit 1, throw, bad JSON, wrong shape, timeout): logged, its threads carried forward, nothing else lost', async () => {
  for (const bad of [{ fail: 1 }, { throws: 'realm died' }, { text: '<html>' }, { text: '{"nope":1}' }, { hang: true }]) {
    const d = scratch();
    const st = { last: null, running: false };
    await core().runOnce(ctxFor(d, fakeBb(PLAN_A())).ctx, st);
    const before = (await fs.promises.readFile(`${d}/threads.json`, 'utf8'));
    const plan = PLAN_A();
    plan.proj_example02 = bad;
    const run = ctxFor(d, fakeBb(plan));
    const r = await core().runOnce(run.ctx, st);
    const what = JSON.stringify(bad);
    is(r.ok, true, `${what}: the run still completes`);
    ok(r.errors.some((e) => e.startsWith('proj_example02: ')), `${what}: error logged (${r.errors.join(' | ')})`);
    is(JSON.stringify(r.carried), JSON.stringify(['proj_example02']), `${what}: carried forward`);
    is(writes(run.ops), 0, `${what}: nothing changed elsewhere, so nothing written`);
    is((await fs.promises.readFile(`${d}/threads.json`, 'utf8')), before, `${what}: last good file intact`);
    // And a change in the healthy project still lands, WITH the failed one's threads.
    plan.proj_example01[1] = raw('thr_example02', { status: 'idle', updatedAt: T0 });
    const run2 = ctxFor(d, fakeBb(plan));
    const r2 = await core().runOnce(run2.ctx, st);
    is(r2.wrote, true, `${what}: healthy project's change written`);
    const f = JSON.parse((await fs.promises.readFile(`${d}/threads.json`, 'utf8')));
    ok(f.threads.thr_example11 && f.threads.thr_example11.state === 'error', `${what}: failed project's thread kept`);
  }
}, SLOW);

test('P5 EVERY project fails: no write, the file survives, and the loop keeps running', async () => {
  const d = scratch();
  const st = { last: null, running: false };
  await core().runOnce(ctxFor(d, fakeBb(PLAN_A())).ctx, st);
  const before = (await fs.promises.readFile(`${d}/threads.json`, 'utf8'));
  // Run 1 fails everywhere, run 2 recovers with a change, run 3 is unchanged.
  const changed = PLAN_A();
  changed.proj_example01[1] = raw('thr_example02', { status: 'idle', updatedAt: T0 });
  const plans = [{ proj_example01: { fail: 1 }, proj_example02: { throws: 'x' } }, changed, changed];
  let n = 0;
  const bb = { exec: (cmd) => fakeBb(plans[Math.min(n, 2)]).exec(cmd) };
  const h = ctxFor(d, bb, { runs: 3 });
  let afterFail = null;
  h.ctx.onRun = async () => { n++; if (n === 1) afterFail = await fs.promises.readFile(`${d}/threads.json`, 'utf8'); };
  const ran = await core().loop(h.ctx, st, null);
  is(ran, 3, 'three runs: a failure did not end the loop');
  is(afterFail, before, 'after the failed run: file byte-identical');
  ok(/^run 1: FAILED .*nothing written/.test(h.logs[0]), h.logs[0]);
  ok(/every project failed/.test(h.logs[0]), 'says why');
  ok(/^run 2: ok .*WROTE/.test(h.logs[1]), h.logs[1]);
  ok(/^run 3: ok .*unchanged/.test(h.logs[2]), h.logs[2]);
  is(writes(h.ops), 1, 'exactly one write across the three runs');
}, SLOW);

test('P6 runs never overlap: a re-entrant run is refused; the next run waits for the current one', async () => {
  const d = scratch();
  let release;
  const gate = new Promise((res) => { release = res; });
  const plan = PLAN_A();
  const bb = { exec: async (cmd) => { await gate; return fakeBb(plan).exec(cmd); } };
  const h = ctxFor(d, bb);
  const st = { last: null, running: false };
  const first = core().runOnce(h.ctx, st);
  const second = await core().runOnce(h.ctx, st);
  is(second.skipped, true, 'second run refused while the first is in flight');
  release();
  const r = await first;
  is(r.ok, true);
  is(st.running, false, 'guard released');
  // The loop sleeps interval minus the run's own duration: start-to-start, never overlapping.
  const h2 = ctxFor(scratch(), fakeBb(PLAN_A()), { runs: 2 });
  await core().loop(h2.ctx, { last: null, running: false }, null);
  is(h2.sleeps.length, 1);
  ok(h2.sleeps[0] > 0 && h2.sleeps[0] < 60000, `slept ${h2.sleeps[0]} ms after a run`);
}, SLOW);

test('P7 a restart reads the last good file: an unchanged first run writes nothing', async () => {
  const d = scratch();
  await core().runOnce(ctxFor(d, fakeBb(PLAN_A())).ctx, { last: null, running: false });
  const last = await core().readLastGood(fs, `${d}/threads.json`);
  ok(last && last.contentHash, 'last good file read back');
  const h = ctxFor(d, fakeBb(PLAN_A()));
  const r = await core().runOnce(h.ctx, { last, running: false });
  is(r.unchanged, true);
  is(writes(h.ops), 0);
  is(await core().readLastGood(fs, `${d}/nope.json`), null, 'absent file: no last good content');
}, SLOW);

test('P8 the bb call is the fetcher\'s loadThreads call; --out is required; odd project ids never reach the shell', async () => {
  const d = scratch();
  const bb = fakeBb(PLAN_A());
  await core().runOnce(ctxFor(d, bb).ctx, { last: null, running: false });
  is(JSON.stringify(bb.calls), JSON.stringify([
    'bb thread list --project proj_example01 --limit 200 --include-hidden --json',
    'bb thread list --project proj_example02 --limit 200 --include-hidden --json',
  ]));
  let threw = null;
  try { core().parseArgs(['--interval-ms', '60000']); } catch (e) { threw = e.message; }
  ok(threw && /--out/.test(threw), `no --out: ${threw}`);
  is(core().parseArgs(['--out', '/tmp/x.json']).intervalMs, 60000, 'default interval 60 s');
  is(core().parseArgs(['--out', '/tmp/x.json']).limit, 200, 'default limit 200');
  const pj = core().projectsFrom({ repos: [{ slug: 'o/a', bbProject: 'proj_example01' }, { slug: 'o/b', bbProject: 'proj_example01' }, { slug: 'o/c', bbProject: 'proj_x; rm -rf /' }, { slug: 'o/d', bbProject: null }] });
  is(JSON.stringify(pj.projects), JSON.stringify([{ project: 'proj_example01', repos: ['o/a', 'o/b'] }]), 'deduped, nulls skipped');
  is(JSON.stringify(pj.refused), JSON.stringify(['proj_x; rm -rf /']), 'refused, not executed');
}, SLOW);

test('P9 quiet log: unchanged runs fold into one line per --summary-every; writes and failures are logged at once', async () => {
  const d = scratch();
  const h = ctxFor(d, fakeBb(PLAN_A()), { runs: 7, summaryEvery: 3 });
  await core().loop(h.ctx, { last: null, running: false }, null);
  is(h.logs.length, 3, `one WROTE line + two summaries for six unchanged runs: ${JSON.stringify(h.logs)}`);
  ok(/^run 1: ok .*WROTE/.test(h.logs[0]), h.logs[0]);
  ok(/^runs 2-4: 3 unchanged, wall min [\d.]+s avg [\d.]+s max [\d.]+s/.test(h.logs[1]), h.logs[1]);
  ok(/^runs 5-7: 3 unchanged/.test(h.logs[2]), h.logs[2]);
  is(core().parseArgs(['--out', '/tmp/x.json']).summaryEvery, 30, 'default: one line per 30 unchanged runs (30 min)');
}, SLOW);
