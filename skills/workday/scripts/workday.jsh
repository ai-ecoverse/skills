#!/usr/bin/env jsh

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wd = require('./lib/workday.js');

const PREFIX = 'workday';

const HELP = `
workday — the Workday org chart from your browser session

USAGE
  workday whoami                     You: name, title, manager, org
  workday find <name>                People whose name matches (up to 10)
  workday person [<name|id>]         One person's title, email, location, managers, org
  workday orgchart [<name|id>]       Management chain, team and direct reports
                                     (default: you)
  workday org <org-id>               One organization: owner, parent, members
  workday lookup                     Resolve names from stdin (one per line) to
                                     id, title, org, location, manager
  workday tree <name|id>             Everyone below a person or an org (247$… or
                                     2500$…), with their top-level group
  workday cache [info]               Cache entries, size and location
  workday cache clear                Empty the cache

FLAGS
  --json        Output JSON (lookup: stdin is a JSON array of objects with a "name")
  --chain N     orgchart: show at most N managers above the person (default: all)
  --depth N     tree: expand at most N levels (default: all)
  --max-age D   Reuse cached answers up to D old: 90s, 15m, 1h, 2d (default: 24h)
  --fresh       Ignore the cache for reading and refresh it
  --gap D       lookup, tree: wait D between requests (default: 1s)
  --retry-wait D  First wait after "Too many repeating requests" (default: 15s;
                doubles each retry, 4 tries)
  Put flags after the names: a flag may take the next word as its value.

CACHE
  Answers are kept per tenant in ~/.cache/workday/<host>_<tenant>.json (or in
  $WORKDAY_CACHE_DIR). No cookies, tokens or headers are stored.

IDS
  Workers are 247$…, supervisory organizations 2500$…; every listing prints
  them as id:… so you can pass them on. Quote them in a shell: '247$1001'.

REQUIRES
  A signed-in Workday tab (https://<host>.myworkday.com/<tenant>/…) in your browser.
  On a host: Chrome with a DevTools port, found automatically (or set SLICC_CDP_URL).
`.trim();

// On a host, sliccy-browser finds Chrome itself when SLICC_CDP_URL is unset.
// When it can't, its error spans several lines and says "Pass --cdp", which
// this CLI has no flag for; turn that into one line.
function cdpFailureHint(err) {
  const message = String((err && err.message) || err || '');
  const cdp = /^(no debugger is connected|CDP connection (failed|timed out)|unsupported CDP URL|json\/version)/;
  if (!cdp.test(message) && !message.includes('does not launch Chrome')) return null;
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const env = (process.env && process.env.SLICC_CDP_URL) || '';
  if (env.trim()) {
    return `cannot reach Chrome DevTools at SLICC_CDP_URL=${env.trim()} (${lines[0]}); check that Chrome is listening there, or unset SLICC_CDP_URL to find it automatically`;
  }
  const tried = lines.filter((l) => l.startsWith('- ') && l !== '- SLICC_CDP_URL: not set').map((l) => l.slice(2));
  return `cannot find Chrome DevTools (tried ${tried.length ? tried.join('; ') : lines[0]}); start Chrome with --remote-debugging-port=9222, or set SLICC_CDP_URL=http://127.0.0.1:<port>`;
}

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;
const words = positional.join(' ').trim();

const SIGN_IN = 'sign in to Workday in your browser, then retry';

// ── settings ──────────────────────────────────────────────────────────
function duration(name, fallback) {
  if (flags[name] === undefined) return fallback;
  const ms = wd.parseDuration(flags[name]);
  if (ms === null) cli.die(`--${name} needs a duration such as 500ms, 15s, 1h or 2d, not "${flags[name]}"`, { prefix: PREFIX });
  return ms;
}
const DAY = 86400000;
const MAX_TRIES = 4;
const BULK = subcommand === 'lookup' || subcommand === 'tree';
const maxAge = duration('max-age', DAY);
const retryWait = duration('retry-wait', 15000);
const gap = duration('gap', BULK ? 1000 : 0);
const fresh = flags.fresh === true || flags.fresh === 'true';

// ── session ───────────────────────────────────────────────────────────
let _site = null;
async function site() {
  if (_site) return _site;
  const tab = await browser.findTab({ urlMatch: /^https:\/\/[^/]+\.myworkday\.com\/(?!wday\/)[A-Za-z0-9_-]+\// });
  if (!tab) cli.die(`open Workday (https://<host>.myworkday.com/<tenant>/d/home.htmld) and ${SIGN_IN}`, { prefix: PREFIX });
  const t = wd.tenantFromUrl(tab.url);
  if (!t) cli.die(`cannot tell the Workday tenant from ${tab.url}; open your Workday home page`, { prefix: PREFIX });
  _site = { tab, ...t };
  return _site;
}

// One wrapper, so every command reports an expired session the same way.
// Workday answers many errors with 200 and an XML or HTML body.
let sent = false;
async function call(path, { method = 'GET', form } = {}) {
  const s = await site();
  const opts = { method, headers: { Accept: 'application/json' } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  if (gap && sent) await wd.sleep(gap);
  sent = true;
  let wait = retryWait;
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await browser.fetch(s.tab, `${s.origin}${path}`, opts);
    if (res.status === 401 || res.status === 403) cli.die(`session expired — ${SIGN_IN}`, { prefix: PREFIX });
    if (!wd.isRateLimited(res.body)) break;
    if (attempt >= MAX_TRIES) {
      cli.die(`Workday is rate limiting this session ("Too many repeating requests") and still refused after ${MAX_TRIES} tries; wait a few minutes, then retry (answers already fetched are cached)`, { prefix: PREFIX });
    }
    cli.warn(`Workday: too many requests; waiting ${Math.round(wait / 1000)}s (try ${attempt + 1} of ${MAX_TRIES})`);
    await wd.sleep(wait);
    wait *= 2;
  }
  const problem = wd.workdayError(res.body);
  if (problem && problem.kind === 'html') {
    cli.die(`Workday returned a page instead of data for ${path} (HTTP ${res.status}); your session may have expired — ${SIGN_IN}`, { prefix: PREFIX });
  }
  if (problem) cli.die(`Workday said: ${problem.message} (${path})`, { prefix: PREFIX });
  if (!res.ok) cli.die(`Workday returned HTTP ${res.status} for ${path}`, { prefix: PREFIX });
  if (typeof res.body === 'string') {
    try {
      return JSON.parse(res.body);
    } catch (_) {
      cli.die(`Workday returned something other than JSON for ${path}`, { prefix: PREFIX });
    }
  }
  return res.body;
}

// ── cache ─────────────────────────────────────────────────────────────
// One JSON file per tenant. It holds parsed answers (search results, profiles,
// team pages, assembled orgs) under a key, each with the time it was stored.
// Errors never get here: call() dies before a result exists. Chunk URLs are
// server-side cursors, so they are never stored.
const CACHE_VERSION = 1;
const KEEP = 30 * DAY;
const cacheDir = () => process.env.WORKDAY_CACHE_DIR || path.join(os.homedir(), '.cache', 'workday');
let _cache = null;
const touched = new Set();
async function cacheLoad() {
  if (_cache) return _cache;
  const s = await site();
  const file = path.join(cacheDir(), wd.cacheFileName(s.origin, s.tenant));
  let entries = {};
  try {
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    if (data && data.version === CACHE_VERSION && data.entries && typeof data.entries === 'object') entries = data.entries;
  } catch (_) {
    // missing or damaged: start empty
  }
  _cache = { file, entries, dirty: 0 };
  return _cache;
}
async function cacheSave() {
  if (!_cache || !_cache.dirty) return;
  const now = Date.now();
  for (const [k, e] of Object.entries(_cache.entries)) if (!(e && now - e.at <= KEEP)) delete _cache.entries[k];
  const s = await site();
  // The cache holds directory data (names, titles, emails, managers): private to this user.
  await fs.promises.mkdir(path.dirname(_cache.file), { recursive: true, mode: 0o700 });
  const tmp = `${_cache.file}.${process.pid || 0}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, host: new URL(s.origin).hostname, tenant: s.tenant, entries: _cache.entries }), { mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, _cache.file);
  _cache.dirty = 0;
}
// Answer from the cache, else produce it. A result of undefined/null is not stored.
async function cached(key, produce, { store = () => true } = {}) {
  const c = await cacheLoad();
  const hit = c.entries[key];
  // --fresh refetches once per run: a key stored in this run is reused.
  if ((!fresh || touched.has(key)) && wd.entryFresh(hit, Date.now(), maxAge)) return hit.value;
  const value = await produce();
  if (value !== undefined && value !== null && store(value)) {
    c.entries[key] = { at: Date.now(), value };
    touched.add(key);
    if (++c.dirty >= 25) await cacheSave();
  }
  return value;
}

const inst = (s, id) => `/${s.tenant}/inst/autocompletesearch/${id}.htmld`;

async function me() {
  const s = await site();
  const user = wd.currentUser(await call(`/${s.tenant}/home.htmld`));
  if (!user) cli.die(`cannot tell who is signed in to Workday; ${SIGN_IN}`, { prefix: PREFIX });
  return user;
}

async function search(query) {
  const s = await site();
  const q = new URLSearchParams({ q: query, autocomplete: 'true' }).toString();
  return cached(`search:${query}`, async () => wd.searchPeople(await call(`/${s.tenant}/search.htmld?${q}`)));
}

// <name|id> → { id, name }; no argument means the signed-in user.
async function resolve(who) {
  if (!who) return me();
  if (/^247\$\d+$/.test(who)) return { id: who, name: '' };
  if (wd.INSTANCE_ID.test(who)) cli.die(`${who} is not a worker id (247$…); for an organization use: workday org '${who}'`, { prefix: PREFIX });
  const pick = wd.choosePerson(who, await search(who));
  if (pick.person) return pick.person;
  const list = (pick.candidates || []).map((p) => `  ${p.name}  ${p.title}  ${p.org}  id:${p.id}`).join('\n');
  cli.die(list ? `${pick.error}:\n${list}` : pick.error, { prefix: PREFIX });
}

async function profileOrNull(person) {
  const s = await site();
  return cached(`profile:${person.id}`, async () => {
    const p = wd.parseProfile(await call(inst(s, person.id)));
    return p ? { ...p, id: p.id || person.id } : null;
  });
}

async function profile(person) {
  const p = await profileOrNull(person);
  if (!p) cli.die(`no Workday profile for ${person.name || person.id}`, { prefix: PREFIX });
  return p;
}

// One organization with every member. Workday sends the first page of
// members with the org; the rest come from a chunk URL that is only good
// right after that request, so page through it at once. The assembled list
// is what gets cached (without the chunk URL). `team` may be a function, so
// a cached org needs no request at all.
const CHUNK = 50;
const MAX_CHUNKS = 400;
async function loadOrg(orgId, team) {
  return cached(`org:${orgId}`, async () => {
    const t = typeof team === 'function' ? await team() : team;
    const nav = wd.parseNavigator(await call(`${t.navigationPath}/${orgId}.htmld`, {
      method: 'POST',
      form: { 'initial-step': t.taskId },
    }));
    if (!nav) cli.die(`Workday sent no org chart for ${orgId}`, { prefix: PREFIX });
    for (let i = 0; nav.chunkPath && nav.children.length < nav.total; i++) {
      if (i >= MAX_CHUNKS) break;
      const page = wd.parseChunk(await call(`${nav.chunkPath}.htmld?startRow=${nav.children.length}&maxRows=${CHUNK}`));
      if (!page || !page.children.length) break;
      nav.children.push(...page.children);
    }
    nav.incomplete = nav.children.length < nav.total;
    if (nav.incomplete) cli.warn(`${orgId}: listed ${nav.children.length} of ${nav.total} members`);
    return { ...nav, chunkPath: null };
  }, { store: (nav) => !nav.incomplete });
}

// The View Team page also carries the task id and URL the org chart needs.
async function teamPage(p) {
  if (!p.teamPath) cli.die(`Workday shows no team for ${p.name || p.id}`, { prefix: PREFIX });
  const team = await cached(`team:${p.teamPath}`, async () => {
    const t = wd.parseTeamPage(await call(`${p.teamPath}.htmld`));
    return t && t.orgId && t.taskId && t.navigationPath ? t : null;
  });
  if (!team) cli.die(`Workday's team page for ${p.name || p.id} has no org chart`, { prefix: PREFIX });
  return team;
}

// Any org: the task id and URL come from the signed-in user's team page.
let _defaultTeam = null;
async function defaultTeam() {
  if (!_defaultTeam) _defaultTeam = await teamPage(await profile(await me()));
  return _defaultTeam;
}

// ── output ────────────────────────────────────────────────────────────
const id = (v) => color.dim(`id:${v}`);
const heading = (text) => console.log(`\n  ${color.bold(text)}`);
function rows(list, mark) {
  if (!list.length) {
    console.log(color.dim('    none'));
    return;
  }
  const body = list.map((n) => {
    const name = n.kind === 'org' ? `${n.owners.map((o) => o.name).join(', ') || n.name}` : n.name;
    const what = n.kind === 'org' ? color.dim(`leads a team${n.size ? ` of ${n.size}` : ''}`) : n.location;
    return [`${mark && mark(n) ? color.cyan('▸ ') : '  '}${name}`, fmt.trunc(n.title, 60), what, id(n.kind === 'org' && n.owners[0] ? n.owners[0].id : n.id)];
  });
  console.log(fmt.table(body).split('\n').map((l) => `  ${l}`).join('\n'));
}

// ── commands ──────────────────────────────────────────────────────────
async function cmdFind() {
  if (!words) cli.die('usage: workday find <name>', { prefix: PREFIX });
  const people = await search(words);
  if (flags.json) return cli.out(people);
  if (!people.length) return console.log(color.dim(`  No one matches "${words}".`));
  console.log(fmt.table(people.map((p) => [p.name, p.title, p.org, p.location, id(p.id)])).split('\n').map((l) => `  ${l}`).join('\n'));
}

async function cmdPerson() {
  const p = await profile(await resolve(words));
  if (flags.json) return cli.out(p);
  console.log(`\n  ${color.cyan(color.bold(p.name))}  ${id(p.id)}`);
  if (p.title) console.log(`  ${p.title}`);
  const line = (label, value) => value && console.log(`  ${color.dim(label.padEnd(10))}${value}`);
  line('Email', p.email);
  line('Location', p.location);
  line('Manager', p.managers.map((m) => `${m.name} ${id(m.id)}`).join(', '));
  line('Org', p.orgPath.join(' › '));
}

async function cmdOrgchart() {
  const who = await resolve(words);
  const p = await profile(who);
  const team = await teamPage(p);
  const own = await loadOrg(team.orgId, team);
  const leads = own.self && own.self.owners.some((o) => o.id === p.id);
  // A manager's View Team is the team they lead; their own team is the parent.
  const member = leads ? (team.ancestors[0] ? await loadOrg(team.ancestors[0].id, team) : null) : own;
  let chain = wd.chainOf(p.id, team, own.self);
  const max = parseInt(flags.chain, 10);
  if (Number.isFinite(max) && max >= 0) chain = chain.slice(0, max);
  const data = {
    person: { id: p.id, name: p.name, title: p.title, location: p.location, email: p.email },
    chain,
    team: member && member.self ? { id: member.self.id, name: member.self.name, total: member.total, members: member.children } : null,
    reports: leads ? { id: own.self.id, name: own.self.name, total: own.total, members: own.children } : null,
  };
  if (flags.json) return cli.out(data);

  console.log(`\n  ${color.cyan(color.bold(p.name))}  ${[p.title, p.location].filter(Boolean).join(' · ')}  ${id(p.id)}`);
  heading('Management chain');
  rows(chain.map((m) => ({ kind: 'person', id: m.id, name: m.name, title: m.title, location: '' })));
  if (data.team) {
    heading(`Team  ${data.team.name}  ${color.dim(`${data.team.total} · id:${data.team.id}`)}`);
    rows(data.team.members, (n) => n.id === p.id || n.owners.some((o) => o.id === p.id));
  }
  heading(data.reports ? `Direct reports  ${color.dim(`${data.reports.total} · id:${data.reports.id}`)}` : 'Direct reports');
  rows(data.reports ? data.reports.members : []);
}

async function cmdOrg() {
  const orgId = positional[0];
  if (!orgId || !/^2500\$\d+$/.test(orgId)) cli.die("usage: workday org <org-id>   (a 2500$… id from orgchart; quote it: '2500$2001')", { prefix: PREFIX });
  const nav = await loadOrg(orgId, defaultTeam);
  if (flags.json) return cli.out(nav);
  const self = nav.self || { name: orgId, owners: [] };
  console.log(`\n  ${color.cyan(color.bold(self.name))}  ${id(orgId)}`);
  const owner = self.owners.map((o) => `${o.name} ${id(o.id)}`).join(', ');
  if (owner) console.log(`  ${color.dim('Led by'.padEnd(10))}${owner}${self.title ? `, ${self.title}` : ''}`);
  if (nav.parent) console.log(`  ${color.dim('Part of'.padEnd(10))}${nav.parent.name} ${id(nav.parent.id)}`);
  heading(`Members  ${color.dim(String(nav.total))}`);
  rows(nav.children);
}

async function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

async function cmdLookup() {
  const input = wd.parseLookupInput(await readStdin(), flags.json === true);
  if (input.error) cli.die(input.error, { prefix: PREFIX });
  if (!input.items.length) cli.die('usage: workday lookup  (names on stdin, one per line; with --json an array of objects with a "name")', { prefix: PREFIX });
  const results = [];
  for (const it of input.items) {
    const people = await search(it.name);
    const pick = wd.choosePerson(it.name, people);
    const prof = pick.person ? await profileOrNull(pick.person) : null;
    results.push({ ...(it.source || { name: it.name }), workday: wd.lookupResult(it.name, people, prof) });
  }
  if (flags.json) return cli.out(results);
  const cell = (w, k) => (w.status === 'found' || w.status === 'no-profile' ? w[k] || '' : '');
  const status = (w) => (w.status === 'ambiguous' ? `ambiguous (${w.candidates.length})` : w.status);
  console.log(fmt.table(results.map((r) => [r.name, status(r.workday), cell(r.workday, 'title'), cell(r.workday, 'org'), cell(r.workday, 'location'), cell(r.workday, 'manager'), r.workday.id ? id(r.workday.id) : '']))
    .split('\n').map((l) => `  ${l}`).join('\n'));
}

async function cmdTree() {
  if (!words) cli.die("usage: workday tree <name|247$id|2500$id> [--depth N] [--json]", { prefix: PREFIX });
  const maxDepth = flags.depth === undefined ? Infinity : parseInt(flags.depth, 10);
  if (!(maxDepth >= 1)) cli.die('--depth needs a whole number of 1 or more', { prefix: PREFIX });
  let orgId;
  let team;
  if (/^2500\$\d+$/.test(words)) {
    orgId = words;
    team = defaultTeam;
  } else {
    const p = await profile(await resolve(words));
    const t = await teamPage(p);
    orgId = t.orgId;
    team = t;
    const own = await loadOrg(orgId, t);
    if (!own.self || !own.self.owners.some((o) => o.id === p.id)) cli.die(`${p.name || p.id} leads no organization in Workday (their team page is ${own.self ? own.self.name : orgId}); pass an org id (2500$…) to walk it`, { prefix: PREFIX });
  }
  const tree = await wd.walkTree(orgId, (o) => loadOrg(o, team), { maxDepth });
  for (const w of tree.warnings) cli.warn(w);
  const data = { root: { id: tree.root.id, name: tree.root.name }, depth: Number.isFinite(maxDepth) ? maxDepth : null, count: tree.people.length, incomplete: tree.warnings.length > 0, people: tree.people };
  if (flags.json) return cli.out(data);
  console.log(`\n  ${color.cyan(color.bold(data.root.name))}  ${id(data.root.id)}  ${color.dim(`${data.count} people`)}`);
  console.log(fmt.table(tree.people.map((p) => [p.name, fmt.trunc(p.title, 50), p.location, p.group || '', id(p.id)])).split('\n').map((l) => `  ${l}`).join('\n'));
}

async function cmdCache() {
  const action = positional[0] || 'info';
  if (action !== 'info' && action !== 'clear') cli.die('usage: workday cache [info|clear]', { prefix: PREFIX });
  const dir = cacheDir();
  let names = [];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  } catch (_) {
    names = [];
  }
  const files = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let entries = 0;
    let bytes = 0;
    try {
      bytes = (await fs.promises.stat(file)).size;
      entries = Object.keys(JSON.parse(await fs.promises.readFile(file, 'utf8')).entries || {}).length;
    } catch (_) {
      // damaged file: counts as 0 entries
    }
    files.push({ path: file, entries, bytes });
  }
  if (action === 'clear') {
    for (const f of files) await fs.promises.rm(f.path, { force: true });
    if (flags.json) return cli.out({ cleared: files.length, entries: files.reduce((n, f) => n + f.entries, 0), path: dir });
    return console.log(`  ${color.green('✓')} cleared ${files.reduce((n, f) => n + f.entries, 0)} entries in ${files.length} file(s) under ${dir}`);
  }
  const total = { entries: files.reduce((n, f) => n + f.entries, 0), bytes: files.reduce((n, f) => n + f.bytes, 0) };
  if (flags.json) return cli.out({ path: dir, ...total, files });
  console.log(`\n  ${color.bold('Cache')}  ${dir}`);
  console.log(`  ${total.entries} entries, ${total.bytes} bytes in ${files.length} file(s)`);
  for (const f of files) console.log(`  ${color.dim(path.basename(f.path))}  ${f.entries} entries, ${f.bytes} bytes`);
}

async function cmdWhoami() {
  const p = await profile(await me());
  if (flags.json) return cli.out(p);
  console.log(`\n  ${color.cyan(color.bold(p.name))}  ${p.title}  ${id(p.id)}`);
  if (p.managers.length) console.log(`  ${color.dim('Manager'.padEnd(10))}${p.managers.map((m) => `${m.name} ${id(m.id)}`).join(', ')}`);
  if (p.orgPath.length) console.log(`  ${color.dim('Org'.padEnd(10))}${p.orgPath.join(' › ')}`);
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  try {
    switch (subcommand) {
      case 'whoami': return await cmdWhoami();
      case 'find': case 'search': return await cmdFind();
      case 'person': case 'profile': return await cmdPerson();
      case 'orgchart': case 'team': return await cmdOrgchart();
      case 'org': return await cmdOrg();
      case 'lookup': return await cmdLookup();
      case 'tree': return await cmdTree();
      case 'cache': return await cmdCache();
      default: cli.die(`unknown command: ${subcommand}\nRun 'workday --help' for usage.`, { prefix: PREFIX });
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(cdpFailureHint(err) || (err && err.message ? err.message : String(err)), { prefix: PREFIX });
  } finally {
    await cacheSave().catch(() => {});
  }
}
await main();
