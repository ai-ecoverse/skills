#!/usr/bin/env jsh
// apple-developer — Certificates, Identifiers & Profiles from a logged-in
// developer.apple.com tab: teams, certificates, App IDs and their capabilities,
// provisioning profiles (list, download, create) and App ID registration.
// Built with secret-sauce from a recorded portal session; the API notes are in
// references/endpoints.md. Runs in SLICC and, on a host, under jsh over CDP.

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
  On a host: Chrome with a DevTools port (SLICC_CDP_URL, default http://127.0.0.1:9222).
`.trim();

// On a host, Chrome's default DevTools port unless SLICC_CDP_URL names another.
if (process.versions && process.versions.jsh && process.env && !process.env.SLICC_CDP_URL) {
  process.env.SLICC_CDP_URL = 'http://127.0.0.1:9222';
}

const parsed = process.argv.parseFlags();
const subcommand = parsed.subcommand || '';
const positional = parsed.positional.slice(1);
const flags = parsed.flags;

const list = (v) => (v === undefined || v === true ? [] : (Array.isArray(v) ? v : [v])).map(String);
const str = (v) => (typeof v === 'string' && v ? v : undefined);

// ── session ────────────────────────────────────────────────────────────────
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

function show(rows, columns) {
  if (!rows.length) { console.log(color.dim('  none')); return; }
  const body = rows.map((r) => columns.map((c) => (r[c] === undefined || r[c] === null ? '' : String(r[c]))));
  console.log(fmt.table([columns.map((c) => color.dim(c)), ...body]));
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdTeams() {
  const teams = portal.teamsFrom(await call({ kind: 'teams' }));
  if (flags.json) return cli.out(teams);
  show(teams, ['teamId', 'name', 'type', 'status']);
}

async function certificates(type) {
  const json = await read('certificates', { 'filter[certificateType]': type, limit: 200 });
  return portal.rows(json);
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
  // The filter matches prefixes too (ai.example matches ai.example.mac); keep the exact one.
  const hit = portal.rows(json).find((b) => b.attributes && b.attributes.identifier === identifier);
  return hit ? { bundle: hit, json } : null;
}

async function cmdBundleIds() {
  const json = await read('bundleIds', { 'filter[identifier]': str(flags.identifier), limit: 200 });
  const rows = portal.rows(json).map(portal.bundleIdRow);
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
  return portal.rows(await read('profiles', { limit: 200, ...params }));
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
  // A new 0600 file renamed over the target, so a symlink there is replaced, not written through.
  const tmp = `${out}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
  await fs.promises.rename(tmp, out);
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

// ── main ───────────────────────────────────────────────────────────────────
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
    cli.die(err && err.message ? err.message : String(err), { prefix: PREFIX });
  }
}
await main();
