import test, { is, ok } from 'tst';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Filing-cone stamp on `loose-ends create` (slicc#3212 Layer C).
// Run with:
//
//   tst skills/loose-ends/tests/filing-cone.test.js

const SCRIPT = path.join(__dirname, '..', 'scripts', 'loose-ends.jsh');
const source = fs.readFileSync(SCRIPT, 'utf8');

function extractFunction(name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('function ' + name + '('));
  ok(start >= 0, name + ' not found in script');
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  ok(end > start, 'end of ' + name + ' not found');
  return lines.slice(start, end + 1).join('\n');
}

function filingCone() {
  const fn = new Function(extractFunction('filingCone') + '\nreturn filingCone;');
  return fn();
}

async function runCreate(args, { env = {}, store = { updated: null, tasks: [] } } = {}) {
  const files = { '/shared/loose-ends.json': JSON.stringify(store) };
  const sent = [];
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  const fakeFs = {
    existsSync: (p) => Object.hasOwn(files, p),
    readFileSync: (p) => {
      if (!Object.hasOwn(files, p)) throw new Error('ENOENT: ' + p);
      return files[p];
    },
    writeFileSync: (p, c) => {
      files[p] = String(c);
    },
    renameSync: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
  };
  const exec = Object.assign(
    async (cmd) => {
      sent.push(cmd);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }
  );
  const argv = ['node', SCRIPT, ...args];
  const proc = {
    argv,
    env,
    pid: 1,
    stdout: { write: (s) => stdout.push(s) },
    stderr: { write: (s) => stderr.push(s) },
    exit(code = 0) {
      const err = new Error('exit ' + code);
      err.name = 'NodeExitError';
      err.exitCode = code;
      throw err;
    },
  };
  const body = new (Object.getPrototypeOf(async function () {}).constructor)(
    'require',
    'process',
    source
  );
  try {
    await body((name) => {
      if (name === 'fs') return fakeFs;
      if (name === 'sliccy:exec') return exec;
      throw new Error('unexpected require: ' + name);
    }, proc);
  } catch (err) {
    if (err.name !== 'NodeExitError') throw err;
    exitCode = err.exitCode;
  }
  const stored = JSON.parse(files['/shared/loose-ends.json']);
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join(''), stored, sent, files };
}

test('filingCone reads the cone folder from TMPDIR for cones and scoops', () => {
  const parse = filingCone();
  is(parse({ TMPDIR: '/tmp/cone-adobe' }), 'cone-adobe');
  is(parse({ TMPDIR: '/tmp/cone-adobe/loose-ends-scoop' }), 'cone-adobe');
  is(parse({ TMPDIR: '/tmp/cone' }), 'cone');
  is(parse({ TMPDIR: '' }), undefined);
  is(parse({}), undefined);
  is(parse(undefined), undefined);
});

test('create stamps the filing cone from TMPDIR', async () => {
  const r = await runCreate(['create', '--title', 'Ping Marta', '--id', 'le-marta'], {
    env: { TMPDIR: '/tmp/cone-adobe/loose-ends-scoop' },
  });
  is(r.exitCode, 0);
  is(r.stored.tasks.length, 1);
  is(r.stored.tasks[0].id, 'le-marta');
  is(r.stored.tasks[0].cone, 'cone-adobe');
});

test('create --cone overrides TMPDIR and upsert keeps the original owner', async () => {
  const first = await runCreate(['create', '--title', 'Ping Marta', '--id', 'le-marta', '--cone', 'cone-helix'], {
    env: { TMPDIR: '/tmp/cone-adobe' },
  });
  is(first.stored.tasks[0].cone, 'cone-helix');

  const second = await runCreate(['create', '--title', 'Ping Marta again', '--id', 'le-marta'], {
    env: { TMPDIR: '/tmp/cone-adobe' },
    store: first.stored,
  });
  is(second.stored.tasks.length, 1);
  is(second.stored.tasks[0].title, 'Ping Marta again');
  is(second.stored.tasks[0].cone, 'cone-helix', 'upsert must not steal the filing cone');
});

test('create without TMPDIR leaves cone unset', async () => {
  const r = await runCreate(['create', '--title', 'No cone', '--id', 'le-none']);
  is(r.stored.tasks[0].cone, undefined);
});
