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
const TAB_MATCH = /outlook\.(cloud\.microsoft|office\.com|live\.com)/;

// ─── Argument Parsing ────────────────────────────────────────────────────────

const { positional, flags, subcommand } = process.argv.parseFlags();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dateRange(dur, defaultDays) {
  const spec = dur || `${defaultDays}d`;
  const ms = time.parseDuration(spec);
  if (!ms) cli.die(`Invalid duration: ${dur}. Use format like 24h, 7d, 2w`, { prefix: 'outlook' });
  const now = new Date();
  return { start: new Date(now.getTime() - ms).toISOString(), end: now.toISOString() };
}

function futureRange(dur, defaultDays) {
  const spec = dur || `${defaultDays}d`;
  const ms = time.parseDuration(spec);
  if (!ms) cli.die(`Invalid duration: ${dur}. Use format like 24h, 1d, 2w`, { prefix: 'outlook' });
  const now = new Date();
  return { start: now.toISOString(), end: new Date(now.getTime() + ms).toISOString() };
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ─── Tab & Token Management ─────────────────────────────────────────────────

async function findOutlookTab() {
  return browser.findTab({ urlMatch: TAB_MATCH });
}

async function extractTokenFromBrowser() {
  const tab = await findOutlookTab();
  if (!tab) return null;

  // Strategy 1: Try MSAL v2 localStorage format (secret field in clear text)
  const legacy = await browser.eval(tab, () => {
    var best = null, bestScopes = 0;
    var keys = Object.keys(localStorage);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('accesstoken') === -1) continue;
      if (k.indexOf('outlook.office.com') === -1 && k.indexOf('graph.microsoft.com') === -1) continue;
      try {
        var e = JSON.parse(localStorage.getItem(k));
        if (!e || !e.secret) continue;
        var scopes = (e.target || '').split(' ').length;
        var exp = parseInt(e.expiresOn || 0);
        if (exp * 1000 < Date.now()) continue;
        if (scopes > bestScopes) { best = e; bestScopes = scopes; }
      } catch (x) {}
    }
    return best ? best.secret : null;
  });

  if (legacy) {
    await fs.writeFile(TOKEN_PATH, legacy);
    return legacy;
  }

  // Strategy 2: MSAL v3 encrypts tokens in localStorage. Intercept a live
  // Authorization header from the app's own fetch calls by monkey-patching
  // fetch, then triggering activity to force a token-bearing request.
  // Navigate to ensure the app makes fresh authenticated requests.
  await exec(`playwright-cli navigate "https://outlook.cloud.microsoft/calendar" --tab=${tab.targetId}`);
  await new Promise(r => setTimeout(r, 3000));

  const token = await browser.evalAsync(tab, async () => {
    window.__sliccTBA = {};
    var of = window.fetch;
    window.fetch = function () {
      var a = arguments;
      var o = a[1] || {};
      var h = o.headers || {};
      var au = '';
      if (h instanceof Headers) au = h.get('Authorization') || '';
      else if (typeof h === 'object') au = h.Authorization || h.authorization || '';
      if (au.startsWith('Bearer ')) {
        var tk = au.substring(7);
        try { var p = tk.split('.'); var pl = JSON.parse(atob(p[1])); window.__sliccTBA[pl.aud] = tk; } catch (e) {}
      }
      return of.apply(this, a);
    };
    window.dispatchEvent(new Event('focus'));
    for (var i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      var t = window.__sliccTBA['https://outlook.office.com'];
      if (t) return t;
    }
    var ks = Object.keys(window.__sliccTBA);
    return ks.length ? window.__sliccTBA[ks[0]] : null;
  });

  if (token && token.startsWith('eyJ')) {
    await fs.writeFile(TOKEN_PATH, token);
    return token;
  }

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

  cli.die(
    'Could not extract Outlook token. Open Outlook at https://outlook.cloud.microsoft (or https://outlook.office.com) in your browser and try again.',
    { prefix: 'outlook' }
  );
}

// ─── API Client ──────────────────────────────────────────────────────────────

const owa = http.client({
  baseUrl: OWA_BASE,
  token: () => getToken(),
  headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
  retry: { on: [429, 503], maxAttempts: 3 },
});

// Legacy wrappers for code that still passes token explicitly
async function owaGet(token, path, params) {
  return owa.get(path, { params });
}

async function owaPost(token, path, body) {
  return owa.post(path, { body });
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

// Colors: use the `c` global (c.green, c.red, c.yellow, c.gray, c.bold, c.cyan)
const C = c; // alias for minimal diff in command functions

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
      cli.out(messages);
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
      const subj = fmt.trunc(msg.Subject || '(no subject)', 80);
      const imp = msg.Importance === 'High' ? C.red(' !') : '';
      const attach = msg.HasAttachments ? C.yellow(' 📎') : '';
      console.log(`  ${read} ${C.gray(date)} ${C.cyan(from)}`);
      console.log(`    ${subj}${imp}${attach}`);
      if (msg.BodyPreview) console.log(`    ${C.gray(fmt.trunc(msg.BodyPreview, 120))}`);
      console.log('');
    }
  } catch (e) {
    cli.die(`mail failed: ${e.message}`, { prefix: 'outlook' });
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
      cli.out(events);
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

      console.log(`  ${C.cyan(fmt.trunc(ev.Subject || '(no title)', 70))}${cancelled}${allDay}${responseTag}`);
      console.log(`    ${C.gray(start)} → ${C.gray(end)}${loc}`);
      if (org) console.log(`    ${C.gray('Organizer:')} ${org}`);
      console.log('');
    }
  } catch (e) {
    cli.die(`calendar failed: ${e.message}`, { prefix: 'outlook' });
  }
}

async function cmdSend() {
  const token = await getToken();
  const to = flags.to;
  const subject = flags.subject || flags.subj;
  const body = flags.body || positional[0];

  if (!to) cli.die('--to is required', { prefix: 'outlook send' });
  if (!subject) cli.die('--subject is required', { prefix: 'outlook send' });
  if (!body) cli.die('--body is required (flag or positional arg)', { prefix: 'outlook send' });

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
    cli.die(`send failed: ${e.message}`, { prefix: 'outlook' });
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
        body: fmt.trunc(msg.BodyPreview || '', 300),
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
        body: fmt.trunc(ev.BodyPreview || '', 300),
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
  if (!id) cli.die('provide a message ID', { prefix: 'outlook view' });

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
    console.log(fmt.trunc(plainBody, 2000));
  } catch (e) {
    cli.die(`view failed: ${e.message}`, { prefix: 'outlook' });
  }
}

// ─── Calendar Response Commands ──────────────────────────────────────────────

const RESPOND_LABELS = {
  accept: { progressive: 'Accepting', past: 'Accepted' },
  decline: { progressive: 'Declining', past: 'Declined' },
  tentativelyAccept: { progressive: 'Tentatively accepting', past: 'Tentative' },
};

async function cmdRespond(action) {
  const token = await getToken();
  const comment = flags.comment || flags.message || '';
  const silent = flags.silent === true || flags.silent === 'true';
  const labels = RESPOND_LABELS[action];

  // Collect event IDs: positional args or --all pending events
  let eventIds = [...positional];
  const subjectsById = new Map();

  if (eventIds.length === 0 && flags.all) {
    // Respond to all pending events in the calendar window, paging through results
    const date = flags.date || '2d';
    const range = futureRange(date, 2);
    let page = await owaGet(token, '/me/calendarview', {
      '$top': '50',
      'startDateTime': range.start,
      'endDateTime': range.end,
      '$select': 'Id,Subject,ResponseStatus',
    });
    const pending = [];
    while (true) {
      for (const ev of page.value || []) {
        if (ev.ResponseStatus?.Response === 'NotResponded') {
          pending.push(ev);
        }
      }
      const next = page['@odata.nextLink'];
      if (!next) break;
      page = await owaGet(token, next);
    }
    if (pending.length === 0) {
      console.log('No pending events to respond to.');
      return;
    }
    for (const ev of pending) {
      eventIds.push(ev.Id);
      if (ev.Subject) subjectsById.set(ev.Id, ev.Subject);
    }
    console.log(`${C.bold(labels.progressive)} ${pending.length} pending event(s)...\n`);
  }

  if (eventIds.length === 0) {
    cli.die('provide one or more event IDs, or use --all', { prefix: `outlook ${action}` });
  }

  const body = { SendResponse: !silent };
  if (comment) body.Comment = comment;

  let success = 0;
  let failed = 0;

  for (const id of eventIds) {
    try {
      await owaPost(token, `/me/events/${encodeURIComponent(id)}/${action}`, body);
      success++;
      // Use the subject from the initial fetch when available; fall back to a lookup otherwise
      let subject = subjectsById.get(id);
      if (!subject) {
        try {
          const ev = await owaGet(token, `/me/events/${encodeURIComponent(id)}`, { '$select': 'Subject' });
          subject = ev.Subject;
        } catch { /* ignore */ }
      }
      const display = subject || `${id.slice(0, 20)}...`;
      console.log(`  ${C.green('✓')} ${labels.past}: ${display}`);
    } catch (e) {
      failed++;
      const msg = e.message || '';
      if (msg.includes('organizer') || msg.includes('response')) {
        console.log(`  ${C.yellow('⚠')} Skipped (no response allowed): ${id.slice(0, 20)}...`);
      } else {
        console.log(`  ${C.red('✗')} Failed: ${msg}`);
      }
    }
  }

  console.log(`\n${success} responded, ${failed} failed/skipped.`);
}

const HELP_TEXT = `outlook — Microsoft Outlook CLI for SLICC

Usage: outlook <command> [options]

Commands:
  mail       List inbox messages
  calendar   List calendar events
  accept     Accept calendar event(s)
  decline    Decline calendar event(s)
  tentative  Tentatively accept calendar event(s)
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

Respond options (accept/decline/tentative):
  outlook accept <event-id> [<event-id>...]
  outlook decline <event-id> --comment "Can't make it"
  outlook accept --all              Accept all pending events
  outlook decline --all --date 7d   Decline all pending in next week
  --comment TEXT    Optional message to organizer
  --silent          Don't send response to organizer
  --all             Act on all NotResponded events in date range
  --date PERIOD     With --all, calendar window to scan (default: 2d)

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
  (MSAL v2/v3). Falls back to /shared/.outlook-token.
`;

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
    case 'accept':
      await cmdRespond('accept');
      break;
    case 'decline':
      await cmdRespond('decline');
      break;
    case 'tentative':
    case 'maybe':
      await cmdRespond('tentativelyAccept');
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
      cli.help(HELP_TEXT);
      break;
    default:
      if (flags.help || flags.h || !subcommand) {
        cli.help(HELP_TEXT);
      } else {
        cli.die(`Unknown command: ${subcommand}`, { prefix: 'outlook' });
      }
  }
} catch (e) {
  cli.die(e.message, { prefix: 'outlook' });
}
