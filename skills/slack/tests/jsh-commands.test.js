// jsh-commands.test.js — the jsh-only paths of `slack watch`, `slack download`,
// `slack watches` / `unwatch` and `slack post --watch-command`, run through the
// shipped slack.jsh exactly as a user types them (argv in, exit status out).
//
// The script is compiled from disk as an AsyncFunction body with
// process.versions.jsh set, so JSH is true. Its I/O is injected: an in-memory fs
// with Node's semantics (node-fs.js, wrapped to record write options), a
// sliccy:browser stub whose websocket `vfs` sink is a path the test appends
// Slack frames to, a child_process stub that records each spawn, and a fetch
// stub for the download. Offline and deterministic.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { is, ok } from 'tst';
import { nodeFs } from './node-fs.js';
import { readScript } from './script.js';

const SCRIPT = fileURLToPath(new URL('../scripts/slack.jsh', import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const WS = 'E06V3987PMY';
const CH = 'D06VCE25DD1';
const ROOT = '1793799262.736699';
const SELF = 'U06V9L30T61';
const HOME = '/home/tester';
const STATE = `${HOME}/.local/state/slack`;

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.exitCode = code;
  }
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `slack <argv>` under jsh.
 * @param {string[]} argv
 * @param {object} [o]
 * @param {object} [o.api]      Slack method -> response body
 * @param {object} [o.files]    initial in-memory files
 * @param {Function} [o.during] async ({ framesPath, vfs, signal }) run while the command runs
 * @param {Function} [o.fetch]  the global fetch the download uses
 * @param {Set<number>} [o.alive] pids that process.kill(pid, 0) finds
 */
async function slack(argv, o = {}) {
  const vfs = nodeFs(o.files || {});
  const writes = [];
  const mkdirs = [];
  const opens = [];
  const reads = [];
  const renames = [];
  const p = vfs.promises;
  const fs = {
    ...vfs,
    openSync: (file, flags, mode) => {
      opens.push({ file, flags, mode });
      return 7;
    },
    closeSync: () => {},
    promises: {
      ...p,
      open: async (file) => ({
        stat: async () => ({ size: (vfs.files[file] || new Uint8Array()).length }),
        read: async (buf, off, len, pos) => {
          const src = (vfs.files[file] || new Uint8Array()).subarray(pos, pos + len);
          buf.set(src, off);
          reads.push({ pos, len: src.length });
          return { bytesRead: src.length, buffer: buf };
        },
        close: async () => {},
      }),
      writeFile: async (file, data, opts) => {
        writes.push({ file, opts });
        if (opts && opts.flag === 'wx' && file in vfs.files)
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        return p.writeFile(file, data);
      },
      rename: async (from, to) => {
        renames.push({ from, to });
        return p.rename(from, to);
      },
      mkdir: async (dir, opts) => {
        mkdirs.push({ dir, opts });
      },
      rm: async (target, opts = {}) => {
        if (opts.recursive) {
          for (const k of Object.keys(vfs.files))
            if (k === target || k.startsWith(`${target}/`)) delete vfs.files[k];
          return;
        }
        return p.rm(target, opts);
      },
    },
  };

  const calls = [];
  const spawns = [];
  const fetches = [];
  const signals = {};
  const killed = [];
  const killedAt = [];
  const stdout = [];
  const stderr = [];
  let framesPath = null;
  let readyAt = null;
  let closed = false;
  // o.tabs: the Slack tabs, in Chrome's order; findTab returns the first match.
  const tabs = o.tabs || [{ targetId: 'tab1', url: `https://app.slack.com/client/${WS}/${CH}` }];
  const hanging = new Map();
  const api = { 'auth.test': { ok: true, user_id: SELF }, ...(o.api || {}) };

  const browser = {
    async findTab(query = {}) {
      const re = query.urlMatch ? new RegExp(query.urlMatch) : null;
      return tabs.find((t) => !re || re.test(t.url)) || null;
    },
    async localStorage(_tab, key) {
      return key === 'localConfig_v2'
        ? JSON.stringify({ teams: { [WS]: { token: 'xoxc-test' }, ...(o.teams || {}) } })
        : null;
    },
    async cookie(_tab, name) {
      return name === 'd' ? 'd-cookie-value' : null;
    },
    async fetch(_tab, url, opts) {
      const method = url.replace('/api/', '');
      const params = {};
      for (const [k, v] of new URLSearchParams(opts && opts.body)) if (k !== 'token') params[k] = v;
      calls.push({ method, params });
      if (o.slowApi && method === 'users.info') await tick(o.slowApi);
      return {
        body: Object.hasOwn(api, method) ? api[method] : { ok: false, error: 'not_mocked' },
      };
    },
    websocket: {
      on: (onTab, onOpts) => ({
        filter: (selector) => ({
          forward: async (sink) => {
            framesPath = sink.path;
            calls.push({ method: 'websocket', tab: onTab, onOpts, selector, sink });
            return {
              id: 'sub-1',
              close: async () => {
                closed = true;
                return true;
              },
            };
          },
        }),
      }),
    },
  };

  // `sh` (a watch callback) closes with 0. `jsh` (a background watch) behaves as
  // o.child says: 'ready' starts and registers like a real watch, 'missing' is
  // jsh not on PATH (no pid, an `error`), 'exits' starts and dies unregistered.
  const childProcess = {
    spawn: (bin, args, opts) => {
      const handlers = {};
      const child = {
        pid: bin === 'jsh' && o.child === 'missing' ? undefined : 5151,
        on: (ev, fn) => {
          handlers[ev] = fn;
          return child;
        },
        once: (ev, fn) => child.on(ev, fn),
        unref: () => {},
      };
      spawns.push({ bin, args, opts });
      const emit = (ev, ...a) => handlers[ev] && handlers[ev](...a);
      if (bin !== 'jsh' && o.hang) {
        // A callback that never ends by itself: only a signal to its group does.
        hanging.set(child.pid, () => emit('close', null, 'SIGTERM'));
      } else if (bin !== 'jsh') {
        setTimeout(() => emit('close', 0, null), 5);
      } else if (o.child === 'missing') {
        setTimeout(
          () => emit('error', Object.assign(new Error('spawn jsh ENOENT'), { code: 'ENOENT' })),
          5
        );
      } else {
        setTimeout(() => emit('spawn'), 5);
        if (o.child === 'exits') setTimeout(() => emit('exit', 1, null), 30);
        else if (o.child === 'slow') {
          /* starts, never registers */
        } else
          setTimeout(() => {
            readyAt = Date.now();
            alive.add(5151);
            // Registers what it was asked to watch, as the real watch does.
            const thread = args.find((a) => a.startsWith('--thread='));
            vfs.files[`${STATE}/watch-5151.json`] = new TextEncoder().encode(
              entry(5151, {
                channel: args[3],
                thread_ts: thread ? thread.slice('--thread='.length) : null,
                command: args[args.length - 1],
              })
            );
            // o.concurrent: another post's watch registers at the same moment.
            if (o.concurrent)
              vfs.files[`${STATE}/watch-222.json`] = new TextEncoder().encode(o.concurrent);
          }, 60);
      }
      return child;
    },
  };

  const modules = {
    'sliccy:browser': browser,
    'sliccy:exec': {
      exec: async () => {
        throw new Error('jsh paths must not shell out through sliccy:exec');
      },
      spawn: async () => {
        throw new Error('jsh paths must not shell out through sliccy:exec');
      },
    },
    fs,
    os,
    path,
    child_process: childProcess,
  };
  const req = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id];
    throw new Error(`unexpected require(${id})`);
  };
  const alive = o.alive || new Set();
  const proc = {
    argv: ['node', SCRIPT, ...argv],
    env: { HOME, SLICC_CDP_URL: 'http://127.0.0.1:9222', ...(o.env || {}) },
    versions: { node: '24.0.0', jsh: '0.64.0' },
    pid: 4242,
    exit: (code = 0) => {
      throw new NodeExitError(code);
    },
    on: (sig, fn) => {
      signals[sig] = fn;
    },
    off: (sig) => {
      delete signals[sig];
    },
    kill: (pid, sig) => {
      if (sig === 0 || sig === undefined) {
        if (pid === 4242 || alive.has(pid)) return true;
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      killed.push({ pid, sig });
      killedAt.push(Date.now());
      if (pid < 0 && hanging.has(-pid)) hanging.get(-pid)();
      return true;
    },
  };
  const cons = {
    log: (...a) => stdout.push(a.map(String).join(' ')),
    info: (...a) => stdout.push(a.map(String).join(' ')),
    error: (...a) => stderr.push(a.map(String).join(' ')),
    warn: (...a) => stderr.push(a.map(String).join(' ')),
  };
  const fetchStub =
    o.fetch ||
    (async (url, opts) => {
      fetches.push({ url, opts });
      throw new Error('fetch was not expected');
    });
  const recordingFetch = async (url, opts) => {
    fetches.push({ url, opts });
    return fetchStub(url, opts);
  };

  const run = new AsyncFunction(
    'require',
    'process',
    'console',
    '__dirname',
    '__filename',
    'fetch',
    'Date',
    readScript(SCRIPT)
  );
  // o.fastClock: Date.now() runs a second ahead on every call, so a 20 s
  // startup timeout passes in a few polls.
  let clock = Date.now();
  const ScriptDate = o.fastClock
    ? class extends Date {
        static now() {
          clock += 1000;
          return clock;
        }
      }
    : Date;
  let exitCode = 0;
  const done = run(req, proc, cons, path.dirname(SCRIPT), SCRIPT, recordingFetch, ScriptDate).catch(
    (e) => {
      if (e && e.name === 'NodeExitError') exitCode = e.exitCode;
      else throw e;
    }
  );
  if (o.during) {
    while (!framesPath) {
      if ((await Promise.race([done.then(() => 'done'), tick(5)])) === 'done') break;
    }
    await o.during({ framesPath, vfs, signal: (sig) => signals[sig] && signals[sig](sig) });
  }
  await done;
  return {
    exitCode,
    calls,
    spawns,
    fetches,
    writes,
    mkdirs,
    opens,
    reads,
    renames,
    killed,
    killedAt,
    signals,
    vfs,
    framesPath,
    closed: () => closed,
    readyAt: () => readyAt,
    out: stdout.join('\n'),
    err: stderr.join('\n'),
  };
}

const frame = (extra) =>
  `${JSON.stringify({ type: 'message', channel: CH, user: 'U0OTHER0001', text: 'hello', ...extra })}\n`;

// ─── slack watch <channel> <command> ─────────────────────────────────────────

test('watch runs the command once per new message, with the message in SLACK_*', async () => {
  const r = await slack(
    ['--ws', WS, 'watch', CH, '--thread', ROOT, '--count', '2', 'notify "$SLACK_TEXT"'],
    {
      during: async ({ framesPath, vfs }) => {
        await vfs.promises.appendFile(
          framesPath,
          frame({ ts: '1.000001', thread_ts: ROOT, text: 'first' })
        );
        await vfs.promises.appendFile(
          framesPath,
          frame({ ts: '1.000001', thread_ts: ROOT, text: 'first' })
        );
        await vfs.promises.appendFile(
          framesPath,
          frame({ ts: '1.000002', user: SELF, text: 'mine' })
        );
        await vfs.promises.appendFile(
          framesPath,
          frame({ ts: '1.000003', subtype: 'message_changed' })
        );
        await vfs.promises.appendFile(
          framesPath,
          frame({ ts: '1.000004', text: 'second; rm -rf ~' })
        );
      },
    }
  );
  is(r.exitCode, 0);
  is(r.spawns.length, 2, 'a duplicate, our own message and an edit run nothing');
  is(r.spawns[0].bin, 'sh');
  is(
    r.spawns[0].args,
    ['-c', 'notify "$SLACK_TEXT"'],
    'the command is passed as is; the message is not in it'
  );
  const env = r.spawns[0].opts.env;
  is(
    [
      env.SLACK_WORKSPACE,
      env.SLACK_CHANNEL,
      env.SLACK_TS,
      env.SLACK_THREAD_TS,
      env.SLACK_USER,
      env.SLACK_TEXT,
    ],
    [WS, CH, '1.000001', ROOT, 'U0OTHER0001', 'first']
  );
  is(JSON.parse(env.SLACK_RAW).text, 'first');
  is(r.spawns[0].opts.env.HOME, HOME, 'the watch’s own environment is passed on');
  is(r.spawns[1].opts.env.SLACK_TEXT, 'second; rm -rf ~');
  is(r.spawns[1].opts.env.SLACK_THREAD_TS, '', 'a top-level message has no thread');
  is(r.spawns[0].opts.stdio, 'inherit');
  const sub = r.calls.find((c) => c.method === 'websocket');
  is(sub.selector, { parseAs: 'json', where: { type: 'message', channel: CH, thread_ts: ROOT } });
});

test('watch takes the command after a boolean flag, and refuses --json with a command', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, '--include-own', 'echo hi', '--count', '1'], {
    during: async ({ framesPath, vfs }) => {
      await vfs.promises.appendFile(framesPath, frame({ ts: '2.000001', user: SELF }));
    },
  });
  is(r.exitCode, 0);
  is(r.spawns.length, 1, '--include-own reports our own message');
  is(r.spawns[0].args, ['-c', 'echo hi']);
  const j = await slack(['--ws', WS, 'watch', CH, '--json', 'echo hi']);
  is(j.exitCode, 2);
  ok(j.err.includes('$SLACK_RAW'));
});

test('watch keeps frames private: a 0700 directory and a fresh 0600 file, both removed at the end', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, '--count', '1'], {
    during: async ({ framesPath, vfs }) => {
      await vfs.promises.appendFile(framesPath, frame({ ts: '3.000001' }));
    },
  });
  is(r.exitCode, 0);
  const dir = path.dirname(r.framesPath);
  ok(dir.startsWith(os.tmpdir()) && dir !== os.tmpdir(), 'its own directory under the tmpdir');
  is(r.mkdirs.find((m) => m.dir === dir).opts, { mode: 0o700 });
  is(r.writes.find((w) => w.file === r.framesPath).opts, { mode: 0o600, flag: 'wx' });
  is(
    Object.keys(r.vfs.files).filter((f) => f.startsWith(dir)),
    [],
    'frames removed'
  );
  is(
    Object.keys(r.vfs.files).filter((f) => f.startsWith(STATE)),
    [],
    'registry entry removed'
  );
  ok(r.closed(), 'subscription closed');
  ok(r.out.includes('hello'), 'without a command the message is printed');
});

test('watch ends after --for with 124 when --count was not reached, and on SIGTERM with 143', async () => {
  const t = await slack(['--ws', WS, 'watch', CH, '--for', '1s', '--count', '1']);
  is(t.exitCode, 124);
  ok(t.err.includes('No message within 1s'));
  is(Object.keys(t.vfs.files), []);

  const s = await slack(['--ws', WS, 'watch', CH], {
    during: async ({ signal }) => {
      await tick(20);
      signal('SIGTERM');
    },
  });
  is(s.exitCode, 143);
  is(Object.keys(s.vfs.files), [], 'nothing left behind');
  is(Object.keys(s.signals), [], 'signal handlers removed');
});

test('a running watch is registered for `slack watches`', async () => {
  let listed = null;
  const r = await slack(
    ['--ws', WS, 'watch', CH, '--thread', ROOT, 'bb thread tell x "$SLACK_TEXT"'],
    {
      during: async ({ signal, vfs }) => {
        await tick(20);
        listed = JSON.parse(new TextDecoder().decode(vfs.files[`${STATE}/watch-4242.json`]));
        signal('SIGINT');
      },
    }
  );
  is(r.exitCode, 130);
  is(
    [
      listed.pid,
      listed.workspace,
      listed.channel,
      listed.thread_ts,
      listed.command,
      listed.expiresAt,
    ],
    [4242, WS, CH, ROOT, 'bb thread tell x "$SLACK_TEXT"', null]
  );
  is(listed.heartbeatAt, listed.startedAt, 'the first heartbeat is the start');
  is(r.writes.find((w) => w.file === `${STATE}/watch-4242.json.tmp`).opts, { mode: 0o600 });
});

test('watch observes the tab of the workspace it watches, not the first Slack tab', async () => {
  const tabs = [
    { targetId: 'other', url: 'https://app.slack.com/client/T06V9L18205/C1' },
    { targetId: 'mine', url: `https://app.slack.com/client/${WS}/${CH}` },
  ];
  const r = await slack(['--ws', WS, 'watch', CH, '--for', '1s'], { tabs });
  is(r.calls.find((c) => c.method === 'websocket').tab.targetId, 'mine');
});

test('a watch of a Grid team observes its org’s tab, not the first Slack tab', async () => {
  const TEAM = 'T0385CHDU9E';
  const tabs = [
    { targetId: 'other-org', url: 'https://app.slack.com/client/E0OTHERORG1/C1' },
    { targetId: 'our-org', url: `https://app.slack.com/client/${WS}/${CH}` },
  ];
  const teams = { [TEAM]: { token: 'xoxc-team', enterprise_id: WS } };
  const r = await slack(['--ws', TEAM, 'watch', CH, '--for', '1s'], { tabs, teams });
  is(r.calls.find((c) => c.method === 'websocket').tab.targetId, 'our-org');
});

test('a watch of a workspace no tab knows fails instead of watching another tab', async () => {
  const r = await slack(['--ws', 'T0NOTSIGNED1', 'watch', CH, '--for', '1s']);
  is(r.exitCode, 1);
  ok(r.err.includes('T0NOTSIGNED1 is not signed in'));
  ok(!r.calls.some((c) => c.method === 'websocket'), 'no subscription');
  ok(!Object.keys(r.vfs.files).some((f) => f.startsWith(STATE)), 'not registered');
});

test('a watch stopped while an author lookup hangs ends at once', async () => {
  const started = Date.now();
  const r = await slack(['--ws', WS, 'watch', CH, 'echo late'], {
    slowApi: 4000,
    during: async ({ framesPath, vfs, signal }) => {
      await vfs.promises.appendFile(framesPath, frame({ ts: '6.000002' }));
      await tick(350);
      signal('SIGTERM');
    },
  });
  is(r.exitCode, 143);
  ok(Date.now() - started < 2500, 'did not wait for the lookup');
  is(r.spawns, []);
  is(Object.keys(r.vfs.files), [], 'cleaned up');
});

test('a watch whose workspace or org tab is closed says which tab to open', async () => {
  const tabs = [{ targetId: 'other-org', url: 'https://app.slack.com/client/E0OTHERORG1/C1' }];
  const teams = {
    T0385CHDU9E: { token: 'x', enterprise_id: WS },
    T0STANDALONE: { token: 'y' },
  };
  for (const [ws, home] of [
    ['T0385CHDU9E', WS],
    ['T0STANDALONE', 'T0STANDALONE'],
  ]) {
    const r = await slack(['--ws', ws, 'watch', CH, '--for', '1s'], { tabs, teams });
    is(r.exitCode, 1, ws);
    ok(r.err.includes(`https://app.slack.com/client/${home}`), ws);
    ok(!r.calls.some((c) => c.method === 'websocket'), `${ws}: no subscription`);
  }
});

test('a watch records the workspace it resolved, so --ws finds an auto-detected watch', async () => {
  let listed = null;
  await slack(['watch', CH], {
    during: async ({ signal, vfs }) => {
      await tick(20);
      listed = JSON.parse(new TextDecoder().decode(vfs.files[`${STATE}/watch-4242.json`]));
      signal('SIGTERM');
    },
  });
  is(listed.workspace, WS, 'from the tab URL, without --ws');
  const files = { [`${STATE}/watch-111.json`]: entry(111) };
  for (const argv of [
    ['--ws', WS, 'unwatch', CH, '--thread', ROOT],
    ['unwatch', CH, '--thread', ROOT],
  ]) {
    const u = await slack(argv, { files, alive: new Set([111]) });
    is(u.killed, [{ pid: 111, sig: 'SIGTERM' }], argv.join(' '));
  }
  const other = await slack(['--ws', 'T06V9L18205', 'unwatch', CH, '--thread', ROOT], {
    files,
    alive: new Set([111]),
  });
  is(other.killed, [], 'another workspace is another target');
});

test('stopping a watch stops a callback that is still running', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, 'sleep 1000'], {
    hang: true,
    during: async ({ framesPath, vfs, signal }) => {
      await vfs.promises.appendFile(framesPath, frame({ ts: '5.000001' }));
      await tick(400);
      signal('SIGTERM');
    },
  });
  is(r.exitCode, 143);
  is(r.killed, [{ pid: -5151, sig: 'SIGTERM' }], 'SIGTERM to the callback’s process group');
  is(r.spawns[0].opts.detached, true, 'the callback leads its own group');
  is(Object.keys(r.vfs.files), []);
});

test('a watch that ends while it looks up a message author runs no callback', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, 'echo late'], {
    slowApi: 600,
    during: async ({ framesPath, vfs, signal }) => {
      await vfs.promises.appendFile(framesPath, frame({ ts: '6.000001' }));
      await tick(350);
      signal('SIGTERM');
    },
  });
  is(r.exitCode, 143);
  is(r.spawns, [], 'no callback starts after the watch was told to stop');
});

test('watch reads only the bytes appended since its last read', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, '--count', '3', 'cb'], {
    during: async ({ framesPath, vfs }) => {
      for (const ts of ['7.000001', '7.000002', '7.000003']) {
        await vfs.promises.appendFile(framesPath, frame({ ts }));
        await tick(300);
      }
    },
  });
  is(r.exitCode, 0);
  is(r.spawns.length, 3);
  const size = r.reads.reduce((n, x) => n + x.len, 0);
  is(size, 3 * frame({ ts: '7.000001' }).length, 'every byte read once');
  ok(
    r.reads.every((x, i) => i === 0 || x.pos === r.reads[i - 1].pos + r.reads[i - 1].len),
    'each read starts where the last one ended'
  );
});

test('a line cut inside a multi-byte character is read whole', async () => {
  const bytes = new TextEncoder().encode(frame({ ts: '8.000001', text: 'ship it 🚀 now' }));
  const cut = bytes.indexOf(0xf0) + 2;
  const r = await slack(['--ws', WS, 'watch', CH, '--count', '1', 'cb'], {
    during: async ({ framesPath, vfs }) => {
      await vfs.promises.appendFile(framesPath, bytes.subarray(0, cut));
      await tick(300);
      await vfs.promises.appendFile(framesPath, bytes.subarray(cut));
    },
  });
  is(r.exitCode, 0);
  is(r.spawns[0].opts.env.SLACK_TEXT, 'ship it 🚀 now');
});

test('a --count watch stopped while its last callback runs keeps the signal’s status', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, '--count', '1', 'sleep 1000'], {
    hang: true,
    during: async ({ framesPath, vfs, signal }) => {
      await vfs.promises.appendFile(framesPath, frame({ ts: '9.000001' }));
      await tick(400);
      signal('SIGTERM');
    },
  });
  is(r.exitCode, 143, 'not 0: the count was not reached by a finished callback');
});

// ─── slack watches / unwatch ─────────────────────────────────────────────────

const entry = (pid, extra) =>
  JSON.stringify({
    pid,
    workspace: WS,
    channel: CH,
    thread_ts: ROOT,
    command: 'cmd',
    startedAt: `2026-11-04T1${pid % 10}:00:00Z`,
    heartbeatAt: new Date().toISOString(),
    ...extra,
  });

test('watches lists live watches and drops entries whose process is gone', async () => {
  const files = {
    [`${STATE}/watch-111.json`]: entry(111),
    [`${STATE}/watch-222.json`]: entry(222),
  };
  const r = await slack(['watches'], { files, alive: new Set([111]) });
  is(r.exitCode, 0);
  ok(r.out.includes('pid 111'));
  ok(!r.out.includes('pid 222'));
  ok(!(`${STATE}/watch-222.json` in r.vfs.files), 'the stale entry is removed');
});

test('unwatch sends SIGTERM to the watches on that target only', async () => {
  const files = {
    [`${STATE}/watch-111.json`]: entry(111),
    [`${STATE}/watch-333.json`]: entry(333, { thread_ts: null }),
  };
  const r = await slack(['--ws', WS, 'unwatch', CH, '--thread', ROOT], {
    files,
    alive: new Set([111, 333]),
  });
  is(r.exitCode, 0);
  is(r.killed, [{ pid: 111, sig: 'SIGTERM' }]);
  const none = await slack(['--ws', WS, 'unwatch', 'C0NOTWATCHED'], {
    files,
    alive: new Set([111, 333]),
  });
  is(none.exitCode, 1);
  is(none.killed, []);
});

// ─── slack post --watch-command ──────────────────────────────────────────────

const posted = {
  'chat.postMessage': { ok: true, ts: '4.000001', message: { text: 'hi', ts: '4.000001' } },
  'conversations.info': { ok: true, channel: { num_members: 500 } },
};

test('post --watch-command starts a background watch of the thread for an hour', async () => {
  const r = await slack(
    [
      '--ws',
      WS,
      'post',
      CH,
      'hi',
      '--no-sign',
      '--watch-command',
      'bb thread tell t "$SLACK_TEXT"',
    ],
    {
      api: posted,
    }
  );
  is(r.exitCode, 0);
  const bg = r.spawns.find((s) => s.bin === 'jsh');
  ok(bg, 'jsh was spawned');
  is(bg.args, [
    SCRIPT,
    `--ws=${WS}`,
    'watch',
    CH,
    '--thread=4.000001',
    '--for=1h',
    'bb thread tell t "$SLACK_TEXT"',
  ]);
  is(bg.opts.detached, true);
  is(r.opens[0].mode, 0o600, 'the log is private');
  ok(r.out.includes('in the background (pid 5151)'));
});

test('post takes the callback from $SLACK_WATCH_COMMAND, watches a small conversation whole, and restarts a running watch', async () => {
  const files = { [`${STATE}/watch-111.json`]: entry(111, { thread_ts: null, command: 'cb' }) };
  const r = await slack(['--ws', WS, 'post', CH, 'hi', '--no-sign'], {
    api: { ...posted, 'conversations.info': { ok: true, channel: { num_members: 2 } } },
    env: { SLACK_WATCH_COMMAND: 'cb' },
    files,
    alive: new Set([111]),
  });
  is(r.exitCode, 0);
  const bg = r.spawns.find((s) => s.bin === 'jsh');
  is(bg.args, [SCRIPT, `--ws=${WS}`, 'watch', CH, '--for=1h', 'cb']);
  is(r.killed, [{ pid: 111, sig: 'SIGTERM' }], 'the old watch stops after the new one starts');
  ok(r.out.includes('Restarted'));
});

test('post without a callback starts nothing and names the watch command', async () => {
  const r = await slack(['--ws', WS, 'post', CH, 'hi', '--no-sign'], { api: posted });
  is(r.exitCode, 0);
  is(r.spawns, []);
  ok(r.out.includes(`watch ${CH} --thread=4.000001 --count=1 --for=1h`));
});

test('the suggested watch takes the conversation scope a background watch would', async () => {
  const small = { ...posted, 'conversations.info': { ok: true, channel: { num_members: 2 } } };
  const r = await slack(['--ws', WS, 'post', CH, 'hi', '--no-sign'], { api: small });
  is(r.exitCode, 0);
  ok(
    r.out.includes(`wait for a reply: slack --ws=${WS} watch ${CH} --count=1 --for=1h`),
    'no --thread in a DM'
  );
});

test('unwatch refuses a --thread without a timestamp instead of stopping the channel watch', async () => {
  const files = { [`${STATE}/watch-333.json`]: entry(333, { thread_ts: null }) };
  for (const argv of [
    ['--ws', WS, 'unwatch', CH, '--thread'],
    ['unwatch', CH, '--thread', '--ws', WS],
    ['unwatch', CH, '--thread=abc'],
  ]) {
    const r = await slack(argv, { files, alive: new Set([333]) });
    is(r.exitCode, 2, argv.join(' '));
    is(r.killed, [], `${argv.join(' ')}: nothing stopped`);
  }
});

test('a restart stops the old watch only after the new one has registered', async () => {
  const files = { [`${STATE}/watch-111.json`]: entry(111, { thread_ts: null, command: 'cb' }) };
  const args = ['--ws', WS, 'post', CH, 'hi', '--no-sign', '--watch-command', 'cb'];
  const small = { ...posted, 'conversations.info': { ok: true, channel: { num_members: 2 } } };
  const r = await slack(args, { api: small, files, alive: new Set([111]) });
  is(r.killed, [{ pid: 111, sig: 'SIGTERM' }]);
  ok(r.readyAt() !== null && r.killedAt[0] >= r.readyAt(), 'SIGTERM after the new entry exists');
  for (const child of ['missing', 'exits']) {
    const f = await slack(args, { api: small, files, alive: new Set([111]), child });
    is(f.exitCode, 0, `${child}: the post itself succeeded`);
    is(f.killed, [], `${child}: the running watch is left alone`);
    ok(f.err.includes('The running watch keeps running'), child);
    ok(!f.out.includes('in the background'), `${child}: no claim that a watch runs`);
  }
});

test('a background watch that misses the startup timeout is stopped; the old one runs on', async () => {
  const files = { [`${STATE}/watch-111.json`]: entry(111, { thread_ts: null, command: 'cb' }) };
  const small = { ...posted, 'conversations.info': { ok: true, channel: { num_members: 2 } } };
  const r = await slack(['--ws', WS, 'post', CH, 'hi', '--no-sign', '--watch-command', 'cb'], {
    api: small,
    files,
    alive: new Set([111]),
    child: 'slow',
    fastClock: true,
  });
  is(r.exitCode, 0);
  is(r.killed, [{ pid: 5151, sig: 'SIGTERM' }], 'only the new child is stopped');
  ok(r.err.includes('was stopped') && r.err.includes('The running watch keeps running'));
});

test('--for refuses what setTimeout cannot wait for', async () => {
  const r = await slack(['--ws', WS, 'watch', CH, '--for', '25d']);
  is(r.exitCode, 2);
  ok(r.err.includes('at most 24d'));
});

test('two posts starting watches at once leave one: the newest', async () => {
  const small = { ...posted, 'conversations.info': { ok: true, channel: { num_members: 2 } } };
  const args = ['--ws', WS, 'post', CH, 'hi', '--no-sign', '--watch-command', 'cmd'];
  const alive = new Set([222]);
  const newer = entry(222, { thread_ts: null, startedAt: '2026-11-04T19:00:00Z' });
  const a = await slack(args, { api: small, alive, concurrent: newer });
  is(a.killed, [{ pid: 5151, sig: 'SIGTERM' }], 'ours yields to the newer one');
  ok(a.out.includes('(pid 222) takes over'));
  const older = entry(222, { thread_ts: null, startedAt: '2026-11-04T10:00:00Z' });
  const b = await slack(args, { api: small, alive, concurrent: older });
  is(b.killed, [{ pid: 222, sig: 'SIGTERM' }], 'the older one yields to ours');
  ok(b.out.includes('(pid 5151)'));
});

test('a registry entry is written to a temporary name and renamed into place', async () => {
  const r = await slack(['--ws', WS, 'watch', CH], {
    during: async ({ signal }) => {
      await tick(20);
      signal('SIGTERM');
    },
  });
  is(r.renames, [{ from: `${STATE}/watch-4242.json.tmp`, to: `${STATE}/watch-4242.json` }]);
  is(r.writes.find((w) => w.file === `${STATE}/watch-4242.json.tmp`).opts, { mode: 0o600 });
  ok(!r.writes.some((w) => w.file === `${STATE}/watch-4242.json`), 'never written in place');
});

test('an entry whose heartbeat is stale is not a watch, even when its pid is alive', async () => {
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const files = { [`${STATE}/watch-111.json`]: entry(111, { heartbeatAt: stale }) };
  const w = await slack(['watches'], { files, alive: new Set([111]) });
  ok(w.out.includes('No running watches'));
  ok(!(`${STATE}/watch-111.json` in w.vfs.files), 'the stale entry is removed');
  const u = await slack(['--ws', WS, 'unwatch', CH, '--thread', ROOT], {
    files,
    alive: new Set([111]),
  });
  is(u.exitCode, 1);
  is(u.killed, [], 'a reused pid gets no SIGTERM');
});

// ─── slack download ──────────────────────────────────────────────────────────

const fileInfo = (name, url = 'https://files.slack.com/files-pri/T1-F1/download/x') => ({
  'files.info': { ok: true, file: { id: 'F1', name, url_private_download: url } },
});

test('download sends the session cookie to files.slack.com and writes the bytes', async () => {
  const r = await slack(['--ws', WS, 'download', 'F1', '--out', '/tmp/out.bin'], {
    api: fileInfo('x.bin'),
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'application/octet-stream' },
      }),
  });
  is(r.exitCode, 0);
  is(r.fetches.length, 1);
  is(r.fetches[0].opts.headers, { Cookie: 'd=d-cookie-value' });
  is([...r.vfs.files['/tmp/out.bin']], [1, 2, 3]);
  ok(
    !r.out.includes('d-cookie-value') && !r.err.includes('d-cookie-value'),
    'the cookie is never printed'
  );
});

test('download refuses to send the session anywhere but https://*.slack.com', async () => {
  for (const url of [
    'https://evil.example/x',
    'http://files.slack.com/x',
    'https://files.slack.com.evil.io/x',
    'not a url',
  ]) {
    const r = await slack(['--ws', WS, 'download', '--url', url, '--out', '/tmp/o']);
    is(r.exitCode, 1, url);
    is(r.fetches, [], `${url}: nothing fetched`);
  }
});

test('download keeps an uploader’s file name inside /tmp', async () => {
  const r = await slack(['--ws', WS, 'download', 'F1'], {
    api: fileInfo('../../home/tester/.zshrc'),
    fetch: async () => new Response('x', { headers: { 'content-type': 'text/plain' } }),
  });
  is(r.exitCode, 0);
  const written = Object.keys(r.vfs.files);
  is(written.length, 1);
  ok(written[0].startsWith('/tmp/') && !written[0].slice(5).includes('/'), written[0]);
  ok(!written[0].includes('/../'), 'no traversal');
});

test('download treats a login page as an expired session', async () => {
  const r = await slack(['--ws', WS, 'download', 'F1', '--out', '/tmp/o'], {
    api: fileInfo('x.bin'),
    fetch: async () =>
      new Response('<html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  });
  is(r.exitCode, 1);
  ok(r.err.includes('session may have expired'));
  is(Object.keys(r.vfs.files), []);
});
