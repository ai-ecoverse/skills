#!/usr/bin/env jsh

const browser = require('sliccy:browser');
const cli = require('sliccy:cli');
const color = require('sliccy:color');
const fmt = require('sliccy:fmt');
const fs = require('fs');
const os = require('os');
const path = require('path');
const portal = require('./lib/portal.js');

const PREFIX = 'apple-developer';

const HELP = `
apple-developer — Apple Developer portal (Certificates, Identifiers & Profiles)

USAGE
  apple-developer teams
  apple-developer certs [--type DEVELOPER_ID_APPLICATION]
  apple-developer capabilities
  apple-developer bundle-ids [--identifier ai.example.app]
  apple-developer bundle-id <identifier>            App ID with its capabilities
  apple-developer profiles [--name <name>] [--type MAC_APP_DIRECT]
  apple-developer profile <name|id|uuid>
  apple-developer profile download <name|id|uuid> [--out <file>] [--base64]
  apple-developer bundle-id create <identifier> --name <name> [--capability ICLOUD]... [--confirm]
  apple-developer profile create --name <name> --type MAC_APP_DIRECT
                                 --bundle-id <identifier> --cert <id|serial>... [--confirm]

FLAGS
  --team <TEAMID>   Team to use (default: $APPLE_TEAM_ID, else your only team)
  --json            Output raw JSON
  --confirm         Perform a create; without it, print what would be sent
  --base64          profile download: print the profile as one base64 line
                    (e.g. | gh secret set NAME), instead of writing a file

EXAMPLES
  apple-developer bundle-id create ai.example.mac --name Example --capability ICLOUD --confirm
  apple-developer profile create --name "Example Developer ID" --type MAC_APP_DIRECT \\
    --bundle-id ai.example.mac --cert 714FB0EAF0BEA248 --confirm
  apple-developer profile download "Example Developer ID" --base64 | gh secret set PROFILE_BASE64

REQUIRES
  https://developer.apple.com/account open and signed in in your browser.
  On a host: Chrome with a DevTools port, found automatically (or set SLICC_CDP_URL).
`.trim();

// On a host, sliccy-browser finds Chrome itself when SLICC_CDP_URL is unset:
// `slicc browsers --json`, then DevToolsActivePort under SLICC's profile dirs
// (for a Chrome started with --remote-debugging-port=0), then 127.0.0.1:9222.
// Don't default SLICC_CDP_URL to 9222 here: that turns discovery off (seen 2026-11-23:
// SLICC's Chrome listened on a random port, nothing on 9222).
//
// When it can't reach Chrome, its error spans several lines and says "Pass
// --cdp", which this CLI has no flag for. cdpFailureHint() turns that into one
// line: what was tried, and how to point the CLI at Chrome. Any other error
// gives null and is left alone.
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

const list = (v) => (v === undefined || v === true ? [] : (Array.isArray(v) ? v : [v])).map(String);
const str = (v) => (typeof v === 'string' && v ? v : undefined);

let _tab = null;
async function getTab() {
  if (_tab) return _tab;
  _tab = await browser.findTab({ urlMatch: /^https:\/\/developer\.apple\.com\/account/ })
    || await browser.findTab({ urlMatch: /^https:\/\/developer\.apple\.com\// });
  if (!_tab) cli.die('open https://developer.apple.com/account in your browser and sign in, then retry', { prefix: PREFIX });
  return _tab;
}

async function call(req) {
  const tab = await getTab();
  const raw = await browser.evalAsync(tab, `(${portal.pageRequest.toString()})(${JSON.stringify(req)})`);
  const res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const out = portal.parseResponse(res);
  if (!out.ok) cli.die(out.error, { prefix: PREFIX });
  return out.json;
}

let _team = null;
async function team() {
  if (_team) return _team;
  const teams = portal.teamsFrom(await call({ kind: 'teams' }));
  const pick = portal.chooseTeam(str(flags.team), str(process.env.APPLE_TEAM_ID), teams);
  if (pick.error) cli.die(pick.error, { prefix: PREFIX });
  _team = pick.teamId;
  return _team;
}

const read = async (resource, params) => call(portal.readRequest(await team(), resource, params));

const MAX_PAGES = 50;
async function readAll(resource, params) {
  const first = portal.readRequest(await team(), resource, params);
  const out = [];
  const seen = new Set();
  let req = first;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await call(req);
    out.push(...portal.rows(json));
    const next = portal.nextQuery(json);
    if (!next || seen.has(next)) return out;
    seen.add(next);
    req = { ...first, query: next };
  }
  cli.die(`more than ${MAX_PAGES} pages of ${resource}; narrow the request`, { prefix: PREFIX });
}

function show(rows, columns) {
  if (!rows.length) { console.log(color.dim('  none')); return; }
  const body = rows.map((r) => columns.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c]))));
  console.log(fmt.table([columns.map((c) => color.dim(c)), ...body]));
}

async function cmdTeams() {
  const teams = portal.teamsFrom(await call({ kind: 'teams' }));
  if (flags.json) return cli.out(teams);
  show(teams, ['teamId', 'name', 'type', 'status']);
}

async function certificates(type) {
  return readAll('certificates', { 'filter[certificateType]': type, limit: 200 });
}

async function cmdCerts() {
  const certs = await certificates(str(flags.type));
  if (flags.json) return cli.out(certs.map(portal.certificateRow));
  show(certs.map(portal.certificateRow).map((c) => ({ ...c, expires: c.expires ? fmt.date(c.expires, 'short') : '' })),
    ['id', 'type', 'name', 'serial', 'expires']);
}

async function cmdCapabilities() {
  const json = await read('capabilities', { 'filter[capabilityType]': 'capability,service', 'filter[includeRequestable]': 'true' });
  const caps = portal.rows(json).map((c) => ({ id: c.id, name: c.attributes && c.attributes.name, type: c.attributes && c.attributes.capabilityType }));
  if (flags.json) return cli.out(caps);
  show(caps, ['id', 'name', 'type']);
}

async function findBundleId(identifier) {
  const json = await read('bundleIds', { 'filter[identifier]': identifier, include: 'bundleIdCapabilities', limit: 20 });
  const hit = portal.rows(json).find((b) => b.attributes && b.attributes.identifier === identifier);
  return hit ? { bundle: hit, json } : null;
}

async function cmdBundleIds() {
  const rows = (await readAll('bundleIds', { 'filter[identifier]': str(flags.identifier), limit: 200 })).map(portal.bundleIdRow);
  if (flags.json) return cli.out(rows);
  show(rows, ['id', 'identifier', 'name', 'platform']);
}

async function cmdBundleId(identifier) {
  if (!identifier) cli.die('usage: apple-developer bundle-id <identifier>', { prefix: PREFIX });
  const found = await findBundleId(identifier);
  if (!found) cli.die(`no App ID ${identifier} on team ${await team()}`, { prefix: PREFIX });
  const row = portal.bundleIdRow(found.bundle);
  const caps = portal.capabilityRows(found.json, found.bundle.id);
  if (flags.json) return cli.out({ ...row, capabilities: caps });
  console.log(`  ${color.bold(row.identifier)}  ${row.name}  ${color.dim(`id:${row.id} ${row.platform}`)}`);
  for (const c of caps) console.log(`    ${c.enabled ? color.green('on ') : color.dim('off')} ${c.capability}${c.settings.length ? color.dim(`  ${c.settings.join(' ')}`) : ''}`);
}

async function profiles(params) {
  return readAll('profiles', { limit: 200, ...params });
}

async function cmdProfiles() {
  const rows = (await profiles({ 'filter[name]': str(flags.name), 'filter[profileType]': str(flags.type) })).map(portal.profileRow);
  if (flags.json) return cli.out(rows);
  show(rows.map((p) => ({ ...p, expires: p.expires ? fmt.date(p.expires, 'short') : '' })), ['id', 'name', 'type', 'state', 'expires']);
}

async function oneProfile(ref) {
  if (!ref) cli.die('name, ID or UUID of the profile is required', { prefix: PREFIX });
  const all = await profiles({ include: 'bundleId,certificates' });
  const pick = portal.pickProfile(all, ref);
  if (pick.error) cli.die(pick.error, { prefix: PREFIX });
  return pick.profile;
}

async function cmdProfile(ref) {
  const p = await oneProfile(ref);
  const row = portal.profileRow(p);
  if (flags.json) return cli.out(row);
  for (const [k, v] of Object.entries(row)) console.log(`  ${color.dim(k.padEnd(8))} ${v ?? ''}`);
}

async function cmdProfileDownload(ref) {
  const p = await oneProfile(ref);
  const bytes = portal.profileBytes(p);
  if (!bytes) cli.die(`the portal returned no profile content for "${ref}"`, { prefix: PREFIX });
  if (flags.base64) { process.stdout.write(bytes.toString('base64') + '\n'); return; }
  let out = str(flags.out);
  if (!out) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'apple-developer-'));
    out = path.join(dir, `${p.attributes.uuid || p.id}.provisionprofile`);
  }
  const tmp = `${out}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await fs.promises.rename(tmp, out);
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
  if (flags.json) return cli.out({ ...portal.profileRow(p), path: out, bytes: bytes.length });
  console.log(out);
}

function preview(what, body) {
  console.log(color.yellow(`Would create ${what}. Re-run with --confirm to send:`));
  console.log(JSON.stringify(body, null, 2));
}

async function cmdBundleIdCreate(identifier) {
  const teamId = await team();
  let body;
  try {
    body = portal.bundleIdCreateBody({ teamId, identifier, name: str(flags.name), capabilities: list(flags.capability) });
  } catch (err) { cli.die(err.message, { prefix: PREFIX }); }
  if (!flags.confirm) return preview(`App ID ${identifier} on team ${teamId}`, body);
  const json = await call(portal.writeRequest(teamId, 'POST', 'bundleIds', body));
  const row = portal.bundleIdRow(portal.rows(json)[0] || {});
  if (flags.json) return cli.out(row);
  console.log(`${color.green('created')} ${row.identifier} ${color.dim(`id:${row.id}`)}`);
}

async function cmdProfileCreate() {
  const teamId = await team();
  const identifier = str(flags['bundle-id']);
  if (!identifier) cli.die('--bundle-id <identifier> is required', { prefix: PREFIX });
  const found = await findBundleId(identifier);
  if (!found) cli.die(`no App ID ${identifier} on team ${teamId}`, { prefix: PREFIX });
  const certRefs = list(flags.cert);
  if (!certRefs.length) cli.die('--cert <id|serial> is required (see `apple-developer certs`)', { prefix: PREFIX });
  const picked = portal.pickCertificates(await certificates(), certRefs);
  if (picked.error) cli.die(picked.error, { prefix: PREFIX });
  let body;
  try {
    body = portal.profileCreateBody({ teamId, name: str(flags.name), profileType: str(flags.type), bundleIdId: found.bundle.id, certificateIds: picked.certificates.map((c) => c.id) });
  } catch (err) { cli.die(err.message, { prefix: PREFIX }); }
  if (!flags.confirm) return preview(`profile "${flags.name}" for ${identifier}`, body);
  const json = await call(portal.writeRequest(teamId, 'POST', 'profiles', body));
  const row = portal.profileRow(portal.rows(json)[0] || {});
  if (flags.json) return cli.out(row);
  console.log(`${color.green('created')} ${row.name} ${color.dim(`id:${row.id} uuid:${row.uuid}`)}`);
  console.log(color.dim(`  download: apple-developer profile download ${row.id}`));
}

async function main() {
  if (flags.help || flags.h || !subcommand || subcommand === 'help') cli.help(HELP);
  const [first, second] = positional;
  try {
    switch (subcommand) {
      case 'teams': return await cmdTeams();
      case 'certs': case 'certificates': return await cmdCerts();
      case 'capabilities': return await cmdCapabilities();
      case 'bundle-ids': return await cmdBundleIds();
      case 'bundle-id':
        if (first === 'create') return await cmdBundleIdCreate(second);
        return await cmdBundleId(first);
      case 'profiles': return await cmdProfiles();
      case 'profile':
        if (first === 'download') return await cmdProfileDownload(second);
        if (first === 'create') return await cmdProfileCreate();
        return await cmdProfile(first);
      default:
        cli.die(`unknown command: ${subcommand}\nRun 'apple-developer --help' for usage.`, { prefix: PREFIX });
    }
  } catch (err) {
    if (err && err.name === 'NodeExitError') throw err;
    cli.die(cdpFailureHint(err) || (err && err.message ? err.message : String(err)), { prefix: PREFIX });
  }
}
await main();
