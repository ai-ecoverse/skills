import fs from 'node:fs';
import path from 'node:path';
import test, { is, ok } from 'tst';

// Runs the real screen-recorder.jsh against an in-memory fs with Node
// semantics (what slicc-jsh and current SLICC 6 both provide), sliccy:exec,
// sliccy:skill and sliccy:cli. The skill root is the cwd under tst.
const ROOT = process.cwd();
const source = fs.readFileSync(path.join(ROOT, 'scripts/screen-recorder.jsh'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const CONFIG = '/shared/sprinkles/recording-setup/config.json';
const CAPS = '/workspace/captures';

class NodeExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

async function run(argv, { files = {}, send = { exitCode: 0 } } = {}) {
  const vfs = { ...files };
  const stdout = [];
  const stderr = [];
  const jobs = [];
  const enoent = (f) => Object.assign(new Error(`ENOENT: ${f}`), { code: 'ENOENT' });
  const fsStub = {
    existsSync: (f) => Object.hasOwn(vfs, f) || Object.keys(vfs).some((k) => k.startsWith(`${f}/`)),
    promises: {
      readFile: async (f) => {
        if (!Object.hasOwn(vfs, f)) throw enoent(f);
        return vfs[f];
      },
      writeFile: async (f, d) => {
        vfs[f] = String(d);
      },
      mkdir: async () => {},
      rm: async (f) => {
        delete vfs[f];
      },
      readdir: async (d) => {
        const names = new Set();
        for (const k of Object.keys(vfs))
          if (k.startsWith(`${d}/`)) names.add(k.slice(d.length + 1).split('/')[0]);
        if (!names.size) throw enoent(d);
        return [...names];
      },
    },
  };
  const exec = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  exec.start = (argv) => {
    const job = { argv, killed: null, ended: false };
    jobs.push(job);
    job.stdin = { write() {}, end: () => (job.ended = true) };
    job.done =
      send === 'hang'
        ? new Promise(() => {})
        : Promise.resolve({ stdout: '', stderr: '', ...send });
    job.kill = (sig) => {
      job.killed = sig;
      return Promise.resolve(true);
    };
    return job;
  };
  const cli = {
    die(msg, opts = {}) {
      stderr.push(`Error: ${msg}`);
      throw new NodeExitError(opts.exitCode ?? 1);
    },
    help(text) {
      stdout.push(text);
      throw new NodeExitError(0);
    },
    warn: (m) => stderr.push(String(m)),
  };
  const modules = {
    fs: fsStub,
    'sliccy:cli': cli,
    'sliccy:exec': exec,
    'sliccy:skill': { dir: '/workspace/skills/screen-recorder' },
  };
  const req = (n) => {
    if (Object.hasOwn(modules, n)) return modules[n];
    throw new Error(`unexpected require(${n})`);
  };
  // The 4 s sprinkle-send timeout fires at once here, so a hung send is cheap to test.
  const fastTimeout = (fn, ms, ...a) => setTimeout(fn, ms >= 1000 ? 1 : ms, ...a);
  const proc = { argv: ['node', 'screen-recorder.jsh', ...argv], env: {} };
  const cons = {
    log: (...a) => stdout.push(a.join(' ')),
    error: (...a) => stderr.push(a.join(' ')),
  };
  let exitCode = 0;
  try {
    await new AsyncFunction('require', 'process', 'console', 'setTimeout', source)(
      req,
      proc,
      cons,
      fastTimeout
    );
  } catch (e) {
    if (e?.name !== 'NodeExitError') throw e;
    exitCode = e.code;
  }
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), vfs, jobs };
}

test('config set writes config.json and live-reloads an open panel', async () => {
  const r = await run([
    'config',
    'set',
    'startUrl=https://example.com',
    'width=1280',
    'maxDurationSec=30',
  ]);
  is(r.exitCode, 0, r.stderr);
  is(JSON.parse(r.vfs[CONFIG]), {
    startUrl: 'https://example.com',
    width: 1280,
    maxDurationSec: 30,
  });
  is(r.jobs[0].argv, ['sprinkle', 'send', 'recording-setup', '{"type":"reloadconfig"}']);
  ok(r.jobs[0].ended, 'stdin closed so the child runs');
  ok(r.stdout.includes('(live panel updated)'));
});

test('an empty, hex, or exponent value is refused, not read as 0 / 16 / 1000', async () => {
  for (const pair of [
    'maxDurationSec=',
    'countdownSec=',
    'width=0x10',
    'width=1e3',
    'maxDurationSec= ',
  ]) {
    const r = await run(['config', 'set', pair]);
    is(r.exitCode, 1, pair);
    ok(r.stderr.includes('must be an integer'), `${pair}: ${r.stderr}`);
    ok(!Object.hasOwn(r.vfs, CONFIG), `${pair}: nothing written`);
  }
  is((await run(['config', 'set', 'maxDurationSec=inf'])).exitCode, 0);
});

test('a hung sprinkle send is killed at the timeout and reported as not updated', async () => {
  const r = await run(['config', 'set', 'countdownSec=3'], { send: 'hang' });
  is(r.exitCode, 0, r.stderr);
  is(r.jobs[0].killed, 'SIGKILL');
  is(r.stdout, 'set countdownSec=3');
});

test('config clear deletes the file and tells the panel', async () => {
  const r = await run(['config', 'clear'], { files: { [CONFIG]: '{"width":1280}' } });
  is(r.exitCode, 0);
  ok(!Object.hasOwn(r.vfs, CONFIG));
  is(r.stdout, 'config cleared (live panel updated)');
});

test('manifest: a screenshot take is not reported as disagreeing with a missing capture', async () => {
  const shot = {
    mode: 'screenshot',
    stopReason: 'screenshot',
    durationMs: 0,
    targetWindow: { predictedFrame: '2560x1686' },
    tracks: [{ name: 'screen', kind: 'image', file: 'screen.png', width: 2560, height: 1686 }],
  };
  const folder = '2026-10-17T10-00-00';
  const same = await run(['manifest'], {
    files: { [`${CAPS}/${folder}/manifest.json`]: JSON.stringify(shot) },
  });
  is(same.exitCode, 0, same.stderr);
  ok(same.stdout.includes('CAPTURED      2560x1686  (single frame)'));
  ok(!same.stdout.includes('DISAGREES'), same.stdout);
  const off = { ...shot, tracks: [{ ...shot.tracks[0], height: 1600 }] };
  const differs = await run(['manifest', folder], {
    files: { [`${CAPS}/${folder}/manifest.json`]: JSON.stringify(off) },
  });
  ok(differs.stdout.includes('DISAGREES with captured'), differs.stdout);
});

test('captures lists only folders that hold a manifest, oldest first', async () => {
  const r = await run(['captures'], {
    files: {
      [`${CAPS}/2026-10-17T10-00-00/manifest.json`]: '{}',
      [`${CAPS}/2026-10-16T09-00-00/manifest.json`]: '{}',
      [`${CAPS}/2026-10-15T09-00-00/screen.webm`]: 'x',
      [`${CAPS}/sync.example.json`]: '{}',
      [`${CAPS}/drivers/a.sh`]: 'x',
    },
  });
  is(r.stdout, '2026-10-16T09-00-00\n2026-10-17T10-00-00');
});

test('install copies the panel from skill.dir and leaves config.json alone', async () => {
  const src = '/workspace/skills/screen-recorder/assets/sprinkle';
  const r = await run(['install'], {
    files: {
      [`${src}/recording-setup.shtml`]: '<html></html>',
      [`${src}/build.sh`]: 'sh',
      [`${src}/src/entry.js`]: 'js',
      [`${src}/src/notes.txt`]: 'skip',
      [CONFIG]: '{"width":900}',
    },
  });
  is(r.exitCode, 0, r.stderr);
  is(r.vfs['/shared/sprinkles/recording-setup/recording-setup.shtml'], '<html></html>');
  is(r.vfs['/shared/sprinkles/recording-setup/src/entry.js'], 'js');
  ok(!Object.hasOwn(r.vfs, '/shared/sprinkles/recording-setup/src/notes.txt'));
  is(r.vfs[CONFIG], '{"width":900}');
});
