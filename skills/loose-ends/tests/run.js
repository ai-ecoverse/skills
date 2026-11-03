import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
export const SCRIPT = fileURLToPath(new URL('../scripts/loose-ends.jsh', import.meta.url));
const RAW = fs.readFileSync(SCRIPT, 'utf8');
const SOURCE = RAW.startsWith('#!') ? `\n${RAW.slice(RAW.indexOf('\n') + 1)}` : RAW;

class NodeExitError extends Error {
  constructor(code) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
    this.code = code;
  }
}

export function sandbox() {
  const root = path.join(
    '/tmp',
    `loose-ends-tst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(path.join(root, 'home'), { recursive: true });
  return {
    root,
    home: path.join(root, 'home'),
    store: path.join(root, 'store.json'),
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    },
  };
}

function mappedFs(root, stdin, socket) {
  const bytes = Buffer.from(stdin, 'utf8');
  let pos = 0;
  const map = (p) => {
    if (typeof p !== 'string') return p;
    if (p === '/shared' || p.startsWith('/shared/')) return path.join(root, p);
    return p;
  };
  return {
    existsSync: (p) => fs.existsSync(map(p)),
    readFileSync: (p, enc) => {
      if (p !== 0) return fs.readFileSync(map(p), enc);
      if (socket) throw new Error('read stdin to EOF, which never comes on a CGI socket');
      return stdin;
    },
    readSync: (fd, buf, off, len) => {
      if (fd !== 0) throw new Error('readSync is only faked for stdin');
      if (pos >= bytes.length) {
        if (socket) throw new Error('read past CONTENT_LENGTH, which blocks forever on a CGI socket');
        return 0;
      }
      const n = Math.min(len, bytes.length - pos);
      bytes.copy(buf, off, pos, pos + n);
      pos += n;
      return n;
    },
    writeFileSync: (p, data) => fs.writeFileSync(map(p), data),
    renameSync: (a, b) => fs.renameSync(map(a), map(b)),
    unlinkSync: (p) => fs.unlinkSync(map(p)),
    mkdirSync: (p, o) => fs.mkdirSync(map(p), o),
    chmodSync: (p, m) => fs.chmodSync(map(p), m),
    readdirSync: (p) => fs.readdirSync(map(p)),
  };
}

export async function run(words, { env = {}, stdin = '', root, platform, socket = false } = {}) {
  const out = [];
  const err = [];
  const spawned = [];
  const proc = {
    argv: ['node', SCRIPT, ...words],
    env: { ...env },
    platform,
    cwd: () => root || '/tmp',
    exit: (code = 0) => {
      throw new NodeExitError(Number(code) || 0);
    },
    stdout: { isTTY: false, write: (s) => out.push(String(s)) },
    stderr: { isTTY: false, write: (s) => err.push(String(s)) },
  };
  const modules = {
    fs: mappedFs(root || '/nonexistent', stdin, socket),
    path,
    os: { homedir: () => env.HOME || '/nonexistent' },
    child_process: {
      spawnSync: (cmd, args, opts) => {
        spawned.push({ cmd, args, input: opts && opts.input });
        return { status: 0 };
      },
    },
  };
  const req = (name) => {
    const key = String(name).replace(/^node:/, '');
    if (key in modules) return modules[key];
    throw new Error(`unexpected require('${name}')`);
  };
  const cons = { log: (...a) => out.push(`${a.join(' ')}\n`), error: (...a) => err.push(`${a.join(' ')}\n`) };
  let exitCode = 0;
  try {
    await new AsyncFunction('require', 'module', 'exports', 'process', 'console', '__dirname', '__filename', SOURCE)(
      req,
      { exports: {} },
      {},
      proc,
      cons,
      path.dirname(SCRIPT),
      SCRIPT
    );
  } catch (e) {
    if (e && e.name === 'NodeExitError') exitCode = e.code;
    else {
      exitCode = 'threw';
      err.push(String((e && e.stack) || e));
    }
  }
  return { exitCode, stdout: out.join(''), stderr: err.join(''), spawned };
}

export function parseCgi(text) {
  const split = text.indexOf('\r\n\r\n');
  const head = text.slice(0, split).split('\r\n');
  const headers = {};
  for (const h of head) {
    const i = h.indexOf(':');
    headers[h.slice(0, i).toLowerCase()] = h.slice(i + 1).trim();
  }
  return { status: Number.parseInt(headers.status, 10), headers, body: JSON.parse(text.slice(split + 4)) };
}
