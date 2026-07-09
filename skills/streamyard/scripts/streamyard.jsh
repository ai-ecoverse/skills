// streamyard.jsh — StreamYard live-studio API client (secret-sauce generated)
//
// StreamYard's studio backend is same-origin cookie-authed REST at
// https://streamyard.com/api/... SLICC's localhost-origin fetch can't carry
// those cookies, so every call runs INSIDE the open studio tab via the
// sliccy:browser bridge (page-context fetch, credentials: 'include').
//
// The broadcast id is the studio URL path segment (streamyard.com/<bid>),
// auto-discovered from the open tab. Live viewer comments per connected
// platform live at /destinations/<output.destinationId>/platform_comments.
//
// Discovered endpoints (all GET, cookie-authed, same-origin):
//   /api/broadcasts/<bid>                                  broadcast + outputs[]
//   /api/broadcasts/<bid>/destinations/<destId>/platform_comments
//   /api/broadcasts/<bid>/starred_comments
//   /api/broadcasts/<bid>/workspace | /team | /token
// where destId = outputs[].destinationId (NOT outputs[].id).

const browser = require('sliccy:browser');
const exec = require('sliccy:exec'); // playwright-cli eval-file + webhook
const fs = require('fs');

const { positional, flags } = process.argv.parseFlags();
const subcommand = positional[0] || 'info';

function die(msg) { console.error(msg); process.exit(1); }
function out(v) { console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); }

let _tab = null, _bid = null;

async function ensure() {
  if (_tab) return;
  _tab = await browser.findTab({ domain: 'streamyard.com' });
  if (!_tab) die('No StreamYard tab found. Open your studio at https://streamyard.com/<id> and sign in, then retry.');
  const path = await browser.eval(_tab, 'location.pathname');
  const m = String(path).match(/\/([A-Za-z0-9]{6,})/);
  if (!m) die('Could not determine the broadcast id from the studio URL (' + path + ').');
  _bid = m[1];
}

// Page-context GET. Returns { status, ok, json }.
//
// NOTE: this runs the fetch in the studio tab's MAIN world via
// `playwright-cli eval`, not the sliccy:browser `evalAsync` bridge. StreamYard's
// same-origin API rejects requests issued from the bridge's isolated world
// (observed: HTTP 400), but accepts main-world requests (HTTP 200) — the app's
// own session/Referer context is what the backend validates. `playwright-cli
// eval` awaits a returned Promise, so the async IIFE resolves correctly.
async function api(path) {
  await ensure();
  const tid = (_tab && _tab.targetId) ? _tab.targetId : String(_tab);
  const js = `(async () => { try { const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } }); const t = await r.text(); let j=null; try{j=JSON.parse(t);}catch(e){j=t;} return JSON.stringify({ status: r.status, ok: r.ok, json: j }); } catch(e){ return JSON.stringify({ error: String(e) }); } })()`;
  // Write the script to a VFS temp file and eval-file it — avoids shell-escaping
  // the JS through exec (which corrupted the request URL and produced spurious
  // 400s), and keeps the fetch in the tab's main world (StreamYard's API rejects
  // the sliccy:browser isolated-world context).
  const tmp = `/shared/.streamyard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`;
  await fs.writeFile(tmp, js);
  const res = await exec(`playwright-cli eval-file ${tmp} --tab=${tid}`);
  await fs.rm(tmp).catch(() => {});
  if (res.exitCode !== 0) die('page eval failed: ' + (res.stderr || res.stdout));
  let r;
  const raw = (res.stdout || '').trim();
  try { r = JSON.parse(raw); } catch (e) { try { r = JSON.parse(JSON.parse(raw)); } catch (e2) { die('Failed to parse StreamYard response: ' + raw.slice(0, 300)); } }
  if (!r || r.error) die('StreamYard request failed: ' + (r && r.error ? r.error : 'empty'));
  if (r.status === 401 || r.status === 403) die('StreamYard session expired (HTTP ' + r.status + '). Reload the studio tab and sign in, then retry.');
  return r;
}

async function getBroadcast() {
  await ensure(); // resolve _bid before building the path
  const r = await api(`/api/broadcasts/${_bid}`);
  if (!r.ok) die('Broadcast fetch failed: HTTP ' + r.status);
  return r.json;
}

function outputRow(o) {
  return {
    id: o.id,
    destinationId: o.destinationId,
    platform: o.platform,
    channel: o.platformUsername || o.platformLink || '',
    title: o.title || '',
    status: o.status,
    plannedStartTime: o.plannedStartTime || null,
    link: o.platformLink || '',
  };
}

function normComment(c) {
  // StreamYard comment shape (e.g. YouTube): author in `name`, body in a
  // `contents[]` array of { type, content } segments, avatar in smallImageSrc.
  let text = '';
  if (Array.isArray(c.contents)) {
    text = c.contents.map((seg) => (seg && (seg.content || seg.text || (seg.emoji ? (seg.alt || '') : ''))) || '').join('');
  } else {
    text = c.message || c.text || c.comment || '';
  }
  return {
    id: c.id || c.commentId,
    platform: c.platform,
    author: c.name || c.authorName || c.author || (c.author && c.author.name) || 'unknown',
    text: text,
    at: c.createdAt || c.publishedAt || c.timestamp || null,
    avatar: c.smallImageSrc || c.largeImageSrc || c.authorImageUrl || c.avatar || null,
    isMember: !!c.isMember,
    isModerator: !!c.isChatModerator,
  };
}

async function collectComments() {
  const b = await getBroadcast();
  const outs = Array.isArray(b.outputs) ? b.outputs : [];
  const seenDest = new Set();
  const all = [];
  for (const o of outs) {
    const d = o.destinationId;
    if (!d || seenDest.has(d)) continue;
    seenDest.add(d);
    const r = await api(`/api/broadcasts/${_bid}/destinations/${d}/platform_comments`);
    if (!r.ok || !r.json) continue;
    const arr = Array.isArray(r.json) ? r.json : (r.json.comments || r.json.data || []);
    for (const c of arr) all.push({ ...normComment(c), platform: c.platform || o.platform });
  }
  all.sort((a, b2) => new Date(a.at || 0) - new Date(b2.at || 0));
  return all;
}

function fmtDur(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + 'h ' : '') + m + 'm';
}

async function cmdInfo() {
  const b = await getBroadcast();
  const info = {
    id: b.id,
    title: b.title || b.studioName,
    status: b.status,
    host: b.hostDisplayName,
    isLive: b.status === 'broadcasting' || b.status === 'live',
    outputs: (b.outputs || []).map(outputRow),
    lastStartedAt: b.lastStartedAt || null,
    lastEpisodeDuration: fmtDur(b.lastEpisodeDurationInMs),
    totalDuration: fmtDur(b.cumulativeDurationInMs),
    shownComments: Array.isArray(b.shownCommentIds) ? b.shownCommentIds.length : 0,
  };
  if (flags.json) return out(info);
  out(`${info.title}`);
  out(`  status:   ${info.status}${info.isLive ? '  ● LIVE' : ''}`);
  out(`  host:     ${info.host || '—'}`);
  out(`  duration: this episode ${info.lastEpisodeDuration} · lifetime ${info.totalDuration}`);
  if (info.outputs.length) {
    out(`  destinations:`);
    for (const o of info.outputs) {
      out(`    ${o.platform.padEnd(9)} ${o.status.padEnd(11)} ${o.title || o.channel}${o.plannedStartTime ? '  @ ' + o.plannedStartTime : ''}`);
      if (o.link) out(`      ${o.link}`);
    }
  }
}

async function cmdComments() {
  const list = await collectComments();
  if (flags.json) return out(list);
  if (!list.length) { out('No platform comments yet (the broadcast may not be live, or no one has commented).'); return; }
  out(`${list.length} comment(s):`);
  for (const c of list) out(`  [${c.platform || '?'}] ${c.author}: ${c.text}`);
}

async function cmdStarred() {
  await ensure(); // resolve _bid before building the path
  const r = await api(`/api/broadcasts/${_bid}/starred_comments`);
  const arr = (r.json && (r.json.starredComments || r.json.comments)) || [];
  const list = arr.map(normComment);
  if (flags.json) return out(list);
  if (!list.length) { out('No starred comments.'); return; }
  out(`${list.length} starred:`);
  for (const c of list) out(`  ★ [${c.platform || '?'}] ${c.author}: ${c.text}`);
}

// Poll for new comments; print them (and optionally POST to a webhook / scoop).
async function cmdWatch() {
  const interval = Math.max(3, parseInt(flags.interval || '8', 10)) * 1000;
  const scoop = flags.scoop || null;
  let webhookUrl = flags.webhook || null;
  if (scoop && !webhookUrl) {
    const w = await exec(`webhook create --scoop ${scoop} --name streamyard-comments`);
    const m = (w.stdout || '').match(/https?:\/\/\S+/);
    if (m) webhookUrl = m[0];
  }
  const seen = new Set();
  (await collectComments()).forEach(c => seen.add(c.id));
  console.error(`[watch] broadcast ${_bid} — polling every ${interval / 1000}s${webhookUrl ? ' → webhook' : ''}. Ctrl-C to stop.`);
  for (;;) {
    await new Promise(r => setTimeout(r, interval));
    let list = [];
    try { list = await collectComments(); } catch (e) { continue; }
    for (const c of list) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out(`[${c.platform || '?'}] ${c.author}: ${c.text}`);
      if (webhookUrl) {
        const payload = JSON.stringify({ type: 'streamyard-comment', data: c });
        await exec(`curl -s -X POST -H "Content-Type: application/json" -d ${JSON.stringify(payload)} ${JSON.stringify(webhookUrl)}`).catch(() => {});
      }
    }
  }
}

async function cmdRaw() {
  const path = positional[1];
  if (!path) die('Usage: streamyard raw <api-path>   (e.g. /api/broadcasts/<id>/workspace)');
  await ensure();
  const full = path.startsWith('/') ? path : `/api/broadcasts/${_bid}/${path}`;
  const r = await api(full);
  out(r.json);
}

function help() {
  out(`streamyard — StreamYard live-studio API client

Usage: streamyard <command> [--json]

Commands:
  info                 Broadcast title, status, host, destinations, durations
  comments             Live viewer comments across connected platforms
  starred              Starred/featured comments
  watch [--interval=8] [--scoop=<name>] [--webhook=<url>]
                       Poll for new comments; print (and optionally POST to a
                       webhook or a scoop's inbox) as they arrive
  raw <api-path>       GET any /api/... path (escape hatch)

Auth: runs inside your open StreamYard studio tab (cookie session). Open
https://streamyard.com/<id> and sign in first. Broadcast id is auto-detected
from the studio URL.`);
}

switch (subcommand) {
  case 'info': await cmdInfo(); break;
  case 'comments': await cmdComments(); break;
  case 'starred': await cmdStarred(); break;
  case 'watch': await cmdWatch(); break;
  case 'raw': await cmdRaw(); break;
  case 'help': case '--help': case '-h': help(); break;
  default: console.error('Unknown command: ' + subcommand); help(); process.exit(1);
}
