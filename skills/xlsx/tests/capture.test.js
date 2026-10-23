import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';
import { exitStub, load } from './extract.js';
import { nodeFs } from './node-fs.js';

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'scripts/excel.jsh'), 'utf8');
const HAR_DIR = '/tmp/.slicc-excel-har';
const TAB = 'AB12CD34';
const HAR = `${HAR_DIR}/${TAB}.har`;
const NAMES = [
  'captureToken',
  'captureTokenSix',
  'captureTokenSeven',
  'isSeven',
  'within',
  'pw',
  'bearerFromHar',
  'startHarHolder',
];

function emitter() {
  const on = {};
  return {
    on: (name, fn) => {
      on[name] = fn;
    },
    emit: (name, value) => on[name] && on[name](value),
  };
}

function harWith(entries) {
  return JSON.stringify({ log: { version: '1.2', entries } });
}

function graphEntry(method, value) {
  return {
    request: {
      method,
      url: 'https://graph.microsoft.com/v1.0/me/photo/$value',
      headers: value ? [{ name: 'Authorization', value }] : [],
    },
  };
}

function seven(harText, hang = false) {
  const vfs = nodeFs();
  const calls = [];
  const spawned = [];
  const exec = async (cmd) => {
    calls.push(cmd);
    return { stdout: '', stderr: 'unexpected six command', exitCode: 1 };
  };
  exec.spawn = async (argv) => {
    calls.push(argv.join(' '));
    if (argv[1] === '--version')
      return { stdout: 'playwright-cli 1.41.0\n', stderr: '', exitCode: 0 };
    if (argv.includes('open'))
      return {
        stdout: `Opened about:blank in new tab [targetId: ${TAB}]\n`,
        stderr: '',
        exitCode: 0,
      };
    if (argv.includes('eval') && argv.some((a) => a.includes('performance')))
      return { stdout: 'true\n', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const childProcess = {
    spawn: (bin, args, opts) => {
      const stdout = emitter();
      const stderr = emitter();
      const events = emitter();
      const child = {
        stdout,
        stderr,
        on: events.on,
        killed: false,
        kill: () => {
          child.killed = true;
        },
        stdin: {
          end: () => {
            if (harText !== null)
              vfs.files[args[args.length - 1]] = new TextEncoder().encode(harText);
            child.ended = true;
            if (!hang) events.emit('close', 0);
          },
        },
      };
      spawned.push({ bin, args, opts, child });
      queueMicrotask(() =>
        stdout.emit(
          'data',
          `${JSON.stringify({ event: 'ready', recordingId: 'rec-1', tab: TAB })}\n`
        )
      );
      return child;
    },
  };
  const exit = exitStub();
  const fns = load(SOURCE, NAMES, {
    exec,
    childProcess,
    fs: vfs,
    cli: exit,
    sleep: async () => {},
    setTimeout: (fn, ms) => (ms === 15000 ? fn() : globalThis.setTimeout(fn, ms)),
    CAPTURE_URL: 'https://excel.cloud.microsoft/',
    GRAPH_ORIGIN: 'https://graph.microsoft.com',
    HAR_DIR,
    PW_SESSION: 'excel-token',
  });
  return { fns, calls, spawned, vfs, exit };
}

test('on seven the token is lifted from a credentialed URL-glob HAR', async () => {
  const run = seven(harWith([graphEntry('OPTIONS', ''), graphEntry('GET', 'Bearer eyJ.a.b')]));
  is(await run.fns.captureToken(), 'eyJ.a.b');
  is(run.exit.dies, []);
  is(run.spawned.length, 1);
  const { bin, args, child } = run.spawned[0];
  is(bin, 'playwright-cli');
  is(args, [
    '-s',
    'excel-token',
    'har-start',
    '--tab',
    TAB,
    '--url-filter',
    'https://graph.microsoft.com/**',
    '--include-credentials',
    HAR,
  ]);
  ok(
    args.every((a) => !a.includes('=>') && !a.includes(';')),
    'no JavaScript filter'
  );
  ok(child.ended, 'holder stopped through stdin EOF');
  is(
    run.calls.some((c) => c.includes(' record ')),
    false
  );
  ok(
    run.calls.includes(
      `playwright-cli -s excel-token eval location.href = "https://excel.cloud.microsoft/" --tab ${TAB}`
    )
  );
  ok(run.calls.includes(`playwright-cli -s excel-token tab-close --tab ${TAB}`));
  is(HAR in run.vfs.files, false);
});

test('on seven a missing token dies with the sign-in hint and still cleans up', async () => {
  const run = seven(harWith([graphEntry('OPTIONS', ''), graphEntry('GET', '')]));
  let err = null;
  try {
    await run.fns.captureToken();
  } catch (e) {
    err = e;
  }
  is(err?.name, 'NodeExitError');
  ok(run.exit.dies[0].startsWith('could not capture a Graph token'));
  ok(run.calls.includes(`playwright-cli -s excel-token tab-close --tab ${TAB}`));
  is(HAR in run.vfs.files, false);
  ok(run.spawned[0].child.killed);
});

test('on seven a holder that misses its shutdown deadline is not read', async () => {
  const run = seven(harWith([graphEntry('GET', 'Bearer eyJ.a.b')]), true);
  let err = null;
  try {
    await run.fns.captureToken();
  } catch (e) {
    err = e;
  }
  is(err?.name, 'NodeExitError');
  ok(run.exit.dies[0].startsWith('the HAR recording did not finish writing'));
  ok(run.spawned[0].child.killed);
  is(HAR in run.vfs.files, false);
  ok(run.calls.includes(`playwright-cli -s excel-token tab-close --tab ${TAB}`));
});

test('bearerFromHar ignores preflights and other origins', () => {
  const { fns } = seven(null);
  is(
    fns.bearerFromHar({
      log: {
        entries: [
          graphEntry('OPTIONS', 'Bearer pre.flight.x'),
          {
            request: {
              method: 'GET',
              url: 'https://evil.example/graph.microsoft.com/',
              headers: [{ name: 'authorization', value: 'Bearer other.origin.x' }],
            },
          },
          graphEntry('GET', 'Bearer real.token.x'),
        ],
      },
    }),
    'real.token.x'
  );
  is(fns.bearerFromHar({}), null);
});

test('on six the JS-era record flow is kept', async () => {
  const calls = [];
  const exec = async (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith('playwright-cli record '))
      return {
        stdout: `Recording started (targetId: ${TAB}, recordingId: rec-9-x) at https://excel.cloud.microsoft/\n`,
        stderr: '',
        exitCode: 0,
      };
    if (cmd.startsWith('playwright-cli requests '))
      return {
        stdout:
          '  1  OPTIONS https://graph.microsoft.com/x\n  2  GET https://graph.microsoft.com/x\n',
        exitCode: 0,
      };
    if (cmd.startsWith('playwright-cli request-headers 2'))
      return { stdout: 'authorization: Bearer six.token.x\n', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  exec.spawn = async (argv) => {
    calls.push(argv.join(' '));
    return { stdout: '', stderr: 'Unknown command: --version\n', exitCode: 1 };
  };
  const exit = exitStub();
  const fns = load(SOURCE, NAMES, {
    exec,
    childProcess: {
      spawn: () => {
        throw new Error('no holder on six');
      },
    },
    fs: nodeFs(),
    cli: exit,
    setTimeout: (fn) => fn(),
    CAPTURE_URL: 'https://excel.cloud.microsoft/',
    GRAPH_ORIGIN: 'https://graph.microsoft.com',
    HAR_DIR,
    PW_SESSION: 'excel-token',
  });
  is(await fns.captureToken(), 'six.token.x');
  ok(calls.includes('playwright-cli stop-recording rec-9-x'));
  ok(calls.includes(`playwright-cli tab-close --tab=${TAB}`));
});
