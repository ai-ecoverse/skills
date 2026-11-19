#!/usr/bin/env jsh
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = 'llm-wiki';
const HELP = `wiki — an Open Knowledge Format (OKF) knowledge base, with okf as its engine

USAGE
  wiki root                         the bundle root and where it came from
  wiki config [get|set|unset] [root] [path]
  wiki config path                  where the config file is
  wiki okf <command> [args...]      okf <command> <root> [args...], e.g. wiki okf validate
  wiki log <kind> <message...>      add "* **Kind**: message" under today in <root>/log.md
  wiki sprinkle [dir]               install the panel and its cgi-bin/ for the current root
  wiki cgi <concepts|show>          answer one CGI/1.1 request (used by the panel)

FLAGS
  --root <path>   the bundle root for this run (before or after the command)
  -h, --help      this text

ENVIRONMENT
  WIKI_ROOT       the bundle root, below --root
  WIKI_CONFIG     the config file (default ~/.config/wiki/config.json)
  OKF_BIN         the okf program (default okf on PATH)

OKF
  wiki okf and the panel run okf (https://github.com/okfcli/okf). In SLICC,
  this package's dependency @ai-ecoverse/wasi-okf provides it; elsewhere, put
  an okf build on PATH or set OKF_BIN. Without it they stop with "wiki: okf not
  found" (exit 127); root, config, log and sprinkle work without okf.

The root is --root, then WIKI_ROOT, then "root" in the config file. There is
no built-in default. Exit status: 0 ok, 1 error, 2 usage error, 127 no okf;
wiki okf exits with okf's status (1 validation, 2 I/O, 4 usage).`;

class Exit extends Error {
  constructor(code, message) {
    super(message || `exit ${code}`);
    this.name = 'WikiExit';
    this.code = code;
  }
}
const die = (msg, code = 1) => {
  throw new Exit(code, msg);
};

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

function configPath() {
  return process.env.WIKI_CONFIG || path.join(homeDir(), '.config', 'wiki', 'config.json');
}

function readConfig(warn) {
  const p = configPath();
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return {};
  }
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    warn(`wiki: ignoring ${p}: expected a JSON object`);
  } catch (e) {
    warn(`wiki: ignoring malformed ${p}: ${e.message}`);
  }
  return {};
}

function writeConfig(obj) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

function resolveRoot(flag, warn) {
  if (flag) return { root: path.resolve(flag), from: '--root' };
  if (process.env.WIKI_ROOT)
    return { root: path.resolve(process.env.WIKI_ROOT), from: 'WIKI_ROOT' };
  const cfg = readConfig(warn);
  if (typeof cfg.root === 'string' && cfg.root) return { root: cfg.root, from: configPath() };
  return null;
}

function requireRoot(flag, warn) {
  const r = resolveRoot(flag, warn);
  if (!r)
    die('wiki: no bundle root: run `wiki config set root <path>`, set WIKI_ROOT or pass --root');
  let st;
  try {
    st = fs.statSync(r.root);
  } catch {
    die(`wiki: the bundle root ${r.root} (from ${r.from}) does not exist`);
  }
  if (!st.isDirectory()) die(`wiki: the bundle root ${r.root} (from ${r.from}) is not a directory`);
  return r;
}

function okfBin() {
  return process.env.OKF_BIN || 'okf';
}

const OKF_MISSING = 127;

function okfMissing() {
  const where = process.env.OKF_BIN ? `OKF_BIN=${process.env.OKF_BIN}` : 'okf on PATH';
  return `wiki: okf not found (${where}). wiki okf and the panel need it; wiki root, config, log and sprinkle don't. In SLICC, install this skill with pnpm in /opt/user, which brings okf (@ai-ecoverse/wasi-okf), or run: cd /opt/user && pnpm add @ai-ecoverse/wasi-okf. Elsewhere, put an okf build (https://github.com/okfcli/okf) on PATH or set OKF_BIN to it.`;
}

function okf(args) {
  const r = spawnSync(okfBin(), args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT') die(okfMissing(), OKF_MISSING);
    die(`wiki: cannot run ${okfBin()}: ${r.error.message}`);
  }
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function okfJson(args) {
  const r = okf(args);
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {}
  return { ...r, data };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addLogEntry(text, kind, message, date) {
  const entry = `* **${kind}**: ${message}`;
  const lines = text ? text.replace(/\r\n/g, '\n').split('\n') : ['# Directory Update Log', ''];
  const firstDate = lines.findIndex((l) => /^## \d{4}-\d{2}-\d{2}\s*$/.test(l));
  if (firstDate >= 0 && lines[firstDate].trim() === `## ${date}`) {
    let end = firstDate + 1;
    while (end < lines.length && !/^## /.test(lines[end])) end++;
    let last = end - 1;
    while (last > firstDate && lines[last].trim() === '') last--;
    lines.splice(last + 1, 0, entry);
  } else {
    const title = lines.findIndex((l) => /^# /.test(l));
    const at = firstDate >= 0 ? firstDate : title + 1;
    const before = at > 0 && lines[at - 1].trim() !== '' ? [''] : [];
    const after = at < lines.length && lines[at].trim() !== '' ? [''] : [];
    lines.splice(at, 0, ...before, `## ${date}`, entry, ...after);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

function cmdLog(root, words) {
  const [kindRaw, ...rest] = words;
  if (!kindRaw || rest.length === 0) die('usage: wiki log <kind> <message...>', 2);
  if (!/^[A-Za-z][A-Za-z-]{0,31}$/.test(kindRaw))
    die(
      `wiki: a log kind is one word (Update, Creation, Deprecation, …), not ${JSON.stringify(kindRaw)}`,
      2
    );
  const kind = kindRaw[0].toUpperCase() + kindRaw.slice(1);
  const message = rest
    .join(' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  if (!message) die('usage: wiki log <kind> <message...>', 2);
  const file = path.join(root, 'log.md');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, addLogEntry(text, kind, message, today()));
  fs.renameSync(tmp, file);
  return file;
}

const CGI_ACTIONS = ['concepts', 'show'];

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function htmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function sprinkleDir(arg) {
  if (arg) return path.resolve(arg);
  if (fs.existsSync('/shared/sprinkles')) return path.join('/shared/sprinkles', NAME);
  return path.join(homeDir(), 'sprinkles', NAME);
}

function whichOkf() {
  const bin = okfBin();
  if (bin.includes('/')) {
    const abs = path.resolve(bin);
    return { bin: abs, found: fs.existsSync(abs) };
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && fs.existsSync(path.join(dir, bin))) return { bin: path.join(dir, bin), found: true };
  }
  return { bin, found: false };
}

function installSprinkle(dir, root, out, warn) {
  const script = path.resolve(__filename);
  const template = path.join(__dirname, '..', 'templates', `${NAME}.shtml`);
  const html = fs.readFileSync(template, 'utf8').replace('__ROOT__', () => htmlAttr(root));
  fs.mkdirSync(path.join(dir, 'cgi-bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${NAME}.shtml`), html);
  out(path.join(dir, `${NAME}.shtml`));
  const { bin, found } = whichOkf();
  for (const action of CGI_ACTIONS) {
    const target = path.join(dir, 'cgi-bin', action);
    fs.writeFileSync(
      target,
      [
        '#!/bin/sh',
        `WIKI_ROOT=${shQuote(root)}`,
        `OKF_BIN=${shQuote(bin)}`,
        'export WIKI_ROOT OKF_BIN',
        `if command -v jsh >/dev/null 2>&1; then exec jsh ${shQuote(script)} cgi ${action}; fi`,
        `exec node ${shQuote(script)} cgi ${action}`,
        '',
      ].join('\n')
    );
    try {
      fs.chmodSync(target, 0o755);
    } catch {}
    out(target);
  }
  if (!found)
    warn(`${okfMissing()} Until then the panel shows this message instead of the concepts.`);
}

const STATUS = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

function respond(write, status, body) {
  write(
    `Status: ${status} ${STATUS[status] || ''}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Wiki: 1\r\n\r\n${JSON.stringify(body)}\n`
  );
}

function crossSite() {
  const site = process.env.HTTP_SEC_FETCH_SITE;
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = process.env.HTTP_ORIGIN;
  const host = process.env.HTTP_HOST;
  if (origin && host) {
    try {
      return new URL(origin).host !== host;
    } catch {
      return true;
    }
  }
  return false;
}

function query() {
  const q = new URLSearchParams(process.env.QUERY_STRING || '');
  const get = (k) => (q.get(k) || '').trim().slice(0, 200);
  return { text: get('text'), type: get('type'), tag: get('tag'), id: get('id') };
}

function validId(id) {
  return (
    /^[^/\0][^\0]*$/.test(id) &&
    !id.split('/').some((s) => s === '..' || s === '.' || s === '') &&
    id.length <= 512
  );
}

function frontmatterBits(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    text = buf.subarray(0, n).toString('utf8');
  } catch {
    return {};
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  const unq = (s) => s.trim().replace(/^(["'])(.*)\1$/, '$2');
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(description|tags|status):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'tags') {
      const f = /^\[(.*)\]\s*$/.exec(kv[2]);
      if (f) out.tags = f[1].split(',').map(unq).filter(Boolean);
    } else if (kv[2] && !/^[|>]/.test(kv[2])) out[kv[1]] = unq(kv[2]);
  }
  return out;
}

function cgiConcepts(root, write) {
  const { text, type, tag } = query();
  const args = ['search', root];
  if (text) args.push('--text', text);
  if (type) args.push('--type', type);
  if (tag) args.push('--tag', tag);
  const r = okfJson(args);
  if (r.status !== 0 || !r.data) return respond(write, 502, { ok: false, error: okfError(r) });
  const types = okfJson(['search', root]);
  const concepts = (r.data.results || []).map((c) => ({
    ...c,
    ...frontmatterBits(path.join(root, `${c.id}.md`)),
  }));
  const allTypes = [
    ...new Set(((types.data && types.data.results) || []).map((c) => c.type).filter(Boolean)),
  ].sort();
  respond(write, 200, { ok: true, root, filters: { text, type, tag }, types: allTypes, concepts });
}

function cgiShow(root, write) {
  const id = (process.env.PATH_INFO || '').replace(/^\/+/, '') || query().id;
  if (!id) return respond(write, 400, { ok: false, error: 'no concept id' });
  if (!validId(id)) return respond(write, 400, { ok: false, error: `not a concept id: ${id}` });
  const r = okfJson(['show', root, id]);
  if (r.status !== 0 || !r.data) {
    const e = r.data && r.data.error;
    const status = e && (e.code === 404 || /^concept not found/.test(e.message || '')) ? 404 : 502;
    return respond(write, status, { ok: false, error: okfError(r) });
  }
  const b = okfJson(['backlinks', root, id]);
  respond(write, 200, {
    ok: true,
    concept: r.data.concept,
    backlinks: (b.data && b.data.backlinks) || [],
  });
}

function okfError(r) {
  const e = r.data && r.data.error;
  if (e && e.message) return e.message;
  return (r.stderr || r.stdout || `okf exited ${r.status}`).trim().split('\n')[0];
}

function cgi(action, write) {
  if (!CGI_ACTIONS.includes(action))
    return respond(write, 404, { ok: false, error: `no such action: ${action}` });
  if ((process.env.REQUEST_METHOD || 'GET') !== 'GET')
    return respond(write, 405, { ok: false, error: `${action} answers GET` });
  if (crossSite()) return respond(write, 403, { ok: false, error: 'cross-site request refused' });
  const r = resolveRoot(null, () => {});
  if (!r || !fs.existsSync(r.root))
    return respond(write, 500, {
      ok: false,
      error: 'the bundle root is not set or does not exist; run wiki sprinkle again',
    });
  try {
    if (action === 'concepts') return cgiConcepts(r.root, write);
    return cgiShow(r.root, write);
  } catch (e) {
    if (e instanceof Exit) return respond(write, 500, { ok: false, error: e.message });
    return respond(write, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

function takeRoot(argv) {
  const out = [];
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      if (i + 1 >= argv.length) die('wiki: --root needs a path', 2);
      root = argv[++i];
    } else if (argv[i].startsWith('--root=')) root = argv[i].slice(7);
    else out.push(argv[i]);
  }
  return { args: out, root };
}

function main(argv, io) {
  const { out, err } = io;
  const warn = (s) => err(`${s}\n`);
  const { args, root: rootFlag } = takeRoot(argv);
  const [cmd, ...rest] = args;
  if (
    !cmd ||
    cmd === 'help' ||
    cmd === '-h' ||
    cmd === '--help' ||
    (cmd !== 'okf' && rest.some((a) => a === '-h' || a === '--help'))
  ) {
    out(`${HELP}\n`);
    return 0;
  }
  if (cmd === 'cgi') {
    cgi(rest[0], (s) => io.raw(s));
    return 0;
  }
  if (cmd === 'root') {
    const r = resolveRoot(rootFlag, warn);
    if (!r)
      die('wiki: no bundle root: run `wiki config set root <path>`, set WIKI_ROOT or pass --root');
    out(`${r.root}\t${r.from}\n`);
    return 0;
  }
  if (cmd === 'config') {
    const [op = 'get', key = 'root', value] = rest;
    if (op === 'path') {
      out(`${configPath()}\n`);
      return 0;
    }
    if (key !== 'root') die(`wiki: unknown config key ${JSON.stringify(key)} (only root)`, 2);
    if (op === 'get') {
      const cfg = readConfig(warn);
      if (typeof cfg.root !== 'string' || !cfg.root) return 1;
      out(`${cfg.root}\n`);
      return 0;
    }
    if (op === 'set') {
      if (!value) die('usage: wiki config set root <path>', 2);
      const abs = path.resolve(value);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        die(`wiki: ${abs} does not exist`);
      }
      if (!st.isDirectory()) die(`wiki: ${abs} is not a directory`);
      writeConfig({ ...readConfig(warn), root: abs });
      out(`${abs}\n`);
      return 0;
    }
    if (op === 'unset') {
      const cfg = readConfig(warn);
      delete cfg.root;
      writeConfig(cfg);
      return 0;
    }
    die(`wiki: unknown config operation ${JSON.stringify(op)}`, 2);
  }
  if (cmd === 'okf') {
    const [sub, ...more] = rest;
    if (!sub) die('usage: wiki okf <command> [args...]', 2);
    const noBundle = new Set(['version', 'schema', 'help', '--help', '-h']);
    const r = noBundle.has(sub)
      ? okf([sub, ...more])
      : okf([sub, requireRoot(rootFlag, warn).root, ...more]);
    if (r.stdout) out(r.stdout);
    if (r.stderr) err(r.stderr);
    return r.status;
  }
  if (cmd === 'log') {
    const file = cmdLog(requireRoot(rootFlag, warn).root, rest);
    out(`${file}\n`);
    return 0;
  }
  if (cmd === 'sprinkle') {
    const r = requireRoot(rootFlag, warn);
    installSprinkle(sprinkleDir(rest[0]), r.root, (s) => out(`${s}\n`), warn);
    return 0;
  }
  die(`wiki: unknown command ${JSON.stringify(cmd)}\nRun 'wiki --help' for usage.`, 2);
}

let code;
const chunks = { out: [], err: [] };
try {
  code = main(process.argv.slice(2), {
    out: (s) => chunks.out.push(s),
    err: (s) => chunks.err.push(s),
    raw: (s) => chunks.out.push(s),
  });
} catch (e) {
  if (e && e.name === 'NodeExitError') throw e;
  if (e instanceof Exit) {
    chunks.err.push(`${e.message}\n`);
    code = e.code;
  } else {
    chunks.err.push(`wiki: ${(e && e.stack) || e}\n`);
    code = 1;
  }
}
if (chunks.out.length) process.stdout.write(chunks.out.join(''));
if (chunks.err.length) process.stderr.write(chunks.err.join(''));
process.exitCode = code;
