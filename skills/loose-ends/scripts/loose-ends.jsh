#!/usr/bin/env jsh
const fs = require('fs');
const path = require('path');

const USAGE = `loose-ends — a plain to-do list for open follow-ups, kept in one JSON file

USAGE
  loose-ends [ls] [-a] [--snoozed] [--done] [--json]   open items, one per line: id<TAB>title
  loose-ends add <title…> [-s summary] [-d detail] [-u url] [-t tag,…] [--snooze when] [--id id]
  loose-ends show <id> [--json]
  loose-ends edit <id> [--title t] [-s …] [-d …] [-u …] [-t …]
  loose-ends done <id>…          mark done (kept; ls --done lists them)
  loose-ends reopen <id>…        undo done
  loose-ends snooze <id> <when>  tomorrow, monday…sunday, week, +3d, +2w, YYYY-MM-DD (09:00 local)
  loose-ends wake <id>…          end a snooze
  loose-ends rm <id>…            delete for good
  loose-ends monday [--limit N]  open items as JSON for the monday dispatcher
  loose-ends path                the store's path
  loose-ends sprinkle [dir]      install the SLICC panel and its cgi-bin/ into dir
  loose-ends cgi <action>        answer one CGI/1.1 request (used by the panel's cgi-bin/)

An <id> is any unique prefix of an id, with or without "le-". "-d -" reads the
detail from stdin. Commands that change items print the ids they changed.

STORE
  $LOOSE_ENDS_FILE, else %LOCALAPPDATA%\\loose-ends\\loose-ends.json on Windows, else
  $XDG_DATA_HOME/loose-ends/loose-ends.json (default ~/.local/share/loose-ends/).
  A SLICC 6 store at /shared/loose-ends.json is used while the default store does not exist.

EXIT STATUS
  0 ok, 1 error (unknown or ambiguous id, unreadable store), 2 usage error`;

class UsageError extends Error {}

const LEGACY_STORE = '/shared/loose-ends.json';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT = { s: 'summary', d: 'detail', u: 'url', t: 'tags', a: 'all', h: 'help', n: 'limit' };
const BOOL = new Set(['all', 'json', 'snoozed', 'done', 'help']);
const CGI_ACTIONS = ['items', 'done', 'reopen', 'snooze', 'wake'];
const env = process.env || {};

function homeDir() {
  if (env.HOME) return env.HOME;
  if (env.USERPROFILE) return env.USERPROFILE;
  return require('os').homedir();
}

function storePath() {
  if (env.LOOSE_ENDS_FILE) return env.LOOSE_ENDS_FILE;
  if (process.platform === 'win32' && env.LOCALAPPDATA)
    return path.join(env.LOCALAPPDATA, 'loose-ends', 'loose-ends.json');
  const data = env.XDG_DATA_HOME || path.join(homeDir(), '.local', 'share');
  const file = path.join(data, 'loose-ends', 'loose-ends.json');
  if (!fs.existsSync(file) && fs.existsSync(LEGACY_STORE)) return LEGACY_STORE;
  return file;
}

function readStore(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { version: 1, updated: null, tasks: [] };
    if (!fs.existsSync(file)) return { version: 1, updated: null, tasks: [] };
    throw e;
  }
  let store;
  try {
    store = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}); fix or move it`);
  }
  if (Array.isArray(store)) store = { tasks: store };
  if (!store || !Array.isArray(store.tasks)) throw new Error(`${file} has no "tasks" array`);
  return store;
}

function writeStore(file, store) {
  store.version = 1;
  store.updated = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    let key;
    let val;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) val = a.slice(eq + 1);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      key = SHORT[a[1]];
      if (!key) throw new UsageError(`unknown option ${a}`);
    } else {
      opts._.push(a);
      continue;
    }
    if (BOOL.has(key)) {
      opts[key] = true;
      continue;
    }
    if (val === undefined) {
      if (i + 1 >= argv.length) throw new UsageError(`--${key} needs a value`);
      val = argv[++i];
    }
    opts[key] = val;
  }
  return opts;
}

function slug(s) {
  const out = String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
  return out || 'item';
}

function newId(title, tasks) {
  const base = `le-${slug(title)}`;
  let id = base;
  for (let n = 2; tasks.some((t) => t.id === id); n++) id = `${base}-${n}`;
  return id;
}

class LookupError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function find(tasks, ref) {
  if (!ref) throw new UsageError('an id is required (see loose-ends ls)');
  const exact = tasks.find((t) => t.id === ref || t.id === `le-${ref}`);
  if (exact) return exact;
  const hits = tasks.filter((t) => t.id.startsWith(ref) || t.id.startsWith(`le-${ref}`));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new LookupError(`no loose end matches '${ref}'`, 404);
  throw new LookupError(
    `'${ref}' matches ${hits.length} loose ends: ${hits.map((t) => t.id).join(', ')}`,
    409
  );
}

function parseWhen(when, now = new Date()) {
  const w = String(when || '')
    .trim()
    .toLowerCase();
  const d = new Date(now);
  const at9 = () => {
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };
  if (w === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return at9();
  }
  if (w === 'week' || w === 'next-week' || w === '1w') {
    d.setDate(d.getDate() + 7);
    return at9();
  }
  let m = /^\+(\d{1,3})([dw])$/.exec(w);
  if (m) {
    d.setDate(d.getDate() + Number(m[1]) * (m[2] === 'w' ? 7 : 1));
    return at9();
  }
  const day = DAYS.findIndex((x) => x === w || x.slice(0, 3) === w);
  if (day >= 0) {
    d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7 || 7));
    return at9();
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (m) {
    d.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return at9();
  }
  throw new UsageError(
    `can't read the time '${when}' (use tomorrow, monday…sunday, week, +3d, YYYY-MM-DD)`
  );
}

const isDone = (t) => !!t.done;
const isSnoozed = (t, now = Date.now()) =>
  !isDone(t) && !!t.snoozedUntil && Date.parse(t.snoozedUntil) > now;
const isOpen = (t) => !isDone(t) && !isSnoozed(t);
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10);
};

function filingCone() {
  if (env.SLICC_AGENT) return String(env.SLICC_AGENT).split(':').pop();
  const parts = String(env.TMPDIR || '')
    .split('/')
    .filter(Boolean);
  const i = parts.indexOf('tmp');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : undefined;
}

function setFields(opts, task) {
  if (opts.title !== undefined) task.title = String(opts.title);
  if (opts.summary !== undefined) task.summary = String(opts.summary);
  if (opts.detail !== undefined)
    task.detail = opts.detail === '-' ? readStdin() : String(opts.detail);
  if (opts.url !== undefined) {
    if (opts.url) task.url = String(opts.url);
    else delete task.url;
  }
  if (opts.tags !== undefined)
    task.skills = String(opts.tags)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (opts.snooze !== undefined) task.snoozedUntil = parseWhen(opts.snooze);
  return task;
}

function readStdin() {
  return fs.readFileSync(0, 'utf8').replace(/\n$/, '');
}

function line(t) {
  const tags = t.skills && t.skills.length ? `  [${t.skills.join(',')}]` : '';
  let state = '';
  if (isDone(t)) state = `  (done ${day(t.done)})`;
  else if (isSnoozed(t)) state = `  (snoozed until ${day(t.snoozedUntil)})`;
  return `${t.id}\t${t.title || ''}${tags}${state}`;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function htmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function sprinkleDir(arg) {
  if (arg) return path.resolve(arg);
  if (fs.existsSync('/shared/sprinkles')) return '/shared/sprinkles/loose-ends';
  return path.join(homeDir(), 'sprinkles', 'loose-ends');
}

function installSprinkle(dir, file, out) {
  const script = path.resolve(__filename);
  const template = path.join(__dirname, '..', 'templates', 'loose-ends.shtml');
  const html = fs.readFileSync(template, 'utf8').replace('__STORE__', htmlAttr(path.resolve(file)));
  fs.mkdirSync(path.join(dir, 'cgi-bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'loose-ends.shtml'), html);
  out(path.join(dir, 'loose-ends.shtml'));
  for (const action of CGI_ACTIONS) {
    const target = path.join(dir, 'cgi-bin', action);
    fs.writeFileSync(
      target,
      [
        '#!/bin/sh',
        `LOOSE_ENDS_FILE=${shQuote(path.resolve(file))}`,
        'export LOOSE_ENDS_FILE',
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
  const flat = path.join(path.dirname(dir), 'loose-ends.shtml');
  if (path.basename(dir) === 'loose-ends' && fs.existsSync(flat)) {
    const old = fs.readFileSync(flat, 'utf8');
    if (old.includes('name="loose-ends-store"')) {
      fs.unlinkSync(flat);
      out(`removed ${flat}`);
    }
  }
}

function cgiBody() {
  const length = Number.parseInt(env.CONTENT_LENGTH || '0', 10);
  if (!Number.isFinite(length) || length <= 0) return {};
  if (length > 65536) throw new LookupError('request body too large', 413);
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(0, buf, got, length - got, null);
    if (!n) break;
    got += n;
  }
  const text = buf.toString('utf8', 0, got);
  const type = String(env.CONTENT_TYPE || '').toLowerCase();
  if (type.startsWith('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(text));
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    throw new LookupError('the body is not JSON', 400);
  }
}

function notifyOwner(action, task) {
  const owner = env.SLICC_OWNER;
  if (!owner || !/^[A-Za-z0-9:._-]{1,64}$/.test(owner)) return;
  try {
    require('child_process').spawnSync(
      'agent',
      ['send', owner, '--lick=sprinkle', '--source', 'loose-ends', '-'],
      {
        input: `${action} ${task.id}: ${task.title}`,
        timeout: 5000,
        stdio: ['pipe', 'ignore', 'ignore'],
      }
    );
  } catch {}
}

function cgi(action, file, write) {
  const reply = (status, body) => {
    const reason = { 200: 'OK', 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Payload Too Large', 500: 'Internal Server Error' }[status];
    write(
      `Status: ${status} ${reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nX-Loose-Ends: 2\r\n\r\n${JSON.stringify(body)}\n`
    );
    return 0;
  };
  const method = String(env.REQUEST_METHOD || 'GET').toUpperCase();
  if (!CGI_ACTIONS.includes(action)) return reply(404, { ok: false, error: `no action '${action}'` });
  const wants = action === 'items' ? 'GET' : 'POST';
  if (method !== wants) return reply(405, { ok: false, error: `${action} takes ${wants}` });
  try {
    const store = readStore(file);
    if (action === 'items') return reply(200, { ok: true, updated: store.updated, tasks: store.tasks });
    const body = cgiBody();
    const task = find(store.tasks, typeof body.id === 'string' ? body.id : '');
    if (action === 'done') task.done = new Date().toISOString();
    else if (action === 'reopen') delete task.done;
    else if (action === 'wake') delete task.snoozedUntil;
    else task.snoozedUntil = parseWhen(body.when);
    writeStore(file, store);
    notifyOwner(action, task);
    return reply(200, { ok: true, id: task.id, updated: store.updated, tasks: store.tasks });
  } catch (e) {
    if (e && e.name === 'NodeExitError') throw e;
    if (e instanceof UsageError) return reply(400, { ok: false, error: e.message });
    if (e instanceof LookupError) return reply(e.status, { ok: false, error: e.message });
    return reply(500, { ok: false, error: String((e && e.message) || e) });
  }
}

function main(argv) {
  const out = (s) => process.stdout.write(`${s}\n`);
  const opts = parseArgs(argv);
  const cmd = opts._.shift() || 'ls';
  const args = opts._;
  if (opts.help || cmd === 'help') {
    out(USAGE);
    return 0;
  }
  const file = storePath();
  if (cmd === 'path') {
    out(file);
    return 0;
  }
  if (cmd === 'sprinkle') {
    installSprinkle(sprinkleDir(args[0]), file, out);
    return 0;
  }
  if (cmd === 'cgi') return cgi(args[0], file, (s) => process.stdout.write(s));

  const store = readStore(file);
  const tasks = store.tasks;
  const save = () => writeStore(file, store);

  switch (cmd) {
    case 'ls':
    case 'list': {
      let rows = tasks.filter(isOpen);
      if (opts.all) rows = tasks;
      else if (opts.snoozed || opts.done)
        rows = tasks.filter((t) => (opts.snoozed && isSnoozed(t)) || (opts.done && isDone(t)));
      if (opts.json) out(JSON.stringify(rows, null, 2));
      else for (const t of rows) out(line(t));
      return 0;
    }
    case 'add':
    case 'create': {
      const title = String(opts.title || args.join(' '));
      if (!title.trim()) throw new UsageError('add: a title is required');
      if (opts.id && tasks.some((t) => t.id === opts.id))
        throw new Error(`'${opts.id}' already exists (use edit)`);
      const task = {
        id: opts.id ? String(opts.id) : newId(title, tasks),
        title,
        summary: '',
        detail: '',
        created: new Date().toISOString(),
        skills: [],
      };
      const cone = opts.cone ? String(opts.cone) : filingCone();
      if (cone) task.cone = cone;
      setFields({ ...opts, title: undefined }, task);
      tasks.push(task);
      save();
      out(task.id);
      return 0;
    }
    case 'show': {
      const t = find(tasks, args[0]);
      if (opts.json) {
        out(JSON.stringify(t, null, 2));
        return 0;
      }
      out(line(t));
      for (const k of ['summary', 'detail', 'url']) if (t[k]) out(`\n${k}:\n${t[k]}`);
      const meta = [
        ['created', t.created],
        ['cone', t.cone],
        ['snoozed until', t.snoozedUntil],
        ['done', t.done],
      ].filter(([, v]) => v);
      if (meta.length) out(`\n${meta.map(([k, v]) => `${k}: ${v}`).join('\n')}`);
      return 0;
    }
    case 'edit': {
      const t = find(tasks, args[0]);
      setFields(opts, t);
      save();
      out(t.id);
      return 0;
    }
    case 'done':
    case 'reopen':
    case 'wake':
    case 'unsnooze':
    case 'rm':
    case 'remove': {
      if (!args.length) throw new UsageError(`${cmd}: an id is required (see loose-ends ls)`);
      const hits = args.map((ref) => find(tasks, ref));
      for (const t of hits) {
        if (cmd === 'done') t.done = new Date().toISOString();
        else if (cmd === 'reopen') delete t.done;
        else if (cmd === 'wake' || cmd === 'unsnooze') delete t.snoozedUntil;
        else if (tasks.includes(t)) tasks.splice(tasks.indexOf(t), 1);
        out(t.id);
      }
      save();
      return 0;
    }
    case 'snooze': {
      if (args.length !== 2) throw new UsageError('snooze: usage: loose-ends snooze <id> <when>');
      const t = find(tasks, args[0]);
      t.snoozedUntil = parseWhen(args[1]);
      save();
      out(`${t.id}\t${t.snoozedUntil}`);
      return 0;
    }
    case 'monday': {
      const n = Number(opts.limit);
      const limit = Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
      const items = tasks
        .filter(isOpen)
        .slice(0, limit)
        .map((t) => ({
          id: t.id,
          ts: t.created,
          source: 'loose-ends',
          title: t.title,
          body: t.summary || '',
          detail: t.detail || '',
          skills: t.skills || [],
          session: t.session,
          rating_hint:
            'User-curated follow-up with real intent; actionable unless the summary says it waits on someone else.',
        }));
      out(JSON.stringify(items, null, 2));
      return 0;
    }
    default:
      throw new UsageError(`unknown command '${cmd}'`);
  }
}

let code = 0;
try {
  code = main(process.argv.slice(2));
} catch (e) {
  if (e && e.name === 'NodeExitError') throw e;
  process.stderr.write(`loose-ends: ${(e && e.message) || e}\n`);
  if (e instanceof UsageError) process.stderr.write("try 'loose-ends --help'\n");
  code = e instanceof UsageError ? 2 : 1;
}
process.exit(code);
