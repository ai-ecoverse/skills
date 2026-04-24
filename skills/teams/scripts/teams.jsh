// teams.jsh  Microsoft Teams channel scanner via Graph API
// Auto-discovered as `teams` shell command in SLICC.
//
// Usage: teams <subcommand> [args] [--since=<duration>] [--top=<n>]
// Subcommands: auth, teams, channels, history, activity, post, thread, user, info, search, unanswered, digest

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_BETA = 'https://graph.microsoft.com/beta';
// NOTE: Channel message reads must use GRAPH_BETA. The delegated token from the Teams
// browser session does not include ChannelMessage.Read.All, so the v1.0 messages endpoint
// returns 403. The beta endpoint works with the scopes the Teams session provides.
const TOKEN_PATH = '/workspace/.teams-token';
const SUBSTRATE_TOKEN_PATH = '/workspace/.teams-substrate-token';
const TEAMS_CACHE_PATH = '/workspace/.teams-cache.json';
const SUBSTRATE_SEARCH_URL = 'https://substrate.office.com/search/api/v2/query';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const subcommand = args[0] || '';
const positional = [];
const flags = {};

for (let i = 1; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      flags[arg.slice(2)] = true;
    }
  } else {
    positional.push(arg);
  }
}

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
// Token management
// ---------------------------------------------------------------------------

async function readToken() {
  try {
    const token = (await fs.readFile(TOKEN_PATH)).trim();
    if (!token) throw new Error('empty');
    return token;
  } catch {
    die(
      'No auth token found. Run `teams auth` first to extract a token from your Teams browser session.'
    );
  }
}

async function saveToken(token) {
  await fs.writeFile(TOKEN_PATH, token);
}

async function readSubstrateToken() {
  try {
    const token = (await fs.readFile(SUBSTRATE_TOKEN_PATH)).trim();
    if (!token) return null;
    return token;
  } catch {
    return null;
  }
}

async function saveSubstrateToken(token) {
  await fs.writeFile(SUBSTRATE_TOKEN_PATH, token);
}

// ---------------------------------------------------------------------------
// Graph API client
// ---------------------------------------------------------------------------

async function graphGet(token, path, params, retries = 3) {
  let url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (resp.status === 401) {
    die('401 Unauthorized  token expired. Run `teams auth` to refresh.');
  }
  if (resp.status === 403) {
    die(
      '403 Forbidden  insufficient permissions. The token may lack required Graph API scopes. See reference.md.'
    );
  }
  if (resp.status === 429) {
    if (retries > 0) {
      const retryAfter = Math.min(parseInt(resp.headers.get('Retry-After') || '5', 10), 30);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return graphGet(token, path, params, retries - 1);
    }
    die('429 Too Many Requests  rate limited. Wait a moment and retry.');
  }
  if (!resp.ok) {
    const body = await resp.text();
    die(`Graph API error ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function graphPost(token, path, body) {
  const url = path.startsWith('http') ? path : `${GRAPH_BETA}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (resp.status === 401) {
    die('401 Unauthorized  token expired. Run `teams auth` to refresh.');
  }
  if (!resp.ok) {
    const text = await resp.text();
    die(`Graph API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Non-fatal POST  returns {ok, status, data} instead of calling die().
// Used for optional endpoints (Search API) where failure should trigger a fallback.
async function graphPostSafe(token, path, body) {
  const url = path.startsWith('http') ? path : `${GRAPH_BETA}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { ok: false, status: resp.status, data: null };
  return { ok: true, status: resp.status, data: await resp.json() };
}

// Generic safe POST for any bearer-token API (e.g. substrate search).
async function apiPostSafe(token, url, body) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { ok: false, status: resp.status, data: null };
    return { ok: true, status: resp.status, data: await resp.json() };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// Generic safe GET for any bearer-token API.
async function apiGetSafe(token, url) {
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!resp.ok) return { ok: false, status: resp.status, data: null };
    return { ok: true, status: resp.status, data: await resp.json() };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function graphGetAllPages(token, path, params, maxPages, useBeta) {
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
    const data = await graphGet(token, url);
    if (data.value) results.push(...data.value);
    url = data['@odata.nextLink'] || null;
    pages++;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Teams/channel resolution (name ’ ID)
// ---------------------------------------------------------------------------

async function getTeams(token) {
  return graphGetAllPages(token, '/me/joinedTeams');
}

async function resolveTeam(token, nameOrId) {
  const teams = await getTeams(token);
  const lower = nameOrId.toLowerCase();
  const exact = teams.find((t) => t.id === nameOrId);
  if (exact) return exact;
  const match = teams.find((t) => t.displayName.toLowerCase().includes(lower));
  if (!match) die(`Team not found: "${nameOrId}". Run \`teams teams\` to list available teams.`);
  return match;
}

async function getChannels(token, teamId) {
  return graphGetAllPages(token, `/teams/${teamId}/channels`);
}

async function resolveChannel(token, teamId, nameOrId) {
  const channels = await getChannels(token, teamId);
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
// Auth subcommand  extract MSAL token from Teams browser tab
// ---------------------------------------------------------------------------

async function cmdAuth() {
  const tabId = await findTeamsTab();

  // Write the token-extraction script to a temp VFS file so we avoid
  // shell-quoting headaches with the long JS expression.
  //
  // IMPORTANT: Modern Teams (v2, teams.microsoft.com/v2/) stores MSAL tokens in
  // localStorage, NOT sessionStorage. We search localStorage for the freshest
  // Graph token (key contains "accesstoken" + "graph.microsoft.com"), falling
  // back to sessionStorage for older Teams versions.
  //
  // We also extract the substrate.office.com token for Substrate Search API
  // access (the internal search engine Teams v2 uses for message search).
  const extractScript = [
    '(function(){',
    // --- Graph token ---
    'var best=null,bestExp=0;',
    'var lkeys=Object.keys(localStorage);',
    'for(var i=0;i<lkeys.length;i++){',
    'var k=lkeys[i];',
    'if(k.indexOf("accesstoken")===-1||k.indexOf("graph.microsoft.com")===-1)continue;',
    'try{var e=JSON.parse(localStorage.getItem(k));',
    'var exp=parseInt(e.expiresOn||e.expires_on||0);',
    'if(e&&e.secret&&exp>bestExp){best=e;bestExp=exp;}}catch(x){}}',
    // --- Substrate token ---
    'var sBest=null,sBestExp=0;',
    'for(var s=0;s<lkeys.length;s++){',
    'var sk=lkeys[s];',
    'if(sk.indexOf("accesstoken")===-1||sk.indexOf("substrate.office.com")===-1)continue;',
    'try{var se=JSON.parse(localStorage.getItem(sk));',
    'var sexp=parseInt(se.expiresOn||se.expires_on||0);',
    'if(se&&se.secret&&sexp>sBestExp){sBest=se;sBestExp=sexp;}}catch(sx){}}',
    // Build result
    'var result={};',
    'if(best){result.token=best.secret;result.expiresOn=best.expiresOn||best.expires_on;}',
    'if(sBest){result.substrateToken=sBest.secret;result.substrateExpiresOn=sBest.expiresOn||sBest.expires_on;}',
    'if(result.token)return JSON.stringify(result);',
    // Fallback: sessionStorage (older Teams)
    'for(var j=0;j<sessionStorage.length;j++){',
    'var k2=sessionStorage.key(j);',
    'if(k2&&k2.toLowerCase().indexOf("accesstoken")!==-1&&k2.toLowerCase().indexOf("graph.microsoft.com")!==-1){',
    'try{var e2=JSON.parse(sessionStorage.getItem(k2));',
    'if(e2&&e2.secret)return JSON.stringify({token:e2.secret,expiresOn:e2.expires_on||e2.expiresOn})}catch(x2){}}',
    '}',
    'return null})()',
  ].join('');

  await fs.writeFile('/tmp/.teams-scout-eval.js', extractScript);
  const scriptContent = await fs.readFile('/tmp/.teams-scout-eval.js');

  // Pass the single-line expression through exec; JSON.stringify adds safe quoting
  const evalResult = await exec(
    'playwright-cli eval --tab=' + tabId + ' ' + JSON.stringify(scriptContent)
  );
  const evalOutput = evalResult.stdout.trim();

  if (!evalOutput || evalOutput === 'null' || evalOutput === 'undefined') {
    die(
      'No MSAL token found in Teams session storage. Make sure Teams is fully loaded and you are logged in. Try refreshing the page.'
    );
  }

  let tokenData;
  try {
    let parsed = evalOutput;
    // The eval output may be double-stringified
    if (parsed.startsWith('"') && parsed.endsWith('"')) {
      parsed = JSON.parse(parsed);
    }
    tokenData = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch (e) {
    die('Failed to parse token data: ' + evalOutput);
  }

  if (!tokenData || !tokenData.token) {
    die('Token extraction returned empty data. Teams may not be fully loaded.');
  }

  await saveToken(tokenData.token);

  // Save substrate token if available
  const hasSubstrate = !!(tokenData.substrateToken);
  if (hasSubstrate) {
    await saveSubstrateToken(tokenData.substrateToken);
  }

  // Verify token by fetching user profile
  const me = await graphGet(tokenData.token, '/me');
  out({
    status: 'authenticated',
    user: me.displayName,
    email: me.mail || me.userPrincipalName,
    id: me.id,
    expiresOn: tokenData.expiresOn || 'unknown',
    substrateSearch: hasSubstrate ? 'available' : 'not found',
    substrateExpiresOn: tokenData.substrateExpiresOn || undefined,
  });
}

async function findTeamsTab() {
  const tabListResult = await exec('playwright-cli tab-list');
  const lines = tabListResult.stdout.split('\n');
  const teamsLine = lines.find(
    (l) => l.includes('teams.microsoft.com') || l.includes('teams.live.com')
  );

  if (!teamsLine) {
    die(
      'No Teams tab found. Open Teams first:\n  open https://teams.microsoft.com\nWait for it to load, then retry `teams auth`.'
    );
  }

  const idMatch = teamsLine.match(/\[targetId:\s*([^\]]+)\]/) || teamsLine.match(/^\[([^\]]+)\]/);
  if (!idMatch) die('Could not parse Teams tab ID from tab-list output.');
  return idMatch[1].trim();
}

// ---------------------------------------------------------------------------
// Teams subcommand
// ---------------------------------------------------------------------------

async function cmdTeams() {
  const token = await readToken();
  const teams = await getTeams(token);
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
  const token = await readToken();
  const term = flags.search ? flags.search.toLowerCase() : null;

  if (!positional[0] && !term) {
    die('Usage: teams channels <teamNameOrId> [--search=term]\n       teams channels --search=term   (search across all teams)');
  }

  if (positional[0]) {
    const team = await resolveTeam(token, positional[0]);
    let channels = await getChannels(token, team.id);
    if (term) channels = channels.filter(c => c.displayName.toLowerCase().includes(term));
    out(channels.map((c) => ({ id: c.id, name: c.displayName, description: c.description || '', membershipType: c.membershipType, team: team.displayName })));
  } else {
    const teams = await getTeams(token);
    const results = [];
    for (const t of teams) {
      try {
        const channels = await getChannels(token, t.id);
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
  const token = await readToken();
  const team = await resolveTeam(token, positional[0]);
  const channel = await resolveChannel(token, team.id, positional[1]);
  const since = sinceDate(sinceDuration, 24);
  const top = topN || 50;

  const messages = await graphGetAllPages(
    token,
    `/teams/${team.id}/channels/${channel.id}/messages`,
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
  if (positional.length < 3) die('Usage: teams post <team> <channel> <message> [--reply-to=<message-id>]');
  const token = await readToken();
  const team = await resolveTeam(token, positional[0]);
  const channel = await resolveChannel(token, team.id, positional[1]);
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
    result = await graphPost(token, `/teams/${team.id}/channels/${channel.id}/messages`, body);
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
  const token = await readToken();
  const team = await resolveTeam(token, positional[0]);
  const channel = await resolveChannel(token, team.id, positional[1]);
  const messageId = positional[2];
  const top = topN || 50;

  const replies = await graphGetAllPages(
    token,
    `/teams/${team.id}/channels/${channel.id}/messages/${messageId}/replies`,
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
  const token = await readToken();
  const query = positional.join(' ');

  let user;
  if (query.match(/^[0-9a-f-]{36}$/i) || query.includes('@')) {
    user = await graphGet(token, `/users/${encodeURIComponent(query)}`);
  } else {
    const results = await graphGet(token, '/users', {
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
  const token = await readToken();
  const team = await resolveTeam(token, positional[0]);
  const channel = await resolveChannel(token, team.id, positional[1]);

  const info = await graphGet(token, `/teams/${team.id}/channels/${channel.id}`);
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
  const token = await readToken();
  const since = sinceDate(sinceDuration, 24); // default 24h
  const limit = topN || 25;

  const me = await graphGet(token, '/me');
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
  const graph = await tryGraphSearch(token, displayName, limit);
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
  await cmdActivityFallback(token, me, since);
}

async function cmdActivityFallback(token, me, since) {
  const maxTeams = parseInt(flags['max-teams'] || '10', 10);
  const concurrency = parseInt(flags['concurrency'] || '5', 10);
  const limit = topN || 25;
  const cutoff = new Date(since).getTime();

  // Run channel scan and chat scan in parallel
  const [channelMentions, chatMentions] = await Promise.all([
    scanChannelsForMentions(token, me, cutoff, limit, maxTeams, concurrency),
    scanChatsForMentions(token, me, cutoff, limit, concurrency),
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
async function scanChannelsForMentions(token, me, cutoff, limit, maxTeams, concurrency) {
  const allTeams = await getTeams(token);
  const teamsToScan = allTeams.slice(0, maxTeams);

  console.error(`[activity] Scanning channels in ${teamsToScan.length} teams...`);

  // Fetch all channels in parallel
  const teamChannels = await pooled(concurrency, teamsToScan.map((team) => async () => {
    try {
      const channels = await getChannels(token, team.id);
      return { team, channels: channels.slice(0, 3) };
    } catch {
      return { team, channels: [] };
    }
  }));

  // Fetch messages for all channels in parallel
  const channelTasks = teamChannels.flatMap(({ team, channels }) =>
    channels.map((channel) => async () => {
      try {
        const messages = await graphGetAllPages(
          token,
          `/teams/${team.id}/channels/${channel.id}/messages`,
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
async function scanChatsForMentions(token, me, cutoff, limit, concurrency) {
  console.error('[activity] Scanning chats/DMs...');

  // Fetch recent chats (ordered by last message)
  const chatsResult = await apiGetSafe(
    token,
    `${GRAPH_BASE}/me/chats?$top=50&$orderby=lastMessagePreview/createdDateTime desc&$expand=lastMessagePreview`
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
      const resp = await apiGetSafe(token, url);
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
  const subToken = await readSubstrateToken();
  if (!subToken) return { ok: false, results: [] };

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

  const result = await apiPostSafe(subToken, SUBSTRATE_SEARCH_URL, body);
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
async function tryGraphSearch(token, query, size) {
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

  const searchResult = await graphPostSafe(token, '/search/query', searchBody);
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
async function searchChannelFallback(token, query, since) {
  const maxTeams = parseInt(flags['max-teams'] || '10', 10);
  const concurrency = parseInt(flags['concurrency'] || '5', 10);
  const limit = topN || 25;
  const cutoff = since ? new Date(since).getTime() : 0;
  const queryLower = query.toLowerCase();
  const allTeams = await getTeams(token);
  const teamsToScan = allTeams.slice(0, maxTeams);

  console.error(`[search] Falling back to channel scan across ${teamsToScan.length} teams...`);

  // Fetch all channels in parallel
  const teamChannels = await pooled(concurrency, teamsToScan.map((team) => async () => {
    try {
      const channels = await getChannels(token, team.id);
      return { team, channels: channels.slice(0, 3) };
    } catch {
      return { team, channels: [] };
    }
  }));

  // Fetch messages for all channels in parallel
  const channelTasks = teamChannels.flatMap(({ team, channels }) =>
    channels.map((channel) => async () => {
      try {
        const messages = await graphGetAllPages(
          token,
          `/teams/${team.id}/channels/${channel.id}/messages`,
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
// Search subcommand  cascading: substrate ’ Graph ’ channel scan fallback
// ---------------------------------------------------------------------------

async function cmdSearch() {
  if (!positional[0]) die('Usage: teams search <query> [--since=7d]');
  const token = await readToken();
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
  const graph = await tryGraphSearch(token, query, size);
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
  const results = await searchChannelFallback(token, query, since);
  out(results);
}

// ---------------------------------------------------------------------------
// Unanswered subcommand
// ---------------------------------------------------------------------------

async function cmdUnanswered() {
  if (positional.length < 2) die('Usage: teams unanswered <team> <channel> [--since=48h]');
  const token = await readToken();
  const team = await resolveTeam(token, positional[0]);
  const channel = await resolveChannel(token, team.id, positional[1]);
  const since = sinceDate(sinceDuration, 48);

  const messages = await graphGetAllPages(
    token,
    `/teams/${team.id}/channels/${channel.id}/messages`,
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
  const token = await readToken();
  const since = sinceDate(sinceDuration, 24);
  const cutoff = new Date(since).getTime();
  const maxTeams = parseInt(flags['max-teams'] || '10', 10);
  const concurrency = parseInt(flags['concurrency'] || '5', 10);
  const allTeams = await getTeams(token);
  const teamsToScan = allTeams.slice(0, maxTeams);

  console.error(`[digest] Fetching channels for ${teamsToScan.length} of ${allTeams.length} teams in parallel...`);

  // Step 1: fetch all channels in parallel
  const teamChannels = await pooled(concurrency, teamsToScan.map((team) => async () => {
    try {
      const channels = await getChannels(token, team.id);
      return { team, channels };
    } catch {
      return { team, channels: [] };
    }
  }));

  // Step 2: fetch messages for all channels in parallel (1 page of 25 for speed)
  const channelTasks = teamChannels.flatMap(({ team, channels }) =>
    channels.map((channel) => async () => {
      try {
        const messages = await graphGetAllPages(
          token,
          `/teams/${team.id}/channels/${channel.id}/messages`,
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

function showHelp() {
  console.log(`teams  Microsoft Teams access via Graph API + Substrate Search

Usage: teams <command> [args] [--since=<duration>] [--top=<n>] [--max-teams=<n>]

Commands:
  auth                              Extract auth tokens from Teams browser session
  teams                             List joined teams
  channels <team>                   List channels in a team
  channels <team> --search=term     Filter channels by name
  channels --search=term            Search channels across all teams
  history <team> <channel>          Fetch recent messages (default: --since=24h)
  activity                          Messages mentioning/involving me (default: --since=24h)
  post <team> <channel> <message>   Post a message to a channel
  post ... --reply-to=<msg-id>      Reply in a thread
  thread <team> <channel> <msg-id>  Read replies to a message
  user <user-id-or-name>            Look up a user
  info <team> <channel>             Channel metadata
  search <query>                    Full-text search across Teams messages
  unanswered <team> <channel>       Messages with no replies (default: --since=48h)
  digest                            Activity summary across all teams (default: --since=24h, --max-teams=10)

Aliases: messages/msgs ’ history, mentions ’ activity

Duration format: <number><unit> where unit is m(inutes), h(ours), d(ays), w(eeks)
  Examples: 30m, 24h, 7d, 2w

--max-teams=N    Cap digest/activity/search scan to N teams (default: 10).
--concurrency=N  Parallel API requests for digest/activity/search (default: 5, max: 10).

Team and channel arguments accept display names (case-insensitive partial match) or IDs.

Search cascade: Substrate Search ’ Graph Search API ’ channel scan fallback.
Activity cascade: Substrate Search ’ Graph Search ’ channel scan + chat/DM scan.
Auth extracts both Graph and Substrate tokens from the Teams browser session.`);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

switch (subcommand) {
  case 'auth':
    await cmdAuth();
    break;
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
