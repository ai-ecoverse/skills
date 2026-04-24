// outlook.jsh — Microsoft Outlook CLI for SLICC agents
// Uses MSAL tokens from the Outlook browser tab's localStorage.
//
// Usage: outlook <command> [args] [--flags]
//
// Commands:
//   mail      List inbox messages
//   calendar  List calendar events
//   send      Send an email
//   monday    Aggregated inbox for monday dispatcher

const OWA_BASE = 'https://outlook.office.com/api/v2.0';
const TOKEN_PATH = '/shared/.outlook-token';
const OUTLOOK_DOMAIN = 'outlook.office.com';

// ─── Argument Parsing ────────────────────────────────────────────────────────

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
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  } else {
    positional.push(arg);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

function parseDuration(dur) {
  if (!dur) return null;
  const match = dur.match(/^(\d+)(h|d|w)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = { h: 3600000, d: 86400000, w: 604800000 };
  return ms[unit] * n;
}

function dateRange(dur, defaultDays) {
  const ms = dur ? parseDuration(dur) : defaultDays * 86400000;
  if (!ms) die(`Invalid duration: ${dur}. Use format like 24h, 7d, 2w`);
  const now = new Date();
  const start = new Date(now.getTime() - ms);
  return { start: start.toISOString(), end: now.toISOString() };
}

function futureRange(dur, defaultDays) {
  const ms = dur ? parseDuration(dur) : defaultDays * 86400000;
  if (!ms) die(`Invalid duration: ${dur}. Use format like 24h, 1d, 2w`);
  const now = new Date();
  const end = new Date(now.getTime() + ms);
  return { start: now.toISOString(), end: end.toISOString() };
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ─── Tab & Token Management ─────────────────────────────────────────────────

let _tabId = null;

async function findOutlookTab() {
  if (_tabId) return _tabId;
  const result = await exec('playwright-cli tab-list');
  if (result.exitCode !== 0) die('Failed to list browser tabs.');
  const lines = result.stdout.split('\n');
  for (const line of lines) {
    if (line.includes(OUTLOOK_DOMAIN)) {
      const m = line.match(/^\[([^\]]+)\]/);
      if (m) { _tabId = m[1]; return _tabId; }
    }
  }
  return null;
}

async function extractTokenFromBrowser() {
  const tabId = await findOutlookTab();
  if (!tabId) return null;

  // Extract the MSAL access token for outlook.office.com with the most scopes
  // (the one with mail.readwrite, calendars.readwrite, etc.)
  const extractScript = [
    '(function(){',
    'var best=null,bestScopes=0;',
    'var keys=Object.keys(localStorage);',
    'for(var i=0;i<keys.length;i++){',
    'var k=keys[i];',
    'if(k.indexOf("accesstoken")===-1)continue;',
    'if(k.indexOf("outlook.office.com")===-1&&k.indexOf("graph.microsoft.com")===-1)continue;',
    'try{var e=JSON.parse(localStorage.getItem(k));',
    'if(!e||!e.secret)continue;',
    'var scopes=(e.target||"").split(" ").length;',
    'var exp=parseInt(e.expiresOn||0);',
    'if(exp*1000<Date.now())continue;',  // skip expired
    'if(scopes>bestScopes){best=e;bestScopes=scopes;}}catch(x){}}',
    'if(best)return JSON.stringify({secret:best.secret,expiresOn:best.expiresOn,resource:best.target?best.target.split(" ")[0].split("/").slice(0,3).join("/"):"unknown"});',
    'return null})()',
  ].join('');

  const tmpFile = '/tmp/.outlook-token-extract-' + Date.now() + '.js';
  await fs.writeFile(tmpFile, extractScript);
  const evalResult = await exec(`playwright-cli eval-file ${tmpFile} --tab=${tabId}`);
  await fs.writeFile(tmpFile, '').catch(() => {}); // clean up

  if (evalResult.exitCode !== 0) return null;

  const raw = evalResult.stdout.trim();
  if (!raw || raw === 'null' || raw === 'undefined') return null;

  try {
    let parsed = raw;
    if (parsed.startsWith('"') && parsed.endsWith('"')) parsed = JSON.parse(parsed);
    const data = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
    if (data && data.secret) {
      // Save for future use
      await fs.writeFile(TOKEN_PATH, data.secret);
      return data.secret;
    }
  } catch { /* fall through */ }
  return null;
}

async function getToken() {
  // 1. Try extracting from browser
  const browserToken = await extractTokenFromBrowser();
  if (browserToken) return browserToken;

  // 2. Fallback to saved token file
  try {
    const saved = (await fs.readFile(TOKEN_PATH)).trim();
    if (saved) return saved;
  } catch { /* no file */ }

  die(
    'Could not extract Outlook token. Open Outlook at https://outlook.office.com in your browser and try again.'
  );
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function owaGet(token, path, params) {
  let url = path.startsWith('http') ? path : `${OWA_BASE}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    let msg;
    try { msg = JSON.parse(body).error?.message || body; } catch { msg = body; }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return res.json();
}

async function owaPost(token, path, body) {
  const url = path.startsWith('http') ? path : `${OWA_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg;
    try { msg = JSON.parse(text).error?.message || text; } catch { msg = text; }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  // 202 Accepted for sendMail (no body)
  if (res.status === 202 || res.headers.get('content-length') === '0') return {};
  return res.json();
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = {
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  gray:   s => `\x1b[90m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
};

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdMail() {
  const token = await getToken();
  const limit = parseInt(flags.limit || '20', 10);
  const unread = flags.unread === true || flags.unread === 'true';
  const search = flags.search || null;
  const date = flags.date || null;

  const params = {
    '$top': String(limit),
    '$orderby': 'ReceivedDateTime desc',
    '$select': 'Id,Subject,From,ReceivedDateTime,IsRead,BodyPreview,ToRecipients,Importance,HasAttachments,WebLink',
  };

  // Build filter conditions
  const filters = [];
  if (unread) filters.push('IsRead eq false');
  if (date) {
    const range = dateRange(date, 7);
    filters.push(`ReceivedDateTime ge ${range.start}`);
  }
  if (filters.length > 0) params['$filter'] = filters.join(' and ');

  let path = '/me/mailFolders/inbox/messages';
  if (search) {
    // Use /me/messages with $search for search across all folders
    path = '/me/messages';
    params['$search'] = `"${search}"`;
    delete params['$filter'];   // $search and $filter don't mix
    delete params['$orderby'];  // $search and $orderby don't mix
  }

  try {
    const data = await owaGet(token, path, params);
    const messages = data.value || [];

    if (flags.json === true || flags.json === 'true') {
      out(messages);
      return;
    }

    if (messages.length === 0) {
      console.log('No messages found.');
      return;
    }

    console.log(`${C.bold('Inbox')} — ${messages.length} message${messages.length !== 1 ? 's' : ''}\n`);

    for (const msg of messages) {
      const read = msg.IsRead ? C.gray('○') : C.green('●');
      const date = formatDate(msg.ReceivedDateTime);
      const from = msg.From?.EmailAddress?.Name || msg.From?.EmailAddress?.Address || 'unknown';
      const subj = trunc(msg.Subject || '(no subject)', 80);
      const imp = msg.Importance === 'High' ? C.red(' !') : '';
      const attach = msg.HasAttachments ? C.yellow(' 📎') : '';
      console.log(`  ${read} ${C.gray(date)} ${C.cyan(from)}`);
      console.log(`    ${subj}${imp}${attach}`);
      if (msg.BodyPreview) console.log(`    ${C.gray(trunc(msg.BodyPreview, 120))}`);
      console.log('');
    }
  } catch (e) {
    die(`outlook: mail failed: ${e.message}`);
  }
}

async function cmdCalendar() {
  const token = await getToken();
  const limit = parseInt(flags.limit || '20', 10);
  const date = flags.date || '2d';

  const range = futureRange(date, 2);

  const params = {
    '$top': String(limit),
    'startDateTime': range.start,
    'endDateTime': range.end,
    '$orderby': 'Start/DateTime asc',
    '$select': 'Id,Subject,Start,End,Organizer,IsAllDay,ResponseStatus,Location,BodyPreview,WebLink,IsCancelled,OnlineMeetingUrl,Attendees,Categories',
  };

  try {
    const data = await owaGet(token, '/me/calendarview', params);
    const events = data.value || [];

    if (flags.json === true || flags.json === 'true') {
      out(events);
      return;
    }

    if (events.length === 0) {
      console.log('No calendar events found.');
      return;
    }

    console.log(`${C.bold('Calendar')} — ${events.length} event${events.length !== 1 ? 's' : ''} in next ${date}\n`);

    for (const ev of events) {
      const cancelled = ev.IsCancelled ? C.red(' [CANCELLED]') : '';
      const allDay = ev.IsAllDay ? C.yellow(' [All day]') : '';
      const start = ev.Start?.DateTime ? formatDate(ev.Start.DateTime + 'Z') : '';
      const end = ev.End?.DateTime ? formatDate(ev.End.DateTime + 'Z') : '';
      const org = ev.Organizer?.EmailAddress?.Name || ev.Organizer?.EmailAddress?.Address || '';
      const loc = ev.Location?.DisplayName ? ` @ ${ev.Location.DisplayName}` : '';
      const response = ev.ResponseStatus?.Response || '';
      const responseTag = response === 'Accepted' ? C.green(' ✓') :
                          response === 'Declined' ? C.red(' ✗') :
                          response === 'TentativelyAccepted' ? C.yellow(' ?') :
                          response === 'NotResponded' ? C.yellow(' [needs response]') : '';

      console.log(`  ${C.cyan(trunc(ev.Subject || '(no title)', 70))}${cancelled}${allDay}${responseTag}`);
      console.log(`    ${C.gray(start)} → ${C.gray(end)}${loc}`);
      if (org) console.log(`    ${C.gray('Organizer:')} ${org}`);
      console.log('');
    }
  } catch (e) {
    die(`outlook: calendar failed: ${e.message}`);
  }
}

async function cmdSend() {
  const token = await getToken();
  const to = flags.to;
  const subject = flags.subject || flags.subj;
  const body = flags.body || positional[0];

  if (!to) die('outlook send: --to is required');
  if (!subject) die('outlook send: --subject is required');
  if (!body) die('outlook send: --body is required (flag or positional arg)');

  const recipients = to.split(',').map(email => ({
    EmailAddress: { Address: email.trim() }
  }));

  const payload = {
    Message: {
      Subject: subject,
      Body: { ContentType: 'Text', Content: body },
      ToRecipients: recipients,
    },
    SaveToSentItems: true,
  };

  try {
    await owaPost(token, '/me/sendMail', payload);
    console.log(C.green('✓') + ` Email sent to ${to}`);
  } catch (e) {
    die(`outlook: send failed: ${e.message}`);
  }
}

async function cmdMonday() {
  const token = await getToken();
  const limit = parseInt(flags.limit || '50', 10);
  const date = flags.date || '7d';
  const depth = parseInt(flags.depth || '5', 10);

  const items = [];

  // 1. Unread inbox messages
  try {
    const mailParams = {
      '$top': String(Math.min(limit, 50)),
      '$orderby': 'ReceivedDateTime desc',
      '$filter': 'IsRead eq false',
      '$select': 'Id,Subject,From,ReceivedDateTime,IsRead,BodyPreview,ToRecipients,Importance,WebLink',
    };
    const mailData = await owaGet(token, '/me/mailFolders/inbox/messages', mailParams);
    for (const msg of (mailData.value || [])) {
      items.push({
        source: 'outlook',
        type: 'email',
        id: `outlook-mail-${msg.Id}`,
        title: msg.Subject || '(no subject)',
        body: trunc(msg.BodyPreview || '', 300),
        url: msg.WebLink || `https://outlook.office.com/mail/id/${encodeURIComponent(msg.Id)}`,
        from: msg.From?.EmailAddress?.Address || '',
        date: msg.ReceivedDateTime || '',
        importance: msg.Importance || 'Normal',
        repo: null,
        number: null,
      });
    }
  } catch (e) {
    console.error(`[outlook monday] WARNING: failed to fetch unread mail: ${e.message}`);
  }

  // 2. Calendar events for today + tomorrow (2 days ahead)
  try {
    const now = new Date();
    const start = now.toISOString();
    const end = new Date(now.getTime() + 2 * 86400000).toISOString();

    const calParams = {
      '$top': String(Math.min(limit, 30)),
      'startDateTime': start,
      'endDateTime': end,
      '$orderby': 'Start/DateTime asc',
      '$select': 'Id,Subject,Start,End,Organizer,IsAllDay,ResponseStatus,Location,BodyPreview,WebLink,IsCancelled,OnlineMeetingUrl',
    };
    const calData = await owaGet(token, '/me/calendarview', calParams);
    for (const ev of (calData.value || [])) {
      if (ev.IsCancelled) continue;

      const response = ev.ResponseStatus?.Response || '';
      const type = response === 'NotResponded' ? 'meeting' : 'calendar';

      items.push({
        source: 'outlook',
        type,
        id: `outlook-cal-${ev.Id}`,
        title: ev.Subject || '(no title)',
        body: trunc(ev.BodyPreview || '', 300),
        url: ev.WebLink || `https://outlook.office.com/calendar/item/${encodeURIComponent(ev.Id)}`,
        from: ev.Organizer?.EmailAddress?.Address || '',
        date: ev.Start?.DateTime ? ev.Start.DateTime + 'Z' : '',
        location: ev.Location?.DisplayName || null,
        response: response || null,
        repo: null,
        number: null,
      });
    }
  } catch (e) {
    console.error(`[outlook monday] WARNING: failed to fetch calendar: ${e.message}`);
  }

  console.log(JSON.stringify(items, null, 2));
}

async function cmdView() {
  const token = await getToken();
  const id = positional[0];
  if (!id) die('outlook view: provide a message ID');

  try {
    const msg = await owaGet(token, `/me/messages/${encodeURIComponent(id)}`, {
      '$select': 'Id,Subject,From,ToRecipients,CcRecipients,ReceivedDateTime,Body,Importance,HasAttachments,WebLink',
    });

    console.log(C.bold(msg.Subject || '(no subject)'));
    console.log(`${C.gray('From:')} ${msg.From?.EmailAddress?.Name || ''} <${msg.From?.EmailAddress?.Address || ''}>`);
    const to = (msg.ToRecipients || []).map(r => r.EmailAddress?.Address).join(', ');
    if (to) console.log(`${C.gray('To:')} ${to}`);
    const cc = (msg.CcRecipients || []).map(r => r.EmailAddress?.Address).join(', ');
    if (cc) console.log(`${C.gray('Cc:')} ${cc}`);
    console.log(`${C.gray('Date:')} ${formatDate(msg.ReceivedDateTime)}`);
    if (msg.Importance && msg.Importance !== 'Normal') console.log(`${C.gray('Importance:')} ${msg.Importance}`);
    console.log(`${C.gray('Link:')} ${msg.WebLink || ''}`);
    console.log('');

    // Strip HTML tags for plain-text display
    const bodyContent = msg.Body?.Content || '';
    const plainBody = bodyContent
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    console.log(trunc(plainBody, 2000));
  } catch (e) {
    die(`outlook: view failed: ${e.message}`);
  }
}

function showHelp() {
  console.log(`outlook — Microsoft Outlook CLI for SLICC

Usage: outlook <command> [options]

Commands:
  mail       List inbox messages
  calendar   List calendar events
  send       Send an email
  view       View a single message
  monday     Aggregated inbox items for monday dispatcher

Mail options:
  --limit N          Number of messages (default: 20)
  --date PERIOD      Filter by age (e.g. 1d, 7d, 2w)
  --unread           Show only unread messages
  --search QUERY     Search across all folders
  --json             Output raw JSON

Calendar options:
  --limit N          Number of events (default: 20)
  --date PERIOD      How far ahead to look (default: 2d)
  --json             Output raw JSON

Send options:
  --to EMAIL         Recipient(s), comma-separated
  --subject TEXT     Email subject
  --body TEXT        Email body

View:
  outlook view <message-id>

Monday options:
  --limit N          Max items per source (default: 50)
  --date PERIOD      Date range (default: 7d)
  --depth N          Detail depth (default: 5)

Authentication:
  Token is extracted automatically from the Outlook browser tab
  (MSAL localStorage). Falls back to /workspace/.outlook-token.
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  switch (subcommand) {
    case 'mail':
    case 'inbox':
      await cmdMail();
      break;
    case 'calendar':
    case 'cal':
      await cmdCalendar();
      break;
    case 'send':
      await cmdSend();
      break;
    case 'view':
      await cmdView();
      break;
    case 'monday':
      await cmdMonday();
      break;
    case 'help':
    case '--help':
    case '-h':
    case '':
      showHelp();
      break;
    default:
      console.error(`Unknown command: ${subcommand}`);
      showHelp();
      process.exit(1);
  }
} catch (e) {
  console.error(`outlook: ${e.message}`);
  process.exit(1);
}
