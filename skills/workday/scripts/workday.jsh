#!/usr/bin/env jsh

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');
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

FLAGS
  --json        Output JSON
  --chain N     orgchart: show at most N managers above the person (default: all)

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
async function call(path, { method = 'GET', form } = {}) {
  const s = await site();
  const opts = { method, headers: { Accept: 'application/json' } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const res = await browser.fetch(s.tab, `${s.origin}${path}`, opts);
  if (res.status === 401 || res.status === 403) cli.die(`session expired — ${SIGN_IN}`, { prefix: PREFIX });
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
  return wd.searchPeople(await call(`/${s.tenant}/search.htmld?${q}`));
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

async function profile(person) {
  const s = await site();
  const p = wd.parseProfile(await call(inst(s, person.id)));
  if (!p) cli.die(`no Workday profile for ${person.name || person.id}`, { prefix: PREFIX });
  return { ...p, id: p.id || person.id };
}

// One organization with every member. Workday sends the first page of
// members with the org; the rest come from a chunk URL that is only good
// right after that request, so page through it at once.
const CHUNK = 50;
const MAX_CHUNKS = 40;
async function loadOrg(orgId, team) {
  const nav = wd.parseNavigator(await call(`${team.navigationPath}/${orgId}.htmld`, {
    method: 'POST',
    form: { 'initial-step': team.taskId },
  }));
  if (!nav) cli.die(`Workday sent no org chart for ${orgId}`, { prefix: PREFIX });
  for (let i = 0; nav.chunkPath && nav.children.length < nav.total; i++) {
    if (i >= MAX_CHUNKS) {
      cli.warn(`${orgId}: listed ${nav.children.length} of ${nav.total} members`);
      break;
    }
    const page = wd.parseChunk(await call(`${nav.chunkPath}.htmld?startRow=${nav.children.length}&maxRows=${CHUNK}`));
    if (!page || !page.children.length) break;
    nav.children.push(...page.children);
  }
  return nav;
}

// The View Team page also carries the task id and URL the org chart needs.
async function teamPage(p) {
  if (!p.teamPath) cli.die(`Workday shows no team for ${p.name || p.id}`, { prefix: PREFIX });
  const team = wd.parseTeamPage(await call(`${p.teamPath}.htmld`));
  if (!team || !team.orgId || !team.taskId || !team.navigationPath) {
    cli.die(`Workday's team page for ${p.name || p.id} has no org chart`, { prefix: PREFIX });
  }
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
  const nav = await loadOrg(orgId, await defaultTeam());
  if (flags.json) return cli.out(nav);
  const self = nav.self || { name: orgId, owners: [] };
  console.log(`\n  ${color.cyan(color.bold(self.name))}  ${id(orgId)}`);
  const owner = self.owners.map((o) => `${o.name} ${id(o.id)}`).join(', ');
  if (owner) console.log(`  ${color.dim('Led by'.padEnd(10))}${owner}${self.title ? `, ${self.title}` : ''}`);
  if (nav.parent) console.log(`  ${color.dim('Part of'.padEnd(10))}${nav.parent.name} ${id(nav.parent.id)}`);
  heading(`Members  ${color.dim(String(nav.total))}`);
  rows(nav.children);
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
      default: cli.die(`unknown command: ${subcommand}\nRun 'workday --help' for usage.`, { prefix: PREFIX });
    }
  } catch (err) {
    if (err?.name === 'NodeExitError') throw err;
    cli.die(cdpFailureHint(err) || (err && err.message ? err.message : String(err)), { prefix: PREFIX });
  }
}
await main();
