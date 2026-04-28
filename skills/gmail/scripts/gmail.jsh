// gmail.jsh — Gmail CLI for SLICC agents
// Uses GWS_* env vars (OAuth client credentials + refresh token) to obtain
// access tokens via the Google OAuth2 token endpoint. No browser needed.
//
// Usage: gmail <command> [args] [--flags]
//
// Commands:
//   mail      List inbox messages
//   view      View a single message (full body)
//   send      Send an email
//   reply     Reply to a message
//   monday    Aggregated inbox for monday dispatcher

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_WEB = 'https://mail.google.com/mail/u/0/#inbox';

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
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function trunc(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * Parse a duration string like 1d, 7d, 2w, 1m into a Gmail after: date.
 * Returns YYYY/MM/DD for use in Gmail search queries.
 */
function durationToDate(dur) {
  if (!dur) return null;
  const match = dur.match(/^(\d+)(h|d|w|m)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
  const cutoff = new Date(Date.now() - ms[unit] * n);
  const yyyy = cutoff.getFullYear();
  const mm = String(cutoff.getMonth() + 1).padStart(2, '0');
  const dd = String(cutoff.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
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

// ─── Auth ────────────────────────────────────────────────────────────────────

let _accessToken = null;

async function getAccessToken() {
  if (_accessToken) return _accessToken;

  const clientId = process.env.GWS_CLIENT_ID;
  const clientSecret = process.env.GWS_CLIENT_SECRET;
  const refreshToken = process.env.GWS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    die('gmail: missing GWS_CLIENT_ID, GWS_CLIENT_SECRET, or GWS_REFRESH_TOKEN env vars.');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const data = await res.json();
  if (!data.access_token) {
    die(`gmail: token refresh failed: ${JSON.stringify(data)}`);
  }

  _accessToken = data.access_token;
  return _accessToken;
}

// ─── API Client ──────────────────────────────────────────────────────────────

async function gmailGet(path, params) {
  const token = await getAccessToken();
  let url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
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

async function gmailPost(path, body) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${GMAIL_BASE}${path}`;
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
  return res.json();
}

// ─── MIME Helpers ─────────────────────────────────────────────────────────────

/**
 * Decode Gmail's base64url-encoded body data to a UTF-8 string.
 */
function decodeBase64Url(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Encode a string to base64url (for sending messages via Gmail API).
 */
function encodeBase64Url(str) {
  const encoded = btoa(unescape(encodeURIComponent(str)));
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Extract the value of a header by name from a Gmail message payload.
 */
function getHeader(payload, name) {
  if (!payload || !payload.headers) return '';
  const h = payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * Recursively extract body text from a Gmail message payload.
 * Prefers text/plain, falls back to text/html (stripped of tags).
 */
function extractBody(payload) {
  if (!payload) return '';

  // Simple body (no parts)
  if (payload.body && payload.body.data) {
    if (payload.mimeType === 'text/html') {
      return stripHtml(decodeBase64Url(payload.body.data));
    }
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — recurse through parts
  if (payload.parts && payload.parts.length > 0) {
    // First pass: text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    // Second pass: text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return stripHtml(decodeBase64Url(part.body.data));
      }
    }
    // Third pass: recurse into nested multipart
    for (const part of payload.parts) {
      if (part.mimeType && part.mimeType.startsWith('multipart/')) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return '';
}

/**
 * Strip HTML tags and decode common entities for plain-text display.
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse email from "Name <email@example.com>" format.
 */
function parseEmail(str) {
  if (!str) return '';
  const m = str.match(/<([^>]+)>/);
  return m ? m[1] : str.trim();
}

/**
 * Parse display name from email header string.
 */
function parseDisplayName(str) {
  if (!str) return '';
  const m = str.match(/^"?([^"<]+)"?\s*</);
  return m ? m[1].trim() : str.replace(/<[^>]+>/, '').trim() || parseEmail(str);
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdMail() {
  const limit = parseInt(flags.limit || '20', 10);
  const unread = flags.unread === true || flags.unread === 'true';
  const search = flags.search || null;
  const date = flags.date || null;

  // Build Gmail search query
  const queryParts = [];
  queryParts.push('in:inbox');
  if (unread) queryParts.push('is:unread');
  if (date) {
    const afterDate = durationToDate(date);
    if (afterDate) queryParts.push(`after:${afterDate}`);
  }
  if (search) queryParts.push(search);

  const q = queryParts.join(' ');

  try {
    // Step 1: List message IDs
    const listData = await gmailGet('/messages', {
      maxResults: String(limit),
      q: q,
    });

    const messageStubs = listData.messages || [];
    if (messageStubs.length === 0) {
      if (flags.json === true || flags.json === 'true') {
        out([]);
      } else {
        process.stdout.write('No messages found.\n');
      }
      return;
    }

    // Step 2: Fetch each message with metadata
    const messages = await Promise.all(
      messageStubs.map(stub =>
        gmailGet(`/messages/${stub.id}`, { format: 'metadata', metadataHeaders: 'From,Subject,Date' })
      )
    );

    if (flags.json === true || flags.json === 'true') {
      out(messages);
      return;
    }

    process.stdout.write(`${C.bold('Inbox')} — ${messages.length} message${messages.length !== 1 ? 's' : ''}\n\n`);

    for (const msg of messages) {
      const isUnread = (msg.labelIds || []).includes('UNREAD');
      const dot = isUnread ? C.green('●') : C.gray('○');
      const from = parseDisplayName(getHeader(msg.payload, 'From'));
      const subject = trunc(getHeader(msg.payload, 'Subject') || '(no subject)', 80);
      const dateStr = formatDate(getHeader(msg.payload, 'Date'));
      const snippet = trunc(msg.snippet || '', 120);

      process.stdout.write(`  ${dot} ${C.gray(dateStr)} ${C.cyan(from)}\n`);
      process.stdout.write(`    ${subject}\n`);
      if (snippet) process.stdout.write(`    ${C.gray(snippet)}\n`);
      process.stdout.write(`    ${C.gray('ID: ' + msg.id)}\n\n`);
    }
  } catch (e) {
    die(`gmail: mail failed: ${e.message}`);
  }
}

async function cmdView() {
  const id = positional[0];
  if (!id) die('gmail view: provide a message ID');

  try {
    const msg = await gmailGet(`/messages/${id}`, { format: 'full' });

    const subject = getHeader(msg.payload, 'Subject') || '(no subject)';
    const from = getHeader(msg.payload, 'From');
    const to = getHeader(msg.payload, 'To');
    const cc = getHeader(msg.payload, 'Cc');
    const date = getHeader(msg.payload, 'Date');
    const labels = (msg.labelIds || []).join(', ');

    process.stdout.write(`${C.bold(subject)}\n`);
    process.stdout.write(`${C.gray('From:')} ${from}\n`);
    if (to) process.stdout.write(`${C.gray('To:')} ${to}\n`);
    if (cc) process.stdout.write(`${C.gray('Cc:')} ${cc}\n`);
    process.stdout.write(`${C.gray('Date:')} ${date}\n`);
    process.stdout.write(`${C.gray('Labels:')} ${labels}\n`);
    process.stdout.write(`${C.gray('Link:')} ${GMAIL_WEB}/${id}\n`);
    process.stdout.write('\n');

    const body = extractBody(msg.payload);
    process.stdout.write(body ? trunc(body, 5000) + '\n' : C.gray('(empty body)') + '\n');
  } catch (e) {
    die(`gmail: view failed: ${e.message}`);
  }
}

async function cmdSend() {
  const to = flags.to;
  const subject = flags.subject;
  const body = flags.body;
  const isHtml = flags.html === true || flags.html === 'true';
  const cc = flags.cc || null;
  const bcc = flags.bcc || null;

  if (!to) die('gmail send: --to is required');
  if (!subject) die('gmail send: --subject is required');
  if (!body) die('gmail send: --body is required');

  // Build RFC 5322 message
  const lines = [];
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  if (isHtml) {
    lines.push('Content-Type: text/html; charset=UTF-8');
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8');
  }
  lines.push('MIME-Version: 1.0');
  lines.push('');
  lines.push(body);

  const raw = encodeBase64Url(lines.join('\r\n'));

  try {
    const result = await gmailPost('/messages/send', { raw });
    process.stdout.write(`${C.green('✓')} Email sent to ${to} (ID: ${result.id})\n`);
  } catch (e) {
    die(`gmail: send failed: ${e.message}`);
  }
}

async function cmdReply() {
  const id = flags.id || positional[0];
  const body = flags.body;
  const isHtml = flags.html === true || flags.html === 'true';

  if (!id) die('gmail reply: --id MESSAGE_ID is required');
  if (!body) die('gmail reply: --body is required');

  try {
    // Fetch original message headers
    const orig = await gmailGet(`/messages/${id}`, {
      format: 'metadata',
      metadataHeaders: 'From,To,Subject,Message-Id,References,In-Reply-To',
    });

    const origFrom = getHeader(orig.payload, 'From');
    const origSubject = getHeader(orig.payload, 'Subject') || '';
    const origMessageId = getHeader(orig.payload, 'Message-Id');
    const origReferences = getHeader(orig.payload, 'References');
    const threadId = orig.threadId;

    // Reply goes to the original sender
    const replyTo = parseEmail(origFrom);
    const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

    // Build References header (original refs + original message-id)
    const refs = origReferences
      ? `${origReferences} ${origMessageId}`
      : origMessageId;

    // Build RFC 5322 message
    const lines = [];
    lines.push(`To: ${replyTo}`);
    lines.push(`Subject: ${subject}`);
    if (origMessageId) lines.push(`In-Reply-To: ${origMessageId}`);
    if (refs) lines.push(`References: ${refs}`);
    if (isHtml) {
      lines.push('Content-Type: text/html; charset=UTF-8');
    } else {
      lines.push('Content-Type: text/plain; charset=UTF-8');
    }
    lines.push('MIME-Version: 1.0');
    lines.push('');
    lines.push(body);

    const raw = encodeBase64Url(lines.join('\r\n'));

    const result = await gmailPost('/messages/send', { raw, threadId });
    process.stdout.write(`${C.green('✓')} Reply sent to ${replyTo} (ID: ${result.id}, thread: ${threadId})\n`);
  } catch (e) {
    die(`gmail: reply failed: ${e.message}`);
  }
}

async function cmdMonday() {
  const limit = parseInt(flags.limit || '20', 10);
  const date = flags.date || '1d';
  const depth = parseInt(flags.depth || '0', 10);

  const items = [];

  try {
    // Build query for unread inbox messages within the date range
    const queryParts = ['in:inbox', 'is:unread'];
    const afterDate = durationToDate(date);
    if (afterDate) queryParts.push(`after:${afterDate}`);
    const q = queryParts.join(' ');

    // Step 1: List message IDs
    const listData = await gmailGet('/messages', {
      maxResults: String(limit),
      q: q,
    });

    const stubs = listData.messages || [];
    if (stubs.length === 0) {
      process.stdout.write('[]');
      return;
    }

    // Step 2: Fetch each message (full if depth > 0, otherwise metadata + snippet)
    const format = depth > 0 ? 'full' : 'metadata';
    const fetchParams = depth > 0
      ? { format: 'full' }
      : { format: 'metadata', metadataHeaders: 'From,To,Subject,Date' };

    const messages = await Promise.all(
      stubs.map(stub => gmailGet(`/messages/${stub.id}`, fetchParams))
    );

    // Step 3: Transform to monday protocol items
    for (const msg of messages) {
      const from = getHeader(msg.payload, 'From');
      const subject = getHeader(msg.payload, 'Subject') || '(no subject)';
      const dateHeader = getHeader(msg.payload, 'Date');
      const isUnread = (msg.labelIds || []).includes('UNREAD');
      const labels = msg.labelIds || [];

      let bodyText = msg.snippet || '';
      if (depth > 0) {
        const full = extractBody(msg.payload);
        bodyText = full ? full.slice(0, 500) : bodyText;
      }

      const fromEmail = parseEmail(from);
      let ts;
      if (dateHeader) {
        const parsed = new Date(dateHeader);
        ts = isNaN(parsed.getTime())
          ? new Date(parseInt(msg.internalDate, 10)).toISOString()
          : parsed.toISOString();
      } else {
        ts = new Date(parseInt(msg.internalDate, 10)).toISOString();
      }

      items.push({
        id: `gmail-${msg.id}`,
        source: 'gmail',
        type: 'email',
        title: subject,
        subtitle: `From: ${fromEmail}`,
        url: `${GMAIL_WEB}/${msg.id}`,
        ts: ts,
        body: trunc(bodyText, 500),
        participants: [fromEmail],
        meta: {
          unread: isUnread,
          labels: labels,
          threadId: msg.threadId || '',
        },
      });
    }
  } catch (e) {
    process.stderr.write(`[gmail monday] WARNING: failed to fetch mail: ${e.message}\n`);
  }

  // Output ONLY the JSON array to stdout
  process.stdout.write(JSON.stringify(items));
}

// ─── Help ────────────────────────────────────────────────────────────────────

function showHelp() {
  process.stdout.write(`gmail — Gmail CLI for SLICC

Usage: gmail <command> [options]

Commands:
  mail       List inbox messages
  view       View a single message (full body)
  send       Send an email
  reply      Reply to a message
  monday     Aggregated inbox items for monday dispatcher

Mail options:
  --limit N          Number of messages (default: 20)
  --date PERIOD      Filter by age (e.g. 1d, 7d, 2w, 1m)
  --unread           Show only unread messages
  --search QUERY     Gmail search query
  --json             Output raw JSON

View:
  gmail view <message-id>

Send options:
  --to EMAIL         Recipient(s), comma-separated (required)
  --subject TEXT     Email subject (required)
  --body TEXT        Email body (required)
  --html             Send as HTML instead of plain text
  --cc EMAIL         CC recipients, comma-separated
  --bcc EMAIL        BCC recipients, comma-separated

Reply options:
  --id MESSAGE_ID    Message to reply to (required)
  --body TEXT        Reply body (required)
  --html             Send reply as HTML

Monday options:
  --limit N          Max messages (default: 20)
  --date PERIOD      Date range (default: 1d)
  --depth N          0 = snippet only, >0 = full body (default: 0)

Authentication:
  Uses GWS_CLIENT_ID, GWS_CLIENT_SECRET, and GWS_REFRESH_TOKEN env vars.
  Obtains a fresh access token via OAuth2 refresh_token grant.
  No browser tab needed.

Gmail API:
  Base URL: https://gmail.googleapis.com/gmail/v1/users/me
  GET  /messages           List messages
  GET  /messages/{id}      Get message (format=full|metadata)
  POST /messages/send      Send message (raw base64url RFC 5322)
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

try {
  switch (subcommand) {
    case 'mail':
    case 'inbox':
      await cmdMail();
      break;
    case 'view':
      await cmdView();
      break;
    case 'send':
      await cmdSend();
      break;
    case 'reply':
      await cmdReply();
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
      process.stderr.write(`Unknown command: ${subcommand}\n`);
      showHelp();
      process.exit(1);
  }
} catch (e) {
  process.stderr.write(`gmail: ${e.message}\n`);
  process.exit(1);
}
