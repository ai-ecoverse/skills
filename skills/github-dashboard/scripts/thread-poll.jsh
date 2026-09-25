// thread-poll.jsh: refresh bb thread STATE for the github-dashboard panel,
// once a minute, into a small file the panel overlays on its snapshot.
//
// USAGE
//   thread-poll.jsh --out <path/threads.json> [--config <config.json>]
//                   [--interval-ms 60000] [--limit 200] [--runs N] [--once]
//                   [--stats <path.jsonl>] [--summary-every 30] [--bb-timeout-ms 120000]
//   --out is REQUIRED (no default), so a dry run can never write the live file
//   by accident. --runs N stops after N runs; --once is --runs 1. --stats
//   appends one JSON line per run (timings, wrote/unchanged, errors).
//   --summary-every N folds N unchanged runs into one log line (1 = every run).
//
// WHY THIS EXISTS. The full cycle (poll.jsh -> fetch-snapshot.mjs) runs every
// ~34 minutes, and it is the only thing that reads bb. So a card whose agent
// thread settled waited up to one cycle to move. bb has no tight rate limit
// (operator, 2026-09-25), so this reads ONLY the thread list, every 60 s, and
// the panel overlays the result. It never links: which thread belongs to
// which card stays the fetcher's decision.
//
// WHY .jsh AND NOT .mjs. It is a long-lived loop that jshd runs directly as a
// unit (jshd starts .jsh files; an .mjs would need a .jsh wrapper, as
// poll.jsh is for the fetcher: two files and a child process per minute for no
// gain). sliccy:exec is asynchronous, so a slow bb call never blocks the timer,
// and the fetcher's cp.execSync has no equivalent to recover from here.
//
// WHAT ONE RUN DOES
//   1. reads the config (every run, so a repo added with `gh monitor add` is
//      picked up without a restart); projects are repos[].bbProject, deduped;
//   2. per project, sequentially: `bb thread list --project <id> --limit 200
//      --include-hidden --json`, the fetcher's loadThreads call. Sequential
//      because measured: two in parallel took 32.5 s against 26.4 s one after
//      the other (each call ~13 s, however small the answer);
//   3. keeps the LIVE threads (not archived, not deleted) with the record
//      fields categorisation needs (threadStateOf, from the shared module);
//   4. hashes the content WITHOUT timestamps and writes the file only when the
//      hash moved: tmp file, then rename (fs.promises; a rename on this VFS was
//      measured at ~1.5 s, a writeFile at ~60 ms, so a write costs ~1.6 s).
//
// FAILURE POLICY. A failed project (non-zero exit, a throw, a timeout,
// unparseable or wrongly shaped JSON) is logged and its threads are CARRIED
// FORWARD from the last good content, so one bad bb call changes nothing on
// disk. If every project fails there is nothing to write and the last good file
// stays. The loop never exits on a failure; runs never overlap: the next run is
// scheduled only after the current one ends (start-to-start `interval`, or at
// once if a run took longer than that), and a re-entrant call is refused.
const exec = require('sliccy:exec');
const fs = require('fs');
const crypto = require('crypto');
const shared = require('./thread-stage-shared.cjs');

/* ---- 8< THREAD-POLL CORE ----------------------------------------------------
   Everything the tests exercise. Pure apart from what ctx injects (exec, fs,
   sha256, now, log), so tests/thread-poll.test.js evaluates THIS text against a
   fake bb and a scratch directory. */
const DEFAULTS = {
  config: '/shared/github-monitor/config.json',
  intervalMs: 60000,
  limit: 200,
  bbTimeoutMs: 120000,
  summaryEvery: 30,
};

function parseArgs(argv) {
  const o = { out: null, config: DEFAULTS.config, intervalMs: DEFAULTS.intervalMs, limit: DEFAULTS.limit, runs: 0, stats: null, bbTimeoutMs: DEFAULTS.bbTimeoutMs, summaryEvery: DEFAULTS.summaryEvery };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === '--out') o.out = v();
    else if (a === '--config') o.config = v();
    else if (a === '--interval-ms') o.intervalMs = Number(v());
    else if (a === '--limit') o.limit = Number(v());
    else if (a === '--runs') o.runs = Number(v());
    else if (a === '--once') o.runs = 1;
    else if (a === '--stats') o.stats = v();
    else if (a === '--bb-timeout-ms') o.bbTimeoutMs = Number(v());
    else if (a === '--summary-every') o.summaryEvery = Number(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.out) throw new Error('--out <path> is required');
  if (!(o.intervalMs >= 1000)) throw new Error('--interval-ms must be >= 1000');
  if (!(o.limit >= 1)) throw new Error('--limit must be >= 1');
  return o;
}

/** repos[].bbProject -> [{ project, repos }], deduped, nulls skipped. An id is
    interpolated into a shell command, so anything but proj_<alnum> is refused. */
function projectsFrom(config) {
  const byId = new Map();
  const refused = [];
  for (const r of (config && Array.isArray(config.repos) ? config.repos : [])) {
    const p = r && r.bbProject;
    if (!p) continue;
    if (!/^proj_[A-Za-z0-9]+$/.test(p)) {
      refused.push(p);
      continue;
    }
    if (!byId.has(p)) byId.set(p, []);
    byId.get(p).push(r.slug || null);
  }
  return { projects: [...byId].map(([project, repos]) => ({ project, repos })), refused };
}

/** JSON with object keys sorted, so the hash depends on content, not order. */
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** One project's thread list. Never throws: { ok, threads } or { ok:false, error }. */
async function listProject(ctx, project) {
  const t0 = ctx.now();
  const cmd = `bb thread list --project ${project} --limit ${ctx.opts.limit} --include-hidden --json`;
  try {
    const r = await withTimeout(Promise.resolve(ctx.exec(cmd)), ctx.opts.bbTimeoutMs, 'bb thread list');
    const ms = ctx.now() - t0;
    const code = r && r.exitCode !== undefined && r.exitCode !== null ? r.exitCode : 0;
    if (code !== 0) {
      const why = String((r && (r.stderr || r.stdout)) || '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 200);
      return { ok: false, ms, error: `exit ${code}: ${why || '(no output)'}` };
    }
    let data;
    try {
      data = JSON.parse(String((r && r.stdout) || ''));
    } catch (err) {
      return { ok: false, ms, error: `unparseable JSON: ${String(err.message).slice(0, 120)}` };
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.threads) ? data.threads : null;
    if (!list) return { ok: false, ms, error: 'JSON is neither an array nor { threads: [...] }' };
    return { ok: true, ms, threads: list };
  } catch (err) {
    return { ok: false, ms: ctx.now() - t0, error: `threw: ${String((err && err.message) || err).slice(0, 200)}` };
  }
}

/** The file's content, minus the timestamp and hash that wrap it. */
function contentFor(results, last, limit) {
  const projects = {};
  const threads = {};
  const carried = [];
  for (const res of results) {
    const p = res.project;
    if (res.ok) {
      const live = res.threads.filter((t) => t && t.id && shared.threadIsLive(t));
      projects[p] = { repos: res.repos, listed: res.threads.length, live: live.length, atLimit: res.threads.length >= limit };
      for (const t of live) threads[t.id] = Object.assign(shared.threadStateOf(t), { project: p });
    } else if (last && last.projects && last.projects[p]) {
      carried.push(p);
      projects[p] = last.projects[p];
      for (const [id, e] of Object.entries(last.threads || {})) if (e && e.project === p) threads[id] = e;
    }
  }
  return { content: { projects, threads }, carried };
}

async function readLastGood(fsx, path) {
  try {
    const f = JSON.parse(await fsx.promises.readFile(path, 'utf8'));
    if (f && f.threads && typeof f.threads === 'object' && typeof f.contentHash === 'string') return f;
  } catch (err) {
    /* absent or unreadable: no last good content */
  }
  return null;
}

/** tmp file, then rename. ASYNC on purpose: in jsh the *Sync calls go through
    a sync-fs mirror that flushes later, and a flush failure is only printed
    (measured 2026-09-25: "[sync-fs] ERROR: flush failed ... EACCES ... unlink
    <out>.tmp" on the first real run), never thrown, so a failed write could not
    be told from a good one. fs.promises reaches the VFS directly and rejects. */
async function writeAtomic(fsx, path, text) {
  const tmp = `${path}.tmp`;
  await fsx.promises.writeFile(tmp, text);
  await fsx.promises.rename(tmp, path);
}

/** One run. state = { last (parsed file or null), running }. Never throws. */
async function runOnce(ctx, state) {
  if (state.running) return { skipped: true };
  state.running = true;
  const t0 = ctx.now();
  const out = { startedAt: new Date(t0).toISOString(), ok: false, wrote: false, unchanged: false, errors: [], perProjectMs: {}, carried: [] };
  try {
    let config;
    try {
      config = JSON.parse(await ctx.fs.promises.readFile(ctx.opts.config, 'utf8'));
    } catch (err) {
      out.errors.push(`config ${ctx.opts.config} unreadable: ${String(err.message).slice(0, 160)}`);
      return out;
    }
    const { projects, refused } = projectsFrom(config);
    for (const p of refused) out.errors.push(`refused bbProject ${JSON.stringify(p)}: not proj_<alnum>`);
    if (!projects.length) {
      out.errors.push('no bbProject mapped in the config: nothing to poll');
      return out;
    }
    const results = [];
    for (const { project, repos } of projects) {
      const res = await listProject(ctx, project);
      out.perProjectMs[project] = res.ms;
      if (!res.ok) out.errors.push(`${project}: ${res.error}`);
      results.push(Object.assign({ project, repos }, res));
    }
    if (!results.some((r) => r.ok)) {
      out.errors.push('every project failed: nothing written, the last good file stays');
      return out;
    }
    const { content, carried } = contentFor(results, state.last, ctx.opts.limit);
    out.carried = carried;
    const hash = ctx.sha256(canonicalJson(content));
    out.hash = hash;
    out.threads = Object.keys(content.threads).length;
    out.ok = true;
    if (state.last && state.last.contentHash === hash) {
      out.unchanged = true;
      return out;
    }
    const file = {
      version: 1,
      generatedAt: new Date(ctx.now()).toISOString(),
      contentHash: hash,
      hashAlgorithm: 'sha256 over the canonical JSON (sorted keys) of { projects, threads }; generatedAt is excluded, so an unchanged run writes nothing',
      writtenBy: 'thread-poll.jsh',
      scope: 'LIVE threads only (not archived, not deleted) from `bb thread list --project <id> --limit <n> --include-hidden --json` per mapped project. State only: links are the snapshot\'s. A thread absent here keeps the snapshot\'s state.',
      projects: content.projects,
      threads: content.threads,
    };
    try {
      await writeAtomic(ctx.fs, ctx.opts.out, JSON.stringify(file, null, 1) + '\n');
    } catch (err) {
      out.ok = false;
      out.errors.push(`write ${ctx.opts.out} failed: ${String(err.message).slice(0, 160)}`);
      return out;
    }
    state.last = file;
    out.wrote = true;
    return out;
  } finally {
    out.ms = ctx.now() - t0;
    state.running = false;
  }
}

function summaryLine(n, r) {
  if (r.skipped) return `run ${n}: skipped, the previous run is still going`;
  const per = Object.entries(r.perProjectMs || {}).map(([p, ms]) => `${p} ${(ms / 1000).toFixed(1)}s`).join(', ');
  const head = r.ok
    ? `run ${n}: ok in ${(r.ms / 1000).toFixed(1)}s (${per}): ${r.threads} live threads, hash ${String(r.hash).slice(0, 12)}, ${r.wrote ? 'WROTE' : 'unchanged'}`
    : `run ${n}: FAILED in ${(r.ms / 1000).toFixed(1)}s (${per || 'no bb call'}), nothing written`;
  const extra = (r.carried && r.carried.length ? ` | carried forward: ${r.carried.join(', ')}` : '') + (r.errors.length ? ` | ${r.errors.join(' | ')}` : '');
  return head + extra;
}

/** The loop. Resolves after opts.runs runs (0 = for ever).
    LOGGING: a write, a failure or a carried-forward project is logged at once;
    unchanged runs are folded into one line per opts.summaryEvery of them (with
    their wall times), because jshd keeps the whole unit log and one line a
    minute is ~200 KB a day. summaryEvery 1 (or unset) logs every run. */
async function loop(ctx, state, stats) {
  let n = 0;
  const every = ctx.opts.summaryEvery > 1 ? ctx.opts.summaryEvery : 1;
  let quiet = [];
  for (;;) {
    n += 1;
    const r = await runOnce(ctx, state);
    if (stats) stats.push(r);
    const plain = r.ok && r.unchanged && !r.errors.length && !(r.carried && r.carried.length);
    if (!plain || every === 1) ctx.log(summaryLine(n, r));
    else {
      quiet.push(r.ms);
      if (quiet.length >= every) {
        const avg = quiet.reduce((a, b) => a + b, 0) / quiet.length;
        ctx.log(`runs ${n - quiet.length + 1}-${n}: ${quiet.length} unchanged, wall min ${(Math.min(...quiet) / 1000).toFixed(1)}s avg ${(avg / 1000).toFixed(1)}s max ${(Math.max(...quiet) / 1000).toFixed(1)}s, hash ${String(r.hash).slice(0, 12)}`);
        quiet = [];
      }
    }
    if (ctx.onRun) await ctx.onRun(r, n);
    if (ctx.opts.runs > 0 && n >= ctx.opts.runs) return n;
    const wait = Math.max(0, ctx.opts.intervalMs - (r.ms || 0));
    await ctx.sleep(wait);
  }
}
/* ---- >8 end THREAD-POLL CORE ---------------------------------------------- */

const ctx = {
  exec,
  fs,
  sha256: (s) => crypto.createHash('sha256').update(s).digest('hex'),
  now: () => Date.now(),
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  opts: null,
  onRun: null,
};
try {
  ctx.opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`thread-poll: ${err.message}`);
  process.exit(2);
}
if (ctx.opts.stats) {
  ctx.onRun = async (r, n) => {
    try {
      await fs.promises.appendFile(ctx.opts.stats, JSON.stringify(Object.assign({ run: n }, r)) + '\n');
    } catch (err) {
      ctx.log(`stats append failed: ${String(err.message).slice(0, 120)}`);
    }
  };
}
const state = { last: await readLastGood(fs, ctx.opts.out), running: false };
ctx.log(
  `thread-poll starting: every ${ctx.opts.intervalMs / 1000}s, limit ${ctx.opts.limit}, config ${ctx.opts.config}, out ${ctx.opts.out}` +
    (state.last ? `, last good ${state.last.generatedAt} hash ${state.last.contentHash.slice(0, 12)}` : ', no previous file') +
    (ctx.opts.runs ? `, stopping after ${ctx.opts.runs} runs` : ''),
);
await loop(ctx, state, null);
