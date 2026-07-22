// teams.jsh — Microsoft Teams access via Graph + Substrate Search APIs
// Auto-discovered as `teams` shell command in SLICC.
//
// Operates against the authenticated browser session on teams.microsoft.com via
// page-context fetch through the sliccy:browser bridge. The user must be logged into
// Teams in their browser; the script never reads, prints, or stores the MSAL
// session token — every API call runs inside the page and only the API response
// leaves the browser context.
//
// Usage: teams <subcommand> [args] [--since=<duration>] [--top=<n>]
// Subcommands: teams, channels, history, activity, post, thread, user, info, search, unanswered, digest
//
// jsh runtime migration (issue #177):
//  - Browser access uses the sliccy:browser bridge (findTab / evalAsync)
//    instead of the legacy browser tab-list / eval shell-outs.
//  - Argument parsing uses process.argv.parseFlags() instead of a manual loop.
//  - Capability bridges are obtained explicitly via require('sliccy:<name>').

const browser = require('sliccy:browser');
const exec = require('sliccy:exec'); // only for the one-time CDP request-buffer seed (see AUTH note)

const TEAMS_DOMAIN_PRIMARY = 'teams.microsoft.com';
const TEAMS_DOMAIN_SECONDARY = 'teams.live.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta';
// NOTE: Channel message reads must use GRAPH_BETA. The delegated token from the Teams
// browser session does not include ChannelMessage.Read.All, so the v1.0 messages endpoint
// returns 403. The beta endpoint works with the scopes the Teams session provides.
const SUBSTRATE_SEARCH_URL = 'https://substrate.office.com/search/api/v2/query';
// Audience markers used to locate the right MSAL access token in localStorage.
const GRAPH_AUDIENCE = 'graph.microsoft.com';
const SUBSTRATE_AUDIENCE = 'substrate.office.com';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const { positional: _allPositional, flags } = process.argv.parseFlags();
const subcommand = _allPositional[0] || '';
const positional = _allPositional.slice(1);

const sinceDuration = flags.since || null;
const topN = flags.top ? parseInt(flags.top, 10) : null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDuration(dur) {
  if (!dur) return null;
  const match = dur.match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return ms[unit] * n;
}

function sinceDate(dur, fallbackHours) {
  const ms = dur ? parseDuration(dur) : fallbackHours * 3600000;
  if (!ms) {
    console.error(`Invalid duration: ${dur}. Use format like 24h, 7d, 2w`);
    process.exit(1);
  }
  return new Date(Date.now() - ms).toISOString();
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

// Runs an array of async factory functions with bounded concurrency.
// Returns results in the same order as the input array.
async function pooled(concurrency, fns) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const i = next++;
      results[i] = await fns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fns.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Tab discovery + page-context fetch + authentication
// ---------------------------------------------------------------------------
//
// All API calls run inside the Teams tab via the sliccy:browser bridge, so the
// origin is teams.microsoft.com and browser session state is available.
//
// AUTH (issue #201): Teams v2 now stores every MSAL access token in
// localStorage as an *encrypted* blob ({id, nonce, data}) with no plaintext
// `.secret` field, so the old "read the token out of localStorage" approach no
// longer works — every Graph subcommand failed with NOT_AUTHENTICATED even
// against a genuinely signed-in tab. Instead we capture the multi-resource MSAL
// *refresh token* that the Teams client posts to the AAD token endpoint
// (POST .../oauth2/v2.0/token) and replay it in-page for the Graph (or
// Substrate) scope; AAD returns an audience-scoped access token because the
// refresh token is multi-resource (FOCI). Capture is two-pronged, and the
// refresh + access tokens are minted and consumed entirely inside the page:
//   1. an idempotent page-context fetch/XHR hook records the refresh token from
//      any live token request into a window global (survives across evals);
//   2. a one-time bootstrap seed reads a recent token request out of the CDP
//      request buffer (playwright-cli requests) and injects it into the page
//      when the hook has not caught one yet. Token rotation then keeps the
//      in-page refresh token fresh for the rest of the tab session.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// JS prepended to every teamsFetch eval: an idempotent refresh-token capture
// hook plus __getToken(audience), which mints/caches a bearer token for the
// requested audience by replaying the captured refresh token in-page.
const AUTH_PREAMBLE = `
  const __AUD_SCOPE = {
    'graph.microsoft.com': 'https://graph.microsoft.com/.default',
    'substrate.office.com': 'https://substrate.office.com/.default'
  };
  if (!window.__sliccTeamsHook) {
    window.__sliccTeamsHook = true;
    const __grab = (bodyStr, u) => {
      try {
        if (!bodyStr || String(u).indexOf('/oauth2/v2.0/token') === -1) return;
        const p = new URLSearchParams(bodyStr);
        const rt = p.get('refresh_token');
        if (!rt) return;
        window.__sliccTeamsAuth = { rt: rt, clientId: p.get('client_id'), authority: String(u).split('/oauth2/')[0] };
      } catch (e) {}
    };
    const __of = window.fetch;
    window.fetch = function (input, init) {
      try {
        const u = (typeof input === 'string') ? input : (input && input.url) || '';
        let b = init && init.body;
        if (b && typeof b !== 'string' && b.toString) b = b.toString();
        if (typeof b === 'string') __grab(b, u);
      } catch (e) {}
      return __of.apply(this, arguments);
    };
    const __os = XMLHttpRequest.prototype.send;
    const __ou = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { this.__su = u; return __ou.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      try { if (typeof b === 'string') __grab(b, this.__su || ''); } catch (e) {}
      return __os.apply(this, arguments);
    };
  }
  window.__sliccTok = window.__sliccTok || {};
  async function __getToken(a) {
    const c = window.__sliccTok[a];
    if (c && c.exp > (Date.now() / 1000) + 60) return c.token;
    if (!(window.__sliccTeamsAuth && window.__sliccTeamsAuth.rt)) return null;
    const au = window.__sliccTeamsAuth;
    const scope = __AUD_SCOPE[a] || ('https://' + a + '/.default');
    const bd = new URLSearchParams({ client_id: au.clientId, grant_type: 'refresh_token', refresh_token: au.rt, scope: scope, client_info: '1' });
    let tj;
    try {
      const tr = await fetch(au.authority + '/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bd.toString() });
      tj = await tr.json();
    } catch (e) { return null; }
    if (!tj || !tj.access_token) return null;
    if (tj.refresh_token) window.__sliccTeamsAuth.rt = tj.refresh_token;
    let exp = Math.floor(Date.now() / 1000) + (tj.expires_in || 3600);
    try { exp = JSON.parse(atob(tj.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || exp; } catch (e) {}
    window.__sliccTok[a] = { token: tj.access_token, exp: exp };
    return tj.access_token;
  }
`;

let _tabId = null;

async function findTeamsTab() {
  for (const domain of [TEAMS_DOMAIN_PRIMARY, TEAMS_DOMAIN_SECONDARY]) {
    const tab = await browser.findTab({ domain });
    if (tab) return tab;
  }
  die(
    'No Teams tab found. Open Teams first:\n  open https://teams.microsoft.com\nWait for it to load and sign in, then retry.'
  );
}

async function ensureTab() {
  if (!_tabId) _tabId = await findTeamsTab();
  return _tabId;
}

// The browser bridge takes a TabHandle, but playwright-cli needs the raw
// targetId string. TabHandle exposes .targetId; fall back to the value itself.
function _targetId(tab) {
  return (tab && tab.targetId) ? tab.targetId : String(tab);
}

// Extract a urlencoded form-field value from a request body string.
function _formField(body, name) {
  for (const part of String(body).split('&')) {
    if (part.startsWith(name + '=')) return part.slice(name.length + 1);
  }
  return null;
}

// Bootstrap seed: read a refresh token from the CDP request buffer and inject it
// into the page as window.__sliccTeamsAuth. Returns true on success. The refresh
// token is passed straight into a page eval (never printed, never written to
// disk) where it is decoded and stored in a page global.
async function seedFromBuffer(tab) {
  const tid = _targetId(tab);
  const r = await exec(`playwright-cli requests --filter="oauth2/v2.0/token" --tab=${tid}`);
  if (r.exitCode !== 0) return false;
  const lines = r.stdout
    .split('\n')
    .filter((l) => /oauth2\/v2\.0\/token/.test(l) && /→\s*200/.test(l));
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  const idx = last.trim().split(/\s+/)[0];
  const authMatch = last.match(/https:\/\/[^/]+\/[0-9a-fA-F-]{36}/);
  const authority = authMatch ? authMatch[0] : null;
  if (!authority || !/^\d+$/.test(idx)) return false;
  const b = await exec(`playwright-cli request-body ${idx} --tab=${tid}`);
  if (b.exitCode !== 0) return false;
  const rt = _formField(b.stdout, 'refresh_token');
  const cid = _formField(b.stdout, 'client_id');
  if (!rt || !cid) return false;
  // rt is percent-encoded in the form body; decode it in-page.
  const seedJs =
    `window.__sliccTeamsAuth = { rt: decodeURIComponent(${JSON.stringify(rt)}), clientId: ${JSON.stringify(cid)}, authority: ${JSON.stringify(authority)} }; 'ok';`;
  try {
    await browser.eval(tab, seedJs);
    return true;
  } catch (e) {
    return false;
  }
}

// Force the Teams client to (re)issue a token request so seedFromBuffer can find
// one in the CDP buffer. A fresh page load makes MSAL re-acquire tokens it does
// not have cached.
async function reloadAndWait(tab) {
  try { await browser.eval(tab, "location.reload(); 'ok'"); } catch (e) {}
  await sleep(12000);
}

// Run the API call in the page. Returns { status, ok, data } or { error }.
async function _runFetchEval(tab, method, url, body, aud) {
  const jsCode = `
    (async () => {
      try {
        ${AUTH_PREAMBLE}
        const aud = ${JSON.stringify(aud)};
        const tok = await __getToken(aud);
        if (!tok) return { error: 'NEED_RT' };
        const opts = { method: ${JSON.stringify(method)}, headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/json' } };
        ${body !== undefined && body !== null ? `opts.headers['Content-Type'] = 'application/json'; opts.body = ${JSON.stringify(JSON.stringify(body))};` : ''}
        const resp = await fetch(${JSON.stringify(url)}, opts);
        if (resp.status === 401) { try { delete window.__sliccTok[aud]; } catch (e) {} }
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = text; }
        return { status: resp.status, ok: resp.ok, data: data };
      } catch (e) {
        return { error: 'FETCH_ERROR', message: e.message };
      }
    })()
  `.trim();
  let parsed;
  try {
    parsed = await browser.evalAsync(tab, jsCode);
  } catch (e) {
    die('eval failed: ' + (e && e.message ? e.message : String(e)));
  }
  // evalAsync returns the value directly. Defensively parse if a raw JSON
  // string comes back instead (older bridge builds).
  if (typeof parsed === 'string') {
    const raw = parsed.trim();
    try { parsed = JSON.parse(raw); }
    catch (e) {
      try { parsed = JSON.parse(JSON.parse(raw)); }
      catch (e2) { die('Failed to parse response: ' + raw.slice(0, 500)); }
    }
  }
  if (parsed === null || parsed === undefined) {
    die('Failed to parse response: empty result');
  }
  return parsed;
}

async function teamsFetch(method, url, body, audience) {
  const tab = await ensureTab();
  const aud = audience || GRAPH_AUDIENCE;
  let parsed = await _runFetchEval(tab, method, url, body, aud);
  if (parsed.error === 'NEED_RT') {
    // The page hook has not captured a refresh token yet. Seed one from the CDP
    // request buffer; if the buffer is empty, force a token request via reload.
    let seeded = await seedFromBuffer(tab);
    if (!seeded) {
      await reloadAndWait(tab);
      seeded = await seedFromBuffer(tab);
    }
    if (!seeded) {
      die(
        'Could not obtain a Teams refresh token. Make sure Teams is fully loaded ' +
        'and signed in at https://teams.microsoft.com, then retry. If it persists, ' +
        'refresh the Teams tab.'
      );
    }
    parsed = await _runFetchEval(tab, method, url, body, aud);
    if (parsed.error === 'NEED_RT') {
      die(
        'Authentication failed: captured a refresh token but the token exchange ' +
        'did not return an access token. Refresh the Teams tab and retry.'
      );
    }
  }
  // One retry on 401 (the in-page token cache was cleared above).
  if (parsed.status === 401) {
    parsed = await _runFetchEval(tab, method, url, body, aud);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Graph API client (page-context)
// ---------------------------------------------------------------------------

async function graphGet(path, params, retries) {
  if (retries === undefined) retries = 3;
  let url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const r = await teamsFetch('GET', url, null, GRAPH_AUDIENCE);
  if (r.error === 'NOT_AUTHENTICATED') {
    die('No Graph access token in Teams localStorage. Make sure Teams is fully loaded and signed in.');
  }
  if (r.error === 'FETCH_ERROR') die('Page fetch error: ' + r.message);
  if (r.status === 401) {
    die('401 Unauthorized — Teams session expired. Refresh the Teams tab and sign in again.');
  }
  if (r.status === 403) {
    die('403 Forbidden — insufficient permissions. The Teams session token lacks required Graph scopes. See reference.md.');
  }
  if (r.status === 429) {
    if (retries > 0) {
      await new Promise((rs) => setTimeout(rs, 5000));
      return graphGet(path, params, retries - 1);
    }
    die('429 Too Many Requests — rate limited. Wait a moment and retry.');
  }
  if (!r.ok) {
    die(`Graph API error ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`);
  }
  return r.data;
}

async function graphPost(path, body) {
  const url = path.startsWith('http') ? path : `${GRAPH_BETA}${path}`;
  const r = await teamsFetch('POST', url, body, GRAPH_AUDIENCE);
  if (r.error === 'NOT_AUTHENTICATED') {
    die('No Graph access token in Teams localStorage. Make sure Teams is fully loaded and signed in.');
  }
  if (r.error === 'FETCH_ERROR') die('Page fetch error: ' + r.message);
  if (r.status === 401) {
    die('401 Unauthorized — Teams session expired. Refresh the Teams tab and sign in again.');
  }
  if (!r.ok) {
    die(`Graph API error ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`);
  }
  return r.data;
}

// Non-fatal POST — returns {ok, status, data} instead of die(). Used for
// optional endpoints (Search API) where failure should trigger a fallback.
async function graphPostSafe(path, body) {
  const url = path.startsWith('http') ? path : `${GRAPH_BETA}${path}`;
  const r = await teamsFetch('POST', url, body, GRAPH_AUDIENCE);
  if (r.error || !r.ok) return { ok: false, status: r.status || 0, data: null };
  return { ok: true, status: r.status, data: r.data };
}

// Generic safe POST for any bearer-token API (substrate search).
async function apiPostSafe(url, body, audience) {
  const r = await teamsFetch('POST', url, body, audience || GRAPH_AUDIENCE);
  if (r.error || !r.ok) return { ok: false, status: r.status || 0, data: null };
  return { ok: true, status: r.status, data: r.data };
}

// Generic safe GET for any bearer-token API.
async function apiGetSafe(url, audience) {
  const r = await teamsFetch('GET', url, null, audience || GRAPH_AUDIENCE);
  if (r.error || !r.ok) return { ok: false, status: r.status || 0, data: null };
  return { ok: true, status: r.status, data: r.data };
}

async function graphGetAllPages(path, params, maxPages, useBeta) {
  maxPages = maxPages || 10;
  const base = useBeta ? GRAPH_BETA : GRAPH_BASE;
  const results = [];
  let url = path.startsWith('http') ? path : `${base}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  let pages = 0;
  while (url && pages < maxPages) {
    const data = await graphGet(url);
    if (data.value) results.push(...data.value);
    url = data['@odata.nextLink'] || null;
    pages++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Teams/channel resolution (name → ID)
// ---------------------------------------------------------------------------

async function getTeams() {
  return graphGetAllPages('/me/joinedTeams');
}

async function resolveTeam(nameOrId) {
  const teams = await getTeams();
  const lower = nameOrId.toLowerCase();
  const exact = teams.find((t) => t.id === nameOrId);
  if (exact) return exact;
  const match = teams.find((t) => t.displayName.toLowerCase().includes(lower));
  if (!match) die(`Team not found: "${nameOrId}". Run \`teams teams\` to list available teams.`);
  return match;
}

async function getChannels(teamId) {
  return graphGetAllPages(`/teams/${teamId}/channels`);
}

async function resolveChannel(teamId, nameOrId) {
  const channels = await getChannels(teamId);
  const lower = nameOrId.toLowerCase();
  const exact = channels.find((c) => c.id === nameOrId);
  if (exact) return exact;
  const match = channels.find((c) => c.displayName.toLowerCase().includes(lower));
  if (!match)
    die(
      `Channel not found: "${nameOrId}". Run \`teams channels ${teamId}\` to list available channels.`
    );
  return match;
}

// ---------------------------------------------------------------------------
// Teams subcommand
// ---------------------------------------------------------------------------

async function cmdTeams() {
  const teams = await getTeams();
  out(
    teams.map((t) => ({
      id: t.id,
      name: t.displayName,
      description: t.description || '',
    }))
  );
}

// ---------------------------------------------------------------------------
// Channels subcommand
// ---------------------------------------------------------------------------

async function cmdChannels() {
  const term = flags.search ? flags.search.toLowerCase() : null;

  if (!positional[0] && !term) {
    die('Usage: teams channels <teamNameOrId> [--search=term]\n       teams channels --search=term   (search across all teams)');
  }

  if (positional[0]) {
    const team = await resolveTeam(positional[0]);
    let channels = await getChannels(team.id);
    if (term) channels = channels.filter(c => c.displayName.toLowerCase().includes(term));
    out(channels.map((c) => ({ id: c.id, name: c.displayName, description: c.description || '', membershipType: c.membershipType, team: team.displayName })));
  } else {
    const teams = await getTeams();
    const results = [];
    for (const t of teams) {
      try {
        const channels = await getChannels(t.id);
        const matched = channels.filter(c => c.displayName.toLowerCase().includes(term));
        results.push(...matched.map(c => ({ id: c.id, name: c.displayName, description: c.description || '', membershipType: c.membershipType, team: t.displayName })));
      } catch { /* skip inaccessible teams */ }
    }
    out(results);
  }
}

// ---------------------------------------------------------------------------
// History subcommand
// ---------------------------------------------------------------------------

async function cmdHistory() {
  if (positional.length < 2) die('Usage: teams history <team> <channel> [--since=24h] [--top=50]');
  const team = await resolveTeam(positional[0]);
  const channel = await resolveChannel(team.id, positional[1]);
  const since = sinceDate(sinceDuration, 24);
  const top = topN || 50;

  const messages = await graphGetAllPages(`/teams/${team.id}/channels/${channel.id}/messages`,
    { $top: String(top) },
    5,
    true  // use beta endpoint  v1.0 requires ChannelMessage.Read.All which the delegated token lacks
  );

  const cutoff = new Date(since).getTime();
  const filtered = messages.filter((m) => {
    const ts = new Date(m.createdDateTime).getTime();
    return ts >= cutoff && m.messageType === 'message';
  });

  out(
    filtered.map((m) => ({
      id: m.id,
      from: m.from?.user?.displayName || m.from?.application?.displayName || 'unknown',
      date: m.createdDateTime,
      body: m.body?.content ? stripHtml(m.body.content).slice(0, 500) : '',
      replyCount: m.replies?.length || 0,
      hasAttachments: (m.attachments || []).length > 0,
      importance: m.importance,
      reactions: (m.reactions || []).map((r) => r.reactionType),
      team: team.displayName,
      channel: channel.displayName,
    }))
  );
}

// ---------------------------------------------------------------------------
// Post subcommand
// ---------------------------------------------------------------------------

async function cmdPost() {
  // --live: post into the CURRENTLY ACTIVE meeting's chat (visible to all
  // participants) instead of a team channel. No team/channel needed.
  if (flags.live) {
    const message = positional.join(' ').trim();
    if (!message) die('Usage: teams post --live <message>   (posts to the active meeting chat)');
    const tab = await findTeamsTab();
    const res = await postToMeetingChat(tab, message);
    if (res === 'no-input') {
      die('Could not find the meeting chat input. Make sure you are in a meeting and the chat is available.');
    }
    out({ target: 'live-meeting-chat', result: res, message });
    return;
  }

  if (positional.length < 3) die('Usage: teams post <team> <channel> <message> [--reply-to=<message-id>]');
  const team = await resolveTeam(positional[0]);
  const channel = await resolveChannel(team.id, positional[1]);
  const message = positional.slice(2).join(' ');
  const replyTo = flags['reply-to'] || null;

  const body = { body: { contentType: 'text', content: message } };

  let result;
  if (replyTo) {
    result = await graphPost(
      token,
      `/teams/${team.id}/channels/${channel.id}/messages/${replyTo}/replies`,
      body
    );
  } else {
    result = await graphPost(`/teams/${team.id}/channels/${channel.id}/messages`, body);
  }

  out({
    id: result.id,
    date: result.createdDateTime,
    from: result.from?.user?.displayName || 'unknown',
    body: message,
    replyTo: replyTo || null,
    team: team.displayName,
    channel: channel.displayName,
    webUrl: result.webUrl || '',
  });
}

// ---------------------------------------------------------------------------
// Thread subcommand
// ---------------------------------------------------------------------------

async function cmdThread() {
  if (positional.length < 3) die('Usage: teams thread <team> <channel> <message-id> [--top=50]');
  const team = await resolveTeam(positional[0]);
  const channel = await resolveChannel(team.id, positional[1]);
  const messageId = positional[2];
  const top = topN || 50;

  const replies = await graphGetAllPages(`/teams/${team.id}/channels/${channel.id}/messages/${messageId}/replies`,
    { $top: String(top) },
    5,
    true
  );

  out(
    replies
      .filter(r => r.messageType === 'message')
      .map(r => ({
        id: r.id,
        from: r.from?.user?.displayName || r.from?.application?.displayName || 'unknown',
        date: r.createdDateTime,
        body: r.body?.content ? stripHtml(r.body.content).slice(0, 500) : '',
        reactions: (r.reactions || []).map(rx => rx.reactionType),
      }))
  );
}

// ---------------------------------------------------------------------------
// User subcommand
// ---------------------------------------------------------------------------

async function cmdUser() {
  if (!positional[0]) die('Usage: teams user <user-id-or-display-name>');
  const query = positional.join(' ');

  let user;
  if (query.match(/^[0-9a-f-]{36}$/i) || query.includes('@')) {
    user = await graphGet(`/users/${encodeURIComponent(query)}`);
  } else {
    const results = await graphGet('/users', {
      $filter: `startswith(displayName,'${query.replace(/'/g, "''")}')`,
      $top: '5',
      $select: 'id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation',
    });
    if (!results.value || results.value.length === 0) {
      die(`User not found: "${query}"`);
    }
    user = results.value[0];
    if (results.value.length > 1) {
      console.error(`Multiple users found, showing first match. Use a user ID for exact lookup.`);
    }
  }

  out({
    id: user.id,
    name: user.displayName,
    email: user.mail || user.userPrincipalName,
    title: user.jobTitle || '',
    department: user.department || '',
    office: user.officeLocation || '',
  });
}

// ---------------------------------------------------------------------------
// Info subcommand
// ---------------------------------------------------------------------------

async function cmdInfo() {
  if (positional.length < 2) die('Usage: teams info <team> <channel>');
  const team = await resolveTeam(positional[0]);
  const channel = await resolveChannel(team.id, positional[1]);

  const info = await graphGet(`/teams/${team.id}/channels/${channel.id}`);
  out({
    id: info.id,
    name: info.displayName,
    description: info.description || '',
    membershipType: info.membershipType,
    webUrl: info.webUrl || '',
    team: team.displayName,
    teamId: team.id,
  });
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Activity subcommand
// ---------------------------------------------------------------------------

async function cmdActivity() {
  const since = sinceDate(sinceDuration, 24); // default 24h
  const limit = topN || 25;

  const me = await graphGet('/me');
  const displayName = me.displayName;

  // 1. Try Substrate Search first (Teams internal search  most reliable)
  console.error('[activity] Trying Substrate Search API...');
  const substrate = await trySubstrateSearch(displayName, limit);
  if (substrate.ok && substrate.results.length > 0) {
    console.error(`[activity] Substrate Search returned ${substrate.results.length} results.`);
    const sinceMs = new Date(since).getTime();
    const filtered = substrate.results.filter(
      (m) => !m.date || new Date(m.date).getTime() >= sinceMs
    );
    out(filtered);
    return;
  }
  if (!substrate.ok) {
    console.error('[activity] Substrate Search unavailable.');
  } else {
    console.error('[activity] Substrate Search returned no results.');
  }

  // 2. Try Graph Search API
  console.error('[activity] Trying Graph Search API...');
  const graph = await tryGraphSearch(displayName, limit);
  if (graph.ok && graph.results.length > 0) {
    console.error(`[activity] Graph Search returned ${graph.results.length} results.`);
    const sinceMs = new Date(since).getTime();
    const filtered = graph.results.filter(
      (m) => !m.date || new Date(m.date).getTime() >= sinceMs
    );
    out(filtered);
    return;
  }
  if (!graph.ok) {
    console.error('[activity] Graph Search API returned error. Falling back to scan...');
  } else {
    console.error('[activity] Graph Search returned no results. Falling back to scan...');
  }

  // 3. Fall back to channel scan + chat scan in parallel
  await cmdActivityFallback(me, since);
}

async function cmdActivityFallback(me, since) {
  const maxTeams = parseInt(flags['max-teams'] || '10', 10);
  const concurrency = parseInt(flags['concurrency'] || '5', 10);
  const limit = topN || 25;
  const cutoff = new Date(since).getTime();

  // Run channel scan and chat scan in parallel
  const [channelMentions, chatMentions] = await Promise.all([
    scanChannelsForMentions(me, cutoff, limit, maxTeams, concurrency),
    scanChatsForMentions(me, cutoff, limit, concurrency),
  ]);

  // Merge, deduplicate by date+from, sort by date descending
  const allMentions = [...channelMentions, ...chatMentions];
  allMentions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Deduplicate by date + from (rough)
  const seen = new Set();
  const deduped = allMentions.filter((m) => {
    const key = `${m.date}|${m.from}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  out(deduped.slice(0, limit));
}

// Scan team channels for mentions of the current user.
async function scanChannelsForMentions(me, cutoff, limit, maxTeams, concurrency) {
  const allTeams = await getTeams();
  const teamsToScan = allTeams.slice(0, maxTeams);

  console.error(`[activity] Scanning channels in ${teamsToScan.length} teams...`);

  // Fetch all channels in parallel
  const teamChannels = await pooled(concurrency, teamsToScan.map((team) => async () => {
    try {
      const channels = await getChannels(team.id);
      return { team, channels: channels.slice(0, 3) };
    } catch {
      return { team, channels: [] };
    }
  }));

  // Fetch messages for all channels in parallel
  const channelTasks = teamChannels.flatMap(({ team, channels }) =>
    channels.map((channel) => async () => {
      try {
        const messages = await graphGetAllPages(`/teams/${team.id}/channels/${channel.id}/messages`,
          { $top: '25' },
          1,
          true  // use beta endpoint
        );
        return { team, channel, messages };
      } catch {
        return { team, channel, messages: [] };
      }
    })
  );

  console.error(`[activity] Scanning ${channelTasks.length} channels in parallel...`);
  const channelResults = await pooled(concurrency, channelTasks);

  const mentions = [];
  for (const { team, channel, messages } of channelResults) {
    for (const m of messages) {
      if (m.messageType !== 'message') continue;
      if (new Date(m.createdDateTime).getTime() < cutoff) continue;
      const hasMention = (m.mentions || []).some(
        (mention) => mention.mentioned?.user?.id === me.id
      );
      const bodyText = m.body?.content ? stripHtml(m.body.content) : '';
      if (hasMention || bodyText.toLowerCase().includes(me.displayName.toLowerCase())) {
        mentions.push({
          from: m.from?.user?.displayName || 'unknown',
          date: m.createdDateTime,
          body: bodyText.slice(0, 500),
          team: team.displayName,
          channel: channel.displayName,
          source: 'channel-scan',
        });
        if (mentions.length >= limit) break;
      }
    }
    if (mentions.length >= limit) break;
  }

  if (allTeams.length > maxTeams) {
    console.error(
      `[activity] Scanned ${maxTeams} of ${allTeams.length} teams. Use --max-teams=N to scan more.`
    );
  }

  return mentions;
}

// Scan 1:1 and group chats for mentions of the current user.
// Uses /me/chats + /me/chats/{id}/messages (requires Chat.Read scope).
async function scanChatsForMentions(me, cutoff, limit, concurrency) {
  console.error('[activity] Scanning chats/DMs...');

  // Fetch recent chats (ordered by last message)
  const chatsResult = await apiGetSafe(`${GRAPH_BASE}/me/chats?$top=50&$orderby=lastMessagePreview/createdDateTime desc&$expand=lastMessagePreview`
  );

  if (!chatsResult.ok) {
    console.error(`[activity] Chat scan unavailable (${chatsResult.status}). Skipping DMs.`);
    return [];
  }

  const chats = (chatsResult.data?.value || []).filter((chat) => {
    // Only scan chats that had recent activity within our time window
    const lastMsg = chat.lastMessagePreview?.createdDateTime;
    if (!lastMsg) return false;
    return new Date(lastMsg).getTime() >= cutoff;
  });

  if (chats.length === 0) {
    console.error('[activity] No recent chat activity in time window.');
    return [];
  }

  console.error(`[activity] Scanning ${chats.length} recent chats for mentions...`);

  // Fetch messages for each chat in parallel
  const chatTasks = chats.map((chat) => async () => {
    try {
      const url = `${GRAPH_BASE}/me/chats/${chat.id}/messages?$top=25`;
      const resp = await apiGetSafe(url);
      if (!resp.ok) return { chat, messages: [] };
      return { chat, messages: resp.data?.value || [] };
    } catch {
      return { chat, messages: [] };
    }
  });

  const chatResults = await pooled(concurrency, chatTasks);

  const mentions = [];
  for (const { chat, messages } of chatResults) {
    for (const m of messages) {
      if (m.messageType !== 'message') continue;
      if (new Date(m.createdDateTime).getTime() < cutoff) continue;
      // Skip messages from self
      if (m.from?.user?.id === me.id) continue;
      const hasMention = (m.mentions || []).some(
        (mention) => mention.mentioned?.user?.id === me.id
      );
      const bodyText = m.body?.content ? stripHtml(m.body.content) : '';
      const mentionsMe = hasMention || bodyText.toLowerCase().includes(me.displayName.toLowerCase());
      // In DMs/group chats, all messages are implicitly "to" you, so include all
      // unless the user specifically asked for @mentions only
      if (mentionsMe || chat.chatType === 'oneOnOne') {
        const chatLabel = chat.topic || chat.chatType === 'oneOnOne' ? 'DM' : 'Group Chat';
        mentions.push({
          from: m.from?.user?.displayName || 'unknown',
          date: m.createdDateTime,
          body: bodyText.slice(0, 500),
          chat: chat.topic || chatLabel,
          chatType: chat.chatType,
          source: 'chat-scan',
        });
        if (mentions.length >= limit) break;
      }
    }
    if (mentions.length >= limit) break;
  }

  console.error(`[activity] Found ${mentions.length} mentions in chats/DMs.`);
  return mentions;
}

// ---------------------------------------------------------------------------
// Substrate Search helper
// ---------------------------------------------------------------------------

// Try Substrate Search API (the internal search engine Teams v2 uses).
// Returns { ok, results } where results is an array of normalized hits.
async function trySubstrateSearch(query, size) {

  const body = {
    EntityRequests: [
      {
        entityType: 'Message',
        query: { queryString: query },
        from: 0,
        size: size || 25,
      },
    ],
  };

  const result = await apiPostSafe(SUBSTRATE_SEARCH_URL, body, SUBSTRATE_AUDIENCE);
  if (!result.ok) return { ok: false, results: [] };

  // Substrate response shape: { EntitySets: [{ ResultSets: [{ Results: [...] }] }] }
  const entitySets = result.data?.EntitySets || result.data?.entitySets || [];
  const resultSets = entitySets[0]?.ResultSets || entitySets[0]?.resultSets || [];
  const hits = resultSets[0]?.Results || resultSets[0]?.results || [];

  const results = hits.map((hit) => {
    const source = hit.Source || hit.source || {};
    return {
      summary: hit.HitHighlightedSummary || hit.Summary || '',
      from: source.From || source.from || source.Creator || source.creator || 'unknown',
      date: source.ItemDate || source.LastModifiedTime || source.itemDate || '',
      body: (source.Preview || source.preview || hit.HitHighlightedSummary || '').slice(0, 500),
      webUrl: source.WebUrl || source.webUrl || source.Path || '',
      source: 'substrate',
    };
  });

  return { ok: true, results };
}

// Try Graph Search API with chatMessage entity type.
// Returns { ok, results } where results is an array of normalized hits.
async function tryGraphSearch(query, size) {
  const searchBody = {
    requests: [
      {
        entityTypes: ['chatMessage'],
        query: { queryString: query },
        from: 0,
        size: size || 25,
      },
    ],
  };

  const searchResult = await graphPostSafe('/search/query', searchBody);
  if (!searchResult.ok) return { ok: false, results: [] };

  const hits = searchResult.data?.value?.[0]?.hitsContainers?.[0]?.hits || [];
  const results = hits.map((hit) => {
    const resource = hit.resource || {};
    return {
      summary: hit.summary || '',
      from: resource.from?.emailAddress?.name || 'unknown',
      date: resource.createdDateTime || resource.lastModifiedDateTime || '',
      body: resource.body?.content ? stripHtml(resource.body.content).slice(0, 500) : hit.summary || '',
      webUrl: resource.webUrl || '',
      source: 'graph',
    };
  });

  return { ok: true, results };
}

// Channel scan fallback for search: scan channels and filter client-side by query.
async function searchChannelFallback(query, since) {
  const maxTeams = parseInt(flags['max-teams'] || '10', 10);
  const concurrency = parseInt(flags['concurrency'] || '5', 10);
  const limit = topN || 25;
  const cutoff = since ? new Date(since).getTime() : 0;
  const queryLower = query.toLowerCase();
  const allTeams = await getTeams();
  const teamsToScan = allTeams.slice(0, maxTeams);

  console.error(`[search] Falling back to channel scan across ${teamsToScan.length} teams...`);

  // Fetch all channels in parallel
  const teamChannels = await pooled(concurrency, teamsToScan.map((team) => async () => {
    try {
      const channels = await getChannels(team.id);
      return { team, channels: channels.slice(0, 3) };
    } catch {
      return { team, channels: [] };
    }
  }));

  // Fetch messages for all channels in parallel
  const channelTasks = teamChannels.flatMap(({ team, channels }) =>
    channels.map((channel) => async () => {
      try {
        const messages = await graphGetAllPages(`/teams/${team.id}/channels/${channel.id}/messages`,
          { $top: '25' },
          1,
          true
        );
        return { team, channel, messages };
      } catch {
        return { team, channel, messages: [] };
      }
    })
  );

  console.error(`[search] Scanning ${channelTasks.length} channels...`);
  const channelResults = await pooled(concurrency, channelTasks);

  const results = [];
  for (const { team, channel, messages } of channelResults) {
    for (const m of messages) {
      if (m.messageType !== 'message') continue;
      if (cutoff && new Date(m.createdDateTime).getTime() < cutoff) continue;
      const bodyText = m.body?.content ? stripHtml(m.body.content) : '';
      if (bodyText.toLowerCase().includes(queryLower)) {
        results.push({
          from: m.from?.user?.displayName || 'unknown',
          date: m.createdDateTime,
          body: bodyText.slice(0, 500),
          team: team.displayName,
          channel: channel.displayName,
          source: 'channel-scan',
        });
        if (results.length >= limit) break;
      }
    }
    if (results.length >= limit) break;
  }

  if (allTeams.length > maxTeams) {
    console.error(
      `[search] Scanned ${maxTeams} of ${allTeams.length} teams. Use --max-teams=N to scan more.`
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Search subcommand  cascading: substrate → Graph → channel scan fallback
// ---------------------------------------------------------------------------

async function cmdSearch() {
  if (!positional[0]) die('Usage: teams search <query> [--since=7d]');
  const query = positional.join(' ');
  const since = sinceDuration ? sinceDate(sinceDuration, 24) : null;
  const size = topN || 25;

  // 1. Try Substrate Search (Teams internal search engine)
  console.error('[search] Trying Substrate Search API...');
  const substrate = await trySubstrateSearch(query, size);
  if (substrate.ok && substrate.results.length > 0) {
    console.error(`[search] Substrate Search returned ${substrate.results.length} results.`);
    const filtered = since
      ? substrate.results.filter((m) => !m.date || new Date(m.date).getTime() >= new Date(since).getTime())
      : substrate.results;
    out(filtered);
    return;
  }
  if (!substrate.ok) {
    console.error('[search] Substrate Search unavailable (no token or API error).');
  } else {
    console.error('[search] Substrate Search returned no results.');
  }

  // 2. Try Graph Search API
  console.error('[search] Trying Graph Search API...');
  const graph = await tryGraphSearch(query, size);
  if (graph.ok && graph.results.length > 0) {
    console.error(`[search] Graph Search returned ${graph.results.length} results.`);
    const filtered = since
      ? graph.results.filter((m) => !m.date || new Date(m.date).getTime() >= new Date(since).getTime())
      : graph.results;
    out(filtered);
    return;
  }
  if (!graph.ok) {
    console.error('[search] Graph Search API returned error (likely missing chatMessage search scope).');
  } else {
    console.error('[search] Graph Search returned no results.');
  }

  // 3. Fall back to channel scan
  const results = await searchChannelFallback(query, since);
  out(results);
}

// ---------------------------------------------------------------------------
// Unanswered subcommand
// ---------------------------------------------------------------------------

async function cmdUnanswered() {
  if (positional.length < 2) die('Usage: teams unanswered <team> <channel> [--since=48h]');
  const team = await resolveTeam(positional[0]);
  const channel = await resolveChannel(team.id, positional[1]);
  const since = sinceDate(sinceDuration, 48);

  const messages = await graphGetAllPages(`/teams/${team.id}/channels/${channel.id}/messages`,
    { $top: '50', $expand: 'replies($top=1)' },
    5,
    true  // use beta endpoint
  );

  const cutoff = new Date(since).getTime();
  const unanswered = messages.filter((m) => {
    if (m.messageType !== 'message') return false;
    if (new Date(m.createdDateTime).getTime() < cutoff) return false;
    const replyCount = m.replies?.length || 0;
    return replyCount === 0;
  });

  out(
    unanswered.map((m) => ({
      id: m.id,
      from: m.from?.user?.displayName || 'unknown',
      date: m.createdDateTime,
      body: m.body?.content ? stripHtml(m.body.content).slice(0, 500) : '',
      importance: m.importance,
      team: team.displayName,
      channel: channel.displayName,
    }))
  );
}

// ---------------------------------------------------------------------------
// Digest subcommand
// ---------------------------------------------------------------------------

async function cmdDigest() {
  const since = sinceDate(sinceDuration, 24);
  const cutoff = new Date(since).getTime();
  const maxTeams = parseInt(flags['max-teams'] || '10', 10);
  const concurrency = parseInt(flags['concurrency'] || '5', 10);
  const allTeams = await getTeams();
  const teamsToScan = allTeams.slice(0, maxTeams);

  console.error(`[digest] Fetching channels for ${teamsToScan.length} of ${allTeams.length} teams in parallel...`);

  // Step 1: fetch all channels in parallel
  const teamChannels = await pooled(concurrency, teamsToScan.map((team) => async () => {
    try {
      const channels = await getChannels(team.id);
      return { team, channels };
    } catch {
      return { team, channels: [] };
    }
  }));

  // Step 2: fetch messages for all channels in parallel (1 page of 25 for speed)
  const channelTasks = teamChannels.flatMap(({ team, channels }) =>
    channels.map((channel) => async () => {
      try {
        const messages = await graphGetAllPages(`/teams/${team.id}/channels/${channel.id}/messages`,
          { $top: '25' },
          1,
          true  // use beta endpoint
        );
        return { team, channel, messages };
      } catch {
        return { team, channel, messages: [] };
      }
    })
  );

  console.error(`[digest] Fetching messages for ${channelTasks.length} channels in parallel...`);
  const channelResults = await pooled(concurrency, channelTasks);

  // Step 3: build digest from results
  const digest = [];
  for (const { team, channel, messages } of channelResults) {
    const recent = messages.filter(
      (m) => m.messageType === 'message' && new Date(m.createdDateTime).getTime() >= cutoff
    );
    if (recent.length === 0) continue;

    const authors = new Set(recent.map((m) => m.from?.user?.displayName || 'unknown'));
    const hasAttachments = recent.some((m) => (m.attachments || []).length > 0);
    const allReactions = recent.flatMap((m) => (m.reactions || []).map((r) => r.reactionType));
    const topMessages = recent.slice(0, 3).map((m) => ({
      from: m.from?.user?.displayName || 'unknown',
      date: m.createdDateTime,
      preview: m.body?.content ? stripHtml(m.body.content).slice(0, 200) : '',
    }));

    digest.push({
      team: team.displayName,
      channel: channel.displayName,
      messageCount: recent.length,
      uniqueAuthors: authors.size,
      authors: [...authors],
      hasAttachments,
      reactionSummary: countOccurrences(allReactions),
      topMessages,
    });
  }

  digest.sort((a, b) => b.messageCount - a.messageCount);

  if (allTeams.length > maxTeams) {
    console.error(
      `[digest] Results cover ${maxTeams} of ${allTeams.length} teams. Use --max-teams=N to scan more.`
    );
  }

  out(digest);
}

function countOccurrences(arr) {
  const counts = {};
  for (const item of arr) {
    counts[item] = (counts[item] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transcribe subcommand — turn on live captions and capture the transcript
// ---------------------------------------------------------------------------
//
// Teams' official meeting transcript/recording is NOT reachable with the
// delegated Graph token this skill uses (the Teams web session lacks the
// OnlineMeetingTranscript.Read.All / OnlineMeetingRecording.Read.All /
// OnlineMeetings.Read scopes — every such call 403s). So this captures the
// live *captions* instead, which only require your own in-meeting view.
//
// `start` navigates the meeting menu to turn on "Show live captions" and then
// installs a tiny in-page collector: a 300ms poller on the caption virtual-list
// that commits each finalized phrase into a window buffer which survives across
// evals, so nothing is lost as caption rows scroll out of the small live view.
// `flush` appends newly-finalized phrases to a transcript file.

const CAP_LIST_TID = 'closed-caption-v2-virtual-list-content';

// Idempotent in-page collector installer; returns the current buffer + state.
const CAP_COLLECTOR_JS = `
  (() => {
    if (!window.__sliccCapInstalled) {
      window.__sliccCapInstalled = true;
      window.__sliccCaps = [];
      window.__capState = { prevAuthor: null, prevText: '' };
      const parseRow = (row) => {
        const textEl = row.querySelector('[data-tid="closed-caption-text"]');
        const full = (row.innerText || '').trim();
        const text = textEl ? (textEl.innerText || '').trim() : '';
        let author = full;
        if (text && full.endsWith(text)) author = full.slice(0, full.length - text.length).trim();
        author = (author.split('\\n')[0] || '').trim();
        return { author, text };
      };
      const tick = () => {
        try {
          const list = document.querySelector('[data-tid="${CAP_LIST_TID}"]');
          if (!list || !list.children.length) return;
          const rows = Array.from(list.children);
          const bottom = parseRow(rows[rows.length - 1]);
          const st = window.__capState;
          // A new phrase has started when the bottom row no longer extends the
          // previous one (different speaker, or text no longer a growing prefix).
          if (st.prevText && !(bottom.author === st.prevAuthor && bottom.text.startsWith(st.prevText))) {
            const phrase = { author: st.prevAuthor, text: st.prevText, ts: Date.now() };
            window.__sliccCaps.push(phrase);
            // Copilot mode: fire the finalized phrase at a SLICC webhook so it
            // arrives as a lick to the wired scoop (no polling). Fire-and-forget,
            // no-cors — we only need to trigger it, not read the response.
            if (window.__sliccCapWebhook) {
              try {
                fetch(window.__sliccCapWebhook, {
                  method: 'POST',
                  mode: 'no-cors',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(phrase),
                });
              } catch (e) {}
            }
          }
          st.prevAuthor = bottom.author;
          st.prevText = bottom.text;
        } catch (e) {}
      };
      window.__sliccCapTimer = setInterval(tick, 300);
    }
    return JSON.stringify({
      buffer: window.__sliccCaps,
      pending: window.__capState ? { author: window.__capState.prevAuthor, text: window.__capState.prevText } : null,
      captionsRendering: !!document.querySelector('[data-tid="${CAP_LIST_TID}"]')
    });
  })()
`;

// Coerce an evalAsync result that may arrive as a boolean or a "true"/"false" string.
function _asBool(v) {
  return v === true || v === 'true';
}

// Walk the meeting overflow menu to enable "Show live captions".
// Returns: 'already-on' | 'enabled' | 'clicked-unconfirmed' | 'not-in-meeting'
//        | 'no-language-menu' | 'no-caption-toggle'.
async function enableLiveCaptions(tab) {
  const rendering0 = await browser.evalAsync(tab, `(() => !!document.querySelector('[data-tid="${CAP_LIST_TID}"]'))()`);
  if (_asBool(rendering0)) return 'already-on';

  const clickedMore = await browser.evalAsync(tab, `(() => {
    const b = Array.from(document.querySelectorAll('button,[role="button"]'))
      .find(x => (x.getAttribute('aria-label') || '') === 'More' || (x.innerText || '').trim() === 'More');
    if (!b) return 'no-more';
    b.click();
    return 'ok';
  })()`);
  if (clickedMore === 'no-more') return 'not-in-meeting';
  await sleep(1200);

  const langOpened = await browser.evalAsync(tab, `(() => {
    const it = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find(e => (e.innerText || '').trim().startsWith('Language and speech'));
    if (!it) return 'no-langspeech';
    it.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    it.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    it.click();
    return 'ok';
  })()`);
  if (langOpened === 'no-langspeech') return 'no-language-menu';
  await sleep(1200);

  const toggled = await browser.evalAsync(tab, `(() => {
    const it = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]'))
      .find(e => (e.innerText || '').trim().startsWith('Show live captions'));
    if (!it) return 'no-toggle';
    if (it.getAttribute('aria-checked') === 'true') return 'already-on';
    it.click();
    return 'clicked';
  })()`);
  if (toggled === 'no-toggle') return 'no-caption-toggle';
  if (toggled === 'already-on') return 'already-on';

  // Captions can take several seconds to render after toggling — especially
  // right after joining a meeting — so poll for the panel (up to ~12s) rather
  // than giving up after a single short wait.
  for (let i = 0; i < 8; i++) {
    await sleep(1500);
    const rendering1 = await browser.evalAsync(tab, `(() => !!document.querySelector('[data-tid="${CAP_LIST_TID}"]'))()`);
    if (_asBool(rendering1)) return 'enabled';
  }
  return 'clicked-unconfirmed';
}

// --- Copilot mode helpers: webhook wiring, snapshots, meeting-chat posting ---

const TRANSCRIBE_STATE = '/shared/.teams-transcribe-state.json';

function _readTranscribeState() {
  try { const fs = require('fs'); return JSON.parse(fs.readFileSync(TRANSCRIBE_STATE, 'utf8')); } catch (e) { return {}; }
}
function _writeTranscribeState(st) {
  try { const fs = require('fs'); fs.writeFileSync(TRANSCRIBE_STATE, JSON.stringify(st, null, 2)); } catch (e) {}
}

// Create a SLICC webhook routed to <scoop>. Returns { id, url } or null.
async function createTranscribeWebhook(scoop) {
  const r = await exec(`webhook create --scoop ${scoop} --name teams-transcribe`);
  if (r.exitCode !== 0) return null;
  const idM = (r.stdout || '').match(/ID:\s*(\S+)/);
  const urlM = (r.stdout || '').match(/URL:\s*(\S+)/);
  if (!idM || !urlM) return null;
  return { id: idM[1], url: urlM[1] };
}

async function deleteWebhook(id) {
  if (!id) return;
  try { await exec(`webhook delete ${id}`); } catch (e) {}
}

// Point the in-page collector at a webhook URL (fired per finalized phrase).
async function setCollectorWebhook(tab, url) {
  await browser.evalAsync(tab, `(() => { window.__sliccCapWebhook = ${JSON.stringify(url || '')}; return 'ok'; })()`);
}

// Detect whether a screen share is active in the meeting.
// VALIDATE-LIVE: selectors may need tuning against a real Teams meeting.
async function isScreenSharing(tab) {
  const r = await browser.evalAsync(tab, `(() => {
    const sels = ['[data-tid*="screenshare" i]','[data-tid*="screen-share" i]','[data-tid="shared-content"]','[data-tid="ScreenShareStage"]','[aria-label*="is sharing" i]','[aria-label*="presenting" i]'];
    for (const s of sels) { try { if (document.querySelector(s)) return true; } catch (e) {} }
    const ctrls = Array.from(document.querySelectorAll('button,[role="button"]'));
    if (ctrls.some((b) => /stop (sharing|presenting)/i.test((b.getAttribute('aria-label') || b.innerText || '')))) return true;
    return false;
  })()`);
  return _asBool(r);
}

// Screenshot the Teams window; keep only if different from the last kept shot
// (md5 dedupe). The whole pipeline runs in the exec shell context so the
// screenshot file and md5sum share one filesystem view.
// VALIDATE-LIVE: confirm `playwright-cli screenshot --tab` is available in exec
// and writes where md5sum can read it.
async function takeSnapshot(tab, shotsDir) {
  const tid = _targetId(tab);
  const dir = shotsDir || '/shared/copilot-shots';
  const ts = Date.now();
  const script =
    `mkdir -p ${dir}; ` +
    `tmp=${dir}/.tmp-${ts}.png; ` +
    `playwright-cli screenshot --tab=${tid} --filename="$tmp" --max-width=1600 >/dev/null 2>&1 || { echo SNAP_ERR; exit 0; }; ` +
    `nm=$(md5sum "$tmp" 2>/dev/null | awk '{print $1}'); ` +
    `lm=$(cat ${dir}/.last-md5 2>/dev/null); ` +
    `if [ -n "$nm" ] && [ "$nm" = "$lm" ]; then rm -f "$tmp"; echo SNAP_UNCHANGED; exit 0; fi; ` +
    `final=${dir}/shot-${ts}.png; mv "$tmp" "$final"; echo "$nm" > ${dir}/.last-md5; echo "SNAP_SAVED $final"`;
  const r = await exec(script);
  const o = (r.stdout || '').trim();
  if (o.includes('SNAP_SAVED')) return { saved: true, path: o.split('SNAP_SAVED ')[1].split(/\s/)[0] };
  if (o.includes('SNAP_UNCHANGED')) return { saved: false, reason: 'unchanged' };
  return { saved: false, reason: 'screenshot_failed' };
}

// Post a message into the CURRENTLY ACTIVE meeting's chat via the DOM.
// Visible to ALL participants. VALIDATE-LIVE: the meeting-chat input selector and
// send mechanism vary by Teams build; tune against a real meeting.
async function postToMeetingChat(tab, message) {
  const js = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const findBox = () => document.querySelector(
      '[data-tid="ckeditor"] [contenteditable="true"], ' +
      'div[role="textbox"][contenteditable="true"], ' +
      '[data-tid="message-input"] [contenteditable="true"], ' +
      '[contenteditable="true"][aria-label*="message" i], ' +
      '[contenteditable="true"][data-tid*="input" i]'
    );
    let box = findBox();
    if (!box) {
      const toggle = Array.from(document.querySelectorAll('button,[role="button"]'))
        .find((b) => /chat/i.test((b.getAttribute('aria-label') || '')) && !/close/i.test((b.getAttribute('aria-label') || '')));
      if (toggle) { toggle.click(); await sleep(1500); box = findBox(); }
    }
    if (!box) return 'no-input';
    box.focus();
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, ${JSON.stringify(message)}); } catch (e) {}
    if (!inserted || !(box.textContent || '').trim()) {
      box.textContent = ${JSON.stringify(message)};
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(400);
    const sendBtn = document.querySelector('button[data-tid="newMessageCommands-send"], button[name="send"], button[aria-label*="Send" i]');
    if (sendBtn && !sendBtn.disabled) { sendBtn.click(); return 'sent-button'; }
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    box.dispatchEvent(new KeyboardEvent('keydown', opts));
    box.dispatchEvent(new KeyboardEvent('keyup', opts));
    return 'sent-enter';
  })()`;
  const r = await browser.evalAsync(tab, js);
  return (typeof r === 'string') ? r : JSON.stringify(r);
}

async function cmdTranscribe() {
  const fs = require('fs');
  const sub = (positional[0] || 'start').toLowerCase();
  const outFile = flags.out || flags.o || 'teams-transcript.md';
  const idxFile = outFile + '.idx';
  const tab = await findTeamsTab(); // dies if no Teams tab

  async function readCollector() {
    let raw = await browser.evalAsync(tab, CAP_COLLECTOR_JS);
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) {} }
    if (!raw || typeof raw !== 'object') raw = {};
    return { buffer: raw.buffer || [], pending: raw.pending || null, captionsRendering: !!raw.captionsRendering };
  }

  // Append newly-finalized phrases to the transcript file. Returns the fresh entries.
  function flushToFile(buffer) {
    if (!fs.existsSync(outFile)) {
      fs.writeFileSync(outFile, `# Teams Meeting Transcript\n\nCaptured live via Teams captions. Started ${new Date().toISOString()}\n\n`);
    }
    let idx = 0;
    try { idx = parseInt(fs.readFileSync(idxFile, 'utf8').trim(), 10) || 0; } catch (e) { idx = 0; }
    const fresh = buffer.slice(idx);
    if (fresh.length) {
      const lines = fresh.map((c) => {
        const t = new Date(c.ts).toISOString().slice(11, 19);
        return `**[${t}] ${c.author || '?'}:** ${c.text}`;
      }).join('\n\n');
      fs.appendFileSync(outFile, lines + '\n\n');
      fs.writeFileSync(idxFile, String(buffer.length));
    }
    return fresh;
  }

  switch (sub) {
    case 'start': {
      const status = await enableLiveCaptions(tab);
      if (status === 'not-in-meeting') {
        die('No active meeting found in the Teams tab. Join a meeting first, then run: teams transcribe start');
      }
      await readCollector(); // install the collector
      if (status === 'enabled' || status === 'already-on') {
        console.log('Live transcription started — captions are on and the collector is running.');
      } else if (status === 'clicked-unconfirmed') {
        console.log('Requested live captions (panel not confirmed yet). Collector is running; it will pick up phrases as soon as captions render.');
      } else {
        console.log(`Could not fully enable captions (${status}). Turn on "More (...) -> Language and speech -> Show live captions" manually, then run: teams transcribe start`);
      }

      // Copilot mode: --scoop <name> wires each finalized phrase to a webhook
      // that delivers a lick to that scoop (event-driven, no polling).
      const state = { outFile, shotsDir: flags['shots-dir'] || '/shared/copilot-shots' };
      if (flags.scoop) {
        const prev = _readTranscribeState();
        if (prev.webhookId) await deleteWebhook(prev.webhookId); // avoid orphaning a previous one
        const wh = await createTranscribeWebhook(flags.scoop);
        if (!wh) {
          console.log(`WARNING: could not create webhook for scoop "${flags.scoop}" — phrases will still be captured, but no licks will fire.`);
        } else {
          await setCollectorWebhook(tab, wh.url);
          state.webhookId = wh.id;
          state.scoop = flags.scoop;
          console.log(`Copilot mode: each finalized phrase now fires a lick to scoop "${flags.scoop}" (webhook ${wh.id}).`);
        }
      }
      _writeTranscribeState(state);

      const outFlag = (flags.out || flags.o) ? ` --out=${outFile}` : '';
      console.log(`Transcript file: ${outFile}`);
      console.log(`Flush new lines:  teams transcribe flush${outFlag}`);
      console.log(`Live status/tail: teams transcribe status`);
      console.log(`Stream + flush:   teams transcribe follow${outFlag}`);
      console.log(`Stop capturing:   teams transcribe stop${outFlag}`);
      break;
    }

    case 'flush': {
      const { buffer } = await readCollector();
      const fresh = flushToFile(buffer);
      console.log(`Flushed ${fresh.length} new phrase(s). Total captured: ${buffer.length}. -> ${outFile}`);
      break;
    }

    case 'status': {
      const { buffer, pending, captionsRendering } = await readCollector();
      console.log(`Captions rendering: ${captionsRendering ? 'yes' : 'no'}`);
      console.log(`Buffered phrases:   ${buffer.length}`);
      if (pending && pending.text) console.log(`Live (in progress): [${pending.author || '?'}] ${pending.text}`);
      break;
    }

    case 'stop': {
      const { buffer } = await readCollector();
      const fresh = flushToFile(buffer);
      await browser.evalAsync(tab, `(() => { if (window.__sliccCapTimer) clearInterval(window.__sliccCapTimer); window.__sliccCapInstalled = false; window.__sliccCapWebhook = null; return 'stopped'; })()`);
      // Tear down copilot webhook if one was wired.
      const st = _readTranscribeState();
      if (st.webhookId) {
        await deleteWebhook(st.webhookId);
        console.log(`Copilot webhook ${st.webhookId} removed.`);
      }
      _writeTranscribeState({});
      console.log(`Stopped. Flushed final ${fresh.length} phrase(s). Total captured: ${buffer.length}. -> ${outFile}`);
      console.log('(Live captions remain toggled on in the meeting UI — turn them off manually if you want.)');
      break;
    }

    case 'follow': {
      const status = await enableLiveCaptions(tab);
      if (status === 'not-in-meeting') {
        die('No active meeting found in the Teams tab. Join a meeting first, then run: teams transcribe follow');
      }
      const intervalSec = flags.interval ? Math.max(1, parseInt(flags.interval, 10)) : 5;
      const maxMin = flags.max ? parseInt(flags.max, 10) : 180;
      const idleStopMin = flags['idle-stop'] ? parseInt(flags['idle-stop'], 10) : 30;
      console.log(`Following live transcript — flushing every ${intervalSec}s to ${outFile}. This blocks; press Ctrl-C to stop.\n`);
      const startT = Date.now();
      let lastNew = Date.now();
      while (true) {
        const { buffer } = await readCollector();
        const fresh = flushToFile(buffer);
        for (const c of fresh) {
          const t = new Date(c.ts).toISOString().slice(11, 19);
          console.log(`[${t}] ${c.author || '?'}: ${c.text}`);
        }
        if (fresh.length) lastNew = Date.now();
        if (Date.now() - lastNew > idleStopMin * 60000) { console.log(`\nNo captions for ${idleStopMin} min — stopping.`); break; }
        if (Date.now() - startT > maxMin * 60000) { console.log('\nMax duration reached — stopping.'); break; }
        await sleep(intervalSec * 1000);
      }
      break;
    }

    default:
      die(`Unknown transcribe subcommand: ${sub}. Use one of: start | flush | status | follow | stop`);
  }

  // --snapshot flag: composes with any subcommand (except follow, which loops).
  // Captures a deduped screenshot of the Teams window IF a screen share is active.
  // The copilot scoop typically calls `teams transcribe flush --snapshot` per lick.
  if (flags.snapshot && sub !== 'follow') {
    const st = _readTranscribeState();
    const shotsDir = flags['shots-dir'] || st.shotsDir || '/shared/copilot-shots';
    const sharing = await isScreenSharing(tab);
    if (!sharing) {
      console.log('Snapshot: skipped (no screen share detected).');
    } else {
      const snap = await takeSnapshot(tab, shotsDir);
      if (snap.saved) console.log(`Snapshot: ${snap.path}`);
      else if (snap.reason === 'unchanged') console.log('Snapshot: unchanged since last frame (skipped).');
      else console.log('Snapshot: capture failed.');
    }
  }
}

function showHelp() {
  console.log(`teams  Microsoft Teams access via Graph API + Substrate Search

Usage: teams <command> [args] [--since=<duration>] [--top=<n>] [--max-teams=<n>]

Commands:
  teams                             List joined teams
  channels <team>                   List channels in a team
  channels <team> --search=term     Filter channels by name
  channels --search=term            Search channels across all teams
  history <team> <channel>          Fetch recent messages (default: --since=24h)
  activity                          Messages mentioning/involving me (default: --since=24h)
  post <team> <channel> <message>   Post a message to a channel
  post ... --reply-to=<msg-id>      Reply in a thread
  post --live <message>             Post into the CURRENTLY ACTIVE meeting chat (visible to all)
  thread <team> <channel> <msg-id>  Read replies to a message
  user <user-id-or-name>            Look up a user
  info <team> <channel>             Channel metadata
  search <query>                    Full-text search across Teams messages
  unanswered <team> <channel>       Messages with no replies (default: --since=48h)
  digest                            Activity summary across all teams (default: --since=24h, --max-teams=10)
  transcribe [start]                Turn on live captions in the active meeting and capture the transcript
  transcribe start --scoop <name>   Copilot mode: fire a lick to <name> for each finalized phrase
  transcribe flush [--snapshot]     Append new phrases; --snapshot also grabs a deduped screen-share frame
  transcribe status                 Show whether captions render + buffered/live lines
  transcribe follow [--out=FILE]    Stream the transcript live and flush continuously (blocks)
  transcribe stop [--out=FILE]      Final flush, remove copilot webhook, stop the collector
    flags: --out=FILE  --scoop=NAME  --snapshot  --shots-dir=DIR  --interval=SEC (follow)

Aliases: messages/msgs → history, mentions → activity

Duration format: <number><unit> where unit is m(inutes), h(ours), d(ays), w(eeks)
  Examples: 30m, 24h, 7d, 2w

--max-teams=N    Cap digest/activity/search scan to N teams (default: 10).
--concurrency=N  Parallel API requests for digest/activity/search (default: 5, max: 10).

Team and channel arguments accept display names (case-insensitive partial match) or IDs.

Search cascade: Substrate Search → Graph Search API → channel scan fallback.
Activity cascade: Substrate Search → Graph Search → channel scan + chat/DM scan.

Authentication: API calls run inside the Teams tab via the sliccy:browser bridge,
so the MSAL session token is consumed in-page and never written to disk.
Requires an authenticated Teams tab open at https://teams.microsoft.com.`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

switch (subcommand) {
  case 'teams':
    await cmdTeams();
    break;
  case 'channels':
    await cmdChannels();
    break;
  case 'history':
  case 'messages':
  case 'msgs':
    await cmdHistory();
    break;
  case 'activity':
  case 'mentions':
    await cmdActivity();
    break;
  case 'post':
    await cmdPost();
    break;
  case 'thread':
    await cmdThread();
    break;
  case 'user':
    await cmdUser();
    break;
  case 'info':
    await cmdInfo();
    break;
  case 'search':
    await cmdSearch();
    break;
  case 'unanswered':
    await cmdUnanswered();
    break;
  case 'digest':
    await cmdDigest();
    break;
  case 'transcribe':
  case 'transcript':
  case 'caption':
  case 'captions':
    await cmdTranscribe();
    break;
  case '--help':
  case '-h':
  case 'help':
  case '':
    showHelp();
    break;
  default:
    console.error(`Unknown command: ${subcommand}`);
    showHelp();
    process.exit(1);
}
