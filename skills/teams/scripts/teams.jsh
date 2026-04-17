// teams.jsh — Microsoft Teams channel scanner via Graph API
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
const TEAMS_CACHE_PATH = '/workspace/.teams-cache.json';

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
    die('401 Unauthorized — token expired. Run `teams auth` to refresh.');
  }
  if (resp.status === 403) {
    die(
      '403 Forbidden — insufficient permissions. The token may lack required Graph API scopes. See reference.md.'
    );
  }
  if (resp.status === 429) {
    if (retries > 0) {
      const retryAfter = Math.min(parseInt(resp.headers.get('Retry-After') || '5', 10), 30);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return graphGet(token, path, params, retries - 1);
    }
    die('429 Too Many Requests — rate limited. Wait a moment and retry.');
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
    die('401 Unauthorized — token expired. Run `teams auth` to refresh.');
  }
  if (!resp.ok) {
    const text = await resp.text();
    die(`Graph API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// Non-fatal POST — returns {ok, status, data} instead of calling die().
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
// Teams/channel resolution (name → ID)
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
// Auth subcommand — extract MSAL token from Teams browser tab
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
  const extractScript = [
    '(function(){',
    // Primary: localStorage (Teams v2)
    'var best=null,bestExp=0;',
    'var lkeys=Object.keys(localStorage);',
    'for(var i=0;i<lkeys.length;i++){',
    'var k=lkeys[i];',
    'if(k.indexOf("accesstoken")===-1||k.indexOf("graph.microsoft.com")===-1)continue;',
    'try{var e=JSON.parse(localStorage.getItem(k));',
    'var exp=parseInt(e.expiresOn||e.expires_on||0);',
    'if(e&&e.secret&&exp>bestExp){best=e;bestExp=exp;}}catch(x){}}',
    'if(best)return JSON.stringify({token:best.secret,expiresOn:best.expiresOn||best.expires_on});',
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

  // Verify token by fetching user profile
  const me = await graphGet(tokenData.token, '/me');
  out({
    status: 'authenticated',
    user: me.displayName,
    email: me.mail || me.userPrincipalName,
    id: me.id,
    expiresOn: tokenData.expiresOn || 'unknown',
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
    true  // use beta endpoint — v1.0 requires ChannelMessage.Read.All which the delegated token lacks
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
  const since = sinceDate(sinceDuration, 168); // default 7 days

  // Use the Search API (beta) to find messages mentioning the current user
  const me = await graphGet(token, '/me');
  const displayName = me.displayName;

  const searchBody = {
    requests: [
      {
        entityTypes: ['chatMessage'],
        query: { queryString: displayName },
        from: 0,
        size: topN || 25,
      },
    ],
  };

  const searchResult = await graphPostSafe(token, '/search/query', searchBody);

  if (!searchResult.ok) {
    console.error(
      `Search API returned ${searchResult.status} (delegated tokens often lack chatMessage search scope). Falling back to channel scan...`
    );
    await cmdActivityFallback(token, me, since);
    return;
  }

  const hits = searchResult.data?.value?.[0]?.hitsContainers?.[0]?.hits || [];
  const mentions = hits
    .map((hit) => {
      const resource = hit.resource || {};
      return {
        summary: hit.summary || '',
        from: resource.from?.emailAddress?.name || 'unknown',
        date: resource.createdDateTime || resource.lastModifiedDateTime || '',
        body: resource.body?.content ? stripHtml(resource.body.content).slice(0, 500) : hit.summary || '',
        channelName: resource.channelIdentity?.channelId || '',
        teamName: resource.channelIdentity?.teamId || '',
        webUrl: resource.webUrl || '',
      };
    })
    .filter((m) => {
      if (!sinceDuration && !m.date) return true;
      if (!m.date) return true;
      return new Date(m.date).getTime() >= new Date(since).getTime();
    });

  out(mentions);
}

async function cmdActivityFallback(token, me, since) {
  const maxTeams = parseInt(flags['max-teams'] || '5', 10);
  const limit = topN || 25;
  const teams = await getTeams(token);
  const mentions = [];
  const cutoff = new Date(since).getTime();

  console.error(`[activity] Scanning up to ${maxTeams} teams (use --max-teams=N to adjust)...`);

  for (const team of teams.slice(0, maxTeams)) {
    console.error(`[activity] ${team.displayName}...`);
    const channels = await getChannels(token, team.id);
    for (const channel of channels.slice(0, 3)) {
      try {
        const messages = await graphGetAllPages(
          token,
          `/teams/${team.id}/channels/${channel.id}/messages`,
          { $top: '50' },
          2,
          true  // use beta endpoint
        );
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
            });
          }
        }
      } catch {
        // Skip channels we can't read
      }
      if (mentions.length >= limit) break;
    }
    if (mentions.length >= limit) break;
  }

  if (teams.length > maxTeams) {
    console.error(
      `[activity] Scanned ${maxTeams} of ${teams.length} teams. Use --max-teams=N to scan more.`
    );
  }

  out(mentions);
}

// ---------------------------------------------------------------------------
// Search subcommand
// ---------------------------------------------------------------------------

async function cmdSearch() {
  if (!positional[0]) die('Usage: teams search <query> [--since=7d]');
  const token = await readToken();
  const query = positional.join(' ');

  const searchBody = {
    requests: [
      {
        entityTypes: ['chatMessage'],
        query: { queryString: query },
        from: 0,
        size: topN || 25,
      },
    ],
  };

  const result = await graphPost(token, '/search/query', searchBody);
  const hits = result.value?.[0]?.hitsContainers?.[0]?.hits || [];

  const since = sinceDuration ? sinceDate(sinceDuration, 168) : null;

  const results = hits
    .map((hit) => {
      const resource = hit.resource || {};
      return {
        summary: hit.summary || '',
        from: resource.from?.emailAddress?.name || 'unknown',
        date: resource.createdDateTime || resource.lastModifiedDateTime || '',
        body: resource.body?.content ? stripHtml(resource.body.content).slice(0, 500) : hit.summary || '',
        webUrl: resource.webUrl || '',
      };
    })
    .filter((m) => {
      if (!since || !m.date) return true;
      return new Date(m.date).getTime() >= new Date(since).getTime();
    });

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
  const maxTeams = parseInt(flags['max-teams'] || '20', 10);
  const allTeams = await getTeams(token);
  const teamsToScan = allTeams.slice(0, maxTeams);
  const digest = [];

  console.error(`[digest] Scanning ${teamsToScan.length} of ${allTeams.length} teams (use --max-teams=N to adjust)...`);

  for (const team of teamsToScan) {
    console.error(`[digest] ${team.displayName}...`);
    let channels;
    try {
      channels = await getChannels(token, team.id);
    } catch {
      continue;
    }

    for (const channel of channels) {
      try {
        const messages = await graphGetAllPages(
          token,
          `/teams/${team.id}/channels/${channel.id}/messages`,
          { $top: '50' },
          2,
          true  // use beta endpoint
        );

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
      } catch {
        // Skip channels we can't access
      }
    }
  }

  // Sort by message count descending
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
  console.log(`teams — Microsoft Teams channel access via Graph API

Usage: teams <command> [args] [--since=<duration>] [--top=<n>] [--max-teams=<n>]

Commands:
  auth                              Extract auth token from Teams browser session
  teams                             List joined teams
  channels <team>                   List channels in a team
  channels <team> --search=term     Filter channels by name
  channels --search=term            Search channels across all teams
  history <team> <channel>          Fetch recent messages (default: --since=24h)
  activity                          Messages mentioning/involving me (default: --since=7d)
  post <team> <channel> <message>   Post a message to a channel
  post ... --reply-to=<msg-id>      Reply in a thread
  thread <team> <channel> <msg-id>  Read replies to a message
  user <user-id-or-name>            Look up a user
  info <team> <channel>             Channel metadata
  search <query>                    Full-text search across Teams messages
  unanswered <team> <channel>       Messages with no replies (default: --since=48h)
  digest                            Activity summary across all teams (default: --since=24h, --max-teams=20)

Aliases: messages/msgs → history, mentions → activity

Duration format: <number><unit> where unit is m(inutes), h(ours), d(ays), w(eeks)
  Examples: 30m, 24h, 7d, 2w

--max-teams=N  Limit digest/activity fallback to N teams (default: digest=20, activity=5).
               Use a smaller value (e.g. --max-teams=5) in large tenants to stay within the
               30s runner timeout.

Team and channel arguments accept display names (case-insensitive partial match) or IDs.`);
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
